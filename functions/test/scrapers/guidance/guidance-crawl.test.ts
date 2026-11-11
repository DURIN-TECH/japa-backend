// ============================================
// Guidance crawl (issue #39) — unit tests, no network, no emulator
// ============================================
//
// Drives GuidanceCrawlService end to end over:
//  - the REAL shared fetch service (VisaCatalogFetchService: robots.txt,
//    per-host gap, 429/503 backoff, PDF reading) on a stubbed HTTP client;
//  - the in-memory Firestore fake (test/helpers/fake-firestore.ts);
//  - an in-memory bucket that enforces the create-only precondition the way
//    Cloud Storage does.
//
// The registry is data, so the fixtures are deliberately synthetic: two
// made-up publishers on made-up hosts, one publishing a web page and one a
// PDF, with made-up jurisdiction and route keys. Nothing in the code under
// test knows any of these values.

import { before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Timestamp } from "firebase-admin/firestore";
import {
  HtmlTextTooLongError,
  MAX_CLEAN_TEXT_CHARS,
  VisaCatalogFetchService,
  VisaCatalogHttpClient,
} from "../../../src/scrapers/shared/fetch/visa-catalog-fetch.service";
import { PDF_PAGE_SEPARATOR } from "../../../src/scrapers/shared/fetch/pdf-text";
import {
  GuidanceChangeEvent,
  GuidanceCrawlService,
  failureKindOf,
  sameDocumentUrl,
} from "../../../src/scrapers/guidance/guidance-crawl.service";
import {
  GuidanceSnapshotStore,
  SnapshotBucket,
  guidanceSnapshotPath,
} from "../../../src/scrapers/guidance/guidance-snapshot.store";
import { buildSeededGuidanceSource } from "../../../src/scrapers/guidance/data/seed-guidance-sources";
import type { GuidanceSnapshotContent, GuidanceSourceSeed } from "../../../src/scrapers/guidance/types";
import { buildPdf } from "../../helpers/pdf-fixture";
import { fakeCollection, fakeRunTransaction, resetStore, store, writes } from "../../helpers/fake-firestore";

// ----- Synthetic registry -----

// Publisher A: a ministry publishing its rules as a web page.
const A_HOST = "rules.alpha-ministry.example";
const A_URL = `https://${A_HOST}/rules/short-stay`;
// Publisher B: an agency publishing casework guidance as a PDF.
const B_HOST = "files.beta-agency.example";
const B_URL = `https://${B_HOST}/media/7f3a/casework-guidance.pdf`;

/** Publisher A's source: HTML, with a "Last updated" date. */
const SOURCE_A: GuidanceSourceSeed = {
  id: "alpha-short-stay-rules",
  title: "Short stay rules",
  url: A_URL,
  jurisdiction: "AA",
  route: "short-stay",
  docType: "html",
  publishedDateSelector: "Last updated:? (\\d{1,2} [A-Za-z]+ \\d{4})",
  checkIntervalHours: 24,
  verificationStatus: "verified",
  verificationNote: "Whole page retrieved by hand on 2026-11-10.",
  retrievedAt: "2026-11-10",
};

/** Publisher B's source: PDF, with a "published for staff on" date. */
const SOURCE_B: GuidanceSourceSeed = {
  id: "beta-study-casework",
  title: "Study route: casework guidance",
  url: B_URL,
  jurisdiction: "BB",
  route: "study",
  docType: "pdf",
  publishedDateSelector: "published for staff on (\\d{1,2} [A-Za-z]+ \\d{4})",
  checkIntervalHours: 168,
  verificationStatus: "partial",
  verificationNote: "First 2 of 3 pages read by hand on 2026-11-10; the last page timed out.",
  retrievedAt: "2026-11-10T09:00:00Z",
  retrievalError: "timeout after page 2",
};

// Body text long enough to clear the fetch service's 100-character floor.
const FILLER = "The decision maker must weigh every piece of evidence and record the reasons for the decision reached.";

/** A web page whose main region carries `body`. */
const htmlPage = (body: string) =>
  `<html><head><title>t</title></head><body><nav>menu</nav><main><h1>Rules</h1><p>${body}</p><p>${FILLER}</p></main></body></html>`;

const A_V1 = htmlPage("Last updated: 3 March 2026. An applicant must intend to leave at the end of the stay.");
const A_V2 = htmlPage("Last updated: 9 October 2026. An applicant must intend to leave at the end of the stay and hold funds.");

const B_PAGES_V1 = [
  `Casework guidance\nThis guidance was published for staff on 14 July 2026\n${FILLER}`,
  `Assessing intention\nConsider the course and the sponsor.\n${FILLER}`,
  `Refusal wording\nUse the standard paragraphs.\n${FILLER}`,
];

