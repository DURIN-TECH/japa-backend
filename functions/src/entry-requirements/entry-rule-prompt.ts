import type { LlmRequest } from "../services/ai/llm-provider";
import { DATA_ONLY_RULE, wrapUntrusted } from "../services/ai/prompt-safety";
import { ENTRY_OUTCOMES } from "../types/entry-requirements";
import { HELD_DOCUMENT_KINDS } from "../types/applicant-facts";
import { ENTRY_PURPOSES } from "./entry-rule-validate";

// ============================================
// ENTRY RULES — PROMPTS, SCHEMAS AND ANSWER PARSERS (issue #236, P7 of #228)
// ============================================
//
// Three model calls, each with its own fixed system prompt and closed schema.
// None shares text with the rulebook prompts (scrapers/rubric/rubric-prompt.ts,
// rubric-checker-prompt.ts), which are owned and versioned separately.
//
//   1. DRAFT (role `judgement`): read one chunk of an official page and
//      propose the entry rules it states, each with a verbatim quote. Code
//      re-checks every quote, number and name against the stored page
//      (entry-rule-draft.ts); the model's answer is never stored as-is.
//   2. CODE A LIST (role `judgement`): map each line of a printed list of
//      names (an annex of nationalities) to a two-letter code, or to "none".
//      The lines are read from the stored page BY CODE, in full; the model only
//      labels them. A line it cannot code stays `uncoded`, never invented.
//   3. CHECK (role `verification`, the independent reader, never the drafter's
//      model): closed yes/no/unsure verdicts on each drafted rule and on each
//      (list line, code) pair. Anything but `yes` keeps the rule from being
//      served or moves the line to `uncoded`.
//
// Every answer is parsed strictly here (exact keys, closed values, every id
// answered once); a malformed answer throws `EntryPromptError("output_invalid")`.
//
// Logging: never a prompt or an answer. Generic: no country or nationality name.

/**
 * Version of the DRAFT and CODE-A-LIST prompts and schemas. Recorded on every
 * rule and run (`promptVersion`). Bump on any change to the text or schema.
 */
export const ENTRY_RULE_PROMPT_VERSION = "entry-rules-2026-11-14.1";

/** Version of the CHECK prompt and schema (`checkPromptVersion`). */
export const ENTRY_CHECK_PROMPT_VERSION = "entry-check-2026-11-14.1";

/** A model answer that could not be used. */
export class EntryPromptError extends Error {
  constructor(readonly code: "output_invalid", message: string) {
    super(message);
    this.name = "EntryPromptError";
  }
}

/** Request limits (from the extraction / checker settings). */
export interface EntryRequestLimits {
  maxOutputTokens: number;
  timeoutMs: number;
}

/** Plain object test. */
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Parse JSON or throw output_invalid. */
function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new EntryPromptError("output_invalid", `the ${what} answer was not JSON`);
  }
}

/** An object schema: these properties, `required` listed, nothing else. */
function obj(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: "object", additionalProperties: false, required, properties };
}

const STRING = { type: "string" };
const NUMBER = { type: "number" };

// ============================================
// 1. DRAFT
// ============================================

/** A bloc or treaty the drafter may name in a `members_of` member (data, pinned on the run). */
export interface DraftAuthorityRef {
  id: string;
  name: string;
}

/** What the drafter is told about the run (data, not instructions). */
export interface DraftContext {
  // The authority whose page this is.
  issuingAuthorityId: string;
  // Active bloc / treaty authorities: the only ids a `members_of` member may use.
  authorities: DraftAuthorityRef[];
}

