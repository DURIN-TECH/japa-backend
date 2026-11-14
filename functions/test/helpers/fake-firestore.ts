// ============================================
// Test helper — a small in-memory Firestore fake (issue #61)
// ============================================
//
// Not a test file itself (`npm test` runs test/*.test.ts only). Shared by the
// pendingVisaChanges suites so they need NO emulator and NO network.
//
// Supports only what the visa-catalog services call:
//  - doc refs: get / set (+merge) / update (dotted paths, FieldValue.delete())
//    / collection(name) for subcollections (e.g. crawlRuns);
//  - collection refs + queries: doc(id?) (auto id when omitted), add,
//    where (==, <, <=, >, >=; Timestamps compared by millis), orderBy
//    (asc/desc), limit, startAfter(docSnapshot) (issue #81 cursor pages), get;
//  - `in` filters and doc / tx deletes (issue #83 alert store);
//  - count() aggregations on a collection / query (issue #28);
//  - runTransaction: tx.get(ref | query), tx.set / tx.update / tx.delete buffered and
//    applied only when the callback resolves — a throw writes NOTHING, like a
//    real transaction.
// Every update()/set() is recorded in `writes` so tests can assert exactly
// what was (or was not) written.
//
// Issue #94: anything a test forgets to fake is caught by the preload,
// test/helpers/setup.ts — a real Firestore / Google call rejects at once and
// fails the test that made it. When a new code path (a new collection, or a
// new service with its own `runTransaction`) is reached from a test, add it to
// installFakes() below (or to the suite's own fake).

import { FieldValue, Timestamp } from "firebase-admin/firestore";

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Data = Record<string, unknown>;

/** "path/to/doc" -> stored data. */
export const store = new Map<string, Data>();
/** Every committed write, in order (raw payload, sentinels intact). */
export const writes: { op: "set" | "update" | "delete"; path: string; data: Data }[] = [];

/** Reset the fake between tests. */
export function resetStore(): void {
  store.clear();
  writes.length = 0;
}

let autoId = 0;

/** Deep-copy plain objects/arrays; keep class instances (Timestamp,
 *  FieldValue sentinels) by reference so their prototypes survive. */
export function clone<T>(v: T): T {
  if (Array.isArray(v)) return v.map(clone) as unknown as T;
  if (v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)])) as T;
  }
  return v;
}

/** Apply a Firestore-style update with dotted field paths. */
function applyUpdate(target: Data, update: Data): Data {
  const out: Data = clone(target);
  for (const [path, value] of Object.entries(update)) {
    const parts = path.split(".");
    let cur = out as Data;
    for (const p of parts.slice(0, -1)) {
      if (typeof cur[p] !== "object" || cur[p] === null) cur[p] = {};
      cur = cur[p] as Data;
    }
    const last = parts[parts.length - 1];
    // FieldValue.delete() sentinel → remove the key, like Firestore.
    if (value instanceof FieldValue && value.isEqual(FieldValue.delete())) delete cur[last];
    else cur[last] = clone(value);
  }
  return out;
}

/** Raw writes (no transaction). */
/** Deep-merge plain objects (what a real set(..., {merge:true}) does with nested maps). */
function deepMerge(base: Data, patch: Data): Data {
  const out: Data = clone(base);
  for (const [k, v] of Object.entries(patch)) {
    const cur = out[k];
    const plain = (x: unknown) => !!x && typeof x === "object" && Object.getPrototypeOf(x) === Object.prototype;
    out[k] = plain(v) && plain(cur) ? deepMerge(cur as Data, v as Data) : clone(v);
  }
  return out;
}
function doSet(path: string, data: Data, merge?: boolean): void {
  writes.push({ op: "set", path, data: { ...data } });
  // Merge keeps untouched nested map keys (issue #120: per-agency cap counters);
  // FieldValue sentinels still go through applyUpdate at the top level.
  if (merge) {
    const merged = deepMerge(store.get(path) ?? {}, data);
    store.set(path, applyUpdate(merged, Object.fromEntries(Object.entries(data).filter(([, v]) => v instanceof FieldValue))));
  } else {
    store.set(path, applyUpdate({}, data));
  }
}
function doUpdate(path: string, data: Data): void {
  const cur = store.get(path);
  if (!cur) throw new Error(`NOT_FOUND ${path}`);
  writes.push({ op: "update", path, data: { ...data } });
  store.set(path, applyUpdate(cur, data));
}

/** Delete a doc (a missing doc is fine, like Firestore). Issue #83. */
function doDelete(path: string): void {
  writes.push({ op: "delete", path, data: {} });
  store.delete(path);
}

/** A doc snapshot shaped like Firestore's. */
function snapshot(path: string, ref: any) {
  const d = store.get(path);
  return { id: ref.id, exists: d !== undefined, ref, data: () => (d ? clone(d) : undefined) };
}

