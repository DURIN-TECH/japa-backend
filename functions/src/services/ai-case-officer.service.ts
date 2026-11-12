import { Timestamp, type Transaction } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { collections, db } from "../utils/firebase";
import { rubricRouteKey, rubricStore, type VisaRubric } from "../scrapers";
import type { Application, Document, DocumentInstance, EligibilityCheck, ProseMirrorDoc, User } from "../types";
import { buildCountryContext, type CountryContextResult } from "./outcome-statistics/country-context";
import type {
  ApplicationAssessment,
  AssessmentErrorCode,
  AssessmentStatus,
  AssessmentTrigger,
  AssessmentUsage,
  AvailableCountryContext,
} from "../types/assessment";
import {
  assembleContent,
  assessmentIdFor,
  buildJudgementRequest,
  computeInputHash,
  deriveHolderFact,
  documentFieldsFor,
  evaluateObjective,
  extractionIsSuspicious,
  hashStatementContent,
  judgementCriteriaOf,
  mandatoryBarHits,
  numberStatementBlocks,
  parseExtraction,
  parseJudgement,
  topIssuesOf,
  type AssessmentContent,
  type AssessmentInputs,
  type DocumentExtraction,
  type Facts,
  type JudgementOutput,
} from "./ai/assessment-engine";
import { extractOneDocument, sniffMediaType } from "./ai/document-extraction";
import { costOfUsage } from "./ai/ai-pricing";
import { readAiSettings, type AiSettings, type AiSettingsRead } from "./ai/ai-settings";
import { AnthropicLlmProvider, type LlmProvider, type LlmUsage } from "./ai/llm-provider";
import { ASSESSMENT_PROMPT_VERSION, findInjectionSignals } from "./ai/prompt-safety";
import type { AssessmentTier, StaleReason } from "./ai/tier-serializer";
import { aiActionService } from "./ai-action.service";

// ============================================
// AI CASE-OFFICER ASSESSMENT — JOB AND I/O (issue #42)
// ============================================
//
// The engine itself is pure and lives in services/ai/assessment-engine.ts. This
// file does the I/O around it and runs the job in three stages, cheapest and
// most certain first:
//
//   stage 1  mandatory bars   code only, ZERO model calls; a hit short-circuits
//   stage 2  objective        one extraction call per document (values only);
//                             CODE evaluates every check
//   stage 3  judgement        one call over the statement, profile, intake and
//                             the stage 2 values; findings are concerns only
//
// THE JOB. A request writes `applicationAssessments/{id}` with status `queued`;
// the id is derived from the inputs, so a second request for the same inputs
// finds the same document and starts nothing. The Firestore-triggered worker
// (index.ts, processAssessmentJob) calls `runJob`, which claims the document
// `queued -> running` in a transaction. No response is ever streamed.
//
// THE CAPS. Checked before each model call (ai-settings.ts). A job that would
// pass a cap fails with its code instead of running unbounded.
//
// NOTHING ELSE SENDS. Model output is never used as a storage path, a user id,
// an application id or a criterion that the rubric does not contain.

/** Fixed time budget for the whole job, under the worker's 540 s timeout. */
const JOB_BUDGET_MS = 480_000;
/** No judgement call starts after this much time has gone. */
const JUDGEMENT_START_LIMIT_MS = 360_000;

/** A job failure with a stable code. Caught by runJob, which stores it. */
class JobStop extends Error {
  constructor(
    readonly code: AssessmentErrorCode,
    message: string
  ) {
    super(message);
    this.name = "JobStop";
  }
}

/** The approved-rubric read the service needs. Injected so tests can swap it. */
export interface RubricReader {
  getApprovedRubric(countryCode: string, visaTypeId: string): Promise<VisaRubric | null>;
  approvedVersionOf(countryCode: string, visaTypeId: string): Promise<number | null>;
}

/** Everything the service reaches outside Firestore. Injected for tests. */
export interface AssessmentDeps {
  provider: LlmProvider;
  rubrics: RubricReader;
  loadBytes(storagePath: string): Promise<Buffer>;
  runTransaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>;
  readSettings(): Promise<AiSettingsRead>;
  now(): Date;
  // Country-context lookup (#116). Optional so existing fakes keep working;
  // defaults to the real builder. Reads published statistics only, no model.
  buildCountryContext?: (input: Parameters<typeof buildCountryContext>[0]) => Promise<CountryContextResult>;
}

/** What a POST resolved to. */
export type RequestOutcome =
  | { kind: "no_rubric"; routeKey: string }
  | { kind: "upgrade_required" }
  // Only when the caller set `maxAttempts` (the #117 auto-run): the failed job
  // for these inputs has used its attempts, so it is NOT queued again.
  | { kind: "attempts_exhausted"; assessmentId: string }
  | { kind: "stored" | "running" | "queued" | "created"; assessmentId: string; status: AssessmentStatus; rubricVersion: number };

