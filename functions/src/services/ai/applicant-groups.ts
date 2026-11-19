/**
 * Applicant groups (issue #234, P5 of #228): the PURE half that decides, in
 * code, whether an applicant is in a rule's group ("nationals of X", "people
 * who live in X", "holders of a valid X permit", "citizens of any member of
 * X"), from what the applicant HOLDS. No Firebase, no model, no clock (the
 * caller passes the date).
 *
 * WHERE THE FACTS COME FROM. The application's copy of the applicant's
 * holdings (`Application.applicantFacts`, taken when the application started),
 * never the live profile. Applications started before #234 have no copy; for
 * those (dev data only) the caller passes the latest eligibility check's
 * nationality through `factsFromNationality`.
 *
 * NEVER GUESS. Every decision has three outcomes and no fourth:
 *   - `match`     the applicant is in the group;
 *   - `no_match`  the applicant's stated facts put them outside it;
 *   - `unknown`   a fact the group needs is not stated (or, for `members_of`,
 *                 the authority has no recorded members): "could not be
 *                 assessed: we need to know your nationality". It is never
 *                 read as "in the group" nor as "not in the group".
 * An expired held document never matches (it is not "unknown" either: the
 * applicant has told us what they hold).
 *
 * Generic by design: nothing here names a country, nationality, bloc or
 * route. Codes and authority ids are data in the rulebook and the profile.
 */
import type { AssessmentCriterion, CriterionAppliesTo, FactTrigger, StoredApplicantGroup } from "../../types/rubric";
import type { ApplicantFacts, HeldDocument } from "../../types/applicant-facts";
import { isValidFactTrigger, parseHoldsValue } from "../../utils/rubric-trigger";

// ============================================
// Inputs
// ============================================

/** The held-document fields rule matching reads (never the applicant's note). */
export type HeldDocumentFact = Pick<HeldDocument, "kind" | "issuerCountryCode" | "issuerAuthorityId" | "validUntil">;

/**
 * The facts rules are decided from. Same "not stated" conventions as
 * `ApplicantFacts`: `nationalities: []` and `residentialCountry: null` are
 * "not stated"; `heldDocuments: null` is "never stated", `[]` is "none".
 */
export interface FactsForRules {
  nationalities: readonly string[];
  residentialCountry: string | null;
  heldDocuments: readonly HeldDocumentFact[] | null;
}

/** No fact stated at all (an applicant we know nothing about). */
export const NO_FACTS: FactsForRules = { nationalities: [], residentialCountry: null, heldDocuments: null };

/**
 * Membership of each authority a rulebook's `members_of` groups name, ON the
 * application's start date: authority id -> the member country codes current
 * on that date. `null` (or a missing key) means the authority has NO recorded
 * members (or does not exist): "could not tell", never "nobody". An empty list
 * means members are recorded but none is current on that date.
 */
export type MembershipOnDate = Readonly<Record<string, readonly string[] | null>>;

/** Two upper-case letters (the only form a code fact is compared in). */
const CODE_RE = /^[A-Z]{2}$/;

/** The facts on an application's copy, as rule matching reads them. */
export function factsFromApplicantFacts(facts: Pick<ApplicantFacts, "nationalities" | "residentialCountry" | "heldDocuments">): FactsForRules {
  return {
    nationalities: (facts.nationalities ?? []).filter((n) => CODE_RE.test(n)),
    residentialCountry: facts.residentialCountry && CODE_RE.test(facts.residentialCountry) ? facts.residentialCountry : null,
    heldDocuments: Array.isArray(facts.heldDocuments) ? facts.heldDocuments : null,
  };
}

/**
 * (Fallback, applications started before #234: dev data only) the one
 * nationality the latest eligibility check holds. Nothing else is known, so
 * residence and held documents are "not stated".
 */
export function factsFromNationality(nationality: string | null): FactsForRules {
  return { nationalities: nationality && CODE_RE.test(nationality) ? [nationality] : [], residentialCountry: null, heldDocuments: null };
}

// ============================================
// Groups: the stored shape read as one list
// ============================================

/** One member of a bar's group, as code reads it (the stored kinds plus `nationality`). */
export type ApplicantGroup = StoredApplicantGroup | { kind: "nationality"; code: string; asWritten: string };

/**
 * Every CODED member of a bar's group as one list. The stored
 * `appliesTo.nationalities` / `asWritten` (the shape since #42, which every
 * approved rulebook on dev uses) are read as `nationality` members, so an old
 * version works with no rewrite; `appliesTo.groups` (#234) follow. Uncoded
 * members (`appliesTo.uncoded`) have no code and are never here: code never
 * decides them (they go to the assessment model, `judgementCriteriaOf`).
 */