/** sha256 hex, independently of the code under test. */
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

// ----- Stub HTTP client -----

/** One stubbed response. */
interface StubResponse {
  status?: number;
  body?: string | Buffer;
  contentType?: string;
  headers?: Record<string, unknown>;
  responseUrl?: string; // post-redirect URL, as the real client reports it
}

/** Routes the stub serves; tests mutate it between runs. */
let routes: Record<string, StubResponse>;
/** Every request made, in order, with the time it was made. */
let calls: { url: string; at: number }[];

const http: VisaCatalogHttpClient = {
  async get(url) {
    calls.push({ url, at: Date.now() });
    const r: StubResponse =
      routes[url] ??
      (url.endsWith("/robots.txt")
        ? { status: 200, body: "", contentType: "text/plain" }
        : { status: 404, body: "<html>not found</html>", contentType: "text/html" });
    return {
      status: r.status ?? 200,
      data: r.body ?? "",
      headers: { "content-type": r.contentType ?? "", ...(r.headers ?? {}) },
      ...(r.responseUrl ? { request: { res: { responseUrl: r.responseUrl } } } : {}),
    };
  },
};

const html = (body: string, extra: Partial<StubResponse> = {}): StubResponse => ({ body, contentType: "text/html; charset=utf-8", ...extra });
const pdf = (pages: string[], extra: Partial<StubResponse> = {}): StubResponse => ({
  body: buildPdf(pages),
  contentType: "application/pdf",
  ...extra,
});

/** URLs requested, minus robots.txt. */
const pageCalls = () => calls.filter((c) => !c.url.endsWith("/robots.txt")).map((c) => c.url);

// ----- In-memory bucket (create-only, like `ifGenerationMatch: 0`) -----

let objects: Map<string, { data: string; options: any }>;
/** save() attempts, including refused ones. */
let saveAttempts: number;

const bucket: SnapshotBucket = {
  file(name: string) {
    return {
      async save(data, options) {
        saveAttempts++;
        // Cloud Storage refuses a create-only write of an existing object.
        if (options.preconditionOpts.ifGenerationMatch === 0 && objects.has(name)) {
          throw Object.assign(new Error("Precondition Failed"), { code: 412 });
        }
        objects.set(name, { data, options });
      },
      async download() {
        const o = objects.get(name);
        if (!o) throw Object.assign(new Error("No such object"), { code: 404 });
        return [Buffer.from(o.data, "utf8")];
      },
    };
  },
};

// ----- Harness -----

/** The run clock: tests move it forward explicitly. */
const T0 = Date.parse("2026-11-11T02:00:00Z");
const HOUR = 60 * 60 * 1000;
const at = (ms: number) => Timestamp.fromMillis(ms);

/** Put seed entries in the fake registry, as the seed would. */
function seed(...seeds: GuidanceSourceSeed[]): void {
  for (const s of seeds) store.set(`guidanceSources/${s.id}`, buildSeededGuidanceSource(s, undefined, at(T0 - HOUR)));
}

/** The stored source doc. */
const source = (id: string) => store.get(`guidanceSources/${id}`) as Record<string, any>;
/** Paths of the snapshot docs of a source. */
const snapshotPaths = (id: string) => [...store.keys()].filter((p) => p.startsWith(`guidanceSources/${id}/snapshots/`));
/** The stored JSON object of a snapshot. */
const stored = (id: string, hash: string): GuidanceSnapshotContent => JSON.parse(objects.get(guidanceSnapshotPath(id, hash))!.data);

/** A crawl service over the stubbed network and the in-memory stores. */
function makeService(minIntervalMs = 0): GuidanceCrawlService {
  const fetcher = new VisaCatalogFetchService({ http, minIntervalMs });
  const svc = new GuidanceCrawlService(fetcher, new GuidanceSnapshotStore(bucket));
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
  routes = { [A_URL]: html(A_V1), [B_URL]: pdf(B_PAGES_V1) };
  calls = [];
  objects = new Map();
  saveAttempts = 0;
});

// ============================================
// First fetch: snapshots for an HTML and a PDF source
// ============================================