/** A doc ref backed by `store`. */
export function fakeDoc(path: string): any {
  const ref = {
    id: path.split("/").pop()!,
    path,
    async get() {
      return snapshot(path, ref);
    },
    async set(data: Data, opts?: { merge?: boolean }) {
      doSet(path, data, opts?.merge);
    },
    // create(): like the real SDK, fails with gRPC ALREADY_EXISTS (6) when the doc is
    // there. The rule-change event store (#123) relies on it for idempotency.
    async create(data: Data) {
      if (store.has(path)) throw Object.assign(new Error(`ALREADY_EXISTS: ${path}`), { code: 6 });
      doSet(path, data);
    },
    async update(data: Data) {
      doUpdate(path, data);
    },
    async delete() {
      doDelete(path);
    },
    collection: (name: string) => fakeCollection(`${path}/${name}`),
  };
  return ref;
}

/** Comparable form of a stored value (Timestamps by millis). */
function cmpValue(v: unknown): unknown {
  return v instanceof Timestamp ? v.toMillis() : v;
}

type Filter = [string, string, unknown];

/** Read a (possibly dotted, e.g. "subject.type") field path from a doc. */
function getPath(d: Data, path: string): unknown {
  return path.split(".").reduce<any>((cur, k) => (cur === undefined || cur === null ? undefined : cur[k]), d);
}

/**
 * A collection ref / query backed by `store` (direct children only).
 * `afterPath`: startAfter() cursor — results begin after the doc at this
 * path in the query's order (ties keep insertion order, like the real
 * Firestore's implicit name tiebreak only approximately; tests avoid ties).
 */
export function fakeCollection(
  path: string,
  filters: Filter[] = [],
  order?: { field: string; dir: "asc" | "desc" },
  max?: number,
  afterPath?: string
): any {
  const col = {
    path,
    doc: (id?: string) => fakeDoc(`${path}/${id ?? `auto${++autoId}`}`),
    async add(data: Data) {
      const ref = col.doc();
      doSet(ref.path, data);
      return ref;
    },
    where(field: string, op: string, value: unknown) {
      return fakeCollection(path, [...filters, [field, op, value]], order, max, afterPath);
    },
    orderBy(field: string, dir: "asc" | "desc" = "asc") {
      return fakeCollection(path, filters, { field, dir }, max, afterPath);
    },
    limit(n: number) {
      return fakeCollection(path, filters, order, n, afterPath);
    },
    // Field projection (issue #81 stats scan): the fake returns whole docs.
    select() {
      return fakeCollection(path, filters, order, max, afterPath);
    },
    // Cursor: a doc snapshot from a previous get() (its ref.path is the key).
    startAfter(snap: { ref: { path: string } }) {
      return fakeCollection(path, filters, order, max, snap.ref.path);
    },
    // count() aggregation (issue #28 document limit): same filters as get(),
    // returned in the AggregateQuerySnapshot shape (`.data().count`).
    count() {
      return {
        async get() {
          const snap = await col.get();
          return { data: () => ({ count: snap.size as number }) };
        },
      };
    },
    async get() {
      let entries = [...store.entries()]
        .filter(([p]) => p.startsWith(`${path}/`) && !p.slice(path.length + 1).includes("/"))
        .filter(([, d]) =>
          filters.every(([f, op, v]) => {
            const a = cmpValue(getPath(d, f)) as any;
            const b = cmpValue(v) as any;
            if (op === "==") return a === b;
            // `in`: the value is an array of candidates (issue #83).
            if (op === "in") return (v as unknown[]).map(cmpValue).includes(a);
            // `array-contains` (issue #231): the stored array holds the value (objects compared by JSON).
            if (op === "array-contains") return Array.isArray(a) && a.some((x) => JSON.stringify(x) === JSON.stringify(b));
            if (a === undefined) return false;
            if (op === "<") return a < b;
            if (op === "<=") return a <= b;
            if (op === ">") return a > b;
            if (op === ">=") return a >= b;
            throw new Error(`fake: unsupported op ${op}`);
          })
        );
      if (order) {
        const sign = order.dir === "desc" ? -1 : 1;
        entries = entries.sort(([, a], [, b]) => {
          const x = cmpValue(getPath(a, order.field)) as any;
          const y = cmpValue(getPath(b, order.field)) as any;
          return x === y ? 0 : x < y ? -sign : sign;
        });
      }
      if (afterPath !== undefined) {
        const i = entries.findIndex(([p]) => p === afterPath);
        entries = i >= 0 ? entries.slice(i + 1) : [];
      }
      if (max !== undefined) entries = entries.slice(0, max);
      const docs = entries.map(([p]) => snapshot(p, fakeDoc(p)));
      return { docs, empty: docs.length === 0, size: docs.length };
    },
  };
  return col;
}

