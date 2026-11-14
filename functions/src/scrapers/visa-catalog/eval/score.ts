import type { ExtractedFeeComponent, ExtractedVisa, FeeComponentKind, FeeComponentPer } from "../types";
import {
  FIELD_WEIGHTS,
  OVERALL_PASS_THRESHOLD,
  PROCESSING_DAYS_MIN_TOLERANCE_DAYS,
  PROCESSING_DAYS_TOLERANCE,
  ROUTE_PASS_THRESHOLD,
  SCORED_FIELDS,
  type ScoredField,
} from "./config";
// Issue #87: the same pure processing-vs-citation check the validator runs.
// Dependency-free module (no Firebase, no LLM client), so the scorer stays free.
import { checkProcessingRangeCitations } from "../visa-catalog-processing-check";

// ============================================
// VISA EXTRACTION EVAL — SCORER (pure, issue #60)
// ============================================
//
// Compares one route's hand-verified expected values (src/scrapers/visa-catalog/eval/golden/<route>/
// expected.json) with what the real extractor returned (an ExtractedVisa) and
// returns per-field results. Deterministic and free: NO network, NO Firebase,
// NO second LLM ("LLM-as-judge" is deliberately out of scope — cost and
// non-determinism). Only `import type` from src/, plus the dependency-free
// src/scrapers/visa-catalog/visa-catalog-processing-check.ts (#87), so importing this
// module loads nothing but ./config and that pure check.
//
// Field types (see src/scrapers/visa-catalog/eval/README.md "How a run is scored"):
//   exact        category, isExtendable
//   fee          feeComponents — set-based exact match on kind/amount/currency/
//                per/years; any missing, extra, wrong-amount or wrong-years
//                component, or `feeUnverifiedReasons` on the output, is a
//                MISMATCH (and a mismatch fails the whole run: hard gate).
//   numeric      processingDaysMin/Max — within +/- PROCESSING_DAYS_TOLERANCE
//                (at least PROCESSING_DAYS_MIN_TOLERANCE_DAYS) of `value`, or
//                inside an inclusive `range` when the page only bounds it
//                ("within 3 weeks" bounds the minimum to 0..21 days)
//   text         name (case/punctuation-insensitive containment),
//                validityPeriod (contains the expected year/month numbers)
//   eligibility  fraction of expected themes with >= 1 keyword alternative
//                present in the joined eligibilityCriteria
//   url          applicationUrlHost — host of applicationUrl equals expected
//
// Plus one HARD gate that is not a scored field (issue #87): processing
// citation mismatch — processingDaysMin/Max more than PROCESSING_DAYS_TOLERANCE
// (at least PROCESSING_DAYS_MIN_TOLERANCE_DAYS) from EVERY duration stated in
// the output's own processing citations (Standard Visitor: max 56 with only
// "within 3 weeks" cited). The value can match expected.json and still fail
// this: a number a reviewer cannot trace to a quote is not acceptable.

// ----- Expected shape (expected.json) -----

/** Every expected value carries a verbatim quote from guide.json. */
interface Sourced {
  source: string; // verbatim quote (plain text of a part, or a raw href for URLs)
}

/** Expected exact value (category, isExtendable, name core, URL host). */
export interface ExpectedValue<T> extends Sourced {
  value: T;
}

/** Expected number: a point value (+/- tolerance) or an inclusive range. */
export interface ExpectedNumber extends Sourced {
  value?: number; // pass within +/- tolerance of this…
  range?: [number, number]; // …or inside [lo, hi] (when the page only bounds it)
}

/** One duration the validityPeriod text must state, e.g. { amount: 5, unit: "year" }. */
export interface ExpectedDuration {
  amount: number;
  unit: "year" | "month";
}

/** Expected validity: every listed duration must appear in the actual text. */
export interface ExpectedValidity extends Sourced {
  durations: ExpectedDuration[];
}

/** One eligibility theme: hit when ANY keyword alternative appears (whole words). */
export interface ExpectedTheme extends Sourced {
  theme: string; // human description of the requirement
  anyOf: string[]; // keyword alternatives (case-insensitive, whole-word)
}

