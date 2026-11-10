// ============================================
// Unit tests — scraper alerts (issue #83)
// ============================================
//
// Run with `npm test`. NO network and NO emulator: Firestore is the
// in-memory fake (test/helpers/fake-firestore.ts); email delivery
// (`scrapeAlertService.notify`) and the structured log writer
// (`scrapeAlertService.log`) are captured in arrays, so no email ever leaves
// the machine. Recipient addresses use `delivered+<name>@resend.dev`.
//
// Covers:
//  - pure rules (services/scrape-alert-rules.ts): config defaults +
//    validation, run_failed, error_rate, linked_surcharge, host_backoff
//    (streak across runs that did not touch the host, news via source ids),
//    run_stuck, missed_window (#63 window maths), source_broken, FX, budget
//    levels (+ skipped without a budget), review queue
//  - store: create -> bump (count) -> auto-resolve (pointer freed) ->
//    a recurrence opens a NEW alert; same occurrence not re-counted;
//    escalation re-opens an acknowledged alert and emails again
//  - email: one email per check to admin recipients only, min severity,
//    immediate off; daily digest once per UTC day
//  - structured JSON log line per action
//  - finalize hook: script runs ignored; hourly check: stuck runs, a
//    stale-swept failed run (no hook) raises run_failed; a disabled rule
//    resolves its alerts; default config written when missing
//  - review fixes: a manual resolve does not re-open the same run (tombstone),
//    auto-resolve race guard, host_backoff clears for stopped sources /
//    expired backoffs, post-run time budget (emailPending -> hourly),
//    critical emails bypass the email opt-out
//  - controller: 403 for owner / agent / client on every route, list
//    filters (open includes acknowledged), acknowledge / resolve, 404 / 409

import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";
import { ROLES, defineAbilitiesFor } from "@durin-tech/authz";
import type { Role } from "@durin-tech/authz";

import { Data, installFakes, resetStore, store } from "./helpers/fake-firestore";

// Admin init needs a project id (utils/firebase derives the bucket from it).
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || "demo-unit-test";

/* eslint-disable @typescript-eslint/no-explicit-any */
let rules: any; // services/scrape-alert-rules
let alertsMod: any; // services/scrape-alert.service
let svc: any; // the scrapeAlertService singleton
let controller: any;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
// Tuesday 2026-11-10 12:00 UTC.
const NOW = Date.parse("2026-11-10T12:00:00Z");

/** Captured emails / log lines (reset per test). */
let emails: any[] = [];
let logs: any[] = [];

before(async () => {
  await installFakes();
  rules = await import("../src/services/scrape-alert-rules");
  alertsMod = await import("../src/services/scrape-alert.service");
  svc = alertsMod.scrapeAlertService;
  controller = (await import("../src/controllers/scrape-alert.controller")).scrapeAlertController;
  // Never send: capture notifyUser calls and log lines instead.
  svc.notify = async (input: any) => {
    emails.push(input);
  };
  svc.log = (entry: any) => {
    logs.push(entry);
  };
  svc.realClock = () => NOW;
});

beforeEach(() => {
  resetStore();
  emails = [];
  logs = [];
  // The #82 stub (no budget): llm_budget skipped unless a test swaps it.
  svc.costSource = { getMonthToDateCost: async () => ({ monthUsd: 0, budgetUsd: null }) };
  // Two admins + one non-admin, with Resend test addresses.
  store.set("users/admin1", { email: "delivered+admin1@resend.dev", admin: true });
  store.set("users/admin2", { email: "delivered+admin2@resend.dev", admin: true });
  store.set("users/client1", { email: "delivered+client1@resend.dev" });
});

/** Default config (resolved), optionally patched. */
function cfg(patch: any = {}): any {
  const { config } = rules.resolveConfig({ ...patch });
  return config;
}

/** A finished run doc (as the finalize hook receives it). */
function run(id: string, over: Data = {}): any {
  return {
    id,
    kind: "visa",
    trigger: "scheduled",
    status: "succeeded",
    startedAt: Timestamp.fromMillis(NOW - HOUR),
    finishedAt: Timestamp.fromMillis(NOW - HOUR + 1000),
    durationMs: 1000,
    summary: { errors: 0, linkedSurchargeErrors: 0, fxRefreshed: true },
    sourcesAttempted: 1,
    pagesAttempted: 10,
    sources: [{ sourceId: "GB", name: "United Kingdom", status: "succeeded", pagesAttempted: 10, pagesFetched: 10, errors: 0 }],
    pages: [],
    pagesTruncated: false,
    errorCount: 0,
    errors: [],
    expireAt: Timestamp.fromMillis(NOW + 180 * DAY),
    createdAt: Timestamp.fromMillis(NOW - HOUR),
    updatedAt: Timestamp.fromMillis(NOW - HOUR),
    ...over,
  };
}

/** Store a run doc (for the hourly check / previous-run reads). */
function seedRun(r: any): void {
  store.set(`scrapeRuns/${r.id}`, r);
}

