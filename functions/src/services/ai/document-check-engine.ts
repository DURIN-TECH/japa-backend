import type { DurationUnit, VisaRubric } from "../../types/rubric";
import type { DocumentExtraction } from "./assessment-engine";
import { findBannedWording } from "./prompt-safety";

// ============================================
// DOCUMENT CHECK ENGINE — PURE CORE (issue #115)
// ============================================
//
// What a per-upload check decides, and how. No Firestore, no SDK, no clock (the
// caller passes `today`), no model. The I/O half is document-check.service.ts.
//
// THE RULES THIS FILE ENFORCES
//
//  1. THE MODEL ONLY READS. The extraction (document-extraction.ts, the same
//     stage 2 as the assessment) returns values. Every pass / fix / could-not-tell
//     below is decided HERE, in code, by comparing those values with the
//     expectations the rubric declares. Change only the expectation and the
//     outcome changes (the tests hold one extraction constant to show it).
//  2. NOTHING IS INVENTED. An expectation exists only if the rubric carries it:
//       - the document type comes from the evidence item (`expects.documentType`,
//         else the item's own title from the cited source);
//       - a REQUIRED PERIOD is a linked criterion's `heldForDays` check;
//       - a MAXIMUM AGE is a linked criterion's `lte` check whose unit is a
//         duration (days, weeks, months, years).
//     With none declared, "period" is `not_applicable`, and "in date" can only
//     catch a future date or an expired document (facts, not thresholds). A check
//     that did not run is never reported as passed.
//  3. THE FIVE CHECKS each give `pass`, `fix` (a message built from the real
//     values and dates), `could_not_tell` (an ambiguous or missing value) or
//     `not_applicable`.
//  4. FEEDBACK IS ABOUT THE DOCUMENT, never about the application. No message
//     predicts a decision; every message is passed through the banned-wording
//     guard as a backstop.
//  5. GENERIC. Nothing here names a country, route, nationality, issuer or
//     document. Words in messages come from the rubric's own item titles.

// ============================================
// Types
// ============================================

/** One check's outcome. `not_applicable`: the rubric declares nothing to compare. */
export type CheckOutcome = "pass" | "fix" | "could_not_tell" | "not_applicable";

/** The five checks, in the order they are shown. */
export const CHECK_KEYS = ["type", "readable", "inDate", "name", "period"] as const;
export type CheckKey = (typeof CHECK_KEYS)[number];

/** One check's result. `code` is stable for clients; `message` is plain words built in code. */
export interface CheckResult {
  outcome: CheckOutcome;
  code: string;
  message: string;
}

export type DocumentChecks = Record<CheckKey, CheckResult>;

/** A duration the rubric declares (value + unit written in the criterion's own quote). */
export interface DeclaredDuration {
  value: number;
  unit: DurationUnit;
}

/** Everything the comparison needs, derived from the rubric and the item. */
export interface Expectations {
  /** Expected document type (words), or null when nothing names one. */
  documentType: string | null;
  /** Whose name the document must carry. */
  holder: "applicant" | "sponsor";
  /** Oldest acceptable document date, as a duration back from today. Null: not declared. */
  maxAge: DeclaredDuration | null;
  /** Minimum span the document must cover. Null: not declared. */
  requiredPeriod: DeclaredDuration | null;
}

/** The values the check reads from a document (all are `field` names in the extraction). */
export const CHECK_FIELDS = ["documentType", "holderName", "documentDate", "periodStart", "periodEnd", "expiryDate"] as const;

/** Values as the model wrote them (or null when it did not report them). */
export type RawFacts = Record<(typeof CHECK_FIELDS)[number], string | null>;

/** Why no check could run at all. */
export type CouldNotCheckCode =
  | "unreadable"
  | "password_protected"
  | "unsupported_type"
  | "too_many_pages"
  | "file_too_large"
  | "timed_out"
  | "unavailable"
  | "daily_limit_application"
  | "daily_limit_user"
  | "disabled";

