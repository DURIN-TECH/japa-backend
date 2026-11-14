import type { Timestamp, Transaction } from "firebase-admin/firestore";
import { collections, db, subcollections } from "../../utils/firebase";
import type { RubricRunUsage } from "../../types/rubric";
import type { ChunkAssessment, LoadedSource, PlannedSource, RunSettingsPin, TranslateStepResult } from "./rubric-extraction.service";

// ============================================
// RUBRIC DRAFTING JOB — TYPES AND FIRESTORE STORE (issue #216)
// ============================================
//
// Layout (all backend-only: no firestore.rules match, clients are denied):
//
//   rubricExtractionJobs/{jobId}                         the job (RubricExtractionJob)
//   rubricExtractionJobs/{jobId}/steps/{stepId}          the result of one finished step
//   rubricExtractionJobs/{jobId}/stepParts/{stepId}__{n} overflow of a very large result
//
// WHAT A STEP IS. One model call and the validation of its answer in code:
//   `c{position}__criteria`   call 1 of a chunk (reads the rules)
//   `c{position}__intake`     call 2 of a chunk (reads the questions and the
//                             document items for the rules call 1 produced;
//                             a chunk whose call 1 produced no rule has none)
//   `c{position}__translate`  (#220) the unofficial translation of the quotes of
//                             the rules the chunk produced, only for a chunk of
//                             a source whose language is not the product
//                             language. It is OPTIONAL by design: it is stored
//                             whether it worked, failed or was skipped (the
//                             request cap), so a translation can never stop or
//                             fail the job, and is never paid for twice.
// `position` is the chunk's place in document order (sources sorted by id,
// chunk index ascending), zero padded so the ids sort in run order.
//
// WHAT IS STORED, AND WHY IT IS ENOUGH. Only the validated `ChunkAssessment`
// of each step, as a JSON STRING. The source text is NOT stored: the job pins
// each source by its content hash, snapshots are immutable and addressed by
// that hash, and the cut into chunks is a pure function of the text and the
// chunk size. So every invocation rebuilds the same chunks and the same quote
// indexes from the pinned snapshots, reads the stored step results, and knows
// exactly where the run stands. The step results are all the model ever
// produced; they are what must never be paid for twice.
//
// WHY A JSON STRING. A result holds optional fields, nested arrays and values
// of mixed type. Firestore refuses `undefined`, arrays inside arrays and a few
// other shapes, and silently drops nothing: a string round-trips exactly the
// bytes `JSON.stringify` wrote, and `JSON.parse` gives back the same data the
// one-shot path would hold in memory (a property that is absent stays absent).
//
// DOCUMENT SIZE. A Firestore document holds at most 1 MiB. One chunk's
// validated result is bounded by the model's output cap (`maxOutputTokens
// PerRequest`) plus the citation fields code adds, so it normally fits in one
// document by a wide margin. It is stored in Firestore (not Cloud Storage) on
// purpose: the step result must commit in the SAME transaction as the job's
// counters (that is what makes "paid once, counted once" true), and a Storage
// object cannot join a Firestore transaction. For the rare larger result the
// string is SPLIT over `stepParts` documents written in the same transaction
// (never truncated, never dropped: a rule must not be lost for size).