export function groupsOf(appliesTo: CriterionAppliesTo | undefined): ApplicantGroup[] {
  if (!appliesTo) return [];
  const nationalities = Array.isArray(appliesTo.nationalities) ? appliesTo.nationalities : [];
  const asWritten = Array.isArray(appliesTo.asWritten) ? appliesTo.asWritten : [];
  const out: ApplicantGroup[] = nationalities.map((code, i) => ({ kind: "nationality" as const, code, asWritten: asWritten[i] ?? "" }));
  for (const g of Array.isArray(appliesTo.groups) ? appliesTo.groups : []) out.push(g);
  return out;
}

// ============================================
// Matching
// ============================================

/** Which fact a decision is missing, in the words the applicant is shown. */
export type FactNeed = "nationality" | "residence" | "holds" | "membership";

/** The plain words of each need ("could not be assessed: we need to know ..."). */
export const FACT_NEED_WORDS: Record<FactNeed, string> = {
  nationality: "your nationality",
  residence: "which country you live in",
  holds: "which visas or permits you hold",
  membership: "which countries belong to the group this rule names (we have no record of its members yet)",
};

/** The outcome of one group (or one trigger) for one applicant. */
export type GroupDecision = { status: "match" } | { status: "no_match" } | { status: "unknown"; needs: FactNeed[] };

/**
 * Is a held document still valid ON `onDate` ("YYYY-MM-DD")? Valid through its
 * `validUntil` day inclusive. Plain string comparison is date order for the
 * validated "YYYY-MM-DD" form; anything else is treated as not valid.
 */
export function isHeldDocumentValidOn(doc: Pick<HeldDocumentFact, "validUntil">, onDate: string): boolean {
  return typeof doc.validUntil === "string" && /^\d{4}-\d{2}-\d{2}$/.test(doc.validUntil) && doc.validUntil >= onDate;
}

/**
 * Does the applicant hold a VALID document of this kind from this issuer?
 * The issuer is matched exactly as recorded (a country code against
 * `issuerCountryCode`, an authority id against `issuerAuthorityId`): no
 * widening of a country to its bloc or of a bloc to its members.
 */
function holdsMatch(docs: readonly HeldDocumentFact[], document: string, issuer: string, onDate: string): boolean {
  return docs.some(
    (d) => d.kind === document && isHeldDocumentValidOn(d, onDate) && (d.issuerCountryCode === issuer || d.issuerAuthorityId === issuer)
  );
}

/**
 * Decide ONE group member for one applicant.
 *
 * @param onDate the date the rule is checked on (held documents must be valid on it)
 * @param membership members of each named authority on the application's start date
 */
export function matchGroup(group: ApplicantGroup, facts: FactsForRules, onDate: string, membership: MembershipOnDate): GroupDecision {
  switch (group.kind) {
  case "nationality":
    // Several nationalities: any one of them counts.
    if (facts.nationalities.length === 0) return { status: "unknown", needs: ["nationality"] };
    return facts.nationalities.includes(group.code) ? { status: "match" } : { status: "no_match" };
  case "residence":
    if (!facts.residentialCountry) return { status: "unknown", needs: ["residence"] };
    return facts.residentialCountry === group.code ? { status: "match" } : { status: "no_match" };
  case "holds":
    if (facts.heldDocuments === null) return { status: "unknown", needs: ["holds"] };
    return holdsMatch(facts.heldDocuments, group.document, group.issuer, onDate) ? { status: "match" } : { status: "no_match" };
  case "members_of": {
    // The fact first: without it, the membership list cannot help.
    const values = group.fact === "nationality" ? facts.nationalities : facts.residentialCountry ? [facts.residentialCountry] : [];
    if (values.length === 0) return { status: "unknown", needs: [group.fact === "nationality" ? "nationality" : "residence"] };
    const members = membership[group.authorityId];
    // No recorded members (or an unknown authority): could not tell, never "nobody".
    if (members === null || members === undefined) return { status: "unknown", needs: ["membership"] };
    return values.some((v) => members.includes(v)) ? { status: "match" } : { status: "no_match" };
  }
  default:
    // A stored group of a kind this code does not know: never decided.
    return { status: "unknown", needs: [] };
  }
}

/**
 * Decide a whole group (the members are alternatives: "nationals of A, or
 * holders of a B permit"). Any member matching is a match; otherwise any
 * member that could not be decided makes the whole group unknown (the
 * applicant might be in it through that member); otherwise no match.
 */
export function decideGroups(groups: readonly ApplicantGroup[], facts: FactsForRules, onDate: string, membership: MembershipOnDate): GroupDecision {
  const needs = new Set<FactNeed>();
  let unknown = false;
  for (const g of groups) {
    const d = matchGroup(g, facts, onDate, membership);
    if (d.status === "match") return d;
    if (d.status === "unknown") {
      unknown = true;
      for (const n of d.needs) needs.add(n);
    }
  }
  return unknown ? { status: "unknown", needs: [...needs] } : { status: "no_match" };
}