/** All alert docs. */
function alertDocs(): Data[] {
  return [...store.entries()].filter(([p]) => p.startsWith("scrapeAlerts/")).map(([, d]) => d);
}

/** All pointer docs. */
function pointerDocs(): Data[] {
  return [...store.entries()].filter(([p]) => p.startsWith("scrapeAlertKeys/")).map(([, d]) => d);
}

/** Run `fn` with console output silenced. */
async function quiet(fn: () => Promise<any>): Promise<any> {
  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => undefined;
  try {
    return await fn();
  } finally {
    Object.assign(console, orig);
  }
}

// ============================================
// Pure rules
// ============================================

describe("config", () => {
  test("defaults when empty; invalid values fall back with a problem each", () => {
    const empty = rules.resolveConfig(undefined);
    assert.deepEqual(empty.problems, []);
    assert.equal(empty.config.thresholds.errorRatePct, 20);
    assert.deepEqual(empty.config.thresholds.budgetPcts, [50, 80, 100]);
    assert.equal(empty.config.email.immediateMinSeverity, "warning");

    const bad = rules.resolveConfig({
      thresholds: { errorRatePct: "lots", stuckRunMinutes: 90, budgetPcts: [100, 50] },
      email: { digest: true, digestHourUtc: 25 },
      rules: { review_queue_stale: { enabled: false }, nope: {} },
      recipientUserIds: ["admin1"],
    });
    assert.equal(bad.config.thresholds.errorRatePct, 20); // fallback
    assert.equal(bad.config.thresholds.stuckRunMinutes, 90); // kept
    assert.deepEqual(bad.config.thresholds.budgetPcts, [50, 100]); // sorted
    assert.equal(bad.config.email.digest, true);
    assert.equal(bad.config.email.digestHourUtc, 7); // fallback
    assert.equal(bad.config.rules.review_queue_stale.enabled, false);
    assert.deepEqual(bad.config.recipientUserIds, ["admin1"]);
    assert.equal(bad.problems.length, 3); // errorRatePct, digestHourUtc, unknown rule
  });
});

describe("run rules", () => {
  test("run_failed: failed raises (eventId = run id), other statuses clear", () => {
    const f = rules.evaluateRunFailed(run("r1", { status: "failed", fatalError: "boom" }), cfg());
    assert.equal(f.signals.length, 1);
    assert.equal(f.signals[0].key, "run_failed:visa");
    assert.equal(f.signals[0].severity, "critical");
    assert.equal(f.signals[0].eventId, "r1");
    assert.match(f.signals[0].message, /boom/);
    const ok = rules.evaluateRunFailed(run("r2", { status: "partial" }), cfg());
    assert.deepEqual(ok, { rule: "run_failed", signals: [], scope: { keys: ["run_failed:visa"] } });
  });

  test("error_rate: above threshold raises, below clears, too few pages says nothing", () => {
    assert.equal(rules.evaluateErrorRate(run("a", { pagesAttempted: 10, errorCount: 3 }), cfg()).signals.length, 1);
    const below = rules.evaluateErrorRate(run("b", { pagesAttempted: 10, errorCount: 2 }), cfg());
    assert.equal(below.signals.length, 0);
    assert.deepEqual(below.scope, { keys: ["error_rate:visa"] });
    const few = rules.evaluateErrorRate(run("c", { pagesAttempted: 4, errorCount: 4 }), cfg());
    assert.deepEqual(few.scope, { keys: [] });
  });

  test("linked_surcharge: > 0 raises on visa runs; news says nothing", () => {
    const r = rules.evaluateLinkedSurcharge(run("a", { summary: { linkedSurchargeErrors: 2 } }), cfg());
    assert.equal(r.signals[0].key, "linked_surcharge:visa");
    assert.deepEqual(rules.evaluateLinkedSurcharge(run("b", { kind: "news" }), cfg()).scope, { keys: [] });
  });

  test("severity override from config", () => {
    const r = rules.evaluateRunFailed(run("r1", { status: "failed" }), cfg({ rules: { run_failed: { severity: "warning" } } }));
    assert.equal(r.signals[0].severity, "warning");
  });
});

