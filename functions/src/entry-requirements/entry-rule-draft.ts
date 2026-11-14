import {
  containsTokenBounded,
  groupNameSupported,
  isIso4217,
  LIST_ITEM_MAX_CHARS,
  normalizeForQuoteMatch,
  SnapshotQuoteIndex,
  uncodedNameSupported,
  unsupportedNumbers,
} from "../scrapers";
import { isCountryCode } from "../authorities/authority-ids";
import { HELD_DOCUMENT_KINDS, type HeldDocumentKind } from "../types/applicant-facts";
import type { TravelPurpose } from "../types/eligibility";
import { ENTRY_OUTCOMES, type EntryOutcome, type EntryRuleMember } from "../types/entry-requirements";
import { ENTRY_PURPOSES, isHttpsUrl } from "./entry-rule-validate";
import type { RawEntryRule } from "./entry-rule-prompt";

// ============================================
// ENTRY RULES — CODE CHECKS OF A DRAFTED RULE (issue #236, P7 of #228)
// ============================================
//
// The model proposes; CODE decides what may be stored. Every drafted rule is
// checked against the STORED snapshot of its official page (the same verbatim
// quote check the rulebooks use, `SnapshotQuoteIndex`), and refused with a
// named reason when anything it claims is not in the text:
//   - the quote must be verbatim, whole-word and on one line (or one PDF page);
//   - a stay limit (days, period) and a fee amount must be printed in the quote;
//   - every group name (`as_written`) and every `uncoded` entry must be in the
//     quote (or in the rule's list lines);
//   - a code is kept only when it is a real code shape (two letters, or a bloc /
//     treaty id from the run's list); anything else goes to `uncoded` with its
//     own words: a code is never made up, a name is never dropped;
//   - an authorisation's name must be in the quote; "it is not a visa" only
//     from a passage of the same page that says so; an application address
//     only when the page prints it (else the rule's own page is the link);
//   - every condition passage must be verbatim, or the rule is refused (a
//     dropped condition could loosen the rule).
//
// LONG LISTS (an annex of nationalities). The model names only the FIRST and
// LAST line of the list; code reads every line between them from the stored
// page, in order and IN FULL: no line is dropped and the list is never capped
// for size (the rulebook's "a list is never truncated", rubric-list-items.ts).
// A line too long to be one entry, a PDF (its line layout is lost), or bounds
// that cannot be found exactly once refuse the rule by name rather than guess.
//
// Pure: no Firebase, no model. Generic: no country or nationality name.

/** One source page a run drafts from, prepared for quote lookups. */
export interface DraftSource {
  sourceId: string;
  url: string;
  contentHash: string;
  fetchedAt: string;
  index: SnapshotQuoteIndex;
}

/** A printed list a rule's group is read from (codes are added later, by the coding step). */
export interface DraftList {
  fact: "nationality" | "residence";
  lines: string[];
  // Units (lines) of the snapshot the list runs through (inclusive), for the check's context.
  startUnit: number;
  endUnit: number;
}

/** A drafted rule that passed every code check (not yet coded or checked). */
export interface DraftedRule {
  sourceId: string;
  url: string;
  contentHash: string;
  fetchedAt: string;
  // The quote as the SOURCE has it (normalised form), and where it is.
  quote: string;
  unit: number;
  outcome: EntryOutcome;
  members: EntryRuleMember[];
  uncoded: string[];
  list?: DraftList;
  maxStayDays?: number;
  stayPeriodDays?: number;
  purposes?: TravelPurpose[];
  authorisationName?: string;
  notAVisa?: { quote: string; url: string };
  applyUrl?: string;
  fee?: { amount: number; currency: string; quote: string };
  conditions: string[];
  // Things code dropped without refusing the rule (an application address not printed on the page).
  notes: string[];
}

/** The outcome of checking one drafted rule. */
export type DraftCheck = { ok: true; rule: DraftedRule } | { ok: false; reason: string };

/** What code checks a drafted rule with. */
export interface DraftCheckContext {
  // Bloc / treaty authority ids the run allows in `members_of` and `holds` issuers.
  authorityIds: ReadonlySet<string>;
}

/** True for a whole number of days in a sane range. */
const isDays = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 3650;

/** Is a name written in the support text (as a capitalised name, or as a lower-case phrase)? */
function nameInText(name: string, support: string): boolean {
  return groupNameSupported(name, support) || uncodedNameSupported(name, support);
}

/**
 * The lines of a printed list, from its first to its last line, read from the
 * stored page. Each bound must match ONE WHOLE LINE exactly, the first exactly
 * once; the list is every non-empty line from it to the first matching last
 * line after it. Never capped; refused by name when not readable cleanly.
 */
