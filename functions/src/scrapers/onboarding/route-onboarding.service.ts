import { randomUUID } from "crypto";
import { Timestamp, type Transaction } from "firebase-admin/firestore";
import { collections, db, subcollections } from "../../utils/firebase";
import type { GuidanceSource } from "../guidance/types";
import type { GuidanceCrawlSummary } from "../guidance/guidance-crawl.service";
import { deriveVisaId } from "../visa-catalog/visa-catalog-ids";
import type { VisaSource, VisaSourcePage } from "../visa-catalog/types";
import { rubricExtractionJobService, type RubricExtractionJobService, type StartJobResult } from "../rubric/rubric-extraction-job";
import { loadRubricSettings, type LoadedRubricSettings } from "../rubric/rubric-settings";
import { loadPublishSettings, addRouteToAllowlist, type AllowlistAddResult, type LoadedPublishSettings } from "../rubric/rubric-publish-settings";
// Issue #232: run keys are rulebook keys `{authorityId}_{routeSlug}` (pure rules, no Firebase).
import { buildRulebookKey, checkAuthorityId } from "../../authorities/authority-ids";
import type { RubricHead, VisaRubric } from "../../types/rubric";
import { appendRegistryAudit } from "../shared/registry/registry-audit";
import {
  evaluateRouteOnboardingAttention,
  evaluateRouteOnboardingCleared,
  type RuleEvaluation,
} from "../shared/alerts/scrape-alert-rules";
import type { ScrapeAlertsConfig } from "../shared/alerts/types";
import { loadOnboardingSettings, type LoadedOnboardingSettings } from "./onboarding-settings";
import {
  OnboardingError,
  isTerminalRun,
  STEP_IDS,
  WORKER_RUN_STATUSES,
  type Confirmation,
  type HoldReason,
  type RouteOnboardingHead,
  type RouteOnboardingRun,
  type RunCounters,
  type RunStatus,
  type RunStep,
  type StepId,
  type StepStatus,
} from "./onboarding-types";
import {
  JOB_FAILURE_WORDS,
  STATUS_PLAIN,
  THIN_PLAIN,
  buildEstimate,
  capRefusal,
  crawlFailureWords,
  initialSteps,
  jobCapMessage,
  mapJob,
  mapPublish,
  publishStateOf,
  type PublishVerdict,
} from "./onboarding-words";

// ============================================
// ROUTE ONBOARDING RUN — SERVICE AND WORKER (issue #217, part P3 of #211)
// ============================================
//
// One RUN takes a registered route from its sources to a published or held
// rulebook. The run is a document (`routeOnboardingRuns/{routeKey}__r{n}`) and
// this service advances it in SMALL SAVED STEPS, one external action per worker
// invocation, so it survives the 540 s function limit and crashes.
//
// ---- the chain (the step ids are in onboarding-types.ts) ----
//   check_setup      registry, sources and settings are in order (no call)
//   read_visa_page   the visa crawl creates the visa record, pending and hidden (DeepSeek, not Claude)
//   read_rule_pages  one guidance crawl per source (no model)
//   plan             the drafting job's DRY plan: sizes and caps. No model call.
//   confirm          STOP. The estimate is stored; an admin confirms the number they saw.
//   draft            on confirm: re-check the plan, optional allow-list patch, start the P2 job, mirror it
//   safeguards       the draft was written; the #200 pipeline publishes or holds it; the run watches
//
// ---- why advancing is safe (read before changing) ----
// 1. STATE IS THE DOCUMENT. What to do next is derived from the stored step
//    statuses and ids, never from memory in a worker.
// 2. ONE ACTION PER INVOCATION, then a transaction that (a) re-checks the
//    worker still owns the lease, (b) writes the result, (c) releases the lease
//    and bumps `kick`, which fires the worker trigger again. A crash before the
//    transaction repeats the action; every action is safe to repeat:
//      - crawls are content-hash gated and the visa crawl is skipped when the
//        record exists, so a repeat makes no model call;
//      - the drafting job has a deterministic id (a repeat is `existing`);
//      - the allow-list patch is idempotent;
//      - the publishing pipeline is only OBSERVED, never started: this file
//        never calls `runOnDraft` and never changes `mode`.
// 3. LEASES. A worker claims the run in a transaction; a second worker finds a
//    live lease and does nothing; a dead worker's lease simply expires and the
//    5-minute sweep wakes the run. A re-delivered trigger is inert.
// 4. CANCEL stops before the NEXT action. A cancelled run cancels its drafting
//    job and, if the draft was already written but undecided, rejects that
//    draft, so a cancelled run publishes nothing new.
// 5. NO MODEL CALL BEFORE CONFIRMATION. Nothing before the `confirm` step calls
//    a model provider (the visa extractor is DeepSeek; the plan is a dry run).
//    Confirming records who, when and the number; the start is refused if the
//    plan has since changed (or now needs more calls than the confirmed number)
//    and the admin is asked again.
// 6. VISIBILITY NEVER CHANGES. The run never approves a visa record and never
//    sets `isSupported`: both stay with an admin (the final checklist says so).
//
// Generic: nothing here names a country, route, nationality or publisher.
// Logging: ids, counts and codes only.

/** Tag on every line this module logs. */
const TAG = "[route-onboarding]";

/** Timings. Exposed so tests can shorten them. */
export interface OnboardingTiming {
  // Lease on a run while a worker advances it.
  leaseMs: number;
  // Wait before retrying a crawl that could not run yet (a lease held, a host backing off).
  crawlRetryMs: number;
  // Poll interval while the drafting job runs / the safeguards decide.
  pollMs: number;
  // The sweep leaves a run alone while it made progress this recently.
  sweepIdleMs: number;
  // Waits (not failures) one action may make before the run fails with "still busy".
  maxWaits: number;
}
export const DEFAULT_TIMING: Readonly<OnboardingTiming> = Object.freeze({
  leaseMs: 10 * 60_000,
  crawlRetryMs: 2 * 60_000,
  pollMs: 3 * 60_000,
  sweepIdleMs: 60_000,
  maxWaits: 24,
});

/** The facts of a visa crawl the run needs (a subset of the crawl summary). */
export interface VisaCrawlFacts {
  sourcesLeased: number;
  budgetHardStop: boolean;
  extractionsSkippedBudget: number;
}

/** Everything the service reaches outside itself; all injectable for tests. */
export interface OnboardingDeps {
  // Transaction runner (tests swap in the in-memory one).
  runTransaction: <T>(fn: (tx: Transaction) => Promise<T>) => Promise<T>;
  clock: () => number;
  newOwnerId: () => string;
  timing: OnboardingTiming;
  loadSettings: () => Promise<LoadedOnboardingSettings>;
  loadPublishSettings: () => Promise<LoadedPublishSettings>;
  loadExtractionSettings: () => Promise<LoadedRubricSettings>;
  // The P2 drafting job service (start with dryRun, start, status, cancel).
  jobs: () => Pick<RubricExtractionJobService, "startJob" | "getStatus" | "cancel">;
  // The visa crawl of one country source, as the manual "Run now" worker calls it.
  crawlVisa: (countryCode: string, force: boolean) => Promise<VisaCrawlFacts>;
  // The guidance crawl of one source.
  crawlGuidance: (sourceId: string) => Promise<GuidanceCrawlSummary>;
  // The head and a version of a rulebook (for the unchanged check and the watch).
  getHead: (routeKey: string) => Promise<RubricHead | null>;
  getVersion: (routeKey: string, version: number) => Promise<VisaRubric | null>;
  // The pipeline's run record of a version (`rubricPublishRuns/{routeKey}__v{n}`).
  getPublishRun: (runId: string) => Promise<{ outcome: "published" | "held" | "skipped"; reasonCodes: string[]; attempts: number } | null>;
  addToAllowlist: (routeKey: string, uid: string) => Promise<AllowlistAddResult>;
  // Reject an undecided draft (cancel after the draft was written).
  rejectDraft: (routeKey: string, version: number, uid: string) => Promise<void>;
  // Alerts.
  loadAlertConfig: () => Promise<ScrapeAlertsConfig>;
  raiseAlerts: (evals: RuleEvaluation[], config?: ScrapeAlertsConfig) => Promise<unknown>;
  appUrl: () => string;
}

/** The lease was taken over by another worker, or the run ended: stop touching it. */
class LeaseLost extends Error {
  constructor() {
    super("the lease on the run is no longer held by this worker");
  }
}

/** What one `advance` call ended with. */
export type AdvanceOutcome =
  | { kind: "idle"; status: RunStatus | null }
  | { kind: "lease_held" }
  | { kind: "lease_lost" }
  // An action ran; the run was kicked for the next one (or is waiting).
  | { kind: "advanced"; status: RunStatus; wake: boolean }
  | { kind: "finished"; status: RunStatus };

