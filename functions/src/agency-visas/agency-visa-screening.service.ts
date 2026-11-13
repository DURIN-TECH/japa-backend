// ============================================
// Agency visas: listing screening (issue #120)
// ============================================
//
// When an agency submits a visa listing, or edits an already approved one,
// Seli screens it FOR AN ADMIN:
//
//  1. CODE comparison with the verified scraped record for the same route
//     (services/risk-rules/listing-comparison.rules.ts, pure functions);
//  2. a model that only LOCATES wording matching three published indicators
//     (services/risk-rules/listing-language.rules.ts); code validates every
//     flag, owns severity and raises the signal.
//
// The result is stored in `listingScreenings/{cc}__{visaId}` and raised as
// risk signals ONLY through riskSignalService.raiseRiskSignal (#119).
//
// WHAT SCREENING NEVER DOES (non-negotiable):
//  - change the listing, its review state, `isActive`, `visibility` or a
//    revision: this file writes only `listingScreenings`, `aiCosts` (caps)
//    and, through the risk-signal service, `riskSignals`;
//  - notify anyone: no notifyUser, email or push;
//  - reach an agency or applicant: no agency/applicant serializer includes
//    the screening doc, a signal, a count or a flag derived from one;
//  - fail or noticeably slow the agency's request: `screenAfterCommit` never
//    throws, stops waiting after SCREENING_BUDGET_MS, and logs failures
//    WITHOUT listing text or personal data (error class and code only).
//
// FAIL-SAFE the other way: a listing can never be approved unscreened without
// an admin acknowledging. `isScreeningClean` is false unless a screening doc
// for the CURRENT content exists with `languageCheck: "done"`, no mismatch and
// no flag; the review service answers 409 SCREENING_OPEN otherwise.

import { Timestamp, type Transaction } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import { AGENCY_VISA_SOURCE } from "@durin-tech/authz";
import { collections, db, subcollections } from "../utils/firebase";
import type { VisaRevision, VisaType } from "../types";
import {
  RISK_SIGNAL_ACTIVE_STATUSES,
  type RaiseRiskSignalInput,
  type RiskSignalEvidence,
} from "../types/risk-signal";
import type {
  LanguageNotRunReason,
  ListingLanguageFlag,
  ListingScreening,
  ScreeningTarget,
} from "../types/listing-screening";
import { riskSignalService } from "../services/risk-signal.service";
import { AnthropicLlmProvider, type LlmProvider } from "../services/ai/llm-provider";
import { readAiSettings, type AiSettings, type AiSettingsRead } from "../services/ai/ai-settings";
import { findInjectionSignals } from "../services/ai/prompt-safety";
import {
  buildListingScreeningRequest,
  listingTextFields,
  screeningContentHash,
} from "../services/ai/listing-screening-prompt";
import {
  FEE_UNIT_LABEL,
  LISTING_COMPARISON_VERSION,
  LISTING_MISMATCH_SIGNAL_TYPE,
  COMPARISON_RULES,
  compareListing,
  isFeeVerified,
  type ComparableListing,
  type ComparisonResult,
  type VerifiedRecord,
} from "../services/risk-rules/listing-comparison.rules";
import {
  LISTING_LANGUAGE_RULES,
  LISTING_LANGUAGE_SIGNAL_TYPE,
  LISTING_LANGUAGE_VERSION,
  validateListingFlags,
} from "../services/risk-rules/listing-language.rules";
import { AGENCY_VISA_CONTENT_FIELDS, AgencyVisaError, pickContent } from "./agency-visa.validation";
import { createHash } from "crypto";

// ============================================
// Constants
// ============================================

/**
 * Longest the agency's request waits for screening, in ms. The model request
 * has its own 12 s timeout (the SDK may retry once); this is the outer guard
 * so a slow provider can never hold the response much longer.
 */
export const SCREENING_BUDGET_MS = 20_000;