/** Plain words for each reason. They always say the upload itself is safe. */
export const COULD_NOT_CHECK_MESSAGES: Record<CouldNotCheckCode, string> = {
  unreadable: "We could not read this document, so we could not check it. A clearer scan or photo may help. Your upload is saved.",
  password_protected: "This file is password protected, so we could not open it. Remove the password and upload it again. Your upload is saved.",
  unsupported_type: "We can check PDF, JPG and PNG files, and this is a different kind of file. Your upload is saved.",
  too_many_pages: "This file has more pages than we can check at once. Your upload is saved.",
  file_too_large: "This file is larger than we can check. Your upload is saved.",
  timed_out: "The check took too long, so we stopped it. You can try again. Your upload is saved.",
  unavailable: "The check is not available right now. You can try again later. Your upload is saved.",
  daily_limit_application: "You have used today's document checks for this application. Try again tomorrow. Your upload is saved.",
  daily_limit_user: "You have used today's document checks. Try again tomorrow. Your upload is saved.",
  disabled: "Document checks are paused right now. Your upload is saved.",
};

/** What `evaluateDocumentCheck` returns. */
export type CheckEvaluation =
  | { status: "done"; checks: DocumentChecks }
  | { status: "could_not_check"; code: CouldNotCheckCode; message: string };

// ============================================
// Expectations from the rubric
// ============================================

const DURATION_UNIT_SET = new Set<string>(["days", "weeks", "months", "years"]);

/** The item (rubric evidence item) the checklist id points at, or undefined. */
function evidenceItemFor(rubric: Pick<VisaRubric, "evidenceItems"> | null, checklistItemId: string) {
  // Checklist ids for rubric evidence are `ev-<key>` (checklist-builder.ts).
  if (!rubric || !checklistItemId.startsWith("ev-")) return undefined;
  const key = checklistItemId.slice(3);
  return (rubric.evidenceItems ?? []).find((e) => e.key === key);
}

/**
 * The expectations for one checklist item. Reads ONLY the rubric: the item's
 * `expects`, and the checks of the criteria it evidences.
 *
 * @param title  the checklist item's title (from the cited source); the type
 *               expectation when `expects.documentType` is not declared
 * @param holder the item's holder, from the stored request
 */
export function expectationsFor(
  rubric: Pick<VisaRubric, "evidenceItems" | "criteria"> | null,
  checklistItemId: string,
  title: string,
  holder: "applicant" | "sponsor"
): Expectations {
  const item = evidenceItemFor(rubric, checklistItemId);
  let maxAge: DeclaredDuration | null = null;
  let requiredPeriod: DeclaredDuration | null = null;
  if (rubric && item) {
    const linked = rubric.criteria.filter((c) => item.criterionIds.includes(c.criterionId));
    for (const c of linked) {
      const check = c.check;
      if (c.kind !== "objective" || !check || typeof check.value !== "number" || !(check.value > 0)) continue;
      if (check.op === "heldForDays") {
        // `heldForDays`: the value is written in the criterion's own unit (days when none is stated).
        const unit = check.unit && DURATION_UNIT_SET.has(check.unit) ? (check.unit as DurationUnit) : "days";
        if (!requiredPeriod) requiredPeriod = { value: check.value, unit };
      } else if (check.op === "lte" && check.unit && DURATION_UNIT_SET.has(check.unit)) {
        // An upper bound in a duration unit: how old the document may be.
        if (!maxAge) maxAge = { value: check.value, unit: check.unit as DurationUnit };
      }
    }
  }
  return {
    documentType: item?.expects?.documentType?.trim() || title.trim() || null,
    holder,
    maxAge,
    requiredPeriod,
  };
}

// ============================================
// Dates (UTC, whole days)
// ============================================

const MONTHS: Record<string, number> = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4, may: 5, june: 6, jun: 6,
  july: 7, jul: 7, august: 8, aug: 8, september: 9, sep: 9, sept: 9, october: 10, oct: 10,
  november: 11, nov: 11, december: 12, dec: 12,
};

/** A parsed date, or why it could not be: `ambiguous` (day/month order unclear) or `unreadable`. */
export type ParsedDate = { ok: true; iso: string } | { ok: false; reason: "ambiguous" | "unreadable" };

