import { ENTRY_OUTCOMES, ENTRY_RULE_STATUSES, type EntryRule, type EntryRuleMember } from "../types/entry-requirements";
import { HELD_DOCUMENT_KINDS } from "../types/applicant-facts";
import { checkAuthorityId, isCountryCode } from "../authorities/authority-ids";
import { isIso4217 } from "../scrapers";

// ============================================
// ENTRY RULES — THE STORE'S STRUCTURAL CHECK (issue #236, P7 of #228)
// ============================================
//
// The one rule that can never bend: EVERY stored entry rule carries a verbatim
// quote and the official URL it came from. `validateEntryRule` is run by the
// store on every write (entry-rule.store.ts) and refuses a rule without them,
// or with any field the lookup could misread (an outcome outside the list, a
// group member with no code, a stay limit that is not a whole number of days).
//
// Pure: no Firebase, no clock. It does NOT re-check that the quote is in the
// source (the drafting pipeline proves that against the stored snapshot before
// it builds a rule); it checks that what reaches Firestore is complete.
//
// Generic: no country, bloc, treaty or nationality name.

/** Shortest quote accepted (the rubric's floor: a few words prove nothing). */
export const MIN_ENTRY_QUOTE_CHARS = 15;

/** The closed list of travel purposes (same as the eligibility pre-check form). */
export const ENTRY_PURPOSES = ["tourism", "business", "work", "study", "family", "transit", "other"] as const;

/** A store write refused: names the field, never the stored text. */
export class EntryRuleRefusedError extends Error {
  constructor(readonly problems: string[]) {
    super(`entry rule refused: ${problems.join("; ")}`);
    this.name = "EntryRuleRefusedError";
  }
}

/** True for an absolute https URL with a host (the only kind of official link stored). */
export function isHttpsUrl(raw: unknown): raw is string {
  if (typeof raw !== "string" || raw.trim() !== raw || raw.length === 0) return false;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && u.hostname.length > 0 && !u.username && !u.password;
  } catch {
    return false;
  }
}

/** True for a whole number of days in a sane range (1 day to 10 years). */
function isDays(raw: unknown): raw is number {
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 1 && raw <= 3650;
}

/** True for a non-empty string after trimming. */
const nonEmpty = (raw: unknown): raw is string => typeof raw === "string" && raw.trim().length > 0;

/** Problems of one group member (empty when it is usable). */
function memberProblems(m: EntryRuleMember, i: number): string[] {
  const at = `group.members[${i}]`;
  const out: string[] = [];
  if (!m || typeof m !== "object") return [`${at}: not an object`];
  if (!nonEmpty((m as { asWritten?: unknown }).asWritten)) out.push(`${at}.asWritten: missing (the source's own wording is required)`);
  switch (m.kind) {
  case "nationality":
  case "residence":
    if (!isCountryCode(m.code)) out.push(`${at}.code: not a two-letter code`);
    break;
  case "holds":
    if (!(HELD_DOCUMENT_KINDS as readonly string[]).includes(m.document)) out.push(`${at}.document: not a held-document kind`);
    if (!isCountryCode(m.issuer) && !checkAuthorityId(m.issuer).ok) out.push(`${at}.issuer: not a country code or authority id`);
    break;
  case "members_of":
    if (!checkAuthorityId(m.authorityId).ok || isCountryCode(m.authorityId)) out.push(`${at}.authorityId: not a bloc or treaty id`);
    if (m.fact !== "nationality" && m.fact !== "residence") out.push(`${at}.fact: must be nationality or residence`);
    break;
  default:
    out.push(`${at}.kind: unknown`);
  }
  return out;
}

/**
 * Every structural problem of a rule about to be stored ([] = storable).
 * Quote and URL first: a rule without them is refused whatever else it has.
 */