/** Inputs the job and the request both read, loaded once. */
export interface LoadedInputs {
  applicantName: string | null;
  nationality: string | null;
  eligibilityScore: number | null;
  eligibilityAnswers: Record<string, unknown> | null;
  intake: Record<string, unknown>;
  documents: Array<{ id: string; path: string; updatedAtMs: number; sizeMb: number; label: string }>;
  // `blocks` is one plain-text string per TOP-LEVEL ProseMirror block, in
  // document order (index = the block's index in `content`); `contentHash`
  // hashes the content itself so the input hash ignores bare version bumps.
  statements: Array<{ instanceId: string; version: number; text: string; blocks: string[]; contentHash: string }>;
}

/** Statement categories that count as a statement. Template-level, never free text. */
const STATEMENT_CATEGORIES = new Set(["sop", "cover_letter"]);

/** Read the plain text out of a ProseMirror document, depth first. */
function plainTextOf(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const n = node as { text?: unknown; content?: unknown };
  const own = typeof n.text === "string" ? n.text : "";
  const kids = Array.isArray(n.content) ? n.content.map(plainTextOf).join(n.content.length ? " " : "") : "";
  return `${own}${kids ? ` ${kids}` : ""}`.replace(/\s+/g, " ").trim();
}

// Re-exported from the shared extraction module so existing imports keep working.
export { sniffMediaType };