describe("host_backoff", () => {
  const backoffPage = (host: string, sourceId = "GB") => ({
    sourceId,
    url: `https://${host}/visa`,
    outcome: "error",
    error: "host backed off (429), retry after 2026-11-10T13:00:00.000Z",
  });
  const okPage = (host: string, sourceId = "GB") => ({ sourceId, url: `https://${host}/visa`, outcome: "unchanged" });

  test("streak over runs that touched the host; runs for other hosts don't break it", () => {
    const current = run("r3", { pages: [backoffPage("www.gov.uk")] });
    const previous = [
      run("r2", { pages: [okPage("www.hikorea.go.kr", "KR")], sources: [{ sourceId: "KR", status: "succeeded" }] }), // other host
      run("r1", { pages: [backoffPage("www.gov.uk")] }),
    ];
    const r = rules.evaluateHostBackoff(current, previous, cfg());
    assert.equal(r.signals.length, 1);
    assert.equal(r.signals[0].key, "host_backoff:visa:www.gov.uk");
    assert.equal(r.signals[0].subject.type, "host");
    assert.equal(r.signals[0].details.consecutiveRuns, 2);
  });

  test("a clean touch in between breaks the streak; a clean run clears the host", () => {
    const current = run("r3", { pages: [backoffPage("www.gov.uk")] });
    const previous = [run("r2", { pages: [okPage("www.gov.uk")] }), run("r1", { pages: [backoffPage("www.gov.uk")] })];
    assert.equal(rules.evaluateHostBackoff(current, previous, cfg()).signals.length, 0);
    const clean = rules.evaluateHostBackoff(run("r4", { pages: [okPage("www.gov.uk")] }), [], cfg());
    assert.deepEqual(clean.scope, { keys: ["host_backoff:visa:www.gov.uk"] });
  });

  test("news: backoff in errors[]; a run processing the same source counts as touching it", () => {
    const err = (sourceId: string) => ({ sourceId, url: "https://news.example/feed", message: "host backed off (503), retry after x" });
    const current = run("n3", { kind: "news", errors: [err("s1")], sources: [{ sourceId: "s1", status: "failed" }] });
    const okInBetween = run("n2", { kind: "news", errors: [], sources: [{ sourceId: "s1", status: "succeeded" }] });
    const first = run("n1", { kind: "news", errors: [err("s1")], sources: [{ sourceId: "s1", status: "failed" }] });
    assert.equal(rules.evaluateHostBackoff(current, [okInBetween, first], cfg()).signals.length, 0);
    assert.equal(rules.evaluateHostBackoff(current, [first], cfg()).signals[0].key, "host_backoff:news:news.example");
  });
});

describe("hourly state rules", () => {
  test("run_stuck: running longer than stuckRunMinutes", () => {
    const r = rules.evaluateStuckRuns(
      [
        run("old", { status: "running", startedAt: Timestamp.fromMillis(NOW - 61 * 60 * 1000) }),
        run("young", { status: "running", startedAt: Timestamp.fromMillis(NOW - 30 * 60 * 1000) }),
      ],
      NOW,
      cfg()
    );
    assert.deepEqual(r.signals.map((s: any) => s.key), ["run_stuck:old"]);
    assert.equal(r.scope, "all");
  });

  test("missed_window: last closed window (Mon 02-05 London) without a crawl", () => {
    const crawlWindow = { timeZone: "Europe/London", dayOfWeek: 1, startHour: 2, endHour: 5 };
    // Last window: Mon 2026-11-09 02:00 London = 02:00Z (GMT).
    assert.equal(rules.lastClosedWindowOpening(crawlWindow, NOW, 2 * HOUR), Date.parse("2026-11-09T02:00:00Z"));
    const base = { status: "active", crawlWindow, createdAt: Timestamp.fromMillis(NOW - 30 * DAY) };
    const r = rules.evaluateMissedWindows(
      [
        { ...base, id: "GB", countryName: "United Kingdom", lastCrawledAt: Timestamp.fromMillis(Date.parse("2026-11-02T02:15:00Z")) },
        { ...base, id: "IE", lastCrawledAt: Timestamp.fromMillis(Date.parse("2026-11-09T02:15:00Z")) }, // crawled
        { ...base, id: "KR", createdAt: Timestamp.fromMillis(NOW - DAY) }, // created after the window
        { ...base, id: "CA", status: "broken" }, // not active: source_broken's job
      ],
      NOW,
      cfg()
    );
    assert.deepEqual(r.signals.map((s: any) => s.key), ["missed_window:GB"]);
    assert.equal(r.signals[0].eventId, `window:${Date.parse("2026-11-09T02:00:00Z")}`);
    // Within the grace period after the window closes, the window before it counts.
    const justAfter = Date.parse("2026-11-09T06:00:00Z");
    assert.equal(rules.lastClosedWindowOpening(crawlWindow, justAfter, 2 * HOUR), Date.parse("2026-11-02T02:00:00Z"));
  });

  test("source_broken: broken (auto) raises, manually paused does not; scope per kind", () => {
    const r = rules.evaluateBrokenSources(
      "news",
      [
        { id: "s1", name: "Feed 1", status: "broken", consecutiveFailures: 5, lastErrorMessage: "timeout" },
        { id: "s2", name: "Feed 2", status: "paused", consecutiveFailures: 0 },
      ],
      cfg()
    );
    assert.deepEqual(r.signals.map((s: any) => s.key), ["source_broken:news:s1"]);
    assert.deepEqual(r.scope, { keyPrefix: "source_broken:news:" });
  });

  test("fx: stale AND the latest run failed to refresh; ageing alone is fine", () => {
    const failed = run("v1", { summary: { fxRefreshed: false }, warnings: ["FX refresh failed: 500"] });
    assert.equal(rules.evaluateFx(NOW - 49 * HOUR, failed, NOW, cfg()).signals.length, 1);
    assert.equal(rules.evaluateFx(NOW - 47 * HOUR, failed, NOW, cfg()).signals.length, 0);
    assert.equal(rules.evaluateFx(NOW - 100 * HOUR, run("v2"), NOW, cfg()).signals.length, 0);
  });

  test("budget: highest level reached, severity by level; no budget = skipped", () => {
    assert.equal(rules.evaluateBudget({ monthUsd: 10, budgetUsd: null }, NOW, cfg()), null);
    const r = rules.evaluateBudget({ monthUsd: 85, budgetUsd: 100 }, NOW, cfg());
    assert.equal(r.signals[0].key, "llm_budget:2026-11");
    assert.equal(r.signals[0].level, 80);
    assert.equal(r.signals[0].severity, "warning");
    assert.equal(rules.evaluateBudget({ monthUsd: 100, budgetUsd: 100 }, NOW, cfg()).signals[0].severity, "critical");
    assert.equal(rules.evaluateBudget({ monthUsd: 10, budgetUsd: 100 }, NOW, cfg()).signals.length, 0);
  });

  test("review queue: items older than maxAgeDays", () => {
    const r = rules.evaluateReviewQueue(
      [
        { kind: "visa", id: "GB/a", queuedAtMs: NOW - 10 * DAY },
        { kind: "change", id: "c1", queuedAtMs: NOW - 8 * DAY },
        { kind: "visa", id: "GB/b", queuedAtMs: NOW - DAY },
      ],
      NOW,
      cfg()
    );
    assert.equal(r.signals[0].details.staleItems, 2);
    assert.equal(r.signals[0].details.oldestDays, 10);
    assert.equal(r.signals[0].severity, "info");
  });
});