/** The drafting system prompt. Fixed text: no per-document data. */
export const ENTRY_DRAFT_SYSTEM_PROMPT =
  "You read one part of an official government page about who may ENTER a country (or a group of countries) and on what terms. " +
  "List every entry rule the text states: which travellers need a visa, may enter without one, get a visa on arrival, need an electronic travel authorisation, or need (or do not need) a visa to transit. " +
  "Each rule has ONE outcome from the list: visa_required, visa_free, visa_on_arrival, travel_authorisation, transit_visa, transit_free.\n" +
  "QUOTE. `quote` is the shortest continuous passage, copied character for character from the text and on one line, that states the rule. Never paraphrase, join passages or fix spelling. A rule you cannot quote that way is left out.\n" +
  "WHO. `members` lists who the rule covers, each with `as_written`: the words exactly as the text writes them. kind `nationality` (nationals of a country: give `code`, the two-letter ISO country code, ONLY when the text names that country), `residence` (people who live in a country: `code`), `holds` (holders of a document: `document` one of visa, residence_permit, travel_authorisation, and `issuer` a two-letter country code or an authority id from the list given), `members_of` (citizens or residents of any member of a bloc or treaty: `authority_id` ONLY from the list given, `fact` nationality or residence). A group you cannot code that way goes, word for word, in `uncoded`. Never invent a code.\n" +
  "LISTS. When the rule says the travellers are those in a printed list (an annex, a table of countries), give `list.first` and `list.last`: the first and the last line of that list, each copied exactly as one whole line, and `list.fact`: nationality when the list names the travellers' countries of nationality, residence when it names where they live. Do not copy the list itself and do not code it: code reads every line of it.\n" +
  "DETAILS. `max_stay_days` and `stay_period_days` only when the text states them as numbers of days for this rule. `purposes` only when the text limits the rule to purposes, from: tourism, business, work, study, family, transit, other. `authorisation_name`: the authorisation's name exactly as written. `not_a_visa_quote`: ONLY if the text itself says the authorisation is not a visa, the exact passage that says so. `apply_url`: only an address printed in the text. `fee`: only an amount and ISO 4217 currency the quote states. `conditions`: other passages, copied exactly, that limit this rule (for example a document the traveller must also hold).\n" +
  "Report only what the text says. A rule that only refers to another page is left out. " +
  `${DATA_ONLY_RULE}`;

/** One member as the drafter writes it (validated in code later). */
const DRAFT_MEMBER_SCHEMA = obj(
  {
    kind: { type: "string", enum: ["nationality", "residence", "holds", "members_of"] },
    as_written: STRING,
    code: STRING,
    document: { type: "string", enum: [...HELD_DOCUMENT_KINDS] },
    issuer: STRING,
    authority_id: STRING,
    fact: { type: "string", enum: ["nationality", "residence"] },
  },
  ["kind", "as_written"]
);

/** The drafting answer schema (optional properties instead of nullables: no unions). */
export const ENTRY_DRAFT_SCHEMA: Record<string, unknown> = obj(
  {
    rules: {
      type: "array",
      items: obj(
        {
          quote: STRING,
          outcome: { type: "string", enum: [...ENTRY_OUTCOMES] },
          members: { type: "array", items: DRAFT_MEMBER_SCHEMA },
          uncoded: { type: "array", items: STRING },
          list: obj({ first: STRING, last: STRING, fact: { type: "string", enum: ["nationality", "residence"] } }, ["first", "last", "fact"]),
          max_stay_days: NUMBER,
          stay_period_days: NUMBER,
          purposes: { type: "array", items: { type: "string", enum: [...ENTRY_PURPOSES] } },
          authorisation_name: STRING,
          not_a_visa_quote: STRING,
          apply_url: STRING,
          fee: obj({ amount: NUMBER, currency: STRING }, ["amount", "currency"]),
          conditions: { type: "array", items: STRING },
        },
        ["quote", "outcome", "members", "uncoded", "conditions"]
      ),
    },
  },
  ["rules"]
);

/** One drafted member, as parsed (shape only; meaning is checked in entry-rule-draft.ts). */
export interface RawEntryMember {
  kind: "nationality" | "residence" | "holds" | "members_of";
  asWritten: string;
  code?: string;
  document?: string;
  issuer?: string;
  authorityId?: string;
  fact?: "nationality" | "residence";
}

/** One drafted rule, as parsed. */
export interface RawEntryRule {
  quote: string;
  outcome: string;
  members: RawEntryMember[];
  uncoded: string[];
  list?: { first: string; last: string; fact: "nationality" | "residence" };
  maxStayDays?: number;
  stayPeriodDays?: number;
  purposes?: string[];
  authorisationName?: string;
  notAVisaQuote?: string;
  applyUrl?: string;
  fee?: { amount: number; currency: string };
  conditions: string[];
}

/** The user turn of one drafting call: run facts, then the page text as untrusted data. */
export function buildDraftRequest(chunkText: string, url: string, ctx: DraftContext, limits: EntryRequestLimits): LlmRequest {
  const authorities = ctx.authorities.length > 0 ? ctx.authorities.map((a) => `- ${a.id}: ${a.name}`).join("\n") : "(none)";
  return {
    role: "judgement",
    system: ENTRY_DRAFT_SYSTEM_PROMPT,
    user: [
      `Issuing authority id: ${ctx.issuingAuthorityId}`,
      `Page address: ${url}`,
      "Blocs and treaties (the only ids a members_of member or an issuer may use besides two-letter country codes):",
      authorities,
      "The page text:",
      wrapUntrusted(chunkText, "official_page"),
    ].join("\n\n"),
    schema: ENTRY_DRAFT_SCHEMA,
    maxOutputTokens: limits.maxOutputTokens,
    timeoutMs: limits.timeoutMs,
    effort: "high",
  };
}

