// ============================================
// Test harness for route onboarding runs (issue #217) — TEST DATA ONLY
// ============================================
//
// Not a test file. Wires the REAL onboarding service over:
//   - the in-memory Firestore fake and serialised transactions (with a kill
//     switch that simulates a worker dying at any transaction);
//   - the REAL drafting-job service over the scripted provider of the rubric
//     tests (invented guidance, no network, no live model);
//   - scripted crawlers (no site is fetched) that leave exactly the documents
//     the real crawls leave;
//   - a scripted publishing pipeline: the tests write the pipeline's own record
//     (`rubricPublishRuns/...`) because the pipeline's output is the contract
//     this part reads.

import { Timestamp } from "firebase-admin/firestore";
import { fakeCollection } from "../../helpers/fake-firestore";
import { store } from "../../helpers/fake-firestore";
import { installRubricFakes, makeHarness, makeJobHarness, serialTransaction, Killed, T0, type Harness, type JobHarness } from "../rubric/rubric-harness";
import { ROUTE, ROUTE_KEY, setUpMulti } from "../rubric/rubric-job-fixtures";
import { resolvePublishSettings, type LoadedPublishSettings } from "../../../src/scrapers/rubric/rubric-publish-settings";
import { resolveOnboardingSettings, type LoadedOnboardingSettings } from "../../../src/scrapers/onboarding/onboarding-settings";
import { RouteOnboardingService, DEFAULT_TIMING, type OnboardingDeps } from "../../../src/scrapers/onboarding/route-onboarding.service";
import type { GuidanceCrawlSummary } from "../../../src/scrapers/guidance/guidance-crawl.service";
import type { RouteOnboardingRun } from "../../../src/scrapers/onboarding/onboarding-types";

/* eslint-disable @typescript-eslint/no-explicit-any */

export { ROUTE, ROUTE_KEY, T0, Killed };
export const COUNTRY = ROUTE.countryCode;
export const VISA_ID = ROUTE.visaTypeId;
export const VISA_PAGE_URL = "https://visa.invalid/page";
export const ADMIN = "admin-uid";

/** Install the fakes for every collection the onboarding code touches (once, in `before`). */
export async function installOnboardingFakes(): Promise<void> {
  await installRubricFakes();
  const firebase: any = await import("../../../src/utils/firebase");
  for (const name of ["routeOnboardingRuns", "routeOnboardingRoutes", "visaSources", "countries", "sourceRegistryAudit", "rubricPublishRuns", "rubricPublishSettingsHistory", "sourceRegistryRateLimits"]) {
    firebase.collections[name] = fakeCollection(name);
  }
  const { publishSettingsTx }: any = await import("../../../src/scrapers/rubric/rubric-publish-settings");
  publishSettingsTx.run = serialTransaction;
  const { onboardingSettingsTx }: any = await import("../../../src/scrapers/onboarding/onboarding-settings");
  onboardingSettingsTx.run = serialTransaction;
}

/** Scripted outcome of a guidance crawl, by source id (default: unchanged). */
export interface PageScript {
  outcome: "changed" | "unchanged" | "failed" | "lease_held" | "skipped_inactive" | "infra_error";
  errorKind?: string;
}

/** Everything a test turns. */
export interface OnboardingHarness {
  h: Harness;
  jh: JobHarness;
  svc: RouteOnboardingService;
  deps: OnboardingDeps;
  // Settings the service reads.
  onboarding: LoadedOnboardingSettings;
  publish: LoadedPublishSettings;
  // Scripted crawlers.
  pages: Map<string, PageScript>;
  visaScript: { leased: boolean; createsRecord: boolean; lastError?: string; budgetStop?: boolean };
  visaCrawls: { countryCode: string; force: boolean }[];
  pageCrawls: string[];
  // What the service asked the outside world to do.
  allowlistCalls: string[];
  rejected: { routeKey: string; version: number; uid: string }[];
  raised: any[][];
  // Transaction counter and kill switch (a worker dying at onboarding transaction N).
  txCount: number;
  killAtTx: number | null;
  sourceIds: string[];
  chunks: number;
}

