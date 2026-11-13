import { createHash } from "crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { collections, db } from "../utils/firebase";
import { applyExclusions, rubricRouteKey, rubricStore, type VisaRubric } from "../scrapers";
import type { Application } from "../types";
import {
  READINESS_BANDS,
  type ApplicationAssessment,
  type AssessmentChangeSummary,
  type AssessmentErrorCode,
  type AssessmentUsage,
  type ReadinessBand,
} from "../types/assessment";
import type {
  AssessmentBatch,
  BulkReassessmentRun,
  DocumentExtractionRecord,
} from "../types/bulk-reassessment";
import {
  assembleContent,
  assessmentIdFor,
  buildExtractionRequest,
  buildJudgementRequest,
  computeInputHash,
  deriveHolderFact,
  documentFieldsFor,
  evaluateObjective,
  extractionIsSuspicious,
  judgementCriteriaOf,
  mandatoryBarHits,
  parseExtraction,
  numberStatementBlocks,
  parseJudgement,
  planJudgementBatches,
  type AssessmentContent,
  type DocumentExtraction,
  type Facts,
  type JudgementOutput,
  type ObjectiveResult,
} from "./ai/assessment-engine";
import { AI_MODELS } from "./ai/ai-models";
import { notAssessedItems, splitByApplicability } from "./ai/rule-applicability";
import type { InsufficientItem } from "../types/assessment";
import { BATCH_PRICE_MULTIPLIER, costOfUsage, rolesArePriced } from "./ai/ai-pricing";
import { readAiSettings, type AiSettings } from "./ai/ai-settings";
import { AnthropicBatchProvider, type BatchItemOutcome, type BatchRequestItem, type LlmBatchProvider } from "./ai/batch-provider";
import type { LlmRequest, LlmUsage } from "./ai/llm-provider";
import { ASSESSMENT_PROMPT_VERSION, findInjectionSignals } from "./ai/prompt-safety";
import {
  aiCaseOfficerService,
  barDateOf,
  dayKey,
  failed as failedExtraction,
  newAssessmentDoc,
  sniffMediaType,
  unreadable,
  zeroUsage,
  type AiCaseOfficerService,
} from "./ai-case-officer.service";
import { claimsService } from "./claims.service";
import { notificationService } from "./notification.service";
import { diffRubricVersions } from "./rubric-diff";
import type { RubricReviewAuditEntry } from "./rubric-review.service";

// ============================================
// BULK RE-ASSESSMENT VIA THE BATCH API (issue #37)
// ============================================
//
// When an admin approves a new rubric version, the open applications on that
// route are re-assessed against it at Batch API rates, so a guidance change
// reaches clients instead of waiting for someone to re-run each case.
//
// ---- The flow ----
//
//  1. TRIGGER. `onRubricApproved` (index.ts) fires on the durable audit document
//     #125 writes in the SAME transaction as an approval (`rubricReviewHistory`,
//     action "approve"). Not an in-memory listener: a crash or a cold start after
//     the commit cannot lose the event, and a re-delivered event is harmless
//     (the run id is the audit id; `create()` fails the second time).
//  2. ENQUEUE. `startRun` creates `bulkReassessments/{auditId}` and then writes one
//     `queued` job per candidate application into `applicationAssessments`, with
//     `viaBatch: true`. Candidates are the applications that already HAVE a
//     succeeded assessment on the route (something to re-assess and to supersede;
//     we never spend on an application nobody asked an assessment for) and are not
//     closed / submitted to the embassy / withdrawn. The scan is resumable
//     (`enqueueCursor`): a pass that runs out of time is continued by the sweep.
//  3. SWEEP. `runSweep` (index.ts, scheduled) does, in order: continue unfinished
//     enqueues, give up on batches that never reached the provider, poll provider
//     batches and write their results, plan waiting jobs into new batches, and
//     close finished runs.
//  4. PLAN. #42's stages are reused so code still decides objective rules:
//       stage 1 mandatory bar   code only, NO model call, never batched. A hit (or
//                               nothing to read) is stored on the spot.
//       stage 2 extraction      one request per document. A rubric bump changes no
//                               document, so a result already in `documentExtractions`
//                               is reused and only MISSING documents are batched
//                               (batch kind "extraction"). Objective checks are then
//                               evaluated in code.
//       stage 3 judgement       one request per application (batch kind "judgement").
//  5. WRITE. A succeeded judgement result is stored as the new assessment, which
//     SUPERSEDES the previous one: the previous document is kept untouched except
//     for `supersededByAssessmentId`, and the new one carries a criteria-level
//     `changeSummary`.
//
// ---- Why the hash short-circuit needs no special case ----
// `rubricVersion` is one of the inputs of the #42 input hash, and the assessment
// id is sha256(applicationId:inputHash). A rubric bump therefore yields a NEW id
// even when no document changed, so the new job is created next to the old result
// instead of being short-circuited by it.
//
// ---- Notification policy (decided on #37) ----
// An applicant is NEVER notified automatically of a lower band caused by a rubric
// change. The new assessment is stored and marked `updateReason: "rules_updated"`.
// The assigned agent (else the agency owner, else the admins) is notified to
// review when the result got WORSE (band down, a new refusal ground, or a mandatory
// bar newly applying). The applicant sees the update only through the normal
// stale / updated state of the /ai routes; `changeSummary` and `reviewRequired`
// are stripped from client-role responses (tier-serializer.ts). No code path in
// this file notifies `app.userId`, and the recipient list filters that uid out.
//
// ---- Spend cap ----
// `maxBatchRequestsPerDay` bounds the provider requests submitted per UTC day (the
// price table is EMPTY today, so a dollar cap cannot be checked: the cap counts
// requests, and says so on the run, `capMode: "requests"`). When both roles are
// priced and `maxBatchCostUsdPerDay` is set, recorded batch spend also stops new
// submissions once it reaches that figure (it can overshoot by at most one
// batch). Work beyond the cap is DEFERRED: the jobs stay `queued`, the run records
// how many were left and when, and the next sweep after the cap resets (next UTC
// day) picks them up. Nothing is dropped.
//
// ---- Partial failure ----
// Each result is written on its own: succeeded ones are stored whatever else in
// the batch failed. A failed request (provider error, expired, cancelled, or
// missing from the results) sends only its job back to the waiting pool with
// `batchAttempts + 1`; at MAX_BATCH_ATTEMPTS it is failed for good. Everything
// is idempotent by status checks: processing an ended batch twice rewrites
// nothing that is already `succeeded`.
//
// Privacy: no log line holds a prompt, a model answer or applicant text. Log
// lines carry ids, counts and fixed codes only.

// ============================================
// Constants
// ============================================

/** Applications in these statuses are NOT re-assessed (closed, submitted onward, withdrawn). */
export const EXCLUDED_APPLICATION_STATUSES: readonly string[] = [
  "submitted_to_embassy",
  "interview_scheduled",
  "approved",
  "rejected",
  "withdrawn",
  "expired",
];

/** A job (or a document read) that failed this many batch rounds is failed for good. */
export const MAX_BATCH_ATTEMPTS = 3;
/** Most requests in one provider batch (well under the provider's published ceiling; confirm before raising). */
const MAX_BATCH_REQUESTS = 2_000;
/** Most request payload bytes (base64 documents and text) in one batch, conservatively under the provider's limit. */
const MAX_BATCH_BYTES = 60 * 1024 * 1024;
/** Candidate assessments read per page of the enqueue scan. */
const SCAN_PAGE = 100;
/** Waiting jobs planned per sweep. */
const PLAN_LIMIT = 200;
/** Time the sweep may use, under the function's 540 s timeout. */
const SWEEP_BUDGET_MS = 450_000;
/** A batch doc stuck in `pending_submit` this long never reached the provider. */
const STALE_PENDING_SUBMIT_MS = 30 * 60_000;
/** Firestore's "already exists" gRPC code, returned by `create()` on an existing doc. */
const ALREADY_EXISTS = 6;
/** Firestore writer batches stay under the 500 write limit. */
const WRITE_CHUNK = 400;

// ============================================
// Dependencies (injected, so a test can swap them)
// ============================================