/** Rule id and version of the "language check did not run" signal. */
export const SCREENING_INCOMPLETE_RULE_ID = "listing_screening_incomplete";
export const SCREENING_INCOMPLETE_VERSION = "1";

/** Doc key of a screening, mismatching signal subject and `visaRevisions` key: `{cc}__{visaId}`. */
export function screeningKey(countryCode: string, visaId: string): string {
  return `${countryCode}__${visaId}`;
}

// ============================================
// Pure helpers (exported for tests)
// ============================================

/**
 * The content that would go live for a revision: the live content with the
 * revision's `changes` applied (null removes a field). Same key rules as the
 * review service's applyRevision (content fields only, never countryCode), kept
 * here so this file does not import the review service (which imports it).
 */
export function revisionContent(visa: Partial<VisaType>, changes: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...pickContent(visa) };
  for (const field of AGENCY_VISA_CONTENT_FIELDS) {
    if (field === "countryCode") continue;
    if (!Object.prototype.hasOwnProperty.call(changes, field)) continue;
    const v = changes[field];
    if (v === null) delete out[field];
    else out[field] = v;
  }
  return out;
}

/**
 * What screening is about for an agency visa right now, or null when nothing
 * is waiting for review: a `pending_review` visa (target "visa") or an
 * approved visa with a `pending_review` revision (target "revision").
 */
export function screeningTargetFor(
  visa: Partial<VisaType>,
  revision: Partial<VisaRevision> | null
): { target: ScreeningTarget; content: Record<string, unknown> } | null {
  if (visa.reviewStatus === "pending_review") return { target: "visa", content: pickContent(visa) };
  if (visa.reviewStatus === "approved" && revision && revision.reviewStatus === "pending_review") {
    return { target: "revision", content: revisionContent(visa, (revision.changes ?? {}) as Record<string, unknown>) };
  }
  return null;
}

/**
 * Is the screening doc CLEAN for the content about to go live? True only when
 * it exists, is for this target and this exact content (hash), the language
 * check is done, and there is no mismatch and no flag. Anything else (no doc,
 * a stale doc from an earlier submit, a failed check) is "open".
 */
export function isScreeningClean(
  doc: Partial<ListingScreening> | null | undefined,
  expected: { target: ScreeningTarget; contentHash: string }
): boolean {
  if (!doc) return false;
  if (doc.target !== expected.target || doc.contentHash !== expected.contentHash) return false;
  if (doc.languageCheck !== "done") return false;
  if ((doc.flags ?? []).length > 0) return false;
  return !(doc.comparisons ?? []).some((c) => c.verdict === "mismatch");
}