/** Build a fully wired harness with a registered route and `sources` rule pages, ready to start. */
export async function makeOnboarding(opts: { sources?: number; paragraphs?: number } = {}): Promise<OnboardingHarness> {
  const h = makeHarness();
  const jh = makeJobHarness(h);
  const setup = await setUpMulti(h, opts.sources ?? 2, opts.paragraphs ?? 3);
  // Registry facts on top of the invented sources: the route's pages as P1 registers them.
  setup.sourceIds.forEach((id, i) => {
    const d: any = store.get(`guidanceSources/${id}`);
    store.set(`guidanceSources/${id}`, { ...d, title: `Rule page ${i + 1}`, jurisdiction: COUNTRY, route: VISA_ID.slice(COUNTRY.length + 1), role: i === 0 ? "primary" : "secondary", verificationStatus: "registered", status: "active", url: `https://docs.invalid/${id}` });
  });
  store.set(`visaSources/${COUNTRY}`, {
    id: COUNTRY, countryCode: COUNTRY, status: "active",
    pages: [{ url: VISA_PAGE_URL, routeName: "Short visit", validation: "unverified", visaId: VISA_ID, addedVia: "portal" }],
  });
  store.set(`countries/${COUNTRY}`, { code: COUNTRY, name: "Testland", isSupported: false });

  const oh: OnboardingHarness = {
    h, jh, svc: undefined as unknown as RouteOnboardingService, deps: undefined as unknown as OnboardingDeps,
    onboarding: { settings: { ...resolveOnboardingSettings({ enabled: true }).settings }, problems: [] },
    publish: { settings: resolvePublishSettings({ mode: "auto" }).settings, exists: true, problems: [] },
    pages: new Map(), visaScript: { leased: false, createsRecord: true }, visaCrawls: [], pageCrawls: [],
    allowlistCalls: [], rejected: [], raised: [], txCount: 0, killAtTx: null, sourceIds: setup.sourceIds, chunks: setup.chunks,
  };
  let owner = 0;
  const deps: OnboardingDeps = {
    runTransaction: (fn) => {
      oh.txCount += 1;
      if (oh.killAtTx !== null && oh.txCount >= oh.killAtTx) return Promise.reject(new Killed());
      return serialTransaction(fn);
    },
    clock: () => h.state.nowMs,
    newOwnerId: () => `onb-worker-${++owner}`,
    timing: { ...DEFAULT_TIMING },
    loadSettings: async () => oh.onboarding,
    loadPublishSettings: async () => oh.publish,
    loadExtractionSettings: async () => ({ settings: h.settings }),
    jobs: () => jh.jobs,
    crawlVisa: async (countryCode, force) => {
      oh.visaCrawls.push({ countryCode, force });
      if (oh.visaScript.leased) return { sourcesLeased: 1, budgetHardStop: false, extractionsSkippedBudget: 0 };
      if (oh.visaScript.budgetStop) return { sourcesLeased: 0, budgetHardStop: true, extractionsSkippedBudget: 1 };
      if (oh.visaScript.createsRecord) {
        // What the real crawl leaves: a PENDING, INACTIVE record from this page.
        store.set(`countries/${COUNTRY}/visaTypes/${VISA_ID}`, { id: VISA_ID, name: "Short visit", source: "scraped", reviewStatus: "pending_review", isActive: false, scrapeMeta: { sourceUrl: VISA_PAGE_URL } });
      } else if (oh.visaScript.lastError) {
        const vs: any = store.get(`visaSources/${COUNTRY}`);
        store.set(`visaSources/${COUNTRY}`, { ...vs, pages: vs.pages.map((p: any) => ({ ...p, lastError: oh.visaScript.lastError })) });
      }
      return { sourcesLeased: 0, budgetHardStop: false, extractionsSkippedBudget: 0 };
    },
    crawlGuidance: async (sourceId) => {
      oh.pageCrawls.push(sourceId);
      const script = oh.pages.get(sourceId) ?? { outcome: "unchanged" as const };
      const d: any = store.get(`guidanceSources/${sourceId}`);
      const results: any[] = [{ sourceId, outcome: script.outcome, ...(script.outcome === "changed" || script.outcome === "unchanged" ? { contentHash: d.latestSnapshotId } : {}), ...(script.errorKind ? { errorKind: script.errorKind } : {}) }];
      return { results } as unknown as GuidanceCrawlSummary;
    },
    getHead: async (key) => (store.get(`visaRubrics/${key}`) as any) ?? null,
    getVersion: async (key, v) => (store.get(`visaRubrics/${key}/rubricVersions/${v}`) as any) ?? null,
    getPublishRun: async (id) => {
      const r: any = store.get(`rubricPublishRuns/${id}`);
      return r ? { outcome: r.outcome, reasonCodes: r.reasonCodes ?? [], attempts: r.attempts ?? 1 } : null;
    },
    addToAllowlist: async (routeKey) => {
      oh.allowlistCalls.push(routeKey);
      return "added";
    },
    rejectDraft: async (routeKey, version, uid) => {
      oh.rejected.push({ routeKey, version, uid });
    },
    loadAlertConfig: async () => ({ enabled: true, rules: {} } as any),
    raiseAlerts: async (evals) => {
      oh.raised.push(evals as any[]);
    },
    appUrl: () => "https://admin.test",
    // (#233 P4b) Shared routes read from the fake store; member records counted from `inheritsFrom` there.
    getSharedRoute: async (id) => (store.get(`sharedRoutes/${id}`) as any) ?? null,
    countMemberRecords: async (id) => [...store.entries()].filter(([p, d]) => /^countries\/[^/]+\/visaTypes\/[^/]+$/.test(p) && Array.isArray((d as any).inheritsFrom) && (d as any).inheritsFrom.some((r: any) => r.sharedRouteId === id)).length,
  };
  oh.deps = deps;
  oh.svc = new RouteOnboardingService(deps);
  return oh;
}

