import type { EntryCheckAspect, EntryVerdict } from "./entry-rule-prompt";
import type { DraftedRule } from "./entry-rule-draft";

// ============================================
// ENTRY RULES — AUTOMATIC PUBLISH SAFEGUARDS (issue #236, P7 of #228)
// ============================================
//
// Rules publish with NO human sign-off (the owner's decision for rulebooks,
// 2026-11-13, applied here too), so these code gates are the safeguard. The
// numbers and the kill switch are the RULEBOOK publisher's own settings
// (`appConfig/rubricPublishSettings`, rubric-publish-settings.ts), read the same
// way and failing CLOSED the same way:
//   - the publish mode must be exactly `auto` and the settings readable;
//   - the authority's entry key (`{authorityId}_entry-requirements`) must be
//     on the route allowlist when one is set;
//   - at least one rule must survive the checks;
//   - rules not served (code refusals + check leave-outs) may be at most
//     `maxLeftOutShare` of what was drafted (a draft that lost many rules is
//     held whole rather than served with holes);
//   - the new run must keep at least `minKeptShareOfServing` of the rules the
//     authority serves now (the shrink guard: a page that suddenly yields far
//     fewer rules is held, not published).
// A held run changes nothing for travellers: the run already served keeps
// serving.
//
// The check verdicts (one independent reader, closed answers) decide each
// rule: every aspect must be `yes`, except that `na` is accepted where the rule
// has nothing for that aspect to judge. Pure functions.

/** The key an authority's entry rules use on the publish allowlist. */
export function entryRuleKeyOf(authorityId: string): string {
  return `${authorityId}_entry-requirements`;
}

/** Is `na` an acceptable verdict for this aspect of this rule? */
export function naAllowed(aspect: EntryCheckAspect, rule: Pick<DraftedRule, "maxStayDays" | "purposes" | "authorisationName" | "fee" | "conditions" | "notAVisa" | "list">): boolean {
  switch (aspect) {
  case "details_right":
    return rule.maxStayDays === undefined && rule.purposes === undefined && rule.authorisationName === undefined && rule.fee === undefined && rule.conditions.length === 0;
  case "not_a_visa_right":
    return rule.notAVisa === undefined;
  case "list_complete":
    return rule.list === undefined;
  default:
    // outcome, group and "nothing missing" always have something to judge.
    return false;
  }
}

/** The aspects of a rule that did NOT pass ([] = the rule is confirmed). */
export function failedAspects(verdicts: Record<EntryCheckAspect, EntryVerdict> | undefined, rule: Parameters<typeof naAllowed>[1]): string[] {
  if (!verdicts) return ["not_answered"];
  return (Object.keys(verdicts) as EntryCheckAspect[]).filter((a) => !(verdicts[a] === "yes" || (verdicts[a] === "na" && naAllowed(a, rule))));
}

/** What the gates are given. */
export interface EntryGateInput {
  authorityId: string;
  drafted: number;
  refused: number;
  kept: number;
  leftOut: number;
  servedNow: number;
  settings: {
    readError?: string;
    mode: string;
    routeAllowlist?: string[];
    maxLeftOutShare: number;
    minKeptShareOfServing: number;
  };
}

/** One gate's result. */
export interface EntryGateResult {
  gate: string;
  passed: boolean;
  detail?: string;
}

/** Run every gate; the run publishes only when all pass. */
export function evaluateEntryGates(input: EntryGateInput): { gates: EntryGateResult[]; reasons: string[] } {
  const gates: EntryGateResult[] = [];
  const s = input.settings;
  gates.push({ gate: "settings_readable", passed: !s.readError, ...(s.readError ? { detail: s.readError } : {}) });
  gates.push({ gate: "publish_mode_auto", passed: s.mode === "auto", detail: `mode ${s.mode}` });
  const key = entryRuleKeyOf(input.authorityId);
  const allowed = s.routeAllowlist === undefined || s.routeAllowlist.includes(key);
  gates.push({ gate: "route_allowed", passed: allowed, detail: key });
  gates.push({ gate: "rules_kept", passed: input.kept > 0, detail: `${input.kept} kept` });
  const notServed = input.refused + input.leftOut;
  const share = input.drafted > 0 ? notServed / input.drafted : 0;
  gates.push({ gate: "leave_out_budget", passed: share <= s.maxLeftOutShare, detail: `${notServed} of ${input.drafted} not served (${input.refused} refused by code, ${input.leftOut} not confirmed by the check); limit ${s.maxLeftOutShare}` });
  const need = Math.ceil(s.minKeptShareOfServing * input.servedNow);
  gates.push({ gate: "shrink_guard", passed: input.servedNow === 0 || input.kept >= need, detail: `${input.kept} kept, ${input.servedNow} served now, at least ${need} needed` });
  const reasons = gates.filter((g) => !g.passed).map((g) => g.gate);
  return { gates, reasons };
}
