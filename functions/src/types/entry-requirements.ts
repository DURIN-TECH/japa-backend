import type { Timestamp } from "firebase-admin/firestore";
import type { StoredApplicantGroup } from "./rubric";
import type { TravelPurpose } from "./eligibility";

// ============================================
// ENTRY REQUIREMENTS: "DO YOU NEED A VISA AT ALL" (issue #236, P7 of #228)
// ============================================
//
// Before an application starts, the app answers "do I need a visa for this
// destination?" from OFFICIAL SOURCES only. Each answer rests on stored entry
// rules (`entryRules/{ruleId}`), every one drafted from an official page with
// a verbatim quote and the page's URL. With no rule for the combination (or a
// rule older than the configured age) the answer is "unknown", with a plain
// reason and, when one is registered, a link to the destination authority's
// own page. Seli NEVER answers "you need a visa" or "you don't" by default.
//
// Generic by design: nothing here names a country, bloc, treaty or
// nationality. Codes and authority ids are data.

// ============================================
// Outcomes
// ============================================

/**
 * What an entry rule says about entering the destination:
 *  - `visa_required`         the group must hold a visa;
 *  - `visa_free`             the group may enter without a visa (within any stay limit);
 *  - `visa_on_arrival`       the group gets a visa at the border;
 *  - `travel_authorisation`  the group needs an electronic travel authorisation
 *                            (which is NOT a visa only when the source says so);
 *  - `transit_visa`          the group needs a visa to transit;
 *  - `transit_free`          the group may transit without a visa.
 */
export const ENTRY_OUTCOMES = [
  "visa_required",
  "visa_free",
  "visa_on_arrival",
  "travel_authorisation",
  "transit_visa",
  "transit_free",
] as const;
export type EntryOutcome = (typeof ENTRY_OUTCOMES)[number];

/**
 * Strictness order, MOST strict first. Where several rules match and disagree
 * ("visa free, but not for work"), the stricter outcome is shown first and the
 * others are listed after it. A visa is stricter than a travel authorisation,
 * which is stricter than nothing at all.
 */
export const ENTRY_OUTCOME_STRICTNESS: readonly EntryOutcome[] = [
  "visa_required",
  "transit_visa",
  "visa_on_arrival",
  "travel_authorisation",
  "transit_free",
  "visa_free",
];

/** Transit outcomes: they answer a transit only (the trip's purpose must be transit). */
export const TRANSIT_OUTCOMES: readonly EntryOutcome[] = ["transit_visa", "transit_free"];

// ============================================
// Stored rule
// ============================================

/**
 * The lifecycle of a stored rule:
 *  - `published`  part of the run that is served for its issuing authority
 *                 (only when `entryRuleHeads/{authorityId}.publishedRunId`
 *                 names its run: the head switch is the atomic publish);
 *  - `held`       drafted and checked, but its run was held by a safeguard
 *                 (visible to the admin, never served);
 *  - `left_out`   the independent check did not confirm it (never served);
 *  - `superseded` a later run was published in its place (kept as history).
 */
export const ENTRY_RULE_STATUSES = ["published", "held", "left_out", "superseded"] as const;
export type EntryRuleStatus = (typeof ENTRY_RULE_STATUSES)[number];

/**
 * Who a rule covers. Members are ALTERNATIVES ("nationals of A, or holders of
 * a valid B residence permit"): any one matching is enough. The same member
 * shapes as the rulebook groups of P5 (`StoredApplicantGroup`) plus the
 * `nationality` kind, decided by `services/ai/applicant-groups.ts`.
 *
 * `uncoded`: names the source gives that have no code (a nationality the
 * coder could not map, a status that is not a document kind). Kept verbatim,
 * never given an invented code, never dropped, and never decided by code.
 */
export interface EntryRuleGroup {
  members: EntryRuleMember[];
  uncoded: string[];
}

/** One coded member of a rule's group. */
export type EntryRuleMember = StoredApplicantGroup | { kind: "nationality"; code: string; asWritten: string };

/**
 * The countries a rule is about:
 *  - `countries`  the listed two-letter codes;
 *  - `members_of` every current member of the authority (a bloc or treaty),
 *                 resolved on the day of the lookup through the recorded
 *                 membership data (`authorities/{id}/members`).
 */
export type EntryDestinationScope =
  | { kind: "countries"; countryCodes: string[] }
  | { kind: "members_of"; authorityId: string };

/** A verbatim passage of the official source, with where it is. */
export interface EntryQuote {
  quote: string;
  url: string;
}

