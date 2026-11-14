import {
  matchGroup,
  needWords,
  type FactNeed,
  type FactsForRules,
  type MembershipOnDate,
} from "../services/ai/applicant-groups";
import type { TravelPurpose } from "../types/eligibility";
import {
  ENTRY_OUTCOME_STRICTNESS,
  TRANSIT_OUTCOMES,
  type EntryAnswerAuthorisation,
  type EntryAnswerCondition,
  type EntryAnswerFee,
  type EntryAnswerPossibleRule,
  type EntryAnswerRule,
  type EntryAnswerSource,
  type EntryOutcome,
  type EntryRequirementResult,
  type EntryRequirementUnknown,
  type EntryRule,
  type EntryRuleMember,
  type EntryUnknownCode,
} from "../types/entry-requirements";

// ============================================
// ENTRY REQUIREMENTS — THE ANSWER (issue #236, P7 of #228)
// ============================================
//
// PURE: stored rules + what the traveller told us in, one answer out. No
// Firebase, no model, no clock (the caller passes the date). The service
// (entry-requirements.service.ts) loads the rules, the membership, the
// freshness of each rule's source and the FX rate, then calls this.
//
// NEVER GUESS. The answer is `unknown` (with a plain reason and the
// destination authority's official page when one is registered) whenever:
//   - no published rule covers the destination and the traveller (`no_rule`);
//   - a rule MIGHT cover them but needs a fact they did not give
//     (`missing_fact`: "we need to know which visas or permits you hold");
//   - a covering rule rests on a source we have not confirmed recently, or on
//     an older version of the page than the one we last fetched (`stale`);
//   - rules exist, but none covers a stay this long / this purpose.
// A rule that could make the answer STRICTER than the matched one but needs a
// missing fact also gives `missing_fact`: we never answer "no visa needed"
// while a stricter rule might apply. A LESS strict possible rule is listed in
// `mightAlsoApply` beside a sourced answer ("you may not need one if you hold
// a valid residence permit: tell us").
//
// The text never says "you need a visa" or "you don't" without the source
// that says so: every `answer` message starts "The official source says".
//
// Generic: no country, bloc, treaty or nationality name.

/** What the traveller told us (already validated by the controller). */
export interface EntryQuery {
  destination: string;
  facts: FactsForRules;
  purpose?: TravelPurpose;
  stayDays?: number;
}

/** Everything the pure answer needs besides the rules and the query. */
export interface EntryAnswerContext {
  // The date rules are checked on ("YYYY-MM-DD"): held documents must be valid on it.
  onDate: string;
  // Members of each authority a rule's `members_of` group names, on `onDate`.
  membership: MembershipOnDate;
  // Is a rule's source still current? (see the service: same page version as
  // our last fetch, and fetched within the configured age).
  isFresh: (rule: EntryRule) => boolean;
  // A rule's fee as shown (USD through the catalog FX rules).
  feeView: (rule: EntryRule) => EntryAnswerFee | null;
  // The destination authority's registered official page, when there is one.
  destinationAuthorityPage?: string;
}

/** Rank of an outcome: 0 is the strictest. */
export function strictnessRank(outcome: EntryOutcome): number {
  const i = ENTRY_OUTCOME_STRICTNESS.indexOf(outcome);
  return i < 0 ? ENTRY_OUTCOME_STRICTNESS.length : i;
}

/** Rules sorted strictest first, then by id (deterministic). */
function byStrictness<T extends { outcome: EntryOutcome; ruleId: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => strictnessRank(a.outcome) - strictnessRank(b.outcome) || a.ruleId.localeCompare(b.ruleId));
}

/**
 * The purposes a rule is limited to, or null for "any purpose". A transit
 * outcome answers a transit only, so it is limited to `transit` even when the
 * quote lists no purpose.
 */
export function effectivePurposes(rule: Pick<EntryRule, "purposes" | "outcome">): TravelPurpose[] | null {
  if (rule.purposes && rule.purposes.length > 0) return rule.purposes;
  return TRANSIT_OUTCOMES.includes(rule.outcome) ? ["transit"] : null;
}

/** The source line of a rule. */
function sourceOf(rule: EntryRule): EntryAnswerSource {
  return {
    quote: rule.quote,
    url: rule.url,
    fetchedAt: rule.fetchedAt,
    ...(rule.listItems && rule.listItems.length > 0 ? { listItems: rule.listItems } : {}),
  };
}

/** Plain words for a held-document kind. */
const DOCUMENT_WORDS: Record<string, string> = {
  visa: "visa",
  residence_permit: "residence permit",
  travel_authorisation: "travel authorisation",
};

/**
 * The conditions of a rule, in plain words. Code writes only from SOURCED,
 * stored fields: the stay limit and purposes the quote states, the group
 * member that matched (its own wording from the quote), and the verbatim
 * condition passages.
 */
