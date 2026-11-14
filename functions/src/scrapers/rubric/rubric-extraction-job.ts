import { createHash, randomUUID } from "crypto";
import { Timestamp, type Transaction } from "firebase-admin/firestore";
import { collections } from "../../utils/firebase";
import { costOfUsage } from "../../services/ai/ai-pricing";
import { emptyLlmUsage } from "../../services/ai/llm-provider";
import { describeAnthropicError } from "../../services/ai/anthropic-client";
import { RUBRIC_PROMPT_VERSION, type KnownQuestionView } from "./rubric-prompt";
import { needsTranslation } from "../language/language-lexicon";
import type { RubricExtractionRun, RubricHead, RubricRunUsage } from "../../types/rubric";
import type { SourceChunk } from "./rubric-chunk";
import {
  MAX_CALL_ATTEMPTS,
  RunStop,
  assembleDraft,
  combineAssessments,
  isTransientProviderError,
  rememberQuestions,
  rubricExtractionService,
  type CallAttempts,
  type ChunkAssessment,
  type LoadedSource,
  type ExtractRouteInput,
  type PlannedSource,
  type RubricExtractionService,
  type RunContext,
  type TranslateStepResult,
} from "./rubric-extraction.service";
import type { QuoteTranslation } from "../../types/rubric";
import { loadRubricSettings, type LoadedRubricSettings } from "./rubric-settings";
import { rubricRouteKey, rubricStore, type RubricStore } from "./rubric.store";
import {
  isTerminalStatus,
  rubricExtractionJobStore,
  stepIdOf,
  type JobStatus,
  type RubricExtractionJob,
  type RubricExtractionJobStore,
  type StepPhase,
  type StepRef,
  type StoredStep,
} from "./rubric-extraction-job.store";

// ============================================
// RUBRIC DRAFTING AS A RESUMABLE BACKGROUND JOB (issue #216)
// ============================================
//
// `extractRoute` drafts a whole rulebook in ONE call chain: a real route took
// 30-40 minutes, and a server function is cut off at 540 seconds. This module
// drafts the same rulebook as a JOB: small saved steps, advanced by a worker
// that can die at any moment and be replaced, never paying twice for a step
// that finished, and producing EXACTLY what `extractRoute` produces.
//
// ---- the moving parts ----
//
//   startJob      plans the route (the same checks `extractRoute` makes), pins
//                 the inputs and creates ONE job document with a deterministic
//                 id. Starting twice is a no-op that returns the first job.
//   advance       the WORKER (the Firestore trigger `processRubricExtraction
//                 Job`): takes a lease on the job, then runs as many steps as
//                 fit in one invocation, then hands over by bumping `kick`,
//                 which fires the trigger again (self-chaining).
//   sweep         every few minutes: any active job with no live lease and no
//                 recent progress is kicked again. This is the crash recovery.
//   cancel        sets a flag; the worker obeys before its NEXT step.
//
// ---- why resuming is safe (read this before changing anything) ----
//
// 1. STATE LIVES IN FIRESTORE, NEVER IN THE WORKER. The job document holds the
//    pinned inputs and the counters; each finished step's validated result is
//    a document of its own. A worker rebuilds everything else (chunks, quote
//    indexes) from the pinned snapshots, which are immutable (addressed by
//    their content hash) and cut deterministically.
// 2. WHERE THE JOB STANDS IS DERIVED FROM THE STORED RESULTS, not from a cursor
//    that could drift: replaying the stored results in document order gives
//    the next step, and the question list the next call must be shown (steps
//    are ORDER-DEPENDENT: the second call of a chunk is told what the first
//    call accepted, and every call is told the questions asked for earlier
//    chunks).
// 3. A STEP IS PAID FOR AT MOST ONCE PER ATTEMPT AND STORED EXACTLY ONCE. The
//    worker writes `inFlight` before the call; it stores the result, adds its
//    tokens to the counters and clears `inFlight` in ONE transaction that also
//    checks the worker still owns the lease and that the step document is not
//    there yet. A result that is stored is never asked for again. If the
//    worker dies after the call but before that transaction, the call was
//    paid for and is lost: unavoidable, and counted (see 4).
// 4. A CRASH IS A COUNTED FAILURE, NOT A SILENT LOOP. A worker that finds
//    `inFlight` still set knows its predecessor died mid-call (a timeout, a
//    redeploy, a crash). It counts that as one failed attempt of that step and
//    against the request cap. After `stepAttemptsMax` failed attempts of one
//    step the job FAILS with a reason, so a call that can never finish inside
//    one invocation ends the job instead of looping.
// 5. LEASES. One worker at a time: the claim is a transaction (a second
//    worker finds a live lease and does nothing), every write a worker makes
//    re-checks it still owns the lease, and a dead worker's lease simply
//    expires. Firestore transactions are serialisable, so two racing claims
//    cannot both win.
// 6. EXACTLY ONE VERSION. The final merge runs only when every step is stored.
//    Writing the version and marking the job `succeeded` (with the final run
//    record) are ONE transaction (`writePendingVersion`'s `guard`): it first
//    checks the job is still `running`, owned by this worker, not cancelled and
//    not already finished. A re-delivered trigger or a second worker that
//    reaches the final step afterwards finds the job finished and writes
//    nothing, even for a forced draft whose version number would otherwise
//    advance every time.
// 7. SAME RESULT AS THE ONE-SHOT RUN. The step functions are the ones
//    `extractRoute` calls (`runCriteriaStep`, `runIntakeStep`), the merge and
//    draft come from the one `assembleDraft`, parts are merged in the same
//    order, and a stored result is the JSON of what the step produced.
//
// ---- inputs are pinned ----
//
// A job reads the sources' newest snapshots ONCE, at start, and keeps their
// content hashes. Every later read is by that hash, so a crawl that changes a
// source mid-job can never mix old and new text. The chosen behaviour when a
// source HAS moved on: the job stops with status `skipped` and reason
// `sources_changed`, before spending another call, and writes no version (a
// draft of text that is already stale must not reach the publishing pipeline).
// The change itself starts a new job through `onGuidanceChanged`, with its own
// id (the source-set hash is part of the id).
//
// ---- caps hold across the whole job ----
//
// The counters (`usage.requests` + `failedAttempts`) live on the job and are
// checked before EVERY call against the cap pinned at start, so a restart or a
// new invocation can never spend the cap again. A job that would pass the cap
// stops with `run_cap_exceeded` and keeps its finished steps; it never
// truncates the rulebook.
//
// Logging: ids, counts and codes only. Never source text, never a prompt or an
// answer.

/** Tag on every line this module logs. */
const TAG = "[rubric-job]";

/** What `startJob` takes. */
export interface StartJobInput extends Pick<ExtractRouteInput, "countryCode" | "visaTypeId" | "sourceIds" | "force" | "dryRun" | "trigger"> {
  // The admin who started it, for the record.
  requestedBy?: string | null;
}

/** Cost of a plan, known before any call. */
export interface JobEstimate {
  chunks: number;
  // Upper bound: two calls per chunk, plus (#220) one translation call per
  // excerpt of a source that is not in the product language.
  maxRequests: number;
  // (#220) The translation calls inside `maxRequests` (0 when every source is in the product language).
  translationCallsAtMost: number;
  inputChars: number;
}

