// ============================================
// Rubric review (issue #125) — shared test fixtures
// ============================================
//
// Not a test file. Builds rubric versions BY HAND (no model, no extraction
// run) from the invented guidance of fixtures/synthetic-guidance.ts, in the
// exact shape extraction stores them: ids derived with the real
// `criterionIdOf`, the source-set hash with the real `sourceSetHashOf`, flags
// from the real validator. Used by the unit suite (in-memory Firestore fake)
// and by the emulator suite (real Firestore emulator), so it touches no
// Firestore itself.
//
// Two fictional routes in two fictional jurisdictions (codes from the ISO
// user-assigned range), with OPPOSITE intent polarity: route A is a web page,
// route B a PDF. Nothing here is, or is derived from, a real immigration rule.

import { Timestamp } from "firebase-admin/firestore";
import { criterionIdOf, sourceSetHashOf } from "../../../src/scrapers/rubric/rubric-extraction.service";
import { validateVisaRubric } from "../../../src/scrapers/rubric/rubric-validate";
import type { RubricDraft } from "../../../src/scrapers/rubric/rubric.store";
import {
  DEFAULT_SEVERITY_LEVELS,
  RUBRIC_SCHEMA_VERSION,
  type AssessmentCriterion,
  type IntentPolarity,
  type RubricCitation,
  type RubricSourceSnapshot,
} from "../../../src/types/rubric";
import { A_LINES, B_QUOTES, ROUTE_A, ROUTE_B, SOURCE_A_ID, SOURCE_A_URL, SOURCE_B_ID, SOURCE_B_URL } from "./fixtures/synthetic-guidance";

/** The clock the fixtures are stamped with. */
export const REVIEW_T0 = Date.parse("2026-11-11T02:00:00Z");

export const KEY_A = `${ROUTE_A.countryCode}_${ROUTE_A.visaTypeId}`;
export const KEY_B = `${ROUTE_B.countryCode}_${ROUTE_B.visaTypeId}`;

/** Strip the leading paragraph reference ("SV 2.1 ") from a fixture line. */
export const body = (line: string) => line.replace(/^[A-Z]+ [\d.]+ /, "");

// ----- Route A, as its page changes -----

/** The sentence of route A that carries its polarity. */
export const A_POLARITY_QUOTE = "An intention to remain beyond the visit counts against the applicant.";

/**
 * Route A's page after the publisher edits it:
 *  - SV 2.1: the age goes from 18 to 21 (same paragraph, new words);
 *  - SV 3.1: the sentence about intention now says the opposite;
 *  - SV 4.1 (the nationality bar) is gone;
 *  - SV 6.1 (insurance) is new.
 * SV 2.2 is word for word what it was.
 */
export const A2_LINES = {
  heading: A_LINES.heading,
  updated: "Last updated: 9 September 2026",
  validity: A_LINES.validity,
  age: "SV 2.1 An applicant must be aged 21 or over on the date of application.",
  held: A_LINES.held,
  leave: "SV 3.1 The decision maker must be satisfied that the applicant will leave Avalen at the end of the visit. An intention to settle later does not count against the applicant.",
  insurance: "SV 6.1 The applicant must hold travel insurance for the whole visit.",
};
export const A2_TEXT = Object.values(A2_LINES).join("\n");
export const A2_POLARITY_QUOTE = "An intention to settle later does not count against the applicant.";

// ----- Builders -----

/** The snapshot a criterion is cited to. */
export interface FixtureSource {
  sourceId: string;
  url: string;
  contentHash: string;
  docType: "html" | "pdf";
}

/** A citation to `src` for `quote`. */
export function citation(src: FixtureSource, quote: string, page?: number): RubricCitation {
  return { quote, sourceId: src.sourceId, url: src.url, contentHash: src.contentHash, ...(page ? { page } : {}), retrievedAt: new Date(REVIEW_T0 - 3_600_000).toISOString() };
}