/** One expected fee component (as published, source currency). */
export interface ExpectedFeeComponent extends Sourced {
  kind: FeeComponentKind;
  amount: number;
  currency: string;
  per: FeeComponentPer;
  years?: number; // only when per === "year"
  yearsSource?: string; // verbatim quote stating the length used for `years`
  // Issue #69: set when the component comes from a LINKED page, not the
  // route's guide: the src/scrapers/visa-catalog/eval/golden/_linked/<linkedPage>/guide.json fixture
  // that `source` is quoted from (the test checks the quote there).
  linkedPage?: string;
  // Issue #69: for a linked surcharge charged for a REGISTRY-ASSUMED length
  // (variable-length routes), the registry's stated assumption, verbatim
  // (replaces `yearsSource`: the length is not on any page).
  yearsAssumed?: string;
}

/**
 * Issue #187: one expected item classification. `match` = keyword alternatives
 * (whole words, any one) that find the item in the extractor's
 * `requiredDocuments`; `kind` / `need` are what the PAGE's wording says.
 */
export interface ExpectedItemKind extends Sourced {
  match: string[];
  kind: "document" | "information";
  need: "required" | "conditional" | "optional";
}

/** A known, tracked gap: reported in every run, never fails it. */
export interface KnownGap {
  field: ScoredField;
  ref: string; // tracker ref, e.g. "#69"
  note: string;
}

/** The whole expected.json for one route. */
export interface ExpectedVisa {
  route: string; // golden dir name, e.g. "skilled-worker-visa"
  sourceUrl: string; // the GOV.UK page
  fixtureRecordedAt: string; // guide.json `_fixture.recordedAt` these values were drafted from
  draftedBy: string;
  // Human verification against the LIVE page. "pending" until QA / the user
  // has checked; the PR cannot merge while any route is pending.
  verifiedBy: string;
  verifiedOn: string;
  notes?: string[]; // judgement calls a verifier should look at
  name: ExpectedValue<string>;
  category: ExpectedValue<string>;
  processingDaysMin: ExpectedNumber;
  processingDaysMax: ExpectedNumber;
  validityPeriod: ExpectedValidity;
  isExtendable: ExpectedValue<boolean>;
  eligibility: { themes: ExpectedTheme[] };
  applicationUrlHost: ExpectedValue<string>;
  feeComponents: { components: ExpectedFeeComponent[] };
  // Issue #187: optional; the field is scored only when present.
  documentKinds?: { items: ExpectedItemKind[] };
  knownGaps?: KnownGap[];
}

// ----- Result shape -----

/** Reporting group of a field. */
export type FieldType = "exact" | "fee" | "numeric" | "text" | "eligibility" | "url" | "itemKinds";

/** Field → reporting group. */
export const FIELD_TYPES: Record<ScoredField, FieldType> = {
  name: "text",
  category: "exact",
  processingDaysMin: "numeric",
  processingDaysMax: "numeric",
  validityPeriod: "text",
  isExtendable: "exact",
  eligibility: "eligibility",
  applicationUrlHost: "url",
  feeComponents: "fee",
  documentKinds: "itemKinds",
};

/** One field's result. */
export interface FieldResult {
  field: ScoredField;
  type: FieldType;
  weight: number;
  score: number; // 0..1 (binary except eligibility / validityPeriod)
  pass: boolean; // score === 1
  expected: unknown; // what was expected (for the report)
  actual: unknown; // what the extractor returned (for the report)
  detail?: string; // why it failed / what matched
}

/** One route's result. */
export interface RouteScore {
  route: string;
  score: number; // weighted mean of field scores, 0..1
  weightedSum: number; // sum(weight x score) — for the overall
  weightTotal: number; // sum(weight)
  fields: FieldResult[];
  feeMismatch: boolean; // true → hard gate fails
  // Issue #87: processing range vs its cited durations; non-empty → hard gate
  // fails. Optional so results files written before #87 still type-check.
  processingCitationProblems?: string[];
  notes: string[]; // known-gap notes etc. (never fail the run)
  knownGaps: KnownGap[];
  error?: string; // extraction failed → every field 0
}

/** The gate verdict over all routes. */
export interface GateResult {
  overall: number;
  pass: boolean;
  failures: string[]; // human-readable reasons (empty when pass)
  thresholds: { overall: number; route: number };
}

// ----- Normalisation helpers -----