/** What `startJob` did. */
export interface StartJobResult {
  routeKey: string | null;
  // started    a new job was created
  // restarted  an earlier job of the same inputs that had stopped was queued again (its finished steps are kept)
  // existing   a job for these exact inputs is already queued, running or done: nothing was created
  // unchanged  the sources are the ones of the newest version: nothing to draft
  // dry_run    plan only
  // refused    stopped before a job existed (see reasonCode)
  outcome: "started" | "restarted" | "existing" | "unchanged" | "dry_run" | "refused";
  jobId: string | null;
  jobStatus: JobStatus | null;
  // Existing run stop codes (`daily_cap_reached`, `run_cap_exceeded`, `visa_type_not_found`, ...).
  reasonCode: string | null;
  message: string | null;
  plan: PlannedSource[];
  estimate: JobEstimate | null;
}

/** What the status endpoint returns: the job without its pinned internals. */
export interface JobView {
  jobId: string;
  routeKey: string;
  status: JobStatus;
  reasonCode: string | null;
  message: string | null;
  trigger: RubricExtractionJob["trigger"];
  force: boolean;
  chunks: number;
  chunksDone: number;
  stepsDone: number;
  stepsMax: number;
  usage: RubricRunUsage;
  failedAttempts: number;
  costUsd: number | null;
  cancelRequested: boolean;
  version: number | null;
  criteriaAccepted: number;
  specialistKept: number;
  discardedCount: number;
  discardedByReason: Record<string, number>;
  plan: PlannedSource[];
  sourceSnapshots: { sourceId: string; contentHashPrefix: string }[];
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

/** What one `advance` call ended with. */
export type AdvanceOutcome =
  // No such job, or it had already finished.
  | { kind: "idle"; status: JobStatus | null }
  // Another worker holds a live lease.
  | { kind: "lease_held" }
  // The lease was lost during the invocation (another worker took over).
  | { kind: "lease_lost"; stepsRun: number }
  // Steps were run and more remain: the job was kicked for the next invocation.
  | { kind: "handed_over"; stepsRun: number }
  // The job reached a final status in this invocation.
  | { kind: "finished"; status: JobStatus; stepsRun: number; reasonCode: string | null };

/** What the sweep did. */
export interface SweepResult {
  considered: number;
  kicked: number;
}

/** Everything the job service reaches outside itself; all injectable for tests. */
export interface RubricExtractionJobDeps {
  service?: RubricExtractionService;
  jobs?: RubricExtractionJobStore;
  store?: RubricStore;
  loadSettings?: () => Promise<LoadedRubricSettings>;
  // Clock in ms since the epoch (also the invocation deadline's clock).
  clock?: () => number;
  // A fresh id per worker invocation.
  newOwnerId?: () => string;
  // Pause between two attempts of one call.
  sleep?: (ms: number) => Promise<void>;
  // The newest snapshot id of each source now (null = none). Default: the registry.
  currentSnapshotIds?: (sourceIds: string[]) => Promise<Map<string, string | null>>;
}

/** The lease was taken over by another worker: stop touching the job. */
class LeaseLost extends Error {
  constructor() {
    super("the lease on the job is no longer held by this worker");
  }
}

/**
 * The fields of the job id: the route, then a hash of everything that makes
 * two drafts the SAME draft. Two starts with the same inputs get the same id,
 * which is what makes a duplicate start a no-op. The newest version number is
 * part of it so that, once a draft has been written, a forced re-draft of the
 * same sources is a new job; `force` is part of it so a forced draft is never
 * swallowed by an unforced one.
 */
export function jobIdOf(parts: { routeKey: string; sourceSetHash: string; promptVersion: string; model: string; maxChunkChars: number; latestVersion: number; force: boolean }): string {
  const digest = createHash("sha256")
    .update([parts.sourceSetHash, parts.promptVersion, parts.model, String(parts.maxChunkChars), String(parts.latestVersion), parts.force ? "force" : "plain"].join("|"))
    .digest("hex")
    .slice(0, 16);
  return `${parts.routeKey}__${digest}`;
}

/** Fingerprint of a plan's chunks, stored so a change in the cut is noticed. */
function chunkRefsOf(chunks: readonly SourceChunk[]): string[] {
  return chunks.map((c) => `${c.sourceId}#${c.chunkIndex}#${c.text.length}`);
}

/**
 * Where a job stands, derived from its stored step results by replaying them
 * in document order (see "why resuming is safe", point 2).
 */
export interface Replay {
  // Finished chunks, in order, ready for `assembleDraft`.
  parts: { chunk: SourceChunk; assessment: ChunkAssessment }[];
  // The questions asked so far (what the next intake call is shown).
  known: Map<string, KnownQuestionView>;
  // (#220) The unofficial translations stored so far, by rule id.
  translations: Record<string, QuoteTranslation>;
  // The next step to run, or null when every step is stored.
  next: (StepRef & { criteriaPart?: ChunkAssessment; assessment?: ChunkAssessment }) | null;
}

/**
 * Replay the stored steps against the pinned chunks.
 *
 * @param translateSourceIds (#220) the sources whose language is not the
 *   product language: a chunk of one of them, with accepted rules, has one more
 *   step after its intake step (the translation). Default none: a route in the
 *   product language replays exactly as before.
 */
export function replaySteps(chunks: readonly SourceChunk[], steps: ReadonlyMap<string, StoredStep>, translateSourceIds: ReadonlySet<string> = new Set()): Replay {
  const parts: Replay["parts"] = [];
  const known = new Map<string, KnownQuestionView>();
  const translations: Record<string, QuoteTranslation> = {};
  for (let position = 0; position < chunks.length; position++) {
    const chunk = chunks[position];
    const criteria = steps.get(stepIdOf(position, "criteria"));
    if (!criteria) return { parts, known, translations, next: { position, phase: "criteria" } };
    const criteriaResult = criteria.result as ChunkAssessment;
    // A chunk whose first call produced no accepted rule has no second call.
    if (criteriaResult.criteria.length === 0) {
      parts.push({ chunk, assessment: criteriaResult });
      continue;
    }
    const intake = steps.get(stepIdOf(position, "intake"));
    if (!intake) return { parts, known, translations, next: { position, phase: "intake", criteriaPart: criteriaResult } };
    const assessment = combineAssessments(criteriaResult, intake.result as ChunkAssessment);
    rememberQuestions(known, assessment);
    // (#220) The optional translation step of this chunk.
    if (translateSourceIds.has(chunk.sourceId)) {
      const translate = steps.get(stepIdOf(position, "translate"));
      if (!translate) return { parts, known, translations, next: { position, phase: "translate", assessment } };
      Object.assign(translations, (translate.result as TranslateStepResult).translations);
    }
    parts.push({ chunk, assessment });
  }
  return { parts, known, translations, next: null };
}

/** (#220) The ids of the pinned sources whose language is not the product language. */
function translateSourceIdsOf(sources: readonly LoadedSource[]): Set<string> {
  return new Set(sources.filter((s) => needsTranslation(s.language)).map((s) => s.snapshot.sourceId));
}

/** A blank usage record. */
function emptyUsage(): RubricRunUsage {
  return { requests: 0, ...emptyLlmUsage() };
}

/** Add `delta` to `base` (a new object). */
function addUsage(base: RubricRunUsage, delta: RubricRunUsage): RubricRunUsage {
  return {
    requests: base.requests + delta.requests,
    inputTokens: base.inputTokens + delta.inputTokens,
    outputTokens: base.outputTokens + delta.outputTokens,
    cacheReadTokens: base.cacheReadTokens + delta.cacheReadTokens,
    cacheWriteTokens: base.cacheWriteTokens + delta.cacheWriteTokens,
  };
}

/** The outcome fields a finished job records (all optional: a stopped job has fewer). */
interface Outcome {
  status: Exclude<JobStatus, "queued" | "running">;
  reasonCode: string | null;
  message: string | null;
  version?: number | null;
  criteriaAccepted?: number;
  specialistKept?: number;
  discardedCount?: number;
  discardedByReason?: Record<string, number>;
}

export class RubricExtractionJobService {
  /** @param deps overrides for tests; production passes nothing. */
  constructor(private readonly deps: RubricExtractionJobDeps = {}) {}