describe("guidance crawl: first fetch", () => {
  test("stores a hash-keyed snapshot for an HTML source and for a PDF source from another publisher", async () => {
    seed(SOURCE_A, SOURCE_B);
    const summary = await quiet(() => makeService().runOrchestrator({ now: at(T0) }));

    assert.equal(summary.sourcesFetched, 2);
    assert.equal(summary.changed, 2);
    assert.equal(summary.snapshotsWritten, 2);
    assert.equal(summary.storageObjectsWritten, 2);
    assert.equal(summary.failed, 0);

    // ---- HTML source ----
    const a = source(SOURCE_A.id);
    assert.match(a.lastContentHash, /^[a-f0-9]{64}$/);
    assert.equal(a.latestSnapshotId, a.lastContentHash);
    assert.equal(a.status, "active");
    assert.equal(a.url, A_URL);
    assert.equal(a.finalUrl, A_URL);
    assert.ok(a.lastFetchedAt instanceof Timestamp);
    // Publisher-reported date, parsed and as written.
    assert.equal(a.publishedDate, "2026-03-03");
    assert.equal(a.publishedDateText, "3 March 2026");

    const aMeta = store.get(`guidanceSources/${SOURCE_A.id}/snapshots/${a.lastContentHash}`) as Record<string, any>;
    const aObj = stored(SOURCE_A.id, a.lastContentHash);
    // The key IS the hash of the stored text.
    assert.equal(sha256(aObj.text), a.lastContentHash);
    assert.ok(aObj.text.includes("An applicant must intend to leave"));
    assert.ok(!aObj.text.includes("menu"), "navigation boilerplate is not part of the snapshot");
    assert.equal(aObj.pages, null);
    assert.deepEqual(
      {
        sourceId: aMeta.sourceId,
        contentHash: aMeta.contentHash,
        docType: aMeta.docType,
        url: aMeta.url,
        finalUrl: aMeta.finalUrl,
        httpStatus: aMeta.httpStatus,
        publishedDate: aMeta.publishedDate,
        pageCount: aMeta.pageCount,
        charCount: aMeta.charCount,
        byteLength: aMeta.byteLength,
        sourceByteLength: aMeta.sourceByteLength,
        storagePath: aMeta.storagePath,
        previousContentHash: aMeta.previousContentHash,
      },
      {
        sourceId: SOURCE_A.id,
        contentHash: a.lastContentHash,
        docType: "html",
        url: A_URL,
        finalUrl: A_URL,
        httpStatus: 200,
        publishedDate: "2026-03-03",
        pageCount: null,
        charCount: aObj.text.length,
        byteLength: Buffer.byteLength(aObj.text, "utf8"),
        sourceByteLength: null,
        storagePath: `guidance-snapshots/${SOURCE_A.id}/${a.lastContentHash}.json`,
        previousContentHash: null,
      }
    );
    assert.ok(aMeta.fetchedAt instanceof Timestamp);

    // ---- PDF source: per-page text with page numbers ----
    const b = source(SOURCE_B.id);
    const bMeta = store.get(`guidanceSources/${SOURCE_B.id}/snapshots/${b.lastContentHash}`) as Record<string, any>;
    const bObj = stored(SOURCE_B.id, b.lastContentHash);
    assert.equal(bMeta.docType, "pdf");
    assert.equal(bMeta.pageCount, 3);
    assert.ok(bMeta.sourceByteLength > 0);
    assert.deepEqual(bObj.pages!.map((p) => p.page), [1, 2, 3]);
    assert.ok(bObj.pages![1].text.includes("Assessing intention"));
    assert.ok(bObj.pages![2].text.includes("Refusal wording"));
    // The whole text is the pages joined by a form feed, and is what was hashed.
    assert.equal(bObj.text, bObj.pages!.map((p) => p.text).join(PDF_PAGE_SEPARATOR));
    assert.equal(sha256(bObj.text), b.lastContentHash);
    assert.equal(b.publishedDate, "2026-07-14");
    // A partial source IS crawled (only unverified ones are skipped).
    assert.equal(b.verificationStatus, "partial");
  });

  test("objects are saved private: create-only, no public flag, no download token", async () => {
    seed(SOURCE_A);
    await quiet(() => makeService().runOrchestrator({ now: at(T0) }));
    const [[name, obj]] = [...objects.entries()];
    assert.ok(name.startsWith("guidance-snapshots/"));
    assert.deepEqual(obj.options.preconditionOpts, { ifGenerationMatch: 0 });
    assert.equal(obj.options.public, undefined);
    assert.equal(obj.options.predefinedAcl, undefined);
    assert.equal(obj.options.metadata.metadata.firebaseStorageDownloadTokens, undefined);
    assert.equal(obj.options.metadata.cacheControl, "private, no-store");
  });

  test("a long web page is stored whole, not cut at the visa-page cap", async () => {
    // ~40,000 characters of distinct sentences, well over the 24,000 cap.
    const long = Array.from({ length: 400 }, (_, i) => `Paragraph ${i}: ${FILLER}`).join(" ");
    routes[A_URL] = html(htmlPage(`${long} FINAL SENTENCE OF THE DOCUMENT.`));
    seed(SOURCE_A);
    await quiet(() => makeService().runOrchestrator({ now: at(T0) }));
    const a = source(SOURCE_A.id);
    const text = stored(SOURCE_A.id, a.lastContentHash).text;
    assert.ok(text.length > MAX_CLEAN_TEXT_CHARS);
    assert.ok(text.includes("FINAL SENTENCE OF THE DOCUMENT."));
  });
});

