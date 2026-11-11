// ============================================
// Guidance: resolving a document's current address (issue #111) — unit
// tests, no network, no emulator
// ============================================
//
// Some documents get a NEW address with every publication, while a stable
// parent page links to the current file. A registry entry describes that with
// `resolveFrom` (a page + a link pattern). These tests drive the real crawl
// service over the real shared fetch service on a stubbed HTTP client, the
// in-memory Firestore fake and an in-memory create-only bucket, and cover:
//  - the seed validator's rules for `resolveFrom`;
//  - the link lookup itself;
//  - a crawl whose document MOVES: new address + new text -> a new hash and
//    a new snapshot, with the previous snapshot still readable by its hash;
//    new address + same text -> nothing downstream;
//  - every way the lookup can fail, none of which ingests anything.
//
// The fixtures are synthetic and deliberately fictional: a made-up registry
// office on made-up hosts, with made-up jurisdiction and route keys and
// made-up document text. Nothing in the code under test knows these values.

import { before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";
import { VisaCatalogFetchService, VisaCatalogHttpClient } from "../../../src/scrapers/shared/fetch/visa-catalog-fetch.service";
import { GuidanceCrawlService, failureKindOf } from "../../../src/scrapers/guidance/guidance-crawl.service";
import {
  GuidanceResolveError,
  findMatchingLinks,
  resolveFromProblems,
} from "../../../src/scrapers/guidance/guidance-resolve";
import { GuidanceSnapshotStore, SnapshotBucket } from "../../../src/scrapers/guidance/guidance-snapshot.store";
import {
  buildSeededGuidanceSource,
  validateGuidanceSourceSeed,
} from "../../../src/scrapers/guidance/data/seed-guidance-sources";
import { toGuidanceSourceListItem } from "../../../src/scrapers/guidance/guidance-source.controller";
import type { GuidanceSourceSeed } from "../../../src/scrapers/guidance/types";
import { buildPdf } from "../../helpers/pdf-fixture";
import { fakeCollection, fakeRunTransaction, resetStore, store } from "../../helpers/fake-firestore";

// ----- Synthetic publisher -----

// The stable page that lists the current file, and the host files live on.
const PAGE_HOST = "www.gamma-registry.example";
const FILE_HOST = "files.gamma-registry.example";
const PAGE_URL = `https://${PAGE_HOST}/publications/lighthouse-keeper-handbook`;
// Two releases of the same handbook: the release id in the path differs.
const FILE_V1 = `https://${FILE_HOST}/media/aa11/handbook.pdf`;
const FILE_V2 = `https://${FILE_HOST}/media/bb22/handbook-revised.pdf`;
// Matches any release id and any file name on the file host.
const LINK_PATTERN = "https://files\\.gamma-registry\\.example/media/[0-9a-f]+/[^/?#]+\\.pdf";

/** The handbook's registry entry. `url` is the address seen at retrieval. */
const HANDBOOK: GuidanceSourceSeed = {
  id: "gamma-lighthouse-handbook",
  title: "Lighthouse keeper handbook",
  url: FILE_V1,
  resolveFrom: { pageUrl: PAGE_URL, linkPattern: LINK_PATTERN },
  jurisdiction: "GG",
  route: "lighthouse-keeper",
  docType: "pdf",
  publishedDateSelector: "issued to keepers on (\\d{1,2} [A-Za-z]+ \\d{4})",
  checkIntervalHours: 24,
  verificationStatus: "verified",
  verificationNote: "Whole fictional handbook retrieved by hand on 2026-11-10.",
  retrievedAt: "2026-11-10",
};

// Fictional body text, long enough to clear the fetch service's floor.
const FILLER = "The keeper records the colour of the lamp and the height of the tide in the harbour ledger each evening.";
const PAGES_V1 = [`Handbook\nThis handbook was issued to keepers on 2 February 2026\n${FILLER}`, `Lamp oil\nKeep three barrels in reserve.\n${FILLER}`];
const PAGES_V2 = [`Handbook\nThis handbook was issued to keepers on 9 September 2026\n${FILLER}`, `Lamp oil\nKeep five barrels in reserve.\n${FILLER}`];

/** The parent page, linking to the given files (plus unrelated links). */
const listing = (...files: string[]) =>
  "<html><body><main><h1>Lighthouse keeper handbook</h1>" +
  "<a href=\"/publications\">All publications</a>" +
  `<a href="https://${FILE_HOST}/media/cc33/cover.png">Cover image</a>` +
  files.map((f) => `<a class="attachment" href="${f}">Download</a>`).join("") +
  "</main></body></html>";

// ----- Stub HTTP client -----

/** One stubbed response. */
interface StubResponse {
  status?: number;
  body?: string | Buffer;
  contentType?: string;
  responseUrl?: string; // post-redirect URL, as the real client reports it
}

/** Routes the stub serves; tests change it between runs. */
let routes: Record<string, StubResponse>;
/** Every URL requested, in order. */
let calls: string[];

const http: VisaCatalogHttpClient = {
  async get(url) {
    calls.push(url);
    const r: StubResponse =
      routes[url] ??
      (url.endsWith("/robots.txt")
        ? { status: 200, body: "", contentType: "text/plain" }
        : { status: 404, body: "<html>not found</html>", contentType: "text/html" });
    return {
      status: r.status ?? 200,
      data: r.body ?? "",
      headers: { "content-type": r.contentType ?? "" },
      ...(r.responseUrl ? { request: { res: { responseUrl: r.responseUrl } } } : {}),
    };
  },
};

const htmlRoute = (body: string, extra: Partial<StubResponse> = {}): StubResponse => ({ body, contentType: "text/html; charset=utf-8", ...extra });
const pdfRoute = (pages: string[], extra: Partial<StubResponse> = {}): StubResponse => ({ body: buildPdf(pages), contentType: "application/pdf", ...extra });

/** URLs requested, minus robots.txt. */
const pageCalls = () => calls.filter((u) => !u.endsWith("/robots.txt"));

// ----- In-memory bucket (create-only, as Cloud Storage enforces it) -----

let objects: Map<string, string>;

const bucket: SnapshotBucket = {
  file(name: string) {
    return {
      async save(data, options) {
        if (options.preconditionOpts.ifGenerationMatch === 0 && objects.has(name)) {
          throw Object.assign(new Error("Precondition Failed"), { code: 412 });
        }
        objects.set(name, data);
      },
      async exists() {
        return [objects.has(name)];
      },
      async download() {
        const data = objects.get(name);
        if (data === undefined) throw Object.assign(new Error("No such object"), { code: 404 });
        return [Buffer.from(data, "utf8")];
      },
    };
  },
};

// ----- Harness -----

const T0 = Date.parse("2026-11-11T02:00:00Z");
const HOUR = 60 * 60 * 1000;
const at = (ms: number) => Timestamp.fromMillis(ms);
const snapshots = new GuidanceSnapshotStore(bucket);

/** Put a seed entry in the fake registry, as the seed would. */
const seed = (s: GuidanceSourceSeed) => store.set(`guidanceSources/${s.id}`, buildSeededGuidanceSource(s, undefined, at(T0 - HOUR)));
/** The stored source doc. */
const source = (id: string) => store.get(`guidanceSources/${id}`) as Record<string, any>;
/** Paths of a source's snapshot docs. */
const snapshotPaths = (id: string) => [...store.keys()].filter((p) => p.startsWith(`guidanceSources/${id}/snapshots/`));

/** A crawl service over the stubbed network and the in-memory stores. */
function makeService(): GuidanceCrawlService {
  const fetcher = new VisaCatalogFetchService({ http, minIntervalMs: 0, clock: () => T0 });
  const svc = new GuidanceCrawlService(fetcher, snapshots);
  svc.runTransaction = fakeRunTransaction as any;
  return svc;
}

/** Run with console output silenced (the crawl logs its summary and failures). */
async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => undefined;
  try {
    return await fn();
  } finally {
    Object.assign(console, saved);
  }
}