export function conditionsOf(rule: EntryRule, matched: EntryRuleMember | null): EntryAnswerCondition[] {
  const out: EntryAnswerCondition[] = [];
  if (rule.maxStayDays !== undefined) {
    out.push({
      kind: "max_stay",
      text: `Stays of up to ${rule.maxStayDays} days${rule.stayPeriodDays !== undefined ? ` in any ${rule.stayPeriodDays}-day period` : ""}.`,
    });
  }
  const purposes = effectivePurposes(rule);
  if (purposes) out.push({ kind: "purposes", text: `Only for these purposes of travel: ${purposes.join(", ")}.` });
  if (matched && matched.kind === "holds") {
    out.push({
      kind: "holds",
      text: `For holders of a ${DOCUMENT_WORDS[matched.document] ?? matched.document} (the source says: "${matched.asWritten}"). It must still be valid when you travel.`,
    });
  }
  for (const c of rule.conditions) out.push({ kind: "source_condition", text: c, quote: c });
  return out;
}

/** A travel authorisation's facts (null for any other outcome). */
export function authorisationOf(rule: EntryRule): EntryAnswerAuthorisation | null {
  if (rule.outcome !== "travel_authorisation") return null;
  return {
    name: rule.authorisationName ?? null,
    // ONLY the source's own statement; code never writes "it is not a visa".
    notAVisa: rule.notAVisa ?? null,
    // The printed application page, else the rule's own official page.
    applyUrl: rule.applyUrl ?? rule.url,
    // Seli does not run an application for an authorisation (FU-4).
    seliApplies: false,
  };
}

/** The answer message: always names the source; never a bare "you need a visa". */
export function answerMessage(rule: EntryRule, disagree: boolean): string {
  const stay = rule.maxStayDays !== undefined ? ` for up to ${rule.maxStayDays} days` : "";
  let text: string;
  switch (rule.outcome) {
  case "visa_required":
    text = "The official source says you need a visa for this trip.";
    break;
  case "visa_free":
    text = `The official source says you can enter without a visa${stay}.`;
    break;
  case "visa_on_arrival":
    text = `The official source says you can get a visa when you arrive${stay}.`;
    break;
  case "travel_authorisation":
    text = `The official source says you need a travel authorisation${rule.authorisationName ? ` (${rule.authorisationName})` : ""} before you travel.`;
    // Said ONLY when the source says it, with its own quote on the answer.
    if (rule.notAVisa) text += " The source says it is not a visa.";
    text += " Seli does not apply for it for you: use the official page.";
    break;
  case "transit_visa":
    text = "The official source says you need a visa to pass through in transit.";
    break;
  case "transit_free":
    text = "The official source says you can pass through in transit without a visa.";
    break;
  default:
    text = "The official source has a rule for this trip.";
  }
  if (disagree) text += " Other official rules also match your trip; the strictest is shown first.";
  return text;
}

/** Plain words of each unknown reason (never "you need a visa" / "you don't"). */
export const UNKNOWN_REASON_WORDS: Record<EntryUnknownCode, string> = {
  no_rule: "We don't have an official source for this yet.",
  missing_fact: "We can't answer from the official source yet: we need to know more about you.",
  stale: "Our copy of the official source may be out of date, so we can't answer yet.",
  stay_not_covered: "We don't have an official source for a stay this long yet.",
  purpose_not_covered: "We don't have an official source for this purpose of travel yet.",
};

/** Build an `unknown` answer. */
function unknown(
  query: EntryQuery,
  ctx: EntryAnswerContext,
  code: EntryUnknownCode,
  extra: { needs?: FactNeed[]; mightApply?: EntryAnswerPossibleRule[] } = {}
): EntryRequirementUnknown {
  let reason = UNKNOWN_REASON_WORDS[code];
  const needs = extra.needs && extra.needs.length > 0 ? needWords(extra.needs) : undefined;
  if (code === "missing_fact" && needs) reason = `We can't answer from the official source yet: we need to know ${needs}.`;
  if (ctx.destinationAuthorityPage) reason += " Check the official page before you travel.";
  return {
    status: "unknown",
    destination: query.destination,
    code,
    reason,
    ...(needs ? { needs } : {}),
    ...(ctx.destinationAuthorityPage ? { destinationAuthorityPage: ctx.destinationAuthorityPage } : {}),
    ...(extra.mightApply && extra.mightApply.length > 0 ? { mightApply: extra.mightApply } : {}),
  };
}

/**
 * Answer one query from the rules IN SCOPE for its destination (the caller has
 * already kept only served rules whose destination covers it).
 */