// ============================================
// Store + email + log (finalize hook)
// ============================================

describe("alert store via the finalize hook", () => {
  test("create -> bump -> auto-resolve -> recurrence opens a new alert", async () => {
    // 1. Failed run: new critical alert, one email per admin, a log line.
    const r1 = await quiet(() => svc.onRunFinalized(run("r1", { status: "failed", fatalError: "boom" })));
    assert.equal(r1.actions.filter((a: any) => a.action === "created").length, 1);
    let docs = alertDocs();
    assert.equal(docs.length, 1);
    const a = docs[0];
    assert.equal(a.rule, "run_failed");
    assert.equal(a.dedupeKey, "run_failed:visa");
    assert.equal(a.status, "open");
    assert.equal(a.count, 1);
    assert.deepEqual(a.subject, { type: "scraper", id: "visa", label: "Visa scraper" });
    assert.equal((a.expireAt as Timestamp).toMillis(), NOW + 180 * DAY);
    assert.equal(pointerDocs().length, 1);
    assert.deepEqual(emails.map((e) => e.userId).sort(), ["admin1", "admin2"]); // never the client
    assert.equal(emails[0].type, "scrape_alert");
    assert.deepEqual(emails[0].channels, ["email"]);
    assert.match(emails[0].title, /^\[Critical\] Visa scraper: run failed/);
    const line = logs.find((l) => l.event === "scrape_alert" && l.action === "created");
    assert.equal(line.severity, "CRITICAL");
    assert.equal(line.alert.dedupeKey, "run_failed:visa");
    assert.doesNotThrow(() => JSON.stringify(line));

    // 2. Another failed run: same alert bumped (count 2), no new email.
    emails = [];
    await quiet(() => svc.onRunFinalized(run("r2", { status: "failed" })));
    docs = alertDocs();
    assert.equal(docs.length, 1);
    assert.equal(docs[0].count, 2);
    assert.equal(docs[0].lastRunId, "r2");
    assert.equal(emails.length, 0);

    // 3. The SAME run reported again (hourly check): not counted twice.
    await quiet(() => svc.onRunFinalized(run("r2", { status: "failed" })));
    assert.equal(alertDocs()[0].count, 2);

    // 4. A successful run: auto-resolved, pointer freed.
    await quiet(() => svc.onRunFinalized(run("r3")));
    docs = alertDocs();
    assert.equal(docs[0].status, "resolved");
    assert.equal(docs[0].autoResolved, true);
    assert.equal(docs[0].resolvedBy, "system");
    assert.equal(pointerDocs().length, 0);
    assert.ok(logs.some((l) => l.action === "resolved" && l.severity === "INFO"));

    // 5. It fails again: a NEW alert (and a new email).
    emails = [];
    await quiet(() => svc.onRunFinalized(run("r4", { status: "failed" })));
    assert.equal(alertDocs().length, 2);
    assert.equal(alertDocs().filter((d) => d.status === "open").length, 1);
    assert.equal(emails.length, 2);
  });

  test("script runs are ignored", async () => {
    const r = await quiet(() => svc.onRunFinalized(run("s1", { status: "failed", trigger: "script" })));
    assert.equal(r, undefined);
    assert.equal(alertDocs().length, 0);
  });

  test("emails: one per check listing several alerts; recipients filtered to admins; min severity", async () => {
    store.set("appConfig/scrapeAlerts", { recipientUserIds: ["admin1", "client1"] });
    // A failed run with a high error rate and linked surcharge errors: 3 alerts, one email.
    await quiet(() =>
      svc.onRunFinalized(run("r1", { status: "failed", pagesAttempted: 10, errorCount: 10, summary: { linkedSurchargeErrors: 1 } }))
    );
    assert.equal(alertDocs().length, 3);
    assert.equal(emails.length, 1); // admin1 only (client1 is not an admin)
    assert.equal(emails[0].userId, "admin1");
    assert.match(emails[0].title, /3 new scraper alerts/);
    assert.match(emails[0].body, /linked surcharge/);

    // immediateMinSeverity critical: warnings are not emailed.
    resetStore();
    store.set("users/admin1", { email: "delivered+admin1@resend.dev", admin: true });
    store.set("appConfig/scrapeAlerts", { email: { immediateMinSeverity: "critical" } });
    emails = [];
    await quiet(() => svc.onRunFinalized(run("r2", { pagesAttempted: 10, errorCount: 5, summary: {} })));
    assert.equal(alertDocs().length, 1); // error_rate (warning) stored
    assert.equal(emails.length, 0); // but not emailed

    // immediate off: nothing emailed even for critical.
    store.set("appConfig/scrapeAlerts", { email: { immediate: false } });
    await quiet(() => svc.onRunFinalized(run("r3", { status: "failed" })));
    assert.equal(emails.length, 0);
  });

  test("escalation re-opens an acknowledged alert and emails again", async () => {
    let cost = { monthUsd: 55, budgetUsd: 100 };
    svc.costSource = { getMonthToDateCost: async () => cost };
    try {
      await quiet(() => svc.runHourlyCheck(NOW));
      let budget = alertDocs().find((d) => d.rule === "llm_budget")!;
      assert.equal(budget.severity, "info");
      assert.equal(budget.level, 50);
      assert.equal(emails.length, 0); // info is below immediateMinSeverity (warning)

      await svc.acknowledge(budget.id, "admin1", NOW);
      cost = { monthUsd: 85, budgetUsd: 100 };
      await quiet(() => svc.runHourlyCheck(NOW + HOUR));
      budget = alertDocs().find((d) => d.rule === "llm_budget")!;
      assert.equal(budget.severity, "warning");
      assert.equal(budget.level, 80);
      assert.equal(budget.status, "open"); // re-opened
      assert.equal(budget.acknowledgedBy, null);
      assert.ok(budget.escalatedAt);
      assert.equal(emails.length, 2);
      assert.match(emails[0].title, /escalated/);
    } finally {
      svc.costSource = { getMonthToDateCost: async () => ({ monthUsd: 0, budgetUsd: null }) };
    }
  });
});