/** Optional string field: absent or a string, else invalid. */
function optStr(v: unknown, what: string): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw new EntryPromptError("output_invalid", `${what} is not a string`);
  return v;
}

/** Optional number field. */
function optNum(v: unknown, what: string): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) throw new EntryPromptError("output_invalid", `${what} is not a number`);
  return v;
}

/** A list of strings. */
function strList(v: unknown, what: string): string[] {
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) throw new EntryPromptError("output_invalid", `${what} is not a list of strings`);
  return v as string[];
}

/** Parse the drafting answer (shape only). */
export function parseDraftAnswer(text: string): RawEntryRule[] {
  const raw = parseJson(text, "draft");
  if (!isObj(raw) || Object.keys(raw).join(",") !== "rules" || !Array.isArray(raw.rules)) throw new EntryPromptError("output_invalid", "expected only a rules list");
  const allowed = new Set(["quote", "outcome", "members", "uncoded", "list", "max_stay_days", "stay_period_days", "purposes", "authorisation_name", "not_a_visa_quote", "apply_url", "fee", "conditions"]);
  return (raw.rules as unknown[]).map((r, i): RawEntryRule => {
    const at = `rules[${i}]`;
    if (!isObj(r) || Object.keys(r).some((k) => !allowed.has(k))) throw new EntryPromptError("output_invalid", `${at} has the wrong shape`);
    if (typeof r.quote !== "string" || typeof r.outcome !== "string" || !Array.isArray(r.members)) throw new EntryPromptError("output_invalid", `${at} lacks quote, outcome or members`);
    const members = (r.members as unknown[]).map((m, j): RawEntryMember => {
      if (!isObj(m) || typeof m.kind !== "string" || typeof m.as_written !== "string") throw new EntryPromptError("output_invalid", `${at}.members[${j}] has the wrong shape`);
      return {
        kind: m.kind as RawEntryMember["kind"],
        asWritten: m.as_written,
        code: optStr(m.code, "code"),
        document: optStr(m.document, "document"),
        issuer: optStr(m.issuer, "issuer"),
        authorityId: optStr(m.authority_id, "authority_id"),
        fact: optStr(m.fact, "fact") as RawEntryMember["fact"],
      };
    });
    let list: RawEntryRule["list"];
    if (r.list !== undefined) {
      if (!isObj(r.list) || typeof r.list.first !== "string" || typeof r.list.last !== "string" || (r.list.fact !== "nationality" && r.list.fact !== "residence")) throw new EntryPromptError("output_invalid", `${at}.list has the wrong shape`);
      list = { first: r.list.first, last: r.list.last, fact: r.list.fact };
    }
    let fee: RawEntryRule["fee"];
    if (r.fee !== undefined) {
      if (!isObj(r.fee) || typeof r.fee.amount !== "number" || typeof r.fee.currency !== "string") throw new EntryPromptError("output_invalid", `${at}.fee has the wrong shape`);
      fee = { amount: r.fee.amount, currency: r.fee.currency };
    }
    return {
      quote: r.quote,
      outcome: r.outcome,
      members,
      uncoded: strList(r.uncoded ?? [], `${at}.uncoded`),
      list,
      maxStayDays: optNum(r.max_stay_days, "max_stay_days"),
      stayPeriodDays: optNum(r.stay_period_days, "stay_period_days"),
      purposes: r.purposes === undefined ? undefined : strList(r.purposes, `${at}.purposes`),
      authorisationName: optStr(r.authorisation_name, "authorisation_name"),
      notAVisaQuote: optStr(r.not_a_visa_quote, "not_a_visa_quote"),
      applyUrl: optStr(r.apply_url, "apply_url"),
      fee,
      conditions: strList(r.conditions ?? [], `${at}.conditions`),
    };
  });
}

// ============================================
// 2. CODE A LIST
// ============================================

/** The list-coding system prompt. */
export const ENTRY_CODING_SYSTEM_PROMPT =
  "Each line below is one entry of an official list of countries or nationalities, exactly as printed. " +
  "For each line, give `code`: the two-letter ISO 3166-1 country code of the ONE country the line names, or `none` when the line does not name exactly one country (a territory you are unsure of, an entity that is not a country, a heading, several countries, a note). " +
  "Use `none` whenever you hesitate: a line with no code is kept as written and is never decided by code, while a wrong code would answer for the wrong people. " +
  "Answer every line once, by its id. The lines may be in any language. " +
  `${DATA_ONLY_RULE}`;