  // Defaults resolved at CALL time (see the import-cycle note in scrapers/index.ts).
  private get service(): RubricExtractionService {
    return this.deps.service ?? rubricExtractionService;
  }
  private get jobs(): RubricExtractionJobStore {
    return this.deps.jobs ?? rubricExtractionJobStore;
  }
  private get store(): RubricStore {
    return this.deps.store ?? rubricStore;
  }
  private clock(): number {
    return this.deps.clock ? this.deps.clock() : Date.now();
  }
  private now(): Timestamp {
    return Timestamp.fromMillis(this.clock());
  }

  /** The newest snapshot id of each source, from the registry (or the test double). */
  private async currentSnapshotIds(sourceIds: string[]): Promise<Map<string, string | null>> {
    if (this.deps.currentSnapshotIds) return this.deps.currentSnapshotIds(sourceIds);
    const out = new Map<string, string | null>();
    for (const id of sourceIds) {
      const doc = await collections.guidanceSources.doc(id).get();
      out.set(id, doc.exists ? ((doc.data() as { latestSnapshotId?: string | null }).latestSnapshotId ?? null) : null);
    }
    return out;
  }

  // ============================================
  // Start
  // ============================================

  /**
   * Plan a route and create its drafting job. Makes the same checks, in the
   * same order, as `extractRoute` (settings that fail closed, the route's
   * sources and visa type, the hash gate, the caps, the daily cap) but calls
   * no model: the first call happens in the worker.
   *
   * Never throws for an expected problem; the result says what happened.
   */
  async startJob(input: StartJobInput): Promise<StartJobResult> {
    const refuse = (reasonCode: string, message: string, routeKey: string | null = null, plan: PlannedSource[] = [], estimate: JobEstimate | null = null): StartJobResult => ({
      routeKey, outcome: "refused", jobId: null, jobStatus: null, reasonCode, message, plan, estimate,
    });
    let routeKey: string;
    try {
      routeKey = rubricRouteKey(input.countryCode, input.visaTypeId);
    } catch (err) {
      return refuse("invalid_route", (err as Error).message);
    }
    try {
      // ---- settings: fail closed ----
      const loaded = await (this.deps.loadSettings ?? loadRubricSettings)();
      if (loaded.readError) return refuse("settings_unavailable", "extraction settings could not be read; not starting", routeKey);
      const settings = loaded.settings;
      if (!settings.enabled) return refuse("disabled", "rubric extraction is switched off", routeKey);

      // ---- the route, its sources, the hash gate ----
      const head: RubricHead | null = await this.store.getHead(routeKey);
      const resolved = await this.service.resolveRoute(input, head);
      if (!input.force && head && head.latestSourceSetHash === resolved.sourceSetHash) {
        return { routeKey, outcome: "unchanged", jobId: null, jobStatus: null, reasonCode: "source_unchanged", message: "the sources are the ones the newest version was drafted from", plan: [], estimate: null };
      }

      // ---- the plan: read the text, cut it, check the caps ----
      const routeName = await this.service.routeName(input.countryCode, input.visaTypeId);
      const ctx = await this.service.buildRunContext(resolved.sources, settings, routeName);
      if (ctx.chunks.length === 0) throw new RunStop("failed", "no_text", "the snapshots hold no text to extract from");
      this.service.assertWithinCaps(ctx.chunks, settings);
      // (#220) One more call at most per excerpt of a source in another language (its translation).
      const translateChunks = ctx.chunks.filter((c) => translateSourceIdsOf(resolved.sources).has(c.sourceId)).length;
      const estimate: JobEstimate = { chunks: ctx.chunks.length, maxRequests: ctx.chunks.length * 2 + translateChunks, translationCallsAtMost: translateChunks, inputChars: ctx.chunks.reduce((n, c) => n + c.text.length, 0) };
      if (input.dryRun) {
        return { routeKey, outcome: "dry_run", jobId: null, jobStatus: null, reasonCode: null, message: null, plan: ctx.plan, estimate };
      }

      const model = this.service.modelName();
      const jobId = jobIdOf({ routeKey, sourceSetHash: resolved.sourceSetHash, promptVersion: RUBRIC_PROMPT_VERSION, model, maxChunkChars: settings.maxChunkChars, latestVersion: head?.latestVersion ?? 0, force: input.force === true });

      // ---- a job for these exact inputs may already exist ----
      const existing = await this.jobs.getJob(jobId);
      if (existing && (existing.status === "queued" || existing.status === "running" || existing.status === "succeeded")) {
        return { routeKey, outcome: "existing", jobId, jobStatus: existing.status, reasonCode: existing.reasonCode, message: existing.message, plan: existing.plan, estimate };
      }
      // The daily cap counts a job ONCE, when it is created (a restart is not
      // a new run). Checked here, before the first write.
      if (!existing) {
        const dayStart = Timestamp.fromMillis(Math.floor(this.clock() / 86_400_000) * 86_400_000);
        if ((await this.store.countRunsSince(dayStart)) >= settings.maxRunsPerDay) {
          throw new RunStop("skipped", "daily_cap_reached", `the daily cap of ${settings.maxRunsPerDay} extraction run(s) is used up`);
        }
      }

      const now = this.now();
      const pinned = {
        maxChunkChars: settings.maxChunkChars,
        maxOutputTokensPerRequest: settings.maxOutputTokensPerRequest,
        requestTimeoutMs: settings.requestTimeoutMs,
        maxRequestsPerRun: settings.maxRequestsPerRun,
        maxInputCharsPerRun: settings.maxInputCharsPerRun,
        stepAttemptsMax: settings.stepAttemptsMax,
      };
      const fresh: RubricExtractionJob = {
        jobId,
        routeKey,
        countryCode: input.countryCode,
        visaTypeId: input.visaTypeId,
        status: "queued",
        reasonCode: null,
        message: null,
        trigger: input.trigger ?? "manual",
        force: input.force === true,
        requestedBy: input.requestedBy ?? null,
        runId: jobId,
        sourceIds: resolved.sourceIds,
        sources: resolved.sources,
        sourceSetHash: resolved.sourceSetHash,
        model,
        promptVersion: RUBRIC_PROMPT_VERSION,
        routeName,
        pinned,
        plan: ctx.plan,
        chunkRefs: chunkRefsOf(ctx.chunks),
        chunks: ctx.chunks.length,
        stepsMax: ctx.chunks.length * 2 + translateChunks,
        stepsDone: 0,
        chunksDone: 0,
        usage: emptyUsage(),
        failedAttempts: 0,
        stepFailure: { stepId: null, count: 0, lastReason: null },
        inFlight: null,
        cancelRequested: false,
        cancelRequestedBy: null,
        leaseOwner: null,
        leaseUntil: null,
        kick: 0,
        version: null,
        criteriaAccepted: 0,
        specialistKept: 0,
        discardedCount: 0,
        discardedByReason: {},
        createdAt: now,
        updatedAt: now,
        expiresAt: Timestamp.fromMillis(now.toMillis() + settings.jobMaxAgeMs),
        finishedAt: null,
      };

      // ---- create (or queue again) in ONE transaction, with the run's `started` record ----
      // The record claims the run's place in the daily count. Both are written
      // only when the job document is not there yet, so two starts racing in
      // the same instant create one job and one record: the loser's
      // transaction re-reads, finds the job, and returns it.
      const jobRef = this.jobs.jobRef(jobId);
      const outcome = await this.jobs.runTransaction(async (tx) => {
        const snap = await tx.get(jobRef);
        const cur = snap.exists ? (snap.data() as RubricExtractionJob) : null;
        if (cur && (cur.status === "queued" || cur.status === "running" || cur.status === "succeeded")) return { kind: "existing" as const, job: cur };
        if (cur) {
          // A job that stopped (failed, skipped, cancelled) for these exact
          // inputs is queued again. Its finished steps are kept (they are
          // still valid: same sources, same prompt, same chunks), so nothing
          // already paid for is paid for again. Counters and caps carry over:
          // the cap is per JOB. The settings are re-pinned so a raised limit
          // takes effect.
          tx.update(jobRef, {
            status: "queued",
            reasonCode: null,
            message: null,
            pinned,
            plan: ctx.plan,
            cancelRequested: false,
            cancelRequestedBy: null,
            stepFailure: { stepId: null, count: 0, lastReason: null },
            inFlight: null,
            leaseOwner: null,
            leaseUntil: null,
            kick: cur.kick + 1,
            expiresAt: fresh.expiresAt,
            updatedAt: now,
            finishedAt: null,
          });
          return { kind: "restarted" as const, job: { ...cur, status: "queued" as const } };
        }
        tx.set(jobRef, fresh as unknown as Record<string, unknown>);
        tx.set(collections.rubricExtractionRuns.doc(jobId), this.runRecordOf(fresh, "started", null, null) as unknown as Record<string, unknown>);
        return { kind: "started" as const, job: fresh };
      });
      console.log(`${TAG} ${routeKey}: ${outcome.kind} job ${jobId} (${ctx.chunks.length} excerpts)`);
      return { routeKey, outcome: outcome.kind, jobId, jobStatus: outcome.job.status, reasonCode: outcome.job.reasonCode, message: outcome.job.message, plan: ctx.plan, estimate };
    } catch (err) {
      if (err instanceof RunStop) return refuse(err.reasonCode, err.message, routeKey);
      console.error(`${TAG} ${routeKey}: could not start a job: ${describeAnthropicError(err).slice(0, 300)}`);
      return refuse("unexpected_error", describeAnthropicError(err).slice(0, 300), routeKey);
    }
  }