// ============================================
// Hourly check
// ============================================

describe("hourly check", () => {
  test("writes the default config when missing", async () => {
    await quiet(() => svc.runHourlyCheck(NOW));
    const stored = store.get("appConfig/scrapeAlerts") as any;
    assert.equal(stored.thresholds.stuckRunMinutes, 60);
    assert.deepEqual(stored.recipientUserIds, []);
  });

  test("stuck run, and a stale-swept failed run (no hook) raise alerts", async () => {
    seedRun(run("stuck", { status: "running", startedAt: Timestamp.fromMillis(NOW - 2 * HOUR), finishedAt: null }));
    seedRun(run("swept", { kind: "news", status: "failed", fatalError: "stale: run did not finish within 1h", startedAt: Timestamp.fromMillis(NOW - 3 * HOUR) }));
    await quiet(() => svc.runHourlyCheck(NOW));
    const keys = alertDocs().map((d) => d.dedupeKey).sort();
    assert.deepEqual(keys, ["run_failed:news", "run_stuck:stuck"]);
    // The stuck run finishes: its alert clears via the hook.
    await quiet(() => svc.onRunFinalized(run("stuck", { status: "succeeded" })));
    assert.equal(alertDocs().find((d) => d.dedupeKey === "run_stuck:stuck")!.status, "resolved");
  });

  test("missed window, broken source, stale review queue, FX failing", async () => {
    store.set("visaSources/GB", {
      countryCode: "GB",
      countryName: "United Kingdom",
      status: "active",
      consecutiveFailures: 0,
      crawlWindow: { timeZone: "Europe/London", dayOfWeek: 1, startHour: 2, endHour: 5 },
      lastCrawledAt: Timestamp.fromMillis(NOW - 9 * DAY),
      createdAt: Timestamp.fromMillis(NOW - 60 * DAY),
    });
    store.set("visaSources/KR", { countryCode: "KR", countryName: "South Korea", status: "broken", consecutiveFailures: 5 });
    store.set("countries/GB/visaTypes/gb-x", { source: "scraped", reviewStatus: "pending_review", createdAt: Timestamp.fromMillis(NOW - 10 * DAY) });
    store.set("countries/GB/visaTypes/gb-seed", { source: "seed", reviewStatus: "pending_review", createdAt: Timestamp.fromMillis(NOW - 10 * DAY) });
    store.set("pendingVisaChanges/c1", { status: "open", createdAt: Timestamp.fromMillis(NOW - 9 * DAY) });
    store.set("appConfig/fx", { fetchedAt: Timestamp.fromMillis(NOW - 72 * HOUR) });
    seedRun(run("v1", { summary: { fxRefreshed: false }, warnings: ["FX refresh failed: 503"] }));
    await quiet(() => svc.runHourlyCheck(NOW));
    const byRule = Object.fromEntries(alertDocs().map((d) => [d.rule, d]));
    assert.equal(byRule.missed_window.dedupeKey, "missed_window:GB");
    assert.equal(byRule.source_broken.dedupeKey, "source_broken:visa:KR");
    assert.equal(byRule.review_queue_stale.details.staleItems, 2); // gb-x + c1 (the seed doc is not scraped)
    assert.equal(byRule.fx_refresh_failing.dedupeKey, "fx_refresh_failing:fx");

    // Re-running the same hour: the missed window is the same occurrence (count stays 1).
    await quiet(() => svc.runHourlyCheck(NOW + 1000));
    assert.equal(alertDocs().find((d) => d.rule === "missed_window")!.count, 1);

    // Disabling a rule resolves its active alerts.
    store.set("appConfig/scrapeAlerts", { rules: { review_queue_stale: { enabled: false } } });
    await quiet(() => svc.runHourlyCheck(NOW + 2000));
    assert.equal(alertDocs().find((d) => d.rule === "review_queue_stale")!.status, "resolved");
  });

  test("daily digest at digestHourUtc, once per UTC day", async () => {
    store.set("appConfig/scrapeAlerts", { email: { digest: true, digestHourUtc: 12, immediate: false } });
    seedRun(run("r1", { status: "failed" }));
    await quiet(() => svc.runHourlyCheck(NOW)); // 12:00 UTC: alert created + digest
    assert.equal(emails.length, 2);
    assert.match(emails[0].title, /digest for 2026-11-10: 1 active/);
    emails = [];
    await quiet(() => svc.runHourlyCheck(NOW + 10 * 60 * 1000)); // same hour again
    assert.equal(emails.length, 0);
    await quiet(() => svc.runHourlyCheck(NOW + HOUR)); // 13:00: not the digest hour
    assert.equal(emails.length, 0);
    assert.equal((store.get("appConfig/scrapeAlertsState") as any).lastDigestDay, "2026-11-10");
  });
});