/** A change to a run, built inside the committing transaction from the run as stored. */
interface Change {
  status?: RunStatus;
  summary?: string;
  steps?: RunStep[];
  pinned?: RouteOnboardingRun["pinned"];
  estimate?: RouteOnboardingRun["estimate"];
  confirmation?: RouteOnboardingRun["confirmation"];
  voidedConfirmations?: Confirmation[];
  allowlist?: RouteOnboardingRun["allowlist"];
  counters?: RunCounters;
  holdReason?: HoldReason | null;
  links?: RouteOnboardingRun["links"];
  unchanged?: boolean;
  nextAttemptAt?: Timestamp | null;
  attempts?: RouteOnboardingRun["attempts"];
  handedToSafeguardsAt?: Timestamp | null;
  // Bump `kick` so the trigger fires and the next action starts at once.
  wake?: boolean;
}

/** Epoch milliseconds of a Timestamp-like value (0 when absent). */
const ms = (t: Timestamp | null | undefined): number => (t ? t.toMillis() : 0);

/** Clip a text to `n` characters. */
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The host of an address, or "" when it is not one. */
function hostOf(url: string | undefined): string {
  try {
    return new URL(url ?? "").hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** Replace one step in a list (a new array). */
function withStep(steps: readonly RunStep[], id: StepId, patch: Partial<Omit<RunStep, "id" | "label">>, now: Timestamp): RunStep[] {
  return steps.map((s) => {
    if (s.id !== id) return s;
    const status: StepStatus = patch.status ?? s.status;
    return {
      ...s,
      ...patch,
      startedAt: s.startedAt ?? (status === "pending" ? null : now),
      finishedAt: ["done", "skipped", "failed", "cancelled"].includes(status) ? now : null,
    };
  });
}

/** The first step that is not finished (the one an action works on). */
function currentStep(steps: readonly RunStep[]): RunStep | undefined {
  return steps.find((s) => s.status !== "done" && s.status !== "skipped");
}

/** Summaries a registered route is found from. */
interface RegisteredRoute {
  page: VisaSourcePage;
  source: VisaSource;
  guidance: { id: string; data: GuidanceSource }[];
}

export class RouteOnboardingService {
  /** @param overrides replacements for tests; production passes nothing. */
  constructor(private readonly overrides: Partial<OnboardingDeps> = {}) {}

  /** The dependencies in force, resolved at CALL time (see the import-cycle note in scrapers/index.ts). */
  private get d(): OnboardingDeps {
    const o = this.overrides;
    return {
      runTransaction: o.runTransaction ?? ((fn) => db.runTransaction(fn)),
      clock: o.clock ?? Date.now,
      newOwnerId: o.newOwnerId ?? (() => randomUUID()),
      timing: o.timing ?? DEFAULT_TIMING,
      loadSettings: o.loadSettings ?? loadOnboardingSettings,
      loadPublishSettings: o.loadPublishSettings ?? loadPublishSettings,
      loadExtractionSettings: o.loadExtractionSettings ?? loadRubricSettings,
      jobs: o.jobs ?? (() => rubricExtractionJobService),
      crawlVisa: o.crawlVisa ?? defaultCrawlVisa,
      crawlGuidance: o.crawlGuidance ?? defaultCrawlGuidance,
      getHead: o.getHead ?? defaultGetHead,
      getVersion: o.getVersion ?? defaultGetVersion,
      getPublishRun: o.getPublishRun ?? defaultGetPublishRun,
      addToAllowlist: o.addToAllowlist ?? addRouteToAllowlist,
      rejectDraft: o.rejectDraft ?? defaultRejectDraft,
      loadAlertConfig: o.loadAlertConfig ?? defaultLoadAlertConfig,
      raiseAlerts: o.raiseAlerts ?? defaultRaiseAlerts,
      appUrl: o.appUrl ?? (() => (process.env.APP_URL || "").replace(/\/+$/, "")),
    };
  }

  private now(): Timestamp {
    return Timestamp.fromMillis(this.d.clock());
  }

  private runRef(runId: string) {
    return collections.routeOnboardingRuns.doc(runId);
  }

  // ============================================
  // Registry facts
  // ============================================

  /**
   * The registered route: its visa page and its guidance sources, or null when it is not registered.
   *
   * Issue #232: `authorityId` is the route's issuing authority (a country code
   * or a bloc/treaty id). The visa page lives in `visaSources/{authorityId}`
   * and the guidance sources carry `jurisdiction == authorityId`, exactly as
   * route registration writes them. For a country this is the same lookup as
   * before (the code is the authority id).
   */
  private async findRegistered(authorityId: string, visaTypeId: string): Promise<RegisteredRoute | null> {
    const snap = await collections.visaSources.doc(authorityId).get();
    if (!snap.exists) return null;
    const source = snap.data() as VisaSource;
    // A country authority's id is its code; only then can page ids be derived from addresses.
    const idCheck = checkAuthorityId(authorityId);
    const isCountry = idCheck.ok && idCheck.shape === "country";
    const page = (source.pages ?? []).find((p) => {
      if (p.supplementOnly) return false;
      // Address-derived ids exist only for (seeded) country pages; a bloc's
      // or treaty's pages are portal-added with a pinned id.
      if (!isCountry) return p.visaId === visaTypeId;
      try {
        return deriveVisaId({ countryCode: authorityId, sourceUrl: p.url, visaId: p.visaId }) === visaTypeId;
      } catch {
        return p.visaId === visaTypeId;
      }
    });
    if (!page) return null;
    // Guidance sources of the route: same authority, same route name (the registration's convention).
    const prefix = `${authorityId.toLowerCase()}-`;
    const route = visaTypeId.startsWith(prefix) ? visaTypeId.slice(prefix.length) : visaTypeId;
    const all = await collections.guidanceSources.where("jurisdiction", "==", authorityId).get();
    const guidance = all.docs
      .map((d) => ({ id: d.id, data: d.data() as GuidanceSource }))
      .filter((g) => g.data.route === route && g.data.status !== "retired")
      .sort((a, b) => a.id.localeCompare(b.id));
    return { page, source, guidance };
  }

  // ============================================
  // Endpoints: start, confirm, cancel, read
  // ============================================

  /**
   * POST /admin/route-onboarding. Creates a run in `preparing`.
   *   503 SETTINGS_UNAVAILABLE / ONBOARDING_DISABLED, 404 ROUTE_NOT_REGISTERED,
   *   409 RUN_ACTIVE (with the active run's id), 429 DAILY_LIMIT_REACHED,
   *   422 SHARED_LAYER_NOT_READY (a route registered under a bloc or treaty).
   *
   * Issue #232: `authorityId` is the route's issuing authority. The run key
   * is the rulebook key `{authorityId}_{visaTypeId}` (buildRulebookKey): for a
   * country it is exactly the old `{countryCode}_{visaTypeId}`. A route
   * registered under a BLOC or TREATY is found, but no run is started for it
   * yet: the run's later steps file a country visa record and draft a country
   * rulebook, and the shared-layer versions of those steps are P4 of #228.
   * Refusing here (before any write or spend) is the safe reading.
   * The head doc, the active-run check, the daily count and the new run are one
   * transaction, so a double click opens ONE run: the second click finds it.
   */
  async start(authorityId: string, visaTypeId: string, uid: string): Promise<RouteOnboardingRun> {
    const loaded = await this.d.loadSettings();
    if (loaded.readError) throw new OnboardingError("SETTINGS_UNAVAILABLE", 503, "Settings could not be read, so no run was started. Try again shortly.");
    if (!loaded.settings.enabled) throw new OnboardingError("ONBOARDING_DISABLED", 503, "Route onboarding is switched off (appConfig/routeOnboardingSettings).");
    let routeKey: string;
    const idCheck = checkAuthorityId(authorityId);
    try {
      if (!idCheck.ok) throw new Error(idCheck.message);
      routeKey = buildRulebookKey(authorityId, visaTypeId);
    } catch {
      throw new OnboardingError("VALIDATION_ERROR", 400, "That is not a valid authority id and visa id.");
    }
    const registered = await this.findRegistered(authorityId, visaTypeId);
    if (!registered) {
      throw new OnboardingError("ROUTE_NOT_REGISTERED", 404, "That route is not registered. Register its visa page and rule pages first.");
    }
    if (idCheck.ok && idCheck.shape !== "country") {
      throw new OnboardingError(
        "SHARED_LAYER_NOT_READY",
        422,
        "This route belongs to a bloc or treaty. Its sources are registered, but drafting a shared rulebook is not available yet, so no run was started."
      );
    }
    // From here on the authority is a country: the run keeps its `countryCode` field.
    const countryCode = authorityId;
    const nowMs = this.d.clock();
    const now = Timestamp.fromMillis(nowMs);
    const dayStart = Timestamp.fromMillis(Math.floor(nowMs / 86_400_000) * 86_400_000);
    const headRef = collections.routeOnboardingRoutes.doc(routeKey);
    const created = await this.d.runTransaction(async (tx) => {
      const headSnap = await tx.get(headRef);
      const head = headSnap.exists ? (headSnap.data() as RouteOnboardingHead) : null;
      if (head?.activeRunId) {
        const activeSnap = await tx.get(this.runRef(head.activeRunId));
        const active = activeSnap.exists ? (activeSnap.data() as RouteOnboardingRun) : null;
        if (active && !isTerminalRun(active.status)) {
          throw new OnboardingError("RUN_ACTIVE", 409, "A run for this route is already in progress.", { activeRunId: active.runId });
        }
      }
      const today = await tx.get(collections.routeOnboardingRuns.where("createdAt", ">=", dayStart));
      if (today.size >= loaded.settings.maxRunsPerDay) {
        throw new OnboardingError("DAILY_LIMIT_REACHED", 429, `${today.size} onboarding runs were already started today; the limit is ${loaded.settings.maxRunsPerDay}. Try again tomorrow, or raise maxRunsPerDay.`);
      }
      const seq = (head?.lastSeq ?? 0) + 1;
      const runId = `${routeKey}__r${seq}`;
      const run = this.newRun(runId, routeKey, countryCode, visaTypeId, uid, now);
      tx.create(this.runRef(runId), run as unknown as Record<string, unknown>);
      const nextHead: RouteOnboardingHead = { routeKey, lastSeq: seq, activeRunId: runId, updatedAt: now };
      tx.set(headRef, nextHead as unknown as Record<string, unknown>);
      appendRegistryAudit(tx, { action: "onboarding_started", actorUid: uid, at: now, targetType: "onboardingRun", targetId: runId, before: null, after: { routeKey, countryCode, visaTypeId } });
      return run;
    });
    console.log(`${TAG} ${created.runId}: started`);
    return created;
  }

  /** A blank run. */
  private newRun(runId: string, routeKey: string, countryCode: string, visaTypeId: string, uid: string, now: Timestamp): RouteOnboardingRun {
    return {
      runId, routeKey, countryCode, visaTypeId,
      status: "preparing",
      summary: STATUS_PLAIN.preparing,
      steps: initialSteps(),
      pinned: { guidanceCrawled: [] },
      estimate: null,
      confirmation: null,
      voidedConfirmations: [],
      allowlist: "not_requested",
      counters: { chunksTotal: 0, chunksDone: 0, calls: 0, inputTokens: 0, outputTokens: 0, costUsd: null },
      holdReason: null,
      links: { visaTypeId: null, visaSourceUrl: null, guidanceSourceIds: [], snapshotIds: [], jobId: null, rulebookVersion: null, publishRunId: null },
      unchanged: false,
      createdBy: uid,
      cancelRequested: false,
      cancelRequestedBy: null,
      leaseOwner: null,
      leaseUntil: null,
      kick: 0,
      nextAttemptAt: null,
      attempts: { stepKey: "", count: 0 },
      alertPending: false,
      createdAt: now,
      updatedAt: now,
      finishedAt: null,
      handedToSafeguardsAt: null,
    };
  }

  /**
   * POST /admin/route-onboarding/:id/confirm. Only from `awaiting_confirmation`,
   * only with the STORED estimate id and `statementAccepted: true`. Records who,
   * when and the number; writes the audit entry; wakes the worker, which starts
   * the drafting job. Confirming again with the same id is a harmless repeat
   * (200, `alreadyConfirmed`); anything else is 409.
   */
  async confirm(runId: string, input: { estimateId: string; addToAllowlist: boolean }, uid: string): Promise<{ run: RouteOnboardingRun; alreadyConfirmed: boolean }> {
    const loaded = await this.d.loadSettings();
    if (loaded.readError) throw new OnboardingError("SETTINGS_UNAVAILABLE", 503, "Settings could not be read, so nothing was started. Try again shortly.");
    if (!loaded.settings.enabled) throw new OnboardingError("ONBOARDING_DISABLED", 503, "Route onboarding is switched off (appConfig/routeOnboardingSettings).");
    const now = this.now();
    const result = await this.d.runTransaction(async (tx) => {
      const snap = await tx.get(this.runRef(runId));
      if (!snap.exists) throw new OnboardingError("NOT_FOUND", 404, "No such onboarding run.");
      const run = snap.data() as RouteOnboardingRun;
      if (run.status !== "awaiting_confirmation") {
        // The same confirmation again (a double click): nothing is written, one job only.
        if (run.confirmation && run.confirmation.estimateId === input.estimateId && !isTerminalRun(run.status)) return { run, alreadyConfirmed: true };
        throw new OnboardingError("NOT_AWAITING_CONFIRMATION", 409, `This run is not waiting for a confirmation (it is ${run.status}).`);
      }
      if (run.cancelRequested) throw new OnboardingError("NOT_AWAITING_CONFIRMATION", 409, "This run is being cancelled.");
      if (!run.estimate || run.estimate.estimateId !== input.estimateId) {
        throw new OnboardingError("ESTIMATE_MISMATCH", 409, "That is not the estimate stored for this run. Reload it and confirm the number you see.", { currentEstimateId: run.estimate?.estimateId ?? null });
      }
      const confirmation: Confirmation = { by: uid, at: now, estimateId: input.estimateId, maxRequests: run.estimate.extractionCallsAtMost, statementAccepted: true, addToAllowlist: input.addToAllowlist };
      const next: RouteOnboardingRun = {
        ...run,
        status: "running",
        summary: `Confirmed. Drafting the rulebook (up to ${run.estimate.extractionCallsAtMost} model calls).`,
        confirmation,
        allowlist: input.addToAllowlist ? "pending" : "not_requested",
        steps: withStep(withStep(run.steps, "confirm", { status: "done", detail: "Confirmed by an admin." }, now), "draft", { status: "running", detail: "Starting the draft." }, now),
        kick: run.kick + 1,
        updatedAt: now,
      };
      tx.set(this.runRef(runId), next as unknown as Record<string, unknown>);
      appendRegistryAudit(tx, {
        action: "onboarding_confirmed", actorUid: uid, at: now, targetType: "onboardingRun", targetId: runId,
        before: { status: run.status },
        after: { estimateId: input.estimateId, maxRequests: confirmation.maxRequests, addToAllowlist: input.addToAllowlist },
        statement: run.estimate.statement,
      });
      return { run: next, alreadyConfirmed: false };
    });
    return result;
  }

  /**
   * POST /admin/route-onboarding/:id/cancel. A run nobody is working on ends
   * `cancelled` at once; a run with a live worker gets the flag, which the
   * worker obeys before its next action. The drafting job is cancelled, and a
   * draft that was written but not decided is rejected, so nothing new is
   * published. Counters already spent are kept. A final run is 409.
   */
  async cancel(runId: string, uid: string): Promise<RouteOnboardingRun> {
    const now = this.now();
    const nowMs = now.toMillis();
    const run = await this.d.runTransaction(async (tx) => {
      const snap = await tx.get(this.runRef(runId));
      if (!snap.exists) throw new OnboardingError("NOT_FOUND", 404, "No such onboarding run.");
      const cur = snap.data() as RouteOnboardingRun;
      if (isTerminalRun(cur.status)) throw new OnboardingError("RUN_FINISHED", 409, `This run has already ended (${cur.status}).`);
      const leased = cur.leaseUntil !== null && ms(cur.leaseUntil) > nowMs;
      appendRegistryAudit(tx, { action: "onboarding_cancelled", actorUid: uid, at: now, targetType: "onboardingRun", targetId: runId, before: { status: cur.status }, after: { immediate: !leased } });
      if (leased) {
        const flagged: RouteOnboardingRun = { ...cur, cancelRequested: true, cancelRequestedBy: uid, updatedAt: now };
        tx.update(this.runRef(runId), { cancelRequested: true, cancelRequestedBy: uid, updatedAt: now });
        return flagged;
      }
      const done = this.asCancelled({ ...cur, cancelRequested: true, cancelRequestedBy: uid }, now);
      tx.set(this.runRef(runId), done as unknown as Record<string, unknown>);
      return done;
    });
    await this.afterCancel(run, uid);
    return run;
  }

  /** The follow-ups of a cancel that do not belong in the transaction: the job, and an undecided draft. Never throws. */
  private async afterCancel(run: RouteOnboardingRun, uid: string): Promise<void> {
    try {
      if (run.links.jobId) await this.d.jobs().cancel(run.links.jobId, uid);
    } catch (err) {
      console.error(`${TAG} ${run.runId}: cancelling the drafting job failed (${errClass(err)})`);
    }
    // Only when the run ended cancelled with a written draft: reject it if nobody decided it.
    if (run.status === "cancelled" && run.links.rulebookVersion !== null) {
      try {
        await this.d.rejectDraft(run.routeKey, run.links.rulebookVersion, uid);
      } catch (err) {
        console.error(`${TAG} ${run.runId}: rejecting the undecided draft failed (${errClass(err)})`);
      }
    }
  }

  /** A run ended cancelled: open steps are marked cancelled, counters stay. */
  private asCancelled(run: RouteOnboardingRun, now: Timestamp): RouteOnboardingRun {
    const steps = run.steps.map((s) => (s.status === "done" || s.status === "skipped" || s.status === "failed" ? s : { ...s, status: "cancelled" as const, startedAt: s.startedAt, finishedAt: now, detail: s.status === "pending" ? "Not started: the run was cancelled." : s.detail }));
    return {
      ...run,
      status: "cancelled",
      summary: run.links.rulebookVersion !== null
        ? "The run was cancelled. The draft that was already written is rejected if nobody had decided it; nothing new is published."
        : "The run was cancelled. What was already spent is kept; nothing is published.",
      steps,
      holdReason: null,
      leaseOwner: null,
      leaseUntil: null,
      nextAttemptAt: null,
      alertPending: false,
      updatedAt: now,
      finishedAt: now,
    };
  }

  /** GET /admin/route-onboarding/:id: the run with live progress and the end checklist. */
  async get(runId: string): Promise<{ run: RouteOnboardingRun; checklist: ChecklistItem[] } | null> {
    const snap = await this.runRef(runId).get();
    if (!snap.exists) return null;
    let run = snap.data() as RouteOnboardingRun;
    // Live progress of the drafting job (the stored mirror lags by one poll).
    if (!isTerminalRun(run.status) && run.links.jobId) {
      try {
        const job = await this.d.jobs().getStatus(run.links.jobId);
        if (job) run = { ...run, counters: countersOf(job, run.counters) };
      } catch {
        // The stored mirror is shown.
      }
    }
    return { run, checklist: await this.checklistOf(run) };
  }

  /** GET /admin/route-onboarding: newest first. */
  async list(opts: { status?: RunStatus; limit: number }): Promise<RouteOnboardingRun[]> {
    let q = collections.routeOnboardingRuns.orderBy("createdAt", "desc");
    if (opts.status) q = collections.routeOnboardingRuns.where("status", "==", opts.status).orderBy("createdAt", "desc");
    const snap = await q.limit(opts.limit).get();
    return snap.docs.map((d) => d.data() as RouteOnboardingRun);
  }

  /** The end checklist, read from the live documents so it is "pending until true". Never throws. */
  async checklistOf(run: RouteOnboardingRun): Promise<ChecklistItem[]> {
    let visaActive = false;
    let visaExists = false;
    let countrySupported = false;
    try {
      const visa = await subcollections.visaTypes(run.countryCode).doc(run.visaTypeId).get();
      visaExists = visa.exists;
      visaActive = visa.exists && (visa.data() as { isActive?: boolean }).isActive === true;
      const country = await collections.countries.doc(run.countryCode).get();
      countrySupported = country.exists && (country.data() as { isSupported?: boolean }).isSupported === true;
    } catch {
      // Shown as pending: the safe reading.
    }
    return [
      {
        id: "approve_visa_record",
        plain: visaExists ? "Approve the visa record in Visa Review (fees and processing times are shown there)." : "The visa record has not been created yet.",
        visaTypeId: run.visaTypeId,
        done: visaActive,
      },
      {
        id: "make_country_visible",
        plain: "Make the country visible to applicants on the Countries screen (isSupported is off until you do).",
        countryCode: run.countryCode,
        done: countrySupported,
      },
    ];
  }

  // ============================================
  // The worker
  // ============================================

  /**
   * Advance one run by ONE action. Safe to call any time, any number of times,
   * concurrently (see the file header). Never throws for an expected problem.
   */
  async advance(runId: string): Promise<AdvanceOutcome> {
    const owner = this.d.newOwnerId();
    const claim = await this.claim(runId, owner);
    if (claim.kind === "stop") return claim.outcome;
    const run = claim.run;
    try {
      const change = await this.decide(run);
      const done = await this.commit(runId, owner, change);
      if (isTerminalRun(done.status)) await this.afterTerminal(done);
      return isTerminalRun(done.status) ? { kind: "finished", status: done.status } : { kind: "advanced", status: done.status, wake: change.wake === true };
    } catch (err) {
      if (err instanceof LeaseLost) return { kind: "lease_lost" };
      // Something unexpected (a storage read, a database error): count it, and
      // fail the run after repeated tries so it cannot loop forever.
      console.error(`${TAG} ${runId}: unexpected error in the worker (${errClass(err)})`);
      return this.recordUnexpected(runId, owner, run);
    }
  }

  /** Take the lease in a transaction. Cancellation is applied here, before any action. */
  private async claim(runId: string, owner: string): Promise<{ kind: "claimed"; run: RouteOnboardingRun } | { kind: "stop"; outcome: AdvanceOutcome }> {
    let cancelled: RouteOnboardingRun | null = null;
    const claim = await this.d.runTransaction(async (tx) => {
      const snap = await tx.get(this.runRef(runId));
      if (!snap.exists) return { kind: "stop" as const, outcome: { kind: "idle", status: null } as AdvanceOutcome };
      const run = snap.data() as RouteOnboardingRun;
      if (isTerminalRun(run.status) || run.status === "awaiting_confirmation") return { kind: "stop" as const, outcome: { kind: "idle", status: run.status } as AdvanceOutcome };
      const nowMs = this.d.clock();
      if (run.leaseOwner && run.leaseOwner !== owner && ms(run.leaseUntil) > nowMs) return { kind: "stop" as const, outcome: { kind: "lease_held" } as AdvanceOutcome };
      const now = Timestamp.fromMillis(nowMs);
      if (run.cancelRequested) {
        const done = this.asCancelled(run, now);
        tx.set(this.runRef(runId), done as unknown as Record<string, unknown>);
        cancelled = done;
        return { kind: "stop" as const, outcome: { kind: "finished", status: "cancelled" } as AdvanceOutcome };
      }
      const claimed: RouteOnboardingRun = { ...run, leaseOwner: owner, leaseUntil: Timestamp.fromMillis(nowMs + this.d.timing.leaseMs), updatedAt: now };
      tx.set(this.runRef(runId), claimed as unknown as Record<string, unknown>);
      return { kind: "claimed" as const, run: claimed };
    });
    if (cancelled) await this.afterCancel(cancelled, (cancelled as RouteOnboardingRun).cancelRequestedBy ?? "system");
    return claim;
  }

  /**
   * Write one action's result, only if `owner` still holds the lease, and
   * release the lease. A cancel requested meanwhile ends the run cancelled
   * AFTER this action's result is recorded (spent counters are kept). A final
   * status gets its end fields; `failed` and `held` raise the alert flag.
   */
  private async commit(runId: string, owner: string, change: Change): Promise<RouteOnboardingRun> {
    const now = this.now();
    return this.d.runTransaction(async (tx) => {
      const snap = await tx.get(this.runRef(runId));
      const run = snap.exists ? (snap.data() as RouteOnboardingRun) : null;
      if (!run || isTerminalRun(run.status) || run.leaseOwner !== owner) throw new LeaseLost();
      let next: RouteOnboardingRun = {
        ...run,
        ...(change.status !== undefined ? { status: change.status } : {}),
        ...(change.summary !== undefined ? { summary: change.summary } : {}),
        ...(change.steps !== undefined ? { steps: change.steps } : {}),
        ...(change.pinned !== undefined ? { pinned: change.pinned } : {}),
        ...(change.estimate !== undefined ? { estimate: change.estimate } : {}),
        ...(change.confirmation !== undefined ? { confirmation: change.confirmation } : {}),
        ...(change.voidedConfirmations !== undefined ? { voidedConfirmations: change.voidedConfirmations } : {}),
        ...(change.allowlist !== undefined ? { allowlist: change.allowlist } : {}),
        ...(change.counters !== undefined ? { counters: change.counters } : {}),
        ...(change.holdReason !== undefined ? { holdReason: change.holdReason } : {}),
        ...(change.links !== undefined ? { links: change.links } : {}),
        ...(change.unchanged !== undefined ? { unchanged: change.unchanged } : {}),
        ...(change.nextAttemptAt !== undefined ? { nextAttemptAt: change.nextAttemptAt } : {}),
        ...(change.attempts !== undefined ? { attempts: change.attempts } : {}),
        ...(change.handedToSafeguardsAt !== undefined ? { handedToSafeguardsAt: change.handedToSafeguardsAt } : {}),
        leaseOwner: null,
        leaseUntil: null,
        updatedAt: now,
      };
      if (!isTerminalRun(next.status) && run.cancelRequested) {
        next = this.asCancelled({ ...next, cancelRequested: true, cancelRequestedBy: run.cancelRequestedBy }, now);
      } else if (isTerminalRun(next.status)) {
        next = { ...next, finishedAt: now, nextAttemptAt: null, alertPending: next.status === "failed" || next.status === "held" };
      } else if (change.wake) {
        next = { ...next, kick: run.kick + 1 };
      }
      tx.set(this.runRef(runId), next as unknown as Record<string, unknown>);
      return next;
    });
  }

  /** What follows a final status: a cancelled run cancels its job; a failed or held one raises its alert. Never throws. */
  private async afterTerminal(run: RouteOnboardingRun): Promise<void> {
    if (run.status === "cancelled") {
      await this.afterCancel(run, run.cancelRequestedBy ?? "system");
      return;
    }
    if (run.alertPending) await this.raiseAlertFor(run);
  }

  /** Raise (and then clear the flag of) a failed or held run's alert. Deduplicated by the run id. */
  private async raiseAlertFor(run: RouteOnboardingRun): Promise<void> {
    if (run.status !== "failed" && run.status !== "held") return;
    try {
      const config = await this.d.loadAlertConfig();
      await this.d.raiseAlerts([evaluateRouteOnboardingAttention({ runId: run.runId, routeKey: run.routeKey, status: run.status, summary: run.summary, link: `${this.d.appUrl()}/admin/route-onboarding/${run.runId}` }, config)], config);
      await this.d.runTransaction(async (tx) => {
        const snap = await tx.get(this.runRef(run.runId));
        if (snap.exists && (snap.data() as RouteOnboardingRun).alertPending) tx.update(this.runRef(run.runId), { alertPending: false });
      });
    } catch (err) {
      // The flag stays set: the sweep raises it again (the key makes that harmless).
      console.error(`${TAG} ${run.runId}: raising the alert failed (${errClass(err)})`);
    }
  }

  /** An unexpected error: count it against the action, and fail the run after the limit. */
  private async recordUnexpected(runId: string, owner: string, run: RouteOnboardingRun): Promise<AdvanceOutcome> {
    const step = currentStep(run.steps);
    const key = `${run.status}:${step?.id ?? "none"}:error`;
    const count = (run.attempts.stepKey === key ? run.attempts.count : 0) + 1;
    try {
      const change: Change = count >= 3
        ? this.failChange(run, "The run stopped because of an unexpected problem that kept happening. Nothing further was started.")
        : { attempts: { stepKey: key, count }, nextAttemptAt: Timestamp.fromMillis(this.d.clock() + this.d.timing.crawlRetryMs) };
      const done = await this.commit(runId, owner, change);
      if (isTerminalRun(done.status)) await this.afterTerminal(done);
      return isTerminalRun(done.status) ? { kind: "finished", status: done.status } : { kind: "advanced", status: done.status, wake: false };
    } catch (err) {
      if (err instanceof LeaseLost) return { kind: "lease_lost" };
      throw err;
    }
  }

  // ---------- Deciding the next action ----------

  /** Pick and run the one action the run needs next; returns its result as a change. */
  private async decide(run: RouteOnboardingRun): Promise<Change> {
    if (run.status === "waiting_for_publish") return this.actSafeguards(run);
    if (run.status === "running") return this.actDraft(run);
    const step = currentStep(run.steps);
    switch (step?.id) {
    case "check_setup": return this.actCheckSetup(run);
    case "read_visa_page": return this.actVisaPage(run);
    case "read_rule_pages": return this.actRulePage(run);
    case "plan": return this.actPlan(run);
    default:
      // Nothing left to prepare (should not happen): wait for a person.
      return { status: "awaiting_confirmation" };
    }
  }

  /** A change that ends the run `failed`, with the step it stopped on marked failed. */
  private failChange(run: RouteOnboardingRun, plain: string): Change {
    const now = this.now();
    const step = currentStep(run.steps);
    return {
      status: "failed",
      summary: plain,
      steps: step ? withStep(run.steps, step.id, { status: "failed", detail: plain }, now) : run.steps,
    };
  }

  /** A change that ends the run `too_thin`. */
  private thinChange(run: RouteOnboardingRun, plain: string, code: string): Change {
    const now = this.now();
    const step = currentStep(run.steps);
    return {
      status: "too_thin",
      summary: plain,
      holdReason: { code, plain, retryScheduled: false, codes: [code] },
      steps: step ? withStep(run.steps, step.id, { status: "done", detail: plain }, now) : run.steps,
    };
  }

  /**
   * A crawl that could not run yet: the step shows `waiting` with the reason,
   * the run is looked at again after `crawlRetryMs`. After `maxWaits` waits in a
   * row the run fails ("still busy") instead of waiting forever.
   */
  private waitChange(run: RouteOnboardingRun, step: StepId, key: string, plain: string): Change {
    const now = this.now();
    const count = (run.attempts.stepKey === key ? run.attempts.count : 0) + 1;
    if (count > this.d.timing.maxWaits) return this.failChange(run, `${plain} It stayed that way for too long, so the run stopped. Start a new run when it is free.`);
    return {
      steps: withStep(run.steps, step, { status: "waiting", detail: `Waiting: ${plain}` }, now),
      attempts: { stepKey: key, count },
      nextAttemptAt: Timestamp.fromMillis(now.toMillis() + this.d.timing.crawlRetryMs),
    };
  }

  // ---------- Step 1: check_setup ----------

  private async actCheckSetup(run: RouteOnboardingRun): Promise<Change> {
    const now = this.now();
    const loaded = await this.d.loadSettings();
    if (loaded.readError) return this.failChange(run, "Settings could not be read, so the run stopped before reading anything.");
    if (!loaded.settings.enabled) return this.failChange(run, "Route onboarding was switched off, so the run stopped before reading anything.");
    const reg = await this.findRegistered(run.countryCode, run.visaTypeId);
    if (!reg) return this.failChange(run, "The route is no longer registered, so the run stopped.");
    const country = await collections.countries.doc(run.countryCode).get();
    if (!country.exists) return this.failChange(run, "The country record does not exist, so the visa page cannot be filed. Register the route again.");
    // The visa source and every rule page must be allowed to be read now.
    if (reg.source.status === "retired" || reg.source.status === "paused") return this.failChange(run, `The visa page's source is ${reg.source.status}. Resume it, then start a new run.`);
    if (reg.guidance.length === 0) return this.failChange(run, "No rule pages are registered for this route. Register at least one, then start a new run.");
    if (!reg.guidance.some((g) => g.data.role === "primary")) return this.failChange(run, "None of the route's rule pages is marked as the route's own rules (primary). Mark one, then start a new run.");
    for (const g of reg.guidance) {
      if (g.data.status === "paused") return this.failChange(run, `The rule page "${g.data.title}" is paused. Resume it, then start a new run. Nothing was extracted.`);
      if (!["verified", "partial", "registered"].includes(String(g.data.verificationStatus))) return this.failChange(run, `The rule page "${g.data.title}" is not verified for reading. Nothing was extracted.`);
    }
    return {
      steps: withStep(withStep(run.steps, "check_setup", { status: "done", detail: `${reg.guidance.length} rule page${reg.guidance.length === 1 ? "" : "s"} and the visa page are registered and ready.` }, now), "read_visa_page", { status: "running", detail: "" }, now),
      links: { ...run.links, visaSourceUrl: reg.page.url, guidanceSourceIds: reg.guidance.map((g) => g.id) },
      wake: true,
    };
  }

  // ---------- Step 2: read_visa_page ----------

  private async actVisaPage(run: RouteOnboardingRun): Promise<Change> {
    const now = this.now();
    const visaRef = subcollections.visaTypes(run.countryCode).doc(run.visaTypeId);
    const reg = await this.findRegistered(run.countryCode, run.visaTypeId);
    if (!reg) return this.failChange(run, "The route is no longer registered, so the run stopped.");
    const done = (detail: string): Change => ({
      steps: withStep(withStep(run.steps, "read_visa_page", { status: "done", detail }, now), "read_rule_pages", { status: "running", detail: "" }, now),
      links: { ...run.links, visaTypeId: run.visaTypeId },
      attempts: { stepKey: "", count: 0 },
      nextAttemptAt: null,
      wake: true,
    });
    // A record from THIS page already exists: nothing to read (no crawl, so no model call on a repeat).
    const exists = async (): Promise<boolean> => {
      const snap = await visaRef.get();
      return snap.exists && (snap.data() as { scrapeMeta?: { sourceUrl?: string } }).scrapeMeta?.sourceUrl === reg.page.url;
    };
    if (await exists()) return done("The visa record already exists; the weekly visa crawl keeps it up to date. It waits for approval in Visa Review.");
    // `force` only when the page was read before but left no record: otherwise the
    // content gate reads this new page and leaves the country's other pages alone.
    const facts = await this.d.crawlVisa(run.countryCode, Boolean(reg.page.lastContentHash));
    if (await exists()) return done("The visa page was read. The visa record was created and waits for approval in Visa Review; it stays hidden from applicants.");
    if (facts.sourcesLeased > 0) return this.waitChange(run, "read_visa_page", "visa", "another crawl of this country is running.");
    if (facts.budgetHardStop || facts.extractionsSkippedBudget > 0) {
      return this.failChange(run, "The monthly budget for reading visa pages is spent, so the visa page was not read. Nothing was extracted.");
    }
    const fresh = await this.findRegistered(run.countryCode, run.visaTypeId);
    const err = fresh?.page.lastError;
    if (err) return this.failChange(run, `The visa page could not be read: ${clip(err, 300)} Nothing was extracted.`);
    return this.failChange(run, "The visa page was read but produced no visa record (the page may not describe a visa route). Nothing was extracted.");
  }

  // ---------- Step 3: read_rule_pages ----------

  private async actRulePage(run: RouteOnboardingRun): Promise<Change> {
    const now = this.now();
    const crawled = new Set(run.pinned.guidanceCrawled.map((c) => c.sourceId));
    const todo = run.links.guidanceSourceIds.filter((id) => !crawled.has(id));
    const finish = async (guidanceCrawled: RouteOnboardingRun["pinned"]["guidanceCrawled"]): Promise<Change> => {
      // All pages read: pin the snapshots the plan will be made from.
      const snapshotIds: string[] = [];
      for (const id of run.links.guidanceSourceIds) {
        const snap = await collections.guidanceSources.doc(id).get();
        const latest = snap.exists ? (snap.data() as GuidanceSource).latestSnapshotId : null;
        if (!latest) return this.failChange(run, `The rule page "${id}" has no stored text, so nothing can be drafted from it.`);
        snapshotIds.push(latest);
      }
      return {
        pinned: { guidanceCrawled },
        steps: withStep(withStep(run.steps, "read_rule_pages", { status: "done", detail: `${guidanceCrawled.length} rule page${guidanceCrawled.length === 1 ? "" : "s"} read.` }, now), "plan", { status: "running", detail: "" }, now),
        links: { ...run.links, snapshotIds },
        attempts: { stepKey: "", count: 0 },
        nextAttemptAt: null,
        wake: true,
      };
    };
    if (todo.length === 0) return finish(run.pinned.guidanceCrawled);
    const id = todo[0];
    const docSnap = await collections.guidanceSources.doc(id).get();
    const title = docSnap.exists ? (docSnap.data() as GuidanceSource).title : id;
    const summary = await this.d.crawlGuidance(id);
    const line = summary.results.find((r) => r.sourceId === id);
    const key = `pages:${id}`;
    if (!line) return this.failChange(run, `The rule page "${title}" is not in the registry any more. Nothing was extracted.`);
    switch (line.outcome) {
    case "changed":
    case "unchanged": {
      const guidanceCrawled = [...run.pinned.guidanceCrawled, { sourceId: id, outcome: line.outcome, contentHashPrefix: line.contentHash ? line.contentHash.slice(0, 12) : null }];
      if (guidanceCrawled.length < run.links.guidanceSourceIds.length) {
        return {
          pinned: { guidanceCrawled },
          steps: withStep(run.steps, "read_rule_pages", { status: "running", detail: `${guidanceCrawled.length} of ${run.links.guidanceSourceIds.length} rule pages read.` }, now),
          attempts: { stepKey: "", count: 0 },
          wake: true,
        };
      }
      return finish(guidanceCrawled);
    }
    case "failed":
      return this.failChange(run, `The rule page "${title}" could not be read: ${crawlFailureWords(line.errorKind)}. Nothing was extracted.`);
    case "skipped_inactive":
    case "skipped_unverified":
      return this.failChange(run, `The rule page "${title}" is paused or not verified for reading. Nothing was extracted.`);
    default:
      // deferred (the host asked us to slow down), lease_held, infra_error, skipped_infra_backoff, not_due.
      return this.waitChange(run, "read_rule_pages", key, `the rule page "${title}" cannot be read just yet (${line.outcome.replace(/_/g, " ")}).`);
    }
  }

  // ---------- Step 4: plan ----------

  /** The drafting job's DRY plan, as a result the run can use (no model call is made here). */
  private async dryPlan(run: RouteOnboardingRun): Promise<StartJobResult> {
    return this.d.jobs().startJob({
      countryCode: run.countryCode,
      visaTypeId: run.visaTypeId,
      sourceIds: run.links.guidanceSourceIds,
      dryRun: true,
      trigger: "manual",
      requestedBy: run.createdBy,
    });
  }

  /** Registry facts of each source, for the estimate's page table. */
  private async sourceFacts(ids: readonly string[]): Promise<Map<string, { title: string; host: string; role: string; language?: string }>> {
    const out = new Map<string, { title: string; host: string; role: string; language?: string }>();
    for (const id of ids) {
      const snap = await collections.guidanceSources.doc(id).get();
      if (!snap.exists) continue;
      const g = snap.data() as GuidanceSource;
      out.set(id, { title: g.title, host: hostOf(g.url), role: g.role ?? "secondary", ...(g.language ? { language: g.language } : {}) });
    }
    return out;
  }

  /**
   * Turn a job's refusal into a final change (shared by the plan and the start).
   * "Too little text" is a clear outcome, not an error.
   */
  private refusalChange(run: RouteOnboardingRun, r: StartJobResult): Change {
    const code = r.reasonCode ?? "unknown";
    if (code === "no_text" || code === "no_sources") return this.thinChange(run, THIN_PLAIN, code);
    if (code === "run_cap_exceeded") return this.failChange(run, jobCapMessage(r.message));
    const words = JOB_FAILURE_WORDS[code] ?? `The plan could not be made (${r.message ?? code}).`;
    return this.failChange(run, words);
  }

  /** The rulebook already has these sources: nothing to draft, hand the newest version to the safeguards watch. */
  private async unchangedChange(run: RouteOnboardingRun): Promise<Change> {
    const now = this.now();
    const head = await this.d.getHead(run.routeKey);
    if (!head) return this.failChange(run, "The sources look unchanged but the route has no rulebook, so the run stopped.");
    const detail = "The pages are the ones the newest rulebook was drafted from, so nothing was drafted and no model call was made.";
    // Every step before the safeguards is finished or not needed.
    let steps = run.steps;
    for (const s of run.steps) {
      if (s.id === "safeguards" || s.status === "done" || s.status === "skipped") continue;
      steps = withStep(steps, s.id, s.id === "plan" ? { status: "done", detail } : { status: "skipped", detail: "Not needed: nothing changed." }, now);
    }
    steps = withStep(steps, "safeguards", { status: "running", detail: "Reading what the safeguards decided for the newest rulebook." }, now);
    return {
      status: "waiting_for_publish",
      summary: "Nothing changed since the last rulebook was drafted, so no model call was made. Reading the state of that rulebook.",
      unchanged: true,
      steps,
      links: { ...run.links, rulebookVersion: head.latestVersion },
      handedToSafeguardsAt: now,
      wake: true,
    };
  }

  private async actPlan(run: RouteOnboardingRun): Promise<Change> {
    const now = this.now();
    const r = await this.dryPlan(run);
    if (r.outcome === "unchanged") return this.unchangedChange(run);
    if (r.outcome === "refused") return this.refusalChange(run, r);
    if (r.outcome !== "dry_run" || !r.estimate) return this.failChange(run, "The plan could not be made. Nothing was spent.");
    const est = await this.buildEstimateFor(run, r);
    if (est.refusal) return this.failChange(run, est.refusal);
    return {
      status: "awaiting_confirmation",
      summary: `Ready for your confirmation: ${est.estimate.plain}`,
      estimate: est.estimate,
      counters: { ...run.counters, chunksTotal: est.estimate.chunks },
      steps: withStep(withStep(run.steps, "plan", { status: "done", detail: `${est.estimate.chunks} text part${est.estimate.chunks === 1 ? "" : "s"} from ${est.estimate.sourceCount} page${est.estimate.sourceCount === 1 ? "" : "s"}.` }, now), "confirm", { status: "waiting", detail: "Waiting for you to confirm the estimate. Nothing has been spent yet." }, now),
      attempts: { stepKey: "", count: 0 },
      nextAttemptAt: null,
    };
  }

  /** The estimate of a dry plan, with the cap check (the refusal names the cap). */
  private async buildEstimateFor(run: RouteOnboardingRun, r: StartJobResult): Promise<{ estimate: NonNullable<RouteOnboardingRun["estimate"]>; refusal: string | null }> {
    const [extraction, publish, onboarding, facts] = await Promise.all([
      this.d.loadExtractionSettings(),
      this.d.loadPublishSettings(),
      this.d.loadSettings(),
      this.sourceFacts(r.plan.map((p) => p.sourceId)),
    ]);
    const estimate = buildEstimate({
      runId: run.runId,
      routeKey: run.routeKey,
      plan: r.plan,
      sourceFacts: facts,
      extraction: extraction.settings,
      checkerMaxRequestsPerRun: publish.settings.checkerMaxRequestsPerRun,
      onboarding: onboarding.settings,
      publishState: publishStateOf(publish, run.routeKey),
      now: this.now(),
    });
    return { estimate, refusal: capRefusal(estimate, extraction.settings, onboarding.settings) };
  }

  // ---------- Step 6: draft ----------

  private async actDraft(run: RouteOnboardingRun): Promise<Change> {
    const now = this.now();
    const confirmation = run.confirmation;
    if (!run.links.jobId) {
      if (!confirmation || !run.estimate) return this.failChange(run, "The run was started without a confirmation, so nothing was drafted.");
      // The kill switch holds until the job exists: nothing is spent after an admin switched it off.
      const loaded = await this.d.loadSettings();
      if (loaded.readError || !loaded.settings.enabled) return this.failChange(run, "Route onboarding was switched off before the draft started. Nothing was spent.");

      // ---- action 1: re-check the plan against the number that was confirmed ----
      if (!confirmation.recheckedAt) {
        const r = await this.dryPlan(run);
        if (r.outcome === "unchanged") return this.unchangedChange(run);
        if (r.outcome === "refused") return this.refusalChange(run, r);
        if (r.outcome !== "dry_run") return this.failChange(run, "The plan could not be re-checked. Nothing was spent.");
        const fresh = await this.buildEstimateFor(run, r);
        if (fresh.refusal) return this.failChange(run, fresh.refusal);
        const stale = fresh.estimate.planHash !== run.estimate.planHash || fresh.estimate.extractionCallsAtMost > confirmation.maxRequests;
        if (stale) {
          // Void the confirmation and ask again with the new number.
          return {
            status: "awaiting_confirmation",
            summary: `The pages changed after you confirmed, so nothing was started. Please confirm the new estimate: ${fresh.estimate.plain}`,
            estimate: fresh.estimate,
            confirmation: null,
            voidedConfirmations: [...run.voidedConfirmations, confirmation],
            allowlist: "not_requested",
            counters: { ...run.counters, chunksTotal: fresh.estimate.chunks },
            steps: withStep(withStep(run.steps, "draft", { status: "pending", detail: "" }, now), "confirm", { status: "waiting", detail: "The pages changed after you confirmed. Confirm the new estimate to continue." }, now),
          };
        }
        return { confirmation: { ...confirmation, recheckedAt: now }, wake: true };
      }

      // ---- action 2: the audited allow-list patch, only when it was asked for ----
      if (run.allowlist === "pending") {
        const res = await this.d.addToAllowlist(run.routeKey, confirmation.by);
        if (res === "added") await this.auditAllowlist(run, confirmation.by);
        return { allowlist: res, wake: true };
      }

      // ---- action 3: start the drafting job (deterministic id: a repeat is `existing`) ----
      const started = await this.d.jobs().startJob({
        countryCode: run.countryCode,
        visaTypeId: run.visaTypeId,
        sourceIds: run.links.guidanceSourceIds,
        trigger: "manual",
        requestedBy: confirmation.by,
      });
      if (started.outcome === "unchanged") return this.unchangedChange(run);
      if (started.outcome === "refused" || !started.jobId) return this.refusalChange(run, started);
      return {
        links: { ...run.links, jobId: started.jobId },
        steps: withStep(run.steps, "draft", { status: "running", detail: `Drafting started (${started.estimate?.chunks ?? run.estimate.chunks} text parts).` }, now),
        nextAttemptAt: Timestamp.fromMillis(now.toMillis() + this.d.timing.pollMs),
        wake: true,
      };
    }

    // ---- observe the drafting job ----
    const job = await this.d.jobs().getStatus(run.links.jobId);
    if (!job) return this.failChange(run, "The drafting job could not be found. Start a new run.");
    const counters = countersOf(job, run.counters);
    const outcome = mapJob(job);
    switch (outcome.kind) {
    case "active":
      return {
        counters,
        steps: withStep(run.steps, "draft", { status: "running", detail: `${job.chunksDone} of ${job.chunks} text parts done; ${job.usage.requests} model calls so far.` }, now),
        summary: `Drafting the rulebook: ${job.chunksDone} of ${job.chunks} text parts done.`,
        nextAttemptAt: Timestamp.fromMillis(now.toMillis() + this.d.timing.pollMs),
      };
    case "drafted":
      return {
        status: "waiting_for_publish",
        summary: STATUS_PLAIN.waiting_for_publish,
        counters,
        links: { ...run.links, rulebookVersion: outcome.version },
        steps: withStep(withStep(run.steps, "draft", { status: "done", detail: `Draft written as version ${outcome.version}.` }, now), "safeguards", { status: "running", detail: "The automatic safeguards are deciding." }, now),
        handedToSafeguardsAt: now,
        nextAttemptAt: null,
        wake: true,
      };
    case "too_thin":
      return { ...this.thinChange(run, outcome.plain, outcome.code), counters };
    case "cancelled":
      return { status: "cancelled", counters };
    default:
      return { ...this.failChange(run, outcome.plain), counters };
    }
  }

  /** The audit entry of an allow-list addition made through a run (the settings history has its own). */
  private async auditAllowlist(run: RouteOnboardingRun, uid: string): Promise<void> {
    try {
      await this.d.runTransaction(async (tx) => {
        appendRegistryAudit(tx, { action: "onboarding_allowlist_added", actorUid: uid, at: this.now(), targetType: "onboardingRun", targetId: run.runId, before: null, after: { routeKey: run.routeKey } });
      });
    } catch (err) {
      console.error(`${TAG} ${run.runId}: the allow-list audit entry failed (${errClass(err)})`);
    }
  }

  // ---------- Step 7: safeguards ----------

  /** Read what the publishing pipeline decided for the run's version (no write to the pipeline, ever). */
  private async observePublish(run: RouteOnboardingRun): Promise<PublishVerdict> {
    const version = run.links.rulebookVersion as number;
    const publishRunId = `${run.routeKey}__v${version}`;
    const [v, rec, settings] = await Promise.all([
      this.d.getVersion(run.routeKey, version),
      this.d.getPublishRun(publishRunId),
      this.d.loadPublishSettings(),
    ]);
    const onboarding = await this.d.loadSettings();
    return mapPublish({
      versionStatus: v ? v.reviewStatus : null,
      run: rec,
      settings,
      waitedMs: this.d.clock() - ms(run.handedToSafeguardsAt),
      waitLimitMs: onboarding.settings.publishWaitMinutes * 60_000,
    });
  }

  private async actSafeguards(run: RouteOnboardingRun): Promise<Change> {
    const now = this.now();
    if (run.links.rulebookVersion === null) return this.failChange(run, "The draft has no version recorded, so the safeguards cannot be watched.");
    const verdict = await this.observePublish(run);
    if (verdict.kind === "wait") {
      return { nextAttemptAt: Timestamp.fromMillis(now.toMillis() + this.d.timing.pollMs) };
    }
    return this.endFromVerdict(run, verdict, now);
  }

  /** A verdict that ends the run: the final status, the hold reason and the plain summary. */
  private endFromVerdict(run: RouteOnboardingRun, verdict: Extract<PublishVerdict, { kind: "end" }>, now: Timestamp): Change {
    const publishRunId = `${run.routeKey}__v${run.links.rulebookVersion}`;
    return {
      status: verdict.status,
      summary: verdict.plain,
      holdReason: verdict.hold,
      links: { ...run.links, publishRunId },
      steps: withStep(run.steps, "safeguards", { status: "done", detail: verdict.plain }, now),
    };
  }

  // ============================================
  // Sweep and wake-ups
  // ============================================

  /**
   * Every few minutes (a scheduled function): wake runs that stalled (no live
   * lease, nothing recent, and any wait time passed), raise alerts that were
   * not raised, and let held runs whose retry is scheduled turn `published`.
   * Calls nothing external but the alert engine; takes no lease.
   */
  async sweep(): Promise<{ considered: number; kicked: number; alertsRaised: number; heldChecked: number }> {
    const out = { considered: 0, kicked: 0, alertsRaised: 0, heldChecked: 0 };
    const active = await collections.routeOnboardingRuns.where("status", "in", [...WORKER_RUN_STATUSES]).get();
    for (const d of active.docs) {
      out.considered += 1;
      const woke = await this.d.runTransaction(async (tx) => {
        const snap = await tx.get(this.runRef(d.id));
        const run = snap.exists ? (snap.data() as RouteOnboardingRun) : null;
        if (!run || !WORKER_RUN_STATUSES.includes(run.status)) return false;
        const nowMs = this.d.clock();
        if (ms(run.leaseUntil) > nowMs) return false;
        if (ms(run.nextAttemptAt) > nowMs) return false;
        if (ms(run.updatedAt) > nowMs - this.d.timing.sweepIdleMs) return false;
        tx.update(this.runRef(run.runId), { kick: run.kick + 1, updatedAt: Timestamp.fromMillis(nowMs) });
        return true;
      });
      if (woke) out.kicked += 1;
    }
    const pending = await collections.routeOnboardingRuns.where("alertPending", "==", true).get();
    for (const d of pending.docs) {
      await this.raiseAlertFor(d.data() as RouteOnboardingRun);
      out.alertsRaised += 1;
    }
    const held = await collections.routeOnboardingRuns.where("status", "==", "held").get();
    for (const d of held.docs) {
      const run = d.data() as RouteOnboardingRun;
      if (run.holdReason?.retryScheduled) {
        out.heldChecked += 1;
        await this.reobserveHeld(run);
      }
    }
    return out;
  }

  /**
   * A route's pipeline or drafting job wrote something: wake the route's
   * active run (or re-read a held one). Used by the two small triggers on the
   * job and the publish-run documents. Never throws.
   */
  async wakeRoute(routeKey: string): Promise<void> {
    try {
      const head = await collections.routeOnboardingRoutes.doc(routeKey).get();
      const runId = head.exists ? (head.data() as RouteOnboardingHead).activeRunId : null;
      if (!runId) return;
      const snap = await this.runRef(runId).get();
      if (!snap.exists) return;
      const run = snap.data() as RouteOnboardingRun;
      if (run.status === "held" && run.holdReason?.retryScheduled) {
        await this.reobserveHeld(run);
        return;
      }
      if (!WORKER_RUN_STATUSES.includes(run.status)) return;
      await this.d.runTransaction(async (tx) => {
        const s = await tx.get(this.runRef(runId));
        const cur = s.exists ? (s.data() as RouteOnboardingRun) : null;
        if (cur && WORKER_RUN_STATUSES.includes(cur.status)) tx.update(this.runRef(runId), { kick: cur.kick + 1 });
      });
    } catch (err) {
      console.error(`${TAG} wake ${routeKey} failed (${errClass(err)})`);
    }
  }

  /**
   * A held run with an automatic retry pending: read the pipeline again. A hold
   * the hourly sweep cleared becomes `published` with no admin action; a hold
   * that is now final stops being watched. Guarded: only a run still `held`.
   */
  private async reobserveHeld(run: RouteOnboardingRun): Promise<void> {
    try {
      if (run.links.rulebookVersion === null) return;
      const now = this.now();
      const onboarding = await this.d.loadSettings();
      // Past the watch window: stop watching (the hold stands).
      const expired = now.toMillis() - ms(run.finishedAt) > onboarding.settings.heldWatchHours * 3_600_000;
      const verdict = await this.observePublish({ ...run, handedToSafeguardsAt: now });
      let patch: Partial<RouteOnboardingRun> | null = null;
      let cleared = false;
      if (verdict.kind === "end" && verdict.status === "published") {
        patch = { status: "published", summary: verdict.plain, holdReason: null, alertPending: false, updatedAt: now, links: { ...run.links, publishRunId: `${run.routeKey}__v${run.links.rulebookVersion}` } };
        cleared = true;
      } else if (verdict.kind === "end" && verdict.hold && (verdict.hold.code !== run.holdReason?.code || verdict.hold.retryScheduled !== run.holdReason?.retryScheduled)) {
        patch = { summary: verdict.plain, holdReason: verdict.hold, updatedAt: now };
      } else if (expired && run.holdReason) {
        patch = { holdReason: { ...run.holdReason, retryScheduled: false }, updatedAt: now };
      }
      if (!patch) return;
      const applied = await this.d.runTransaction(async (tx) => {
        const snap = await tx.get(this.runRef(run.runId));
        const cur = snap.exists ? (snap.data() as RouteOnboardingRun) : null;
        if (!cur || cur.status !== "held") return false;
        tx.set(this.runRef(run.runId), { ...cur, ...patch } as unknown as Record<string, unknown>);
        return true;
      });
      if (applied && cleared) {
        const config = await this.d.loadAlertConfig();
        await this.d.raiseAlerts([evaluateRouteOnboardingCleared(run.runId)], config);
        console.log(`${TAG} ${run.runId}: held -> published (the safeguards cleared it)`);
      }
    } catch (err) {
      console.error(`${TAG} ${run.runId}: re-reading a held run failed (${errClass(err)})`);
    }
  }
}

/** One item of the end checklist (not blocking; read from live documents). */
export interface ChecklistItem {
  id: "approve_visa_record" | "make_country_visible";
  plain: string;
  done: boolean;
  visaTypeId?: string;
  countryCode?: string;
}

/** Counters mirrored from a job view. */
function countersOf(job: { chunks: number; chunksDone: number; usage: { requests: number; inputTokens: number; outputTokens: number }; costUsd: number | null }, prev: RunCounters): RunCounters {
  return { ...prev, chunksTotal: job.chunks, chunksDone: job.chunksDone, calls: job.usage.requests, inputTokens: job.usage.inputTokens, outputTokens: job.usage.outputTokens, costUsd: job.costUsd };
}

/** A safe description of an error for the log: its code, else its class. Never the message. */
function errClass(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string" || typeof code === "number") return `code ${code}`;
  return (err as { constructor?: { name?: string } } | null)?.constructor?.name ?? "unknown error";
}

// ---------- Default dependencies (resolved lazily: import-cycle rule of scrapers/index.ts) ----------

async function defaultCrawlVisa(countryCode: string, force: boolean): Promise<VisaCrawlFacts> {
  const { visaCatalogCrawlService } = await import("../visa-catalog/visa-catalog-crawl.service");
  const s = await visaCatalogCrawlService.runOrchestrator({ sourceId: countryCode, force: force || undefined, trigger: "manual" });
  return { sourcesLeased: s.sourcesLeased, budgetHardStop: s.budgetHardStop, extractionsSkippedBudget: s.extractionsSkippedBudget };
}

async function defaultCrawlGuidance(sourceId: string): Promise<GuidanceCrawlSummary> {
  const { guidanceCrawlService } = await import("../guidance/guidance-crawl.service");
  return guidanceCrawlService.runOrchestrator({ sourceIds: [sourceId], trigger: "manual" });
}

async function defaultGetHead(routeKey: string): Promise<RubricHead | null> {
  const { rubricStore } = await import("../rubric/rubric.store");
  return rubricStore.getHead(routeKey);
}

async function defaultGetVersion(routeKey: string, version: number): Promise<VisaRubric | null> {
  const { rubricStore } = await import("../rubric/rubric.store");
  return rubricStore.getVersionForReview(routeKey, version);
}

async function defaultGetPublishRun(runId: string): Promise<{ outcome: "published" | "held" | "skipped"; reasonCodes: string[]; attempts: number } | null> {
  const snap = await collections.rubricPublishRuns.doc(runId).get();
  if (!snap.exists) return null;
  const d = snap.data() as { outcome: "published" | "held" | "skipped"; reasonCodes?: string[]; attempts?: number };
  return { outcome: d.outcome, reasonCodes: d.reasonCodes ?? [], attempts: d.attempts ?? 1 };
}

/** Reject an undecided draft as the cancelling admin (the same decision code a person's rejection uses). */
async function defaultRejectDraft(routeKey: string, version: number, uid: string): Promise<void> {
  const { rubricStore } = await import("../rubric/rubric.store");
  const v = await rubricStore.getVersionForReview(routeKey, version);
  if (!v || v.reviewStatus !== "pending_review") return;
  const { rubricReviewService, rubricVersionId } = await import("../../services/rubric-review.service");
  const { RUBRIC_ACTOR_KIND } = await import("../../types/rubric");
  await rubricReviewService.decideAs(
    rubricVersionId(routeKey, version),
    { action: "reject", revision: v.revision, reason: "Route onboarding run cancelled by an admin before the draft was published" },
    { kind: RUBRIC_ACTOR_KIND.ADMIN, uid }
  );
}

async function defaultLoadAlertConfig(): Promise<ScrapeAlertsConfig> {
  const { scrapeAlertService } = await import("../shared/alerts/scrape-alert.service");
  return scrapeAlertService.loadConfig();
}

async function defaultRaiseAlerts(evals: RuleEvaluation[], config?: ScrapeAlertsConfig): Promise<unknown> {
  const { scrapeAlertService } = await import("../shared/alerts/scrape-alert.service");
  return scrapeAlertService.raise(evals, config);
}

/** The singleton over the real crawlers, job service and Firestore. */
export const routeOnboardingService = new RouteOnboardingService();

// Re-exported for the controller's view of the step ids.
export { STEP_IDS };