/** A stored criterion: the id is derived exactly as extraction derives it. */
export function criterion(
  src: FixtureSource,
  f: Omit<Partial<AssessmentCriterion>, "source" | "criterionId"> & Pick<AssessmentCriterion, "title" | "kind"> & { quote: string; page?: number }
): AssessmentCriterion {
  const { quote, page, ...rest } = f;
  return {
    stage: "eligibility",
    severity: "high",
    confidence: 0.9,
    // A judgement criterion needs these two to pass the kind rules.
    ...(f.kind === "judgement" ? { probeFactors: ["ties outside the destination"], requiresInterviewBeforeRefusal: false } : {}),
    ...rest,
    criterionId: criterionIdOf(src.sourceId, quote, f.kind, f.check?.field),
    source: citation(src, quote, page),
  };
}

/** What `draft` takes besides the criteria. */
export interface DraftOptions {
  proposal?: { value: IntentPolarity; quote?: string; page?: number } | null;
  createdAtMs?: number;
  extra?: Partial<RubricDraft>;
}

/**
 * A pristine `pending_review` draft, as extraction would hand it to
 * `RubricStore.writePendingVersion`. Its flags are computed the way the
 * extraction service computes them (validator flags, plus the
 * suspicious-passages flag when there are any).
 */
export function draft(route: { countryCode: string; visaTypeId: string }, sources: FixtureSource[], criteria: AssessmentCriterion[], opts: DraftOptions = {}): RubricDraft {
  const sourceSnapshots: RubricSourceSnapshot[] = sources.map((s) => ({ sourceId: s.sourceId, contentHash: s.contentHash, url: s.url, docType: s.docType }));
  const p = opts.proposal;
  const d: RubricDraft = {
    schemaVersion: RUBRIC_SCHEMA_VERSION,
    routeKey: `${route.countryCode}_${route.visaTypeId}`,
    countryCode: route.countryCode,
    visaTypeId: route.visaTypeId,
    reviewStatus: "pending_review",
    intentPolarity: null,
    reviewedBy: null,
    reviewedAt: null,
    rejectReason: null,
    revision: 0,
    supersededAt: null,
    intentPolarityProposal: p ? { value: p.value, ...(p.quote ? { source: citation(sources[0], p.quote, p.page) } : {}) } : null,
    severityLevels: [...DEFAULT_SEVERITY_LEVELS],
    criteria,
    intakeQuestions: [],
    evidenceItems: [],
    sourceSnapshots,
    sourceSetHash: sourceSetHashOf(sourceSnapshots),
    extractorModel: "recorded-model",
    extractorPromptVersion: "test-prompt-v1",
    extractionRunId: `run-${route.visaTypeId}-${opts.createdAtMs ?? REVIEW_T0}`,
    discardedCount: 0,
    discarded: [],
    suspiciousPassages: [],
    flags: [],
    createdAt: Timestamp.fromMillis(opts.createdAtMs ?? REVIEW_T0),
    ...opts.extra,
  };
  const validation = validateVisaRubric({ ...d, version: 1 });
  if (validation.errors.length > 0) throw new Error(`fixture rubric is invalid: ${validation.errors.map((e) => e.code).join(", ")}`);
  d.flags = [...d.flags, ...validation.flags];
  if (d.suspiciousPassages.length > 0) d.flags.push({ code: "suspicious_passages", message: "passages read as instructions to a reader model", target: "rubric" });
  return d;
}

/** Route A's source at a given snapshot hash. */
export const sourceA = (contentHash: string): FixtureSource => ({ sourceId: SOURCE_A_ID, url: SOURCE_A_URL, contentHash, docType: "html" });
/** Route B's source at a given snapshot hash. */
export const sourceB = (contentHash: string): FixtureSource => ({ sourceId: SOURCE_B_ID, url: SOURCE_B_URL, contentHash, docType: "pdf" });

/**
 * Route A, first reading of its page: an age check, a holding period, a
 * judgement about intent and a nationality-scoped bar. An intention to remain
 * counts AGAINST the applicant.
 */