/** A blank usage record. Exported for the bulk path (#37). */
export function zeroUsage(): AssessmentUsage {
  return { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

/** Add one call's usage to a total. Exported for the bulk path (#37). */
export function addUsage(total: AssessmentUsage, u: LlmUsage): AssessmentUsage {
  return {
    requests: total.requests + 1,
    inputTokens: total.inputTokens + u.inputTokens,
    outputTokens: total.outputTokens + u.outputTokens,
    cacheReadTokens: total.cacheReadTokens + u.cacheReadTokens,
    cacheWriteTokens: total.cacheWriteTokens + u.cacheWriteTokens,
  };
}

/** The UTC day key used for the daily cap. */
export function dayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** ISO date (YYYY-MM-DD) for the bar comparison. */
function isoDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * The date a mandatory bar is checked against.
 *
 * - `submittedAt`, when the application has one: a rule in force when the
 *   applicant applied governs their application, so a rule change after
 *   submission must not change a re-run's outcome.
 * - Otherwise the ASSESSMENT date (`now`). Never `startDate`: that is when the
 *   draft was created, not when the application is made, and a bar that came
 *   into force after a long-lived draft was started would be silently skipped.
 *
 * It never returns "no date". Skipping a mandatory bar because a date is
 * missing would tell an applicant nothing blocks them when something may; the
 * safe direction is to check the bar against today. (A missing or malformed
 * `submittedAt` therefore also falls back to `now`.)
 */
export function barDateOf(app: Pick<Application, "submittedAt">, now: Date): string {
  const ts = app.submittedAt as { toDate?: () => Date } | undefined;
  if (ts && typeof ts.toDate === "function") {
    const d = ts.toDate();
    if (d instanceof Date && !Number.isNaN(d.getTime())) return isoDate(d);
  }
  return isoDate(now);
}

/** The default deps: Firestore, Cloud Storage, the Anthropic provider and the settings doc. */
function defaultDeps(): AssessmentDeps {
  return {
    provider: new AnthropicLlmProvider(),
    rubrics: {
      getApprovedRubric: (cc, vt) => rubricStore.getApprovedRubric(cc, vt),
      async approvedVersionOf(cc, vt) {
        const head = await rubricStore.getHead(rubricRouteKey(cc, vt));
        return head?.approvedVersion ?? null;
      },
    },
    loadBytes: async (storagePath) => {
      const [bytes] = await getStorage().bucket().file(storagePath).download();
      return bytes;
    },
    runTransaction: (fn) => db.runTransaction(fn),
    readSettings: readAiSettings,
    now: () => new Date(),
  };
}

/** A blank stored record, before the job has run. */
export function newAssessmentDoc(args: {
  id: string;
  app: Application;
  rubricVersion: number;
  inputHash: string;
  trigger: AssessmentTrigger;
  requestedBy: string;
  now: Date;
}): ApplicationAssessment {
  return {
    id: args.id,
    applicationId: args.app.id,
    userId: args.app.userId,
    agencyId: args.app.agencyId ?? null,
    countryCode: args.app.countryCode,
    visaTypeId: args.app.visaTypeId,
    rubricVersion: args.rubricVersion,
    inputHash: args.inputHash,
    model: null,
    createdAt: Timestamp.fromDate(args.now),
    status: "queued",
    error: null,
    attempt: 1,
    trigger: args.trigger,
    requestedBy: args.requestedBy,
    startedAt: null,
    finishedAt: null,
    stageOutcomes: { mandatoryBar: "not_applicable", objective: "not_applicable", judgement: "not_run", credibility: "clear" },
    score: null,
    readiness: null,
    refusalGrounds: [],
    credibilityFlags: [],
    strengths: [],
    statementFindings: [],
    statement: null,
    insufficientInformation: [],
    suspiciousContent: [],
    confidence: null,
    topIssues: [],
    hasBlockingRule: false,
    internalCall: null,
    models: { extract: null, judge: null },
    promptVersion: ASSESSMENT_PROMPT_VERSION,
    usage: { extract: zeroUsage(), judge: zeroUsage() },
    costUsd: null,
  };
}

export class AiCaseOfficerService {
  constructor(private readonly deps: AssessmentDeps = defaultDeps()) {}

  // ----------------------------------------------------------------
  // Inputs
  // ----------------------------------------------------------------

  /**
   * Load every input the assessment reads. Applicant-derived strings are only
   * ever passed on wrapped in delimiters (services/ai/prompt-safety.ts).
   */
  // Public since #37: the bulk re-assessment service reads the same inputs.
  async loadInputs(app: Application): Promise<LoadedInputs> {
    const userSnap = await collections.users.doc(app.userId).get();
    const user = userSnap.exists ? (userSnap.data() as User) : null;
    const applicantName = user ? `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim() || null : null;

    const checkSnap = await collections.eligibilityChecks
      .where("userId", "==", app.userId)
      .where("visaTypeId", "==", app.visaTypeId)
      .orderBy("createdAt", "desc")
      .limit(1)
      .get();
    const check = checkSnap.empty ? null : ({ id: checkSnap.docs[0].id, ...checkSnap.docs[0].data() } as EligibilityCheck & { id: string });
    const nationality = check && /^[A-Z]{2}$/.test(check.nationality ?? "") ? check.nationality : null;
    const eligibilityAnswers = check
      ? Object.fromEntries(
        (check.answers ?? []).map((a) => [String((a as { questionId: string }).questionId), (a as { answer?: unknown }).answer ?? null])
      )
      : null;

    const docSnap = await collections.documents.where("applicationId", "==", app.id).get();
    // A refusal letter (issue #122) is read by its own analysis, never by the
    // assessment: leave it out, so it is not sent to extraction here and
    // uploading one does not change the assessment's input hash.
    const documents = docSnap.docs.filter((d) => (d.data() as Document).requirementId !== "refusal-letter").map((d) => {
      const data = d.data() as Document;
      return {
        id: d.id,
        path: data.storageUrl,
        updatedAtMs: data.updatedAt ? data.updatedAt.toMillis() : 0,
        sizeMb: data.fileSizeMb ?? 0,
        label: data.documentType ?? data.displayName ?? "document",
      };
    });
    documents.sort((a, b) => (a.id < b.id ? -1 : 1));

    const instanceSnap = await collections.documentInstances.where("applicationId", "==", app.id).get();
    const statements: LoadedInputs["statements"] = [];
    for (const d of instanceSnap.docs) {
      const inst = d.data() as DocumentInstance;
      const tpl = inst.templateId ? await collections.documentTemplates.doc(inst.templateId).get() : null;
      const category = tpl && tpl.exists ? (tpl.data() as { category?: string }).category : undefined;
      if (!category || !STATEMENT_CATEGORIES.has(category)) continue;
      const doc = inst.content as ProseMirrorDoc | undefined;
      // Top-level children only: the portal resolves `nodePath: [i]` as
      // doc.content[i], so the numbering must use exactly this array.
      const top = doc && Array.isArray((doc as { content?: unknown }).content) ? ((doc as { content: unknown[] }).content) : [];
      statements.push({
        instanceId: d.id,
        version: inst.version ?? 0,
        text: plainTextOf(doc),
        blocks: top.map((b) => plainTextOf(b)),
        contentHash: hashStatementContent(doc ?? null),
      });
    }
    statements.sort((a, b) => (a.instanceId < b.instanceId ? -1 : 1));

    const intake = ((app as Application & { intake?: Record<string, unknown> }).intake ?? {}) as Record<string, unknown>;

    return {
      applicantName,
      nationality,
      eligibilityScore: check && typeof check.score === "number" ? check.score : null,
      eligibilityAnswers,
      intake,
      documents,
      statements,
    };
  }

  /** The hash inputs for a loaded set and rubric version. */
  // Public since #37 (bulk re-assessment recomputes the same hash).
  inputsFor(loaded: LoadedInputs, rubricVersion: number): AssessmentInputs {
    return {
      rubricVersion,
      documents: loaded.documents.map((d) => ({ path: `${d.id}:${d.path}`, updatedAtMs: d.updatedAtMs })),
      statements: loaded.statements.map((s) => ({ instanceId: s.instanceId, contentHash: s.contentHash })),
      eligibilityAnswers: loaded.eligibilityAnswers,
      intake: loaded.intake,
    };
  }

  // ----------------------------------------------------------------
  // Request (the POST path and the status trigger)
  // ----------------------------------------------------------------

  /**
   * Ask for an assessment of an application against its approved rubric.
   *
   *  - no approved rubric for the route: `no_rubric` (never a partial result);
   *  - the same inputs already stored: their status (`stored`, `running`, `queued`);
   *  - a re-run whose inputs changed, by a free caller: `upgrade_required`;
   *  - a failed job with the same inputs: queued again, in the same document;
   *  - otherwise a new `queued` document.
   *
   * `tier` is decided by the handler from the caller's entitlement. The status
   * trigger passes "full": it is the system, not an applicant's request.
   */
  async requestAssessment(
    app: Application,
    opts: { tier: AssessmentTier; trigger: AssessmentTrigger; requestedBy: string; maxAttempts?: number }
  ): Promise<RequestOutcome> {
    const rubric = await this.deps.rubrics.getApprovedRubric(app.countryCode, app.visaTypeId);
    if (!rubric) return { kind: "no_rubric", routeKey: rubricRouteKey(app.countryCode, app.visaTypeId) };

    const loaded = await this.loadInputs(app);
    const inputHash = computeInputHash(this.inputsFor(loaded, rubric.version));
    const assessmentId = assessmentIdFor(app.id, inputHash);
    const now = this.deps.now();

    // A re-run by a free caller needs a previous result for a DIFFERENT input set.
    const previous = await this.latestSucceeded(app.id);
    const isRerunOfChanged = previous !== null && previous.inputHash !== inputHash;

    const outcome = await this.deps.runTransaction(async (tx): Promise<RequestOutcome> => {
      const ref = collections.applicationAssessments.doc(assessmentId);
      const snap = await tx.get(ref);
      if (snap.exists) {
        const cur = snap.data() as ApplicationAssessment;
        if (cur.status === "succeeded") return { kind: "stored", assessmentId, status: cur.status, rubricVersion: cur.rubricVersion };
        if (cur.status === "queued" || cur.status === "running") {
          return { kind: cur.status, assessmentId, status: cur.status, rubricVersion: cur.rubricVersion };
        }
        // Failed: a retry on the same inputs is free on both tiers, unless the
        // caller caps attempts (#117 auto-run: one automatic retry, then stop).
        if (opts.maxAttempts !== undefined && (cur.attempt ?? 1) >= opts.maxAttempts) {
          return { kind: "attempts_exhausted", assessmentId };
        }
        tx.update(ref, {
          status: "queued",
          error: null,
          attempt: (cur.attempt ?? 1) + 1,
          trigger: opts.trigger,
          requestedBy: opts.requestedBy,
          // A failed BULK job retried by a person runs on the interactive path
          // (the interactive worker skips viaBatch jobs), and leaves its batch.
          viaBatch: false,
          batchId: null,
          batchPhase: null,
          startedAt: null,
          finishedAt: null,
        });
        return { kind: "queued", assessmentId, status: "queued", rubricVersion: rubric.version };
      }
      if (opts.tier === "free" && isRerunOfChanged) return { kind: "upgrade_required" };
      tx.set(
        ref,
        newAssessmentDoc({ id: assessmentId, app, rubricVersion: rubric.version, inputHash, trigger: opts.trigger, requestedBy: opts.requestedBy, now })
      );
      return { kind: "created", assessmentId, status: "queued", rubricVersion: rubric.version };
    });
    return outcome;
  }

  /** Status-change trigger: enqueue for an application that moved to under review. Never throws. */
  async enqueueForStatusChange(applicationId: string): Promise<void> {
    try {
      const snap = await collections.applications.doc(applicationId).get();
      if (!snap.exists) return;
      const app = { id: snap.id, ...snap.data() } as Application;
      const outcome = await this.requestAssessment(app, { tier: "full", trigger: "status_change", requestedBy: "system" });
      console.log(`[ai-case-officer] status trigger for ${applicationId}: ${outcome.kind}`);
    } catch (err) {
      console.error(`[ai-case-officer] status trigger failed for ${applicationId}: ${(err as Error).name}`);
    }
  }

  // ----------------------------------------------------------------
  // Reads
  // ----------------------------------------------------------------

  /** One stored assessment, or null. The caller checks access on its application. */
  async getById(assessmentId: string): Promise<ApplicationAssessment | null> {
    const snap = await collections.applicationAssessments.doc(assessmentId).get();
    return snap.exists ? (snap.data() as ApplicationAssessment) : null;
  }

  /**
   * The newest assessment for an application, or null.
   *
   * A bulk re-assessment job (#37) that has not succeeded is background work: it
   * may wait hours in a provider batch. It must not hide the applicant's current
   * result, so a `viaBatch` job in any state but `succeeded` is skipped here.
   */
  async latestFor(applicationId: string): Promise<ApplicationAssessment | null> {
    const snap = await collections.applicationAssessments
      .where("applicationId", "==", applicationId)
      .orderBy("createdAt", "desc")
      .limit(10)
      .get();
    for (const d of snap.docs) {
      const a = d.data() as ApplicationAssessment;
      if (a.viaBatch === true && a.status !== "succeeded") continue;
      return a;
    }
    return null;
  }

  /** The newest succeeded assessment for an application, or null (filtered in code). */
  private async latestSucceeded(applicationId: string): Promise<ApplicationAssessment | null> {
    const snap = await collections.applicationAssessments.where("applicationId", "==", applicationId).get();
    const done = snap.docs.map((d) => d.data() as ApplicationAssessment).filter((a) => a.status === "succeeded");
    done.sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0));
    return done[0] ?? null;
  }

  /**
   * Why a stored assessment is out of date, or null when it is current. Done on
   * the server because the client cannot compute the input hash.
   *
   * `inputs_changed` wins: the applicant's own changes are what they can act on.
   * Otherwise `rules_updated` when the approved rubric version differs from the
   * one the assessment used.
   */
  async staleReasonOf(app: Application, assessment: ApplicationAssessment): Promise<StaleReason | null> {
    const loaded = await this.loadInputs(app);
    if (computeInputHash(this.inputsFor(loaded, assessment.rubricVersion)) !== assessment.inputHash) return "inputs_changed";
    const approved = await this.approvedVersionOf(assessment.countryCode, assessment.visaTypeId);
    if (approved !== null && approved !== assessment.rubricVersion) return "rules_updated";
    return null;
  }

  /** The approved version of a route. */
  async approvedVersionOf(countryCode: string, visaTypeId: string): Promise<number | null> {
    return this.deps.rubrics.approvedVersionOf(countryCode, visaTypeId);
  }

  // ----------------------------------------------------------------
  // The job
  // ----------------------------------------------------------------

  /**
   * Run one queued assessment. Called by the Firestore worker. Claims the
   * document `queued -> running` in a transaction, so a duplicate delivery of
   * the same event does nothing. Never throws: every failure is stored.
   */
  async runJob(assessmentId: string): Promise<"skipped" | "succeeded" | "failed"> {
    const claimed = await this.deps.runTransaction(async (tx) => {
      const ref = collections.applicationAssessments.doc(assessmentId);
      const snap = await tx.get(ref);
      if (!snap.exists) return null;
      const cur = snap.data() as ApplicationAssessment;
      if (cur.status !== "queued") return null;
      tx.update(ref, { status: "running", startedAt: Timestamp.fromDate(this.deps.now()) });
      return cur;
    });
    if (!claimed) return "skipped";

    const started = this.deps.now().getTime();
    try {
      await this.execute(claimed, started);
      console.log(`[ai-case-officer] assessment ${assessmentId} succeeded`);
      return "succeeded";
    } catch (err) {
      const stop =
        err instanceof JobStop
          ? err
          : new JobStop("internal_error", "the assessment stopped unexpectedly");
      await this.finish(assessmentId, { status: "failed", error: { code: stop.code, message: stop.message } });
      console.log(`[ai-case-officer] assessment ${assessmentId} failed: ${stop.code}`);
      return "failed";
    }
  }

  /** Write a stored result or failure. Only the worker writes these fields. */
  // Public since #37 (the bulk path writes failures through it).
  async finish(assessmentId: string, patch: Partial<ApplicationAssessment> & { status: AssessmentStatus }): Promise<void> {
    await collections.applicationAssessments.doc(assessmentId).update({
      ...patch,
      finishedAt: Timestamp.fromDate(this.deps.now()),
    } as Record<string, unknown>);
  }

  /** The job: stages 1 to 3, then assembly. Throws JobStop to fail the job. */
  private async execute(cur: ApplicationAssessment, started: number): Promise<void> {
    // ---- settings (fail closed) ----
    const settingsRead = await this.deps.readSettings();
    if (!settingsRead.ok) throw new JobStop("settings_unavailable", settingsRead.reason);
    const settings: AiSettings = settingsRead.settings;
    if (!settings.enabled) throw new JobStop("disabled", "AI assessments are switched off");

    // ---- the inputs must still be the ones the request hashed ----
    const appSnap = await collections.applications.doc(cur.applicationId).get();
    if (!appSnap.exists) throw new JobStop("inputs_changed", "the application no longer exists");
    const app = { id: appSnap.id, ...appSnap.data() } as Application;

    const rubric = await this.deps.rubrics.getApprovedRubric(app.countryCode, app.visaTypeId);
    if (!rubric || rubric.version !== cur.rubricVersion) {
      throw new JobStop("rubric_changed", "the approved rubric changed after this assessment was requested");
    }
    const loaded = await this.loadInputs(app);
    if (computeInputHash(this.inputsFor(loaded, rubric.version)) !== cur.inputHash) {
      throw new JobStop("inputs_changed", "the application's inputs changed after this assessment was requested");
    }

    const now = this.deps.now();
    const score = loaded.eligibilityScore;

    // ---- stage 1: mandatory bars (no model call) ----
    // The bar is checked against the date the application was SUBMITTED when
    // there is one, else today (see barDateOf for why never startDate and why
    // a missing date never means "skip the bar").
    const hits = mandatoryBarHits(rubric, loaded.nationality, barDateOf(app, now));
    if (hits.length > 0) {
      const content = assembleContent({
        rubric,
        mandatoryHits: hits,
        objective: [],
        judgement: null,
        documents: [],
        statementReadable: loaded.statements.length > 0,
        score,
        suspiciousDocumentIds: [],
        judgementFailed: false,
      });
      await this.storeContent(cur.id, rubric, content, { extract: zeroUsage(), judge: zeroUsage() }, { extract: null, judge: null });
      return;
    }

    // ---- nothing to read: a valid low-readiness result, no model call ----
    const hasContent = loaded.documents.length > 0 || loaded.statements.some((s) => s.text.trim().length > 0);
    if (!hasContent) {
      const content = assembleContent({
        rubric,
        mandatoryHits: [],
        objective: [],
        judgement: null,
        documents: [],
        statementReadable: false,
        score,
        suspiciousDocumentIds: [],
        judgementFailed: false,
      });
      await this.storeContent(cur.id, rubric, content, { extract: zeroUsage(), judge: zeroUsage() }, { extract: null, judge: null });
      return;
    }

    // ---- the daily cap, counted only for jobs that reach a model ----
    await this.claimDailyCap(settings);

    // ---- stage 2: extraction, one call per document ----
    const fields = documentFieldsFor(rubric);
    const extractions: DocumentExtraction[] = [];
    const suspiciousContent: ApplicationAssessment["suspiciousContent"] = [];
    let extractUsage = zeroUsage();
    let requests = 0;
    let chars = 0;
    let extractUsed = false;

    for (const d of loaded.documents) {
      const base = { documentId: d.id, label: d.label };
      if (d.sizeMb * 1024 * 1024 > settings.maxFileBytes) {
        extractions.push(unreadable(base, "file is larger than the limit"));
        continue;
      }
      if (fields.length === 0) {
        extractions.push(unreadable(base, "no field to read"));
        continue;
      }
      if (this.deps.now().getTime() - started > JOB_BUDGET_MS) throw new JobStop("timed_out", "the assessment ran out of time");

      let bytes: Buffer;
      try {
        bytes = await this.deps.loadBytes(d.path);
      } catch {
        extractions.push(unreadable(base, "file could not be read"));
        continue;
      }
      // The shared single-document extraction (document-extraction.ts, also used
      // by the per-upload check #115): sniff, guards, request, call, parse.
      // The cost caps run just before the call, through `beforeCall`.
      const result = await extractOneDocument({
        provider: this.deps.provider,
        documentId: d.id,
        label: d.label,
        bytes,
        fields,
        beforeCall: (request) => {
          requests++;
          chars += request.user.length + (request.documents?.[0]?.data.length ?? 0);
          if (requests > settings.maxRequestsPerAssessment) throw new JobStop("cost_cap_exceeded", "the assessment would pass its request cap");
          if (chars > settings.maxInputCharsPerAssessment) throw new JobStop("cost_cap_exceeded", "the assessment would pass its input size cap");
        },
      });
      if (result.called) extractUsed = true;
      if (result.usage) extractUsage = addUsage(extractUsage, result.usage);
      if (result.extraction.suspicious) suspiciousContent.push({ source: "document", documentId: d.id, page: null });
      extractions.push(result.extraction);
    }

    // ---- facts the checks may read ----
    const facts: Facts = {
      ...Object.fromEntries(Object.entries(loaded.intake).map(([k, v]) => [`intake.${k}`, v as Facts[string]])),
      ...deriveHolderFact(loaded.applicantName, extractions),
    };

    // ---- stage 2 evaluation: code decides ----
    const objective = evaluateObjective(rubric, facts, extractions);

    // ---- stage 3: judgement, one call ----
    const judgementCriteria = judgementCriteriaOf(rubric);
    let judgement: JudgementOutput | null = null;
    let judgementFailed = false;
    let judgeUsage = zeroUsage();
    let judgeUsed = false;
    const statementText = loaded.statements.map((s) => s.text).filter(Boolean).join("\n\n");
    // The ONE statement whose blocks are numbered and anchorable: the first (by
    // instance id) that has any block. Others are sent unnumbered, so a note on
    // them is stored without a position. `statement` records what was read.
    const primary = loaded.statements.find((s) => s.blocks.length > 0) ?? null;
    const numbered = primary ? numberStatementBlocks(primary.blocks) : null;
    const otherText = loaded.statements.filter((s) => s !== primary).map((s) => s.text).filter(Boolean).join("\n\n");
    const statementRef = primary ? { instanceId: primary.instanceId, version: primary.version } : null;
    if (statementText && findInjectionSignals(statementText)) {
      suspiciousContent.push({ source: "statement", documentId: null, page: null });
    }
    if (judgementCriteria.length > 0 && (extractions.length > 0 || statementText.trim().length > 0)) {
      if (this.deps.now().getTime() - started > JUDGEMENT_START_LIMIT_MS) throw new JobStop("timed_out", "the assessment ran out of time before judgement");
      requests++;
      if (requests > settings.maxRequestsPerAssessment) throw new JobStop("cost_cap_exceeded", "the assessment would pass its request cap");
      const request = buildJudgementRequest({
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
      if (chars + request.user.length > settings.maxInputCharsPerAssessment) throw new JobStop("cost_cap_exceeded", "the assessment would pass its input size cap");
      judgeUsed = true;
      try {
        const res = await this.deps.provider.complete(request);
        judgeUsage = addUsage(judgeUsage, res.usage);
        if (res.stopReason === "refusal") {
          judgementFailed = true;
        } else {
          const parsed = parseJudgement(res.text, judgementCriteria.map((c) => c.criterionId), numbered ? numbered.sentCount : 0);
          if (parsed.ok) judgement = parsed.output;
          else judgementFailed = true;
        }
      } catch {
        judgementFailed = true;
      }
    }

    // ---- assembly: containment and citations in code ----
    const content = assembleContent({
      rubric,
      mandatoryHits: [],
      objective,
      judgement,
      documents: extractions,
      statementReadable: statementText.trim().length > 0,
      statement: statementRef,
      score,
      suspiciousDocumentIds: suspiciousContent.map((s) => s.documentId ?? "statement"),
      judgementFailed,
    });
    await this.storeContent(
      cur.id,
      rubric,
      content,
      { extract: extractUsage, judge: judgeUsage },
      { extract: extractUsed ? this.deps.provider.modelFor("extraction") : null, judge: judgeUsed ? this.deps.provider.modelFor("judgement") : null },
      suspiciousContent
    );
  }

  /**
   * The country-context note for a finished assessment (#116), or undefined.
   *
   * Called ONLY from storeContent, after `content` (band, score, findings) is
   * fully assembled, and its result goes into the stored doc beside them. It
   * does not feed back: nothing here is passed to assembleContent, topIssuesOf,
   * the input hash or any model request. Undefined (so the field is absent)
   * when the rubric has no outcome-statistics mapping, the applicant has no
   * passport country, no figure was found, or ANYTHING fails: the assessment
   * never fails because of this note.
   */
  private async countryContextFor(rubric: VisaRubric, assessmentId: string): Promise<AvailableCountryContext | undefined> {
    const mapping = rubric.outcomeStatistics;
    if (!mapping) return undefined; // a rubric without the mapping produces no note
    try {
      // Nationality = the PASSPORT country on the profile, not residence.
      const assessmentSnap = await collections.applicationAssessments.doc(assessmentId).get();
      const applicationId = (assessmentSnap.data() as ApplicationAssessment | undefined)?.applicationId;
      const appSnap = applicationId ? await collections.applications.doc(applicationId).get() : null;
      const userId = appSnap && appSnap.exists ? (appSnap.data() as Application).userId : null;
      const userSnap = userId ? await collections.users.doc(userId).get() : null;
      const passportCountry = userSnap && userSnap.exists ? (userSnap.data() as User).passportCountry : undefined;

      // Rubric-tagged "extra evidence helps" criteria, by their own titles.
      const byId = new Map(rubric.criteria.map((c) => [c.criterionId, c.title]));
      const evidenceAreas = (rubric.evidenceHelpsCriterionIds ?? [])
        .filter((id) => byId.has(id))
        .map((id) => ({ id, label: byId.get(id) as string }));

      const build = this.deps.buildCountryContext ?? buildCountryContext;
      const result = await build({
        destination: rubric.countryCode,
        categoryKey: mapping.categoryKey,
        categoryLabel: mapping.categoryLabel,
        passportCountry,
        evidenceAreas,
      });
      return result.status === "available" ? result : undefined;
    } catch (err) {
      // Counted, never fatal; no applicant data in the log.
      console.warn(`[ai-case-officer] country context not built for assessment ${assessmentId}: ${err instanceof Error ? err.name : "error"}`);
      return undefined;
    }
  }

  /** Store the result of a finished job. */
  // Public since #37. `extra` is merged into the same write (the bulk path adds its
  // supersede links, change summary and review flag), so a result and its bulk
  // fields land in ONE update and a reader never sees one without the other.
  async storeContent(
    id: string,
    rubric: VisaRubric,
    content: AssessmentContent,
    usage: { extract: AssessmentUsage; judge: AssessmentUsage },
    models: { extract: string | null; judge: string | null },
    suspiciousContent: ApplicationAssessment["suspiciousContent"] = [],
    extra: Partial<ApplicationAssessment> = {}
  ): Promise<void> {
    // Items dropped by code (a criterion id the rubric does not contain, or model
    // text that broke the banned-wording list) are logged as a COUNT. The text is
    // never logged: it may carry an applicant's words.
    if (content.unanchoredCount > 0) {
      // A count only: never the text or the model's index values.
      console.warn(`[ai-case-officer] assessment ${id}: ${content.unanchoredCount} statement finding(s) stored without a position`);
    }
    if (content.droppedCount > 0) {
      console.warn(`[ai-case-officer] assessment ${id}: ${content.droppedCount} model item(s) dropped by code checks`);
    }
    // Cost from the price table; null while a role has no confirmed price.
    const extractCost = costOfUsage("extraction", this.usageAsLlm(usage.extract));
    const judgeCost = costOfUsage("judgement", this.usageAsLlm(usage.judge));
    // Computed AFTER the content above is final, from nothing in it (#116).
    const countryContext = await this.countryContextFor(rubric, id);
    await this.finish(id, {
      status: "succeeded",
      error: null,
      stageOutcomes: content.stageOutcomes,
      score: content.score,
      readiness: content.readiness,
      refusalGrounds: content.refusalGrounds,
      credibilityFlags: content.credibilityFlags,
      strengths: content.strengths,
      statementFindings: content.statementFindings,
      statement: content.statement,
      insufficientInformation: content.insufficientInformation,
      suspiciousContent,
      confidence: content.confidence,
      topIssues: topIssuesOf(rubric, content),
      hasBlockingRule: content.hasBlockingRule,
      internalCall: content.internalCall,
      // Spread only when present: an absent note is an absent field, not null.
      ...(countryContext ? { countryContext } : {}),
      models,
      model: models.judge ?? models.extract ?? null,
      usage,
      // A total only when both stages are priced: a part-priced total would understate the spend.
      costUsd: extractCost === null || judgeCost === null ? null : extractCost + judgeCost,
      ...extra,
    });
    // Proposed actions (issue #44): derived from the findings just stored and
    // checked against THIS rubric version. They are inert proposals (nothing is
    // created for the applicant until a human accepts one). Best-effort inside
    // the service: it never throws, so it cannot fail a stored verdict.
    const stored = await this.getById(id);
    if (stored) await aiActionService.writeForAssessment(stored, rubric, content);
  }

  /** Stored usage in the shape the price function takes. */
  private usageAsLlm(u: AssessmentUsage): LlmUsage {
    return { inputTokens: u.inputTokens, outputTokens: u.outputTokens, cacheReadTokens: u.cacheReadTokens, cacheWriteTokens: u.cacheWriteTokens };
  }

  /**
   * Count one assessment against today's cap, in a transaction, before its first
   * model call. A job over the cap is failed with `daily_cap_exceeded`.
   */
  private async claimDailyCap(settings: AiSettings): Promise<void> {
    const ref = collections.aiCosts.doc(dayKey(this.deps.now()));
    await this.deps.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const used = snap.exists ? Number((snap.data() as { assessments?: number }).assessments ?? 0) : 0;
      if (used >= settings.maxAssessmentsPerDay) throw new JobStop("daily_cap_exceeded", "today's assessment cap is used up");
      tx.set(ref, { assessments: used + 1 }, { merge: true });
    });
  }
}

/** A document that could not be read: its criteria become insufficient. */
export function unreadable(base: { documentId: string; label: string }, reason: string): DocumentExtraction {
  return { ...base, mediaType: "", readable: false, values: [], failed: false, failure: reason, suspicious: false };
}

/** A document whose extraction failed: counted as unread, never as a pass. */
export function failed(base: { documentId: string; label: string }, reason: string): DocumentExtraction {
  return { ...base, mediaType: "", readable: false, values: [], failed: true, failure: reason, suspicious: false };
}

/** Singleton over the real provider, Storage, Firestore and settings. */
export const aiCaseOfficerService = new AiCaseOfficerService();