/** True when y-m-d is a real calendar date. */
function validYmd(y: number, m: number, d: number): boolean {
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function iso(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * Parse a date as the document wrote it. Accepts ISO (2025-03-14), a month
 * name (14 March 2025, March 14, 2025) and numeric day/month/year with a
 * separator. A numeric date where both leading parts could be a month
 * (03/04/2025) is AMBIGUOUS and is never guessed. Anything else is unreadable.
 */
export function parseDocumentDate(raw: string | null | undefined): ParsedDate {
  if (!raw) return { ok: false, reason: "unreadable" };
  const text = raw.trim().replace(/\s+/g, " ").replace(/(\d)(st|nd|rd|th)\b/gi, "$1");
  let m: RegExpMatchArray | null;

  // ISO: 2025-03-14 (also 2025/03/14).
  if ((m = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/))) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return validYmd(y, mo, d) ? { ok: true, iso: iso(y, mo, d) } : { ok: false, reason: "unreadable" };
  }
  // 14 March 2025, 14 Mar, 2025
  if ((m = text.match(/^(\d{1,2}) ([A-Za-z]+),? (\d{4})$/))) {
    const mo = MONTHS[m[2].toLowerCase()];
    const [y, d] = [Number(m[3]), Number(m[1])];
    return mo && validYmd(y, mo, d) ? { ok: true, iso: iso(y, mo, d) } : { ok: false, reason: "unreadable" };
  }
  // March 14, 2025
  if ((m = text.match(/^([A-Za-z]+) (\d{1,2}),? (\d{4})$/))) {
    const mo = MONTHS[m[1].toLowerCase()];
    const [y, d] = [Number(m[3]), Number(m[2])];
    return mo && validYmd(y, mo, d) ? { ok: true, iso: iso(y, mo, d) } : { ok: false, reason: "unreadable" };
  }
  // 14/03/2025 or 03/14/2025 (separators / - .)
  if ((m = text.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/))) {
    const [a, b, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (a > 12 && b <= 12) return validYmd(y, b, a) ? { ok: true, iso: iso(y, b, a) } : { ok: false, reason: "unreadable" };
    if (b > 12 && a <= 12) return validYmd(y, a, b) ? { ok: true, iso: iso(y, a, b) } : { ok: false, reason: "unreadable" };
    if (a === b) return validYmd(y, a, b) ? { ok: true, iso: iso(y, a, b) } : { ok: false, reason: "unreadable" };
    if (a <= 12 && b <= 12) return { ok: false, reason: "ambiguous" };
    return { ok: false, reason: "unreadable" };
  }
  return { ok: false, reason: "unreadable" };
}

/** Whole days since the epoch for an ISO date. */
function dayNumber(isoDate: string): number {
  const [y, m, d] = isoDate.split("-").map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
}

/** ISO date for a day number. */
function fromDayNumber(n: number): string {
  return new Date(n * 86_400_000).toISOString().slice(0, 10);
}

/** Add whole calendar months to an ISO date, clamping the day to the month's end. */
function addMonths(isoDate: string, months: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return iso(ny, nm, Math.min(d, last));
}

/** `date` moved by `sign * duration` (sign -1 = back in time). */
export function shiftByDuration(date: string, dur: DeclaredDuration, sign: 1 | -1): string {
  if (dur.unit === "days") return fromDayNumber(dayNumber(date) + sign * dur.value);
  if (dur.unit === "weeks") return fromDayNumber(dayNumber(date) + sign * dur.value * 7);
  if (dur.unit === "months") return addMonths(date, sign * dur.value);
  return addMonths(date, sign * dur.value * 12);
}

/** A duration in words ("3 months", "1 week"). */
export function durationWords(dur: DeclaredDuration): string {
  const singular = dur.unit.replace(/s$/, "");
  return `${dur.value} ${dur.value === 1 ? singular : dur.unit}`;
}

/** An ISO date written for an applicant ("14 March 2025"). */
export function dateWords(isoDate: string): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const names = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  return `${d} ${names[m - 1]} ${y}`;
}

// ============================================
// Names
// ============================================

/** Lower-case letters only, diacritics removed, as word tokens. */
export function nameTokens(name: string): string[] {
  return name
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** Do two tokens match? Equal, or one is a single-letter initial of the other. */
function tokenMatches(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length === 1 && b.startsWith(a)) return true;
  if (b.length === 1 && a.startsWith(b)) return true;
  return false;
}