/**
 * A fee stated by the rule's source (a travel authorisation's charge, a visa
 * on arrival's fee): stored in the SOURCE currency with the quote it is in.
 * It is converted to USD only for display, at lookup time, through the
 * catalog's FX rules (`scrapers/visa-catalog/visa-catalog-fx.ts`).
 */
export interface EntryRuleFee {
  amount: number;
  // ISO 4217 code.
  currency: string;
  // The verbatim sentence the amount is printed in.
  quote: string;
}

/** `entryRules/{ruleId}`: one sourced entry rule. Backend-only. */
export interface EntryRule {
  id: string;
  // The authority that issues the rule (the destination country, or a bloc
  // or treaty for a shared rule). Authority ids: authorities/{id}.
  issuingAuthorityId: string;
  destination: EntryDestinationScope;
  // Denormalised for the lookup query (`array-contains`): the listed codes of
  // a `countries` scope, [] for `members_of`.
  destinationCodes: string[];
  // Denormalised: the scope's authority for `members_of`, null otherwise.
  scopeAuthorityId: string | null;
  outcome: EntryOutcome;
  group: EntryRuleGroup;
  // Longest stay the rule allows, in days, when the quote states one.
  maxStayDays?: number;
  // The rolling period the stay limit counts within ("90 days in any 180"), when stated.
  stayPeriodDays?: number;
  // Purposes the rule is limited to (closed list), when the quote limits it.
  purposes?: TravelPurpose[];
  // The authorisation's own name, exactly as the quote writes it (travel authorisation outcomes).
  authorisationName?: string;
  // The source's own statement that the authorisation is NOT a visa, with
  // its URL. Present only when the source says so (never written by code).
  notAVisa?: EntryQuote;
  // The official page where the traveller applies (an authorisation, a visa
  // on arrival). Only an address printed in the stored source; else absent
  // and the rule's own `url` is the official link.
  applyUrl?: string;
  fee?: EntryRuleFee;
  // Further verbatim conditions on the rule (each a passage of the source).
  conditions: string[];
  // The verbatim sentence the rule rests on, and the official page. REQUIRED:
  // a rule without both is refused by the store (entry-rule-validate.ts).
  quote: string;
  url: string;
  // When the rule's group is a printed list of names (an annex of
  // nationalities), the list lines exactly as the stored source has them,
  // in order, IN FULL (never capped for size).
  listItems?: string[];
  // Where the quote was checked: the guidance source and snapshot.
  sourceId: string;
  contentHash: string;
  // When the source page was fetched (ISO-8601): what staleness is measured from.
  fetchedAt: string;
  // When the rule was published (null until then, and for held / left out rules).
  publishedAt: Timestamp | null;
  status: EntryRuleStatus;
  // Why a rule was left out (the check's failed aspects), for the admin.
  leftOutReason?: string;
  // The drafting run that produced it (entryRuleRuns/{runId}).
  runId: string;
  promptVersion: string;
  checkPromptVersion: string;
  createdAt: Timestamp;
}

/** `entryRuleHeads/{authorityId}`: which run is served for an authority. */
export interface EntryRuleHead {
  authorityId: string;
  // The run whose `published` rules are served (null: none yet).
  publishedRunId: string | null;
  publishedAt: Timestamp | null;
  publishedRuleCount: number;
  // The latest run of any outcome, for the admin.
  lastRunId: string | null;
  lastRunStatus: EntryRuleRunStatus | null;
  // The official pages the authority's entry rules are drafted from: the
  // "destination authority's registered official page" an `unknown` answer
  // links to.
  sourceUrls: string[];
  updatedAt: Timestamp;
}

// ============================================
// Drafting runs (admin review data)
// ============================================

/** Outcome of a drafting run. */
export type EntryRuleRunStatus = "published" | "held" | "failed" | "dry_run";

/** A drafted rule code refused before it was stored (never served). */
export interface EntryRuleRefusal {
  reason: string;
  sourceId: string;
  // The quote the model gave, cut to 300 characters (backend-only record).
  quote: string;
}

/** `entryRuleRuns/{runId}`. Backend-only. */
export interface EntryRuleRun {
  id: string;
  authorityId: string;
  status: EntryRuleRunStatus;
  // Why the run was held or failed (reason codes), [] when published.
  reasons: string[];
  // Each gate's result.
  gates: { gate: string; passed: boolean; detail?: string }[];
  sourceIds: string[];
  promptVersion: string;
  checkPromptVersion: string;
  models: { drafting: string | null; check: string | null };
  // Spend, as the provider reported it.
  requests: { drafting: number; coding: number; check: number };
  inputChars: number;
  inputTokens: number;
  outputTokens: number;
  counts: {
    drafted: number;
    refused: number;
    kept: number;
    leftOut: number;
    listLines: number;
    uncodedNames: number;
  };
  refusals: EntryRuleRefusal[];
  // The rule ids written by this run (any status).
  ruleIds: string[];
  // UTC day the run started ("YYYY-MM-DD"), for the per-day cap.
  startedOn: string;
  startedAt: Timestamp;
  finishedAt: Timestamp;
  trigger: "script" | "test";
}

