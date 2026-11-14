// ============================================
// Guidance source registry (issue #39) — seed, store, admin list, access
// ============================================
//
// Unit tests, no network and no emulator:
//  - the seed validator (verification honesty) and the merge builder;
//  - the publisher-date helper;
//  - the snapshot text store (hash key, create-only, integrity on read,
//    per-project bucket);
//  - GET /admin/guidance-sources (admin-only, fields only);
//  - the "stored text is unreachable by clients" guarantees, checked against
//    the real firestore.rules, storage.rules and route table.
//
// Fixtures are synthetic: made-up publishers, hosts, jurisdictions, routes.

import { before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { Timestamp } from "firebase-admin/firestore";
import { ROLES, defineAbilitiesFor } from "@durin-tech/authz";
import type { Role } from "@durin-tech/authz";
import {
  GUIDANCE_SOURCE_SEEDS,
  buildSeededGuidanceSource,
  seedGuidanceSources,
  validateGuidanceSourceSeed,
  validateGuidanceSourceSeeds,
} from "../../../src/scrapers/guidance/data/seed-guidance-sources";
import {
  DEFAULT_PUBLISHED_DATE_WINDOW_CHARS,
  extractPublishedDate,
  parsePublishedDate,
  publishedDateSelectorProblem,
} from "../../../src/scrapers/guidance/guidance-published-date";
import {
  GuidanceSnapshotStore,
  SnapshotBucket,
  guidanceSnapshotPath,
  sha256Hex,
} from "../../../src/scrapers/guidance/guidance-snapshot.store";
import { guidanceSourceController } from "../../../src/scrapers/guidance/guidance-source.controller";
import { adminGuidanceSourceRoutes } from "../../../src/scrapers/guidance/guidance-source.routes";
import type { GuidanceSourceSeed } from "../../../src/scrapers/guidance/types";
import { fakeCollection, resetStore, store } from "../../helpers/fake-firestore";

// ----- Synthetic entries: two publishers, two document kinds -----

const HTML_SEED: GuidanceSourceSeed = {
  id: "alpha-short-stay-rules",
  title: "Short stay rules",
  url: "https://rules.alpha-ministry.example/rules/short-stay",
  jurisdiction: "AA",
  route: "short-stay",
  docType: "html",
  publishedDateSelector: "Last updated:? (\\d{1,2} [A-Za-z]+ \\d{4})",
  checkIntervalHours: 24,
  verificationStatus: "verified",
  verificationNote: "Whole page retrieved by hand on 2026-11-10.",
  retrievedAt: "2026-11-10",
};

const PDF_SEED: GuidanceSourceSeed = {
  id: "beta-study-casework",
  title: "Study route: casework guidance",
  url: "https://files.beta-agency.example/media/7f3a/casework-guidance.pdf",
  jurisdiction: "BB",
  route: "study",
  docType: "pdf",
  checkIntervalHours: 168,
  verificationStatus: "unverified",
  verificationNote: "Download failed on 2026-11-10; nothing was read.",
  retrievalError: "TLS handshake failed",
};

const NOW = Timestamp.fromMillis(Date.parse("2026-11-11T02:00:00Z"));

// ============================================
// Seed: shape, verification honesty, merge
// ============================================

describe("guidance seed: validation", () => {
  test("the two synthetic entries (HTML + PDF, different publishers) are valid", () => {
    assert.deepEqual(validateGuidanceSourceSeeds([HTML_SEED, PDF_SEED]), []);
  });

  test("every committed seed entry passes the validator", () => {
    // Empty in #39 (the first real entries are #111); whatever is added
    // later must satisfy the same rules, verification fields included.
    assert.deepEqual(validateGuidanceSourceSeeds(GUIDANCE_SOURCE_SEEDS), []);
  });

  test("verificationStatus and a note are mandatory", () => {
    const noStatus = { ...HTML_SEED, verificationStatus: undefined } as unknown as GuidanceSourceSeed;
    assert.ok(validateGuidanceSourceSeed(noStatus).some((p) => p.startsWith("verificationStatus must be one of")));
    assert.ok(validateGuidanceSourceSeed({ ...HTML_SEED, verificationNote: "  " }).some((p) => p.startsWith("verificationNote is required")));
  });

  test("a source with a recorded retrieval failure cannot be seeded as verified", () => {
    const problems = validateGuidanceSourceSeed({ ...HTML_SEED, retrievalError: "page cut off after 4096 bytes" });
    assert.deepEqual(problems, ["a source with a retrievalError cannot be verified: seed it as partial or unverified"]);
    // The same entry, honestly labelled, is accepted and keeps the error.
    const partial: GuidanceSourceSeed = { ...HTML_SEED, verificationStatus: "partial", retrievalError: "page cut off after 4096 bytes" };
    assert.deepEqual(validateGuidanceSourceSeed(partial), []);
    const doc = buildSeededGuidanceSource(partial, undefined, NOW);
    assert.equal(doc.verificationStatus, "partial");
    assert.equal(doc.retrievalError, "page cut off after 4096 bytes");
  });

  test("verified needs a retrieval date; unverified needs the error of the failed retrieval", () => {
    assert.deepEqual(validateGuidanceSourceSeed({ ...HTML_SEED, retrievedAt: undefined }), [
      "a verified source needs retrievedAt (when it was retrieved in full)",
    ]);
    assert.deepEqual(validateGuidanceSourceSeed({ ...PDF_SEED, retrievalError: undefined }), [
      "an unverified source needs retrievalError (what the failed retrieval returned)",
    ]);
    assert.deepEqual(validateGuidanceSourceSeed({ ...HTML_SEED, verificationStatus: "partial", retrievedAt: undefined }), [
      "a partial source needs retrievedAt (when the part that was retrieved was retrieved)",
    ]);
  });

  test("field rules: id, https url, generic lowercase route, docType, interval, status, selector", () => {
    const bad = (over: Partial<GuidanceSourceSeed>) => validateGuidanceSourceSeed({ ...HTML_SEED, ...over } as GuidanceSourceSeed);
    assert.equal(bad({ id: "Has Spaces" }).length, 1);
    assert.equal(bad({ id: "../escape" }).length, 1);
    assert.equal(bad({ url: "http://rules.alpha-ministry.example/x" }).length, 1);
    assert.equal(bad({ url: "not a url" }).length, 1);
    assert.equal(bad({ route: "Short Stay" }).length, 1);
    assert.equal(bad({ route: "SHORT-STAY" }).length, 1);
    assert.equal(bad({ jurisdiction: "" }).length, 1);
    assert.equal(bad({ docType: "docx" as never }).length, 1);
    assert.equal(bad({ checkIntervalHours: 0 }).length, 1);
    assert.equal(bad({ checkIntervalHours: Number.NaN }).length, 1);
    // `failing` is the crawler's status, not a seedable one.
    assert.equal(bad({ status: "failing" as never }).length, 1);
    assert.equal(bad({ publishedDateSelector: "no capture group" }).length, 1);
    assert.equal(bad({ publishedDateSelector: "(unclosed" }).length, 1);
    // Patterns that backtrack badly are refused at seeding time.
    for (const slow of [".*Updated (\\d+)", "(.+)Updated (\\d+)", "[\\s\\S]*Updated (\\d+)", "Updated (\\d+)+", "Updated (?:\\s+\\w+)* (\\d+)"]) {
      assert.equal(bad({ publishedDateSelector: slow }).length, 1, slow);
    }
    assert.equal(bad({ expectedFinalUrl: "ftp://x.example/a" }).length, 1);
  });

  test("duplicate ids and urls are refused, and an invalid list writes nothing", async () => {
    const problems = validateGuidanceSourceSeeds([HTML_SEED, { ...PDF_SEED, id: HTML_SEED.id }, { ...PDF_SEED, id: "third", url: HTML_SEED.url }]);
    assert.ok(problems.includes(`${HTML_SEED.id}: duplicate id`));
    assert.ok(problems.includes(`third: duplicate url ${HTML_SEED.url}`));
    // seedGuidanceSources validates before it touches Firestore (an unfaked
    // Firestore call would fail this test through the preload guard).
    await assert.rejects(seedGuidanceSources([{ ...HTML_SEED, verificationNote: "" }]), /nothing written/);
  });
});

describe("guidance seed: the doc that is written", () => {
  test("a new source carries every registry field and a blank crawl state", () => {
    const doc = buildSeededGuidanceSource(HTML_SEED, undefined, NOW);
    assert.deepEqual(doc, {
      title: HTML_SEED.title,
      url: HTML_SEED.url,
      jurisdiction: "AA",
      route: "short-stay",
      docType: "html",
      publishedDateSelector: HTML_SEED.publishedDateSelector,
      expectedFinalUrl: null,
      // Issue #111: no parent page to resolve the address from.
      resolveFrom: null,
      // Issue #112: HTML_SEED names no role, so none is stored (null, so a role removed from a seed is cleared).
      role: null,
      checkIntervalHours: 24,
      verificationStatus: "verified",
      verificationNote: HTML_SEED.verificationNote,
      retrievedAt: Timestamp.fromMillis(Date.parse("2026-11-10")),
      retrievalError: null,
      status: "active",
      lastFetchedAt: null,
      lastContentHash: null,
      finalUrl: null,
      resolvedUrl: null,
      publishedDate: null,
      publishedDateText: null,
      latestSnapshotId: null,
      lastChangedAt: null,
      lastAttemptAt: null,
      consecutiveFailures: 0,
      lastError: null,
      lastErrorKind: null,
      lastErrorAt: null,
      backoffUntil: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
  });

  test("a seed's source role is stored as written, and the real seed gives each source its role", () => {
    for (const role of ["primary", "route_guidance", "secondary"] as const) {
      assert.equal(buildSeededGuidanceSource({ ...HTML_SEED, role }, undefined, NOW).role, role);
    }
    // The registry data (not code) decides the roles: the route's rules are
    // primary, its caseworker guidance (both renditions) route guidance, the
    // cross-route documents secondary.
    assert.deepEqual(
      Object.fromEntries(GUIDANCE_SOURCE_SEEDS.map((x) => [x.id, x.role])),
      {
        // ---- Standard Visitor (issue #111) ----
        "gb-appendix-v-visitor": "primary",
        "gb-visit-guidance-html": "route_guidance",
        "gb-visit-guidance-pdf": "route_guidance",
        "gb-part-suitability": "secondary",
        "gb-appendix-finance": "secondary",
        // ---- UK Family (issue #260): Appendix FM is the route's rules, FM-SE
        // the cross-route evidence appendix, the two caseworker guidances
        // (Family Policy web + PDF, minimum income requirement PDF) route guidance.
        "gb-appendix-fm-family-members": "primary",
        "gb-appendix-fm-se-specified-evidence": "secondary",
        "gb-family-life-guidance-html": "route_guidance",
        "gb-family-life-guidance-pdf": "route_guidance",
        "gb-family-financial-requirement-pdf": "route_guidance",
      }
    );
  });

  test("every route in the real seed has exactly one primary source (its own rules)", () => {
    // Issue #260: once several routes share the list, a second primary under
    // one route key (or a route with none) would be a copy-paste slip: the
    // rubric is built around ONE rules document per route.
    const primaries = new Map<string, number>();
    for (const seed of GUIDANCE_SOURCE_SEEDS) {
      if (!primaries.has(seed.route)) primaries.set(seed.route, 0);
      if (seed.role === "primary") primaries.set(seed.route, primaries.get(seed.route)! + 1);
    }
    for (const [route, count] of primaries) assert.equal(count, 1, `${route} has ${count} primary sources`);
  });

  test("an unknown source role is rejected by the seed validator", () => {
    const problems = validateGuidanceSourceSeed({ ...HTML_SEED, role: "tertiary" as never });
    assert.deepEqual(problems, ["role must be one of primary, route_guidance, secondary when present"]);
  });

  test("a re-seed keeps the crawl state and does not un-fail a failing source", () => {
    const existing = {
      ...buildSeededGuidanceSource(HTML_SEED, undefined, NOW),
      status: "failing",
      lastContentHash: "a".repeat(64),
      latestSnapshotId: "a".repeat(64),
      consecutiveFailures: 5,
      finalUrl: HTML_SEED.url,
    };
    const doc = buildSeededGuidanceSource({ ...HTML_SEED, title: "Short stay rules (renamed)", status: "active" }, existing, NOW);
    // Curated fields are updated...
    assert.equal(doc.title, "Short stay rules (renamed)");
    // ...and the merge payload does not carry (so does not reset) crawl state.
    for (const field of ["status", "lastContentHash", "latestSnapshotId", "consecutiveFailures", "finalUrl", "createdAt"]) {
      assert.ok(!(field in doc), `${field} must be left to the crawler`);
    }
  });

  test("a changed URL resets the redirect baseline and the failure streak", () => {
    const existing = {
      ...buildSeededGuidanceSource(HTML_SEED, undefined, NOW),
      status: "failing",
      lastContentHash: "a".repeat(64),
      consecutiveFailures: 5,
      finalUrl: "https://rules.alpha-ministry.example/old-target",
      autoPaused: true,
    };
    const doc = buildSeededGuidanceSource({ ...HTML_SEED, url: "https://rules.alpha-ministry.example/rules/short-stay-v2" }, existing, NOW);
    assert.equal(doc.finalUrl, null);
    assert.equal(doc.consecutiveFailures, 0);
    assert.equal(doc.status, "active");
    assert.equal(doc.autoPaused, false);
    // The stored hash stays: identical text at the new address is not re-snapshotted.
    assert.ok(!("lastContentHash" in doc));
  });

  test("an explicit paused / retired status in the seed is applied to an existing source", () => {
    const existing = buildSeededGuidanceSource(HTML_SEED, undefined, NOW);
    assert.equal(buildSeededGuidanceSource({ ...HTML_SEED, status: "retired" }, existing, NOW).status, "retired");
    assert.equal(buildSeededGuidanceSource({ ...HTML_SEED, status: "paused" }, { ...existing, status: "failing" }, NOW).status, "paused");
  });
});

// ============================================
// Publisher-reported date
// ============================================

describe("guidance published date", () => {
  test("parses the date forms publishers write, and refuses ambiguous or impossible ones", () => {
    assert.equal(parsePublishedDate("11 November 2025"), "2025-11-11");
    assert.equal(parsePublishedDate("1st Sept 2026"), "2026-09-01");
    assert.equal(parsePublishedDate("November 11, 2025"), "2025-11-11");
    assert.equal(parsePublishedDate("2026-02-28T10:00:00Z"), "2026-02-28");
    assert.equal(parsePublishedDate("31 February 2026"), null);
    assert.equal(parsePublishedDate("11/12/2025"), null); // day-first or month-first? not guessed
    assert.equal(parsePublishedDate("soon"), null);
  });

  test("the selector is data: the same code reads two publishers' wordings", () => {
    assert.deepEqual(extractPublishedDate("Rules\nLast updated: 3 March 2026\nText", "Last updated:? (\\d{1,2} [A-Za-z]+ \\d{4})"), {
      publishedDate: "2026-03-03",
      publishedDateText: "3 March 2026",
    });
    assert.deepEqual(
      extractPublishedDate("This guidance was PUBLISHED FOR STAFF ON 14 July\n2026.", "published for staff on (\\d{1,2}\\s+[A-Za-z]+\\s+\\d{4})"),
      { publishedDate: "2026-07-14", publishedDateText: "14 July 2026" }
    );
    // An unparseable date keeps the text as written.
    assert.deepEqual(extractPublishedDate("Version of 11/12/2025", "Version of (\\S+)"), {
      publishedDate: null,
      publishedDateText: "11/12/2025",
    });
  });

  test("the selector only runs over the head and the tail of the text", () => {
    const sel = "Last updated:? (\\d{1,2} [A-Za-z]+ \\d{4})";
    const pad = (n: number) => "x".repeat(n);
    const W = 1000;
    // In the head window, and in the tail window: found.
    assert.equal(extractPublishedDate(`Last updated: 3 March 2026 ${pad(5000)}`, sel, W)?.publishedDate, "2026-03-03");
    assert.equal(extractPublishedDate(`${pad(5000)} Last updated: 3 March 2026`, sel, W)?.publishedDate, "2026-03-03");
    // In the middle, outside both windows: simply no published date.
    assert.equal(extractPublishedDate(`${pad(3000)} Last updated: 3 March 2026 ${pad(3000)}`, sel, W), null);
    // A text shorter than two windows is searched once, with no overlap.
    assert.equal(extractPublishedDate(`${pad(1200)} Last updated: 3 March 2026`, sel, W)?.publishedDate, "2026-03-03");
    // The default window is 20,000 characters at each end.
    assert.equal(DEFAULT_PUBLISHED_DATE_WINDOW_CHARS, 20_000);
    assert.equal(extractPublishedDate(`${pad(30_000)} Last updated: 3 March 2026 ${pad(30_000)}`, sel), null);
    assert.equal(extractPublishedDate(`${pad(30_000)} Last updated: 3 March 2026 ${pad(10_000)}`, sel)?.publishedDate, "2026-03-03");
  });

  test("a slow pattern that reached the registry anyway is not run", () => {
    assert.equal(extractPublishedDate("Updated 2026-03-03", ".*Updated (\\S+)"), null);
    assert.equal(extractPublishedDate("Updated 2026-03-03", "Updated (\\S+)")?.publishedDate, "2026-03-03");
  });

  test("no selector, no match or a bad selector yields null and never throws", () => {
    assert.equal(extractPublishedDate("text", undefined), null);
    assert.equal(extractPublishedDate("text", null), null);
    assert.equal(extractPublishedDate("text", "Updated (\\d+)"), null);
    assert.equal(extractPublishedDate("text", "(unclosed"), null);
    assert.equal(publishedDateSelectorProblem("Updated (\\d+)"), undefined);
    assert.match(publishedDateSelectorProblem("Updated \\d+")!, /capture group/);
  });
});

// ============================================
// Snapshot text store
// ============================================

/**
 * An in-memory bucket that enforces create-only writes, like Cloud Storage.
 * `blindExists: true` makes exists() always answer "no", as it would for the
 * loser of a race between two runs, so the write precondition is what stops
 * the overwrite.
 */
function memoryBucket(opts: { blindExists?: boolean } = {}) {
  const objects = new Map<string, string>();
  const counts = { saves: 0 };
  const bucket: SnapshotBucket = {
    file: (name) => ({
      async exists() {
        return [opts.blindExists ? false : objects.has(name)];
      },
      async save(data, options) {
        counts.saves++;
        if (options.preconditionOpts.ifGenerationMatch === 0 && objects.has(name)) {
          throw Object.assign(new Error("Precondition Failed"), { code: 412 });
        }
        objects.set(name, data);
      },
      async download() {
        return [Buffer.from(objects.get(name) ?? "", "utf8")];
      },
    }),
  };
  return { bucket, objects, counts };
}

describe("guidance snapshot store", () => {
  const input = {
    sourceId: "beta-study-casework",
    docType: "pdf" as const,
    url: "https://files.beta-agency.example/a.pdf",
    finalUrl: "https://files.beta-agency.example/a.pdf",
    fetchedAtMs: NOW.toMillis(),
    text: "page one\fpage two",
    pages: ["page one", "page two"],
  };

  test("writes under the content hash, once; a repeat write stores nothing and overwrites nothing", async () => {
    const { bucket, objects, counts } = memoryBucket();
    const s = new GuidanceSnapshotStore(bucket);
    const first = await s.write(input);
    assert.equal(first.contentHash, sha256Hex(input.text));
    assert.equal(first.storagePath, `guidance-snapshots/beta-study-casework/${first.contentHash}.json`);
    assert.equal(first.byteLength, Buffer.byteLength(input.text, "utf8"));
    assert.equal(first.created, true);
    const before = objects.get(first.storagePath);

    // Same text again, fetched later from elsewhere: nothing changes.
    const again = await s.write({ ...input, fetchedAtMs: input.fetchedAtMs + 1000, finalUrl: "https://elsewhere.example/a.pdf" });
    assert.equal(again.created, false);
    assert.equal(objects.size, 1);
    assert.equal(objects.get(first.storagePath), before);
    assert.equal(counts.saves, 1, "the existing object is detected before any write is sent");

    const read = await s.read(input.sourceId, first.contentHash);
    assert.equal(read.text, input.text);
    assert.deepEqual(read.pages, [{ page: 1, text: "page one" }, { page: 2, text: "page two" }]);
    assert.equal(read.fetchedAt, "2026-11-11T02:00:00.000Z");
  });

  test("a write that races past the exists check is stopped by the create-only precondition", async () => {
    const { bucket, objects, counts } = memoryBucket({ blindExists: true });
    const s = new GuidanceSnapshotStore(bucket);
    const first = await s.write(input);
    const before = objects.get(first.storagePath);
    const again = await s.write({ ...input, fetchedAtMs: input.fetchedAtMs + 1000 });
    assert.equal(counts.saves, 2, "the second write was sent");
    assert.equal(again.created, false, "and refused (412), reported as already stored");
    assert.equal(objects.get(first.storagePath), before);
  });

  test("read refuses an object whose text does not match its key", async () => {
    const { bucket, objects } = memoryBucket();
    const s = new GuidanceSnapshotStore(bucket);
    const { storagePath, contentHash } = await s.write(input);
    objects.set(storagePath, JSON.stringify({ ...JSON.parse(objects.get(storagePath)!), text: "tampered" }));
    await assert.rejects(s.read(input.sourceId, contentHash), /does not match its content hash/);
  });

  test("read refuses a PDF snapshot whose pages do not join back into its text", async () => {
    const { bucket, objects } = memoryBucket();
    const s = new GuidanceSnapshotStore(bucket);
    const { storagePath, contentHash } = await s.write(input);
    const good = JSON.parse(objects.get(storagePath)!);
    /** Store a variant of the object (same text, so the hash still matches). */
    const withPages = (pages: unknown) => objects.set(storagePath, JSON.stringify({ ...good, pages }));

    // A page's text altered (a quote would be cited to the wrong page).
    withPages([{ page: 1, text: "page one" }, { page: 2, text: "page 2" }]);
    await assert.rejects(s.read(input.sourceId, contentHash), /its pages do not match its text/);
    // Text moved between pages.
    withPages([{ page: 1, text: "page" }, { page: 2, text: "one\fpage two" }]);
    await assert.rejects(s.read(input.sourceId, contentHash), /its pages do not match its text/);
    // Page numbers wrong or out of order.
    withPages([{ page: 2, text: "page one" }, { page: 1, text: "page two" }]);
    await assert.rejects(s.read(input.sourceId, contentHash), /its pages do not match its text/);
    // Pages dropped from a PDF snapshot.
    withPages(null);
    await assert.rejects(s.read(input.sourceId, contentHash), /a PDF snapshot without pages/);
    // The untouched object still reads.
    withPages(good.pages);
    assert.equal((await s.read(input.sourceId, contentHash)).pages!.length, 2);
  });

  test("an HTML snapshot (no pages) reads back", async () => {
    const { bucket } = memoryBucket();
    const s = new GuidanceSnapshotStore(bucket);
    const w = await s.write({ ...input, docType: "html", sourceId: "alpha-short-stay-rules", text: "whole page", pages: undefined });
    const r = await s.read("alpha-short-stay-rules", w.contentHash);
    assert.equal(r.pages, null);
    assert.equal(r.text, "whole page");
  });

  test("ids that could escape the snapshot folder are refused", () => {
    const hash = "a".repeat(64);
    assert.throws(() => guidanceSnapshotPath("../users", hash), /Invalid guidance source id/);
    assert.throws(() => guidanceSnapshotPath("a/b", hash), /Invalid guidance source id/);
    assert.throws(() => guidanceSnapshotPath("ok-id", "../../x"), /Invalid content hash/);
    assert.equal(guidanceSnapshotPath("ok-id", hash), `guidance-snapshots/ok-id/${hash}.json`);
  });

  test("the default bucket is derived from the running project, not hard-coded", async () => {
    const { storage } = await import("../../../src/utils/firebase");
    // The test preload sets GCLOUD_PROJECT to a demo- id.
    assert.equal(storage.bucket().name, `${process.env.GCLOUD_PROJECT}.firebasestorage.app`);
    // And the store names no bucket of its own.
    const src = fs.readFileSync(path.join(__dirname, "../../../src/scrapers/guidance/guidance-snapshot.store.ts"), "utf8");
    assert.ok(!/firebasestorage\.app|appspot\.com/.test(src));
    assert.ok(/storage\.bucket\(\)/.test(src));
  });
});

// ============================================
// GET /admin/guidance-sources
// ============================================

/** Minimal Express res double. */
function fakeRes() {
  const out: { status: number; body: any } = { status: 0, body: undefined };
  const res = {
    status(code: number) {
      out.status = code;
      return res;
    },
    json(b: unknown) {
      out.body = b;
      return res;
    },
  };
  return { res, out };
}

/** A request with the CASL ability of `role` (as verifyAuth would attach). */
function req(role: Role): any {
  const authz = { uid: `${role}-uid`, role, agencyId: role === ROLES.OWNER || role === ROLES.AGENT ? "ag1" : null };
  return { params: {}, query: {}, body: {}, userId: authz.uid, authz, ability: defineAbilitiesFor(authz) };
}

/** Call the list handler and return the captured response. */
async function list(role: Role) {
  const { res, out } = fakeRes();
  await guidanceSourceController.list(req(role), res as any);
  return out;
}

describe("GET /admin/guidance-sources", () => {
  let firebase: any;
  before(async () => {
    firebase = await import("../../../src/utils/firebase");
  });
  beforeEach(() => {
    resetStore();
    firebase.collections.guidanceSources = fakeCollection("guidanceSources");
  });

  test("a non-admin gets 403 FORBIDDEN and the registry is not even read", async () => {
    // Any read would throw: proves the gate runs first.
    firebase.collections.guidanceSources = {
      get: async () => {
        throw new Error("the registry was read for a non-admin");
      },
    };
    for (const role of Object.values(ROLES).filter((r) => r !== ROLES.ADMIN) as Role[]) {
      const out = await list(role);
      assert.equal(out.status, 403, role);
      assert.equal(out.body.success, false);
      assert.equal(out.body.error, "FORBIDDEN");
      assert.equal(out.body.data, undefined);
    }
  });

  test("an admin gets every entry with lastFetchedAt, status and verificationStatus", async () => {
    const fetchedAt = Timestamp.fromMillis(Date.parse("2026-11-10T03:00:00Z"));
    store.set(`guidanceSources/${PDF_SEED.id}`, buildSeededGuidanceSource(PDF_SEED, undefined, NOW));
    store.set(`guidanceSources/${HTML_SEED.id}`, {
      ...buildSeededGuidanceSource(HTML_SEED, undefined, NOW),
      lastFetchedAt: fetchedAt,
      lastContentHash: "b".repeat(64),
      latestSnapshotId: "b".repeat(64),
      finalUrl: `${HTML_SEED.url}-2026`,
      publishedDate: "2026-03-03",
      // A field a later change might add: must not leak through the mapper.
      internalNote: "do not expose",
    });

    const out = await list(ROLES.ADMIN);
    assert.equal(out.status, 200);
    assert.equal(out.body.data.total, 2);
    // Sorted by jurisdiction (AA before BB).
    const [a, b] = out.body.data.sources;
    assert.equal(a.id, HTML_SEED.id);
    assert.equal(a.lastFetchedAt, "2026-11-10T03:00:00.000Z");
    assert.equal(a.status, "active");
    assert.equal(a.verificationStatus, "verified");
    assert.equal(a.url, HTML_SEED.url);
    assert.equal(a.finalUrl, `${HTML_SEED.url}-2026`);
    assert.equal(a.publishedDate, "2026-03-03");
    assert.equal(a.docType, "html");
    assert.equal(b.id, PDF_SEED.id);
    assert.equal(b.lastFetchedAt, null);
    assert.equal(b.verificationStatus, "unverified");
    assert.equal(b.retrievalError, "TLS handshake failed");
    assert.equal(b.docType, "pdf");

    // Fields only: no document text, no Storage location, no unknown fields.
    for (const item of out.body.data.sources) {
      for (const key of ["text", "pages", "cleanText", "storagePath", "internalNote"]) {
        assert.ok(!(key in item), `${key} must not be in the response`);
      }
    }
  });
});

// ============================================
// Stored text is not reachable by any client
// ============================================

describe("guidance snapshots are backend-only", () => {
  // test/scrapers/guidance -> repo root (firestore.rules, storage.rules).
  const repoRoot = path.join(__dirname, "../../../..");
  const srcRoot = path.join(__dirname, "../../../src");

  /** Rules text with `//` comments removed (the collections are named in comments). */
  const rules = (file: string) =>
    fs
      .readFileSync(path.join(repoRoot, file), "utf8")
      .split("\n")
      .map((l) => l.replace(/\/\/.*$/, ""))
      .join("\n");

  test("firestore.rules has no match for the registry or its snapshots, and no catch-all", () => {
    const text = rules("firestore.rules");
    assert.ok(!/guidanceSources/.test(text));
    assert.ok(!/match\s+\/snapshots\b/.test(text));
    // A recursive wildcard at the top would open every collection.
    assert.ok(!/match\s+\/\{[A-Za-z_]+=\*\*\}/.test(text));
  });

  test("storage.rules has no match for the snapshot folder, and no catch-all", () => {
    const text = rules("storage.rules");
    assert.ok(!/guidance-snapshots/.test(text));
    assert.ok(!/match\s+\/\{[A-Za-z_]+=\*\*\}/.test(text));
  });

  // Issue #215 added PATCH /:id (status / role). There is still no DELETE and no
  // route that serves a snapshot.
  test("the guidance router has exactly these routes: list, crawl, edit (no delete)", () => {
    const routes = (adminGuidanceSourceRoutes as any).stack.filter((l: any) => l.route).map((l: any) => ({
      path: l.route.path,
      methods: Object.keys(l.route.methods),
    }));
    assert.deepEqual(routes, [
      { path: "/", methods: ["get"] },
      { path: "/:id/crawl", methods: ["post"] },
      { path: "/:id", methods: ["patch"] },
    ]);
  });

  test("no controller or route file reads the snapshot store", () => {
    /** Every .ts file under `dir`. */
    const walk = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name);
        return e.isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
      });
    const offenders = walk(srcRoot)
      .filter((f) => /(controller|routes)\.ts$/.test(f) || f.endsWith("app.ts"))
      .filter((f) => /guidance-snapshot\.store|guidanceSnapshotStore|GuidanceSnapshotStore/.test(fs.readFileSync(f, "utf8")));
    assert.deepEqual(offenders, []);
  });
});