/** Does every token of `small` have a distinct partner in `large`? */
function isSubset(small: string[], large: string[]): boolean {
  const used = new Set<number>();
  for (const t of small) {
    const i = large.findIndex((l, idx) => !used.has(idx) && tokenMatches(t, l));
    if (i < 0) return false;
    used.add(i);
  }
  return true;
}

/** How many tokens of `a` have a partner in `b`. */
function overlap(a: string[], b: string[]): number {
  const used = new Set<number>();
  let n = 0;
  for (const t of a) {
    const i = b.findIndex((l, idx) => !used.has(idx) && tokenMatches(t, l));
    if (i >= 0) {
      used.add(i);
      n++;
    }
  }
  return n;
}

/**
 * Compare two names in code: ignores case, diacritics, punctuation and word
 * order, and tolerates missing middle names (the shorter name must be fully
 * contained in the longer, with at least two words, or the two must be equal).
 *  - `match`:     the same person's name as far as a name can tell;
 *  - `mismatch`:  nothing in common that matters (no shared word, or too little);
 *  - `unclear`:   some words shared but neither name contains the other, or only
 *                 one word of a longer name matches. Never decided either way.
 */
export function compareNames(expected: string, found: string): "match" | "mismatch" | "unclear" {
  const e = nameTokens(expected);
  const f = nameTokens(found);
  if (e.length === 0 || f.length === 0) return "unclear";
  const [small, large] = e.length <= f.length ? [e, f] : [f, e];
  if (small.length === large.length && isSubset(small, large)) return "match";
  if (small.length >= 2 && isSubset(small, large)) return "match";
  const shared = overlap(e, f);
  if (shared === 0) return "mismatch";
  return "unclear";
}

// ============================================
// Document type
// ============================================

/** Words that carry no type information, for the type comparison. */
const TYPE_STOPWORDS = new Set(["a", "an", "the", "of", "for", "and", "or", "your", "you", "to", "in", "last", "recent", "latest", "months", "month", "days", "weeks", "years", "copy", "official", "original", "certified"]);

/** Content words of a document type, plural endings folded, qualifiers in brackets dropped. */
function typeTokens(text: string): string[] {
  return text
    .replace(/\([^)]*\)/g, " ")
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => t && !TYPE_STOPWORDS.has(t))
    .map((t) => (t.length > 3 ? t.replace(/s$/, "") : t));
}

/**
 * Is the document of the expected type? Compared by content words: all of one
 * side's words appear in the other = a match; no word in common = a different
 * type; some in common = unclear. The expected words come from the rubric.
 */
export function compareDocumentType(expected: string, found: string): "match" | "mismatch" | "unclear" {
  const e = typeTokens(expected);
  const f = typeTokens(found);
  if (e.length === 0 || f.length === 0) return "unclear";
  const eSet = new Set(e);
  const fSet = new Set(f);
  if (e.every((t) => fSet.has(t)) || f.every((t) => eSet.has(t))) return "match";
  if (!e.some((t) => fSet.has(t))) return "mismatch";
  return "unclear";
}

// ============================================
// Reading the extraction
// ============================================

/** The first usable value of each field a readable, unsuspicious extraction holds. */
export function rawFactsOf(extraction: Pick<DocumentExtraction, "values">): RawFacts {
  const facts = Object.fromEntries(CHECK_FIELDS.map((f) => [f, null])) as RawFacts;
  for (const v of extraction.values) {
    if (!(CHECK_FIELDS as readonly string[]).includes(v.field)) continue;
    const key = v.field as keyof RawFacts;
    if (facts[key] !== null) continue;
    if (v.value === null || typeof v.value === "boolean") continue;
    const text = String(v.value).trim();
    if (text) facts[key] = text;
  }
  return facts;
}

// ============================================
// The five checks
// ============================================

/** Guard: a message that trips the banned wording is replaced by a neutral one. */
function safe(message: string): string {
  return findBannedWording(message) ? "Please check this document against the rule shown." : message;
}

function result(outcome: CheckOutcome, code: string, message: string): CheckResult {
  return { outcome, code, message: safe(message) };
}

