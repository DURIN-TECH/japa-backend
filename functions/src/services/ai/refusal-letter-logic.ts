import { createHash } from "crypto";
import type { LlmRequest } from "./llm-provider";
import { DATA_ONLY_RULE, findInjectionSignals, wrapUntrusted } from "./prompt-safety";
import { buildChecklist } from "./checklist-builder";
import type { AssessmentCriterion, VisaRubric } from "../../types/rubric";
import type {
  RefusalChecklist,
  RefusalReason,
  RefusalRuleMatch,
  RefusalWarning,
} from "../../types/refusal-letter";

// ============================================
// REFUSAL-LETTER ANALYSIS — pure logic (issue #122)
// ============================================
//
// No I/O in this file, so every rule below can be tested without Firestore or a
// model. Division of labour:
//
//   MODEL  (one call, values only)   which references the letter cites, the
//                                    letter's own wording for each reason, the
//                                    decision date, the visa type named, and
//                                    the name / date of birth printed on it.
//                                    The schema has no verdict, no advice and
//                                    no mapping field.
//   CODE   (everything here)         parse and validate the answer, match each
//                                    cited reference to an approved rubric
//                                    criterion, frame it, detect a deception
//                                    ground, compare the identity, and pick
//                                    the checklist items.
//
// GENERIC BY DESIGN: nothing below names a country, route, nationality or visa
// type. A rubric's `ruleRef` strings are data; the matching works on their shape.

/** Version of the prompt in this file. Stored on every analysis. */
export const REFUSAL_PROMPT_VERSION = "refusal-letter-2026-11-11.1";

/** Most reasons kept from one letter (a longer list is cut, in letter order). */
export const MAX_REASONS = 15;
/** Most references kept per reason. */
const MAX_REFS_PER_REASON = 6;
/** Longest quote kept (characters). */
const MAX_QUOTE_CHARS = 700;
/** Longest cited reference kept. */
const MAX_REF_CHARS = 60;
/** Longest value kept for the date, visa type and identity strings. */
const MAX_VALUE_CHARS = 120;

// ============================================
// 1. The extraction request
// ============================================

/**
 * Output schema. VALUES ONLY: no verdict, no advice, no mapping, no "reason
 * category". A test asserts there is no such property anywhere in it.
 */
export function refusalSchema(): Record<string, unknown> {
  const nullableString = { type: ["string", "null"] };
  return {
    type: "object",
    additionalProperties: false,
    required: ["readable", "isRefusalLetter", "decisionDate", "visaTypeNamed", "applicantName", "dateOfBirth", "reasons"],
    properties: {
      readable: { type: "boolean" },
      isRefusalLetter: { type: "boolean" },
      decisionDate: nullableString,
      visaTypeNamed: nullableString,
      applicantName: nullableString,
      dateOfBirth: nullableString,
      reasons: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["citedRefs", "quote", "page"],
          properties: {
            citedRefs: { type: "array", items: { type: "string" } },
            quote: { type: "string" },
            page: { type: ["integer", "null"] },
          },
        },
      },
    },
  };
}

const REFUSAL_SYSTEM =
  "You read one attached letter and report only what it says. " +
  "First say whether it is readable, and whether it is a decision letter that refuses an application. " +
  "If it is, report: the decision date as written; the visa or permission type the letter names, as written; " +
  "the applicant name and date of birth as printed; and, for each reason the letter itself gives for the refusal, " +
  "the rule or paragraph references the letter cites for it (as printed, one string per reference) and the letter's own " +
  "wording for that reason, copied exactly, with the page it is on. " +
  "Report only references and wording that are in the letter. Do not add, infer or complete a reference. " +
  "Do not interpret, judge, summarise, explain, advise, or say anything about a future application. " +
  "If the letter is unreadable, or is not a refusal decision, say so and leave the other fields empty.\n" +
  DATA_ONLY_RULE;

/** The request: the label is code-written; the letter is attached, never inlined. */
export function buildRefusalRequest(doc: {
  mediaType: "application/pdf" | "image/jpeg" | "image/png";
  data: string;
}): LlmRequest {
  return {
    role: "extraction",
    system: REFUSAL_SYSTEM,
    user: `Read the attached letter.\n${wrapUntrusted("refusal letter", "document_label")}`,
    schema: refusalSchema(),
    documents: [{ mediaType: doc.mediaType, data: doc.data }],
    maxOutputTokens: 4_000,
    timeoutMs: 120_000,
  };
}