/** The list-coding answer schema. */
export const ENTRY_CODING_SCHEMA: Record<string, unknown> = obj(
  { answers: { type: "array", items: obj({ id: STRING, code: STRING }, ["id", "code"]) } },
  ["answers"]
);

/** One list line sent to be coded. */
export interface ListLine {
  id: string;
  text: string;
}

/** The request coding one batch of list lines. */
export function buildCodingRequest(lines: readonly ListLine[], limits: EntryRequestLimits): LlmRequest {
  return {
    role: "judgement",
    system: ENTRY_CODING_SYSTEM_PROMPT,
    user: ["The list lines:", wrapUntrusted(JSON.stringify(lines.map((l) => ({ id: l.id, line: l.text }))), "list_lines")].join("\n\n"),
    schema: ENTRY_CODING_SCHEMA,
    maxOutputTokens: limits.maxOutputTokens,
    timeoutMs: limits.timeoutMs,
    effort: "low",
    cacheSystem: true,
  };
}

/**
 * Parse a coding answer: exactly one answer per line id; `code` is a
 * two-letter upper-case code or "none". Returns id -> code (null for none).
 */
export function parseCodingAnswer(text: string, lines: readonly ListLine[]): Map<string, string | null> {
  const raw = parseJson(text, "list coding");
  if (!isObj(raw) || Object.keys(raw).join(",") !== "answers" || !Array.isArray(raw.answers)) throw new EntryPromptError("output_invalid", "expected only an answers list");
  const ids = new Set(lines.map((l) => l.id));
  const out = new Map<string, string | null>();
  for (const a of raw.answers as unknown[]) {
    if (!isObj(a) || Object.keys(a).sort().join(",") !== "code,id" || typeof a.id !== "string" || typeof a.code !== "string") throw new EntryPromptError("output_invalid", "a coding answer has the wrong shape");
    if (!ids.has(a.id) || out.has(a.id)) throw new EntryPromptError("output_invalid", "a line id not sent, or answered twice");
    if (a.code !== "none" && !/^[A-Z]{2}$/.test(a.code)) throw new EntryPromptError("output_invalid", "a code that is neither two letters nor none");
    out.set(a.id, a.code === "none" ? null : a.code);
  }
  if (out.size !== ids.size) throw new EntryPromptError("output_invalid", "not every line was answered");
  return out;
}

// ============================================
// 3. CHECK (independent reader)
// ============================================

/** The aspects the check judges on each rule. */
export const ENTRY_CHECK_ASPECTS = ["outcome_right", "group_right", "details_right", "nothing_missing", "not_a_visa_right", "list_complete"] as const;
export type EntryCheckAspect = (typeof ENTRY_CHECK_ASPECTS)[number];

/** Closed verdict values. `na` is accepted only where the rule has nothing to judge for that aspect. */
export const ENTRY_VERDICTS = ["yes", "no", "unsure", "na"] as const;
export type EntryVerdict = (typeof ENTRY_VERDICTS)[number];

/** The check's system prompt. Shares no text with the drafter's. */
export const ENTRY_CHECK_SYSTEM_PROMPT =
  "You independently check entry rules that another reader drafted from official pages. For each rule you get its verbatim official passage (and the lines around it), and what was drafted from it. " +
  "Judge each aspect only against the passage shown, with one of yes, no, unsure, na:\n" +
  "- outcome_right: the passage says exactly this outcome (visa required, visa free, visa on arrival, travel authorisation, transit visa, transit free) for these travellers.\n" +
  "- group_right: the travellers drafted (each with the words the passage uses, and any code) are exactly who the passage covers; a code names the country the words name.\n" +
  "- details_right: any stay limit, purposes, authorisation name, fee and conditions drafted are what the passage says; na when none was drafted.\n" +
  "- nothing_missing: nothing in the passage or the lines right after it narrows or reverses the rule (an exception, a further condition, a negation) that the draft leaves out.\n" +
  "- not_a_visa_right: the 'not a visa' passage really says the authorisation is not a visa; na when none was drafted.\n" +
  "- list_complete: when the rule's group is a printed list, the list shown starts at its real first entry and ends at its real last entry (look at the lines before and after it); na when there is no list.\n" +
  "For each list line with a code, answer whether the code is the country the line names (yes, no, unsure). " +
  "Answer unsure whenever you hesitate: an unconfirmed rule is not served, and an unconfirmed code is kept as written instead. " +
  `${DATA_ONLY_RULE}`;

