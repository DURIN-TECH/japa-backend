// ============================================
// Guidance: quote integrity check + the committed seed data (issue #111) —
// unit tests, no network, no emulator
// ============================================
//
// Two things are covered here:
//  1. the quote check itself (guidance-quote-check.ts), on SYNTHETIC text;
//  2. the committed data: every seed entry and every quote-check row is
//     well formed, and the code stays generic (no code file names anything
//     that belongs to a seed entry).
//
// The fixture text below is invented for these tests and deliberately
// fictional (a harbour office's rules for lighthouse keepers). It is not, and
// does not paraphrase, any real rule or guidance. The real passages live in
// data/guidance-quote-checks.ts and are only ever compared with snapshots of
// the real documents, by the seed script (`--check-quotes`), never here:
// `npm test` makes no network request.

import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { PDF_PAGE_SEPARATOR } from "../../../src/scrapers/shared/fetch/pdf-text";
import { GUIDANCE_QUOTE_CHECKS } from "../../../src/scrapers/guidance/data/guidance-quote-checks";
import {
  GUIDANCE_SOURCE_SEEDS,
  validateGuidanceSourceSeeds,
} from "../../../src/scrapers/guidance/data/seed-guidance-sources";
import {
  GuidanceQuoteCheck,
  failedQuoteResults,
  findPassage,
  foldTypography,
  runQuoteChecks,
  validateQuoteChecks,
} from "../../../src/scrapers/guidance/guidance-quote-check";
import { extractPublishedDate } from "../../../src/scrapers/guidance/guidance-published-date";
import { sha256Hex } from "../../../src/scrapers/guidance/guidance-snapshot.store";
import { buildSeededGuidanceSource } from "../../../src/scrapers/guidance/data/seed-guidance-sources";
import { guidanceSourceController } from "../../../src/scrapers/guidance/guidance-source.controller";
import { Timestamp } from "firebase-admin/firestore";
import { ROLES, defineAbilitiesFor } from "@durin-tech/authz";
import type { Role } from "@durin-tech/authz";
import { fakeCollection, resetStore, store } from "../../helpers/fake-firestore";
import type { GuidanceSnapshotContent } from "../../../src/scrapers/guidance/types";

// ----- Synthetic snapshots (fictional text) -----

// A web-page rendition: one cleaned text, typographic apostrophe included.
const WEB_TEXT =
  "Harbour rules for keepers\n\nK 1.1. The keeper must light the lamp before dusk,\nwhich means the keeper:\n\n" +
  "(a) trims the wick each morning; and\n\n(b) records the keeper’s watch in the ledger.\n\n" +
  "K 1.2. A relief keeper may stand in for up to three nights.";

// A PDF rendition of the same rules: lines wrapped differently, a ligature
// glyph and a no-break space as a PDF text layer has them, over two pages.
const PDF_PAGES = [
  "Harbour rules for keepers\nK 1.1. The keeper must light the lamp\nbefore dusk, which means the keeper:\n(a) trims the wick each morning; and",
  "(b) records the keeper’s watch in the ledger.\nK 1.2. A relief keeper may stand in\nfor up to three nights.\nThe ﬁrst watch begins at dusk.",
];

/** A stored snapshot object for the given text (and pages, for a PDF). */
function snapshot(sourceId: string, text: string, pages?: string[]): GuidanceSnapshotContent {
  return {
    schemaVersion: 1,
    sourceId,
    contentHash: sha256Hex(text),
    docType: pages ? "pdf" : "html",
    url: `https://rules.delta-harbour.example/${sourceId}`,
    finalUrl: `https://rules.delta-harbour.example/${sourceId}`,
    fetchedAt: "2026-11-11T02:00:00.000Z",
    text,
    pages: pages ? pages.map((t, i) => ({ page: i + 1, text: t })) : null,
  };
}

const WEB = snapshot("delta-keeper-rules-web", WEB_TEXT);
const PDF = snapshot("delta-keeper-rules-pdf", PDF_PAGES.join(PDF_PAGE_SEPARATOR), PDF_PAGES);