  // ============================================
  // Records
  // ============================================

  /** The run record of a job in a given state (same document id from start to end). */
  private runRecordOf(job: RubricExtractionJob, status: RubricExtractionRun["status"], outcome: Outcome | null, finishedAt: Timestamp | null): RubricExtractionRun {
    return {
      runId: job.runId,
      routeKey: job.routeKey,
      countryCode: job.countryCode,
      visaTypeId: job.visaTypeId,
      status,
      // A job counts against the daily cap from the moment it exists.
      reachedModel: true,
      reasonCode: outcome?.reasonCode ?? null,
      error: outcome?.message ?? null,
      trigger: job.trigger,
      sourceSnapshots: job.sources.map((s) => s.snapshot),
      sourceSetHash: job.sourceSetHash,
      model: job.model,
      promptVersion: job.promptVersion,
      version: outcome?.version ?? null,
      chunks: job.chunks,
      usage: job.usage,
      costUsd: job.usage.requests > 0 ? costOfUsage("judgement", job.usage) : null,
      criteriaAccepted: outcome?.criteriaAccepted ?? 0,
      specialistKept: outcome?.specialistKept ?? 0,
      discardedCount: outcome?.discardedCount ?? 0,
      discardedByReason: outcome?.discardedByReason ?? {},
      startedAt: job.createdAt,
      finishedAt: finishedAt ?? this.now(),
    };
  }

  /**
   * Put a job into a final state, inside a transaction: the job document and
   * the run record (which replaces the `started` one). `job` is the version
   * of the document the transaction read.
   */
  private finishInTx(tx: Transaction, job: RubricExtractionJob, outcome: Outcome, extra: Partial<RubricExtractionJob> = {}): RubricExtractionJob {
    const now = this.now();
    const done: RubricExtractionJob = {
      ...job,
      ...extra,
      status: outcome.status,
      reasonCode: outcome.reasonCode,
      message: outcome.message,
      version: outcome.version ?? job.version,
      criteriaAccepted: outcome.criteriaAccepted ?? job.criteriaAccepted,
      specialistKept: outcome.specialistKept ?? job.specialistKept,
      discardedCount: outcome.discardedCount ?? job.discardedCount,
      discardedByReason: outcome.discardedByReason ?? job.discardedByReason,
      inFlight: null,
      leaseOwner: null,
      leaseUntil: null,
      updatedAt: now,
      finishedAt: now,
    };
    tx.set(this.jobs.jobRef(job.jobId), done as unknown as Record<string, unknown>);
    // The run record's status vocabulary has no `cancelled`: a cancelled job is
    // recorded as failed with the reason `cancelled`.
    const runStatus: RubricExtractionRun["status"] = outcome.status === "succeeded" ? "succeeded" : outcome.status === "skipped" ? "skipped" : "failed";
    tx.set(collections.rubricExtractionRuns.doc(job.runId), this.runRecordOf(done, runStatus, outcome, now) as unknown as Record<string, unknown>);
    return done;
  }

  /** Read a job inside a transaction and make sure `owner` still holds its lease. */
  private async readOwned(tx: Transaction, jobId: string, owner: string): Promise<RubricExtractionJob> {
    const snap = await tx.get(this.jobs.jobRef(jobId));
    const job = snap.exists ? (snap.data() as RubricExtractionJob) : null;
    if (!job || isTerminalStatus(job.status) || job.leaseOwner !== owner) throw new LeaseLost();
    return job;
  }

  /** End a job with `outcome`, but only if `owner` still holds the lease. */
  private async finishOwned(jobId: string, owner: string, outcome: Outcome, extra: Partial<RubricExtractionJob> = {}): Promise<boolean> {
    try {
      await this.jobs.runTransaction(async (tx) => {
        const job = await this.readOwned(tx, jobId, owner);
        this.finishInTx(tx, job, outcome, extra);
      });
      console.log(`${TAG} ${jobId}: ${outcome.status}${outcome.reasonCode ? ` (${outcome.reasonCode})` : ""}`);
      return true;
    } catch (err) {
      if (err instanceof LeaseLost) return false;
      throw err;
    }
  }

  // ============================================
  // The worker
  // ============================================