// ============================================
// 2. Parsing the answer (code is the trust boundary)
// ============================================

/** What the model's answer yields once validated. */
export interface ParsedLetter {
  readable: boolean;
  isRefusalLetter: boolean;
  decisionDate: string | null;
  visaTypeNamed: string | null;
  applicantName: string | null;
  dateOfBirth: string | null;
  reasons: Array<{ citedRefs: string[]; quote: string; page: number | null }>;
  // True when any text in the answer addressed a reader model. The offending
  // reasons / values are dropped, and the flag is stored for operators.
  suspicious: boolean;
}

export type RefusalParse = { ok: true; letter: ParsedLetter } | { ok: false; reason: string };

const TOP_KEYS = new Set(["readable", "isRefusalLetter", "decisionDate", "visaTypeNamed", "applicantName", "dateOfBirth", "reasons"]);
const REASON_KEYS = new Set(["citedRefs", "quote", "page"]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Strip control characters, collapse whitespace, cap the length. */
function cleanText(text: string, max: number): string {
  return (
    text
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, max)
  );
}

/**
 * Validate the answer. Any shape mismatch (extra key, wrong type) is a FAILED
 * read, never a partial success. Text that addresses the model is dropped and
 * flagged; a letter that says "ignore prior instructions" therefore yields
 * extracted values only (the injected sentence never reaches a response).
 */