/** UTC day key `YYYY-MM-DD` for the `aiCosts/{day}` counters. */
export function utcDayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** First 16 hex chars of a sha256 of `text` (a quote's hash in signal evidence; the text itself is never stored). */
function shortHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** Money as a signal labels it: whole US dollars, major unit. */
function usd(value: number) {
  return { value, currency: "USD", unit: "major" as const };
}

/**
 * Evidence of one MISMATCH signal: references and structured facts only
 * (field name, content hash, money as {value, currency, unit}); never listing
 * text, a quote, a sponsor name or a contact.
 */
export function mismatchEvidence(
  c: ComparisonResult,
  contentHash: string,
  countryCode: string,
  verifiedVisaId: string
): RiskSignalEvidence[] {
  const verifiedRef = `countries/${countryCode}/visaTypes/${verifiedVisaId}#${c.field}`;
  // The hash is part of the ref, so an edit adds NEW evidence and merges into the active signal.
  const evidence: RiskSignalEvidence[] = [{ kind: "listing_content", ref: contentHash }];
  if (c.field === "baseCostUsd" && typeof c.listingValue === "number" && typeof c.verifiedValue === "number") {
    evidence.push(
      { kind: "listing_value", ref: `${c.field}#${contentHash}`, note: `fee in ${FEE_UNIT_LABEL}`, amount: usd(c.listingValue) },
      { kind: "verified_value", ref: verifiedRef, note: `fee in ${FEE_UNIT_LABEL}`, amount: usd(c.verifiedValue) }
    );
  } else {
    evidence.push(
      { kind: "field_mismatch", ref: `${c.field}#${contentHash}`, note: "field differs from the verified record" },
      { kind: "verified_record", ref: verifiedRef }
    );
  }
  return evidence;
}

/** Character offsets of a quote inside its field's text (first occurrence). */
function offsetsOf(fields: Record<string, string>, flag: ListingLanguageFlag): { start: number; end: number } {
  const start = (fields[flag.field] ?? "").indexOf(flag.quote);
  return { start: Math.max(0, start), end: Math.max(0, start) + flag.quote.length };
}

/**
 * Evidence of one LANGUAGE signal: per flag the field name, character offsets
 * and a hash of the quote, plus the content hash. The quote itself stays on
 * the admin-only screening doc.
 */
export function languageEvidence(
  flags: ListingLanguageFlag[],
  fields: Record<string, string>,
  contentHash: string
): RiskSignalEvidence[] {
  const evidence: RiskSignalEvidence[] = [{ kind: "listing_content", ref: contentHash }];
  for (const f of flags) {
    const { start, end } = offsetsOf(fields, f);
    evidence.push({ kind: "language_flag", ref: `${f.field}:${start}-${end}:sha256:${shortHash(f.quote)}` });
  }
  return evidence;
}

// ============================================
// Types
// ============================================

/** What to screen. */
export interface ScreenInput {
  target: ScreeningTarget;
  countryCode: string;
  visaId: string;
  ownerAgencyId: string;
  /** The content fields that would go live (see screeningTargetFor). */
  content: Record<string, unknown>;
}

/** What a screening did. `unchanged` = same content and language check already done: doc not rewritten. */
export interface ScreenResult {
  status: "screened" | "unchanged";
  screening: ListingScreening;
  /** Outcome of each raiseRiskSignal call (created, merged, unchanged, suppressed), for tests and logs. */
  signalOutcomes: string[];
}

/** Collaborators, swappable in tests. */
export interface ScreeningDeps {
  /** Model provider (default: the real Anthropic provider). */
  provider: LlmProvider;
  /** Settings reader (default: appConfig/aiSettings). */
  readSettings: () => Promise<AiSettingsRead>;
  runTransaction: <T>(fn: (tx: Transaction) => Promise<T>) => Promise<T>;
  now: () => Date;
}

/** Result of the language step. */
type LanguageResult =
  | { check: "done"; flags: ListingLanguageFlag[]; dropped: number }
  | { check: "not_run"; reason: LanguageNotRunReason };

// ============================================
// Service
// ============================================

class AgencyVisaScreeningService {
  /** Collaborators; tests replace them. */
  deps: ScreeningDeps = {
    provider: new AnthropicLlmProvider(),
    readSettings: readAiSettings,
    runTransaction: (fn) => db.runTransaction(fn),
    now: () => new Date(),
  };

  // ------------------------------------------
  // Hook entry point (called by the agency service after the commit)
  // ------------------------------------------

  /**
   * Screen after the agency's transaction committed. NEVER throws and stops
   * waiting after SCREENING_BUDGET_MS: the agency endpoint's status and body
   * are identical whether screening succeeded, failed or was skipped.
   * Failures are logged with the error class only (no text, no personal data).
   */
  async screenAfterCommit(input: ScreenInput): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const budget = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), SCREENING_BUDGET_MS);
        timer.unref?.();
      });
      const outcome = await Promise.race([this.screen(input).then(() => "done" as const), budget]);
      if (outcome === "timeout") logger.error("listing_screening_failed", { stage: "budget", target: input.target });
    } catch (error) {
      // Class and code only: a message could echo a query value or listing text.
      logger.error("listing_screening_failed", {
        stage: "screen",
        target: input.target,
        error: error instanceof Error ? error.name : "unknown",
        code: (error as { code?: string | number } | undefined)?.code,
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // ------------------------------------------
  // Core
  // ------------------------------------------

  /**
   * Screen one listing: compare in code, check the language with the model
   * (subject to settings and caps), raise signals, store the result.
   *
   * Idempotent on `contentHash`: the same content with `languageCheck` already
   * "done" rewrites nothing and calls no model; signals are re-raised and come
   * back `unchanged`. A changed hash writes a new doc and adds new evidence,
   * so the active signal is merged, not duplicated.
   *
   * @throws only on an unexpected store failure; callers use screenAfterCommit.
   */
  async screen(input: ScreenInput): Promise<ScreenResult> {
    const contentHash = screeningContentHash(input.target, input.content);
    const key = screeningKey(input.countryCode, input.visaId);
    const ref = collections.listingScreenings.doc(key);
    const priorSnap = await ref.get();
    const prior = priorSnap.exists ? (priorSnap.data() as ListingScreening) : null;
    const reuse = !!prior && prior.contentHash === contentHash && prior.target === input.target && prior.languageCheck === "done";

    // ---- 1. Code comparison (no model) ----
    const found = await this.findVerifiedRecord(input.countryCode, input.content.code);
    const comparisons = compareListing(input.content as ComparableListing, found.record, found.ambiguous);

    // ---- 2. Language check (model locates, code validates) ----
    const fields = listingTextFields(input.content);
    const language: LanguageResult = reuse
      ? { check: "done", flags: (prior as ListingScreening).flags, dropped: (prior as ListingScreening).droppedFlags }
      : await this.runLanguageCheck(input, fields);
    const injectionSuspected = findInjectionSignals(Object.values(fields).join("\n"));

    // ---- 3. Signals (only through raiseRiskSignal) ----
    const raised = await this.raiseSignals(input, contentHash, comparisons, language, fields, found.record?.id ?? null);

    if (reuse) return { status: "unchanged", screening: prior as ListingScreening, signalOutcomes: raised.outcomes };

    // ---- 4. Store the result (one doc per listing, overwritten on new content) ----
    const screening: ListingScreening = {
      target: input.target,
      contentHash,
      ranAt: Timestamp.fromDate(this.deps.now()),
      countryCode: input.countryCode,
      visaId: input.visaId,
      ownerAgencyId: input.ownerAgencyId,
      // `source` is only for the signal; the stored comparison keeps the plain facts.
      comparisons: comparisons.map(({ source: _source, ...c }) => c),
      verifiedVisaId: found.record?.id ?? null,
      languageCheck: language.check,
      ...(language.check === "not_run" ? { notRunReason: language.reason } : {}),
      flags: language.check === "done" ? language.flags : [],
      droppedFlags: language.check === "done" ? language.dropped : 0,
      injectionSuspected,
      signalIds: raised.ids,
    };
    await ref.set(screening);
    return { status: "screened", screening, signalOutcomes: raised.outcomes };
  }

  // ------------------------------------------
  // Verified record
  // ------------------------------------------

  /**
   * The verified scraped record for the listing's route, or none. A record
   * qualifies when it is in the same country, `source: "scraped"`,
   * `reviewStatus: "approved"`, `isActive`, and its `code` equals the
   * listing's code after trim and upper-casing. If more than one qualifies the
   * match is ambiguous and none is trusted.
   *
   * Query: `countries/{cc}/visaTypes` where `source ==` and `reviewStatus ==`
   * (equality only: no composite index); the rest is checked in code.
   */
  async findVerifiedRecord(
    countryCode: string,
    listingCode: unknown
  ): Promise<{ record: VerifiedRecord | null; ambiguous: boolean }> {
    if (typeof listingCode !== "string" || !listingCode.trim()) return { record: null, ambiguous: false };
    const wanted = listingCode.trim().toUpperCase();
    const snap = await subcollections
      .visaTypes(countryCode)
      .where("source", "==", "scraped")
      .where("reviewStatus", "==", "approved")
      .get();
    const matches = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }) as VisaType)
      .filter((v) => v.isActive === true && typeof v.code === "string" && v.code.trim().toUpperCase() === wanted);
    if (matches.length === 0) return { record: null, ambiguous: false };
    if (matches.length > 1) return { record: null, ambiguous: true };
    return { record: toVerifiedRecord(matches[0]), ambiguous: false };
  }

  // ------------------------------------------
  // Language check
  // ------------------------------------------

  /**
   * Run the model step, or say why it did not run. Order: settings (a failed
   * read fails closed), kill switch, caps (claimed in one transaction), then
   * the call. Any provider problem is `model_failed`; the reply is validated
   * flag by flag in code.
   */
  private async runLanguageCheck(input: ScreenInput, fields: Record<string, string>): Promise<LanguageResult> {
    const read = await this.deps.readSettings();
    if (!read.ok) return { check: "not_run", reason: "settings_unavailable" };
    if (!read.settings.enabled) return { check: "not_run", reason: "ai_disabled" };
    // Nothing to read: the check is trivially done, no model call, no cap used.
    if (Object.keys(fields).length === 0) return { check: "done", flags: [], dropped: 0 };

    if ((await this.claimCaps(input.ownerAgencyId, read.settings)) !== "ok") {
      return { check: "not_run", reason: "cap_reached" };
    }

    try {
      const response = await this.deps.provider.complete(buildListingScreeningRequest(fields));
      // A refusal or cut-off reply is a failure, not "no flags".
      if (response.stopReason !== "end_turn") return { check: "not_run", reason: "model_failed" };
      const validated = validateListingFlags(response.text, fields);
      if (!validated.ok) return { check: "not_run", reason: "model_failed" };
      return { check: "done", flags: validated.accepted, dropped: validated.dropped };
    } catch (error) {
      // Class and code only, never the prompt, the reply or the error message.
      logger.error("listing_screening_model_failed", {
        error: error instanceof Error ? error.name : "unknown",
        code: (error as { code?: string | number } | undefined)?.code,
      });
      return { check: "not_run", reason: "model_failed" };
    }
  }

  /**
   * Claim one model request against both daily caps in ONE transaction
   * (`aiCosts/{day}`: `listingScreenings` and a per-agency map), the way chat
   * claims its caps. Fails closed: a transaction error counts as not run.
   */
  private async claimCaps(agencyId: string, s: AiSettings): Promise<"ok" | "cap_reached"> {
    const costRef = collections.aiCosts.doc(utcDayKey(this.deps.now()));
    try {
      return await this.deps.runTransaction(async (tx): Promise<"ok" | "cap_reached"> => {
        const snap = await tx.get(costRef);
        const c = (snap.exists ? snap.data() : {}) as {
          listingScreenings?: number;
          listingScreeningsByAgency?: Record<string, number>;
        };
        const total = Number(c.listingScreenings ?? 0);
        const mine = Number(c.listingScreeningsByAgency?.[agencyId] ?? 0);
        if (total >= s.listingScreeningsPerDay) return "cap_reached";
        if (mine >= s.listingScreeningsPerAgencyPerDay) return "cap_reached";
        tx.set(
          costRef,
          { listingScreenings: total + 1, listingScreeningsByAgency: { [agencyId]: mine + 1 } },
          { merge: true }
        );
        return "ok";
      });
    } catch {
      return "cap_reached";
    }
  }

  // ------------------------------------------
  // Signals
  // ------------------------------------------

  /**
   * Raise the signals for one screening, each through raiseRiskSignal and each
   * isolated: one failing never stops the others or the stored result.
   *  - one `listing_contradicts_verified_record` per mismatching field, sourced
   *    from the verified record's own URL and citation;
   *  - one `listing_recruitment_language` per indicator with accepted flags,
   *    sourced from the rule's published quote (the model only locates);
  *  - one low `listing_screening_incomplete` when the language check did not run.
   * A listing with no mismatch and no flag raises nothing.
   */
  private async raiseSignals(
    input: ScreenInput,
    contentHash: string,
    comparisons: ComparisonResult[],
    language: LanguageResult,
    fields: Record<string, string>,
    verifiedVisaId: string | null
  ): Promise<{ ids: string[]; outcomes: string[] }> {
    const subject = { type: "visa" as const, id: screeningKey(input.countryCode, input.visaId) };
    const inputs: RaiseRiskSignalInput[] = [];

    // ---- mismatches (code) ----
    for (const c of comparisons) {
      if (c.verdict !== "mismatch" || !c.source || !verifiedVisaId) continue;
      const rule = COMPARISON_RULES.find((r) => r.field === c.field);
      if (!rule) continue;
      inputs.push({
        subject,
        category: rule.category,
        type: LISTING_MISMATCH_SIGNAL_TYPE,
        severity: "medium",
        evidence: mismatchEvidence(c, contentHash, input.countryCode, verifiedVisaId),
        source: {
          kind: "rule",
          ruleId: rule.ruleId,
          version: LISTING_COMPARISON_VERSION,
          sourceUrl: c.source.sourceUrl,
          sourceQuote: c.source.sourceQuote,
        },
        dedupeKey: `${rule.ruleId}:${subject.type}:${subject.id}`,
      });
    }

    // ---- language (model located, code validated) ----
    if (language.check === "done") {
      for (const rule of LISTING_LANGUAGE_RULES) {
        const finding = rule.evaluate({ flags: language.flags });
        if (!finding) continue;
        inputs.push({
          subject,
          category: rule.category,
          type: LISTING_LANGUAGE_SIGNAL_TYPE,
          severity: rule.severity,
          evidence: languageEvidence(finding.flags, fields, contentHash),
          source: {
            kind: "rule",
            ruleId: rule.ruleId,
            version: LISTING_LANGUAGE_VERSION,
            sourceUrl: rule.sourceUrl,
            sourceQuote: rule.sourceQuote,
          },
          dedupeKey: `${rule.ruleId}:${subject.type}:${subject.id}`,
        });
      }
    } else {
      // ---- the gap itself is visible in the queue ----
      inputs.push({
        subject,
        category: "scam",
        type: "listing_screening_incomplete",
        severity: "low",
        evidence: [
          { kind: "listing_content", ref: contentHash },
          { kind: "screening_gap", ref: `${language.reason}#${contentHash}`, note: `language check not run: ${language.reason}` },
        ],
        source: { kind: "rule", ruleId: SCREENING_INCOMPLETE_RULE_ID, version: SCREENING_INCOMPLETE_VERSION },
        dedupeKey: `${SCREENING_INCOMPLETE_RULE_ID}:${subject.type}:${subject.id}`,
      });
    }

    const ids: string[] = [];
    const outcomes: string[] = [];
    for (const signal of inputs) {
      try {
        const r = await riskSignalService.raiseRiskSignal(signal);
        outcomes.push(r.outcome);
        if (!ids.includes(r.signalId)) ids.push(r.signalId);
      } catch (error) {
        logger.error("listing_screening_signal_failed", {
          ruleId: signal.source.ruleId,
          error: error instanceof Error ? error.name : "unknown",
          field: (error as { field?: string } | undefined)?.field,
        });
      }
    }
    return { ids, outcomes };
  }

  // ------------------------------------------
  // Admin reads
  // ------------------------------------------

  /** The stored screening of one listing, or null. */
  async getScreening(countryCode: string, visaId: string): Promise<ListingScreening | null> {
    const snap = await collections.listingScreenings.doc(screeningKey(countryCode, visaId)).get();
    return snap.exists ? (snap.data() as ListingScreening) : null;
  }

  /**
   * Admin list enrichment: for each agency visa, its stored screening (or
   * null) and the count of ACTIVE (open / in_review) risk signals about it.
   * Returns a map keyed `{cc}__{visaId}`. Reads: one doc get per visa, and ONE
   * query on active signals (`status in [open, in_review]`, single field, no
   * composite index) counted per subject in code.
   */
  async adminViews(
    visas: Array<Pick<VisaType, "id" | "countryCode">>
  ): Promise<Map<string, { screening: ListingScreening | null; openScreeningSignals: number }>> {
    const keys = visas.map((v) => screeningKey(v.countryCode, v.id));
    const [docs, active] = await Promise.all([
      Promise.all(keys.map((k) => collections.listingScreenings.doc(k).get())),
      collections.riskSignals.where("status", "in", [...RISK_SIGNAL_ACTIVE_STATUSES]).get(),
    ]);
    const counts = new Map<string, number>();
    for (const d of active.docs) {
      const s = d.data() as { subject?: { type?: string; id?: string } };
      if (s.subject?.type === "visa" && s.subject.id) counts.set(s.subject.id, (counts.get(s.subject.id) ?? 0) + 1);
    }
    const out = new Map<string, { screening: ListingScreening | null; openScreeningSignals: number }>();
    keys.forEach((k, i) => {
      out.set(k, {
        screening: docs[i].exists ? (docs[i].data() as ListingScreening) : null,
        openScreeningSignals: counts.get(k) ?? 0,
      });
    });
    return out;
  }

  /**
   * `POST /admin/visas/:id/screening/rerun`: screen the listing's CURRENT
   * target again (the recovery path after a model outage). Follows the same
   * idempotency rule and counts against the caps.
   *
   * @throws AgencyVisaError 404 for an unknown or non-agency visa; 409
   *   NO_SCREENING_TARGET when nothing is waiting for review
   */
  async rerun(
    countryCode: string,
    visaId: string
  ): Promise<{ result: ScreenResult; openScreeningSignals: number }> {
    const cc = countryCode.toUpperCase();
    const snap = await subcollections.visaTypes(cc).doc(visaId).get();
    const visa = snap.exists ? ({ id: snap.id, ...snap.data() } as VisaType) : null;
    if (!visa || visa.source !== AGENCY_VISA_SOURCE || !visa.ownerAgencyId) {
      throw new AgencyVisaError("NOT_FOUND", "Visa type not found", 404);
    }
    const revSnap = await collections.visaRevisions.doc(screeningKey(cc, visaId)).get();
    const target = screeningTargetFor(visa, revSnap.exists ? (revSnap.data() as VisaRevision) : null);
    if (!target) {
      throw new AgencyVisaError(
        "NO_SCREENING_TARGET",
        "This visa has nothing waiting for review, so there is nothing to screen",
        409
      );
    }
    const result = await this.screen({
      target: target.target,
      countryCode: cc,
      visaId,
      ownerAgencyId: visa.ownerAgencyId,
      content: target.content,
    });
    const views = await this.adminViews([{ id: visaId, countryCode: cc }]);
    return { result, openScreeningSignals: views.get(screeningKey(cc, visaId))?.openScreeningSignals ?? 0 };
  }
}

/** Reduce a stored scraped visa to what the comparison rules read. */
export function toVerifiedRecord(v: VisaType): VerifiedRecord {
  const meta = v.scrapeMeta as
    | { sourceUrl?: string; citations?: Record<string, string>; fee?: Record<string, unknown>; processingUnknown?: boolean }
    | undefined;
  return {
    id: v.id,
    sourceUrl: typeof meta?.sourceUrl === "string" ? meta.sourceUrl : "",
    citations: meta?.citations ?? {},
    baseCostUsd: typeof v.baseCostUsd === "number" ? v.baseCostUsd : null,
    feeVerified: isFeeVerified(meta?.fee, v.baseCostUsd),
    category: v.category ?? null,
    isExtendable: typeof v.isExtendable === "boolean" ? v.isExtendable : null,
    processingDaysMin: typeof v.processingDaysMin === "number" ? v.processingDaysMin : null,
    processingDaysMax: typeof v.processingDaysMax === "number" ? v.processingDaysMax : null,
    processingUnknown: meta?.processingUnknown === true,
  };
}

export const agencyVisaScreeningService = new AgencyVisaScreeningService();