/** The check's answer schema. */
export const ENTRY_CHECK_SCHEMA: Record<string, unknown> = obj(
  {
    rules: {
      type: "array",
      items: obj(
        Object.fromEntries([["id", STRING], ...ENTRY_CHECK_ASPECTS.map((a) => [a, { type: "string", enum: [...ENTRY_VERDICTS] }])]),
        ["id", ...ENTRY_CHECK_ASPECTS]
      ),
    },
    codes: { type: "array", items: obj({ id: STRING, verdict: { type: "string", enum: ["yes", "no", "unsure"] } }, ["id", "verdict"]) },
  },
  ["rules", "codes"]
);

/** One rule as the check sees it. */
export interface CheckRuleView {
  id: string;
  passage: string;
  linesBefore: string[];
  linesAfter: string[];
  drafted: Record<string, unknown>;
  // The list as read by code (ends + neighbours), when there is one.
  list?: { firstLine: string; lastLine: string; lineCount: number; lineBefore: string | null; lineAfter: string | null };
}

/** One (list line, code) pair to confirm. */
export interface CheckCodeView {
  id: string;
  line: string;
  code: string;
}

/** The check request for a batch of rules and code pairs. */
export function buildCheckRequest(rules: readonly CheckRuleView[], codes: readonly CheckCodeView[], limits: EntryRequestLimits): LlmRequest {
  return {
    role: "verification",
    system: ENTRY_CHECK_SYSTEM_PROMPT,
    user: [
      "Answer every rule and every code below once, by its id.",
      "Rules:",
      wrapUntrusted(JSON.stringify(rules), "entry_rules"),
      "Codes to confirm:",
      wrapUntrusted(JSON.stringify(codes), "list_codes"),
    ].join("\n\n"),
    schema: ENTRY_CHECK_SCHEMA,
    maxOutputTokens: limits.maxOutputTokens,
    timeoutMs: limits.timeoutMs,
    effort: "medium",
    cacheSystem: true,
  };
}

/** The parsed check answer. */
export interface CheckAnswer {
  rules: Map<string, Record<EntryCheckAspect, EntryVerdict>>;
  codes: Map<string, "yes" | "no" | "unsure">;
}

/** Parse a check answer: every rule and code id sent is answered exactly once. */
export function parseCheckAnswer(text: string, rules: readonly CheckRuleView[], codes: readonly CheckCodeView[]): CheckAnswer {
  const raw = parseJson(text, "check");
  if (!isObj(raw) || Object.keys(raw).sort().join(",") !== "codes,rules" || !Array.isArray(raw.rules) || !Array.isArray(raw.codes)) throw new EntryPromptError("output_invalid", "expected rules and codes lists");
  const ruleIds = new Set(rules.map((r) => r.id));
  const codeIds = new Set(codes.map((c) => c.id));
  const out: CheckAnswer = { rules: new Map(), codes: new Map() };
  const keys = ["id", ...ENTRY_CHECK_ASPECTS].sort().join(",");
  for (const r of raw.rules as unknown[]) {
    if (!isObj(r) || Object.keys(r).sort().join(",") !== keys || typeof r.id !== "string") throw new EntryPromptError("output_invalid", "a rule verdict has the wrong shape");
    if (!ruleIds.has(r.id) || out.rules.has(r.id)) throw new EntryPromptError("output_invalid", "a rule id not sent, or answered twice");
    const verdicts = {} as Record<EntryCheckAspect, EntryVerdict>;
    for (const a of ENTRY_CHECK_ASPECTS) {
      if (!(ENTRY_VERDICTS as readonly unknown[]).includes(r[a])) throw new EntryPromptError("output_invalid", "a verdict outside the closed values");
      verdicts[a] = r[a] as EntryVerdict;
    }
    out.rules.set(r.id, verdicts);
  }
  for (const c of raw.codes as unknown[]) {
    if (!isObj(c) || Object.keys(c).sort().join(",") !== "id,verdict" || typeof c.id !== "string") throw new EntryPromptError("output_invalid", "a code verdict has the wrong shape");
    if (!codeIds.has(c.id) || out.codes.has(c.id)) throw new EntryPromptError("output_invalid", "a code id not sent, or answered twice");
    if (c.verdict !== "yes" && c.verdict !== "no" && c.verdict !== "unsure") throw new EntryPromptError("output_invalid", "a code verdict outside yes, no, unsure");
    out.codes.set(c.id, c.verdict);
  }
  if (out.rules.size !== ruleIds.size || out.codes.size !== codeIds.size) throw new EntryPromptError("output_invalid", "not every rule or code was answered");
  return out;
}