// ============================================
// The lookup answer (GET /entry-requirements)
// ============================================

/** One source line of an answer. */
export interface EntryAnswerSource {
  quote: string;
  url: string;
  // When the source page was fetched (ISO-8601).
  fetchedAt: string;
  // The list lines the rule's group was read from, when it is a list.
  listItems?: string[];
}

/** One condition of a rule, in plain words (code-written from stored, sourced fields). */
export interface EntryAnswerCondition {
  kind: "max_stay" | "purposes" | "holds" | "source_condition";
  text: string;
  // The verbatim passage, for a `source_condition`.
  quote?: string;
}

/** A fee as shown: the source amount and currency, plus USD when it converts. */
export interface EntryAnswerFee {
  amount: number;
  currency: string;
  quote: string;
  // Whole USD (null when no usable rate: never a guessed figure).
  usd: number | null;
  fxDate: string | null;
}

/** One matching rule in an answer. */
export interface EntryAnswerRule {
  ruleId: string;
  outcome: EntryOutcome;
  stay: { maxDays: number; periodDays: number | null } | null;
  purposes: TravelPurpose[] | null;
  conditions: EntryAnswerCondition[];
  authorisation: EntryAnswerAuthorisation | null;
  fee: EntryAnswerFee | null;
  source: EntryAnswerSource;
}

/**
 * A travel authorisation outcome's extra facts. `notAVisa` only when the
 * source says so (with its quote and URL). `seliApplies` is always false:
 * Seli does not run an application for an authorisation (FU-4).
 */
export interface EntryAnswerAuthorisation {
  name: string | null;
  notAVisa: EntryQuote | null;
  // The official page to apply on (the rule's own page when none is printed).
  applyUrl: string;
  seliApplies: false;
}

/** A rule that MIGHT also apply, if the traveller told us more. */
export interface EntryAnswerPossibleRule {
  ruleId: string;
  outcome: EntryOutcome;
  // What we would need to know, in plain words ("which visas or permits you hold").
  needs: string;
  source: EntryAnswerSource;
}

/** `status: "answer"`: at least one sourced rule covers the trip. */
export interface EntryRequirementAnswer {
  status: "answer";
  destination: string;
  // The STRICTEST matching outcome.
  outcome: EntryOutcome;
  // Plain words, always naming the source ("The official source says ...").
  message: string;
  // The strictest rule's stay limit.
  stay: { maxDays: number; periodDays: number | null } | null;
  // The strictest rule's conditions.
  conditions: EntryAnswerCondition[];
  // Every matching rule's source, strictest first.
  sources: EntryAnswerSource[];
  // Every matching rule, strictest first (the first decides `outcome`).
  rules: EntryAnswerRule[];
  // True when matching rules give different outcomes.
  disagree: boolean;
  // Rules that could change the answer if the traveller told us more.
  mightAlsoApply: EntryAnswerPossibleRule[];
  // Present on a travel authorisation answer (strictest rule).
  authorisation: EntryAnswerAuthorisation | null;
}

/** Why the answer is unknown (stable codes; the `reason` text explains). */
export type EntryUnknownCode =
  | "no_rule" // no published rule covers this destination and traveller
  | "missing_fact" // a rule might cover it, but we need a fact the traveller did not give
  | "stale" // a covering rule is older than the configured age
  | "stay_not_covered" // rules exist but none covers a stay this long
  | "purpose_not_covered"; // rules exist but none covers this purpose

/** `status: "unknown"`: no sourced answer. Never says "you need a visa" or "you don't". */
export interface EntryRequirementUnknown {
  status: "unknown";
  destination: string;
  code: EntryUnknownCode;
  // Plain words ("We don't have an official source for this yet.").
  reason: string;
  // The facts that would let us answer (missing_fact).
  needs?: string;
  // The destination authority's registered official page, when one exists.
  destinationAuthorityPage?: string;
  // Rules that might apply (missing_fact), with their sources.
  mightApply?: EntryAnswerPossibleRule[];
}

/** What GET /entry-requirements returns. */
export type EntryRequirementResult = EntryRequirementAnswer | EntryRequirementUnknown;