// ============================================
// Hash gate: an unchanged source is a no-op
// ============================================

describe("guidance crawl: hash gate", () => {
  test("a second run over unchanged sources does zero downstream work", async () => {
    seed(SOURCE_A, SOURCE_B);
    const svc = makeService();
    const events: GuidanceChangeEvent[] = [];
    const onChanged = async (e: GuidanceChangeEvent) => void events.push(e);
    await quiet(() => svc.runOrchestrator({ now: at(T0), onChanged }));
    assert.equal(events.length, 2);

    // Second run, a fortnight later: both sources are due again.
    const snapshotDocsBefore = [...store.keys()].filter((p) => p.includes("/snapshots/")).sort();
    const objectsBefore = new Map(objects);
    events.length = 0;
    writes.length = 0;
    saveAttempts = 0;
    calls = [];
    const second = await quiet(() => svc.runOrchestrator({ now: at(T0 + 14 * 24 * HOUR), onChanged }));

    // Both were fetched again (that is how "unchanged" is known)...
    assert.equal(second.sourcesFetched, 2);
    assert.equal(second.unchanged, 2);
    assert.deepEqual(pageCalls().sort(), [B_URL, A_URL].sort());
    // ...and nothing downstream happened.
    assert.equal(second.changed, 0);
    assert.equal(second.snapshotsWritten, 0);
    assert.equal(second.storageObjectsWritten, 0);
    assert.equal(second.downstreamCalls, 0);
    assert.equal(events.length, 0, "the change listener is not called");
    assert.equal(saveAttempts, 0, "Cloud Storage is not written to (not even attempted)");
    assert.deepEqual([...store.keys()].filter((p) => p.includes("/snapshots/")).sort(), snapshotDocsBefore);
    assert.deepEqual(objects, objectsBefore);
    // The only Firestore writes are the two fetch-time stamps on the sources.
    assert.deepEqual(writes.map((w) => `${w.op} ${w.path}`).sort(), [
      `update guidanceSources/${SOURCE_A.id}`,
      `update guidanceSources/${SOURCE_B.id}`,
    ]);
    for (const w of writes) {
      assert.equal(w.data.lastContentHash, undefined, "the hash is not rewritten");
      assert.equal(w.data.latestSnapshotId, undefined);
      assert.equal(w.data.lastChangedAt, undefined);
    }
    assert.equal(source(SOURCE_A.id).lastAttemptAt.toMillis(), T0 + 14 * 24 * HOUR);
  });

  test("a source checked within its interval is not requested at all", async () => {
    seed(SOURCE_A);
    const svc = makeService();
    await quiet(() => svc.runOrchestrator({ now: at(T0) }));
    calls = [];
    // 23h later, interval 24h.
    const summary = await quiet(() => svc.runOrchestrator({ now: at(T0 + 23 * HOUR) }));
    assert.equal(summary.notDue, 1);
    assert.equal(calls.length, 0);
  });

  test("changed content adds a snapshot, records the change and leaves the old snapshot untouched", async () => {
    seed(SOURCE_A);
    const svc = makeService();
    const events: GuidanceChangeEvent[] = [];
    const onChanged = (e: GuidanceChangeEvent) => void events.push(e);
    await quiet(() => svc.runOrchestrator({ now: at(T0), onChanged }));
    const h1 = source(SOURCE_A.id).lastContentHash as string;
    const firstMeta = JSON.stringify(store.get(`guidanceSources/${SOURCE_A.id}/snapshots/${h1}`));
    const firstObject = objects.get(guidanceSnapshotPath(SOURCE_A.id, h1))!.data;

    // The publisher edits the page.
    routes[A_URL] = html(A_V2);
    events.length = 0;
    const t1 = T0 + 25 * HOUR;
    const summary = await quiet(() => svc.runOrchestrator({ now: at(t1), onChanged }));
    const a = source(SOURCE_A.id);
    const h2 = a.lastContentHash as string;

    assert.notEqual(h2, h1);
    assert.equal(summary.changed, 1);
    assert.equal(summary.snapshotsWritten, 1);
    assert.equal(summary.storageObjectsWritten, 1);
    assert.equal(snapshotPaths(SOURCE_A.id).length, 2);
    // The change is recorded on the source and on the new snapshot.
    assert.equal(a.latestSnapshotId, h2);
    assert.equal(a.lastChangedAt.toMillis(), t1);
    assert.equal(a.publishedDate, "2026-10-09");
    const meta2 = store.get(`guidanceSources/${SOURCE_A.id}/snapshots/${h2}`) as Record<string, any>;
    assert.equal(meta2.previousContentHash, h1);
    assert.deepEqual(events, [
      { sourceId: SOURCE_A.id, contentHash: h2, previousContentHash: h1, storagePath: guidanceSnapshotPath(SOURCE_A.id, h2) },
    ]);
    // Immutable: the first snapshot's doc and object are byte-for-byte the same.
    assert.equal(JSON.stringify(store.get(`guidanceSources/${SOURCE_A.id}/snapshots/${h1}`)), firstMeta);
    assert.equal(objects.get(guidanceSnapshotPath(SOURCE_A.id, h1))!.data, firstObject);

    // The publisher reverts: the earlier snapshot is reused, nothing new is stored.
    routes[A_URL] = html(A_V1);
    const back = await quiet(() => svc.runOrchestrator({ now: at(t1 + 25 * HOUR), onChanged }));
    assert.equal(back.changed, 1);
    assert.equal(back.snapshotsWritten, 0);
    assert.equal(back.storageObjectsWritten, 0);
    assert.equal(snapshotPaths(SOURCE_A.id).length, 2);
    assert.equal(source(SOURCE_A.id).latestSnapshotId, h1);
    assert.equal(JSON.stringify(store.get(`guidanceSources/${SOURCE_A.id}/snapshots/${h1}`)), firstMeta);
  });

  test("a change listener that throws becomes a warning, not a failed source", async () => {
    seed(SOURCE_A);
    const summary = await quiet(() =>
      makeService().runOrchestrator({
        now: at(T0),
        onChanged: () => {
          throw new Error("downstream is down");
        },
      })
    );
    assert.equal(summary.changed, 1);
    assert.equal(summary.failed, 0);
    assert.equal(summary.warnings.length, 1);
    assert.match(summary.warnings[0], /change listener failed: downstream is down/);
    assert.equal(source(SOURCE_A.id).consecutiveFailures, 0);
  });
});