/** Type check. */
export function checkType(raw: RawFacts, exp: Expectations): CheckResult {
  if (!exp.documentType) return result("not_applicable", "type_not_declared", "No document type is named for this item.");
  if (!raw.documentType) return result("could_not_tell", "type_not_found", "We could not tell what kind of document this is.");
  const cmp = compareDocumentType(exp.documentType, raw.documentType);
  if (cmp === "match") return result("pass", "type_ok", `This looks like the right kind of document: ${exp.documentType}.`);
  if (cmp === "mismatch") {
    return result("fix", "type_wrong", `This looks like a "${raw.documentType}", and this item needs a "${exp.documentType}". Upload the right document.`);
  }
  return result("could_not_tell", "type_unclear", `We could not tell if this is a "${exp.documentType}". It reads as "${raw.documentType}".`);
}

/** Readable check: reached only when the extraction was readable and clean. */
export function checkReadable(raw: RawFacts): CheckResult {
  const found = Object.values(raw).some((v) => v !== null);
  return found
    ? result("pass", "readable_ok", "We could read this document.")
    : result("could_not_tell", "readable_nothing", "We could open this document but could not find the details we look for. A clearer copy may help.");
}

/**
 * In-date check. Facts only unless the rubric declares a maximum age:
 *  - a document dated after `today` is a fix;
 *  - an expiry date before `today` is a fix (an expiry ON today still passes);
 *  - with a declared maximum age, a document date before the cut-off is a fix
 *    (a date ON the cut-off passes);
 *  - an unreadable or ambiguous date that would matter is `could_not_tell`.
 * Nothing to test (no age, no expiry): `not_applicable`, never a pass.
 */
export function checkInDate(raw: RawFacts, exp: Expectations, today: string): CheckResult {
  const fixes: string[] = [];
  let unclear: string | null = null;
  let tested = false;

  // Expiry.
  if (raw.expiryDate) {
    const p = parseDocumentDate(raw.expiryDate);
    if (p.ok) {
      tested = true;
      if (dayNumber(p.iso) < dayNumber(today)) fixes.push(`This document expired on ${dateWords(p.iso)}. Upload one that is still valid.`);
    } else {
      unclear = p.reason === "ambiguous" ? "We could not tell the day and month order of the expiry date." : "We could not read the expiry date.";
    }
  }

  // The document's own date: the end of its period, else its issue date.
  const dateRaw = raw.periodEnd ?? raw.documentDate;
  if (dateRaw) {
    const p = parseDocumentDate(dateRaw);
    if (p.ok) {
      if (dayNumber(p.iso) > dayNumber(today)) {
        tested = true;
        fixes.push(`This document is dated ${dateWords(p.iso)}, which is in the future. Upload the right document.`);
      } else if (exp.maxAge) {
        tested = true;
        const cutoff = shiftByDuration(today, exp.maxAge, -1);
        if (dayNumber(p.iso) < dayNumber(cutoff)) {
          fixes.push(
            `This document is dated ${dateWords(p.iso)}. The rule asks for one from the last ${durationWords(exp.maxAge)}, so dated ${dateWords(cutoff)} or later. Upload a newer one.`
          );
        }
      }
    } else if (exp.maxAge || !raw.expiryDate) {
      unclear = unclear ?? (p.reason === "ambiguous" ? "We could not tell the day and month order of the date on this document." : "We could not read the date on this document.");
    }
  } else if (exp.maxAge) {
    unclear = unclear ?? "We could not find a date on this document.";
  }

  if (fixes.length > 0) return result("fix", "in_date_fix", fixes[0]);
  if (unclear) return result("could_not_tell", "in_date_unclear", unclear);
  if (!tested) return result("not_applicable", "in_date_not_declared", "No date limit is declared for this item.");
  return result("pass", "in_date_ok", "The date on this document is fine.");
}

/**
 * Name check. `expectedName` is the applicant's profile name, or the sponsor's
 * full name from intake; null when unknown (never a pass).
 */
