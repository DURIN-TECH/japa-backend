import { createHash } from "crypto";
import { getStorage } from "firebase-admin/storage";
import { Timestamp } from "firebase-admin/firestore";
import { collections, db } from "../../utils/firebase";
import { rubricStore } from "../../scrapers/rubric/rubric.store";
import type { Application, Document, User } from "../../types";
import type { VisaRubric } from "../../types/rubric";
import type { RefusalAnalysis } from "../../types/refusal-letter";
import { AnthropicLlmProvider, type LlmProvider } from "./llm-provider";
import { readAiSettings, type AiSettings, type AiSettingsRead } from "./ai-settings";
import {
  REFUSAL_PROMPT_VERSION,
  buildReapplicationChecklist,
  buildReasons,
  buildRefusalRequest,
  identityWarnings,
  parseRefusalAnswer,
} from "./refusal-letter-logic";
import { resolveDisclosureNotice } from "./refusal-disclosure-notice";
import { sniffMediaType } from "../ai-case-officer.service";

// ============================================
// REFUSAL-LETTER ANALYSIS — job service (issue #122)
// ============================================
//
// Flow (same runner shape as the #42 assessment):
//
//   POST /ai/refusal-letters   controller checks auth, tier, access, then calls
//                              `requestAnalysis`, which validates the file's
//                              size and type, enforces the per-user daily cap,
//                              and writes `refusalAnalyses/{id}` as `queued`.
//   processRefusalAnalysisJob  (index.ts) fires on that write and calls `runJob`:
//                              claim queued -> running in a transaction, read the
//                              letter from Storage, ONE model call (values only),
//                              then everything else in code (refusal-letter-logic.ts).
//
// The letter is untrusted input. It reaches the model only as an attached file,
// with the same data-only rule, media-type sniffing and size caps as #42's
// document extraction (sniffMediaType, DATA_ONLY_RULE, maxFileBytes), and the
// answer is validated in code before anything is stored.
//
// LOGGING: ids and stable codes only. Never the letter, a quote, a name or a
// date of birth.

/** The requirement id the mobile app registers a refusal-letter upload against. */
export const REFUSAL_LETTER_REQUIREMENT_ID = "refusal-letter";

/** Most analyses one applicant may start per UTC day (failed retries count). */
export const REFUSAL_MAX_PER_USER_PER_DAY = 3;

/** File types accepted at the door (the bytes are sniffed again in the job). */
const ALLOWED_FILE_TYPES = new Set(["application/pdf", "image/jpeg", "image/png"]);

/** A job failure with a stable code. Caught by runJob, which stores it. */
class JobStop extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

/** What `requestAnalysis` decided. */
export type RefusalRequestOutcome =
  | { kind: "file_too_large" }
  | { kind: "unsupported_type" }
  | { kind: "wrong_document" }
  | { kind: "per_user_cap" }
  | { kind: "disabled" }
  | { kind: "created" | "existing" | "requeued"; analysisId: string; status: RefusalAnalysis["status"] };

/** Everything the job reaches outside itself through (swappable in tests). */
export interface RefusalDeps {
  provider: LlmProvider;
  getApprovedRubric(countryCode: string, visaTypeId: string): Promise<VisaRubric | null>;
  loadBytes(storagePath: string): Promise<Buffer>;
  runTransaction<T>(fn: (tx: FirebaseFirestore.Transaction) => Promise<T>): Promise<T>;
  readSettings(): Promise<AiSettingsRead>;
  now(): Date;
}

function defaultDeps(): RefusalDeps {
  return {
    provider: new AnthropicLlmProvider(),
    getApprovedRubric: (cc, vt) => rubricStore.getApprovedRubric(cc.toUpperCase(), vt),
    loadBytes: async (storagePath) => {
      const [bytes] = await getStorage().bucket().file(storagePath).download();
      return bytes;
    },
    runTransaction: (fn) => db.runTransaction(fn),
    readSettings: readAiSettings,
    now: () => new Date(),
  };
}

