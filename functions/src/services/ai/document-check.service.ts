import { createHash } from "crypto";
import { Timestamp, type DocumentReference, type Transaction } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { collections, db } from "../../utils/firebase";
import { validateStoragePath } from "../../utils/storage-paths";
import { rubricStore, type RulebookStack, type VisaRubric } from "../../scrapers";
import { defaultRulebookStack, rulebookFor, type ApplicationStackRef } from "./application-rulebook";
import type { Application, Document, DocumentRequest, User } from "../../types";
import type { DocumentCheckRecord } from "../../types/document-check";
import { readAiSettings, type AiSettingsRead } from "./ai-settings";
import { CHECK_FIELDS, COULD_NOT_CHECK_MESSAGES, evaluateDocumentCheck, expectationsFor, maskName, rawFactsOf, type CouldNotCheckCode, type RawFacts } from "./document-check-engine";
import { extractOneDocument, type ExtractionFailureCode } from "./document-extraction";
import { AnthropicLlmProvider, type LlmProvider } from "./llm-provider";
import { ASSESSMENT_PROMPT_VERSION } from "./prompt-safety";

// ============================================
// DOCUMENT CHECK SERVICE — the I/O half (issue #115)
// ============================================
//
// A paid self-service applicant uploads a document against a checklist item (a
// DocumentRequest with a `checklistItemId`, #114). This service:
//
//   enqueue()   writes `documentChecks/{documentId}` as `queued`. It makes no
//               model call and is cheap, so POST /documents does not wait on it.
//   runJob()    (the Firestore-triggered worker) claims the job, reads the file,
//               runs the SHARED stage 2 extraction (document-extraction.ts),
//               and hands the values to the pure engine, which decides.
//
// SAFETY, in the order it happens in runJob:
//   - the tier is decided BEFORE a job exists (the controller passes it in;
//     a caller whose entitlements did not resolve is the free tier), so a free
//     caller never reaches this file's model path;
//   - the stored path is re-validated against the document's owner and
//     application before any byte is read;
//   - size, page, per-application and per-user daily caps run BEFORE the call;
//   - the call has a wall-clock limit; past it the job ends `could_not_check`;
//   - nothing here ever changes a Document's status.
//
// A failed or unavailable check is never an error to the upload: every path
// below ends in a stored `could_not_check` with plain words, not a throw.

// ============================================
// Limits
// ============================================

/** The check's own limits. Overridable under `appConfig/aiSettings.documentCheck`. */
export interface DocumentCheckLimits {
  /** Pages a PDF may have. */
  maxPages: number;
  /** Checks that may reach a model, per application, per UTC day. */
  perApplicationPerDay: number;
  /** Checks that may reach a model, per user, per UTC day. */
  perUserPerDay: number;
  /** Whole-job time limit in ms; past it the job ends `could_not_check`. */
  timeoutMs: number;
}

export const DEFAULT_CHECK_LIMITS: Readonly<DocumentCheckLimits> = Object.freeze({
  maxPages: 10,
  perApplicationPerDay: 20,
  perUserPerDay: 40,
  timeoutMs: 90_000,
});

const CHECK_LIMIT_RANGES: Record<keyof DocumentCheckLimits, [number, number]> = {
  maxPages: [1, 100],
  perApplicationPerDay: [1, 500],
  perUserPerDay: [1, 1000],
  timeoutMs: [10_000, 110_000],
};

/** Merge a stored `documentCheck` object over the defaults; a bad value falls back. */
export function mergeCheckLimits(stored: unknown): DocumentCheckLimits {
  const out: DocumentCheckLimits = { ...DEFAULT_CHECK_LIMITS };
  if (!stored || typeof stored !== "object") return out;
  for (const key of Object.keys(CHECK_LIMIT_RANGES) as Array<keyof DocumentCheckLimits>) {
    const v = (stored as Record<string, unknown>)[key];
    const [min, max] = CHECK_LIMIT_RANGES[key];
    if (typeof v === "number" && Number.isFinite(v) && v >= min && v <= max) out[key] = v;
  }
  return out;
}

/** A job `queued` or `running` for longer than this is reported as timed out on read. */
export const STALE_CHECK_MS = 5 * 60 * 1000;

// ============================================
// Dependencies (injected for tests)
// ============================================