/** Number of transactions run (and how many committed). */
export const txStats = { runs: 0, commits: 0 };

/**
 * In-memory runTransaction: reads go straight to the store, writes are
 * buffered and applied only after `fn` resolves (a throw discards them).
 */
export async function fakeRunTransaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
  txStats.runs++;
  const pending: (() => void)[] = [];
  const tx = {
    get: (refOrQuery: any) => refOrQuery.get(),
    set(ref: any, data: Data, opts?: { merge?: boolean }) {
      pending.push(() => doSet(ref.path, data, opts?.merge));
      return tx;
    },
    // create(): like the real transaction, fails when the doc exists (#215 audit trail).
    create(ref: any, data: Data) {
      pending.push(() => {
        if (store.has(ref.path)) throw Object.assign(new Error(`ALREADY_EXISTS: ${ref.path}`), { code: 6 });
        doSet(ref.path, data);
      });
      return tx;
    },
    update(ref: any, data: Data) {
      pending.push(() => doUpdate(ref.path, data));
      return tx;
    },
    delete(ref: any) {
      pending.push(() => doDelete(ref.path));
      return tx;
    },
  };
  const result = await fn(tx);
  for (const w of pending) w();
  txStats.commits++;
  return result;
}

/**
 * Swap the real Firestore refs in utils/firebase for fakes, and the
 * transaction runners (changes service, catalog service, visa service) for
 * the in-memory one. Call in `before()`.
 */