/** Everything the service reaches outside Firestore. */
export interface BulkDeps {
  officer: AiCaseOfficerService;
  batches: LlmBatchProvider;
  // The approved rubric of a route, and any version of it (for the diff).
  getApprovedRubric(countryCode: string, visaTypeId: string): Promise<VisaRubric | null>;
  getRubricVersion(routeKey: string, version: number): Promise<VisaRubric | null>;
  loadBytes(storagePath: string): Promise<Buffer>;
  readSettings: typeof readAiSettings;
  notify: typeof notificationService.notifyUser;
  adminUids(): Promise<string[]>;
  now(): Date;
}

/** The default deps: the real provider, store, Storage and notifier. */
function defaultDeps(): BulkDeps {
  return {
    officer: aiCaseOfficerService,
    batches: new AnthropicBatchProvider(),
    getApprovedRubric: (cc, vt) => rubricStore.getApprovedRubric(cc, vt),
    getRubricVersion: (routeKey, version) => rubricStore.getVersionForReview(routeKey, version),
    loadBytes: async (storagePath) => {
      const [bytes] = await getStorage().bucket().file(storagePath).download();
      return bytes;
    },
    readSettings: readAiSettings,
    notify: (input) => notificationService.notifyUser(input),
    adminUids: () => claimsService.listAdminUids(),
    now: () => new Date(),
  };
}

// ============================================
// Planning types
// ============================================

/** A document whose stage 2 result is not stored yet. */
interface MissingDocument {
  documentId: string;
  path: string;
  label: string;
  key: string;
  // Failed rounds already spent on it.
  attempts: number;
}

/** Everything the assembly needs, loaded once per job. */
interface JobContext {
  app: Application;
  // The rulebook NARROWED to the rules that apply to this applicant (#207):
  // what the engine and the assembly run on.
  rubric: VisaRubric;
  // The whole rulebook, for what must look rules up by id (titles, top issues, actions).
  fullRubric: VisaRubric;
  // Rules whose applicability could not be decided: reported as "could not be assessed".
  notAssessed: InsufficientItem[];
  statementText: string;
  score: number | null;
  extractions: DocumentExtraction[];
  suspiciousContent: ApplicationAssessment["suspiciousContent"];
  objective: ObjectiveResult[];
  judgementCriteriaIds: string[];
  // Null when no judgement call is due (no criteria, or nothing to weigh).
  judgementRequest: LlmRequest | null;
  // Stage 2 spend that THIS run paid for (cache records stamped with its run id).
  extractUsage: AssessmentUsage;
  usedExtraction: boolean;
  hasStatementReadable: boolean;
  // Integration (#37 x #42 6f3336d): the statement the model was shown numbered
  // blocks of, and how many it was shown. Needed to range-check the anchors the
  // model returns and to record which statement was read, exactly as the single
  // path does. Null / 0 when no statement had any block.
  statementRef: { instanceId: string; version: number } | null;
  statementSentCount: number;
}

/** What planning one waiting job found. */
type Planned =
  // The job cannot run any more (closed, rubric moved, inputs changed): fail it.
  | { kind: "stop"; code: AssessmentErrorCode; message: string }
  // Stage 1 hit, or nothing to read: stored with no model call.
  | { kind: "final_no_model"; content: AssessmentContent; rubric: VisaRubric; app: Application }
  // Documents still to extract: they go into an extraction batch.
  | { kind: "need_extraction"; app: Application; missing: MissingDocument[]; fields: string[] }
  // All of stage 2 is stored: ready for stage 3 (or for assembly if no call is due).
  | { kind: "ready"; ctx: JobContext };

/** What the judgement stage came to. */
type JudgementOutcome = { kind: "none" } | { kind: "ok"; output: JudgementOutput; usage: LlmUsage } | { kind: "failed"; usage: LlmUsage | null };

/** One request waiting to go into a batch, with the assessment that owns it. */
interface PendingItem {
  customId: string;
  request: LlmRequest;
  assessmentId: string;
  bytes: number;
  // Extraction only: the cache record to create.
  cache?: { applicationId: string; documentId: string; fields: string[]; attempts: number };
}

/** Result of one sweep, for the log line. */
export interface SweepResult {
  skipped: string | null;
  runsContinued: number;
  batchesPolled: number;
  batchesProcessed: number;
  stored: number;
  failedJobs: number;
  submittedBatches: number;
  submittedRequests: number;
  deferredJobs: number;
  runsCompleted: number;
}

/** A blank sweep result. */
function emptySweep(): SweepResult {
  return {
    skipped: null,
    runsContinued: 0,
    batchesPolled: 0,
    batchesProcessed: 0,
    stored: 0,
    failedJobs: 0,
    submittedBatches: 0,
    submittedRequests: 0,
    deferredJobs: 0,
    runsCompleted: 0,
  };
}

// ============================================
// Small pure helpers
// ============================================