export interface DocumentCheckDeps {
  provider: LlmProvider;
  // (#233) `getRulebookStack` reads the application's whole rulebook stack
  // (set by the default deps); without it the own layer alone is read.
  rubrics: { getApprovedRubric(countryCode: string, visaTypeId: string): Promise<VisaRubric | null>; getRulebookStack?(app: ApplicationStackRef): Promise<RulebookStack> };
  loadBytes(storagePath: string): Promise<Buffer>;
  runTransaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>;
  readSettings(): Promise<AiSettingsRead>;
  readLimits(): Promise<DocumentCheckLimits>;
  now(): Date;
}

function defaultDeps(): DocumentCheckDeps {
  return {
    provider: new AnthropicLlmProvider(),
    rubrics: { getApprovedRubric: (cc, vt) => rubricStore.getApprovedRubric(cc, vt), getRulebookStack: (app) => defaultRulebookStack(app) },
    loadBytes: async (storagePath) => {
      const [bytes] = await getStorage().bucket().file(storagePath).download();
      return bytes;
    },
    runTransaction: (fn) => db.runTransaction(fn),
    readSettings: readAiSettings,
    readLimits: async () => {
      try {
        const snap = await collections.appConfig.doc("aiSettings").get();
        return mergeCheckLimits(snap.exists ? (snap.data() as Record<string, unknown>).documentCheck : undefined);
      } catch {
        // Limits are protective: on a failed read use the defaults (the kill
        // switch itself is read, fail-closed, through readSettings).
        return { ...DEFAULT_CHECK_LIMITS };
      }
    },
    now: () => new Date(),
  };
}

// ============================================
// Small helpers
// ============================================

/** UTC day key YYYY-MM-DD. */
function dayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** A stopped job with a stable code, thrown inside runJob and stored by it. */
class CheckStop extends Error {
  /** `extra` is stored with the stop (the model, hash and rubric version known so far). */
  constructor(
    readonly code: CouldNotCheckCode,
    readonly extra: Partial<DocumentCheckRecord> = {}
  ) {
    super(code);
    this.name = "CheckStop";
  }
}

/** Map an extraction failure code to the applicant-facing reason. */
function reasonFor(code: ExtractionFailureCode | null): CouldNotCheckCode {
  switch (code) {
  case "password_protected":
    return "password_protected";
  case "unsupported_type":
    return "unsupported_type";
  case "too_many_pages":
    return "too_many_pages";
  case "call_failed":
    return "unavailable";
  default:
    // model_refused, bad_answer, or no code with an unreadable file.
    return "unreadable";
  }
}

/** The applicant's own name as the profile holds it (the passport name). */
export function profileName(user: Pick<User, "firstName" | "middleName" | "lastName"> | null): string | null {
  if (!user) return null;
  const name = [user.firstName, user.middleName, user.lastName].filter((p) => typeof p === "string" && p.trim()).join(" ").trim();
  return name || null;
}

/**
 * The sponsor's full name from intake. The rubric declares the question: an
 * intake question with `party: "sponsor"` and a text answer. When several
 * qualify, the one that reads the same criteria as the item wins, else the first.
 */
export function sponsorNameFrom(
  rubric: Pick<VisaRubric, "intakeQuestions" | "evidenceItems"> | null,
  checklistItemId: string,
  answers: Record<string, unknown> | null | undefined
): string | null {
  if (!rubric || !answers) return null;
  const candidates = (rubric.intakeQuestions ?? []).filter((q) => q.party === "sponsor" && q.answerType === "text");
  if (candidates.length === 0) return null;
  const item = checklistItemId.startsWith("ev-") ? (rubric.evidenceItems ?? []).find((e) => e.key === checklistItemId.slice(3)) : undefined;
  const preferred = item ? candidates.find((q) => q.criterionIds.some((c) => item.criterionIds.includes(c))) : undefined;
  const q = preferred ?? candidates[0];
  const answer = answers[q.id];
  return typeof answer === "string" && answer.trim() ? answer.trim() : null;
}

/** sha256 of the bytes, hex. */
function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// ============================================
// The service
// ============================================

/** What `enqueue` did. */
export type EnqueueOutcome =
  | { kind: "skipped"; reason: "not_a_checklist_upload" }
  | { kind: "queued" | "running" | "unchanged"; documentId: string };

export class DocumentCheckService {
  constructor(private readonly deps: DocumentCheckDeps = defaultDeps()) {}