/** UTC day key, `YYYY-MM-DD`. */
function dayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** The applicant's date of birth as `YYYY-MM-DD` (UTC), or null. */
function dobOf(user: User | null): string | null {
  const ts = user?.dateOfBirth as { toDate?: () => Date } | undefined;
  if (!ts || typeof ts.toDate !== "function") return null;
  const d = ts.toDate();
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/** Deterministic job id: the same letter version asks once (a repeat request is a no-op). */
export function refusalAnalysisIdFor(args: { userId: string; documentId: string; storagePath: string; updatedAtMs: number }): string {
  return createHash("sha256")
    .update(`${args.userId}:${args.documentId}:${args.storagePath}:${args.updatedAtMs}:${REFUSAL_PROMPT_VERSION}`)
    .digest("hex");
}

export class RefusalLetterService {
  constructor(private readonly deps: RefusalDeps = defaultDeps()) {}

  /** One analysis by id, or null. */
  async getById(id: string): Promise<RefusalAnalysis | null> {
    const snap = await collections.refusalAnalyses.doc(id).get();
    return snap.exists ? ({ ...(snap.data() as RefusalAnalysis), id: snap.id }) : null;
  }

  // ----------------------------------------------------------------
  // Request (called by the controller after auth, tier and access)
  // ----------------------------------------------------------------

  /**
   * Validate and enqueue. Rejections are decided BEFORE any model call and are
   * logged by code only ("oversize or unsupported types are rejected with a
   * logged reason, not a provider error").
   */
  async requestAnalysis(args: { document: Document; app: Application; requestedBy: string }): Promise<RefusalRequestOutcome> {
    const { document, app, requestedBy } = args;
    const now = this.deps.now();

    // The upload must have been registered as a refusal letter.
    if (document.requirementId !== REFUSAL_LETTER_REQUIREMENT_ID) return { kind: "wrong_document" };

    const settingsRead = await this.deps.readSettings();
    if (!settingsRead.ok) {
      console.log("[refusal-letter] rejected: settings_unavailable");
      return { kind: "disabled" }; // fail closed
    }
    const settings: AiSettings = settingsRead.settings;
    if (!settings.enabled) return { kind: "disabled" };

    if (!ALLOWED_FILE_TYPES.has(document.fileType)) {
      console.log(`[refusal-letter] rejected: unsupported_type doc=${document.id}`);
      return { kind: "unsupported_type" };
    }
    if ((document.fileSizeMb ?? 0) * 1024 * 1024 > settings.maxFileBytes) {
      console.log(`[refusal-letter] rejected: file_too_large doc=${document.id}`);
      return { kind: "file_too_large" };
    }

    const id = refusalAnalysisIdFor({
      userId: app.userId,
      documentId: document.id,
      storagePath: document.storageUrl,
      updatedAtMs: document.updatedAt ? document.updatedAt.toMillis() : 0,
    });
    const existing = await this.getById(id);
    // The same letter version again: return what exists. A failed job may be
    // asked again below (and counts against the cap like any request).
    if (existing && existing.status !== "failed") return { kind: "existing", analysisId: id, status: existing.status };

    // Per-user daily cap, counted from the stored requests of today (UTC).
    const startOfDay = Timestamp.fromDate(new Date(`${dayKey(now)}T00:00:00.000Z`));
    const todays = await collections.refusalAnalyses
      .where("userId", "==", app.userId)
      .where("createdAt", ">=", startOfDay)
      .count()
      .get();
    if (todays.data().count >= REFUSAL_MAX_PER_USER_PER_DAY) {
      console.log(`[refusal-letter] rejected: per_user_cap user=${app.userId}`);
      return { kind: "per_user_cap" };
    }

    const blank = this.blankDoc({ id, document, app, requestedBy, now });
    if (existing) {
      // failed -> queued: reset the job fields. `createdAt` is "last requested",
      // so a retry counts against today's cap.
      await collections.refusalAnalyses.doc(id).set(blank);
      return { kind: "requeued", analysisId: id, status: "queued" };
    }
    // `create` fails if a concurrent request wrote the same id first: then it is "existing".
    try {
      await collections.refusalAnalyses.doc(id).create(blank);
    } catch {
      const raced = await this.getById(id);
      if (raced) return { kind: "existing", analysisId: id, status: raced.status };
      throw new Error("could not create the analysis");
    }
    return { kind: "created", analysisId: id, status: "queued" };
  }

  private blankDoc(a: { id: string; document: Document; app: Application; requestedBy: string; now: Date }): RefusalAnalysis {
    return {
      id: a.id,
      userId: a.app.userId,
      agencyId: a.app.agencyId ?? null,
      applicationId: a.app.id,
      documentId: a.document.id,
      countryCode: a.app.countryCode,
      visaTypeId: a.app.visaTypeId,
      rubricVersion: null,
      status: "queued",
      error: null,
      outcome: null,
      requestedBy: a.requestedBy,
      createdAt: Timestamp.fromDate(a.now),
      startedAt: null,
      finishedAt: null,
      decisionDate: null,
      visaTypeNamed: null,
      reasons: [],
      warnings: [],
      suspiciousContent: false,
      checklist: { state: "not_built", items: [] },
      matchedCriterionIds: [],
      unmatchedReasonIds: [],
      disclosureNotice: null,
      model: null,
      promptVersion: REFUSAL_PROMPT_VERSION,
      usage: null,
    };
  }

  // ----------------------------------------------------------------
  // The job
  // ----------------------------------------------------------------

  /**
   * Run one queued analysis. Called by the Firestore worker. Claims the
   * document `queued -> running` in a transaction, so a duplicate delivery of
   * the same event does nothing. Never throws: every failure is stored.
   */
  async runJob(id: string): Promise<"skipped" | "succeeded" | "failed"> {
    const claimed = await this.deps.runTransaction(async (tx) => {
      const ref = collections.refusalAnalyses.doc(id);
      const snap = await tx.get(ref);
      if (!snap.exists) return null;
      const cur = { ...(snap.data() as RefusalAnalysis), id: snap.id };
      if (cur.status !== "queued") return null;
      tx.update(ref, { status: "running", startedAt: Timestamp.fromDate(this.deps.now()) });
      return cur;
    });
    if (!claimed) return "skipped";

    try {
      await this.execute(claimed);
      console.log(`[refusal-letter] analysis ${id} succeeded`);
      return "succeeded";
    } catch (err) {
      const stop = err instanceof JobStop ? err : new JobStop("internal_error", "the analysis stopped unexpectedly");
      await collections.refusalAnalyses.doc(id).update({
        status: "failed",
        error: { code: stop.code, message: stop.message },
        finishedAt: Timestamp.fromDate(this.deps.now()),
      });
      console.log(`[refusal-letter] analysis ${id} failed: ${stop.code}`);
      return "failed";
    }
  }

  /** The job body. Throws JobStop to fail it. */
  private async execute(cur: RefusalAnalysis): Promise<void> {
    // ---- settings (fail closed) ----
    const settingsRead = await this.deps.readSettings();
    if (!settingsRead.ok) throw new JobStop("settings_unavailable", settingsRead.reason);
    const settings = settingsRead.settings;
    if (!settings.enabled) throw new JobStop("disabled", "AI analysis is switched off");

    // ---- the records the request was made against ----
    const [docSnap, appSnap] = await Promise.all([
      collections.documents.doc(cur.documentId).get(),
      collections.applications.doc(cur.applicationId).get(),
    ]);
    if (!docSnap.exists || !appSnap.exists) throw new JobStop("inputs_changed", "the letter or the application no longer exists");
    const document = { id: docSnap.id, ...docSnap.data() } as Document;
    const app = { id: appSnap.id, ...appSnap.data() } as Application;
    // The document must still belong to the application it was requested for.
    if (document.applicationId !== app.id) throw new JobStop("inputs_changed", "the letter no longer belongs to this application");

    // ---- read the file; check size and type from the BYTES, not the stored name ----
    let bytes: Buffer;
    try {
      bytes = await this.deps.loadBytes(document.storageUrl);
    } catch {
      throw new JobStop("file_unreadable", "the file could not be read");
    }
    if (bytes.length > settings.maxFileBytes) {
      console.log(`[refusal-letter] rejected: file_too_large (bytes) analysis=${cur.id}`);
      throw new JobStop("file_too_large", "the file is larger than the limit");
    }
    const mediaType = sniffMediaType(bytes);
    if (!mediaType) {
      console.log(`[refusal-letter] rejected: unsupported_type (bytes) analysis=${cur.id}`);
      throw new JobStop("unsupported_type", "the file type is not supported");
    }

    // ---- the approved rubric for the application's route (null is allowed) ----
    const rubric = await this.deps.getApprovedRubric(app.countryCode, app.visaTypeId);
    // Per-destination, tied to the rubric's own criterion when it has one.
    const disclosureNotice = resolveDisclosureNotice(app.countryCode, rubric);

    // ---- today's global cap, claimed only by jobs that reach the model ----
    await this.claimDailyCap(settings);

    // ---- the one model call: values only ----
    const request = buildRefusalRequest({ mediaType, data: bytes.toString("base64") });
    if (request.documents![0].data.length > settings.maxInputCharsPerAssessment) {
      throw new JobStop("cost_cap_exceeded", "the file would pass the input size cap");
    }
    let res;
    try {
      res = await this.deps.provider.complete(request);
    } catch {
      // The provider error is already secret-free, but nothing from it is stored.
      throw new JobStop("model_call_failed", "the model call failed");
    }
    const usage = {
      inputTokens: res.usage.inputTokens,
      outputTokens: res.usage.outputTokens,
      cacheReadTokens: res.usage.cacheReadTokens,
      cacheWriteTokens: res.usage.cacheWriteTokens,
    };

    // A model that declines, or an answer that breaks the contract, is "could not read", never a guess.
    const parsed = res.stopReason === "refusal" ? null : parseRefusalAnswer(res.text);
    if (!parsed || !parsed.ok) {
      await this.store(cur.id, {
        outcome: "unreadable",
        disclosureNotice,
        rubricVersion: rubric?.version ?? null,
        model: res.model,
        usage,
      });
      return;
    }
    const letter = parsed.letter;
    if (!letter.readable) {
      await this.store(cur.id, { outcome: "unreadable", disclosureNotice, rubricVersion: rubric?.version ?? null, suspiciousContent: letter.suspicious, model: res.model, usage });
      return;
    }
    if (!letter.isRefusalLetter) {
      await this.store(cur.id, { outcome: "not_a_refusal_letter", disclosureNotice, rubricVersion: rubric?.version ?? null, suspiciousContent: letter.suspicious, model: res.model, usage });
      return;
    }

    // ---- everything below is code ----
    const reasons = buildReasons(letter, rubric, (id) => console.log(`[refusal-letter] dropped a mapping to an unknown criterion id=${id}`));
    const userSnap = await collections.users.doc(app.userId).get();
    const user = userSnap.exists ? (userSnap.data() as User) : null;
    const warnings = identityWarnings(
      { name: user ? `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim() || null : null, dateOfBirth: dobOf(user) },
      letter
    );
    const intake = (app as Application & { intake?: { answers?: Record<string, unknown> } }).intake;
    const checklist = buildReapplicationChecklist({ rubric, reasons, intakeAnswers: intake?.answers ?? null });

    await this.store(cur.id, {
      outcome: "analysed",
      disclosureNotice,
      rubricVersion: rubric?.version ?? null,
      decisionDate: letter.decisionDate,
      visaTypeNamed: letter.visaTypeNamed,
      reasons,
      warnings,
      suspiciousContent: letter.suspicious,
      checklist,
      matchedCriterionIds: [...new Set(reasons.flatMap((r) => r.matches.map((m) => m.criterionId)))],
      unmatchedReasonIds: reasons.filter((r) => r.matches.length === 0).map((r) => r.reasonId),
      model: res.model,
      usage,
    });
  }

  /** Write a finished result. Only the worker writes these fields. */
  private async store(id: string, patch: Partial<RefusalAnalysis> & { outcome: NonNullable<RefusalAnalysis["outcome"]> }): Promise<void> {
    await collections.refusalAnalyses.doc(id).update({
      ...patch,
      status: "succeeded",
      error: null,
      finishedAt: Timestamp.fromDate(this.deps.now()),
    } as Record<string, unknown>);
  }

  /** Count one analysis against today's global cap before its model call. */
  private async claimDailyCap(settings: AiSettings): Promise<void> {
    const ref = collections.aiCosts.doc(dayKey(this.deps.now()));
    await this.deps.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const used = snap.exists ? Number((snap.data() as { refusalAnalyses?: number }).refusalAnalyses ?? 0) : 0;
      if (used >= settings.maxAssessmentsPerDay) throw new JobStop("daily_cap_exceeded", "today's analysis cap is used up");
      tx.set(ref, { refusalAnalyses: used + 1 }, { merge: true });
    });
  }
}

/** Singleton over the real provider, Storage, Firestore and settings. */
export const refusalLetterService = new RefusalLetterService();
