// ============================================
// Guidance: quote integrity check AFTER a crawl (issue #150) — unit tests,
// no network, no emulator
// ============================================
//
// Drives GuidanceCrawlService end to end (real shared fetch service on a
// stubbed HTTP client, in-memory Firestore fake, in-memory bucket) with the
// run recorder and the REAL shared alert service wired as the run's finalize
// hook (as functions/src/index.ts does), so each test sees what an admin
// would: the run record, the source doc and the alerts. Email delivery and
// the structured log writer are captured, never sent.
//
// The registry and the declared passages are synthetic (two made-up
// publishers plus one source with no checks); nothing in the code under test
// knows any of these values. The seed script's own `--check-quotes` is not
// changed by #150; its pure pieces stay covered by guidance-quote-check.test.ts
// and guidance-seed-run.test.ts, and one test here shows the crawl's own
// check stays OFF for a "script" run.

import { before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";
import {
  VisaCatalogFetchService,
  VisaCatalogHttpClient,
} from "../../../src/scrapers/shared/fetch/visa-catalog-fetch.service";
import { GuidanceCrawlService } from "../../../src/scrapers/guidance/guidance-crawl.service";
import { GuidanceSnapshotStore, SnapshotBucket } from "../../../src/scrapers/guidance/guidance-snapshot.store";
import { buildSeededGuidanceSource } from "../../../src/scrapers/guidance/data/seed-guidance-sources";
import { GUIDANCE_QUOTE_CHECKS } from "../../../src/scrapers/guidance/data/guidance-quote-checks";
import type { GuidanceQuoteCheck } from "../../../src/scrapers/guidance/guidance-quote-check";
import type { GuidanceSourceSeed } from "../../../src/scrapers/guidance/types";
import { buildPdf } from "../../helpers/pdf-fixture";
import { fakeCollection, fakeRunTransaction, resetStore, store, writes } from "../../helpers/fake-firestore";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ----- Synthetic registry -----

const A_URL = "https://rules.alpha-ministry.example/rules/short-stay";
const B_URL = "https://files.beta-agency.example/media/7f3a/casework-guidance.pdf";
const C_URL = "https://rules.gamma-office.example/rules/other";

const base = { checkIntervalHours: 24, verificationStatus: "verified" as const, verificationNote: "Retrieved by hand.", retrievedAt: "2026-11-10" };
const SOURCE_A: GuidanceSourceSeed = { id: "alpha-short-stay-rules", title: "Short stay rules", url: A_URL, jurisdiction: "AA", route: "short-stay", docType: "html", ...base };
const SOURCE_B: GuidanceSourceSeed = { id: "beta-study-casework", title: "Study casework", url: B_URL, jurisdiction: "BB", route: "study", docType: "pdf", ...base };
// Publisher C has NO declared checks.
const SOURCE_C: GuidanceSourceSeed = { id: "gamma-other-rules", title: "Other rules", url: C_URL, jurisdiction: "CC", route: "other", docType: "html", ...base };

const A_PASSAGE = "An applicant must intend to leave at the end of the stay.";
const B_PASSAGE = "Consider the course and the sponsor.";

/** The declared passages (data, injected into the crawl). */
const CHECKS: GuidanceQuoteCheck[] = [
  { id: "alpha-intention", label: "A 1.1", passage: A_PASSAGE, sourceIds: [SOURCE_A.id] },
  { id: "beta-assessing", label: "B 2", passage: B_PASSAGE, sourceIds: [SOURCE_B.id] },
];

const FILLER = "The decision maker must weigh every piece of evidence and record the reasons for the decision reached.";
const htmlPage = (body: string) => `<html><head><title>t</title></head><body><main><h1>Rules</h1><p>${body}</p><p>${FILLER}</p></main></body></html>`;
// Passage present / reworded by the publisher / reworded differently.
const A_OK = htmlPage(`Edition one. ${A_PASSAGE}`);
const A_DRIFT = htmlPage("Edition two. An applicant must plan to leave when the stay ends.");
const A_DRIFT2 = htmlPage("Edition three. An applicant must plan to depart when the stay ends.");
const C_PAGE = htmlPage("Nothing declared is checked in this page.");
const bPages = (line: string) => [
  `Casework guidance\n${FILLER}`,
  `Assessing intention\n${line}\n${FILLER}`,
  `Refusal wording\nUse the standard paragraphs.\n${FILLER}`,
];
const B_OK = bPages(B_PASSAGE);
const B_DRIFT = bPages("Consider the course and the funds.");

// ----- Stub HTTP client + in-memory bucket -----

let routes: Record<string, { body: string | Buffer; contentType: string }>;
const http: VisaCatalogHttpClient = {
  async get(url) {
    const r = routes[url] ?? (url.endsWith("/robots.txt") ? { body: "", contentType: "text/plain" } : { body: "nf", contentType: "text/html" });
    return { status: 200, data: r.body, headers: { "content-type": r.contentType } };
  },
};
const html = (body: string) => ({ body, contentType: "text/html; charset=utf-8" });
const pdf = (pages: string[]) => ({ body: buildPdf(pages), contentType: "application/pdf" });

let objects: Map<string, string>;
let downloads: number;
const bucket: SnapshotBucket = {
  file(name: string) {
    return {
      async save(data) {
        objects.set(name, data as string);
      },
      async exists() {
        return [objects.has(name)];
      },
      async download() {
        downloads++;
        const o = objects.get(name);
        if (o === undefined) throw Object.assign(new Error("No such object"), { code: 404 });
        return [Buffer.from(o, "utf8")];
      },
    };
  },
};

// ----- Harness -----

const T0 = Date.parse("2026-11-11T02:00:00Z");
const HOUR = 60 * 60 * 1000;
const at = (ms: number) => Timestamp.fromMillis(ms);
const DAY = 24 * HOUR;

let alertSvc: any;
let runsSvc: any;
let off: (() => void) | undefined;

function seed(...seeds: GuidanceSourceSeed[]): void {
  for (const s of seeds) store.set(`guidanceSources/${s.id}`, buildSeededGuidanceSource(s, undefined, at(T0 - HOUR)));
}
const source = (id: string) => store.get(`guidanceSources/${id}`) as Record<string, any>;
/** Every alert doc (any status) of a rule. */
const alerts = (rule = "guidance_quote_drift") =>
  [...store.entries()].filter(([p, d]) => p.startsWith("scrapeAlerts/") && (d as any).rule === rule).map(([, d]) => d as any);
/** The latest run doc of the guidance crawl. */
const lastRun = (): any =>
  [...store.entries()].filter(([p]) => p.startsWith("scrapeRuns/")).map(([, d]) => d as any).sort((a, b) => b.startedAt.toMillis() - a.startedAt.toMillis())[0];

function makeService(): GuidanceCrawlService {
  const fetcher = new VisaCatalogFetchService({ http, minIntervalMs: 0, clock: () => T0 });
  const svc = new GuidanceCrawlService(fetcher, new GuidanceSnapshotStore(bucket));
  svc.runTransaction = fakeRunTransaction as any;
  return svc;
}

async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => undefined;
  try {
    return await fn();
  } finally {
    Object.assign(console, saved);
  }
}