/** Status of a drafting job. `queued` and `running` are the active ones. */
export const JOB_STATUSES = ["queued", "running", "succeeded", "failed", "cancelled", "skipped"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** The statuses a job can still change out of. */
export const ACTIVE_JOB_STATUSES: readonly JobStatus[] = ["queued", "running"];

/** True for a status the job can no longer leave on its own. */
export function isTerminalStatus(status: JobStatus): boolean {
  return !ACTIVE_JOB_STATUSES.includes(status);
}

/** The two kinds of step (see the file header). */
export type StepPhase = "criteria" | "intake" | "translate";

/** Which step comes next (derived from the stored results, never trusted from the cursor). */
export interface StepRef {
  // Position of the chunk in document order.
  position: number;
  phase: StepPhase;
}

/** Id of a step: sorts in run order. */
export function stepIdOf(position: number, phase: StepPhase): string {
  return `c${String(position).padStart(4, "0")}__${phase}`;
}

/**
 * The failures of the step the job is currently on. Only ONE step is ever
 * current (steps run strictly in order), so one counter is enough, and it
 * resets as soon as a step succeeds.
 */
export interface StepFailure {
  stepId: string | null;
  // Failed attempts of that step, across invocations.
  count: number;
  // The reason code of the latest one (an existing `RunStop` code).
  lastReason: string | null;
}

/** `rubricExtractionJobs/{jobId}`. */
export interface RubricExtractionJob {
  jobId: string;
  routeKey: string;
  countryCode: string;
  visaTypeId: string;
  status: JobStatus;
  // Machine-readable reason for failed / skipped / cancelled (an existing run
  // stop code such as `provider_error`, `run_cap_exceeded`, or `cancelled`).
  reasonCode: string | null;
  // The same in plain words, for the admin who reads the status.
  message: string | null;
  trigger: "manual" | "guidance_changed" | "pending_sweep";
  // Write a new version even when the sources are the ones of the newest one.
  force: boolean;
  // Who started it (an admin's uid), or null for the automatic re-draft.
  requestedBy: string | null;
  // The run record's id and the id stored on the version it writes. It is the
  // job id: deterministic, so a duplicate start can never open a second run.
  runId: string;
  // ---- inputs, PINNED when the job started ----
  sourceIds: string[];
  sources: LoadedSource[];
  sourceSetHash: string;
  model: string;
  promptVersion: string;
  routeName: string;
  pinned: RunSettingsPin & { stepAttemptsMax: number };
  plan: PlannedSource[];
  // Fingerprint of every chunk (`sourceId#chunkIndex#characters`), so a change
  // in how text is cut is noticed instead of misaligning stored results.
  chunkRefs: string[];
  // ---- progress ----
  chunks: number;
  // Upper bound: two calls per chunk (a chunk with no accepted rule has one).
  stepsMax: number;
  stepsDone: number;
  chunksDone: number;
  usage: RubricRunUsage;
  // Model attempts that ended without a usable answer (counted against the cap).
  failedAttempts: number;
  stepFailure: StepFailure;
  // Set just before a model call, cleared when its result is stored. Still set
  // when a worker claims the job = the previous worker died mid-call.
  inFlight: { stepId: string; startedAtMs: number } | null;
  // ---- control ----
  cancelRequested: boolean;
  cancelRequestedBy: string | null;
  leaseOwner: string | null;
  leaseUntil: Timestamp | null;
  // Bumped to wake a worker (the worker trigger fires when it changes).
  kick: number;
  // ---- outcome ----
  version: number | null;
  criteriaAccepted: number;
  specialistKept: number;
  discardedCount: number;
  discardedByReason: Record<string, number>;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  expiresAt: Timestamp;
  finishedAt: Timestamp | null;
}

/** One finished step, as stored. */
export interface StoredStep {
  stepId: string;
  position: number;
  phase: StepPhase;
  sourceId: string;
  chunkIndex: number;
  // The validated result of the step's model call (a `translate` step stores a TranslateStepResult).
  result: ChunkAssessment | TranslateStepResult;
  // Tokens and attempts this step cost (already added to the job's counters).
  usage: RubricRunUsage;
  failedAttempts: number;
  createdAt: Timestamp;
}

/**
 * Characters of a stored result kept in one document. A document holds 1 MiB
 * of UTF-8, and a character takes at most four bytes, so 150,000 characters
 * stay under 600 KB even for text that is all four-byte characters, leaving
 * room for the header fields.
 */
export const STEP_DOC_CHARS = 150_000;

/** The header of a step document (the result lives in `data`, or in `stepParts` when `parts > 1`). */
interface StepDoc extends Omit<StoredStep, "result"> {
  parts: number;
  data?: string;
}

export class RubricExtractionJobStore {
  // Transaction runner; a property so tests can swap in an in-memory one.
  runTransaction: <T>(fn: (tx: Transaction) => Promise<T>) => Promise<T> = (fn) => db.runTransaction(fn);

  /** Ref of a job document. */
  jobRef(jobId: string) {
    return collections.rubricExtractionJobs.doc(jobId);
  }

  /** One job, or null. */
  async getJob(jobId: string): Promise<RubricExtractionJob | null> {
    const snap = await this.jobRef(jobId).get();
    return snap.exists ? (snap.data() as RubricExtractionJob) : null;
  }

  /** Every job that has not finished (a handful at any time: one per route being drafted). */
  async listActive(): Promise<RubricExtractionJob[]> {
    const snap = await collections.rubricExtractionJobs.where("status", "in", [...ACTIVE_JOB_STATUSES]).get();
    return snap.docs.map((d) => d.data() as RubricExtractionJob);
  }

  /**
   * Add a step's result to a transaction: the header document and, for a very
   * large result, its overflow parts. The caller has already read the step
   * document in the same transaction (to know it is not there yet).
   */
  writeStepInTx(tx: Transaction, jobId: string, step: StoredStep): void {
    const json = JSON.stringify(step.result);
    const pieces: string[] = [];
    for (let at = 0; at < json.length; at += STEP_DOC_CHARS) pieces.push(json.slice(at, at + STEP_DOC_CHARS));
    if (pieces.length === 0) pieces.push("");
    // The header is the step without its result (the result goes in `data` / the parts).
    const header: Omit<StoredStep, "result"> = { stepId: step.stepId, position: step.position, phase: step.phase, sourceId: step.sourceId, chunkIndex: step.chunkIndex, usage: step.usage, failedAttempts: step.failedAttempts, createdAt: step.createdAt };
    const doc: StepDoc = pieces.length === 1 ? { ...header, parts: 1, data: pieces[0] } : { ...header, parts: pieces.length };
    tx.set(subcollections.rubricExtractionSteps(jobId).doc(step.stepId), doc as unknown as Record<string, unknown>);
    if (pieces.length > 1) {
      pieces.forEach((data, n) => tx.set(subcollections.rubricExtractionStepParts(jobId).doc(`${step.stepId}__${n}`), { stepId: step.stepId, n, data }));
    }
  }

  /** Ref of a step document (for the transaction's existence read). */
  stepRef(jobId: string, stepId: string) {
    return subcollections.rubricExtractionSteps(jobId).doc(stepId);
  }

  /** Every stored step of a job, by id, with large results put back together. */
  async readSteps(jobId: string): Promise<Map<string, StoredStep>> {
    const snap = await subcollections.rubricExtractionSteps(jobId).get();
    const out = new Map<string, StoredStep>();
    for (const d of snap.docs) {
      const doc = d.data() as StepDoc;
      let json = doc.data;
      if (doc.parts > 1) {
        const pieces: string[] = [];
        for (let n = 0; n < doc.parts; n++) {
          const part = await subcollections.rubricExtractionStepParts(jobId).doc(`${doc.stepId}__${n}`).get();
          pieces.push(((part.data() as { data?: string } | undefined)?.data) ?? "");
        }
        json = pieces.join("");
      }
      out.set(doc.stepId, {
        stepId: doc.stepId,
        position: doc.position,
        phase: doc.phase,
        sourceId: doc.sourceId,
        chunkIndex: doc.chunkIndex,
        usage: doc.usage,
        failedAttempts: doc.failedAttempts,
        createdAt: doc.createdAt,
        result: JSON.parse(json ?? "null") as ChunkAssessment | TranslateStepResult,
      });
    }
    return out;
  }
}

/** Singleton over the project's Firestore. */
export const rubricExtractionJobStore = new RubricExtractionJobStore();