/** Snapshot lookups over the two synthetic sources (plus failure modes). */
const deps = {
  latestSnapshotId: async (sourceId: string) =>
    sourceId === WEB.sourceId ? WEB.contentHash : sourceId === PDF.sourceId ? PDF.contentHash : sourceId === "delta-broken" ? "f".repeat(64) : null,
  readSnapshot: async (sourceId: string) => {
    if (sourceId === WEB.sourceId) return WEB;
    if (sourceId === PDF.sourceId) return PDF;
    throw new Error("does not match its content hash");
  },
};

const BOTH = [WEB.sourceId, PDF.sourceId];
const check = (id: string, passage: string, sourceIds: string[] = BOTH): GuidanceQuoteCheck => ({ id, label: "K 1.1", passage, sourceIds });

// ============================================
// The check
// ============================================

describe("guidance quote check: matching", () => {
  test("a passage is found however the lines were wrapped, and a PDF hit carries its page", () => {
    const passage = "The keeper must light the lamp before dusk, which means the keeper:";
    assert.deepEqual(findPassage(WEB, passage), { found: true });
    assert.deepEqual(findPassage(PDF, passage), { found: true, page: 1, endPage: 1 });
    // Whitespace in the PASSAGE is normalised too.
    assert.equal(findPassage(WEB, "  The keeper must light the lamp\n before   dusk,").found, true);
    // Ligatures and no-break spaces are normalised on both sides (#33 helper).
    assert.deepEqual(findPassage(PDF, "for up to three nights. The first watch begins at dusk."), { found: true, page: 2, endPage: 2 });
  });

  test("a passage that runs across a page break reports both pages", () => {
    assert.deepEqual(findPassage(PDF, "trims the wick each morning; and (b) records"), { found: true, page: 1, endPage: 2 });
  });

  test("anything but whitespace must be exact: wording, case and punctuation", () => {
    assert.equal(findPassage(WEB, "The keeper should light the lamp before dusk").found, false);
    assert.equal(findPassage(WEB, "the keeper must light the lamp before dusk").found, false);
    // A typographic apostrophe survives cleaning, so it must be in the passage.
    assert.equal(findPassage(WEB, "records the keeper’s watch in the ledger.").found, true);
    assert.equal(findPassage(WEB, "records the keeper's watch in the ledger.").found, false);
    assert.equal(findPassage(WEB, "   ").found, false);
  });

  test("foldTypography folds quote marks and dashes only", () => {
    assert.equal(foldTypography("keeper’s “watch” – dusk"), "keeper's \"watch\" - dusk");
  });
});