export async function installFakes(): Promise<void> {
  const firebase: any = await import("../../src/utils/firebase");
  firebase.collections.appConfig = fakeCollection("appConfig");
  // Issue #179: public agent / agency reads look up the exchange rate to add
  // a local figure; an empty fake means "no rate stored" (local figures
  // unavailable, dollar prices still served). Suites that want a rate call
  // useFixedRate() from test/helpers/local-pricing.ts.
  firebase.collections.exchangeRates = fakeCollection("exchangeRates");
  firebase.collections.visaSources = fakeCollection("visaSources");
  firebase.collections.guidanceSources = fakeCollection("guidanceSources");
  // Issue #215: the source registry safeguards (all backend-only collections).
  firebase.collections.officialDomains = fakeCollection("officialDomains");
  firebase.collections.officialDomainPreviews = fakeCollection("officialDomainPreviews");
  firebase.collections.sourceRegistryAudit = fakeCollection("sourceRegistryAudit");
  firebase.collections.sourceRegistryRateLimits = fakeCollection("sourceRegistryRateLimits");
  // Issue #232: the registry checks the authority a website or route belongs to.
  firebase.collections.authorities = fakeCollection("authorities");
  firebase.collections.countries = fakeCollection("countries");
  firebase.collections.pendingVisaChanges = fakeCollection("pendingVisaChanges");
  // Issue #81: run records + the news registry (source health, news runs).
  firebase.collections.scrapeRuns = fakeCollection("scrapeRuns");
  firebase.collections.newsSources = fakeCollection("newsSources");
  // Issue #17: the health rows count a source's articles (articlesLast7d).
  firebase.collections.newsArticles = fakeCollection("newsArticles");
  // Issue #83: the alert store + its dedupe pointers, and users (recipients).
  // Issue #123: approving a visa change records a rule-change event after commit.
  firebase.collections.ruleChangeEvents = fakeCollection("ruleChangeEvents");
  firebase.collections.scrapeAlerts = fakeCollection("scrapeAlerts");
  firebase.collections.scrapeAlertKeys = fakeCollection("scrapeAlertKeys");
  firebase.collections.users = fakeCollection("users");
  firebase.subcollections.scrapeRuns = (id: string) => fakeCollection(`newsSources/${id}/scrapeRuns`);
  firebase.subcollections.visaTypes = (cc: string) => fakeCollection(`countries/${cc}/visaTypes`);
  const changes: any = await import("../../src/scrapers/visa-catalog/changes/visa-catalog-changes.service");
  changes.visaChangeService.runTransaction = fakeRunTransaction;
  // Issue #70: the catalog's pending-refresh write and the manual-cost write
  // are transactional too.
  const catalog: any = await import("../../src/scrapers/visa-catalog/visa-catalog.service");
  catalog.visaCatalogService.runTransaction = fakeRunTransaction;
  const visa: any = await import("../../src/services/visa.service");
  visa.visaService.runTransaction = fakeRunTransaction;
  // Issue #81: the stale run sweep is transactional.
  const runs: any = await import("../../src/scrapers/shared/runs/scrape-run.service");
  runs.scrapeRunService.runTransaction = fakeRunTransaction;
  // Issue #82: the monthly cost rollup (scrapeCosts + its runs markers) is
  // written by a finalize hook in a transaction.
  firebase.collections.scrapeCosts = fakeCollection("scrapeCosts");
  const costs: any = await import("../../src/scrapers/shared/cost/scrape-cost.service");
  costs.scrapeCostService.runTransaction = fakeRunTransaction;
  // Issue #83: alert upserts / resolves / digest claim are transactional.
  const alerts: any = await import("../../src/scrapers/shared/alerts/scrape-alert.service");
  alerts.scrapeAlertService.runTransaction = fakeRunTransaction;
  // Issue #96: settings audit history, Run now requests + their locks, and
  // the three services that write them in transactions.
  firebase.collections.scraperSettingsHistory = fakeCollection("scraperSettingsHistory");
  firebase.collections.scrapeRunRequests = fakeCollection("scrapeRunRequests");
  firebase.collections.scrapeRunLocks = fakeCollection("scrapeRunLocks");
  // Review: per-source crawl leases, taken in a transaction by every crawl.
  firebase.collections.scrapeSourceLeases = fakeCollection("scrapeSourceLeases");
  const leases: any = await import("../../src/scrapers/shared/runs/source-lease");
  leases.sourceLeaseService.runTransaction = fakeRunTransaction;
  const settings: any = await import("../../src/scrapers/shared/settings/scraper-settings.service");
  settings.scraperSettingsService.runTransaction = fakeRunTransaction;
  const requests: any = await import("../../src/scrapers/shared/settings/scrape-run-request.service");
  requests.scrapeRunRequestService.runTransaction = fakeRunTransaction;
  const worker: any = await import("../../src/scrapers/shared/settings/scrape-run-worker");
  worker.scrapeRunWorker.runTransaction = fakeRunTransaction;
  // Issue #107: the per-run source health writes (news + visa) re-read the
  // source status in a transaction (an admin pause made mid-run is kept).
  const newsHealth: any = await import("../../src/scrapers/news/news-source-health");
  newsHealth.newsSourceHealthService.runTransaction = fakeRunTransaction;
  const crawl: any = await import("../../src/scrapers/visa-catalog/visa-catalog-crawl.service");
  crawl.visaCatalogCrawlService.runTransaction = fakeRunTransaction;
  // Issue #101: the admin visa list / review reads agency names and pending
  // revisions, and the agency visa review runs in its own transaction.
  firebase.collections.agencies = fakeCollection("agencies");
  firebase.collections.visaRevisions = fakeCollection("visaRevisions");
  const agencyReview: any = await import("../../src/agency-visas/agency-visa-review.service");
  agencyReview.agencyVisaReviewService.runTransaction = fakeRunTransaction;

  // Issue #119: the risk-signal store, its audit subcollection (reached
  // through the doc ref's collection()), and the transactional raise /
  // status change. Also the collections the "no signal leaks into a
  // non-admin response" test reads: applications, agents, conversations,
  // notifications and document requests (users + agencies are above).
  firebase.collections.riskSignals = fakeCollection("riskSignals");
  firebase.collections.applications = fakeCollection("applications");
  firebase.collections.agents = fakeCollection("agents");
  firebase.collections.conversations = fakeCollection("conversations");
  firebase.collections.notifications = fakeCollection("notifications");
  firebase.collections.documentRequests = fakeCollection("documentRequests");
  // attachAuthz reads the caller's resolved-entitlements cache for every
  // non-admin token (null means RBAC-only, which is what these tests want).
  firebase.collections.entitlements = fakeCollection("entitlements");
  // Issue #172: the conversation list/response reads the caller's AI message
  // access record (approval, account-wide setting) for the `aiAccess` view.
  firebase.collections.aiMessageAccess = fakeCollection("aiMessageAccess");
  firebase.collections.aiMessageAccessAudit = fakeCollection("aiMessageAccessAudit");
  const riskSignals: any = await import("../../src/services/risk-signal.service");
  riskSignals.riskSignalService.runTransaction = fakeRunTransaction;

  // Issue #120: listing screening results, the daily AI counters it claims
  // caps from, and its transactional cap claim.
  firebase.collections.listingScreenings = fakeCollection("listingScreenings");
  firebase.collections.aiCosts = fakeCollection("aiCosts");
  const screening: any = await import("../../src/agency-visas/agency-visa-screening.service");
  screening.agencyVisaScreeningService.deps.runTransaction = fakeRunTransaction;
  // Never the real model in a unit test: a request with no recording throws
  // (screening then records `model_failed`), so a test cannot reach the network.
  const llm: any = await import("../../src/services/ai/llm-provider");
  screening.agencyVisaScreeningService.deps.provider = new llm.RecordedLlmProvider();
}