  /**
   * Advance one job: claim it, run as many steps as fit in this invocation,
   * and hand over (or finish). Safe to call at any time and any number of
   * times, concurrently: see "why resuming is safe" in the file header.
   *
   * @param opts.deadlineAt wall-clock end (ms since the epoch) of this
   *   invocation. Default: now plus the `invocationBudgetMs` setting.
   */
  async advance(jobId: string, opts: { deadlineAt?: number } = {}): Promise<AdvanceOutcome> {
    const loaded = await (this.deps.loadSettings ?? loadRubricSettings)();
    const owner = this.deps.newOwnerId ? this.deps.newOwnerId() : randomUUID();
    const deadlineAt = opts.deadlineAt ?? this.clock() + loaded.settings.invocationBudgetMs;

    // ---- 1. claim the lease ----
    const claim = await this.claim(jobId, owner, loaded);
    if (claim.kind !== "claimed") return claim.outcome;
    const job = claim.job;

    // ---- 2. work, turning anything unexpected into a counted failed attempt ----
    let stepsRun = 0;
    try {
      return await this.work(job, owner, loaded, deadlineAt, (n) => (stepsRun = n));
    } catch (err) {
      if (err instanceof LeaseLost) return { kind: "lease_lost", stepsRun };
      // Something outside a model call went wrong (a storage read, a database
      // error). It is counted against the step like a failed call, so the job
      // cannot loop forever on it.
      const message = describeAnthropicError(err).slice(0, 300);
      console.error(`${TAG} ${jobId}: unexpected error in the worker: ${message}`);
      return this.recordFailure(jobId, owner, "unexpected_error", message, null, stepsRun);
    }
  }

  /**
   * Take the lease in a transaction. Also applies, before any work, the
   * things that end a job without a call: cancellation, the age bound, and
   * the failed attempts a dead worker left behind.
   */
  private async claim(jobId: string, owner: string, loaded: LoadedRubricSettings): Promise<{ kind: "claimed"; job: RubricExtractionJob } | { kind: "stop"; outcome: AdvanceOutcome }> {
    const settings = loaded.settings;
    return this.jobs.runTransaction(async (tx) => {
      const snap = await tx.get(this.jobs.jobRef(jobId));
      if (!snap.exists) return { kind: "stop" as const, outcome: { kind: "idle", status: null } as AdvanceOutcome };
      const job = snap.data() as RubricExtractionJob;
      if (isTerminalStatus(job.status)) return { kind: "stop" as const, outcome: { kind: "idle", status: job.status } as AdvanceOutcome };
      const nowMs = this.clock();
      // A live lease of ANOTHER worker: do nothing (a duplicate delivery, or a
      // second worker racing this one).
      if (job.leaseOwner && job.leaseOwner !== owner && job.leaseUntil && job.leaseUntil.toMillis() > nowMs) {
        return { kind: "stop" as const, outcome: { kind: "lease_held" } as AdvanceOutcome };
      }
      // ---- stops that need no call ----
      if (job.cancelRequested) {
        this.finishInTx(tx, job, { status: "cancelled", reasonCode: "cancelled", message: "an admin cancelled the job; the steps already finished are kept" });
        return { kind: "stop" as const, outcome: { kind: "finished", status: "cancelled", stepsRun: 0, reasonCode: "cancelled" } as AdvanceOutcome };
      }
      if (nowMs >= job.expiresAt.toMillis()) {
        this.finishInTx(tx, job, { status: "failed", reasonCode: "job_timed_out", message: "the job did not finish within the time allowed for it" });
        return { kind: "stop" as const, outcome: { kind: "finished", status: "failed", stepsRun: 0, reasonCode: "job_timed_out" } as AdvanceOutcome };
      }
      // ---- a dead predecessor: its in-flight call counts as a failed attempt ----
      let next: RubricExtractionJob = job;
      // (#220) A predecessor that died inside the OPTIONAL translation call: the call is counted as a
      // failed attempt against the request cap, and the step is stored as failed (the rules keep no
      // translation) so the job moves on. A translation can never fail a job, however often it dies.
      if (job.inFlight && job.inFlight.stepId.endsWith("__translate")) {
        const dead = job.inFlight.stepId;
        const already = await tx.get(this.jobs.stepRef(jobId, dead));
        if (!already.exists) {
          const failedStep: TranslateStepResult = { translations: {}, outcome: "failed", reason: "worker_died" };
          this.jobs.writeStepInTx(tx, jobId, { stepId: dead, position: Number(/^c(\d+)__/.exec(dead)?.[1] ?? 0), phase: "translate", sourceId: "", chunkIndex: 0, result: failedStep, usage: emptyUsage(), failedAttempts: 1, createdAt: Timestamp.fromMillis(nowMs) });
        }
        next = { ...job, failedAttempts: job.failedAttempts + 1, inFlight: null, stepsDone: job.stepsDone + (already.exists ? 0 : 1), chunksDone: job.chunksDone + (already.exists ? 0 : 1) };
        console.warn(`${TAG} ${jobId}: the previous worker stopped during a translation call (counted as a failed attempt; the translation is skipped)`);
      }
      if (next.inFlight) {
        const deadStep = next.inFlight.stepId;
        const same = job.stepFailure.stepId === deadStep;
        next = {
          ...next,
          failedAttempts: next.failedAttempts + 1,
          inFlight: null,
          stepFailure: { stepId: deadStep, count: (same ? job.stepFailure.count : 0) + 1, lastReason: "provider_error" },
        };
        console.warn(`${TAG} ${jobId}: the previous worker stopped during a model call (counted as a failed attempt of ${deadStep})`);
      }
      if (next.stepFailure.count >= job.pinned.stepAttemptsMax) {
        this.finishInTx(tx, next, {
          status: "failed",
          reasonCode: next.stepFailure.lastReason ?? "provider_error",
          message: `a model call failed ${next.stepFailure.count} times in a row (the limit is ${job.pinned.stepAttemptsMax}); the job stopped with ${next.chunksDone} of ${next.chunks} parts done`,
        });
        return { kind: "stop" as const, outcome: { kind: "finished", status: "failed", stepsRun: 0, reasonCode: next.stepFailure.lastReason ?? "provider_error" } as AdvanceOutcome };
      }
      const claimed: RubricExtractionJob = {
        ...next,
        status: "running",
        leaseOwner: owner,
        leaseUntil: Timestamp.fromMillis(nowMs + settings.leaseMs),
        updatedAt: Timestamp.fromMillis(nowMs),
      };
      tx.set(this.jobs.jobRef(jobId), claimed as unknown as Record<string, unknown>);
      return { kind: "claimed" as const, job: claimed };
    });
  }