/** One scheduled crawl at `now`, with the declared checks injected. */
const crawl = (svc: GuidanceCrawlService, now: number, extra: Record<string, unknown> = {}) =>
  quiet(() => svc.runOrchestrator({ now: at(now), quoteChecks: CHECKS, ...extra }));

before(async () => {
  const { installFakes } = await import("../../helpers/fake-firestore");
  await installFakes();
  const firebase: any = await import("../../../src/utils/firebase");
  firebase.collections.guidanceSources = fakeCollection("guidanceSources");
  firebase.subcollections.guidanceSnapshots = (id: string) => fakeCollection(`guidanceSources/${id}/snapshots`);
  // The real alert service as the run's finalize hook, as in index.ts.
  const alertsMod: any = await import("../../../src/scrapers/shared/alerts/scrape-alert.service");
  alertSvc = alertsMod.scrapeAlertService;
  alertSvc.notify = async () => undefined;
  alertSvc.log = () => undefined;
  const runs: any = await import("../../../src/scrapers/shared/runs/scrape-run.service");
  runsSvc = runs.scrapeRunService;
});

beforeEach(() => {
  resetStore();
  routes = { [A_URL]: html(A_OK), [B_URL]: pdf(B_OK), [C_URL]: html(C_PAGE) };
  objects = new Map();
  downloads = 0;
  off?.();
  off = runsSvc.registerFinalizeHook((run: any) => alertSvc.onRunFinalized(run));
});