export function readBoundedList(index: SnapshotQuoteIndex, first: string, last: string): { ok: true; lines: string[]; startUnit: number; endUnit: number } | { ok: false; reason: string } {
  if (index.isPaginated) return { ok: false, reason: "list_not_readable:pdf_layout_lost" };
  const f = normalizeForQuoteMatch(first);
  const l = normalizeForQuoteMatch(last);
  if (!f || !l) return { ok: false, reason: "list_bounds_missing" };
  const starts: number[] = [];
  for (let u = 0; u < index.unitCount; u++) if (index.unitText(u) === f) starts.push(u);
  if (starts.length === 0) return { ok: false, reason: "list_first_line_not_found" };
  if (starts.length > 1) return { ok: false, reason: "list_first_line_ambiguous" };
  const start = starts[0];
  let end = -1;
  for (let u = start; u < index.unitCount; u++) {
    if (index.unitText(u) === l) {
      end = u;
      break;
    }
  }
  if (end < 0) return { ok: false, reason: "list_last_line_not_found" };
  const lines: string[] = [];
  for (let u = start; u <= end; u++) {
    const text = index.unitText(u);
    if (!text) continue;
    // A line this long is not one entry of a list: refuse, never cut it.
    if (text.length > LIST_ITEM_MAX_CHARS) return { ok: false, reason: "list_not_readable:item_too_long" };
    lines.push(text);
  }
  return { ok: true, lines, startUnit: start, endUnit: end };
}

/**
 * Turn one raw drafted member into a coded member, or (code not usable) into
 * an uncoded name. The NAME must be in the support text either way; a name
 * that is not there is reported (`null`) and refuses the rule.
 */
function codeMember(m: RawEntryRule["members"][number], support: string, ctx: DraftCheckContext): { member?: EntryRuleMember; uncoded?: string } | null {
  const asWritten = m.asWritten.trim();
  if (!asWritten || !nameInText(asWritten, support)) return null;
  switch (m.kind) {
  case "nationality":
  case "residence":
    return isCountryCode(m.code) ? { member: { kind: m.kind, code: m.code, asWritten } } : { uncoded: asWritten };
  case "holds": {
    const docOk = (HELD_DOCUMENT_KINDS as readonly string[]).includes(m.document ?? "");
    const issuerOk = isCountryCode(m.issuer) || (typeof m.issuer === "string" && ctx.authorityIds.has(m.issuer));
    return docOk && issuerOk ? { member: { kind: "holds", document: m.document as HeldDocumentKind, issuer: m.issuer as string, asWritten } } : { uncoded: asWritten };
  }
  case "members_of":
    return typeof m.authorityId === "string" && ctx.authorityIds.has(m.authorityId) && (m.fact === "nationality" || m.fact === "residence")
      ? { member: { kind: "members_of", authorityId: m.authorityId, fact: m.fact, asWritten } }
      : { uncoded: asWritten };
  default:
    return { uncoded: asWritten };
  }
}

/**
 * Check one drafted rule against its source page. Returns the rule ready for
 * list coding and the independent check, or the reason it was refused.
 */