  /** The check record for a document, or null. */
  async getByDocumentId(documentId: string): Promise<DocumentCheckRecord | null> {
    const snap = await collections.documentChecks.doc(documentId).get();
    return snap.exists ? (snap.data() as DocumentCheckRecord) : null;
  }

  /**
   * The latest check per checklist item for an application. One query on
   * `applicationId + createdAt` (the index in firestore.indexes.json); a
   * retried check keeps its record, so grouping is by item and `requestedAt`.
   */
  async latestForApplication(applicationId: string): Promise<DocumentCheckRecord[]> {
    const snap = await collections.documentChecks.where("applicationId", "==", applicationId).orderBy("createdAt", "desc").limit(200).get();
    const latest = new Map<string, DocumentCheckRecord>();
    for (const d of snap.docs) {
      const rec = d.data() as DocumentCheckRecord;
      const cur = latest.get(rec.checklistItemId);
      if (!cur || rec.requestedAt.toMillis() > cur.requestedAt.toMillis()) latest.set(rec.checklistItemId, rec);
    }
    return [...latest.values()];
  }

  /** Remove a document's check (with its document). Best effort for the caller. */
  async deleteForDocument(documentId: string): Promise<void> {
    await collections.documentChecks.doc(documentId).delete();
  }

  /** True when a queued or running record has outlived its time and should read as timed out. */
  isStale(rec: Pick<DocumentCheckRecord, "status" | "requestedAt">): boolean {
    return (rec.status === "queued" || rec.status === "running") && this.deps.now().getTime() - rec.requestedAt.toMillis() > STALE_CHECK_MS;
  }