// ============================================
// All-pass run
// ============================================

describe("quote check after a crawl: a passing run", () => {
  test("every passage found: nothing raised, nothing written beyond the run summary", async () => {
    seed(SOURCE_A, SOURCE_B);
    const summary = await crawl(makeService(), T0);

    assert.deepEqual(summary.quoteChecked.sort(), [SOURCE_A.id, SOURCE_B.id].sort());
    assert.equal(summary.quoteChecksRun, 2);
    assert.equal(summary.quoteChecksFailed, 0);
    assert.deepEqual(summary.quoteDrift, []);
    assert.deepEqual(summary.infrastructureErrors, []);
    assert.deepEqual(summary.warnings, []);

    const run = lastRun();
    assert.equal(run.status, "succeeded");
    assert.equal(run.errorCount, 0);
    assert.deepEqual(run.warnings ?? [], []);
    assert.deepEqual(run.summary.quoteChecked.sort(), [SOURCE_A.id, SOURCE_B.id].sort());

    // No alert of any kind, and no quote field on the source docs.
    assert.equal([...store.keys()].filter((p) => p.startsWith("scrapeAlerts/")).length, 0);
    for (const w of writes.filter((x) => x.path.startsWith("guidanceSources/"))) {
      assert.equal("quoteDrift" in w.data, false, `no quote-check write to ${w.path}`);
    }
  });

  test("a second all-pass run (unchanged sources) is also silent and writes no quote field", async () => {
    seed(SOURCE_A);
    const svc = makeService();
    await crawl(svc, T0);
    writes.length = 0;
    const second = await crawl(svc, T0 + 2 * DAY);
    assert.equal(second.unchanged, 1);
    assert.deepEqual(second.quoteChecked, [SOURCE_A.id], "an unchanged source is re-checked");
    assert.equal(writes.filter((w) => "quoteDrift" in w.data).length, 0);
    assert.equal(alerts().length, 0);
  });
});

// ============================================
// Drift: run record, source doc, one alert, bump, resolve
// ============================================