// ============================================
// Controller
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
function req(role: Role, over: Data = {}): any {
  const authz = { uid: `${role}-uid`, role, agencyId: role === ROLES.OWNER || role === ROLES.AGENT ? "ag1" : null };
  return { params: {}, query: {}, body: {}, userId: authz.uid, authz, ability: defineAbilitiesFor(authz), ...over };
}

/** Call a controller handler and return the captured response. */
async function call(handler: string, r: any) {
  const { res, out } = fakeRes();
  await quiet(() => controller[handler](r, res));
  return out;
}

/** Store an alert doc directly. */
function seedAlert(id: string, over: Data = {}): void {
  store.set(`scrapeAlerts/${id}`, {
    id,
    rule: "run_failed",
    dedupeKey: `run_failed:${id}`,
    severity: "critical",
    kind: "visa",
    subject: { type: "scraper", id: "visa", label: "Visa scraper" },
    message: "m",
    firstSeen: Timestamp.fromMillis(NOW - HOUR),
    lastSeen: Timestamp.fromMillis(NOW - HOUR),
    count: 1,
    eventIds: ["r1"],
    status: "open",
    acknowledgedBy: null,
    acknowledgedAt: null,
    resolvedBy: null,
    resolvedAt: null,
    autoResolved: false,
    expireAt: Timestamp.fromMillis(NOW + 180 * DAY),
    createdAt: Timestamp.fromMillis(NOW - HOUR),
    updatedAt: Timestamp.fromMillis(NOW - HOUR),
    ...over,
  });
}