/** Lower-case, straight quotes, every non-alphanumeric run → one space. */
export function normalizeWords(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\u2018\u2019\u201B]/g, "'")
    .replace(/[^a-z0-9£$,.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** name normalisation: like normalizeWords but punctuation dropped entirely. */
function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Escape a string for literal use inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True when `keyword` occurs in `text` as whole word(s) (both normalised). */
export function containsKeyword(text: string, keyword: string): boolean {
  const kw = normalizeWords(keyword);
  if (!kw) return false;
  // Whole-word boundaries (so "cos" doesn't match "costs"); digits count as word chars.
  return new RegExp(`(^|[^a-z0-9])${escapeRegExp(kw)}($|[^a-z0-9])`).test(normalizeWords(text));
}

// Number words the model may use instead of digits ("five years").
const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, eighteen: 18, "twenty-four": 24,
};

/** Every (amount, unit) duration stated in a text: "2 years and 9 months" → [2y, 9m]. */
export function durationsIn(text: string): ExpectedDuration[] {
  const out: ExpectedDuration[] = [];
  const re = /\b(\d+(?:\.\d+)?|[a-z]+(?:-[a-z]+)?)[\s-]*(years?|months?)\b/gi;
  for (const m of text.toLowerCase().matchAll(re)) {
    const n = /^\d/.test(m[1]) ? Number(m[1]) : NUMBER_WORDS[m[1]];
    if (n === undefined || !Number.isFinite(n)) continue;
    out.push({ amount: n, unit: m[2].startsWith("year") ? "year" : "month" });
  }
  return out;
}

/** Host of a URL, lower-cased; "" when absent / unparseable. */
export function urlHost(url: unknown): string {
  if (typeof url !== "string" || !url.trim()) return "";
  try {
    return new URL(url.trim()).host.toLowerCase();
  } catch {
    return "";
  }
}

// ----- Per-field scorers -----

/** Build a FieldResult (weight from FIELD_WEIGHTS, pass = score 1). */
function result(
  field: ScoredField,
  score: number,
  expected: unknown,
  actual: unknown,
  detail?: string
): FieldResult {
  return {
    field,
    type: FIELD_TYPES[field],
    weight: FIELD_WEIGHTS[field],
    score,
    pass: score === 1,
    expected,
    actual,
    ...(detail ? { detail } : {}),
  };
}

/** Exact equality (category, isExtendable). Missing actual → 0. */
function scoreExact(field: ScoredField, expected: unknown, actual: unknown): FieldResult {
  const ok = actual !== undefined && actual === expected;
  return result(field, ok ? 1 : 0, expected, actual, ok ? undefined : `expected ${JSON.stringify(expected)}`);
}

/** Allowed absolute deviation for an expected day count. */
export function processingTolerance(expected: number): number {
  return Math.max(PROCESSING_DAYS_MIN_TOLERANCE_DAYS, Math.abs(expected) * PROCESSING_DAYS_TOLERANCE);
}

/** Numeric tolerance (processingDaysMin/Max): point +/- tolerance, or inclusive range. */
function scoreNumber(field: ScoredField, expected: ExpectedNumber, actual: unknown): FieldResult {
  const exp = expected.range ? { range: expected.range } : { value: expected.value };
  if (typeof actual !== "number" || !Number.isFinite(actual)) {
    return result(field, 0, exp, actual, "missing / not a number");
  }
  if (expected.range) {
    const [lo, hi] = expected.range;
    const ok = actual >= lo && actual <= hi;
    return result(field, ok ? 1 : 0, exp, actual, ok ? undefined : `outside [${lo}, ${hi}]`);
  }
  const v = expected.value ?? NaN;
  const tol = processingTolerance(v);
  const ok = Math.abs(actual - v) <= tol;
  // Rounded for display only (0.2 x 56 prints as 11.200000000000001 otherwise).
  return result(field, ok ? 1 : 0, exp, actual, ok ? undefined : `outside ${v} +/- ${Number(tol.toFixed(2))}`);
}

/** name: normalised actual contains the normalised expected core name. */
function scoreName(expected: ExpectedValue<string>, actual: unknown): FieldResult {
  const ok = typeof actual === "string" && normalizeName(actual).includes(normalizeName(expected.value));
  return result("name", ok ? 1 : 0, expected.value, actual, ok ? undefined : `does not contain "${expected.value}"`);
}

/** validityPeriod: fraction of expected durations stated in the actual text. */
function scoreValidity(expected: ExpectedValidity, actual: unknown): FieldResult {
  const exp = expected.durations.map((d) => `${d.amount} ${d.unit}`);
  if (typeof actual !== "string" || !actual.trim()) {
    return result("validityPeriod", 0, exp, actual, "missing");
  }
  const found = durationsIn(actual);
  const hits = expected.durations.filter((d) =>
    found.some((f) => f.amount === d.amount && f.unit === d.unit)
  );
  const score = expected.durations.length ? hits.length / expected.durations.length : 1;
  const missing = expected.durations.filter((d) => !hits.includes(d)).map((d) => `${d.amount} ${d.unit}`);
  return result("validityPeriod", score, exp, actual, missing.length ? `missing ${missing.join(", ")}` : undefined);
}

/** eligibility: fraction of themes with >= 1 keyword alternative in the joined criteria. */
function scoreEligibility(expected: { themes: ExpectedTheme[] }, actual: unknown): FieldResult {
  const themes = expected.themes;
  const list = Array.isArray(actual) ? actual.filter((x): x is string => typeof x === "string") : [];
  const joined = list.join(" \n ");
  const missed = themes.filter((t) => !t.anyOf.some((kw) => containsKeyword(joined, kw)));
  const score = themes.length ? (themes.length - missed.length) / themes.length : 1;
  return result(
    "eligibility",
    score,
    themes.map((t) => t.theme),
    list,
    missed.length ? `missed themes: ${missed.map((t) => t.theme).join("; ")}` : undefined
  );
}

/** applicationUrlHost: host of actual.applicationUrl equals the expected host. */
function scoreHost(expected: ExpectedValue<string>, actualUrl: unknown): FieldResult {
  const host = urlHost(actualUrl);
  const ok = host !== "" && host === expected.value.toLowerCase();
  // Detail names BOTH hosts, so the report never reads as if the actual host were expected.
  const detail = ok ? undefined : `host "${host || "(none)"}", expected "${expected.value}"`;
  return result("applicationUrlHost", ok ? 1 : 0, expected.value, actualUrl ?? null, detail);
}

// ----- Item kinds + need (issue #187) -----

/**
 * documentKinds: for each expected item, find the extractor item whose text
 * contains one of its keywords; the item scores when BOTH `kind` and `need`
 * match (a missing item, or one flagged `kindReview`, scores 0). The field
 * score is the fraction of expected items right.
 */
function scoreDocumentKinds(expected: { items: ExpectedItemKind[] }, actual: Partial<ExtractedVisa>): FieldResult {
  const names = Array.isArray(actual.requiredDocuments) ? actual.requiredDocuments : [];
  const meta = Array.isArray(actual.requiredDocumentMeta) ? actual.requiredDocumentMeta : [];
  const wrong: string[] = [];
  const got: string[] = [];
  for (const e of expected.items) {
    const i = names.findIndex((n) => e.match.some((kw) => containsKeyword(n, kw)));
    const m = i >= 0 ? meta[i] : undefined;
    got.push(m ? `${e.match[0]}: ${m.kind}/${m.need}${m.kindReview ? " (review)" : ""}` : `${e.match[0]}: (not extracted)`);
    if (!m || m.kindReview || m.kind !== e.kind || m.need !== e.need) wrong.push(`${e.match[0]} (expected ${e.kind}/${e.need})`);
  }
  const n = expected.items.length;
  return result(
    "documentKinds",
    n ? (n - wrong.length) / n : 1,
    expected.items.map((e) => `${e.match[0]}: ${e.kind}/${e.need}`),
    got,
    wrong.length ? `wrong or missing: ${wrong.join("; ")}` : undefined
  );
}

// ----- Fees (set-based, hard gate) -----

/** Comparable key of a component: kind|amount|currency|per|years. Label ignored. */
function feeKey(c: { kind: string; amount: number; currency?: string; per: string; years?: number }): string {
  const years = c.per === "year" ? String(c.years ?? "") : "";
  return [c.kind, String(Number(c.amount)), String(c.currency ?? "").toUpperCase(), c.per, years].join("|");
}

/** Human form of a component for the report, e.g. "surcharge 1035 GBP per year x5". */
export function describeFee(c: { kind: string; amount: number; currency?: string; per: string; years?: number }): string {
  const yrs = c.per === "year" ? ` x${c.years ?? "?"}` : "";
  return `${c.kind} ${c.amount} ${String(c.currency ?? "").toUpperCase()} per ${c.per}${yrs}`;
}

/**
 * feeComponents: order-independent multiset match. Returns the field result
 * plus whether it is a MISMATCH for the hard gate, and notes for tolerated
 * known-gap differences.
 *
 * Known gap on feeComponents (e.g. a surcharge only on a linked page that is
 * not modelled yet; Student IHS was one until #69): the expected set is what
 * the guide itself prints. EXTRA surcharge components and
 * `feeUnverifiedReasons` (a dropped IHS whose length the validator could not
 * prove) are then reported as NOTES, not mismatches. A missing or wrong
 * application fee is still a mismatch.
 */
function scoreFees(
  expected: { components: ExpectedFeeComponent[] },
  actual: Partial<ExtractedVisa>,
  feeGap: KnownGap | undefined
): { field: FieldResult; mismatch: boolean; notes: string[] } {
  const notes: string[] = [];
  const exp = expected.components;
  const act: ExtractedFeeComponent[] = Array.isArray(actual.feeComponents) ? actual.feeComponents : [];

  // Greedy multiset match on the comparable key.
  const unmatchedActual = [...act];
  const missing: ExpectedFeeComponent[] = [];
  for (const e of exp) {
    const i = unmatchedActual.findIndex((a) => feeKey(a) === feeKey(e));
    if (i >= 0) unmatchedActual.splice(i, 1);
    else missing.push(e);
  }
  let extra = unmatchedActual;

  // Known gap: extra surcharges are notes, not mismatches.
  if (feeGap) {
    const tolerated = extra.filter((a) => a.kind === "surcharge");
    for (const t of tolerated) {
      notes.push(`known gap ${feeGap.ref}: extractor returned ${describeFee(t)} (not on the guide itself) — note only`);
    }
    extra = extra.filter((a) => a.kind !== "surcharge");
  }

  // feeUnverifiedReasons on the output = the validator dropped a surcharge.
  const unverified = Array.isArray(actual.feeUnverifiedReasons) ? actual.feeUnverifiedReasons : [];
  let unverifiedMismatch = false;
  if (unverified.length > 0) {
    if (feeGap) notes.push(`known gap ${feeGap.ref}: feeUnverifiedReasons ${JSON.stringify(unverified)} — note only`);
    else unverifiedMismatch = true;
  }
  if (!Array.isArray(actual.feeComponents)) {
    unverifiedMismatch = true; // no fee array at all (missing field)
  }

  const mismatch = missing.length > 0 || extra.length > 0 || unverifiedMismatch;
  const problems: string[] = [];
  if (!Array.isArray(actual.feeComponents)) problems.push("feeComponents missing");
  if (missing.length) problems.push(`missing: ${missing.map(describeFee).join("; ")}`);
  if (extra.length) problems.push(`extra: ${extra.map(describeFee).join("; ")}`);
  if (unverifiedMismatch && unverified.length) problems.push(`feeUnverifiedReasons: ${unverified.join("; ")}`);

  return {
    field: result(
      "feeComponents",
      mismatch ? 0 : 1,
      exp.map(describeFee),
      act.map(describeFee),
      problems.length ? problems.join(" | ") : undefined
    ),
    mismatch,
    notes,
  };
}

// ----- Route + gate -----

/**
 * Score one route. `actual` is the extractor output (possibly missing fields,
 * so it is treated as Partial); `null` / an `error` means the extraction failed:
 * every field scores 0 and the fee counts as a mismatch.
 */
export function scoreRoute(
  expected: ExpectedVisa,
  actual: Partial<ExtractedVisa> | null | undefined,
  error?: string
): RouteScore {
  const knownGaps = expected.knownGaps ?? [];
  const notes = knownGaps.map((g) => `known gap ${g.ref} (${g.field}): ${g.note}`);

  // ---- Failed extraction: route scores 0, fee is a mismatch ----
  if (!actual || error) {
    const fields = SCORED_FIELDS.filter((f) => f !== "documentKinds" || expected.documentKinds).map((f) =>
      result(f, 0, null, null, `extraction failed: ${error ?? "no output"}`)
    );
    const weightTotal = fields.reduce((s, f) => s + f.weight, 0);
    return {
      route: expected.route,
      score: 0,
      weightedSum: 0,
      weightTotal,
      fields,
      feeMismatch: true,
      notes,
      knownGaps,
      error: error ?? "no extractor output",
    };
  }

  const feeGap = knownGaps.find((g) => g.field === "feeComponents");
  const fee = scoreFees(expected.feeComponents, actual, feeGap);
  const fields: FieldResult[] = [
    scoreName(expected.name, actual.name),
    scoreExact("category", expected.category.value, actual.category),
    scoreNumber("processingDaysMin", expected.processingDaysMin, actual.processingDaysMin),
    scoreNumber("processingDaysMax", expected.processingDaysMax, actual.processingDaysMax),
    scoreValidity(expected.validityPeriod, actual.validityPeriod),
    scoreExact("isExtendable", expected.isExtendable.value, actual.isExtendable),
    scoreEligibility(expected.eligibility, actual.eligibilityCriteria),
    scoreHost(expected.applicationUrlHost, actual.applicationUrl),
    fee.field,
    // Issue #187: only routes with expected item kinds are scored for them.
    ...(expected.documentKinds ? [scoreDocumentKinds(expected.documentKinds, actual)] : []),
  ];
  const weightedSum = fields.reduce((s, f) => s + f.weight * f.score, 0);
  const weightTotal = fields.reduce((s, f) => s + f.weight, 0);
  // Issue #87: the range must be stated by the output's own citations, with
  // the eval's numeric tolerance (20%, >= 1 day). Not weighted: a hard gate.
  const processingCitationProblems = checkProcessingRangeCitations(
    { processingDaysMin: actual.processingDaysMin, processingDaysMax: actual.processingDaysMax },
    actual.citations,
    { tolerance: PROCESSING_DAYS_TOLERANCE, minToleranceDays: PROCESSING_DAYS_MIN_TOLERANCE_DAYS }
  );
  return {
    route: expected.route,
    score: weightTotal ? weightedSum / weightTotal : 0,
    weightedSum,
    weightTotal,
    fields,
    feeMismatch: fee.mismatch,
    processingCitationProblems,
    notes: [...notes, ...fee.notes],
    knownGaps,
  };
}

/**
 * The gate over all routes:
 *  - HARD: any route with a fee mismatch fails (whatever the scores);
 *  - HARD (#87): any route whose processingDaysMin/Max is outside the
 *    tolerance of every duration in its processing citations fails;
 *  - SOFT: overall weighted score < OVERALL_PASS_THRESHOLD fails;
 *  - SOFT: any route score < ROUTE_PASS_THRESHOLD fails.
 * Overall = sum(weight x score) / sum(weight) over every field of every route.
 */
export function evaluateGate(routes: RouteScore[]): GateResult {
  const ws = routes.reduce((s, r) => s + r.weightedSum, 0);
  const wt = routes.reduce((s, r) => s + r.weightTotal, 0);
  const overall = wt ? ws / wt : 0;
  const failures: string[] = [];
  for (const r of routes) {
    if (r.feeMismatch) {
      const fee = r.fields.find((f) => f.field === "feeComponents");
      failures.push(`fee mismatch on ${r.route} (hard gate): ${fee?.detail ?? r.error ?? ""}`);
    }
    // Issue #87: a processing figure no cited duration supports (hard gate).
    for (const problem of r.processingCitationProblems ?? []) {
      failures.push(`processing citation mismatch on ${r.route} (hard gate): ${problem}`);
    }
  }
  if (routes.length === 0) failures.push("no routes scored");
  if (overall < OVERALL_PASS_THRESHOLD) {
    failures.push(`overall ${overall.toFixed(3)} < ${OVERALL_PASS_THRESHOLD}`);
  }
  for (const r of routes) {
    if (r.score < ROUTE_PASS_THRESHOLD) {
      failures.push(`route ${r.route} ${r.score.toFixed(3)} < ${ROUTE_PASS_THRESHOLD}`);
    }
  }
  return {
    overall,
    pass: failures.length === 0,
    failures,
    thresholds: { overall: OVERALL_PASS_THRESHOLD, route: ROUTE_PASS_THRESHOLD },
  };
}

/** Mean score per field type across routes (report table). */
export function fieldTypeScores(routes: RouteScore[]): Record<FieldType, number> {
  const acc: Partial<Record<FieldType, { sum: number; n: number }>> = {};
  for (const r of routes) {
    for (const f of r.fields) {
      const a = (acc[f.type] ??= { sum: 0, n: 0 });
      a.sum += f.score;
      a.n += 1;
    }
  }
  const out = {} as Record<FieldType, number>;
  for (const t of Object.values(FIELD_TYPES)) {
    const a = acc[t];
    out[t] = a && a.n ? a.sum / a.n : 0;
  }
  return out;
}

/** Mean score per field across routes (used by --compare). */
export function fieldScores(routes: RouteScore[]): Record<ScoredField, number> {
  const out = {} as Record<ScoredField, number>;
  for (const f of SCORED_FIELDS) {
    const vals = routes.map((r) => r.fields.find((x) => x.field === f)?.score ?? 0);
    out[f] = vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : 0;
  }
  return out;
}