// ============================================
// Verification honesty: unverified sources are skipped and reported
// ============================================

describe("guidance crawl: unverified sources", () => {
  const UNVERIFIED: GuidanceSourceSeed = {
    ...SOURCE_A,
    id: "alpha-unverified",
    url: `https://${A_HOST}/rules/long-stay`,
    verificationStatus: "unverified",
    verificationNote: "Could not be retrieved on 2026-11-10: the page was cut off mid-document.",
    retrievedAt: undefined,
    retrievalError: "response truncated at 4096 bytes",
  };

  test("an unverified source produces no fetched content and is reported", async () => {
    routes[UNVERIFIED.url] = html(A_V1);
    seed(UNVERIFIED, SOURCE_B);
    const summary = await quiet(() => makeService().runOrchestrator({ now: at(T0) }));

    assert.deepEqual(summary.skippedUnverified, [UNVERIFIED.id]);
    assert.deepEqual(
      summary.results.find((r) => r.sourceId === UNVERIFIED.id),
      { sourceId: UNVERIFIED.id, outcome: "skipped_unverified" }
    );
    // No request reached its host: not the page, not even robots.txt.
    assert.equal(calls.filter((c) => c.url.includes(A_HOST)).length, 0);
    // No content: no snapshot doc, no stored object, no hash on the source.
    assert.equal(snapshotPaths(UNVERIFIED.id).length, 0);
    assert.equal([...objects.keys()].filter((k) => k.includes(UNVERIFIED.id)).length, 0);
    const doc = source(UNVERIFIED.id);
    assert.equal(doc.lastContentHash, null);
    assert.equal(doc.lastFetchedAt, null);
    // The verified-enough source in the same run was still crawled.
    assert.equal(summary.changed, 1);
  });

  test("naming an unverified source explicitly does not fetch it either", async () => {
    routes[UNVERIFIED.url] = html(A_V1);
    seed(UNVERIFIED);
    const summary = await quiet(() => makeService().runOrchestrator({ now: at(T0), sourceIds: [UNVERIFIED.id] }));
    assert.deepEqual(summary.skippedUnverified, [UNVERIFIED.id]);
    assert.equal(calls.length, 0);
    assert.equal(objects.size, 0);
  });
});

// ============================================
// Etiquette: the shared fetch path (robots.txt, per-host gap, backoff)
// ============================================