describe("quote check after a crawl: a drifted passage", () => {
  test("is reported on the run (warning), the source doc and ONE alert; the run and its snapshot are unaffected", async () => {
    seed(SOURCE_A);
    const svc = makeService();
    await crawl(svc, T0);
    routes[A_URL] = html(A_DRIFT);
    const summary = await crawl(svc, T0 + 2 * DAY);

    // The crawl itself: a normal changed run, snapshot written.
    assert.equal(summary.changed, 1);
    assert.equal(summary.snapshotsWritten, 1);
    const run = lastRun();
    assert.equal(run.status, "succeeded", "the check never fails the run");
    assert.equal(run.errorCount, 0);
    assert.equal(run.errors.length, 0);

    // Run record: a warning naming the source and the check id (not the passage).
    assert.equal(run.warnings.length, 1);
    assert.match(run.warnings[0], new RegExp(`source ${SOURCE_A.id}: quote check: 1 passage`));
    assert.match(run.warnings[0], /alpha-intention/);
    assert.ok(!run.warnings[0].includes(A_PASSAGE));
    assert.deepEqual(run.summary.quoteDrift[0].failed.map((f: any) => f.checkId), ["alpha-intention"]);

    // Source doc.
    const doc = source(SOURCE_A.id);
    assert.equal(doc.quoteDrift.contentHash, doc.latestSnapshotId);
    assert.deepEqual(doc.quoteDrift.failed, [{ checkId: "alpha-intention", label: "A 1.1", problem: "not_found" }]);

    // Alert: one, open, keyed per source, warning by default.
    const list = alerts();
    assert.equal(list.length, 1);
    assert.equal(list[0].dedupeKey, `guidance_quote_drift:${SOURCE_A.id}`);
    assert.equal(list[0].status, "open");
    assert.equal(list[0].severity, "warning");
    assert.equal(list[0].kind, "guidance");
    assert.equal(list[0].count, 1);
    assert.ok(!list[0].message.includes(A_PASSAGE));
  });

  test("a second run with the passage still missing bumps the alert; restoring the passage resolves it and clears the source field", async () => {
    seed(SOURCE_A);
    const svc = makeService();
    await crawl(svc, T0);
    routes[A_URL] = html(A_DRIFT);
    await crawl(svc, T0 + 2 * DAY);
    // Still drifted, different text again (a new run, the alert is bumped, not duplicated).
    routes[A_URL] = html(A_DRIFT2);
    await crawl(svc, T0 + 4 * DAY);
    assert.equal(alerts().length, 1, "deduplicated per source");
    assert.equal(alerts()[0].count, 2);
    // Unchanged content, still missing: re-checked, bumped again.
    await crawl(svc, T0 + 6 * DAY);
    assert.equal(alerts().length, 1);
    assert.equal(alerts()[0].count, 3);

    // The publisher restores the passage.
    routes[A_URL] = html(A_OK);
    await crawl(svc, T0 + 8 * DAY);
    const list = alerts();
    assert.equal(list.length, 1);
    assert.equal(list[0].status, "resolved");
    assert.equal(list[0].autoResolved, true);
    assert.equal(source(SOURCE_A.id).quoteDrift, null);
    assert.deepEqual(lastRun().warnings ?? [], []);
  });

  test("the rule is configurable like the others: severity override and disable", async () => {
    seed(SOURCE_A);
    store.set("appConfig/scrapeAlerts", { rules: { guidance_quote_drift: { severity: "critical" } } });
    const svc = makeService();
    await crawl(svc, T0);
    routes[A_URL] = html(A_DRIFT);
    await crawl(svc, T0 + 2 * DAY);
    assert.equal(alerts()[0].severity, "critical");

    // Disabled: the active alert is resolved and none is raised.
    store.set("appConfig/scrapeAlerts", { rules: { guidance_quote_drift: { enabled: false } } });
    routes[A_URL] = html(A_DRIFT2);
    await crawl(svc, T0 + 4 * DAY);
    assert.equal(alerts().filter((a) => a.status !== "resolved").length, 0);
  });
});

// ============================================
// Missing snapshot object: infrastructure, not drift
// ============================================

describe("quote check after a crawl: a snapshot missing from Storage", () => {
  test("goes down the infrastructure path: no drift alert, run not failed", async () => {
    seed(SOURCE_A);
    const svc = makeService();
    await crawl(svc, T0);
    objects.clear(); // the stored text vanished; the source doc still points at it
    const summary = await crawl(svc, T0 + 2 * DAY); // unchanged hash: no re-store

    assert.equal(summary.unchanged, 1);
    assert.deepEqual(summary.quoteDrift, []);
    assert.deepEqual(summary.quoteChecked, [], "nothing was judged, so nothing is claimed");
    assert.equal(summary.infrastructureErrors.length, 1);
    assert.match(summary.infrastructureErrors[0], new RegExp(`source ${SOURCE_A.id}: storage_error: quote check`));

    assert.equal(lastRun().status, "succeeded");
    assert.equal(alerts().length, 0, "not quote drift");
    const infra = alerts("infrastructure_error");
    assert.equal(infra.length, 1);
    assert.equal(infra[0].dedupeKey, "infrastructure_error:guidance");
    // The source's own streak and status are not touched.
    assert.equal(source(SOURCE_A.id).consecutiveFailures, 0);
    assert.equal(source(SOURCE_A.id).status, "active");
    assert.equal(source(SOURCE_A.id).quoteDrift ?? null, null);
  });

  test("does not resolve an existing drift alert (nothing was confirmed)", async () => {
    seed(SOURCE_A);
    const svc = makeService();
    await crawl(svc, T0);
    routes[A_URL] = html(A_DRIFT);
    await crawl(svc, T0 + 2 * DAY);
    assert.equal(alerts()[0].status, "open");
    objects.clear();
    await crawl(svc, T0 + 4 * DAY);
    assert.equal(alerts()[0].status, "open");
    assert.equal(alerts()[0].count, 1, "and it is not bumped either");
    assert.ok(source(SOURCE_A.id).quoteDrift, "the source keeps its last known drift");
  });
});