export function answerEntryRequirements(rules: readonly EntryRule[], query: EntryQuery, ctx: EntryAnswerContext): EntryRequirementResult {
  // Each rule ends in exactly one of these piles.
  const matched: { rule: EntryRule; member: EntryRuleMember }[] = [];
  const possible: { rule: EntryRule; needs: FactNeed[] }[] = [];
  let excludedByStay = 0;
  let excludedByPurpose = 0;
  let groupRelevant = 0;

  for (const rule of rules) {
    // ---- 1. who: the traveller is in the group, out of it, or we cannot tell ----
    let member: EntryRuleMember | null = null;
    const needs = new Set<FactNeed>();
    let couldBe = false;
    for (const m of rule.group.members) {
      const d = matchGroup(m, query.facts, ctx.onDate, ctx.membership);
      if (d.status === "match") {
        member = m;
        break;
      }
      if (d.status === "unknown") {
        couldBe = true;
        for (const n of d.needs) needs.add(n);
      }
    }
    // Out of the group (uncoded names are never decided by code): not about this traveller.
    if (!member && !couldBe) continue;
    groupRelevant++;

    // ---- 2. purpose: a stated purpose outside the rule's list means the rule does not cover the trip ----
    const purposes = effectivePurposes(rule);
    if (purposes) {
      if (query.purpose !== undefined && !purposes.includes(query.purpose)) {
        excludedByPurpose++;
        continue;
      }
      // A transit rule never answers a trip whose purpose was not given (it answers a transit only).
      if (query.purpose === undefined && TRANSIT_OUTCOMES.includes(rule.outcome)) {
        excludedByPurpose++;
        continue;
      }
    }

    // ---- 3. stay: a longer stay than the rule allows is not covered by it ----
    if (query.stayDays !== undefined && rule.maxStayDays !== undefined && query.stayDays > rule.maxStayDays) {
      excludedByStay++;
      continue;
    }

    if (member) matched.push({ rule, member });
    else possible.push({ rule, needs: [...needs] });
  }

  const possibleView = (p: { rule: EntryRule; needs: FactNeed[] }): EntryAnswerPossibleRule => ({
    ruleId: p.rule.id,
    outcome: p.rule.outcome,
    needs: needWords(p.needs),
    source: sourceOf(p.rule),
  });
  const possibleSorted = byStrictness(possible.map((p) => ({ ...possibleView(p), _needs: p.needs }))).map(({ _needs, ...rest }) => ({ rest, needs: _needs }));

  // ---- nothing matched for sure ----
  if (matched.length === 0) {
    if (possible.length > 0) {
      const allNeeds = [...new Set(possible.flatMap((p) => p.needs))];
      return unknown(query, ctx, "missing_fact", { needs: allNeeds, mightApply: possibleSorted.map((p) => p.rest) });
    }
    if (groupRelevant > 0 && excludedByStay > 0 && excludedByPurpose === 0) return unknown(query, ctx, "stay_not_covered");
    if (groupRelevant > 0 && excludedByPurpose > 0 && excludedByStay === 0) return unknown(query, ctx, "purpose_not_covered");
    // No rule is about this traveller at all (or the exclusions were mixed).
    return unknown(query, ctx, "no_rule");
  }

  // ---- a covering rule on a source we cannot vouch for: no answer ----
  if (matched.some((m) => !ctx.isFresh(m.rule))) return unknown(query, ctx, "stale");

  const rows: (EntryAnswerRule & { ruleId: string })[] = byStrictness(
    matched.map(({ rule, member }) => ({
      ruleId: rule.id,
      outcome: rule.outcome,
      stay: rule.maxStayDays !== undefined ? { maxDays: rule.maxStayDays, periodDays: rule.stayPeriodDays ?? null } : null,
      purposes: effectivePurposes(rule),
      conditions: conditionsOf(rule, member),
      authorisation: authorisationOf(rule),
      fee: ctx.feeView(rule),
      source: sourceOf(rule),
    }))
  );
  const strictest = rows[0];

  // ---- a STRICTER rule might apply if we knew more: never answer the looser one ----
  const stricterPossible = possibleSorted.filter((p) => strictnessRank(p.rest.outcome) < strictnessRank(strictest.outcome));
  if (stricterPossible.length > 0) {
    const allNeeds = [...new Set(stricterPossible.flatMap((p) => p.needs))];
    return unknown(query, ctx, "missing_fact", { needs: allNeeds, mightApply: possibleSorted.map((p) => p.rest) });
  }

  const strictestRule = matched.find((m) => m.rule.id === strictest.ruleId)!.rule;
  const disagree = new Set(rows.map((r) => r.outcome)).size > 1;
  return {
    status: "answer",
    destination: query.destination,
    outcome: strictest.outcome,
    message: answerMessage(strictestRule, disagree),
    stay: strictest.stay,
    conditions: strictest.conditions,
    sources: rows.map((r) => r.source),
    rules: rows,
    disagree,
    mightAlsoApply: possibleSorted.map((p) => p.rest),
    authorisation: strictest.authorisation,
  };
}