describe("guidance crawl: crawler etiquette", () => {
  test("robots.txt is read before the page, and a disallowed URL is never requested", async () => {
    routes[`https://${A_HOST}/robots.txt`] = { body: "User-agent: *\nDisallow: /rules/\n", contentType: "text/plain" };
    seed(SOURCE_A, SOURCE_B);
    const summary = await quiet(() => makeService().runOrchestrator({ now: at(T0) }));

    // Host A: robots.txt only. Host B: robots.txt, then the PDF.
    assert.deepEqual(
      calls.filter((c) => c.url.includes(A_HOST)).map((c) => c.url),
      [`https://${A_HOST}/robots.txt`]
    );
    assert.deepEqual(
      calls.filter((c) => c.url.includes(B_HOST)).map((c) => c.url),
      [`https://${B_HOST}/robots.txt`, B_URL]
    );
    const a = summary.results.find((r) => r.sourceId === SOURCE_A.id)!;
    assert.equal(a.outcome, "failed");
    assert.equal(a.errorKind, "robots_blocked");
    assert.equal(source(SOURCE_A.id).lastErrorKind, "robots_blocked");
    assert.equal(snapshotPaths(SOURCE_A.id).length, 0);
  });

  test("requests to one host are spaced by the per-host delay", async () => {
    const second: GuidanceSourceSeed = { ...SOURCE_A, id: "alpha-second", url: `https://${A_HOST}/rules/transit` };
    routes[second.url] = html(htmlPage("Last updated: 1 May 2026. Transit rules apply to a passenger in transit."));
    seed(SOURCE_A, second);
    const GAP = 60;
    await quiet(() => makeService(GAP).runOrchestrator({ now: at(T0) }));

    // robots.txt + two pages, all on one host: each at least GAP after the last.
    const onHost = calls.filter((c) => c.url.includes(A_HOST));
    assert.equal(onHost.length, 3);
    for (let i = 1; i < onHost.length; i++) {
      const gap = onHost[i].at - onHost[i - 1].at;
      // 5 ms of slack for timer granularity.
      assert.ok(gap >= GAP - 5, `gap ${gap}ms before ${onHost[i].url} is shorter than ${GAP}ms`);
    }
  });

  test("a 429 backs the host off: stored on the source, other sources on that host are not requested", async () => {
    const second: GuidanceSourceSeed = { ...SOURCE_A, id: "alpha-second", url: `https://${A_HOST}/rules/transit` };
    routes[A_URL] = { status: 429, body: "slow down", contentType: "text/plain", headers: { "retry-after": "7200" } };
    routes[second.url] = html(A_V1);
    // Seed order = crawl order (ids sort the same way the fake lists them).
    seed(SOURCE_A, second);
    const svc = makeService();
    const summary = await quiet(() => svc.runOrchestrator({ now: at(T0) }));

    const first = summary.results.find((r) => r.sourceId === SOURCE_A.id)!;
    assert.equal(first.outcome, "failed");
    assert.equal(first.errorKind, "host_backoff");
    const other = summary.results.find((r) => r.sourceId === second.id)!;
    assert.equal(other.outcome, "deferred");
    assert.ok(!pageCalls().includes(second.url), "the second source on the throttling host is not requested");
    // The deferred source is not charged a failure.
    assert.equal(source(second.id).consecutiveFailures, 0);
    assert.ok(source(SOURCE_A.id).backoffUntil.toMillis() > T0);
    assert.ok(source(second.id).backoffUntil.toMillis() > T0);

    // A later run that is still inside the backoff does not touch the host.
    calls = [];
    routes[A_URL] = html(A_V1);
    const later = await quiet(() => svc.runOrchestrator({ now: at(T0 + HOUR), sourceIds: [SOURCE_A.id, second.id] }));
    assert.equal(later.deferred, 2);
    assert.equal(calls.length, 0);
  });
});

// ============================================
// Failures: counted, reported, never thrown
// ============================================