describe("guidance quote check: running a list", () => {
  test("a passage listed against two renditions must be in both", async () => {
    const results = await runQuoteChecks(
      [check("both-agree", "(b) records the keeper’s watch in the ledger."), check("pdf-only", "The first watch begins at dusk.")],
      deps
    );
    assert.deepEqual(
      results.map((r) => [r.checkId, r.sourceId, r.found, r.page ?? null, r.problem ?? null]),
      [
        ["both-agree", WEB.sourceId, true, null, null],
        ["both-agree", PDF.sourceId, true, 2, null],
        // The sentence exists in one rendition only: the renditions DISAGREE.
        ["pdf-only", WEB.sourceId, false, null, "not_found"],
        ["pdf-only", PDF.sourceId, true, 2, null],
      ]
    );
    assert.equal(results[0].contentHash, WEB.contentHash);
    assert.deepEqual(failedQuoteResults(results).map((r) => `${r.checkId}@${r.sourceId}`), [`pdf-only@${WEB.sourceId}`]);
  });

  test("a punctuation-only difference still fails, with a hint that says so", async () => {
    const [straight] = await runQuoteChecks([check("straight", "records the keeper's watch in the ledger.", [WEB.sourceId])], deps);
    assert.equal(straight.found, false);
    assert.equal(straight.problem, "not_found");
    assert.match(straight.detail!, /different quote marks or dashes/);
    // Different WORDS get no such hint.
    const [wrong] = await runQuoteChecks([check("wrong", "records the tide in the ledger.", [WEB.sourceId])], deps);
    assert.equal(wrong.problem, "not_found");
    assert.equal(wrong.detail, undefined);
  });

  test("a source with no snapshot, or an unreadable one, fails its passages without stopping the others", async () => {
    const results = await runQuoteChecks(
      [check("mixed", "trims the wick each morning", ["delta-never-fetched", "delta-broken", WEB.sourceId])],
      deps
    );
    assert.deepEqual(results.map((r) => [r.sourceId, r.found, r.problem ?? null]), [
      ["delta-never-fetched", false, "no_snapshot"],
      ["delta-broken", false, "snapshot_unreadable"],
      [WEB.sourceId, true, null],
    ]);
    assert.match(results[1].detail!, /content hash/);
  });

  test("each snapshot is read once, and a subset run checks only that subset", async () => {
    let reads = 0;
    const counting = { ...deps, readSnapshot: async (id: string) => (reads++, deps.readSnapshot(id)) };
    const checks = [check("one", "trims the wick each morning"), check("two", "A relief keeper may stand in")];
    assert.equal((await runQuoteChecks(checks, counting)).length, 4);
    assert.equal(reads, 2);
    const subset = await runQuoteChecks(checks, counting, [PDF.sourceId]);
    assert.deepEqual(subset.map((r) => r.sourceId), [PDF.sourceId, PDF.sourceId]);
  });

  test("the list validator refuses malformed rows and rows that name an unknown source", () => {
    assert.deepEqual(validateQuoteChecks([check("ok", "x")], BOTH), []);
    const problems = validateQuoteChecks(
      [
        check("Bad Id", "x"),
        check("dup", "x"),
        check("dup", "x"),
        check("empty", "  "),
        check("nowhere", "x", []),
        check("typo", "x", ["delta-keeper-rules-wbe"]),
        check("twice", "x", [WEB.sourceId, WEB.sourceId]),
        { ...check("no-label", "x"), label: "" },
      ],
      BOTH
    ).join("\n");
    for (const expected of [
      /Bad Id: id must be/,
      /dup: duplicate id/,
      /empty: passage is required/,
      /nowhere: sourceIds must name at least one/,
      /typo: source "delta-keeper-rules-wbe" is not in the seed/,
      /twice: sourceIds repeats an entry/,
      /no-label: label is required/,
    ]) {
      assert.match(problems, expected);
    }
  });
});

// ============================================
// The committed data (issue #111)
// ============================================