before(async () => {
  // Swap the real Firestore refs for the in-memory fake.
  const firebase: any = await import("../../../src/utils/firebase");
  firebase.collections.guidanceSources = fakeCollection("guidanceSources");
  firebase.subcollections.guidanceSnapshots = (id: string) => fakeCollection(`guidanceSources/${id}/snapshots`);
});

beforeEach(() => {
  resetStore();
  routes = { [PAGE_URL]: htmlRoute(listing(FILE_V1)), [FILE_V1]: pdfRoute(PAGES_V1), [FILE_V2]: pdfRoute(PAGES_V2) };
  calls = [];
  objects = new Map();
});

// ============================================
// Seed validation
// ============================================

describe("guidance resolveFrom: seed validation", () => {
  test("an entry with a parent page and a host-pinned pattern is valid", () => {
    assert.deepEqual(validateGuidanceSourceSeed(HANDBOOK), []);
    assert.deepEqual(resolveFromProblems(HANDBOOK.resolveFrom), []);
  });

  test("the page must be https and the pattern must be a usable expression", () => {
    const bad = (resolveFrom: unknown) => resolveFromProblems(resolveFrom).join(" | ");
    assert.match(bad("https://x.example"), /must be an object/);
    assert.match(bad({ pageUrl: "http://www.gamma-registry.example/p", linkPattern: LINK_PATTERN }), /pageUrl must be an absolute https URL/);
    assert.match(bad({ pageUrl: PAGE_URL }), /linkPattern is required/);
    assert.match(bad({ pageUrl: PAGE_URL, linkPattern: "https://files\\.gamma-registry\\.example/(" }), /not a valid regular expression/);
    assert.match(bad({ pageUrl: PAGE_URL, linkPattern: `https://files\\.gamma-registry\\.example/${"a".repeat(400)}` }), /longer than/);
    assert.match(bad({ pageUrl: PAGE_URL, linkPattern: "https://files\\.gamma-registry\\.example/(?:[a-z]+/)+x\\.pdf" }), /nested quantifiers/);
  });

  test("the pattern must pin the host: a page can never send the crawl somewhere else", () => {
    const problems = (linkPattern: string) => resolveFromProblems({ pageUrl: PAGE_URL, linkPattern }).join(" | ");
    // No literal origin at all, a wildcard host, an unescaped dot, plain http.
    for (const p of [".+\\.pdf", "https://[^/]+/media/.+\\.pdf", "https://files.gamma-registry.example/.+\\.pdf", "http://files\\.gamma-registry\\.example/.+\\.pdf"]) {
      assert.match(problems(p), /must begin with a literal https:\/\/<host>\//, p);
    }
    // A top-level alternative would let the second branch name any host.
    assert.match(problems("https://files\\.gamma-registry\\.example/a\\.pdf|https://.+"), /top-level alternative/);
    // The same alternative inside a group is fine: the literal start still applies.
    assert.equal(problems("https://files\\.gamma-registry\\.example/media/(?:a|b)\\.pdf"), "");
  });

  test("resolveFrom and expectedFinalUrl cannot be combined", () => {
    const problems = validateGuidanceSourceSeed({ ...HANDBOOK, expectedFinalUrl: FILE_V1 });
    assert.ok(problems.some((p) => /expectedFinalUrl cannot be combined with resolveFrom/.test(p)));
  });

  test("the seeded doc stores the two strings, and null when the entry has none", () => {
    const doc = buildSeededGuidanceSource(HANDBOOK, undefined, at(T0));
    assert.deepEqual(doc.resolveFrom, { pageUrl: PAGE_URL, linkPattern: LINK_PATTERN });
    assert.notEqual(doc.resolveFrom, HANDBOOK.resolveFrom, "a copy, not the seed's own object");
    assert.equal(doc.resolvedUrl, null);
    const { resolveFrom: _dropped, ...plain } = HANDBOOK;
    assert.equal(buildSeededGuidanceSource(plain, undefined, at(T0)).resolveFrom, null);
  });
});

// ============================================
// The link lookup
// ============================================

describe("guidance resolveFrom: finding the link", () => {
  test("only links that match the whole pattern count; relative links are resolved; duplicates collapse", () => {
    const page =
      `<a href="${FILE_V1}">a</a><a href="${FILE_V1}#page=2">same file, with a fragment</a>` +
      "<a href=\"/media/aa11/handbook.pdf\">relative, so on the PAGE host</a>" +
      `<a href="${FILE_V1}.sig">longer than the pattern</a>` +
      `<a href="http://${FILE_HOST}/media/aa11/handbook.pdf">not https</a>` +
      "<a href=\"https://files.gamma-registry.example.evil.example/media/aa11/handbook.pdf\">another host</a>" +
      "<a href=\"mailto:keeper@gamma-registry.example\">mail</a><a>no href</a>";
    assert.deepEqual(findMatchingLinks(page, PAGE_URL, LINK_PATTERN), [FILE_V1]);
  });

  test("a relative link is resolved against the page it is on", () => {
    const pattern = "https://www\\.gamma-registry\\.example/files/[a-z]+\\.pdf";
    assert.deepEqual(findMatchingLinks("<a href=\"../files/handbook.pdf\">x</a>", PAGE_URL, pattern), [
      `https://${PAGE_HOST}/files/handbook.pdf`,
    ]);
  });
});

// ============================================
// Crawling a document whose address moves
// ============================================

describe("guidance resolveFrom: crawl", () => {
  test("the address is read from the parent page, then that address is fetched and recorded", async () => {
    seed(HANDBOOK);
    const summary = await quiet(() => makeService().runOrchestrator({ now: at(T0) }));

    assert.equal(summary.changed, 1);
    assert.equal(summary.snapshotsWritten, 1);
    // Parent page first, then the file it linked to. Nothing else.
    assert.deepEqual(pageCalls(), [PAGE_URL, FILE_V1]);
    // robots.txt was read for BOTH hosts before either was asked for a page.
    assert.ok(calls.indexOf(`https://${PAGE_HOST}/robots.txt`) < calls.indexOf(PAGE_URL));
    assert.ok(calls.indexOf(`https://${FILE_HOST}/robots.txt`) < calls.indexOf(FILE_V1));

    const s = source(HANDBOOK.id);
    assert.equal(s.resolvedUrl, FILE_V1);
    assert.equal(s.finalUrl, FILE_V1);
    assert.equal(s.publishedDate, "2026-02-02");
    const meta = store.get(`guidanceSources/${HANDBOOK.id}/snapshots/${s.lastContentHash}`) as Record<string, any>;
    assert.equal(meta.url, FILE_V1);
    assert.equal(meta.resolvedFromUrl, PAGE_URL);
    assert.equal(meta.pageCount, 2);
    // The admin list shows where the address came from and what it was.
    const item = toGuidanceSourceListItem(HANDBOOK.id, s);
    assert.equal(item.resolveFromPageUrl, PAGE_URL);
    assert.equal(item.resolvedUrl, FILE_V1);
  });

  test("a second run with nothing changed writes no snapshot and does zero downstream work", async () => {
    seed(HANDBOOK);
    const svc = makeService();
    let notified = 0;
    const onChanged = () => void notified++;
    await quiet(() => svc.runOrchestrator({ now: at(T0), onChanged }));
    assert.equal(notified, 1);

    const again = await quiet(() => svc.runOrchestrator({ now: at(T0 + 25 * HOUR), onChanged }));
    assert.equal(again.unchanged, 1);
    assert.equal(again.changed, 0);
    assert.equal(again.snapshotsWritten, 0);
    assert.equal(again.storageObjectsWritten, 0);
    assert.equal(again.downstreamCalls, 0);
    assert.equal(notified, 1);
    assert.equal(snapshotPaths(HANDBOOK.id).length, 1);
    assert.equal(objects.size, 1);
  });

  test("a new publication (new address, new text) yields a new hash and snapshot; the previous one stays readable", async () => {
    seed(HANDBOOK);
    const svc = makeService();
    await quiet(() => svc.runOrchestrator({ now: at(T0) }));
    const h1 = source(HANDBOOK.id).lastContentHash as string;
    const first = await snapshots.read(HANDBOOK.id, h1);

    // The publisher re-issues the handbook: the page now links to a new file
    // and the old address is gone. The registry entry is NOT touched.
    routes[PAGE_URL] = htmlRoute(listing(FILE_V2));
    delete routes[FILE_V1];
    calls = [];
    const summary = await quiet(() => svc.runOrchestrator({ now: at(T0 + 25 * HOUR) }));

    const s = source(HANDBOOK.id);
    const h2 = s.lastContentHash as string;
    assert.equal(summary.failed, 0);
    assert.equal(summary.changed, 1);
    assert.equal(summary.snapshotsWritten, 1);
    assert.notEqual(h2, h1);
    assert.deepEqual(pageCalls(), [PAGE_URL, FILE_V2], "the stale address in the seed is never requested");
    assert.equal(s.url, FILE_V1, "the seed's record of the retrieval-day address is kept");
    assert.equal(s.resolvedUrl, FILE_V2);
    assert.equal(s.finalUrl, FILE_V2);
    assert.equal(s.status, "active");
    assert.equal(s.publishedDate, "2026-09-09");
    assert.equal(snapshotPaths(HANDBOOK.id).length, 2);
    const meta2 = store.get(`guidanceSources/${HANDBOOK.id}/snapshots/${h2}`) as Record<string, any>;
    assert.equal(meta2.previousContentHash, h1);
    assert.equal(meta2.url, FILE_V2);

    // Both snapshots are addressable by hash, each with its own text and pages.
    const second = await snapshots.read(HANDBOOK.id, h2);
    const firstAgain = await snapshots.read(HANDBOOK.id, h1);
    assert.deepEqual(firstAgain, first);
    assert.ok(firstAgain.pages![1].text.includes("three barrels"));
    assert.ok(second.pages![1].text.includes("five barrels"));
    assert.equal(firstAgain.url, FILE_V1);
    assert.equal(second.url, FILE_V2);
  });

  test("the same text under a new address is unchanged: no snapshot, but the new address is recorded", async () => {
    seed(HANDBOOK);
    const svc = makeService();
    await quiet(() => svc.runOrchestrator({ now: at(T0) }));
    const h1 = source(HANDBOOK.id).lastContentHash;

    // Re-uploaded under a new release id, byte-identical text.
    routes[PAGE_URL] = htmlRoute(listing(FILE_V2));
    routes[FILE_V2] = pdfRoute(PAGES_V1);
    const summary = await quiet(() => svc.runOrchestrator({ now: at(T0 + 25 * HOUR) }));

    assert.equal(summary.unchanged, 1);
    assert.equal(summary.snapshotsWritten, 0);
    assert.equal(summary.storageObjectsWritten, 0);
    assert.equal(source(HANDBOOK.id).lastContentHash, h1);
    assert.equal(source(HANDBOOK.id).resolvedUrl, FILE_V2);
    assert.equal(snapshotPaths(HANDBOOK.id).length, 1);
  });
});

// ============================================
// Lookups that fail ingest nothing
// ============================================

describe("guidance resolveFrom: failures", () => {
  /** Crawl once and return the summary's single result plus the source. */
  async function crawlOnce() {
    seed(HANDBOOK);
    const summary = await quiet(() => makeService().runOrchestrator({ now: at(T0) }));
    return { summary, result: summary.results[0], s: source(HANDBOOK.id) };
  }
  /** Nothing was stored for the source. */
  const assertNothingIngested = () => {
    assert.equal(objects.size, 0);
    assert.equal(snapshotPaths(HANDBOOK.id).length, 0);
    assert.equal(source(HANDBOOK.id).lastContentHash, null);
  };

  test("no matching link: resolve_failed, and the file is never requested", async () => {
    routes[PAGE_URL] = htmlRoute(listing());
    const { result, s } = await crawlOnce();
    assert.equal(result.outcome, "failed");
    assert.equal(result.errorKind, "resolve_failed");
    assert.match(result.error!, /No link on .* matches/);
    assert.equal(s.consecutiveFailures, 1);
    assert.deepEqual(pageCalls(), [PAGE_URL]);
    assertNothingIngested();
  });

  test("two different matching links: resolve_failed, the crawl never guesses", async () => {
    routes[PAGE_URL] = htmlRoute(listing(FILE_V1, FILE_V2));
    const { result } = await crawlOnce();
    assert.equal(result.errorKind, "resolve_failed");
    assert.match(result.error!, /2 different links/);
    assert.deepEqual(pageCalls(), [PAGE_URL]);
    assertNothingIngested();
  });

  test("the parent page is missing: resolve_failed with the HTTP status", async () => {
    delete routes[PAGE_URL];
    const { result } = await crawlOnce();
    assert.equal(result.errorKind, "resolve_failed");
    assert.match(result.error!, /HTTP 404/);
    assertNothingIngested();
  });

  test("the parent page redirects somewhere else: its links are not trusted", async () => {
    routes[PAGE_URL] = htmlRoute(listing(FILE_V1), { responseUrl: `https://${PAGE_HOST}/publications/withdrawn` });
    const { result } = await crawlOnce();
    assert.equal(result.errorKind, "redirect_changed");
    assert.deepEqual(pageCalls(), [PAGE_URL]);
    assertNothingIngested();
  });

  test("robots.txt disallows the parent page: neither it nor the file is requested", async () => {
    routes[`https://${PAGE_HOST}/robots.txt`] = { body: "User-agent: *\nDisallow: /publications/", contentType: "text/plain" };
    const { result } = await crawlOnce();
    assert.equal(result.errorKind, "robots_blocked");
    assert.deepEqual(pageCalls(), []);
    assertNothingIngested();
  });

  test("the resolved file redirects to another address: redirect_changed", async () => {
    routes[FILE_V1] = pdfRoute(PAGES_V1, { responseUrl: `https://${FILE_HOST}/media/zz99/other.pdf` });
    const { result } = await crawlOnce();
    assert.equal(result.errorKind, "redirect_changed");
    assertNothingIngested();
  });

  test("a hand-edited doc with a pattern that does not pin the host is refused at crawl time", async () => {
    seed(HANDBOOK);
    source(HANDBOOK.id).resolveFrom = { pageUrl: PAGE_URL, linkPattern: "https://[^/]+/.+\\.pdf" };
    const summary = await quiet(() => makeService().runOrchestrator({ now: at(T0) }));
    assert.equal(summary.results[0].errorKind, "resolve_failed");
    assert.match(summary.results[0].error!, /Invalid resolveFrom/);
    assert.deepEqual(pageCalls(), []);
    assertNothingIngested();
  });

  test("failureKindOf maps a lookup error to resolve_failed", () => {
    assert.equal(failureKindOf(new GuidanceResolveError("x")), "resolve_failed");
  });
});