describe("guidance crawl: failing sources", () => {
  test("a source that starts 404ing becomes `failing` after N consecutive failures and is reported", async () => {
    seed(SOURCE_A, SOURCE_B);
    const svc = makeService();
    await quiet(() => svc.runOrchestrator({ now: at(T0) }));
    const goodHash = source(SOURCE_A.id).lastContentHash;

    // The page disappears.
    delete routes[A_URL];
    const LIMIT = 3;
    let t = T0;
    const outcomes: string[] = [];
    for (let i = 1; i <= LIMIT; i++) {
      t += 25 * HOUR;
      // Does not throw: the failure is in the summary.
      const s = await quiet(() => svc.runOrchestrator({ now: at(t), failureLimit: LIMIT }));
      const r = s.results.find((x) => x.sourceId === SOURCE_A.id)!;
      outcomes.push(`${r.outcome}:${r.errorKind}:${r.status}`);
      assert.equal(source(SOURCE_A.id).consecutiveFailures, i);
      if (i < LIMIT) assert.deepEqual(s.newlyFailing, []);
      else {
        assert.deepEqual(s.newlyFailing, [SOURCE_A.id]);
        assert.deepEqual(s.failing, [SOURCE_A.id]);
      }
    }
    assert.deepEqual(outcomes, ["failed:http_error:active", "failed:http_error:active", "failed:http_error:failing"]);

    const a = source(SOURCE_A.id);
    assert.equal(a.status, "failing");
    assert.match(a.lastError, /HTTP 404/);
    assert.equal(a.lastErrorKind, "http_error");
    assert.equal(a.autoPaused, true);
    // What was fetched before the failures is kept.
    assert.equal(a.lastContentHash, goodHash);
    assert.equal(snapshotPaths(SOURCE_A.id).length, 1);

    // A scheduled run no longer requests a failing source, but still reports it.
    calls = [];
    const next = await quiet(() => svc.runOrchestrator({ now: at(t + 25 * HOUR), failureLimit: LIMIT }));
    assert.ok(!pageCalls().includes(A_URL));
    assert.deepEqual(next.failing, [SOURCE_A.id]);

    // The page comes back; an explicit single-source run recovers it.
    routes[A_URL] = html(A_V1);
    const retry = await quiet(() => svc.runOrchestrator({ now: at(t + 26 * HOUR), failureLimit: LIMIT, sourceIds: [SOURCE_A.id] }));
    assert.equal(retry.unchanged, 1);
    assert.equal(source(SOURCE_A.id).status, "active");
    assert.equal(source(SOURCE_A.id).consecutiveFailures, 0);
    assert.equal(source(SOURCE_A.id).autoPaused, false);
  });

  test("a redirect is recorded with both the requested and the final URL", async () => {
    const moved = `https://${A_HOST}/rules/short-stay-2026`;
    routes[A_URL] = html(A_V1, { responseUrl: moved });
    seed(SOURCE_A);
    await quiet(() => makeService().runOrchestrator({ now: at(T0) }));
    const a = source(SOURCE_A.id);
    assert.equal(a.url, A_URL);
    assert.equal(a.finalUrl, moved);
    const meta = store.get(`guidanceSources/${SOURCE_A.id}/snapshots/${a.lastContentHash}`) as Record<string, any>;
    assert.equal(meta.url, A_URL);
    assert.equal(meta.finalUrl, moved);
    const obj = stored(SOURCE_A.id, a.lastContentHash);
    assert.equal(obj.url, A_URL);
    assert.equal(obj.finalUrl, moved);
  });

  test("a source that starts redirecting to a different document fails and its content is not ingested", async () => {
    seed(SOURCE_A);
    const svc = makeService();
    await quiet(() => svc.runOrchestrator({ now: at(T0) }));
    const before = source(SOURCE_A.id).lastContentHash;

    // The URL now lands on another document with other text.
    routes[A_URL] = html(htmlPage("This page has moved. See the collection of all current rules for every route."), {
      responseUrl: `https://${A_HOST}/collections/all-rules`,
    });
    const s = await quiet(() => svc.runOrchestrator({ now: at(T0 + 25 * HOUR) }));
    const r = s.results[0];
    assert.equal(r.outcome, "failed");
    assert.equal(r.errorKind, "redirect_changed");
    const a = source(SOURCE_A.id);
    assert.equal(a.lastContentHash, before, "the other document's text is not taken as this source's");
    assert.equal(a.finalUrl, A_URL);
    assert.equal(a.consecutiveFailures, 1);
    assert.equal(snapshotPaths(SOURCE_A.id).length, 1);
    assert.equal(objects.size, 1);
  });

  test("a seeded expectedFinalUrl is the redirect baseline from the first fetch", async () => {
    const expected = `https://${A_HOST}/rules/short-stay-current`;
    seed({ ...SOURCE_A, expectedFinalUrl: expected });
    // Lands somewhere else on the very first fetch.
    routes[A_URL] = html(A_V1, { responseUrl: `https://${A_HOST}/archive/short-stay` });
    const svc = makeService();
    const s = await quiet(() => svc.runOrchestrator({ now: at(T0) }));
    assert.equal(s.results[0].errorKind, "redirect_changed");
    assert.equal(objects.size, 0);
    // Lands where expected (a trailing slash is not a different document).
    routes[A_URL] = html(A_V1, { responseUrl: `${expected}/` });
    const ok = await quiet(() => svc.runOrchestrator({ now: at(T0 + 25 * HOUR) }));
    assert.equal(ok.changed, 1);
  });

  test("a changed content type fails in both directions", async () => {
    // The web-page source now serves a PDF; the PDF source now serves a page.
    routes[A_URL] = pdf(B_PAGES_V1);
    routes[B_URL] = html(A_V1);
    seed(SOURCE_A, SOURCE_B);
    const s = await quiet(() => makeService().runOrchestrator({ now: at(T0) }));
    assert.equal(s.failed, 2);
    for (const r of s.results) {
      assert.equal(r.outcome, "failed");
      assert.equal(r.errorKind, "content_type_changed", r.sourceId);
    }
    assert.equal(objects.size, 0);
    assert.equal(source(SOURCE_A.id).lastErrorKind, "content_type_changed");
    assert.equal(source(SOURCE_B.id).lastErrorKind, "content_type_changed");
  });

  test("a Storage failure is a counted failure and the hash is not advanced", async () => {
    seed(SOURCE_A);
    const failing: SnapshotBucket = {
      file: () => ({
        save: async () => {
          throw Object.assign(new Error("backend unavailable"), { code: 503 });
        },
        download: async () => [Buffer.from("")],
      }),
    };
    const svc = new GuidanceCrawlService(new VisaCatalogFetchService({ http, minIntervalMs: 0 }), new GuidanceSnapshotStore(failing));
    svc.runTransaction = fakeRunTransaction as any;
    const s = await quiet(() => svc.runOrchestrator({ now: at(T0) }));
    assert.equal(s.results[0].errorKind, "storage_error");
    const a = source(SOURCE_A.id);
    assert.equal(a.lastContentHash, null);
    assert.equal(a.consecutiveFailures, 1);
    assert.equal(snapshotPaths(SOURCE_A.id).length, 0);
  });

  test("paused and retired sources are never requested", async () => {
    seed({ ...SOURCE_A, status: "paused" }, { ...SOURCE_B, status: "retired" });
    const s = await quiet(() => makeService().runOrchestrator({ now: at(T0), sourceIds: [SOURCE_A.id, SOURCE_B.id] }));
    assert.equal(s.skippedInactive, 2);
    assert.equal(calls.length, 0);
  });
});