export function checkDraftedRule(raw: RawEntryRule, source: DraftSource, ctx: DraftCheckContext): DraftCheck {
  const refuse = (reason: string): DraftCheck => ({ ok: false, reason });
  // ---- outcome: one of the closed list ----
  if (!(ENTRY_OUTCOMES as readonly string[]).includes(raw.outcome)) return refuse("outcome_invalid");
  const outcome = raw.outcome as EntryOutcome;

  // ---- the quote: verbatim in the stored page ----
  const found = source.index.locate(raw.quote);
  if (!found.ok) return refuse(found.reason);
  const quote = found.matched;

  // ---- the list, read by code from the page ----
  let list: DraftList | undefined;
  if (raw.list) {
    const read = readBoundedList(source.index, raw.list.first, raw.list.last);
    if (!read.ok) return refuse(read.reason);
    list = { fact: raw.list.fact, lines: read.lines, startUnit: read.startUnit, endUnit: read.endUnit };
  }
  // Names may be in the quote or in the list lines.
  const support = list ? [quote, ...list.lines].join("\n") : quote;

  // ---- who: coded members, else uncoded names (never invented, never dropped) ----
  const members: EntryRuleMember[] = [];
  const uncoded: string[] = [];
  for (const m of raw.members) {
    const coded = codeMember(m, support, ctx);
    if (coded === null) return refuse("member_not_in_source");
    if (coded.member) members.push(coded.member);
    if (coded.uncoded) uncoded.push(coded.uncoded);
  }
  for (const u of raw.uncoded) {
    const name = u.trim();
    if (!name || !nameInText(name, support)) return refuse("uncoded_not_in_source");
    uncoded.push(name);
  }
  if (members.length === 0 && uncoded.length === 0 && !list) return refuse("group_empty");

  // ---- stay limit: whole days, printed in the quote ----
  if (raw.maxStayDays !== undefined && (!isDays(raw.maxStayDays) || unsupportedNumbers(raw.maxStayDays, quote).length > 0)) return refuse("stay_not_in_quote");
  if (raw.stayPeriodDays !== undefined && (!isDays(raw.stayPeriodDays) || raw.maxStayDays === undefined || unsupportedNumbers(raw.stayPeriodDays, quote).length > 0)) return refuse("stay_period_not_in_quote");

  // ---- purposes: the closed list ----
  if (raw.purposes && !raw.purposes.every((p) => (ENTRY_PURPOSES as readonly string[]).includes(p))) return refuse("purpose_invalid");
  const purposes = raw.purposes && raw.purposes.length > 0 ? ([...new Set(raw.purposes)] as TravelPurpose[]) : undefined;

  // ---- travel authorisation facts ----
  let notAVisa: DraftedRule["notAVisa"];
  if (raw.notAVisaQuote !== undefined) {
    // Only the source may say an authorisation is not a visa, and only about an authorisation.
    if (outcome !== "travel_authorisation") return refuse("not_a_visa_on_other_outcome");
    const nv = source.index.locate(raw.notAVisaQuote);
    if (!nv.ok) return refuse("not_a_visa_not_found");
    notAVisa = { quote: nv.matched, url: source.url };
  }
  let authorisationName: string | undefined;
  if (raw.authorisationName !== undefined && raw.authorisationName.trim()) {
    const name = raw.authorisationName.trim();
    const inText = containsTokenBounded(quote, name) || (notAVisa !== undefined && containsTokenBounded(notAVisa.quote, name));
    if (!inText) return refuse("authorisation_name_not_in_quote");
    authorisationName = name;
  }

  // ---- an application address: only one the page prints ----
  const notes: string[] = [];
  let applyUrl: string | undefined;
  if (raw.applyUrl !== undefined) {
    if (isHttpsUrl(raw.applyUrl) && source.index.containsLiteral(raw.applyUrl)) applyUrl = raw.applyUrl;
    else notes.push("apply_url_not_printed_on_page");
  }

  // ---- a fee: amount printed in the quote, ISO currency ----
  let fee: DraftedRule["fee"];
  if (raw.fee !== undefined) {
    const { amount, currency } = raw.fee;
    if (!Number.isFinite(amount) || amount < 0 || !isIso4217(currency) || unsupportedNumbers(amount, quote).length > 0) return refuse("fee_not_in_quote");
    fee = { amount, currency, quote };
  }

  // ---- further conditions: each verbatim, or the rule is refused ----
  const conditions: string[] = [];
  for (const c of raw.conditions) {
    const at = source.index.locate(c);
    if (!at.ok) return refuse("condition_not_found");
    conditions.push(at.matched);
  }

  return {
    ok: true,
    rule: {
      sourceId: source.sourceId,
      url: source.url,
      contentHash: source.contentHash,
      fetchedAt: source.fetchedAt,
      quote,
      unit: found.unit,
      outcome,
      members,
      uncoded,
      ...(list ? { list } : {}),
      ...(raw.maxStayDays !== undefined ? { maxStayDays: raw.maxStayDays } : {}),
      ...(raw.stayPeriodDays !== undefined ? { stayPeriodDays: raw.stayPeriodDays } : {}),
      ...(purposes ? { purposes } : {}),
      ...(authorisationName ? { authorisationName } : {}),
      ...(notAVisa ? { notAVisa } : {}),
      ...(applyUrl ? { applyUrl } : {}),
      ...(fee ? { fee } : {}),
      conditions,
      notes,
    },
  };
}

/**
 * Drop exact duplicates across chunks (the same page passage, outcome and
 * list): the first in document order wins. Different rules on one passage
 * (two outcomes) are both kept.
 */
export function dedupeDrafted(rules: readonly DraftedRule[]): DraftedRule[] {
  const seen = new Set<string>();
  const out: DraftedRule[] = [];
  for (const r of rules) {
    const key = JSON.stringify([r.sourceId, r.quote, r.outcome, r.list?.startUnit ?? null, r.list?.endUnit ?? null, r.members, r.uncoded]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}