  /** The steps loop of one invocation. */
  private async work(job: RubricExtractionJob, owner: string, loaded: LoadedRubricSettings, deadlineAt: number, report: (stepsRun: number) => void): Promise<AdvanceOutcome> {
    const jobId = job.jobId;
    let stepsRun = 0;

    // ---- the kill switch and the settings, checked on every invocation ----
    if (loaded.readError) return this.stopped(jobId, owner, { status: "skipped", reasonCode: "settings_unavailable", message: "extraction settings could not be read; the job stopped" }, stepsRun);
    if (!loaded.settings.enabled) return this.stopped(jobId, owner, { status: "skipped", reasonCode: "disabled", message: "rubric extraction is switched off; the job stopped" }, stepsRun);

    // ---- the pinned sources must still be the current ones ----
    const stale = await this.staleSources(job);
    if (stale.length > 0) return this.stopped(jobId, owner, { status: "skipped", reasonCode: "sources_changed", message: "a source changed while the job was running; no version was written (the change starts a new job)" }, stepsRun);

    // ---- rebuild the run from the pinned snapshots, and replay the stored steps ----
    const ctx = await this.service.buildRunContext(job.sources, job.pinned, job.routeName);
    const refs = chunkRefsOf(ctx.chunks);
    if (refs.length !== job.chunkRefs.length || refs.some((r, i) => r !== job.chunkRefs[i])) {
      return this.stopped(jobId, owner, { status: "failed", reasonCode: "plan_changed", message: "the stored text no longer cuts into the same parts as when the job started; start a new draft" }, stepsRun);
    }
    const steps = await this.jobs.readSteps(jobId);
    // (#220) The sources whose chunks get a translation step.
    const translateIds = translateSourceIdsOf(job.sources);
    let replay = replaySteps(ctx.chunks, steps, translateIds);

    // ---- run steps while the invocation has time ----
    for (;;) {
      if (replay.next === null) return await this.finalize(job, owner, ctx, replay, stepsRun);
      const optional = replay.next.phase === "translate";

      // A new step starts only if a whole request timeout still fits before
      // the deadline, so a call is never started that the function's cut-off
      // could kill mid-flight. The first step of an invocation always runs
      // (otherwise a timeout longer than the budget would never progress).
      if (stepsRun > 0 && this.clock() + job.pinned.requestTimeoutMs > deadlineAt) return await this.handOver(jobId, owner, stepsRun);

      const ref = replay.next;
      const chunk = ctx.chunks[ref.position];
      const stepId = stepIdOf(ref.position, ref.phase);

      // ---- begin: re-check the lease, the cancel flag and the cap; mark the call in flight ----
      const begun = await this.begin(jobId, owner, stepId, optional);
      if (begun.kind === "stopped") return { kind: "finished", status: begun.status, stepsRun, reasonCode: begun.reasonCode };
      const cur = begun.job;
      // (#220) The request cap is used up and this step is the OPTIONAL translation: store it as skipped
      // (no call) so the job moves on to its version. A translation never ends the job.
      if (begun.kind === "cap_skip") {
        const skipped: TranslateStepResult = { translations: {}, outcome: "skipped_cap" };
        const done = await this.storeStep(jobId, owner, { stepId, ref, chunk, result: skipped, usage: emptyUsage(), failed: 0, chunkFinished: true });
        if (!done) return { kind: "lease_lost", stepsRun };
        stepsRun += 1;
        report(stepsRun);
        steps.set(stepId, done);
        replay = replaySteps(ctx.chunks, steps, translateIds);
        continue;
      }

      // ---- the call: exactly one model call (plus a deadline-aware retry) ----
      const usage = emptyUsage();
      const attempts: CallAttempts = { failed: 0, cap: Math.max(1, cur.pinned.maxRequestsPerRun - cur.usage.requests - cur.failedAttempts) };
      const failuresSoFar = cur.stepFailure.stepId === stepId ? cur.stepFailure.count : 0;
      const maxAttempts = Math.max(1, Math.min(MAX_CALL_ATTEMPTS, cur.pinned.stepAttemptsMax - failuresSoFar));
      let result: ChunkAssessment | TranslateStepResult;
      try {
        const callOpts = { deadlineAt, nowMs: () => this.clock(), ...(this.deps.sleep ? { sleep: this.deps.sleep } : {}), maxAttempts };
        if (ref.phase === "translate") {
          // (#220) Never throws, never fails the job: a failure is stored as the step's result.
          result = await this.service.runTranslateStep(ctx, chunk, ref.assessment as ChunkAssessment, usage, attempts, callOpts).catch((): TranslateStepResult => ({ translations: {}, outcome: "failed", reason: "unexpected_error" }));
        } else {
          result = ref.phase === "criteria"
            ? await this.service.runCriteriaStep(ctx, chunk, usage, attempts, callOpts)
            : await this.service.runIntakeStep(ctx, chunk, ref.criteriaPart as ChunkAssessment, [...replay.known.values()], usage, attempts, callOpts);
        }
      } catch (err) {
        report(stepsRun);
        if (err instanceof RunStop) return await this.recordFailure(jobId, owner, err.reasonCode, err.message, { usage, failed: attempts.failed }, stepsRun);
        const message = describeAnthropicError(err).slice(0, 300);
        return await this.recordFailure(jobId, owner, "unexpected_error", message, { usage, failed: attempts.failed }, stepsRun);
      }

      // ---- store the result and the counters in ONE transaction ----
      // A chunk is finished by its last step: the translation when it has one, else the intake, else a
      // criteria step that accepted no rule (it has no second call).
      const chunkFinished = ref.phase === "translate" || (ref.phase === "intake" && !translateIds.has(chunk.sourceId)) || (ref.phase === "criteria" && (result as ChunkAssessment).criteria.length === 0);
      const stored = await this.storeStep(jobId, owner, { stepId, ref, chunk, result, usage, failed: attempts.failed, chunkFinished });
      if (!stored) return { kind: "lease_lost", stepsRun };
      stepsRun += 1;
      report(stepsRun);
      steps.set(stepId, stored);
      replay = replaySteps(ctx.chunks, steps, translateIds);
    }
  }

  /** Stop a job for a reason that needs no call; returns the outcome. */
  private async stopped(jobId: string, owner: string, outcome: Outcome, stepsRun: number): Promise<AdvanceOutcome> {
    const ok = await this.finishOwned(jobId, owner, outcome);
    return ok ? { kind: "finished", status: outcome.status, stepsRun, reasonCode: outcome.reasonCode } : { kind: "lease_lost", stepsRun };
  }

  /** The pinned sources whose newest snapshot is no longer the one the job pinned. */
  private async staleSources(job: RubricExtractionJob): Promise<string[]> {
    const now = await this.currentSnapshotIds(job.sourceIds);
    return job.sources.filter((s) => now.get(s.snapshot.sourceId) !== s.snapshot.contentHash).map((s) => s.snapshot.sourceId);
  }

  /**
   * Before a call: in one transaction re-check the lease, obey a cancel
   * request, enforce the request cap across the whole job, and mark the step
   * `inFlight` (see point 4 of the file header).
   */
  private async begin(jobId: string, owner: string, stepId: string, optional = false): Promise<{ kind: "go"; job: RubricExtractionJob } | { kind: "cap_skip"; job: RubricExtractionJob } | { kind: "stopped"; status: JobStatus; reasonCode: string | null }> {
    return this.jobs.runTransaction(async (tx) => {
      const job = await this.readOwned(tx, jobId, owner);
      if (job.cancelRequested) {
        this.finishInTx(tx, job, { status: "cancelled", reasonCode: "cancelled", message: "an admin cancelled the job; the steps already finished are kept" });
        return { kind: "stopped" as const, status: "cancelled" as JobStatus, reasonCode: "cancelled" };
      }
      const used = job.usage.requests + job.failedAttempts;
      // (#220) An OPTIONAL step (the translation) that would pass the cap is skipped, not fatal.
      if (used >= job.pinned.maxRequestsPerRun && optional) return { kind: "cap_skip" as const, job };
      if (used >= job.pinned.maxRequestsPerRun) {
        this.finishInTx(tx, job, { status: "skipped", reasonCode: "run_cap_exceeded", message: `the job used its cap of ${job.pinned.maxRequestsPerRun} model calls; the steps already finished are kept` });
        return { kind: "stopped" as const, status: "skipped" as JobStatus, reasonCode: "run_cap_exceeded" };
      }
      const nowMs = this.clock();
      const next: RubricExtractionJob = { ...job, inFlight: { stepId, startedAtMs: nowMs }, updatedAt: Timestamp.fromMillis(nowMs) };
      tx.update(this.jobs.jobRef(jobId), { inFlight: next.inFlight, updatedAt: next.updatedAt });
      return { kind: "go" as const, job: next };
    });
  }