// ============================================
// Pure helpers + the fetch option this issue added
// ============================================

describe("guidance crawl: helpers", () => {
  test("sameDocumentUrl ignores fragments, trailing slashes and host case", () => {
    assert.ok(sameDocumentUrl("https://Docs.Example.org/a/b/", "https://docs.example.org/a/b#part-2"));
    assert.ok(!sameDocumentUrl("https://docs.example.org/a/b", "https://docs.example.org/a/c"));
    assert.ok(!sameDocumentUrl("https://docs.example.org/a?v=1", "https://docs.example.org/a?v=2"));
  });

  test("failureKindOf classifies fetch errors", () => {
    assert.equal(failureKindOf(new Error("Fetch failed for https://x.example/a (HTTP 410)")), "http_error");
    assert.equal(failureKindOf(new Error("Blocked by robots.txt: https://x.example/a")), "robots_blocked");
    assert.equal(failureKindOf(new HtmlTextTooLongError("https://x.example/a", 10, 5)), "text_too_long");
    assert.equal(failureKindOf(new Error("socket hang up")), "fetch_error");
  });

  test("fetchAndClean: maxHtmlTextChars refuses an over-long page; without it the page is sliced as before", async () => {
    const long = Array.from({ length: 400 }, (_, i) => `Paragraph ${i}: ${FILLER}`).join(" ");
    routes[A_URL] = html(htmlPage(long));
    const fetcher = new VisaCatalogFetchService({ http, minIntervalMs: 0 });
    // Default (every existing caller): capped at MAX_CLEAN_TEXT_CHARS.
    const capped = await fetcher.fetchAndClean(A_URL);
    assert.equal(capped.cleanText.length, MAX_CLEAN_TEXT_CHARS);
    // With a generous limit: the whole text.
    const whole = await fetcher.fetchAndClean(A_URL, { maxHtmlTextChars: 1_000_000 });
    assert.ok(whole.cleanText.length > MAX_CLEAN_TEXT_CHARS);
    assert.ok(whole.cleanText.startsWith(capped.cleanText));
    // With a limit the page exceeds: refused, never truncated.
    await assert.rejects(fetcher.fetchAndClean(A_URL, { maxHtmlTextChars: 30_000 }), (err: unknown) => {
      assert.ok(err instanceof HtmlTextTooLongError);
      assert.equal(err.maxTextChars, 30_000);
      assert.equal(err.textChars, whole.cleanText.length);
      return true;
    });
  });
});