  /**
   * Start (or restart) the check for an uploaded document. Cheap: one small
   * write, no model call, so the upload response does not wait on the check.
   *
   * The CALLER has already decided the tier and must call this only for a full
   * tier applicant. A document whose request is not a cited checklist item is
   * skipped (it has nothing to check against).
   *
   *  - no record yet: created `queued`;
   *  - a final record (`done` or `could_not_check`) or a stale one: moved back
   *    to `queued` with `attempt + 1` (a retry);
   *  - a live `queued` or `running` record: left alone.
   */
  async enqueue(document: Pick<Document, "id" | "userId" | "applicationId">, application: Pick<Application, "agencyId">, request: DocumentRequest): Promise<EnqueueOutcome> {
    if (!request.checklistItemId || !request.citation) return { kind: "skipped", reason: "not_a_checklist_upload" };
    const ref = collections.documentChecks.doc(document.id);
    const now = Timestamp.fromDate(this.deps.now());
    return this.deps.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) {
        const rec: DocumentCheckRecord = {
          documentId: document.id,
          applicationId: document.applicationId,
          userId: document.userId,
          agencyId: application.agencyId ?? null,
          documentRequestId: request.id,
          checklistItemId: request.checklistItemId!,
          rubricVersion: null,
          model: null,
          promptVersion: ASSESSMENT_PROMPT_VERSION,
          fileHash: null,
          reusedFromDocumentId: null,
          status: "queued",
          attempt: 1,
          checks: null,
          reason: null,
          extracted: null,
          citation: request.citation!,
          createdAt: now,
          requestedAt: now,
        };
        tx.create(ref, rec);
        return { kind: "queued" as const, documentId: document.id };
      }
      const cur = snap.data() as DocumentCheckRecord;
      if ((cur.status === "queued" || cur.status === "running") && !this.isStale(cur)) {
        return { kind: cur.status, documentId: document.id };
      }
      // A retry: same record, back to queued. The worker fires on the move INTO queued.
      tx.update(ref, {
        status: "queued",
        attempt: cur.attempt + 1,
        checks: null,
        reason: null,
        extracted: null,
        model: null,
        reusedFromDocumentId: null,
        requestedAt: now,
        startedAt: null,
        finishedAt: null,
      });
      return { kind: "queued" as const, documentId: document.id };
    });
  }

  // ------------------------------------------------------------
  // The worker
  // ------------------------------------------------------------

  /**
   * Run one queued check. Idempotent: the claim `queued -> running` is a
   * transaction, so a duplicate event delivery returns without work. Never
   * throws for a check problem; every outcome is stored.
   */
  async runJob(documentId: string): Promise<void> {
    const ref = collections.documentChecks.doc(documentId);
    const claimed = await this.deps.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists || (snap.data() as DocumentCheckRecord).status !== "queued") return null;
      tx.update(ref, { status: "running", startedAt: Timestamp.fromDate(this.deps.now()) });
      return snap.data() as DocumentCheckRecord;
    });
    if (!claimed) return;

    try {
      await this.withTimeout(this.execute(claimed));
    } catch (err) {
      const code: CouldNotCheckCode = err instanceof CheckStop ? err.code : "unavailable";
      // Only the code is kept: never the error text (it could hold request detail).
      await this.finish(ref, { ...(err instanceof CheckStop ? err.extra : {}), status: "could_not_check", reason: { code, message: COULD_NOT_CHECK_MESSAGES[code] } });
    }
  }

  /** Reject with a `timed_out` stop when the job outlives the configured limit. */
  private async withTimeout<T>(work: Promise<T>): Promise<T> {
    const limits = await this.deps.readLimits();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new CheckStop("timed_out")), limits.timeoutMs);
    });
    try {
      return await Promise.race([work, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** The body of the job. Throws CheckStop for a stop with a reason. */
  private async execute(rec: DocumentCheckRecord): Promise<void> {
    const ref = collections.documentChecks.doc(rec.documentId);

    // ---- kill switch and settings: fail closed ----
    const settingsRead = await this.deps.readSettings();
    if (!settingsRead.ok) throw new CheckStop("unavailable");
    if (!settingsRead.settings.enabled) throw new CheckStop("disabled");
    const settings = settingsRead.settings;
    const limits = await this.deps.readLimits();

    // ---- the records the check reads ----
    const [docSnap, appSnap, reqSnap] = await Promise.all([
      collections.documents.doc(rec.documentId).get(),
      collections.applications.doc(rec.applicationId).get(),
      collections.documentRequests.doc(rec.documentRequestId).get(),
    ]);
    if (!docSnap.exists || !appSnap.exists || !reqSnap.exists) throw new CheckStop("unavailable");
    const document = { id: docSnap.id, ...docSnap.data() } as Document;
    const application = { id: appSnap.id, ...appSnap.data() } as Application;
    const request = { id: reqSnap.id, ...reqSnap.data() } as DocumentRequest;
    // The record's ids must agree with the stored ones; a mismatch is not trusted.
    if (document.applicationId !== rec.applicationId || document.userId !== rec.userId || request.applicationId !== rec.applicationId) {
      throw new CheckStop("unavailable");
    }

    // ---- size, then the bytes (the stored path is re-validated first) ----
    if (document.fileSizeMb * 1024 * 1024 > settings.maxFileBytes) throw new CheckStop("file_too_large");
    const stored = validateStoragePath(document.storageUrl, { purpose: "application-document", ownerUserId: document.userId, applicationId: document.applicationId });
    if (!stored.ok) throw new CheckStop("unavailable");
    let bytes: Buffer;
    try {
      bytes = await this.deps.loadBytes(stored.key);
    } catch {
      throw new CheckStop("unavailable");
    }
    if (bytes.length > settings.maxFileBytes) throw new CheckStop("file_too_large");
    const fileHash = sha256(bytes);

    // ---- expectations: from the approved rubric only ----
    // (#233) The application's rulebook stack (its own layer alone without inheritance).
    const rubric = await rulebookFor({ ...application, countryCode: application.countryCode.toUpperCase() }, this.deps.rubrics);
    const holder = request.holder ?? "applicant";
    // (#207) The applicant's intake answers decide which linked rules apply.
    const savedAnswers = (application as Application & { intake?: { answers?: Record<string, unknown> } }).intake?.answers ?? null;
    const expectations = expectationsFor(rubric, request.checklistItemId ?? rec.checklistItemId, request.documentType, holder, savedAnswers);

    // ---- the name the document must carry ----
    let expectedName: string | null;
    if (holder === "sponsor") {
      const intake = (application as Application & { intake?: { answers?: Record<string, unknown> } }).intake;
      expectedName = sponsorNameFrom(rubric, rec.checklistItemId, intake?.answers);
    } else {
      const userSnap = await collections.users.doc(application.userId).get();
      expectedName = profileName(userSnap.exists ? ({ id: userSnap.id, ...userSnap.data() } as User) : null);
    }

    // ---- the values: reuse an identical file's, or read the document ----
    let raw: RawFacts | null = null;
    let model: string | null = null;
    let reusedFrom: string | null = null;
    const prior = await this.findReusable(rec, fileHash);
    if (prior?.extracted) {
      // Same file, same item, same prompt: no model call and no cap used. The
      // DECISION is still re-made now, from the stored values and today's date.
      raw = prior.extracted;
      reusedFrom = prior.documentId;
      model = prior.model;
    } else {
      // ---- caps, claimed only when a model call is about to happen ----
      await this.claimCaps(rec, limits);
      const result = await extractOneDocument({
        provider: this.deps.provider,
        documentId: rec.documentId,
        label: "uploaded document",
        bytes,
        fields: CHECK_FIELDS,
        maxPages: limits.maxPages,
        timeoutMs: Math.min(limits.timeoutMs, 60_000),
      });
      model = result.model;
      if (!result.extraction.readable || result.extraction.failed || result.extraction.suspicious) {
        // `suspicious` has no code of its own: it reads as an unreadable document.
        throw new CheckStop(reasonFor(result.failureCode), { model, fileHash, rubricVersion: rubric?.version ?? null });
      }
      raw = rawFactsOf(result.extraction);
    }

    // ---- the decision: code only ----
    const evaluation = evaluateDocumentCheck({
      extraction: { documentId: rec.documentId, label: "uploaded document", mediaType: "", readable: true, values: toValues(raw), failed: false, failure: null, suspicious: false },
      expectations,
      expectedName,
      today: dayKey(this.deps.now()),
    });
    if (evaluation.status === "could_not_check") throw new CheckStop(evaluation.code);

    // ---- keep the values minimal: a sponsor's name is kept as initials ----
    const kept: RawFacts = { ...raw };
    if (holder === "sponsor" && kept.holderName) kept.holderName = maskName(kept.holderName);

    await this.finish(ref, {
      status: "done",
      checks: evaluation.checks,
      extracted: kept,
      model,
      fileHash,
      reusedFromDocumentId: reusedFrom,
      rubricVersion: rubric?.version ?? null,
    });
  }

  /** An earlier `done` check of the same file against the same item (another document), if any. */
  private async findReusable(rec: DocumentCheckRecord, fileHash: string): Promise<DocumentCheckRecord | null> {
    const snap = await collections.documentChecks
      .where("applicationId", "==", rec.applicationId)
      .where("checklistItemId", "==", rec.checklistItemId)
      .where("fileHash", "==", fileHash)
      .limit(10)
      .get();
    for (const d of snap.docs) {
      const other = d.data() as DocumentCheckRecord;
      if (other.documentId !== rec.documentId && other.status === "done" && other.extracted && other.promptVersion === rec.promptVersion) return other;
    }
    return null;
  }

  /**
   * Claim one check from the application's and the user's daily counters, in a
   * transaction. Throws the matching stop when either is used up.
   */
  private async claimCaps(rec: DocumentCheckRecord, limits: DocumentCheckLimits): Promise<void> {
    const day = dayKey(this.deps.now());
    const appRef = collections.documentCheckCaps.doc(`${rec.applicationId}__${day}`);
    const userRef = collections.documentCheckCaps.doc(`${rec.userId}__${day}`);
    await this.deps.runTransaction(async (tx) => {
      const [a, u] = await Promise.all([tx.get(appRef), tx.get(userRef)]);
      const appCount = a.exists ? Number((a.data() as { count?: number }).count ?? 0) : 0;
      const userCount = u.exists ? Number((u.data() as { count?: number }).count ?? 0) : 0;
      if (appCount >= limits.perApplicationPerDay) throw new CheckStop("daily_limit_application");
      if (userCount >= limits.perUserPerDay) throw new CheckStop("daily_limit_user");
      tx.set(appRef, { count: appCount + 1 }, { merge: true });
      tx.set(userRef, { count: userCount + 1 }, { merge: true });
    });
  }

  /** Write the final state. `finishedAt` is always set. */
  private async finish(
    ref: DocumentReference,
    fields: Partial<DocumentCheckRecord> & Pick<DocumentCheckRecord, "status">
  ): Promise<void> {
    await ref.update({ ...fields, finishedAt: Timestamp.fromDate(this.deps.now()) });
  }
}

/** Raw facts back into extraction values, so the engine reads one shape on both paths. */
function toValues(raw: RawFacts) {
  return Object.entries(raw)
    .filter(([, v]) => v !== null)
    .map(([field, value]) => ({ field, value: value as string, unit: null, page: null, quote: null }));
}

/** Singleton over the real provider, Storage, Firestore and settings. */
export const documentCheckService = new DocumentCheckService();