  /**
   * Store a finished step. ONE transaction: the lease is still ours, the step
   * document is not there yet, then the result, the counters and the cleared
   * `inFlight` are written together, so a result is never stored without its
   * cost counted, nor counted without being stored. Returns null when the lease
   * was lost (the result is dropped: the new owner will make the call again).
   */
  private async storeStep(jobId: string, owner: string, s: { stepId: string; ref: StepRef; chunk: SourceChunk; result: ChunkAssessment | TranslateStepResult; usage: RubricRunUsage; failed: number; chunkFinished: boolean }): Promise<StoredStep | null> {
    const settingsLease = (await (this.deps.loadSettings ?? loadRubricSettings)()).settings.leaseMs;
    try {
      return await this.jobs.runTransaction(async (tx) => {
        const job = await this.readOwned(tx, jobId, owner);
        const existing = await tx.get(this.jobs.stepRef(jobId, s.stepId));
        if (existing.exists) throw new LeaseLost();
        const nowMs = this.clock();
        const step: StoredStep = {
          stepId: s.stepId,
          position: s.ref.position,
          phase: s.ref.phase,
          sourceId: s.chunk.sourceId,
          chunkIndex: s.chunk.chunkIndex,
          result: s.result,
          usage: s.usage,
          failedAttempts: s.failed,
          createdAt: Timestamp.fromMillis(nowMs),
        };
        this.jobs.writeStepInTx(tx, jobId, step);
        const chunkFinished = s.chunkFinished;
        tx.update(this.jobs.jobRef(jobId), {
          // (#220) The translation steps are not in the count made at start (it is an upper bound); never show more done than the maximum.
          stepsMax: Math.max(job.stepsMax, job.stepsDone + 1),
          usage: addUsage(job.usage, s.usage),
          failedAttempts: job.failedAttempts + s.failed,
          stepsDone: job.stepsDone + 1,
          chunksDone: job.chunksDone + (chunkFinished ? 1 : 0),
          stepFailure: { stepId: null, count: 0, lastReason: null },
          inFlight: null,
          leaseUntil: Timestamp.fromMillis(nowMs + settingsLease),
          updatedAt: Timestamp.fromMillis(nowMs),
        });
        return step;
      });
    } catch (err) {
      if (err instanceof LeaseLost) return null;
      throw err;
    }
  }

  /**
   * A step failed (or something unexpected happened while on it). Add what the
   * failed attempt cost, count it against the step, and either fail the job
   * (a failure retrying cannot fix, or the attempts used up) or hand over so
   * the NEXT invocation retries the step.
   */
  private async recordFailure(jobId: string, owner: string, reasonCode: string, message: string, spent: { usage: RubricRunUsage; failed: number } | null, stepsRun: number): Promise<AdvanceOutcome> {
    const transient = reasonCode === "unexpected_error" || (reasonCode === "provider_error" && isTransientProviderError(message));
    try {
      return await this.jobs.runTransaction(async (tx) => {
        const job = await this.readOwned(tx, jobId, owner);
        const stepId = job.inFlight?.stepId ?? job.stepFailure.stepId;
        const same = job.stepFailure.stepId === stepId;
        // Attempts that ended without a usable answer: the ones retried inside
        // the call plus this last one.
        const failedNow = (spent?.failed ?? 0) + 1;
        const count = (same ? job.stepFailure.count : 0) + failedNow;
        const billed: RubricExtractionJob = {
          ...job,
          usage: spent ? addUsage(job.usage, spent.usage) : job.usage,
          // A refused or cut-off answer was received and counted in `usage`;
          // only attempts with no response count here.
          failedAttempts: job.failedAttempts + (spent?.failed ?? 0) + (spent && spent.usage.requests > 0 ? 0 : 1),
          inFlight: null,
          stepFailure: { stepId, count, lastReason: reasonCode },
        };
        if (!transient || count >= job.pinned.stepAttemptsMax) {
          const text = !transient ? message : `a model call failed ${count} times (the limit is ${job.pinned.stepAttemptsMax}): ${message}`;
          this.finishInTx(tx, billed, { status: "failed", reasonCode, message: `${text.slice(0, 400)}. The job stopped with ${job.chunksDone} of ${job.chunks} parts done` });
          console.log(`${TAG} ${jobId}: failed (${reasonCode})`);
          return { kind: "finished", status: "failed", stepsRun, reasonCode } as AdvanceOutcome;
        }
        // Retry in the next invocation: release the lease and wake a worker.
        tx.set(this.jobs.jobRef(jobId), { ...billed, leaseOwner: null, leaseUntil: null, kick: job.kick + 1, updatedAt: this.now() } as unknown as Record<string, unknown>);
        console.warn(`${TAG} ${jobId}: step ${stepId} failed (${reasonCode}), attempt ${count} of ${job.pinned.stepAttemptsMax}; retrying in the next invocation`);
        return { kind: "handed_over", stepsRun } as AdvanceOutcome;
      });
    } catch (err) {
      if (err instanceof LeaseLost) return { kind: "lease_lost", stepsRun };
      throw err;
    }
  }

  /** End of an invocation with work left: release the lease and wake the next worker. */
  private async handOver(jobId: string, owner: string, stepsRun: number): Promise<AdvanceOutcome> {
    try {
      await this.jobs.runTransaction(async (tx) => {
        const job = await this.readOwned(tx, jobId, owner);
        tx.update(this.jobs.jobRef(jobId), { leaseOwner: null, leaseUntil: null, inFlight: null, kick: job.kick + 1, updatedAt: this.now() });
      });
      return { kind: "handed_over", stepsRun };
    } catch (err) {
      if (err instanceof LeaseLost) return { kind: "lease_lost", stepsRun };
      throw err;
    }
  }

  // ============================================
  // The final step
  // ============================================