describe("scrape-alert controller", () => {
  test("owner / agent / client get 403 on every route, before any read or write", async () => {
    seedAlert("a1");
    for (const role of [ROLES.OWNER, ROLES.AGENT, ROLES.CLIENT] as Role[]) {
      assert.equal((await call("list", req(role))).status, 403);
      assert.equal((await call("get", req(role, { params: { id: "a1" } }))).status, 403);
      assert.equal((await call("acknowledge", req(role, { params: { id: "a1" } }))).status, 403);
      assert.equal((await call("resolve", req(role, { params: { id: "a1" } }))).status, 403);
    }
    assert.equal((store.get("scrapeAlerts/a1") as any).status, "open");
  });

  test("list: status=open includes acknowledged; lastSeen desc; ISO dates; no eventIds; paging", async () => {
    seedAlert("a1", { lastSeen: Timestamp.fromMillis(NOW - 3 * HOUR) });
    seedAlert("a2", { status: "acknowledged", lastSeen: Timestamp.fromMillis(NOW - 2 * HOUR) });
    seedAlert("a3", { status: "resolved", lastSeen: Timestamp.fromMillis(NOW - HOUR) });
    const open = await call("list", req(ROLES.ADMIN, { query: { status: "open" } }));
    assert.equal(open.status, 200);
    assert.deepEqual(open.body.data.items.map((i: any) => i.id), ["a2", "a1"]);
    assert.equal(open.body.data.items[0].lastSeen, new Date(NOW - 2 * HOUR).toISOString());
    assert.equal(open.body.data.items[0].eventIds, undefined);
    const resolved = await call("list", req(ROLES.ADMIN, { query: { status: "resolved" } }));
    assert.deepEqual(resolved.body.data.items.map((i: any) => i.id), ["a3"]);
    const page = await call("list", req(ROLES.ADMIN, { query: { limit: "2" } }));
    assert.deepEqual(page.body.data.items.map((i: any) => i.id), ["a3", "a2"]);
    assert.equal(page.body.data.nextCursor, "a2");
    const next = await call("list", req(ROLES.ADMIN, { query: { limit: "2", cursor: "a2" } }));
    assert.deepEqual(next.body.data.items.map((i: any) => i.id), ["a1"]);
    assert.equal(next.body.data.nextCursor, null);
    assert.equal((await call("list", req(ROLES.ADMIN, { query: { status: "closed" } }))).status, 400);
    assert.equal((await call("list", req(ROLES.ADMIN, { query: { cursor: "missing" } }))).status, 400);
  });

  test("acknowledge / resolve: audit fields, idempotence, 404, 409, pointer tombstoned", async () => {
    seedAlert("a1");
    store.set(`scrapeAlertKeys/${alertsMod.alertKeyId("run_failed:a1")}`, { dedupeKey: "run_failed:a1", alertId: "a1" });
    const ack = await call("acknowledge", req(ROLES.ADMIN, { params: { id: "a1" } }));
    assert.equal(ack.status, 200);
    assert.equal(ack.body.data.status, "acknowledged");
    assert.equal(ack.body.data.acknowledgedBy, "admin-uid");
    assert.equal(ack.body.data.acknowledgedAt, new Date(NOW).toISOString());
    assert.equal((await call("acknowledge", req(ROLES.ADMIN, { params: { id: "a1" } }))).status, 200); // idempotent

    const res = await call("resolve", req(ROLES.ADMIN, { params: { id: "a1" } }));
    assert.equal(res.status, 200);
    assert.equal(res.body.data.status, "resolved");
    assert.equal(res.body.data.resolvedBy, "admin-uid");
    assert.equal(res.body.data.autoResolved, false);
    // The alert had occurrence ids: the pointer stays as a tombstone so the
    // same run is not re-opened by the next check (review fix).
    assert.equal(pointerDocs().length, 1);
    assert.deepEqual(pointerDocs()[0].suppressEventIds, ["r1"]);
    assert.equal((await call("resolve", req(ROLES.ADMIN, { params: { id: "a1" } }))).status, 200); // idempotent
    assert.equal((await call("acknowledge", req(ROLES.ADMIN, { params: { id: "a1" } }))).status, 409);
    assert.equal((await call("acknowledge", req(ROLES.ADMIN, { params: { id: "nope" } }))).status, 404);
    assert.equal((await call("get", req(ROLES.ADMIN, { params: { id: "nope" } }))).status, 404);
    assert.equal((await call("get", req(ROLES.ADMIN, { params: { id: "a1" } }))).body.data.id, "a1");
  });
});

// ============================================
// Review fixes
// ============================================