export function routeAV1(contentHash: string, opts: DraftOptions = {}): RubricDraft {
  const s = sourceA(contentHash);
  return draft(
    ROUTE_A,
    [s],
    [
      criterion(s, { title: "Aged 18 or over", kind: "objective", ruleRef: "SV 2.1", quote: body(A_LINES.age), check: { field: "applicant.age", op: "gte", value: 18 } }),
      criterion(s, { title: "Funds held for 28 days", kind: "objective", ruleRef: "SV 2.2", quote: body(A_LINES.held), check: { field: "funds.balance", op: "heldForDays", value: 28, unit: "days" } }),
      criterion(s, { title: "Will leave at the end of the visit", kind: "judgement", stage: "credibility", ruleRef: "SV 3.1", quote: "The decision maker must be satisfied that the applicant will leave Avalen at the end of the visit.", concernsIntent: true }),
      criterion(s, { title: "Nationals refused from a stated date", kind: "mandatory_bar", stage: "suitability", severity: "critical", ruleRef: "SV 4.1", quote: body(A_LINES.bar), appliesTo: { nationalities: ["QM", "QN"], asWritten: ["Borduria", "Syldavia"] }, validFrom: "2026-03-26" }),
    ],
    { proposal: { value: "immigrant_intent_penalised", quote: A_POLARITY_QUOTE }, ...opts }
  );
}

/**
 * Route A, read again after the page changed (A2_LINES): the age rule has new
 * words, the holding period is the same passage with a lower severity, the
 * bar is gone, insurance is new, and the proposed polarity has FLIPPED.
 */
export function routeAV2(contentHash: string, opts: DraftOptions = {}): RubricDraft {
  const s = sourceA(contentHash);
  return draft(
    ROUTE_A,
    [s],
    [
      criterion(s, { title: "Aged 21 or over", kind: "objective", ruleRef: "SV 2.1", quote: body(A2_LINES.age), check: { field: "applicant.age", op: "gte", value: 21 } }),
      criterion(s, { title: "Funds held for 28 days", kind: "objective", severity: "medium", ruleRef: "SV 2.2", quote: body(A2_LINES.held), check: { field: "funds.balance", op: "heldForDays", value: 28, unit: "days" } }),
      criterion(s, { title: "Will leave at the end of the visit", kind: "judgement", stage: "credibility", ruleRef: "SV 3.1", quote: "The decision maker must be satisfied that the applicant will leave Avalen at the end of the visit.", concernsIntent: true }),
      criterion(s, { title: "Travel insurance for the whole visit", kind: "objective", ruleRef: "SV 6.1", quote: body(A2_LINES.insurance), check: { field: "insurance.coversVisit", op: "present" } }),
    ],
    { proposal: { value: "dual_intent_permitted", quote: A2_POLARITY_QUOTE }, createdAtMs: REVIEW_T0 + 86_400_000, ...opts }
  );
}

/**
 * Route B (PDF): a judgement about ties (page 2) and a tuition check (page 3).
 * Holding a temporary and a longer-term intention together is ALLOWED.
 */
export function routeBV1(contentHash: string, opts: DraftOptions = {}): RubricDraft {
  const s = sourceB(contentHash);
  return draft(
    ROUTE_B,
    [s],
    [
      criterion(s, { title: "Ties, study plan and previous travel", kind: "judgement", stage: "credibility", ruleRef: "G 3", quote: B_QUOTES.tiesRewrapped, page: 2, concernsIntent: true, requiresInterviewBeforeRefusal: true }),
      criterion(s, { title: "Tuition for the first 12 months", kind: "objective", ruleRef: "G 5", quote: B_QUOTES.tuition, page: 3, check: { field: "tuition.monthsCovered", op: "gte", value: 12, unit: "months" } }),
    ],
    { proposal: { value: "dual_intent_permitted", quote: B_QUOTES.dual, page: 2 }, createdAtMs: REVIEW_T0 + 3_600_000, ...opts }
  );
}