describe("committed guidance seed data", () => {
  test("every committed seed entry passes the validator, and there is at least one", () => {
    assert.ok(GUIDANCE_SOURCE_SEEDS.length > 0);
    assert.deepEqual(validateGuidanceSourceSeeds(GUIDANCE_SOURCE_SEEDS), []);
  });

  test("no committed entry claims `verified` without saying when it was retrieved, and none carries an error", () => {
    for (const seed of GUIDANCE_SOURCE_SEEDS) {
      if (seed.verificationStatus !== "verified") continue;
      assert.ok(seed.retrievedAt, `${seed.id}: retrievedAt`);
      assert.equal(seed.retrievalError, undefined, `${seed.id}: retrievalError`);
      // The note must record a retrieval, with its date, not just assert one.
      assert.match(seed.verificationNote, /\d{4}-\d{2}-\d{2}/, `${seed.id}: the note gives the retrieval date`);
    }
  });

  test("every committed quote check is well formed and names entries that exist", () => {
    assert.deepEqual(validateQuoteChecks(GUIDANCE_QUOTE_CHECKS, GUIDANCE_SOURCE_SEEDS.map((s) => s.id)), []);
  });

  test("a committed date selector reads the publisher's own wording (synthetic sample of that wording)", () => {
    // For each selector in the seed, build a sample line from the selector's
    // own literal lead-in and a made-up date, and check the date comes out.
    // This proves the pattern is usable without quoting any document.
    for (const seed of GUIDANCE_SOURCE_SEEDS) {
      if (!seed.publishedDateSelector) continue;
      const leadIn = seed.publishedDateSelector.split("(")[0];
      const found = extractPublishedDate(`Sample heading\n${leadIn}1 January 2030\nSample body`, seed.publishedDateSelector);
      assert.deepEqual(found, { publishedDate: "2030-01-01", publishedDateText: "1 January 2030" }, seed.id);
    }
  });

  // ---- The admin list over the committed entries ----

  /** Call GET /admin/guidance-sources as `role`; returns status and body. */
  async function list(role: Role): Promise<{ status: number; body: any }> {
    const out = { status: 0, body: undefined as any };
    const res: any = {
      status: (code: number) => ((out.status = code), res),
      json: (b: unknown) => ((out.body = b), res),
    };
    const authz = { uid: `${role}-uid`, role, agencyId: role === ROLES.OWNER || role === ROLES.AGENT ? "ag1" : null };
    await guidanceSourceController.list({ params: {}, query: {}, body: {}, userId: authz.uid, authz, ability: defineAbilitiesFor(authz) } as any, res);
    return out;
  }

  before(async () => {
    const firebase: any = await import("../../../src/utils/firebase");
    firebase.collections.guidanceSources = fakeCollection("guidanceSources");
  });

  test("the admin list returns every committed entry with lastFetchedAt, status and verificationStatus; a non-admin gets FORBIDDEN", async () => {
    resetStore();
    const now = Timestamp.fromMillis(Date.parse("2026-11-11T02:00:00Z"));
    for (const seed of GUIDANCE_SOURCE_SEEDS) {
      // As seeded, then as a first successful crawl would stamp it.
      store.set(`guidanceSources/${seed.id}`, { ...buildSeededGuidanceSource(seed, undefined, now), lastFetchedAt: now });
    }
    const out = await list(ROLES.ADMIN);
    assert.equal(out.status, 200);
    assert.equal(out.body.data.total, GUIDANCE_SOURCE_SEEDS.length);
    const byId = new Map<string, any>(out.body.data.sources.map((s: any) => [s.id, s]));
    for (const seed of GUIDANCE_SOURCE_SEEDS) {
      const item = byId.get(seed.id);
      assert.ok(item, seed.id);
      assert.equal(item.lastFetchedAt, "2026-11-11T02:00:00.000Z");
      assert.equal(item.status, "active");
      assert.equal(item.verificationStatus, seed.verificationStatus);
      assert.equal(item.url, seed.url);
      assert.equal(item.resolveFromPageUrl, seed.resolveFrom?.pageUrl ?? null);
    }
    const denied = await list(ROLES.AGENT);
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error, "FORBIDDEN");
    assert.equal(denied.body.data, undefined);
  });

  test("generic by design: no guidance CODE file names anything that belongs to a seed entry", () => {
    // Everything under guidance/ except data/ is code. A seed entry's id,
    // route key, host names and title are data; if one shows up in a code
    // file, some code path has started to depend on a particular source.
    const root = path.resolve(__dirname, "../../../src/scrapers/guidance");
    const codeFiles: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "data") walk(full);
        } else if (entry.name.endsWith(".ts")) {
          codeFiles.push(full);
        }
      }
    };
    walk(root);
    assert.ok(codeFiles.length >= 6, "the guidance code files were found");

    const needles = new Set<string>();
    for (const seed of GUIDANCE_SOURCE_SEEDS) {
      needles.add(seed.id);
      needles.add(seed.route);
      needles.add(seed.title);
      needles.add(new URL(seed.url).host);
      if (seed.resolveFrom) needles.add(new URL(seed.resolveFrom.pageUrl).host);
    }
    for (const c of GUIDANCE_QUOTE_CHECKS) needles.add(c.passage);
    for (const file of codeFiles) {
      const text = fs.readFileSync(file, "utf8").toLowerCase();
      for (const needle of needles) {
        assert.ok(!text.includes(needle.toLowerCase()), `${path.relative(root, file)} mentions seed data: ${JSON.stringify(needle)}`);
      }
    }
  });
});