/**
 * Decide a fact trigger (`criterion.factTrigger`). The values are
 * alternatives, like a group's members. Same three outcomes. An unusable
 * trigger is reported as `unknown` with no need (the caller treats it like a
 * damaged question trigger).
 */
export function decideFactTrigger(trigger: FactTrigger | undefined, facts: FactsForRules, onDate: string): GroupDecision {
  if (!isValidFactTrigger(trigger)) return { status: "unknown", needs: [] };
  const groups: ApplicantGroup[] = trigger.anyOf.map((v): ApplicantGroup => {
    if (trigger.fact === "holds") {
      const h = parseHoldsValue(v) as NonNullable<ReturnType<typeof parseHoldsValue>>;
      return { kind: "holds", document: h.document, issuer: h.issuer, asWritten: v };
    }
    return trigger.fact === "nationality" ? { kind: "nationality", code: v, asWritten: v } : { kind: "residence", code: v, asWritten: v };
  });
  return decideGroups(groups, facts, onDate, {});
}

/** "could not be assessed" words for a set of needs (the first need, or a fixed phrase). */
export function needWords(needs: readonly FactNeed[]): string {
  if (needs.length === 0) return "whether this rule applies to your application";
  return needs.map((n) => FACT_NEED_WORDS[n]).join(" and ");
}

// ============================================
// What a rulebook needs (membership loads, facts sent to the model)
// ============================================

/** The authority ids a rulebook's `members_of` groups name (sorted, unique): what the caller must load. */
export function membershipAuthorityIdsOf(criteria: readonly Pick<AssessmentCriterion, "appliesTo">[]): string[] {
  const ids = new Set<string>();
  for (const c of criteria) {
    for (const g of c.appliesTo?.groups ?? []) if (g.kind === "members_of" && typeof g.authorityId === "string") ids.add(g.authorityId);
  }
  return [...ids].sort();
}

/** Which kinds of fact a rulebook's rules read: drives what the assessment model is shown. */
export function factKindsReadBy(criteria: readonly Pick<AssessmentCriterion, "appliesTo" | "factTrigger">[]): Set<"nationality" | "residence" | "holds"> {
  const kinds = new Set<"nationality" | "residence" | "holds">();
  for (const c of criteria) {
    for (const g of groupsOf(c.appliesTo)) {
      if (g.kind === "members_of") kinds.add(g.fact);
      else kinds.add(g.kind);
    }
    if (c.factTrigger && isValidFactTrigger(c.factTrigger)) kinds.add(c.factTrigger.fact);
  }
  return kinds;
}

/**
 * The applicant-facts line of the assessment model's profile summary. KEPT TO
 * WHAT THE RULES NEED (privacy, #234):
 *   - nationality codes: always (the assessment has always been told the
 *     applicant's nationality; now every stated one), or "not given";
 *   - the country of residence code: only when an applicable rule reads it
 *     (a `residence` group, a `members_of` group on residence, a residence
 *     fact trigger) or a bar the model judges exists (`judgedBarPresent`: its
 *     uncoded members may name a residence);
 *   - held documents: only when an applicable rule reads them (a `holds`
 *     group or trigger) or a judged bar exists; only documents VALID on the
 *     date, as kind + issuer code/id + valid-until date. The applicant's own
 *     note is NEVER sent.
 * Every value is a validated code, id, enum or date (never free text).
 */
export function factsSummaryForModel(
  facts: FactsForRules,
  criteria: readonly Pick<AssessmentCriterion, "appliesTo" | "factTrigger">[],
  onDate: string,
  judgedBarPresent: boolean
): string {
  const kinds = factKindsReadBy(criteria);
  const parts: string[] = [];
  parts.push(facts.nationalities.length > 0 ? `Nationality code(s): ${facts.nationalities.join(", ")}.` : "Nationality code(s): not given.");
  if (kinds.has("residence") || judgedBarPresent) {
    parts.push(`Country of residence code: ${facts.residentialCountry ?? "not given"}.`);
  }
  if (kinds.has("holds") || judgedBarPresent) {
    if (facts.heldDocuments === null) parts.push("Valid visas and permits held: not given.");
    else {
      const valid = facts.heldDocuments.filter((d) => isHeldDocumentValidOn(d, onDate));
      parts.push(
        valid.length === 0
          ? "Valid visas and permits held: none stated."
          : `Valid visas and permits held: ${valid.map((d) => `${d.kind} issued by ${d.issuerCountryCode ?? d.issuerAuthorityId ?? "unknown issuer"}, valid until ${d.validUntil}`).join("; ")}.`
      );
    }
  }
  return parts.join(" ");
}