/** The stored run (the fake's copy). */
export const runOf = (id: string): RouteOnboardingRun => store.get(`routeOnboardingRuns/${id}`) as unknown as RouteOnboardingRun;

/**
 * Do what the worker trigger does: call `advance` until the run waits for
 * something outside it (a person, the drafting job, the pipeline) or ends.
 * Returns the number of invocations.
 */
export async function pump(oh: OnboardingHarness, runId: string, max = 60): Promise<number> {
  for (let i = 1; i <= max; i++) {
    const out = await oh.svc.advance(runId);
    if (out.kind === "idle" || out.kind === "finished" || out.kind === "lease_held" || out.kind === "lease_lost") return i;
    if (out.kind === "advanced" && !out.wake) return i;
  }
  throw new Error("the run never settled");
}

/** Do what `processRubricExtractionJob` does: advance the drafting job until it is final. */
export async function driveJob(oh: OnboardingHarness, jobId: string): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const out = await oh.jh.jobs.advance(jobId);
    if (out.kind === "finished" || out.kind === "idle") return;
  }
  throw new Error("the job never finished");
}

/** Write the publishing pipeline's own record for a version. */
export function writePublishRun(routeKey: string, version: number, rec: { outcome: "published" | "held" | "skipped"; reasonCodes?: string[]; attempts?: number }): void {
  store.set(`rubricPublishRuns/${routeKey}__v${version}`, { runId: `${routeKey}__v${version}`, routeKey, version, reasonCodes: [], attempts: 1, ...rec, startedAt: Timestamp.fromMillis(T0), finishedAt: Timestamp.fromMillis(T0) });
}

/** Run to `awaiting_confirmation` (start, then pump). */
export async function prepare(oh: OnboardingHarness): Promise<RouteOnboardingRun> {
  const run = await oh.svc.start(COUNTRY, VISA_ID, ADMIN);
  await pump(oh, run.runId);
  return runOf(run.runId);
}

/** Confirm the stored estimate. */
export function confirm(oh: OnboardingHarness, run: RouteOnboardingRun, extra: { addToAllowlist?: boolean } = {}) {
  return oh.svc.confirm(run.runId, { estimateId: (runOf(run.runId).estimate as any).estimateId, addToAllowlist: extra.addToAllowlist === true }, ADMIN);
}

/** Confirm, pump until the drafting job exists, drive the job, pump until the run waits on the pipeline. */
export async function confirmAndDraft(oh: OnboardingHarness, run: RouteOnboardingRun): Promise<RouteOnboardingRun> {
  await confirm(oh, run);
  await pump(oh, run.runId);
  const jobId = runOf(run.runId).links.jobId as string;
  await driveJob(oh, jobId);
  await pump(oh, run.runId);
  return runOf(run.runId);
}

/** Documents under a collection path prefix. */
export const docsUnder = (prefix: string) => [...store.keys()].filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes("/"));