describe("review fixes", () => {
  test("manual resolve: the same failed run is not re-opened; a new failing run is", async () => {
    seedRun(run("r1", { status: "failed" }));
    await quiet(() => svc.runHourlyCheck(NOW));
    const first = alertDocs()[0];
    assert.equal(first.status, "open");
    await quiet(() => svc.resolve(first.id, "admin1", NOW + 1000));
    // Tombstone pointer remembers r1.
    assert.deepEqual(pointerDocs()[0].suppressEventIds, ["r1"]);

    emails = [];
    await quiet(() => svc.runHourlyCheck(NOW + HOUR)); // re-reads r1: skipped
    assert.equal(alertDocs().length, 1);
    assert.equal(emails.length, 0);

    seedRun(run("r2", { status: "failed", startedAt: Timestamp.fromMillis(NOW + HOUR) }));
    await quiet(() => svc.runHourlyCheck(NOW + 2 * HOUR)); // new failing run: new alert
    assert.equal(alertDocs().filter((d) => d.status === "open").length, 1);
    assert.equal(emails.length, 2);

    // A success (finalized later than that hourly check) clears it and removes the pointer.
    svc.realClock = () => NOW + 3 * HOUR;
    try {
      await quiet(() => svc.onRunFinalized(run("r3", { startedAt: Timestamp.fromMillis(NOW + 2 * HOUR) })));
    } finally {
      svc.realClock = () => NOW;
    }
    assert.equal(pointerDocs().length, 0);
    assert.equal(alertDocs().filter((d) => d.status === "open").length, 0);
  });

  test("auto-resolve skips an alert seen after the evaluation started", async () => {
    seedAlert("a1", { dedupeKey: "run_failed:visa", lastSeen: Timestamp.fromMillis(NOW + 5 * 60 * 1000) });
    store.set(`scrapeAlertKeys/${alertsMod.alertKeyId("run_failed:visa")}`, { dedupeKey: "run_failed:visa", alertId: "a1" });
    const actions = await quiet(() =>
      svc.applyEvaluations([{ rule: "run_failed", signals: [], scope: { keys: ["run_failed:visa"] } }], cfg(), NOW)
    );
    assert.equal(actions.length, 0);
    assert.equal((store.get("scrapeAlerts/a1") as any).status, "open");
    assert.equal(pointerDocs().length, 1);
    // An evaluation that started after that sighting does resolve it.
    await quiet(() => svc.applyEvaluations([{ rule: "run_failed", signals: [], scope: { keys: ["run_failed:visa"] } }], cfg(), NOW + HOUR));
    assert.equal((store.get("scrapeAlerts/a1") as any).status, "resolved");
  });

  test("host_backoff: backoffUntil recorded; cleared when sources stop or the backoff expires", async () => {
    // Rule records the retry-after instant.
    const msg = "host backed off (429), retry after 2026-11-10T13:00:00.000Z";
    const page = { sourceId: "GB", url: "https://www.gov.uk/v", outcome: "error", error: msg };
    const sig = rules.evaluateHostBackoff(run("r2", { pages: [page] }), [run("r1", { pages: [page] })], cfg()).signals[0];
    assert.equal(sig.details.backoffUntil, "2026-11-10T13:00:00.000Z");
    assert.equal(sig.details.sources, "GB");

    // Pure clears.
    const statuses = { visa: new Map([["GB", "paused"], ["IE", "active"]]) };
    const r = rules.evaluateHostBackoffClears(
      [
        { dedupeKey: "host_backoff:visa:a", kind: "visa", details: { sources: "GB", backoffUntil: null } }, // paused
        { dedupeKey: "host_backoff:visa:b", kind: "visa", details: { sources: "XX", backoffUntil: null } }, // removed
        { dedupeKey: "host_backoff:visa:c", kind: "visa", details: { sources: "IE", backoffUntil: "2026-11-10T11:00:00.000Z" } }, // expired
        { dedupeKey: "host_backoff:visa:d", kind: "visa", details: { sources: "IE", backoffUntil: "2026-11-10T13:00:00.000Z" } }, // still on
      ],
      statuses,
      NOW
    );
    assert.deepEqual(r.scope.keys, ["host_backoff:visa:a", "host_backoff:visa:b", "host_backoff:visa:c"]);

    // Through the hourly check.
    store.set("visaSources/GB", { countryCode: "GB", status: "paused", consecutiveFailures: 0 });
    seedAlert("h1", { rule: "host_backoff", dedupeKey: "host_backoff:visa:www.gov.uk", details: { sources: "GB", backoffUntil: null } });
    store.set(`scrapeAlertKeys/${alertsMod.alertKeyId("host_backoff:visa:www.gov.uk")}`, { dedupeKey: "host_backoff:visa:www.gov.uk", alertId: "h1" });
    await quiet(() => svc.runHourlyCheck(NOW));
    const h1 = store.get("scrapeAlerts/h1") as any;
    assert.equal(h1.status, "resolved");
    assert.equal(h1.autoResolved, true);
  });

  test("post-run time budget: near the timeout -> stored, emailed by the hourly check; past it -> skipped", async () => {
    const late = await quiet(() =>
      svc.onRunFinalized(run("r1", { status: "failed", durationMs: alertsMod.HOOK_NO_EMAIL_AFTER_MS + 1000 }))
    );
    assert.equal(late.actions.length, 1);
    assert.equal(emails.length, 0);
    assert.equal(alertDocs()[0].emailPending, true);
    seedRun(run("r1", { status: "failed" })); // the hourly check sees the same run (no new occurrence)
    await quiet(() => svc.runHourlyCheck(NOW));
    assert.equal(emails.length, 2); // sent now
    assert.equal(alertDocs()[0].emailPending, false);
    emails = [];
    await quiet(() => svc.runHourlyCheck(NOW + HOUR));
    assert.equal(emails.length, 0); // only once

    resetStore();
    const skipped = await quiet(() => svc.onRunFinalized(run("r9", { status: "failed", durationMs: alertsMod.HOOK_SKIP_AFTER_MS })));
    assert.equal(skipped, undefined);
    assert.equal(alertDocs().length, 0);
  });

  test("critical alert emails bypass the email opt-out; warnings respect it", async () => {
    await quiet(() => svc.onRunFinalized(run("r1", { status: "failed" })));
    assert.ok(emails.length > 0 && emails.every((e) => e.critical === true));
    emails = [];
    await quiet(() => svc.onRunFinalized(run("r2", { pagesAttempted: 10, errorCount: 5 }))); // error_rate warning (run_failed clears)
    assert.ok(emails.length > 0 && emails.every((e) => e.critical === false));
  });
});