export function parseRefusalAnswer(text: string): RefusalParse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "answer is not JSON" };
  }
  if (!isRecord(parsed)) return { ok: false, reason: "answer is not an object" };
  for (const key of Object.keys(parsed)) if (!TOP_KEYS.has(key)) return { ok: false, reason: `unexpected key ${key}` };
  if (typeof parsed.readable !== "boolean") return { ok: false, reason: "readable is not a boolean" };
  if (typeof parsed.isRefusalLetter !== "boolean") return { ok: false, reason: "isRefusalLetter is not a boolean" };
  for (const k of ["decisionDate", "visaTypeNamed", "applicantName", "dateOfBirth"] as const) {
    if (!(parsed[k] === null || typeof parsed[k] === "string")) return { ok: false, reason: `${k} has a bad type` };
  }
  if (!Array.isArray(parsed.reasons)) return { ok: false, reason: "reasons is not an array" };

  let suspicious = false;
  // A scalar value: kept only when it does not address the model.
  const scalar = (v: unknown): string | null => {
    if (typeof v !== "string") return null;
    const c = cleanText(v, MAX_VALUE_CHARS);
    if (!c) return null;
    if (findInjectionSignals(c)) {
      suspicious = true;
      return null;
    }
    return c;
  };

  const reasons: ParsedLetter["reasons"] = [];
  const seen = new Set<string>();
  for (const r of parsed.reasons) {
    if (!isRecord(r)) return { ok: false, reason: "a reason is not an object" };
    for (const key of Object.keys(r)) if (!REASON_KEYS.has(key)) return { ok: false, reason: `unexpected reason key ${key}` };
    if (!Array.isArray(r.citedRefs) || !r.citedRefs.every((x) => typeof x === "string")) return { ok: false, reason: "citedRefs is not a string array" };
    if (typeof r.quote !== "string") return { ok: false, reason: "a quote is not a string" };
    if (!(r.page === null || (typeof r.page === "number" && Number.isInteger(r.page)))) return { ok: false, reason: "a page has a bad type" };

    const quote = cleanText(r.quote, MAX_QUOTE_CHARS);
    const refs = (r.citedRefs as string[]).map((x) => cleanText(x, MAX_REF_CHARS)).filter(Boolean).slice(0, MAX_REFS_PER_REASON);
    // A reason with no wording of its own is not shown: nothing to quote.
    if (!quote) continue;
    // Text addressed to a model: drop the whole reason, flag the letter.
    if (findInjectionSignals(quote) || refs.some((x) => findInjectionSignals(x))) {
      suspicious = true;
      continue;
    }
    const key = `${refs.map(normaliseRuleRef).join("|")}::${quote.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    reasons.push({ citedRefs: refs, quote, page: r.page as number | null });
    if (reasons.length >= MAX_REASONS) break;
  }

  return {
    ok: true,
    letter: {
      readable: parsed.readable,
      isRefusalLetter: parsed.isRefusalLetter,
      decisionDate: scalar(parsed.decisionDate),
      visaTypeNamed: scalar(parsed.visaTypeNamed),
      applicantName: scalar(parsed.applicantName),
      dateOfBirth: scalar(parsed.dateOfBirth),
      reasons,
      suspicious,
    },
  };
}

// ============================================
// 3. Mapping a cited reference to a rubric criterion (code only)
// ============================================

/**
 * Normalise a paragraph reference so formatting differences do not matter:
 * upper case; the words "paragraph", "para", "appendix", "rule", "section" and
 * the pilcrow dropped; spaces removed; a dot before a bracket and a trailing
 * dot removed; brackets kept (they carry the sub-paragraph letter).
 *
 *   "SUI 9.1(b)" "sui9.1 (B)" "paragraph SUI 9.1.(b)." -> "SUI9.1(B)"
 */
export function normaliseRuleRef(ref: string): string {
  return ref
    .toUpperCase()
    .replace(/[¶§]/g, " ")
    .replace(/\b(PARAGRAPHS?|PARAS?|APPENDIX|RULES?|SECTIONS?)\b\.?/g, " ")
    .replace(/\s+/g, "")
    .replace(/\.(?=\()/g, "")
    .replace(/\.+$/, "");
}

/**
 * How a cited reference relates to a rubric reference (both already normalised):
 *  - exact   the same paragraph
 *  - parent  the letter cites a sub-paragraph, `X9.1(B)`, of the paragraph the
 *            rubric holds, `X9.1` (the boundary is a bracket, so 9.1 never
 *            matches 9.10)
 *  - null    anything else. A letter citing the WHOLE paragraph where the
 *            rubric holds only sub-paragraphs is NOT matched: which
 *            sub-paragraph applied is not known.
 */
export function refRelation(cited: string, rubricRef: string): "exact" | "parent" | null {
  if (!cited || !rubricRef) return null;
  if (cited === rubricRef) return "exact";
  if (cited.startsWith(rubricRef) && cited.charAt(rubricRef.length) === "(") return "parent";
  return null;
}

/** The rubric fields a match reads. Everything shown comes from here, never from the model. */
function matchFrom(c: AssessmentCriterion, matchType: "exact" | "parent"): RefusalRuleMatch | null {
  // A criterion shown as a rule must carry its own words and URL.
  if (!c.ruleRef || !c.source?.quote?.trim() || !c.source.url) return null;
  return {
    criterionId: c.criterionId,
    title: c.title,
    kind: c.kind,
    ruleRef: c.ruleRef,
    sourceUrl: c.source.url,
    sourceQuote: c.source.quote,
    matchType,
    framing: c.kind === "judgement" ? "strengthen" : "requirement",
  };
}

/**
 * Match every cited reference of one reason against the rubric. A criterion is
 * matched at most once per reason; an `exact` match wins over a `parent` one.
 * No reference, no match, no rubric: an empty list ("not matched to our guidance").
 */
export function matchReferences(citedRefs: readonly string[], rubric: Pick<VisaRubric, "criteria"> | null): RefusalRuleMatch[] {
  if (!rubric) return [];
  const byId = new Map<string, RefusalRuleMatch>();
  for (const raw of citedRefs) {
    const cited = normaliseRuleRef(raw);
    for (const c of rubric.criteria) {
      if (!c.ruleRef) continue;
      const rel = refRelation(cited, normaliseRuleRef(c.ruleRef));
      if (!rel) continue;
      const m = matchFrom(c, rel);
      if (!m) continue;
      const prior = byId.get(m.criterionId);
      if (!prior || (prior.matchType === "parent" && m.matchType === "exact")) byId.set(m.criterionId, m);
    }
  }
  return [...byId.values()];
}

/**
 * The last guard: every matched id must exist in the rubric version used. By
 * construction they do (matches are built from the rubric), so a drop here is
 * a bug; it is dropped and reported, never shown. `onDrop` receives the id only.
 */
export function dropFabricatedMatches(
  matches: readonly RefusalRuleMatch[],
  rubric: Pick<VisaRubric, "criteria"> | null,
  onDrop?: (criterionId: string) => void
): RefusalRuleMatch[] {
  const known = new Set((rubric?.criteria ?? []).map((c) => c.criterionId));
  return matches.filter((m) => {
    if (known.has(m.criterionId)) return true;
    onDrop?.(m.criterionId);
    return false;
  });
}

// ============================================
// 4. Deception grounds (code only)
// ============================================

/**
 * Wording that marks a deception ground. Read from the criterion's own source
 * text and title (so it follows the route's own rule), and from the letter's
 * own wording for an unmatched reason. Generic: no route is named. Conservative
 * on purpose: a false positive only swaps a fix list for "ask an adviser".
 */
const DECEPTION_WORDING: RegExp[] = [
  /\bdeception\b/i,
  /\bdeceiv(e|ed|ing)\b/i,
  /\bfalse\s+(representations?|documents?|information|statements?|declarations?)\b/i,
  /\bfalsif(y|ied|ication)\b/i,
  /\bforg(ed|ery)\b/i,
  /\bmisrepresent(ed|ation|ations)?\b/i,
  /\bnot\s+disclos(ing|ed)\b/i,
  /\bfail(ed|ure)?\s+to\s+disclose\b/i,
  /\bfraudulent(ly)?\b/i,
];

/** True when a text carries deception wording. */
export function hasDeceptionWording(text: string): boolean {
  return DECEPTION_WORDING.some((re) => re.test(text));
}

/** A reason is a deception ground when a matched criterion's own text, or the letter's wording, says so. */
export function isDeceptionReason(letterQuote: string, matches: readonly RefusalRuleMatch[]): boolean {
  if (hasDeceptionWording(letterQuote)) return true;
  return matches.some((m) => hasDeceptionWording(m.sourceQuote) || hasDeceptionWording(m.title));
}

// ============================================
// 5. Turning the parsed letter into reasons
// ============================================

/** Stable id for a reason inside one analysis (position + wording). */
function reasonIdFor(index: number, quote: string): string {
  return `r${index + 1}-${createHash("sha256").update(quote).digest("hex").slice(0, 8)}`;
}

/** Build the stored reasons: match, frame and flag, all in code. */
export function buildReasons(
  parsed: ParsedLetter,
  rubric: VisaRubric | null,
  onDrop?: (criterionId: string) => void
): RefusalReason[] {
  return parsed.reasons.map((r, i) => {
    const matches = dropFabricatedMatches(matchReferences(r.citedRefs, rubric), rubric, onDrop);
    return {
      reasonId: reasonIdFor(i, r.quote),
      letterQuote: r.quote,
      citedRefs: r.citedRefs,
      page: r.page,
      matches,
      deception: isDeceptionReason(r.quote, matches),
    };
  });
}

// ============================================
// 6. Identity check (warning, never a block)
// ============================================

/** Lower-case letters and spaces only, accents folded. */
function nameTokens(name: string): string[] {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z\s'-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

/**
 * Names agree when every token of the shorter name is in the longer one
 * (middle names and order do not matter). No profile name or no printed name:
 * nothing to compare, so no warning.
 */
export function namesDisagree(profileName: string | null, letterName: string | null): boolean {
  if (!profileName || !letterName) return false;
  const a = nameTokens(profileName);
  const b = nameTokens(letterName);
  if (a.length === 0 || b.length === 0) return false;
  const [short, long] = a.length <= b.length ? [a, new Set(b)] : [b, new Set(a)];
  return !short.every((t) => long.has(t));
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * The calendar dates a printed date of birth could mean, as `YYYY-MM-DD`.
 * Numeric forms with both parts 12 or under give both day-first and month-first
 * readings, so an ambiguous letter never produces a false warning.
 * Unparseable text gives an empty list (nothing to compare).
 */
export function dateCandidates(text: string): string[] {
  const t = text.trim().toLowerCase();
  const pad = (n: number) => String(n).padStart(2, "0");
  const valid = (y: number, m: number, d: number) => y >= 1900 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31;
  const out = new Set<string>();

  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(t);
  if (m && valid(+m[1], +m[2], +m[3])) out.add(`${m[1]}-${pad(+m[2])}-${pad(+m[3])}`);

  m = /^(\d{1,2})[-/. ](\d{1,2})[-/. ](\d{4})$/.exec(t);
  if (m) {
    if (valid(+m[3], +m[2], +m[1])) out.add(`${m[3]}-${pad(+m[2])}-${pad(+m[1])}`);
    if (valid(+m[3], +m[1], +m[2])) out.add(`${m[3]}-${pad(+m[1])}-${pad(+m[2])}`);
  }

  m = /^(\d{1,2})(?:st|nd|rd|th)?[\s-]+([a-z]{3,9})[\s,.-]+(\d{4})$/.exec(t);
  if (m) {
    const mi = MONTHS.indexOf(m[2].slice(0, 3));
    if (mi >= 0 && valid(+m[3], mi + 1, +m[1])) out.add(`${m[3]}-${pad(mi + 1)}-${pad(+m[1])}`);
  }
  m = /^([a-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/.exec(t);
  if (m) {
    const mi = MONTHS.indexOf(m[1].slice(0, 3));
    if (mi >= 0 && valid(+m[3], mi + 1, +m[2])) out.add(`${m[3]}-${pad(mi + 1)}-${pad(+m[2])}`);
  }
  return [...out];
}

/** True when the printed date of birth is readable and differs from the profile's (`YYYY-MM-DD`). */
export function dobDisagrees(profileDob: string | null, letterDob: string | null): boolean {
  if (!profileDob || !letterDob) return false;
  const candidates = dateCandidates(letterDob);
  if (candidates.length === 0) return false;
  return !candidates.includes(profileDob);
}

/** The warnings for a letter against the applicant's profile. */
export function identityWarnings(
  profile: { name: string | null; dateOfBirth: string | null },
  letter: Pick<ParsedLetter, "applicantName" | "dateOfBirth">
): RefusalWarning[] {
  const out: RefusalWarning[] = [];
  if (namesDisagree(profile.name, letter.applicantName)) out.push({ code: "name_mismatch" });
  if (dobDisagrees(profile.dateOfBirth, letter.dateOfBirth)) out.push({ code: "dob_mismatch" });
  return out;
}

// ============================================
// 7. The reapplication checklist (the #114 builder decides what is listed)
// ============================================

/**
 * Items from the #114 builder, narrowed to the evidence the matched criteria
 * need. Rules:
 *  - what is listed is decided by `buildChecklist` and the rubric's evidence
 *    links, never by a model;
 *  - a criterion that belongs to a deception reason contributes NOTHING (no
 *    do-it-yourself fix list for it); an item also linked to a non-deception
 *    matched criterion stays, listed for that one only;
 *  - nothing is created as a DocumentRequest here.
 */
export function buildReapplicationChecklist(args: {
  rubric: VisaRubric | null;
  reasons: readonly RefusalReason[];
  intakeAnswers: Record<string, unknown> | null;
}): RefusalChecklist {
  const { rubric, reasons, intakeAnswers } = args;
  if (!rubric) return { state: "not_built", items: [] };

  // Criteria the checklist may address: matched, and not under a deception reason.
  const fixable = new Set<string>();
  for (const r of reasons) {
    if (r.deception) continue;
    for (const m of r.matches) fixable.add(m.criterionId);
  }
  // Also drop a criterion that is ALSO matched under a deception reason: the
  // deception reading wins, so no fix list for it.
  for (const r of reasons) {
    if (!r.deception) continue;
    for (const m of r.matches) fixable.delete(m.criterionId);
  }
  if (fixable.size === 0) return { state: "not_built", items: [] };

  const built = buildChecklist({ rubric, visaRecord: null, intakeAnswers });
  if (built.state === "intake_needed") {
    return { state: "intake_needed", ...(built.emptyReason ? { emptyReason: built.emptyReason } : {}), items: [] };
  }

  // evidence item id -> the fixable criterion ids it evidences.
  const evidenceFor = new Map<string, string[]>();
  for (const ev of rubric.evidenceItems ?? []) {
    const linked = ev.criterionIds.filter((id) => fixable.has(id));
    if (linked.length > 0) evidenceFor.set(`ev-${ev.key}`, linked);
  }

  const items = built.items
    .filter((it) => evidenceFor.has(it.checklistItemId))
    .map((it) => ({
      checklistItemId: it.checklistItemId,
      title: it.title,
      holder: it.holder,
      required: it.required,
      reason: it.reason,
      citation: it.citation,
      addressesCriterionIds: evidenceFor.get(it.checklistItemId) ?? [],
    }));

  if (items.length === 0) {
    return { state: "no_checklist", emptyReason: "The published guidance for this route does not list a document for these points.", items: [] };
  }
  return { state: "ready", items };
}