/** sha256 hex of a JSON value: the cache key and request ids are 64 characters. */
function sha256Json(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/**
 * The `documentExtractions` key for one document. A changed file (`updatedAtMs`),
 * a changed field list, a new prompt version or a new model each give a new key,
 * so a stale extraction is never read.
 */
export function extractionKeyFor(documentId: string, updatedAtMs: number, fields: readonly string[]): string {
  return sha256Json([documentId, updatedAtMs, [...fields].sort(), ASSESSMENT_PROMPT_VERSION, AI_MODELS.extraction]);
}

/** Position of a band in the ordered list (higher is better), or -1. */
function bandRank(b: ReadinessBand | null | undefined): number {
  return b ? READINESS_BANDS.indexOf(b) : -1;
}

/** Add two usages without counting a request (used to sum stored extraction usage). */
function sumUsage(a: AssessmentUsage, b: AssessmentUsage | null): AssessmentUsage {
  if (!b) return a;
  return {
    requests: a.requests + b.requests,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

/** Usage in the shape the price function takes. */
function asLlm(u: AssessmentUsage): LlmUsage {
  return { inputTokens: u.inputTokens, outputTokens: u.outputTokens, cacheReadTokens: u.cacheReadTokens, cacheWriteTokens: u.cacheWriteTokens };
}

/** Usage of one batch result as a stored one-request usage. */
function oneRequest(u: LlmUsage): AssessmentUsage {
  return { requests: 1, ...u };
}

/** True when an error from a Firestore `create()` is "already exists". */
function isAlreadyExists(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === ALREADY_EXISTS;
}

/** Criterion ids a stored result raises (refusal grounds, credibility flags, insufficient information). */
function findingIdsOf(a: Pick<ApplicationAssessment, "refusalGrounds" | "credibilityFlags" | "insufficientInformation">): Set<string> {
  return new Set([
    ...a.refusalGrounds.map((g) => g.criterionId),
    ...a.credibilityFlags.map((f) => f.criterionId),
    ...a.insufficientInformation.map((i) => i.criterionId),
  ]);
}

// ============================================
// The service
// ============================================

export class BulkReassessmentService {
  constructor(private readonly deps: BulkDeps = defaultDeps()) {}

  // Rubric versions read for diffs during one process lifetime of a sweep.
  // Cleared at the start of each sweep so a long-lived instance holds nothing stale.
  private rubricVersionCache = new Map<string, VisaRubric | null>();

  // ----------------------------------------------------------------
  // 1. Trigger and enqueue
  // ----------------------------------------------------------------

  /**
   * Start the run for one rubric approval. Called by the Firestore trigger on
   * the audit document. Idempotent: the run id is the audit id, so a second
   * delivery finds the run and returns "duplicate" (an unfinished enqueue is
   * continued by the sweep, not here).
   *
   * @param auditId id of the `rubricReviewHistory` document
   * @param entry   its data
   */
  async startRun(auditId: string, entry: RubricReviewAuditEntry): Promise<"started" | "duplicate" | "ignored"> {
    // Only an approval that now serves a version starts anything. A reject
    // changes nothing about what is served.
    if (entry.action !== "approve" || entry.approvedVersion === null || entry.approvedVersion === undefined) return "ignored";

    const now = Timestamp.fromDate(this.deps.now());
    const run: BulkReassessmentRun = {
      id: auditId,
      routeKey: entry.routeKey,
      countryCode: entry.countryCode,
      visaTypeId: entry.visaTypeId,
      rubricVersion: entry.approvedVersion,
      previousApprovedVersion: entry.previousApprovedVersion ?? null,
      approvedBy: entry.by,
      status: "enqueuing",
      createdAt: now,
      updatedAt: now,
      enqueueCursor: null,
      enqueueDone: false,
      enqueued: 0,
      alreadyCurrent: 0,
      excluded: 0,
      deferredAtLastSweep: 0,
      lastDeferredAt: null,
      capMode: null,
      succeeded: null,
      failed: null,
      completedAt: null,
    };
    try {
      await collections.bulkReassessments.doc(auditId).create(run as unknown as Record<string, unknown>);
    } catch (err) {
      if (isAlreadyExists(err)) return "duplicate";
      throw err;
    }

    // An older, unfinished run on the same route is overtaken by this approval:
    // its waiting jobs would fail `rubric_changed` anyway. Mark it so the record says why.
    const older = await collections.bulkReassessments
      .where("routeKey", "==", entry.routeKey)
      .where("status", "in", ["enqueuing", "running"])
      .get();
    for (const d of older.docs) {
      if (d.id === auditId) continue;
      await d.ref.update({ status: "cancelled", updatedAt: now });
    }

    // First pass inline, bounded; the sweep continues the rest.
    await this.enqueuePass(run, this.deps.now().getTime() + SWEEP_BUDGET_MS);
    console.log(`[bulk-reassess] run ${auditId} started for ${entry.routeKey} v${entry.approvedVersion}`);
    return "started";
  }

  /**
   * Scan the route's succeeded assessments (ordered by application id) and
   * enqueue a job per candidate application, resuming from the run's cursor.
   * Stops when the scan is done or `deadlineMs` passes, saving its place.
   */
  private async enqueuePass(run: BulkReassessmentRun, deadlineMs: number): Promise<void> {
    let cursor = run.enqueueCursor;
    let done = run.enqueueDone;
    while (!done && this.deps.now().getTime() < deadlineMs) {
      let q = collections.applicationAssessments
        .where("countryCode", "==", run.countryCode)
        .where("visaTypeId", "==", run.visaTypeId)
        .where("status", "==", "succeeded")
        .orderBy("applicationId")
        .limit(SCAN_PAGE);
      if (cursor) q = q.startAfter(cursor);
      const snap = await q.get();
      if (snap.empty) {
        done = true;
        break;
      }

      // One application can have several succeeded assessments: handle it once.
      const seen = new Set<string>();
      const counts = { enqueued: 0, alreadyCurrent: 0, excluded: 0 };
      for (const d of snap.docs) {
        const applicationId = (d.data() as ApplicationAssessment).applicationId;
        if (seen.has(applicationId)) continue;
        seen.add(applicationId);
        const outcome = await this.enqueueOne(run, applicationId);
        if (outcome === "enqueued") counts.enqueued++;
        else if (outcome === "already_current") counts.alreadyCurrent++;
        else counts.excluded++;
      }

      cursor = (snap.docs[snap.docs.length - 1].data() as ApplicationAssessment).applicationId;
      if (snap.size < SCAN_PAGE) done = true;
      // Progress is saved after every page, so a crash loses at most one page
      // (which re-runs harmlessly: `create()` on an existing job is a no-op).
      await collections.bulkReassessments.doc(run.id).update({
        enqueueCursor: cursor,
        enqueueDone: done,
        status: done ? "running" : "enqueuing",
        enqueued: FieldValue.increment(counts.enqueued),
        alreadyCurrent: FieldValue.increment(counts.alreadyCurrent),
        excluded: FieldValue.increment(counts.excluded),
        updatedAt: Timestamp.fromDate(this.deps.now()),
      });
    }
  }

  /**
   * Enqueue the job for one application, or say why not.
   *  - `excluded`: the application is gone, closed, submitted to the embassy or withdrawn;
   *  - `already_current`: it already has a succeeded assessment at this rubric
   *    version, or a job for exactly these inputs already exists;
   *  - `enqueued`: a `queued`, `viaBatch` job was created.
   */
  private async enqueueOne(run: BulkReassessmentRun, applicationId: string): Promise<"enqueued" | "already_current" | "excluded"> {
    const appSnap = await collections.applications.doc(applicationId).get();
    if (!appSnap.exists) return "excluded";
    const app = { id: appSnap.id, ...appSnap.data() } as Application;
    if (EXCLUDED_APPLICATION_STATUSES.includes(app.status)) return "excluded";

    const previous = await this.latestSucceeded(applicationId);
    if (previous && previous.rubricVersion === run.rubricVersion) return "already_current";

    const loaded = await this.deps.officer.loadInputs(app);
    const inputHash = computeInputHash(this.deps.officer.inputsFor(loaded, run.rubricVersion));
    const id = assessmentIdFor(app.id, inputHash);

    const job: ApplicationAssessment = {
      ...newAssessmentDoc({
        id,
        app,
        rubricVersion: run.rubricVersion,
        inputHash,
        trigger: "rubric_bump",
        requestedBy: "system",
        now: this.deps.now(),
      }),
      viaBatch: true,
      bulkRunId: run.id,
      batchId: null,
      batchPhase: null,
      batchAttempts: 0,
      updateReason: "rules_updated",
      supersedesAssessmentId: previous ? previous.id : null,
      supersededByAssessmentId: null,
      supersededAt: null,
      changeSummary: null,
      reviewRequired: false,
      reviewNotifiedAt: null,
    };
    try {
      await collections.applicationAssessments.doc(id).create(job as unknown as Record<string, unknown>);
      return "enqueued";
    } catch (err) {
      // A job for exactly these inputs exists (an interactive run got there, or an
      // earlier pass of this scan): nothing to add.
      if (isAlreadyExists(err)) return "already_current";
      throw err;
    }
  }

  /** The newest succeeded assessment of an application (any version), or null. */
  private async latestSucceeded(applicationId: string): Promise<ApplicationAssessment | null> {
    const snap = await collections.applicationAssessments.where("applicationId", "==", applicationId).get();
    const done = snap.docs.map((d) => d.data() as ApplicationAssessment).filter((a) => a.status === "succeeded");
    done.sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0));
    return done[0] ?? null;
  }

  // ----------------------------------------------------------------
  // 2. The sweep
  // ----------------------------------------------------------------

  /**
   * One scheduled pass. Safe to run at any time and any number of times: every
   * step is guarded by the status of what it touches. Never throws for a
   * per-item problem; the settings and key problems are returned as `skipped`.
   */
  async runSweep(): Promise<SweepResult> {
    const result = emptySweep();
    this.rubricVersionCache.clear();
    const deadline = this.deps.now().getTime() + SWEEP_BUDGET_MS;

    // Fail closed, as #42's worker does: an unreadable settings doc, or an admin's "off".
    const settingsRead = await this.deps.readSettings();
    if (!settingsRead.ok) return { ...result, skipped: "settings_unavailable" };
    const settings = settingsRead.settings;
    if (!settings.enabled) return { ...result, skipped: "disabled" };

    const runSnap = await collections.bulkReassessments.where("status", "in", ["enqueuing", "running"]).get();
    const runs = runSnap.docs.map((d) => d.data() as BulkReassessmentRun);
    if (runs.length === 0 && (await this.hasOpenBatchesOrWaitingJobs()) === false) return { ...result, skipped: "idle" };

    // a. Continue enqueues a previous pass could not finish.
    for (const run of runs.filter((r) => !r.enqueueDone)) {
      await this.enqueuePass(run, deadline);
      result.runsContinued++;
    }

    // b. Batches that never reached the provider are released.
    await this.releaseStalePendingBatches();

    // c. Poll and process provider batches.
    await this.pollBatches(result, deadline);

    // d. Plan waiting jobs into new batches (spend cap applies here).
    await this.planAndSubmit(settings, runs, result, deadline);

    // e. Close runs whose jobs are all finished.
    await this.completeRuns(result);

    console.log(
      `[bulk-reassess] sweep: polled ${result.batchesPolled}, processed ${result.batchesProcessed}, ` +
        `stored ${result.stored}, failed ${result.failedJobs}, submitted ${result.submittedBatches} batch(es) / ` +
        `${result.submittedRequests} request(s), deferred ${result.deferredJobs}, runs completed ${result.runsCompleted}`
    );
    return result;
  }

  /** True when any batch is open or any bulk job waits (so an idle sweep can skip cheaply). */
  private async hasOpenBatchesOrWaitingJobs(): Promise<boolean> {
    const open = await collections.assessmentBatches.where("status", "in", ["pending_submit", "submitted", "ended"]).limit(1).get();
    if (!open.empty) return true;
    const waiting = await collections.applicationAssessments.where("viaBatch", "==", true).where("status", "==", "queued").limit(1).get();
    return !waiting.empty;
  }

  // ----------------------------------------------------------------
  // 3. Context: stage 1 and the stored part of stage 2
  // ----------------------------------------------------------------

  /**
   * Work out where a waiting job stands: cannot run, finished without a model,
   * needs documents extracted, or ready for stage 3. Pure reads.
   */
  private async plan(doc: ApplicationAssessment, settings: AiSettings): Promise<Planned> {
    const officer = this.deps.officer;
    const appSnap = await collections.applications.doc(doc.applicationId).get();
    if (!appSnap.exists) return { kind: "stop", code: "inputs_changed", message: "the application no longer exists" };
    const app = { id: appSnap.id, ...appSnap.data() } as Application;
    // Re-checked here, not only at enqueue: the application may have been submitted since.
    if (EXCLUDED_APPLICATION_STATUSES.includes(app.status)) {
      return { kind: "stop", code: "application_closed", message: "the application is closed, submitted or withdrawn" };
    }

    const fullRubric = await this.deps.getApprovedRubric(app.countryCode, app.visaTypeId);
    if (!fullRubric || fullRubric.version !== doc.rubricVersion) {
      return { kind: "stop", code: "rubric_changed", message: "the approved rubric changed after this re-assessment was queued" };
    }
    const loaded = await officer.loadInputs(app);
    if (computeInputHash(officer.inputsFor(loaded, fullRubric.version)) !== doc.inputHash) {
      return { kind: "stop", code: "inputs_changed", message: "the application's inputs changed after this re-assessment was queued" };
    }
    // ---- which rules apply to THIS applicant (#207): see AiCaseOfficerService.execute ----
    const split = splitByApplicability(fullRubric, loaded.intake);
    const rubric: VisaRubric = { ...fullRubric, criteria: split.applicable };
    const notAssessed = notAssessedItems(split);

    const now = this.deps.now();
    const score = loaded.eligibilityScore;

    // ---- stage 1: mandatory bars (code only, never batched) ----
    const hits = mandatoryBarHits(rubric, loaded.nationality, barDateOf(app, now));
    if (hits.length > 0) {
      const content = assembleContent({
        rubric, mandatoryHits: hits, objective: [], judgement: null, documents: [],
        statementReadable: loaded.statements.length > 0, score, suspiciousDocumentIds: [], judgementFailed: false, notAssessed,
      });
      return { kind: "final_no_model", content, rubric: fullRubric, app };
    }
    // ---- nothing to read: a valid low-readiness result, no model call ----
    const hasContent = loaded.documents.length > 0 || loaded.statements.some((s) => s.text.trim().length > 0);
    if (!hasContent) {
      const content = assembleContent({
        rubric, mandatoryHits: [], objective: [], judgement: null, documents: [],
        statementReadable: false, score, suspiciousDocumentIds: [], judgementFailed: false, notAssessed,
      });
      return { kind: "final_no_model", content, rubric: fullRubric, app };
    }
    // ---- (#207) one judgement request per application on this path ----
    // A batch result is keyed by the assessment id, so this path carries ONE
    // judgement request. The rules that apply to this applicant normally fit in
    // one (see planJudgementBatches); when they need several, the job fails
    // with the cost-cap code rather than assessing a subset. The live
    // assessment path makes as many calls as it needs.
    if (planJudgementBatches(judgementCriteriaOf(rubric)).length > 1) {
      return { kind: "stop", code: "cost_cap_exceeded", message: "the rules that apply to this application need more than one judgement request; re-assess it from the application instead of in bulk" };
    }

    // ---- stage 2: what is already extracted, and what is missing ----
    const fields = documentFieldsFor(rubric);
    const keys = loaded.documents.map((d) => extractionKeyFor(d.id, d.updatedAtMs, fields));
    const records = new Map<string, DocumentExtractionRecord>();
    if (keys.length > 0 && fields.length > 0) {
      const snaps = await db.getAll(...keys.map((k) => collections.documentExtractions.doc(k)));
      for (const s of snaps) if (s.exists) records.set(s.id, s.data() as DocumentExtractionRecord);
    }

    const extractions: DocumentExtraction[] = [];
    const suspiciousContent: ApplicationAssessment["suspiciousContent"] = [];
    const missing: MissingDocument[] = [];
    let extractUsage = zeroUsage();
    let usedExtraction = false;
    loaded.documents.forEach((d, i) => {
      const base = { documentId: d.id, label: d.label };
      if (d.sizeMb * 1024 * 1024 > settings.maxFileBytes) return void extractions.push(unreadable(base, "file is larger than the limit"));
      if (fields.length === 0) return void extractions.push(unreadable(base, "no field to read"));
      const rec = records.get(keys[i]);
      if (rec && rec.status === "ok") {
        extractions.push({
          documentId: d.id, label: d.label, mediaType: rec.mediaType, readable: rec.readable, values: rec.values,
          failed: false, failure: rec.failure, suspicious: rec.suspicious,
        });
        if (rec.suspicious) suspiciousContent.push({ source: "document", documentId: d.id, page: null });
        // Spend is attributed to the run that paid for it, so a reused extraction is not counted twice.
        if (rec.bulkRunId === doc.bulkRunId && rec.usage) {
          extractUsage = sumUsage(extractUsage, rec.usage);
          usedExtraction = true;
        }
        return;
      }
      if (rec && rec.status === "failed" && rec.attempts >= MAX_BATCH_ATTEMPTS) {
        // Gave up on this document: it counts as unread, never as a pass (as in #42).
        extractions.push(failedExtraction(base, rec.failure ?? "the document could not be read"));
        return;
      }
      missing.push({ documentId: d.id, path: d.path, label: d.label, key: keys[i], attempts: rec?.attempts ?? 0 });
    });
    if (missing.length > 0) return { kind: "need_extraction", app, missing, fields };

    // ---- stage 2 evaluation: code decides ----
    const facts: Facts = {
      ...Object.fromEntries(Object.entries(loaded.intake).map(([k, v]) => [`intake.${k}`, v as Facts[string]])),
      ...deriveHolderFact(loaded.applicantName, extractions),
    };
    const objective = evaluateObjective(rubric, facts, extractions);

    // ---- stage 3 request, when one is due ----
    const judgementCriteria = judgementCriteriaOf(rubric);
    const statementText = loaded.statements.map((s) => s.text).filter(Boolean).join("\n\n");
    if (statementText && findInjectionSignals(statementText)) suspiciousContent.push({ source: "statement", documentId: null, page: null });
    // Integration (#37 x #42 6f3336d): number the ONE primary statement's blocks so
    // findings can be anchored, as `execute` does. Without this the batch result
    // would store every statement finding unanchored (no `nodePath`).
    const primary = loaded.statements.find((s) => s.blocks.length > 0) ?? null;
    const numbered = primary ? numberStatementBlocks(primary.blocks) : null;
    const otherText = loaded.statements.filter((s) => s !== primary).map((s) => s.text).filter(Boolean).join("\n\n");
    const statementRef = primary ? { instanceId: primary.instanceId, version: primary.version } : null;
    let judgementRequest: LlmRequest | null = null;
    if (judgementCriteria.length > 0 && (extractions.length > 0 || statementText.trim().length > 0)) {
      judgementRequest = buildJudgementRequest({
        rubric,
        statementText: numbered ? numbered.text : statementText || null,
        otherStatementsText: otherText || null,
        profileSummary: `Applicant name: ${loaded.applicantName ?? "not given"}. Nationality code: ${loaded.nationality ?? "not given"}.`,
        intakeSummary: JSON.stringify(loaded.intake),
        extractionSummary: extractions
          .filter((e) => e.readable && !e.failed && !e.suspicious)
          .flatMap((e) => e.values.map((v) => `${v.field}: ${String(v.value)}${v.unit ? ` ${v.unit}` : ""}${v.page ? ` (page ${v.page})` : ""}`))
          .join("\n"),
        objectiveSummary: objective.map((r) => `${r.criterionId}: ${r.outcome}`).join("\n"),
      });
    }

    return {
      kind: "ready",
      ctx: {
        app, rubric, fullRubric, notAssessed, statementText, score, extractions, suspiciousContent, objective,
        judgementCriteriaIds: judgementCriteria.map((c) => c.criterionId),
        judgementRequest, extractUsage, usedExtraction,
        hasStatementReadable: statementText.trim().length > 0,
        statementRef,
        statementSentCount: numbered ? numbered.sentCount : 0,
      },
    };
  }

  // ----------------------------------------------------------------
  // 4. Writing a result
  // ----------------------------------------------------------------

  /** Fail a waiting job with a stable code. Skips a job that is no longer queued. */
  private async failJob(id: string, code: AssessmentErrorCode, message: string): Promise<void> {
    const ref = collections.applicationAssessments.doc(id);
    const ok = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists || (snap.data() as ApplicationAssessment).status !== "queued") return false;
      tx.update(ref, {
        status: "failed",
        error: { code, message },
        batchId: null,
        batchPhase: null,
        finishedAt: Timestamp.fromDate(this.deps.now()),
      });
      return true;
    });
    if (ok) console.log(`[bulk-reassess] job ${id} failed: ${code}`);
  }

  /**
   * Store a job's result and supersede the previous assessment.
   *
   * Guarded: only a job that is still `queued` is written, so reprocessing an
   * ended batch (or a duplicate sweep) rewrites nothing that already succeeded.
   * One update carries the result AND its bulk fields (supersede link, change
   * summary, review flag). The previous assessment is kept; it only gains
   * `supersededByAssessmentId`.
   */
  private async storeResult(
    doc: ApplicationAssessment,
    content: AssessmentContent,
    rubric: VisaRubric,
    app: Application,
    usage: { extract: AssessmentUsage; judge: AssessmentUsage },
    suspiciousContent: ApplicationAssessment["suspiciousContent"]
  ): Promise<boolean> {
    const fresh = await this.deps.officer.getById(doc.id);
    if (!fresh || fresh.status !== "queued") return false;

    // ---- what changed against the assessment this one replaces ----
    const previous = doc.supersedesAssessmentId ? await this.deps.officer.getById(doc.supersedesAssessmentId) : null;
    const summary = previous ? await this.summaryAgainst(previous, content, rubric) : null;

    // ---- the review policy: worse for the applicant means an agent looks first ----
    const reviewRequired = summary !== null && (summary.readiness.direction === "down" || summary.newBlockingRule || this.raisedGround(previous, content));

    // ---- cost: batch-discounted, and only when BOTH roles are priced ----
    const extractCost = costOfUsage("extraction", asLlm(usage.extract));
    const judgeCost = costOfUsage("judgement", asLlm(usage.judge));
    const costUsd = extractCost === null || judgeCost === null ? null : (extractCost + judgeCost) * BATCH_PRICE_MULTIPLIER;

    await this.deps.officer.storeContent(
      doc.id,
      rubric,
      content,
      usage,
      { extract: usage.extract.requests > 0 ? AI_MODELS.extraction : null, judge: usage.judge.requests > 0 ? AI_MODELS.judgement : null },
      suspiciousContent,
      {
        costUsd,
        batchId: null,
        batchPhase: null,
        changeSummary: summary,
        reviewRequired,
        reviewNotifiedAt: null,
      }
    );

    // ---- supersede: keep the old one, point it at the new one ----
    if (previous) {
      await collections.applicationAssessments.doc(previous.id).update({
        supersededByAssessmentId: doc.id,
        supersededAt: Timestamp.fromDate(this.deps.now()),
      });
    }

    // ---- notify the reviewer (never the applicant) ----
    if (reviewRequired) await this.notifyReviewer(doc.id, app, summary);
    return true;
  }

  /** True when the new result raises a refusal ground the previous one did not. */
  private raisedGround(previous: ApplicationAssessment | null, content: AssessmentContent): boolean {
    if (!previous) return false;
    const before = new Set(previous.refusalGrounds.map((g) => g.criterionId));
    return content.refusalGrounds.some((g) => !before.has(g.criterionId));
  }

  /** The criteria-level change summary between a previous assessment and the new content. */
  private async summaryAgainst(previous: ApplicationAssessment, content: AssessmentContent, rubric: VisaRubric): Promise<AssessmentChangeSummary> {
    const before = bandRank(previous.readiness);
    const after = bandRank(content.readiness);
    const direction = before < 0 || after < 0 ? "unknown" : after < before ? "down" : after > before ? "up" : "same";

    // Rubric-level diff: which criterion ids were added, removed or changed.
    const old = await this.rubricVersionOf(rubric, previous.rubricVersion);
    let criteria: AssessmentChangeSummary["criteria"] = null;
    if (old) {
      const diff = diffRubricVersions(rubric, old);
      criteria = {
        added: diff.added.map((c) => c.criterionId),
        removed: diff.removed.map((c) => c.criterionId),
        changed: diff.changed.map((c) => c.criterionId),
      };
    }

    // Result-level diff: which findings are newly raised or no longer raised.
    const prevIds = findingIdsOf(previous);
    const nowIds = findingIdsOf(content);
    return {
      previousAssessmentId: previous.id,
      previousRubricVersion: previous.rubricVersion,
      rubricVersion: rubric.version,
      readiness: { from: previous.readiness, to: content.readiness, direction },
      criteria,
      findings: {
        raised: [...nowIds].filter((id) => !prevIds.has(id)).sort(),
        resolved: [...prevIds].filter((id) => !nowIds.has(id)).sort(),
      },
      newBlockingRule: content.hasBlockingRule && previous.hasBlockingRule !== true,
    };
  }

  /** A stored rubric version of the same route, or null when it cannot be read (cached per sweep). */
  private async rubricVersionOf(current: VisaRubric, version: number): Promise<VisaRubric | null> {
    const routeKey = rubricRouteKey(current.countryCode, current.visaTypeId);
    const key = `${routeKey}#${version}`;
    if (this.rubricVersionCache.has(key)) return this.rubricVersionCache.get(key) ?? null;
    let found: VisaRubric | null = null;
    try {
      const loaded = await this.deps.getRubricVersion(routeKey, version);
      if (loaded && loaded.reviewStatus !== "approved") {
        // `getVersionForReview` returns ANY status. Only an approved version
        // is a rule set someone was assessed against, so a pending or
        // rejected one is skipped (the change summary just has no rubric diff).
        console.warn(`Bulk re-assessment: rubric ${routeKey} v${version} is ${loaded.reviewStatus}, not approved; skipped for the diff`);
      } else if (loaded) {
        // Compare EFFECTIVE content (#161): the approved reader has the
        // reviewer's exclusions applied, so this side must too.
        found = applyExclusions(loaded);
      }
    } catch {
      found = null;
    }
    this.rubricVersionCache.set(key, found);
    return found;
  }

  /**
   * Tell whoever reviews this case that the rules changed and the result got
   * worse: the assigned agent, else the agency owner, else the admins. The
   * applicant's uid is filtered out of every list, so no path reaches them.
   * Best effort: a delivery failure never undoes the stored result.
   */
  private async notifyReviewer(assessmentId: string, app: Application, summary: AssessmentChangeSummary | null): Promise<void> {
    try {
      let recipients: string[] = [];
      if (app.agentId) recipients = [app.agentId];
      else if (app.agencyId) {
        const agency = await collections.agencies.doc(app.agencyId).get();
        const ownerId = agency.exists ? (agency.data() as { ownerId?: string }).ownerId : undefined;
        if (ownerId) recipients = [ownerId];
      }
      if (recipients.length === 0) recipients = await this.deps.adminUids();
      recipients = [...new Set(recipients)].filter((uid) => uid !== app.userId);
      if (recipients.length === 0) return;

      const who = app.clientName ? ` for ${app.clientName}` : "";
      const route = app.visaTypeName ?? "this route";
      await Promise.all(
        recipients.map((userId) =>
          this.deps.notify({
            userId,
            type: "assessment_rules_updated",
            title: "Rules changed: a case needs your review",
            body:
              `The guidance for ${route} changed and the assessment${who} was updated` +
              (summary && summary.readiness.direction === "down" ? ", with a lower readiness band" : "") +
              ". Please review it. The client has not been told.",
            relatedEntityType: "application",
            relatedEntityId: app.id,
          })
        )
      );
      await collections.applicationAssessments.doc(assessmentId).update({ reviewNotifiedAt: Timestamp.fromDate(this.deps.now()) });
    } catch (err) {
      console.error(`[bulk-reassess] reviewer notification failed for ${assessmentId}: ${(err as Error).name}`);
    }
  }

  /**
   * Finish a job from its planned context and a judgement outcome: assemble in
   * code (containment, citations), then store.
   */
  private async finalize(doc: ApplicationAssessment, ctx: JobContext, judgement: JudgementOutcome): Promise<boolean> {
    const content = assembleContent({
      rubric: ctx.rubric,
      mandatoryHits: [],
      objective: ctx.objective,
      judgement: judgement.kind === "ok" ? judgement.output : null,
      documents: ctx.extractions,
      statementReadable: ctx.hasStatementReadable,
      statement: ctx.statementRef,
      score: ctx.score,
      suspiciousDocumentIds: ctx.suspiciousContent.map((s) => s.documentId ?? "statement"),
      judgementFailed: judgement.kind === "failed",
      notAssessed: ctx.notAssessed,
    });
    if (content.droppedCount > 0) {
      // A count only; model text may carry an applicant's words.
      console.warn(`[bulk-reassess] assessment ${doc.id}: ${content.droppedCount} model item(s) dropped by code checks`);
    }
    const judgeUsage = judgement.kind === "ok" ? oneRequest(judgement.usage) : judgement.kind === "failed" && judgement.usage ? oneRequest(judgement.usage) : zeroUsage();
    return this.storeResult(doc, content, ctx.fullRubric, ctx.app, { extract: ctx.extractUsage, judge: judgeUsage }, ctx.suspiciousContent);
  }

  // ----------------------------------------------------------------
  // 5. Polling and results
  // ----------------------------------------------------------------

  /** Batches the provider is working on or has ended: advance each as far as it can go. */
  private async pollBatches(result: SweepResult, deadline: number): Promise<void> {
    const snap = await collections.assessmentBatches.where("status", "in", ["submitted", "ended"]).get();
    for (const d of snap.docs) {
      if (this.deps.now().getTime() > deadline) return;
      const batch = d.data() as AssessmentBatch;
      try {
        if (batch.status === "submitted") {
          result.batchesPolled++;
          const progress = await this.deps.batches.progress(batch.providerBatchId as string);
          if (!progress.ended) continue;
          batch.status = "ended";
          await d.ref.update({ status: "ended", endedAt: Timestamp.fromDate(this.deps.now()) });
        }
        await this.processBatch(batch, result);
        result.batchesProcessed++;
      } catch (err) {
        // A batch that cannot be read this time is left as it is for the next sweep.
        console.error(`[bulk-reassess] batch ${batch.id} could not be processed: ${(err as Error).message}`);
      }
    }
  }

  /** Write every result of an ended batch, then release what did not finish. */
  private async processBatch(batch: AssessmentBatch, result: SweepResult): Promise<void> {
    const seen = new Set<string>();
    let succeeded = 0;
    let failedCount = 0;
    for await (const item of this.deps.batches.results(batch.providerBatchId as string)) {
      seen.add(item.customId);
      const ok = batch.kind === "extraction" ? await this.handleExtractionResult(batch, item.customId, item.outcome) : await this.handleJudgementResult(batch, item.customId, item.outcome, result);
      if (ok) succeeded++;
      else failedCount++;
    }

    if (batch.kind === "extraction") {
      // Cache records still pending with no result: a failed round for that document.
      const pend = await collections.documentExtractions.where("batchId", "==", batch.id).get();
      for (const p of pend.docs) {
        const rec = p.data() as DocumentExtractionRecord;
        if (rec.status !== "pending") continue;
        await p.ref.update({ status: "failed", attempts: rec.attempts + 1, batchId: null, failure: "no result came back", updatedAt: Timestamp.fromDate(this.deps.now()) });
        failedCount++;
      }
    }

    // Members still attached to this batch: judgement jobs with no result count as a failed
    // round; extraction members simply go back to be planned (their documents are now cached).
    const members = await collections.applicationAssessments.where("batchId", "==", batch.id).get();
    for (const m of members.docs) {
      const a = m.data() as ApplicationAssessment;
      if (a.status !== "queued") continue;
      if (batch.kind === "judgement") await this.bumpAttempt(a, "no result came back", result);
      else await m.ref.update({ batchId: null, batchPhase: null });
    }

    await collections.assessmentBatches.doc(batch.id).update({ status: "processed", succeeded, failed: failedCount });
    console.log(`[bulk-reassess] batch ${batch.id} (${batch.kind}) processed: ${succeeded} ok, ${failedCount} not`);
  }

  /** Record one stage 2 result in the cache. True when the document was read. */
  private async handleExtractionResult(batch: AssessmentBatch, customId: string, outcome: BatchItemOutcome): Promise<boolean> {
    const ref = collections.documentExtractions.doc(customId);
    const snap = await ref.get();
    // Idempotent: only a record still waiting on THIS batch is written.
    if (!snap.exists) return false;
    const rec = snap.data() as DocumentExtractionRecord;
    if (rec.status !== "pending" || rec.batchId !== batch.id) return false;
    const stamp = Timestamp.fromDate(this.deps.now());

    // A round that failed for a reason outside the content: retry up to the cap.
    if (outcome.kind !== "succeeded") {
      await ref.update({ status: "failed", attempts: rec.attempts + 1, batchId: null, failure: `the provider did not answer (${outcome.kind})`, updatedAt: stamp });
      return false;
    }
    await this.recordSpend("extraction", outcome.response.usage);
    const usage = oneRequest(outcome.response.usage);

    // The same containment as #42: a refusal or a broken answer is a failed
    // extraction for good (the content is the problem, so another round would not help).
    if (outcome.response.stopReason === "refusal") {
      await ref.update({ status: "failed", attempts: MAX_BATCH_ATTEMPTS, batchId: null, failure: "the model declined to read the file", usage, updatedAt: stamp });
      return false;
    }
    const parsed = parseExtraction(outcome.response.text, rec.fields);
    if (!parsed.ok) {
      await ref.update({ status: "failed", attempts: MAX_BATCH_ATTEMPTS, batchId: null, failure: `the answer broke the contract: ${parsed.reason}`, usage, updatedAt: stamp });
      return false;
    }
    await ref.update({
      status: "ok",
      batchId: null,
      readable: parsed.readable,
      values: parsed.values,
      suspicious: extractionIsSuspicious(parsed.values),
      failure: null,
      usage,
      updatedAt: stamp,
    });
    return true;
  }

  /** Write one stage 3 result as the job's assessment. True when it was stored. */
  private async handleJudgementResult(batch: AssessmentBatch, assessmentId: string, outcome: BatchItemOutcome, result: SweepResult): Promise<boolean> {
    const doc = await this.deps.officer.getById(assessmentId);
    // Idempotent: only a job still waiting on THIS batch is written.
    if (!doc || doc.status !== "queued" || doc.batchId !== batch.id) return false;

    if (outcome.kind !== "succeeded") {
      await this.bumpAttempt(doc, `the provider did not answer (${outcome.kind})`, result);
      return false;
    }
    await this.recordSpend("judgement", outcome.response.usage);

    // Re-plan from the stored state: the rubric, the application and its inputs
    // must still be what the request was built from, or the answer is discarded.
    const settings = await this.settingsOrNull();
    if (!settings) return false;
    const planned = await this.plan(doc, settings);
    if (planned.kind === "stop") {
      await this.failJob(doc.id, planned.code, planned.message);
      result.failedJobs++;
      return false;
    }
    if (planned.kind !== "ready") {
      // Planning no longer reaches stage 3 (a document changed state): back to the pool.
      await collections.applicationAssessments.doc(doc.id).update({ batchId: null, batchPhase: null });
      return false;
    }

    // Parse in code. A refusal or a broken answer is recorded as a failed judgement
    // stage on the stored result (every judgement criterion insufficient), as in #42.
    let outcomeJ: JudgementOutcome;
    if (outcome.response.stopReason === "refusal") outcomeJ = { kind: "failed", usage: outcome.response.usage };
    else {
      const parsed = parseJudgement(outcome.response.text, planned.ctx.judgementCriteriaIds, planned.ctx.statementSentCount);
      outcomeJ = parsed.ok ? { kind: "ok", output: parsed.output, usage: outcome.response.usage } : { kind: "failed", usage: outcome.response.usage };
    }
    const stored = await this.finalize(doc, planned.ctx, outcomeJ);
    if (stored) result.stored++;
    return stored;
  }

  /** Count a failed round on a job: back to the pool, or failed at the cap. */
  private async bumpAttempt(doc: ApplicationAssessment, reason: string, result: SweepResult): Promise<void> {
    const attempts = (doc.batchAttempts ?? 0) + 1;
    if (attempts >= MAX_BATCH_ATTEMPTS) {
      await this.failJob(doc.id, "provider_error", `the batch request failed ${attempts} times (${reason})`);
      result.failedJobs++;
      return;
    }
    await collections.applicationAssessments.doc(doc.id).update({ batchAttempts: attempts, batchId: null, batchPhase: null });
  }

  /** The settings, or null when they cannot be read (the caller then leaves the job alone). */
  private async settingsOrNull(): Promise<AiSettings | null> {
    const read = await this.deps.readSettings();
    return read.ok ? read.settings : null;
  }

  /**
   * Add a finished request's cost to today's batch spend, when it can be priced.
   * With the price table empty nothing is added (a request count is kept at
   * submit time instead). Batch pricing applies the issue's 50% multiplier.
   */
  private async recordSpend(role: "extraction" | "judgement", usage: LlmUsage): Promise<void> {
    const cost = costOfUsage(role, usage);
    if (cost === null) return;
    await collections.aiCosts.doc(dayKey(this.deps.now())).set({ batchCostUsd: FieldValue.increment(cost * BATCH_PRICE_MULTIPLIER) }, { merge: true });
  }

  // ----------------------------------------------------------------
  // 6. Planning and submitting
  // ----------------------------------------------------------------

  /**
   * Take waiting jobs, settle what needs no model, and submit the rest in
   * batches within today's cap. Jobs the cap leaves out stay queued (deferred).
   */
  private async planAndSubmit(settings: AiSettings, runs: BulkReassessmentRun[], result: SweepResult, deadline: number): Promise<void> {
    // ---- today's capacity ----
    const dayRef = collections.aiCosts.doc(dayKey(this.deps.now()));
    const daySnap = await dayRef.get();
    const day = (daySnap.exists ? daySnap.data() : {}) as { batchRequests?: number; batchCostUsd?: number };
    const usdMode = settings.maxBatchCostUsdPerDay > 0 && rolesArePriced(["extraction", "judgement"]);
    let remaining = Math.max(0, settings.maxBatchRequestsPerDay - Number(day.batchRequests ?? 0));
    if (usdMode && Number(day.batchCostUsd ?? 0) >= settings.maxBatchCostUsdPerDay) remaining = 0;
    // The cap mode is recorded on every active run, so the record says how the cap was counted.
    const capMode: "requests" | "usd" = usdMode ? "usd" : "requests";

    // ---- waiting jobs, oldest first ----
    const waiting = await collections.applicationAssessments
      .where("viaBatch", "==", true)
      .where("status", "==", "queued")
      .where("batchId", "==", null)
      .orderBy("createdAt")
      .limit(PLAN_LIMIT)
      .get();

    const judgementItems: PendingItem[] = [];
    const extractionGroups: Array<{ assessmentId: string; runId: string; items: PendingItem[] }> = [];
    const runOf = new Map<string, string>();
    const unsettled = new Map<string, number>(); // runId -> jobs left waiting (deferred)

    for (const d of waiting.docs) {
      if (this.deps.now().getTime() > deadline) break;
      const doc = d.data() as ApplicationAssessment;
      const runId = doc.bulkRunId ?? "";
      runOf.set(doc.id, runId);
      try {
        const planned = await this.plan(doc, settings);
        if (planned.kind === "stop") {
          await this.failJob(doc.id, planned.code, planned.message);
          result.failedJobs++;
        } else if (planned.kind === "final_no_model") {
          // Stage 1 / nothing to read: stored here, no batch, no cap.
          const ok = await this.storeResult(doc, planned.content, planned.rubric, planned.app, { extract: zeroUsage(), judge: zeroUsage() }, []);
          if (ok) result.stored++;
        } else if (planned.kind === "ready") {
          if (planned.ctx.judgementRequest) {
            const request = planned.ctx.judgementRequest;
            judgementItems.push({ customId: doc.id, request, assessmentId: doc.id, bytes: request.user.length + request.system.length });
          } else {
            // No judgement call is due: assemble from the stored stage 2 now.
            const ok = await this.finalize(doc, planned.ctx, { kind: "none" });
            if (ok) result.stored++;
          }
        } else {
          const items = await this.extractionItemsFor(doc, planned.missing, planned.fields, planned.app);
          if (items.length > 0) extractionGroups.push({ assessmentId: doc.id, runId, items });
        }
      } catch (err) {
        // One job's problem never stops the sweep; it stays queued for the next one.
        console.error(`[bulk-reassess] planning ${doc.id} failed: ${(err as Error).name}`);
      }
    }

    // ---- apply the cap: judgement first (already paid-for extraction), then extraction ----
    const run = (id: string): BulkReassessmentRun | undefined => runs.find((r) => r.id === id);
    const chosenJudgement: PendingItem[] = [];
    for (const it of judgementItems) {
      if (remaining >= 1) {
        chosenJudgement.push(it);
        remaining -= 1;
      } else unsettled.set(runOf.get(it.assessmentId) ?? "", (unsettled.get(runOf.get(it.assessmentId) ?? "") ?? 0) + 1);
    }
    const chosenExtraction: Array<{ assessmentId: string; runId: string; items: PendingItem[] }> = [];
    for (const g of extractionGroups) {
      // Whole job or nothing: its documents are batched together.
      if (remaining >= g.items.length) {
        chosenExtraction.push(g);
        remaining -= g.items.length;
      } else unsettled.set(g.runId, (unsettled.get(g.runId) ?? 0) + 1);
    }

    // ---- submit, one batch per (kind, run), chunked by count and bytes ----
    const byRun = new Map<string, PendingItem[]>();
    for (const it of chosenJudgement) byRun.set(runOf.get(it.assessmentId) ?? "", [...(byRun.get(runOf.get(it.assessmentId) ?? "") ?? []), it]);
    for (const [runId, items] of byRun) await this.submitChunks("judgement", runId, run(runId), items, result);
    const extByRun = new Map<string, PendingItem[]>();
    for (const g of chosenExtraction) extByRun.set(g.runId, [...(extByRun.get(g.runId) ?? []), ...g.items]);
    for (const [runId, items] of extByRun) await this.submitChunks("extraction", runId, run(runId), items, result);

    // ---- the deferral is recorded, never silent ----
    let deferred = 0;
    for (const r of runs) {
      const n = unsettled.get(r.id) ?? 0;
      deferred += n;
      await collections.bulkReassessments.doc(r.id).update({
        deferredAtLastSweep: n,
        capMode,
        ...(n > 0 ? { lastDeferredAt: Timestamp.fromDate(this.deps.now()) } : {}),
        updatedAt: Timestamp.fromDate(this.deps.now()),
      });
    }
    result.deferredJobs = deferred;
    if (deferred > 0) {
      console.log(
        `[bulk-reassess] daily cap reached (${capMode}): ${deferred} job(s) deferred to the next run` +
          (capMode === "requests" ? " (the price table is empty, so the cap counts requests, not dollars)" : "")
      );
    }
  }

  /**
   * Build the extraction requests for a job's missing documents. A document
   * whose bytes cannot be used is settled here: unreadable files are recorded as
   * such (no model call); a storage read error is a failed round, retried later.
   */
  private async extractionItemsFor(doc: ApplicationAssessment, missing: MissingDocument[], fields: string[], app: Application): Promise<PendingItem[]> {
    const items: PendingItem[] = [];
    for (const m of missing) {
      let bytes: Buffer;
      try {
        bytes = await this.deps.loadBytes(m.path);
      } catch {
        await this.writeCache(m, app.id, fields, doc, { status: "failed", attempts: m.attempts + 1, failure: "file could not be read", mediaType: "" });
        continue;
      }
      const mediaType = sniffMediaType(bytes);
      if (!mediaType) {
        // Deterministic: recorded as an unreadable document, no model call.
        await this.writeCache(m, app.id, fields, doc, { status: "ok", attempts: m.attempts, failure: "file type is not supported", mediaType: "" });
        continue;
      }
      const data = bytes.toString("base64");
      const request = buildExtractionRequest({ label: m.label, mediaType, data }, fields);
      items.push({
        customId: m.key,
        request,
        assessmentId: doc.id,
        bytes: request.user.length + data.length,
        cache: { applicationId: app.id, documentId: m.documentId, fields, attempts: m.attempts },
      });
    }
    // A job whose documents were all settled above has nothing to batch: it is planned again next sweep.
    return items;
  }

  /** Write a settled (no-model) cache record. */
  private async writeCache(
    m: MissingDocument,
    applicationId: string,
    fields: string[],
    doc: ApplicationAssessment,
    s: { status: "ok" | "failed"; attempts: number; failure: string; mediaType: string }
  ): Promise<void> {
    const stamp = Timestamp.fromDate(this.deps.now());
    const rec: DocumentExtractionRecord = {
      key: m.key, applicationId, documentId: m.documentId, status: s.status, batchId: null, fields, attempts: s.attempts,
      bulkRunId: doc.bulkRunId ?? null, mediaType: s.mediaType, readable: false, values: [], suspicious: false,
      failure: s.failure, usage: null, createdAt: stamp, updatedAt: stamp,
    };
    await collections.documentExtractions.doc(m.key).set(rec as unknown as Record<string, unknown>);
  }

  /** Split items into batches by request count and bytes and submit each. */
  private async submitChunks(kind: "extraction" | "judgement", runId: string, run: BulkReassessmentRun | undefined, items: PendingItem[], result: SweepResult): Promise<void> {
    let chunk: PendingItem[] = [];
    let bytes = 0;
    const flush = async (): Promise<void> => {
      if (chunk.length === 0) return;
      await this.submitBatch(kind, runId, run, chunk, result);
      chunk = [];
      bytes = 0;
    };
    for (const it of items) {
      if (chunk.length >= MAX_BATCH_REQUESTS || (chunk.length > 0 && bytes + it.bytes > MAX_BATCH_BYTES)) await flush();
      chunk.push(it);
      bytes += it.bytes;
    }
    await flush();
  }

  /**
   * Submit one batch. Order matters for crash safety:
   *   1. reserve the day's request count (transaction),
   *   2. write the batch doc `pending_submit` and CLAIM the members (their
   *      `batchId`), so no other sweep plans them again,
   *   3. call the provider,
   *   4. mark the batch `submitted` with the provider's id.
   * A provider failure releases the members and the reservation. A crash between
   * 3 and 4 leaves a `pending_submit` doc that `releaseStalePendingBatches` frees
   * later: the cost is a possibly wasted provider batch, never two writers.
   */
  private async submitBatch(kind: "extraction" | "judgement", runId: string, run: BulkReassessmentRun | undefined, items: PendingItem[], result: SweepResult): Promise<void> {
    const now = Timestamp.fromDate(this.deps.now());
    const dayRef = collections.aiCosts.doc(dayKey(this.deps.now()));
    await dayRef.set({ batchRequests: FieldValue.increment(items.length) }, { merge: true });

    const batchRef = collections.assessmentBatches.doc();
    const batch: AssessmentBatch = {
      id: batchRef.id,
      kind,
      routeKey: run?.routeKey ?? "",
      rubricVersion: run?.rubricVersion ?? 0,
      bulkRunId: runId,
      status: "pending_submit",
      providerBatchId: null,
      requestCount: items.length,
      succeeded: 0,
      failed: 0,
      submittedAt: null,
      endedAt: null,
      createdAt: now,
      failure: null,
    };
    await batchRef.create(batch as unknown as Record<string, unknown>);

    // Claim the members (and, for extraction, create the pending cache records).
    const memberIds = [...new Set(items.map((i) => i.assessmentId))];
    for (let i = 0; i < memberIds.length; i += WRITE_CHUNK) {
      const w = db.batch();
      for (const id of memberIds.slice(i, i + WRITE_CHUNK)) w.update(collections.applicationAssessments.doc(id), { batchId: batchRef.id, batchPhase: kind });
      await w.commit();
    }
    if (kind === "extraction") {
      for (let i = 0; i < items.length; i += WRITE_CHUNK) {
        const w = db.batch();
        for (const it of items.slice(i, i + WRITE_CHUNK)) {
          const c = it.cache as NonNullable<PendingItem["cache"]>;
          const rec: DocumentExtractionRecord = {
            key: it.customId, applicationId: c.applicationId, documentId: c.documentId, status: "pending", batchId: batchRef.id,
            fields: c.fields, attempts: c.attempts, bulkRunId: runId, mediaType: "", readable: false, values: [], suspicious: false,
            failure: null, usage: null, createdAt: now, updatedAt: now,
          };
          w.set(collections.documentExtractions.doc(it.customId), rec as unknown as Record<string, unknown>);
        }
        await w.commit();
      }
    }

    // The provider call.
    const requestItems: BatchRequestItem[] = items.map((i) => ({ customId: i.customId, request: i.request }));
    try {
      const providerBatchId = await this.deps.batches.submit(requestItems);
      await batchRef.update({ status: "submitted", providerBatchId, submittedAt: Timestamp.fromDate(this.deps.now()) });
      result.submittedBatches++;
      result.submittedRequests += items.length;
      console.log(`[bulk-reassess] submitted ${kind} batch ${batchRef.id}: ${items.length} request(s)`);
    } catch (err) {
      // Nothing reached the provider: release everything and give the reservation back.
      await this.releaseBatch(batchRef.id, (err as Error).message.slice(0, 300));
      await dayRef.set({ batchRequests: FieldValue.increment(-items.length) }, { merge: true });
      console.error(`[bulk-reassess] batch submit failed: ${(err as Error).message.slice(0, 200)}`);
    }
  }

  /** Mark a batch failed and free its members and pending cache records. */
  private async releaseBatch(batchId: string, failure: string): Promise<void> {
    const stamp = Timestamp.fromDate(this.deps.now());
    await collections.assessmentBatches.doc(batchId).update({ status: "failed", failure });
    const members = await collections.applicationAssessments.where("batchId", "==", batchId).get();
    for (let i = 0; i < members.docs.length; i += WRITE_CHUNK) {
      const w = db.batch();
      for (const m of members.docs.slice(i, i + WRITE_CHUNK)) w.update(m.ref, { batchId: null, batchPhase: null });
      await w.commit();
    }
    const pend = await collections.documentExtractions.where("batchId", "==", batchId).get();
    for (const p of pend.docs) {
      if ((p.data() as DocumentExtractionRecord).status === "pending") {
        // Not a failed READ of the document: the attempt count is left as it was.
        await p.ref.update({ status: "failed", batchId: null, failure: "the batch never reached the provider", updatedAt: stamp });
      }
    }
  }

  /** Free batches stuck in `pending_submit` (a crash between claiming and submitting). */
  private async releaseStalePendingBatches(): Promise<void> {
    const snap = await collections.assessmentBatches.where("status", "==", "pending_submit").get();
    const cutoff = this.deps.now().getTime() - STALE_PENDING_SUBMIT_MS;
    for (const d of snap.docs) {
      const b = d.data() as AssessmentBatch;
      if (b.createdAt.toMillis() > cutoff) continue;
      await this.releaseBatch(b.id, "the batch was never submitted to the provider");
      console.warn(`[bulk-reassess] released stale batch ${b.id}`);
    }
  }

  // ----------------------------------------------------------------
  // 7. Closing runs
  // ----------------------------------------------------------------

  /** A run whose enqueue is done and whose jobs are all finished is completed, with its tallies. */
  private async completeRuns(result: SweepResult): Promise<void> {
    const snap = await collections.bulkReassessments.where("status", "==", "running").get();
    for (const d of snap.docs) {
      const run = d.data() as BulkReassessmentRun;
      if (!run.enqueueDone) continue;
      const open = await collections.applicationAssessments.where("bulkRunId", "==", run.id).where("status", "in", ["queued", "running"]).count().get();
      if (open.data().count > 0) continue;
      const ok = await collections.applicationAssessments.where("bulkRunId", "==", run.id).where("status", "==", "succeeded").count().get();
      const bad = await collections.applicationAssessments.where("bulkRunId", "==", run.id).where("status", "==", "failed").count().get();
      const stamp = Timestamp.fromDate(this.deps.now());
      await d.ref.update({ status: "completed", succeeded: ok.data().count, failed: bad.data().count, completedAt: stamp, updatedAt: stamp });
      result.runsCompleted++;
    }
  }
}

/** Singleton over the real provider, Storage, Firestore and notifier. */
export const bulkReassessmentService = new BulkReassessmentService();