  /**
   * Every step is stored: merge, validate and write the version, exactly once
   * (point 6 of the file header).
   */
  private async finalize(job: RubricExtractionJob, owner: string, ctx: RunContext, replay: Replay, stepsRun: number): Promise<AdvanceOutcome> {
    const jobId = job.jobId;
    // Do not draft text that is already stale.
    const stale = await this.staleSources(job);
    if (stale.length > 0) return this.stopped(jobId, owner, { status: "skipped", reasonCode: "sources_changed", message: "a source changed while the job was running; no version was written (the change starts a new job)" }, stepsRun);

    const assembled = assembleDraft(
      { routeKey: job.routeKey, countryCode: job.countryCode, visaTypeId: job.visaTypeId, sources: job.sources, sourceSetHash: job.sourceSetHash, model: job.model, runId: job.runId, severityLevels: ctx.severityLevels, chunkCount: ctx.chunks.length, midSentence: ctx.midSentence, createdAt: this.now() },
      replay.parts,
      replay.translations
    );
    if (!assembled.ok) {
      const ok = await this.finishOwned(jobId, owner, { status: "failed", reasonCode: assembled.reasonCode, message: assembled.error, discardedCount: assembled.discardedCount, discardedByReason: assembled.discardedByReason });
      return ok ? { kind: "finished", status: "failed", stepsRun, reasonCode: assembled.reasonCode } : { kind: "lease_lost", stepsRun };
    }
    const { draft, merged, discardedByReason } = assembled;
    const summary = {
      criteriaAccepted: merged.criteria.length,
      specialistKept: merged.criteria.filter((c) => c.applicability === "specialist").length,
      discardedCount: merged.discards.length,
      discardedByReason,
    };

    // The version, the head, the job's completion and the final run record are
    // written in ONE transaction. `guard.read` is the exactly-once check.
    let committed: RubricExtractionJob | null = null;
    const written = await this.store.writePendingVersion(draft, job.sourceIds, {
      force: job.force,
      now: this.now(),
      guard: {
        read: async (tx) => {
          const snap = await tx.get(this.jobs.jobRef(jobId));
          const cur = snap.exists ? (snap.data() as RubricExtractionJob) : null;
          // Still ours, still running, not cancelled, and no version recorded.
          if (!cur || cur.status !== "running" || cur.leaseOwner !== owner || cur.cancelRequested || cur.version !== null) return false;
          committed = cur;
          return true;
        },
        commit: (tx, version) => {
          this.finishInTx(tx, committed as unknown as RubricExtractionJob, { status: "succeeded", reasonCode: null, message: null, version, ...summary });
        },
      },
    });

    if ("guarded" in written) {
      // Nothing was written. Why? Cancelled meanwhile, or another worker
      // finished or took over. Re-read to tell.
      const cur = await this.jobs.getJob(jobId);
      if (cur && cur.status === "running" && cur.leaseOwner === owner && cur.cancelRequested) {
        await this.finishOwned(jobId, owner, { status: "cancelled", reasonCode: "cancelled", message: "an admin cancelled the job before its version was written; no version was written" });
        return { kind: "finished", status: "cancelled", stepsRun, reasonCode: "cancelled" };
      }
      return cur && isTerminalStatus(cur.status) ? { kind: "idle", status: cur.status } : { kind: "lease_lost", stepsRun };
    }
    if (!written.written) {
      // Another run wrote this exact source set while the job was drafting.
      const ok = await this.finishOwned(jobId, owner, { status: "skipped", reasonCode: "source_unchanged", message: "another draft of the same sources was written first; this job wrote nothing", version: written.version, ...summary });
      return ok ? { kind: "finished", status: "skipped", stepsRun, reasonCode: "source_unchanged" } : { kind: "lease_lost", stepsRun };
    }
    console.log(`${TAG} ${jobId}: succeeded, version ${written.version}, accepted=${summary.criteriaAccepted} discarded=${summary.discardedCount}`);
    return { kind: "finished", status: "succeeded", stepsRun, reasonCode: null };
  }

  // ============================================
  // Sweep, cancel, status
  // ============================================

  /**
   * The crash recovery. Any active job with no live lease and no recent
   * progress is kicked, which fires the worker trigger. The sweep itself calls
   * no model and takes no lease (so it needs no secret): it only wakes a worker.
   * A worker that finds nothing to do, or a live lease, simply returns.
   */
  async sweep(): Promise<SweepResult> {
    const settings = (await (this.deps.loadSettings ?? loadRubricSettings)()).settings;
    const active = await this.jobs.listActive();
    let kicked = 0;
    for (const listed of active) {
      const woke = await this.jobs.runTransaction(async (tx) => {
        const snap = await tx.get(this.jobs.jobRef(listed.jobId));
        const job = snap.exists ? (snap.data() as RubricExtractionJob) : null;
        if (!job || isTerminalStatus(job.status)) return false;
        const nowMs = this.clock();
        if (job.leaseUntil && job.leaseUntil.toMillis() > nowMs) return false;
        if (job.updatedAt.toMillis() > nowMs - settings.jobIdleMs) return false;
        tx.update(this.jobs.jobRef(job.jobId), { kick: job.kick + 1, updatedAt: Timestamp.fromMillis(nowMs) });
        return true;
      });
      if (woke) kicked += 1;
    }
    return { considered: active.length, kicked };
  }

  /**
   * Cancel a job. A job nobody is working on is cancelled at once; a job with
   * a live worker gets the flag, which the worker obeys before its next step
   * (the call in flight is allowed to finish and is kept). A finished job is
   * left as it is. A cancelled job writes no version.
   */
  async cancel(jobId: string, requestedBy: string | null): Promise<JobView | null> {
    const job = await this.jobs.runTransaction(async (tx) => {
      const snap = await tx.get(this.jobs.jobRef(jobId));
      if (!snap.exists) return null;
      const cur = snap.data() as RubricExtractionJob;
      if (isTerminalStatus(cur.status)) return cur;
      const idle = !cur.leaseUntil || cur.leaseUntil.toMillis() <= this.clock();
      if (idle) return this.finishInTx(tx, cur, { status: "cancelled", reasonCode: "cancelled", message: "an admin cancelled the job; the steps already finished are kept" }, { cancelRequested: true, cancelRequestedBy: requestedBy });
      tx.update(this.jobs.jobRef(jobId), { cancelRequested: true, cancelRequestedBy: requestedBy, updatedAt: this.now() });
      return { ...cur, cancelRequested: true, cancelRequestedBy: requestedBy };
    });
    return job ? this.viewOf(job) : null;
  }

  /** The status of a job, or null. */
  async getStatus(jobId: string): Promise<JobView | null> {
    const job = await this.jobs.getJob(jobId);
    return job ? this.viewOf(job) : null;
  }

  /** The admin-facing view of a job: no pinned internals, ISO dates. */
  private viewOf(job: RubricExtractionJob): JobView {
    return {
      jobId: job.jobId,
      routeKey: job.routeKey,
      status: job.status,
      reasonCode: job.reasonCode,
      message: job.message,
      trigger: job.trigger,
      force: job.force,
      chunks: job.chunks,
      chunksDone: job.chunksDone,
      stepsDone: job.stepsDone,
      stepsMax: job.stepsMax,
      usage: job.usage,
      failedAttempts: job.failedAttempts,
      costUsd: job.usage.requests > 0 ? costOfUsage("judgement", job.usage) : null,
      cancelRequested: job.cancelRequested,
      version: job.version,
      criteriaAccepted: job.criteriaAccepted,
      specialistKept: job.specialistKept,
      discardedCount: job.discardedCount,
      discardedByReason: job.discardedByReason,
      plan: job.plan,
      sourceSnapshots: job.sources.map((s) => ({ sourceId: s.snapshot.sourceId, contentHashPrefix: s.snapshot.contentHash.slice(0, 12) })),
      createdAt: job.createdAt.toDate().toISOString(),
      updatedAt: job.updatedAt.toDate().toISOString(),
      finishedAt: job.finishedAt ? job.finishedAt.toDate().toISOString() : null,
    };
  }
}

/** Singleton over the real provider, bucket and Firestore. */
export const rubricExtractionJobService = new RubricExtractionJobService();

/** Which phase a step id names (for logs and tests). */
export function phaseOfStepId(stepId: string): StepPhase {
  return stepId.endsWith("__intake") ? "intake" : stepId.endsWith("__translate") ? "translate" : "criteria";
}