export function checkName(raw: RawFacts, exp: Expectations, expectedName: string | null): CheckResult {
  if (!expectedName || nameTokens(expectedName).length === 0) {
    return result(
      "could_not_tell",
      "name_expected_unknown",
      exp.holder === "sponsor" ? "We don't have your sponsor's name." : "We don't have your name on your profile."
    );
  }
  if (!raw.holderName) return result("could_not_tell", "name_not_found", "We could not find a name on this document.");
  const cmp = compareNames(expectedName, raw.holderName);
  if (cmp === "match") return result("pass", "name_ok", exp.holder === "sponsor" ? "The name matches your sponsor's." : "The name matches your profile.");
  if (cmp === "unclear") {
    return result("could_not_tell", "name_unclear", exp.holder === "sponsor" ? "We could not tell if the name is your sponsor's." : "We could not tell if the name is yours.");
  }
  // The sponsor's name read off the document is third-party data: not repeated.
  return result(
    "fix",
    "name_wrong",
    exp.holder === "sponsor"
      ? "The name on this document does not match your sponsor's name as you entered it. Upload one in their name."
      : `The name on this document (${raw.holderName}) does not match your profile (${expectedName}). Upload one in your name.`
  );
}

/**
 * Period check, only when the rubric declares a required period: the document's
 * start and end dates must span at least that long (both days counted). A span
 * of exactly the required length passes; one day short is a fix.
 */
export function checkPeriod(raw: RawFacts, exp: Expectations): CheckResult {
  if (!exp.requiredPeriod) return result("not_applicable", "period_not_declared", "No period is declared for this item.");
  if (!raw.periodStart || !raw.periodEnd) return result("could_not_tell", "period_not_found", "We could not find the start and end dates of the period this document covers.");
  const s = parseDocumentDate(raw.periodStart);
  const e = parseDocumentDate(raw.periodEnd);
  if (!s.ok || !e.ok) return result("could_not_tell", "period_unclear", "We could not read the dates this document covers.");
  if (dayNumber(e.iso) < dayNumber(s.iso)) return result("could_not_tell", "period_unclear", "The dates this document covers look out of order.");
  // The first day NOT covered if the span were exactly the required length.
  const needEndExclusive = shiftByDuration(s.iso, exp.requiredPeriod, 1);
  const haveEndExclusive = fromDayNumber(dayNumber(e.iso) + 1);
  if (dayNumber(haveEndExclusive) >= dayNumber(needEndExclusive)) {
    return result("pass", "period_ok", `This document covers ${dateWords(s.iso)} to ${dateWords(e.iso)}.`);
  }
  return result(
    "fix",
    "period_short",
    `This document covers ${dateWords(s.iso)} to ${dateWords(e.iso)}. The rule asks for ${durationWords(exp.requiredPeriod)}. Upload one that covers the full period.`
  );
}

// ============================================
// Putting it together
// ============================================

export interface EvaluateInput {
  extraction: DocumentExtraction;
  expectations: Expectations;
  /** The expected name (profile or sponsor from intake), or null when unknown. */
  expectedName: string | null;
  /** Today, YYYY-MM-DD, from the caller's clock. */
  today: string;
}

/**
 * Evaluate one document's extraction against the expectations. A document that
 * could not be read, whose answer failed, or that addressed the model, gives
 * `could_not_check` (its values are never used). Otherwise the five checks.
 */
export function evaluateDocumentCheck(input: EvaluateInput): CheckEvaluation {
  const { extraction, expectations, expectedName, today } = input;
  // A document that addresses the model is data that cannot be trusted: its
  // values are discarded and the applicant is told only that it could not be read.
  if (!extraction.readable || extraction.failed || extraction.suspicious) {
    return { status: "could_not_check", code: "unreadable", message: COULD_NOT_CHECK_MESSAGES.unreadable };
  }
  const raw = rawFactsOf(extraction);
  const checks: DocumentChecks = {
    type: checkType(raw, expectations),
    readable: checkReadable(raw),
    inDate: checkInDate(raw, expectations, today),
    name: checkName(raw, expectations, expectedName),
    period: checkPeriod(raw, expectations),
  };
  return { status: "done", checks };
}

/** True when any of the five checks is a fix. */
export function hasFix(checks: DocumentChecks): boolean {
  return CHECK_KEYS.some((k) => checks[k].outcome === "fix");
}

/** The least that is kept of a name for storage: initials only ("A. O."). */
export function maskName(name: string): string {
  return nameTokens(name)
    .map((t) => `${t[0].toUpperCase()}.`)
    .join(" ");
}