export function entryRuleProblems(rule: Partial<EntryRule>): string[] {
  const out: string[] = [];
  // ---- the non-negotiable pair ----
  if (!nonEmpty(rule.quote)) out.push("quote: missing (every entry rule needs the verbatim official sentence)");
  else if (rule.quote.trim().length < MIN_ENTRY_QUOTE_CHARS) out.push("quote: too short to prove anything");
  if (!isHttpsUrl(rule.url)) out.push("url: missing or not an https address (every entry rule needs its official page)");
  // ---- identity and scope ----
  if (!nonEmpty(rule.id)) out.push("id: missing");
  if (!checkAuthorityId(rule.issuingAuthorityId).ok) out.push("issuingAuthorityId: not an authority id");
  const d = rule.destination;
  if (!d || (d.kind !== "countries" && d.kind !== "members_of")) out.push("destination: missing");
  else if (d.kind === "countries") {
    if (!Array.isArray(d.countryCodes) || d.countryCodes.length === 0 || !d.countryCodes.every(isCountryCode)) out.push("destination.countryCodes: need at least one two-letter code");
    if (JSON.stringify(rule.destinationCodes) !== JSON.stringify(d.countryCodes)) out.push("destinationCodes: must equal destination.countryCodes");
    if (rule.scopeAuthorityId !== null) out.push("scopeAuthorityId: must be null for a countries scope");
  } else {
    if (!checkAuthorityId(d.authorityId).ok || isCountryCode(d.authorityId)) out.push("destination.authorityId: not a bloc or treaty id");
    if (!Array.isArray(rule.destinationCodes) || rule.destinationCodes.length !== 0) out.push("destinationCodes: must be empty for a members_of scope");
    if (rule.scopeAuthorityId !== d.authorityId) out.push("scopeAuthorityId: must equal destination.authorityId");
  }
  // ---- what the rule says ----
  if (!(ENTRY_OUTCOMES as readonly unknown[]).includes(rule.outcome)) out.push("outcome: not one of the entry outcomes");
  const g = rule.group;
  if (!g || !Array.isArray(g.members) || !Array.isArray(g.uncoded)) out.push("group: missing");
  else {
    if (g.members.length === 0 && g.uncoded.length === 0) out.push("group: names nobody (a coded or an uncoded member is required)");
    g.members.forEach((m, i) => out.push(...memberProblems(m, i)));
    if (!g.uncoded.every(nonEmpty)) out.push("group.uncoded: an empty entry");
  }
  if (rule.maxStayDays !== undefined && !isDays(rule.maxStayDays)) out.push("maxStayDays: not a whole number of days");
  if (rule.stayPeriodDays !== undefined && !isDays(rule.stayPeriodDays)) out.push("stayPeriodDays: not a whole number of days");
  if (rule.stayPeriodDays !== undefined && rule.maxStayDays === undefined) out.push("stayPeriodDays: given without maxStayDays");
  if (rule.purposes !== undefined && (!Array.isArray(rule.purposes) || rule.purposes.length === 0 || !rule.purposes.every((p) => (ENTRY_PURPOSES as readonly string[]).includes(p)))) out.push("purposes: not from the purpose list");
  if (rule.authorisationName !== undefined && !nonEmpty(rule.authorisationName)) out.push("authorisationName: empty");
  // "It is not a visa" is the source's statement, about an authorisation only.
  if (rule.notAVisa !== undefined) {
    if (rule.outcome !== "travel_authorisation") out.push("notAVisa: only a travel authorisation can carry it");
    if (!nonEmpty(rule.notAVisa?.quote) || !isHttpsUrl(rule.notAVisa?.url)) out.push("notAVisa: needs its own quote and URL");
  }
  if (rule.applyUrl !== undefined && !isHttpsUrl(rule.applyUrl)) out.push("applyUrl: not an https address");
  if (rule.fee !== undefined) {
    const f = rule.fee;
    if (typeof f?.amount !== "number" || !Number.isFinite(f.amount) || f.amount < 0) out.push("fee.amount: not a number");
    if (typeof f?.currency !== "string" || !isIso4217(f.currency)) out.push("fee.currency: not an ISO 4217 code");
    if (!nonEmpty(f?.quote)) out.push("fee.quote: missing (a fee is stored with the sentence it is in)");
  }
  if (!Array.isArray(rule.conditions) || !rule.conditions.every(nonEmpty)) out.push("conditions: must be a list of verbatim passages");
  if (rule.listItems !== undefined && (!Array.isArray(rule.listItems) || rule.listItems.length === 0 || !rule.listItems.every(nonEmpty))) out.push("listItems: must be the non-empty list lines");
  // ---- provenance ----
  if (!nonEmpty(rule.sourceId)) out.push("sourceId: missing");
  if (!nonEmpty(rule.contentHash)) out.push("contentHash: missing");
  if (!nonEmpty(rule.fetchedAt) || !Number.isFinite(Date.parse(rule.fetchedAt))) out.push("fetchedAt: not a date-time");
  if (!(ENTRY_RULE_STATUSES as readonly unknown[]).includes(rule.status)) out.push("status: unknown");
  if (!nonEmpty(rule.runId)) out.push("runId: missing");
  if (!nonEmpty(rule.promptVersion) || !nonEmpty(rule.checkPromptVersion)) out.push("promptVersion / checkPromptVersion: missing");
  return out;
}

/** Throw `EntryRuleRefusedError` unless the rule is storable. */
export function assertStorableEntryRule(rule: Partial<EntryRule>): asserts rule is EntryRule {
  const problems = entryRuleProblems(rule);
  if (problems.length > 0) throw new EntryRuleRefusedError(problems);
}