// ============================================
// Awkward cases
// ============================================

describe("quote check after a crawl: awkward cases", () => {
  test("a source with no declared checks is skipped cheaply (no snapshot read, no alert)", async () => {
    seed(SOURCE_C);
    const summary = await crawl(makeService(), T0);
    assert.equal(summary.changed, 1);
    assert.equal(downloads, 0, "no snapshot was read for the check");
    assert.deepEqual(summary.quoteChecked, []);
    assert.equal(summary.quoteChecksRun, 0);
    assert.deepEqual(summary.warnings, []);
    assert.equal([...store.keys()].filter((p) => p.startsWith("scrapeAlerts/")).length, 0);
  });

  test("a check that throws does not fail the run", async () => {
    seed(SOURCE_A);
    const broken: any = [{ id: "x", label: "x", passage: "p", get sourceIds(): string[] { throw new Error("boom in the check"); } }];
    const summary = await crawl(makeService(), T0, { quoteChecks: broken });
    assert.equal(summary.changed, 1, "the crawl's own work is unaffected");
    assert.equal(summary.snapshotsWritten, 1);
    assert.ok(summary.warnings.some((w) => /quote check could not run: boom in the check/.test(w)));
    const run = lastRun();
    assert.equal(run.status, "succeeded");
    assert.equal(run.errorCount, 0);
  });

  test("a manual single-source crawl checks that source only, and cannot resolve another source's alert", async () => {
    seed(SOURCE_A, SOURCE_B);
    routes[A_URL] = html(A_DRIFT);
    routes[B_URL] = pdf(B_DRIFT);
    const svc = makeService();
    await crawl(svc, T0);
    assert.equal(alerts().length, 2);

    // The admin retries A after the publisher restored it.
    routes[A_URL] = html(A_OK);
    routes[B_URL] = pdf(B_DRIFT); // B still drifted, and not crawled
    downloads = 0;
    const summary = await crawl(svc, T0 + HOUR, { sourceIds: [SOURCE_A.id], trigger: "manual" });
    assert.deepEqual(summary.quoteChecked, [SOURCE_A.id]);
    assert.equal(downloads, 1, "only A's snapshot was read");
    const byKey = Object.fromEntries(alerts().map((a) => [a.dedupeKey, a.status]));
    assert.equal(byKey[`guidance_quote_drift:${SOURCE_A.id}`], "resolved");
    assert.equal(byKey[`guidance_quote_drift:${SOURCE_B.id}`], "open", "B was not touched by this run");
    assert.equal(lastRun().trigger, "manual");
  });

  test("a PDF source is checked on its stored text like a web page", async () => {
    seed(SOURCE_B);
    routes[B_URL] = pdf(B_DRIFT);
    const summary = await crawl(makeService(), T0);
    assert.deepEqual(summary.quoteDrift.map((d) => d.sourceId), [SOURCE_B.id]);
  });
});

// ============================================
// Script runs and the default data
// ============================================

describe("quote check after a crawl: defaults", () => {
  test("by default the declared data is used for a scheduled run, but a script run leaves the check to the script's own --check-quotes", async () => {
    seed(SOURCE_A);
    // Declare a check for the synthetic source in the real data array, for this test only.
    const entry: GuidanceQuoteCheck = { id: "alpha-default-wiring", label: "A", passage: A_PASSAGE, sourceIds: [SOURCE_A.id] };
    GUIDANCE_QUOTE_CHECKS.push(entry);
    try {
      const svc = makeService();
      const script = await quiet(() => svc.runOrchestrator({ now: at(T0), trigger: "script" }));
      assert.deepEqual(script.quoteChecked, []);
      assert.equal(downloads, 0, "a script run reads nothing for the check");

      const scheduled = await quiet(() => svc.runOrchestrator({ now: at(T0 + 2 * DAY) }));
      assert.deepEqual(scheduled.quoteChecked, [SOURCE_A.id], "the scheduled run uses the declared data");
    } finally {
      GUIDANCE_QUOTE_CHECKS.splice(GUIDANCE_QUOTE_CHECKS.indexOf(entry), 1);
    }
  });
});
