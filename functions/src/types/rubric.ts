import type { Timestamp } from "firebase-admin/firestore";

// ============================================
// VISA RUBRIC — TYPES (issue #40)
// ============================================
//
// A RUBRIC is published caseworker guidance turned into data: a list of
// assessment criteria, each one tied to the exact sentence of the source it
// came from, tagged by decision stage and by WHO is allowed to decide it
// (code, or a reasoning model whose output is only ever a concern, never a
// refusal). The assessment engine (#42), the intake screen (#113), the
// document checklist (#114) and the review tools (#125, #41) all read this
// one shape.
//
// Generic by design: a route is DATA, keyed by `countryCode` + `visaTypeId`.
// Nothing in this file (or in the validator and extractor built on it) names a
// country, a route, a publisher or a nationality.
//
// (#233, P4 of #228) A rulebook is owned by an ISSUING AUTHORITY: its key is
// `{authorityId}_{routeSlug}` (see authorities/authority-ids.ts). For a
// COUNTRY authority that is exactly today's `{countryCode}_{visaTypeId}`, so
// every stored rulebook keeps its key and nothing moves. For a BLOC or TREATY
// authority the key is `{issuingAuthorityId}_{sharedRouteId}` (a shared route,
// types/shared-route.ts) and the document carries NO `countryCode` /
// `visaTypeId`: there is no single country. Documents written since #233 carry
// `authorityId` + `routeSlug`; documents written before only carry
// `countryCode` + `visaTypeId`, and every read fills the two new fields in
// from them (rubric-key.ts `rulebookPartsOf`, applied by the store), so old
// documents read unchanged without any data move.
//
// Storage (all backend-only: no firestore.rules match, so client SDKs are
// denied; see scrapers/rubric/rubric.store.ts):
//
//   visaRubrics/{countryCode}_{visaTypeId}                    RubricHead
//   visaRubrics/{routeKey}/rubricVersions/{version}           VisaRubric
//   rubricExtractionRuns/{runId}                              RubricExtractionRun
//   rubricPublishRuns/{routeKey}__v{version}                  RubricPublishRun (#201)
//   rubricPublishSettingsHistory/{auto id}                    settings change audit (#201)
//
// A head doc plus a versions subcollection, so an APPROVED version can keep
// serving while a newer PENDING one waits for review (#125 needs both at
// once). A version document's content is immutable once written: a new
// extraction always makes a new version.
//
// Pure module: types and constant lists only. No Firebase call, no SDK.

/** Version of the stored rubric shape. Bump when a field changes meaning. */
export const RUBRIC_SCHEMA_VERSION = 1;

// ============================================
// Enumerations
// ============================================

/**
 * WHO decides a criterion. This is the containment boundary (#42):
 *  - `mandatory_bar`: a hard bar that applies to a stated group (for example
 *    holders of listed nationalities, between stated dates). Decided by CODE
 *    from the applicant's profile, with zero model calls.
 *  - `objective`: a rule with a machine-checkable `check`. Decided by CODE:
 *    a model may READ a value out of a document, but code compares it.
 *  - `judgement`: a matter of weighing evidence (credibility, genuineness).
 *    A model reasons over it using `probeFactors`; the result can only ever
 *    be a credibility flag, never a refusal ground. That is why a judgement
 *    criterion must NOT carry a `check`.
 */
export const CRITERION_KINDS = ["objective", "mandatory_bar", "judgement"] as const;
export type CriterionKind = (typeof CRITERION_KINDS)[number];

/**
 * The stage of the decision a criterion belongs to, in the order a
 * caseworker applies them. The ORDER IS PART OF THE CONTRACT, and so is what
 * failing each stage means, because the wording shown to an applicant
 * depends on it:
 *
 *  1. `validity`    — is this a valid application at all (right form, fee,
 *                     identity document). Failing validity is NOT A REFUSAL:
 *                     the application is not considered, and can be made
 *                     again. Never describe it to an applicant as a refusal.
 *  2. `suitability` — grounds on which an applicant is refused whatever the
 *                     merits (conduct, history, deception). Failing
 *                     suitability IS A REFUSAL.
 *  3. `eligibility` — the route's own requirements. Failing is a refusal.
 *  4. `credibility` — whether the decision maker believes the account given.
 *                     Usually `judgement` criteria: a concern, not a ground.
 */
export const DECISION_STAGES = ["validity", "suitability", "eligibility", "credibility"] as const;
export type DecisionStage = (typeof DECISION_STAGES)[number];

/**
 * Review state of one rubric VERSION. Extraction only ever writes
 * `pending_review`. A version moves on through the ONE approval transaction
 * (rubric-review.service.ts), run either by an admin (#125) or, when
 * `appConfig/rubricPublishSettings.mode` is `auto`, by the named system actor
 * after the automatic gates pass (#201). Extraction itself never publishes.
 */
export const RUBRIC_REVIEW_STATUSES = ["pending_review", "approved", "rejected"] as const;
export type RubricReviewStatus = (typeof RUBRIC_REVIEW_STATUSES)[number];

/**
 * How the route treats an intention to stay beyond the visit / to settle:
 *  - `immigrant_intent_penalised`: showing such an intention counts AGAINST
 *    the applicant;
 *  - `dual_intent_permitted`: it does not (the route allows a temporary stay
 *    alongside a longer-term intention);
 *  - `not_assessed`: the route's guidance does not make intention a factor.
 *
 * It exists because a general-purpose model gets this backwards about half
 * the time. So it is DECLARED BY THE RUBRIC and decided by an admin at
 * approval; the model is never asked to infer it at assessment time.
 */
export const INTENT_POLARITIES = ["immigrant_intent_penalised", "dual_intent_permitted", "not_assessed"] as const;
export type IntentPolarity = (typeof INTENT_POLARITIES)[number];

/**
 * Operators of an objective check:
 *  - gte / lte / eq: compare the read value with `value`;
 *  - present:        the field must exist (no `value`);
 *  - heldForDays:    the field's condition must have held for a period;
 *                    `value` + `unit` give the period AS THE SOURCE WRITES IT
 *                    (the engine converts to days; the extractor never does
 *                    arithmetic, so no derived number can be invented).
 */
export const CHECK_OPS = ["gte", "lte", "eq", "present", "heldForDays"] as const;
export type CheckOp = (typeof CHECK_OPS)[number];

/** Units a duration may be written in. */
export const DURATION_UNITS = ["days", "weeks", "months", "years"] as const;
export type DurationUnit = (typeof DURATION_UNITS)[number];

/**
 * Default severity scale, most severe first. A rubric DECLARES its scale in
 * `severityLevels`; each criterion's `severity` is one of those values. The
 * free tier of #42 picks its top three issues in code by this order (ties
 * broken by the order of `criteria`).
 */
export const DEFAULT_SEVERITY_LEVELS = ["critical", "high", "medium", "low"] as const;

/** Whose document or answer something is. */
export const EVIDENCE_PARTIES = ["applicant", "sponsor"] as const;
export type EvidenceParty = (typeof EVIDENCE_PARTIES)[number];

/**
 * Answer types the intake renderer (#113) supports. `answerType` is stored as
 * a plain string so a rubric can carry a type a client does not know yet:
 * clients must degrade safely on an unknown type (the validator only warns).
 */
export const INTAKE_ANSWER_TYPES = [
  "single_choice",
  "multi_choice",
  "yes_no",
  "date",
  "date_range",
  "text",
  "amount", // an amount with a currency
] as const;
export type IntakeAnswerType = (typeof INTAKE_ANSWER_TYPES)[number];

// ============================================
// Criterion
// ============================================

/**
 * Where a criterion (or an evidence item, or the polarity proposal) comes
 * from. EVERY field except `quote` is set by code from the snapshot the quote
 * was validated against; none is taken from the model.
 */
export interface RubricCitation {
  // The exact words of the source, verbatim: the passage as the STORED
  // SNAPSHOT has it (whitespace collapsed to single spaces), not the model's
  // copy of it. The model's quote is only used to find it: it must match
  // verbatim (whitespace-normalised, no fuzzy matching), start and end on a
  // word boundary, and sit within one page / one paragraph. A criterion whose
  // quote is not found never reaches Firestore.
  quote: string;
  // Guidance source the quote is in (`guidanceSources/{sourceId}`).
  sourceId: string;
  // The document's URL after redirects (what a reviewer opens).
  url: string;
  // sha256 of the snapshot text the quote was validated against. Lets #125
  // tell a reviewer when the live source no longer contains the quote.
  contentHash: string;
  // 1-based page the quote is on. PDFs only; a quote must sit within one page.
  page?: number;
  // When that snapshot was fetched (ISO-8601).
  retrievedAt: string;
  // The publisher's own date for the document (YYYY-MM-DD), when it gave one.
  publishedDate?: string;
  // (#222) Set only when `quote` is the LEAD-IN of a list ("... except where
  // they are subject to any of the following:"): the list lines that directly
  // follow it in the stored snapshot, in order, each one a WHOLE LINE of that
  // snapshot, verbatim (list marker included). Attached by CODE, never written
  // by the model, and each line is checked against the snapshot as its own line
  // (the quote validator cannot span lines). The rule's full text is the quote
  // plus these items. Absent for every other rule and for versions stored
  // before #222 (additive, optional).
  listItems?: string[];
}

/**
 * The machine-checkable rule of an `objective` criterion. The extractor
 * emits the RULE and the FIELD to read; it never emits a verdict. Application
 * code evaluates it (#42).
 */
export interface CriterionCheck {
  // Dotted name of the fact to read (from the profile, the intake answers or
  // a document extraction), e.g. "funds.balance". Free text: #42 owns the
  // field catalogue.
  field: string;
  op: CheckOp;
  // The threshold / expected value. Absent for `present`. For `gte`, `lte`
  // and `heldForDays` it is always a NUMBER, and that number is written in
  // the criterion's OWN quote (outside any date in it). For `eq` it may be a
  // number (same rule), a boolean, or a string found verbatim in the quote.
  // Supporting `citations` never widen this: only `source.quote` counts.
  value?: number | string | boolean;
  // Unit of `value` exactly as the criterion's own quote writes it (a
  // duration unit, a currency code, ...).
  unit?: string;
}

/** The group a `mandatory_bar` applies to. */
export interface CriterionAppliesTo {
  // ISO 3166-1 alpha-2 codes. PROPOSED by extraction from `asWritten`,
  // confirmed by the reviewer; the engine matches the applicant's
  // nationality against this list.
  nationalities: string[];
  // The same group exactly as the source names it, one entry per code (the
  // two arrays are parallel), each found in the criterion's own quote as a
  // whole name. This is what makes the mapping to codes checkable by a human.
  asWritten: string[];
  // The platform's display name (English) for each code, parallel to
  // `nationalities`, filled in by code. A reviewer aid: when it differs from
  // the matching `asWritten` entry the version carries a flag for this
  // criterion. The codes are a model PROPOSAL either way and every one must
  // be confirmed by the reviewer.
  codeNames?: string[];
  // (#222) Members of the group that are NOT a nationality ("people with right
  // of abode"), each exactly as the source's own quote names it and found in
  // that quote as a whole name. They have NO code: none is ever made up for
  // them, and they are never in `nationalities` / `asWritten` (those stay
  // parallel, for real nationalities only). A bar needs at least one coded or
  // uncoded member. Absent on versions stored before #222 (additive, optional).
  uncoded?: string[];
}

/**
 * (#207) The machine-readable form of a criterion's applicability condition:
 * the rule applies when the applicant's answer to intake question
 * `questionId` is one of `anyOf` (option values of that question). The
 * condition's own words stay in `applicabilityCondition`, verbatim.
 */
export interface RuleTrigger {
  questionId: string;
  anyOf: string[];
}

/** One criterion of a rubric. */
export interface AssessmentCriterion {
  // Stable id, derived in code from the source id, the normalised quote, the
  // kind and the checked field. The same rule text yields the same id in
  // every version, so #125 can diff two versions by id (a rule whose text
  // changed shows as removed + added; pair those by `ruleRef`).
  criterionId: string;
  // Short applicant-readable name. The free tier (#42) serves
  // `{ criterionId, title }` and nothing else, so it must stand on its own.
  title: string;
  kind: CriterionKind;
  stage: DecisionStage;
  // One of the rubric's `severityLevels`.
  severity: string;
  // The publisher's own reference for the rule (paragraph or section number),
  // as printed. Must appear in the source text. Optional: not every source
  // numbers its rules.
  ruleRef?: string;
  source: RubricCitation;

  // ---- kind-specific ----
  // objective only (required there, forbidden on a judgement criterion).
  check?: CriterionCheck;
  // mandatory_bar only (required there).
  appliesTo?: CriterionAppliesTo;
  // mandatory_bar: the dates the bar runs between (YYYY-MM-DD), mirroring
  // VisaExemption.validFrom / validUntil. Each must be supported by a quote.
  validFrom?: string;
  validUntil?: string;
  // judgement only: the factors the guidance tells a decision maker to weigh.
  probeFactors?: string[];
  // judgement only: the guidance says the applicant should be interviewed
  // (or asked) before a refusal on this point.
  requiresInterviewBeforeRefusal?: boolean;

  // ---- joins ----
  // The criterion is about the applicant's intention to leave / to stay. Set
  // by extraction, editable in review. A rubric with such a criterion but no
  // polarity is flagged by the validator.
  concernsIntent?: boolean;
  // Scope (#112, #207): does the rule apply to every applicant on the route,
  // or only in some circumstances? `applicabilityCondition` is those
  // circumstances in the source's words, found verbatim in the source.
  // Four values (see CRITERION_APPLICABILITIES): `all_applicants`,
  // `conditional` and `specialist` are stored (#207: a specialist-activity
  // rule is KEPT, however long that makes the rulebook; it applies only to
  // applicants its condition covers). `other_route` is proposed by the model
  // and dropped in code (with a discard record): it is about a different route.
  applicability?: "all_applicants" | "conditional" | "specialist" | "other_route";
  applicabilityCondition?: string;
  // (#207) WHEN the rule applies, in a form code can evaluate: "this rule
  // applies when the applicant's answer to intake question `questionId` is one
  // of `anyOf`" (for a multi-choice question: includes any of them). Set by
  // extraction only after code has checked that the question exists in the
  // rubric and that every value is one of its options. Absent on a
  // `specialist` rule = "could not tell whether this applies" (the rule is
  // kept, and an assessment reports it as not assessable, never as failed and
  // never as applying to everyone). See services/ai/rule-applicability.ts.
  trigger?: RuleTrigger;
  // (#248) SERVED-SIDE ONLY, never stored on a version and never extracted: set by
  // `applyExclusions` (rubric-exclusions.ts) on a mandatory bar that is served WITHOUT
  // its trigger because the independent check could not confirm the trigger (the
  // rule itself was confirmed by both models). It means "never decide this rule in
  // code": `mandatoryBarHits` skips it, `judgementCriteriaOf` puts it, in full, to the
  // assessment model, and `resolveApplicability` puts it to every applicant (the model
  // reads its condition words). Why: removing a trigger widens who a rule is put to;
  // a bar that code decided from nationality would then bar EVERY applicant of that
  // nationality, including ones its condition does not cover. Derived from the
  // version's own review fields on every read, so the same stored version always
  // gives the same served rule; a stored value is ignored and stripped.
  notCodeDecided?: true;
  // (#233) SERVED-SIDE ONLY, never stored on a version: set by the stack merge
  // (scrapers/rubric/rubric-stack.ts) on a rulebook STACK of more than one layer,
  // naming the rulebook key of the layer this item came from. Absent on a
  // single-layer rulebook (every route without inheritance), so those read
  // exactly as before.
  layerKey?: string;
  // Links to an existing EligibilityQuestion (types/eligibility.ts).
  eligibilityQuestionId?: string;
  // Ids of the rubric's intake questions whose answers this criterion reads.
  intakeQuestionIds?: string[];

  // ---- extraction quality ----
  // Extra passages the extractor pointed at for single fields (keys are
  // RUBRIC_CITATION_FIELDS), each found verbatim in the same source. REVIEWER
  // AIDS ONLY: a number, unit, date or group is checked against
  // `source.quote` alone, never against these.
  citations?: Record<string, string>;
  // The extractor's confidence in its own reading, 0..1. A review aid only:
  // nothing is accepted or rejected on it.
  confidence: number;
}

// ============================================
// Intake questions (#113)
// ============================================

/** One selectable option of a choice question. */
export interface IntakeOption {
  value: string;
  label: string;
  description?: string;
}

/** One "show this question when..." condition. */
export interface IntakeCondition {
  questionId: string;
  op: "eq" | "neq" | "in";
  value: string | number | boolean | string[];
}

/** A question the route needs answered before it can be assessed. */
export interface IntakeQuestion {
  id: string;
  label: string;
  helpText?: string;
  // See INTAKE_ANSWER_TYPES; unknown values must degrade safely in clients.
  answerType: string;
  required: boolean;
  // The criteria that read the answer. At least one: a question no criterion
  // reads has no reason to be asked.
  criterionIds: string[];
  // Optional heading the question is listed under.
  group?: string;
  // Whose details the question asks for. A sponsor's full name is
  // `{ answerType: "text", party: "sponsor" }` (#113, #115).
  party?: EvidenceParty;
  // Choice questions.
  options?: IntakeOption[];
  // Date questions: ISO bounds, and/or a bound relative to "today".
  dateLimits?: { min?: string; max?: string; relativeToToday?: "past_only" | "future_only" };
  // Free-text questions.
  textLimits?: { minLength?: number; maxLength?: number };
  // Shown when ANY of these conditions holds (always shown when absent).
  showWhen?: { anyOf: IntakeCondition[] };
  // date_range questions: the longest allowed range, in days (#113). Optional:
  // the renderer and validator degrade safely when it is absent.
  maxLengthDays?: number;
  // (#233) SERVED-SIDE ONLY, never stored on a version: set by the stack merge
  // (scrapers/rubric/rubric-stack.ts) on a rulebook STACK of more than one layer,
  // naming the rulebook key of the layer this item came from. Absent on a
  // single-layer rulebook (every route without inheritance), so those read
  // exactly as before.
  layerKey?: string;
  // amount questions: the allowed ISO 4217 codes (#113). Any code when absent.
  currencies?: string[];
}

/** Headings of the intake section as a whole. */
export interface IntakeMeta {
  title?: string;
  cardTitle?: string;
  intro?: string;
}

// ============================================
// Evidence declarations (#114) and outcome statistics (#116)
// ============================================

/**
 * A document that evidences one or more criteria, and whose it is. The
 * checklist builder (#114) turns these into document requests in code.
 */
export interface EvidenceItem {
  // Stable key within the rubric (lowercase letters, digits, hyphens).
  key: string;
  title: string;
  party: EvidenceParty;
  // The criteria it evidences (at least one).
  criterionIds: string[];
  // Only asked for when this intake answer matches.
  when?: IntakeCondition;
  // What the per-upload check (#115) should expect to read.
  expects?: { documentType?: string; fields?: string[] };
  // The sentence of the source that names the document. Validated verbatim.
  // (#233) SERVED-SIDE ONLY, never stored on a version: set by the stack merge
  // (scrapers/rubric/rubric-stack.ts) on a rulebook STACK of more than one layer,
  // naming the rulebook key of the layer this item came from. Absent on a
  // single-layer rulebook (every route without inheritance), so those read
  // exactly as before.
  layerKey?: string;
  source: RubricCitation;
}

/**
 * How the route maps onto a publisher's outcome statistics (#116). The
 * publisher's categories rarely match one route exactly (a category may cover
 * a whole family of routes), so the mapping is data an admin sets. Extraction
 * never fills it in.
 */
export interface OutcomeStatisticsMapping {
  // Key of the published category the route is counted under: an opaque key
  // the destination's importer adapter defines (the `categoryKey` of stored
  // outcomeStatistics docs, e.g. "group:<slug>"). Looked up by exact match.
  categoryKey: string;
  // Wording for that category in the applicant's note, e.g. "all visitor
  // visas". Written by the admin so the note's label matches how wide the
  // published category really is. Required (#116).
  categoryLabel: string;
  // Importer adapter that reads that publisher's tables.
  adapterId?: string;
  // Where the tables are published.
  sourceUrl?: string;
  // Anything a reader must know (e.g. "category is wider than this route").
  note?: string;
}

// ============================================
// Rubric version and head
// ============================================

/** The extractor's proposal for the route's intent polarity, with its quote. */
export interface IntentPolarityProposal {
  value: IntentPolarity;
  // Absent only for `not_assessed` (there is nothing to quote).
  source?: RubricCitation;
}

/**
 * (#220) The unofficial translation of one quote. `unofficial` is always true
 * and `language` is the product language; `quoteHash` is the sha256 of the
 * normalised quote that was translated, so a reader can tell the translation
 * still belongs to the quote beside it (a repaired rule has a different quote).
 */
export interface QuoteTranslation {
  text: string;
  language: string;
  model: string;
  promptVersion: string;
  unofficial: true;
  quoteHash: string;
}

/** One snapshot a version was extracted from. */
export interface RubricSourceSnapshot {
  sourceId: string;
  contentHash: string;
  url: string;
  docType: "html" | "pdf";
  publishedDate?: string;
  // (#220) The language the source was registered in (a code), when one was declared. Lets every
  // later reader of the version (the independent check and its re-draft) read the document's
  // numbers and dates in its own language. Absent = the product language.
  language?: string;
}

/**
 * The criterion fields a supporting citation may be attached to. A closed
 * list, so a citation's key is never a string the model made up.
 */
export const RUBRIC_CITATION_FIELDS = [
  "title",
  "kind",
  "stage",
  "ruleRef",
  "check.field",
  "check.value",
  "check.unit",
  "appliesTo",
  "validFrom",
  "validUntil",
  "probeFactors",
  "requiresInterviewBeforeRefusal",
  "concernsIntent",
] as const;
export type RubricCitationField = (typeof RUBRIC_CITATION_FIELDS)[number];

/** Why a model-proposed item was thrown away. Stable, machine-readable. */
export const RUBRIC_DISCARD_REASONS = [
  "quote_empty",
  "quote_too_short",
  "quote_not_found", // not verbatim in ITS OWN source (includes paraphrase and another document's text)
  "quote_spans_pages", // PDF: runs across a page break
  "quote_spans_paragraphs", // web page: runs across a line (block) of the cleaned text
  "quote_in_flagged_passage", // overlaps text flagged as addressed to the model
  "number_not_in_quote", // states a number / duration its quote does not
  "date_not_in_quote",
  "unit_not_in_quote",
  "rule_ref_not_in_source",
  "applies_to_not_in_quote",
  "list_not_readable", // (#222) reserved: the list after a lead-in could not be read cleanly (raised as a flag today, see rubric-list-items.ts)
  "citation_not_found", // a per-field supporting quote is not verbatim in the source
  "invalid_shape", // breaks a kind rule (judgement with a check, ...)
  "duplicate", // same criterion already produced by an earlier chunk
  "unresolved_reference", // points at criteria that did not survive
  "out_of_route_scope", // from a cross-route source the route's own source does not point to, or not for every applicant of the route
  "other_route", // the text says it applies to a different route or category of applicant
] as const;
export type RubricDiscardReason = (typeof RUBRIC_DISCARD_REASONS)[number];

/**
 * (#207) Reasons that older stored versions may still carry but that extraction
 * can no longer produce. `specialist_activity` was the reason a rule for a
 * specialist activity was left out; such rules are now kept (see
 * AssessmentCriterion.trigger). Kept in the type so a stored version that holds
 * the value is still read as valid data.
 */
export const LEGACY_DISCARD_REASONS = ["specialist_activity"] as const;
export type LegacyDiscardReason = (typeof LEGACY_DISCARD_REASONS)[number];

/** One discarded item, kept for the reviewer. Never holds source text. */
export interface RubricDiscard {
  itemType: "criterion" | "intake_question" | "evidence_item" | "intent_polarity";
  reason: RubricDiscardReason | LegacyDiscardReason;
  // Fixed, code-written detail (which field failed which rule). Never holds
  // a string the model supplied, and never source text.
  detail: string;
  // The model's own label for the item (its title), so a reviewer can tell
  // which proposal was dropped. Capped, control characters removed, stored
  // only: it is never written to a log.
  label: string;
  sourceId: string;
  // Which chunk of the source it came from (0-based).
  chunkIndex: number;
  // Audit trail (#112): what the model proposed, so a reviewer can tell WHY
  // a proposal was dropped. Published guidance, not personal data. The
  // reference as the model wrote it, a sha256 of its quote (hex) and the
  // first 120 characters of that quote. Present on criteria only.
  ruleRef?: string;
  quoteHash?: string;
  quoteStart?: string;
}

/** A non-fatal remark on a stored rubric (see the validator). */
export interface RubricFlag {
  code: string;
  message: string;
  // What it is about: a criterion id, a question id, or "rubric".
  target: string;
}

/**
 * (#233) One layer of a rulebook STACK as an application sees it: whose
 * rulebook (`rulebookKey`, `authorityId`), its role (`shared` for a bloc /
 * treaty layer, `own` for the country's own layer), and the approved version
 * served (`approved`) or that it has none (`missing`, `version` null). A
 * missing layer is always listed, never left out.
 */
export interface RulebookStackLayer {
  rulebookKey: string;
  authorityId: string;
  role: "shared" | "own";
  status: "approved" | "missing";
  version: number | null;
}

/**
 * (#233) The key fields every rulebook document carries (head, version,
 * extraction run, publish run). `routeKey` is the document key
 * `{authorityId}_{routeSlug}`.
 *
 *  - `authorityId` / `routeSlug`: written on every document since #233.
 *    OPTIONAL in the type only because documents written before #233 do not
 *    have them; the store fills them in on every read (`rulebookPartsOf`), and
 *    code that needs them calls `rulebookPartsOf` rather than reading the
 *    fields directly.
 *  - `countryCode` / `visaTypeId`: present ONLY on a country authority's
 *    rulebook, where they equal `authorityId` / `routeSlug` (today's shape).
 *    A bloc or treaty rulebook has neither: code that needs a country must
 *    not invent one.
 */
export interface RulebookKeyFields {
  // `${authorityId}_${routeSlug}`: the head doc id.
  routeKey: string;
  authorityId?: string;
  routeSlug?: string;
  countryCode?: string;
  visaTypeId?: string;
}

/**
 * One VERSION of a route's rubric:
 * `visaRubrics/{authorityId}_{routeSlug}/rubricVersions/{version}` (for a
 * country: `{countryCode}_{visaTypeId}`, unchanged).
 *
 * Content is immutable once written. The only fields that may change after
 * creation are the REVIEW fields (RUBRIC_REVIEW_FIELDS), written by #125.
 */
export interface VisaRubric extends RulebookKeyFields {
  schemaVersion: number;
  // (#233) Key fields (`routeKey`, `authorityId`, `routeSlug`, and for a
  // country authority `countryCode` + `visaTypeId`): see RulebookKeyFields.
  // Monotonic per route, starting at 1. Also the doc id (as a string).
  version: number;

  // ---- review (owned by #125; extraction writes the initial values only) ----
  reviewStatus: RubricReviewStatus;
  // The DECISION, made by an admin at approval. Null until then. The engine
  // reads only this, never the proposal.
  intentPolarity: IntentPolarity | null;
  reviewedBy: string | null;
  reviewedAt: Timestamp | null;
  rejectReason: string | null;
  // Concurrency token for the review (#125 increments it on every decision).
  revision: number;
  // Set when a later version is approved over this one.
  supersededAt: Timestamp | null;

  // ---- content (immutable) ----
  // What extraction proposed for the polarity, with its quote. Kept apart
  // from the decision so a reviewer sees both.
  intentPolarityProposal: IntentPolarityProposal | null;
  // The ordered severity scale, most severe first.
  severityLevels: string[];
  // In source order (source by source, then position in the document).
  criteria: AssessmentCriterion[];
  intake?: IntakeMeta;
  intakeQuestions: IntakeQuestion[];
  evidenceItems: EvidenceItem[];
  // Set by an admin (never by extraction); absent until then.
  outcomeStatistics?: OutcomeStatisticsMapping;
  // Admin-set tag (#116): ids of the criteria for which extra supporting
  // evidence helps. The country-context note lists their titles, and only
  // when the nationality's published rate is below the all-nationality rate.
  // Never model-extracted, never chosen per nationality. Absent = no areas.
  evidenceHelpsCriterionIds?: string[];
  // Admin-set at approval (#161): criteria the reviewer EXCLUDED from the
  // served rubric. The extracted `criteria` list is never edited; the read
  // side (`applyExclusions`, called by `rubricStore.getApprovedRubric`) leaves
  // these out, together with the intake questions and evidence items that
  // only they justified. Never extracted. A mandatory bar can never be listed.
  // Absent = nothing excluded.
  excludedCriterionIds?: string[];
  // Admin-set (#161): the reviewer's one note for the exclusions above.
  exclusionNote?: string;
  // Written with the AUTOMATIC approval (#203): the question plan (what the
  // wording check removed, exact duplicates merged, conditions, order). Never
  // extracted, never client-visible: `applyExclusions` applies it on the read
  // side and strips it from the served rubric. Absent = serve as extracted.
  questionPlan?: QuestionPlan;
  // Written with the AUTOMATIC approval (#223): protected rules (mandatory bars)
  // that failed the independent check and were RE-DRAFTED once from their own
  // source passage, with the replacement that passed the check. The extracted
  // `criteria` list is never edited: `applyExclusions` (the one read-side
  // filter) swaps each replacement in on the read side, so what is served is
  // exactly what the check verified, and the original stays in `criteria` as
  // the audit trail. Never extracted, never client-visible. Absent = none.
  ruleRepairs?: RubricRuleRepair[];

  // ---- provenance (immutable) ----
  // (#233) SERVED-SIDE ONLY, never stored: present on the MERGED view of a
  // rulebook stack of more than one layer (rubric-stack.ts). One entry per
  // layer in stack order (shared layers first, the country's own layer last),
  // with the approved version served or `missing`. Absent on a single-layer
  // rulebook. Consumers record it so an application shows which layer is
  // missing and which versions it was assessed against.
  stackLayers?: RulebookStackLayer[];
  sourceSnapshots: RubricSourceSnapshot[];
  // (#220) The languages the sources of this version are written in (primary
  // language codes, sorted, de-duplicated). Written at extraction from each
  // source's declared language (a source with none counts as the product
  // language). The publish gate HOLDS the version `language_not_supported`
  // unless every one is in `appConfig/routeOnboardingSettings.supportedLanguages`.
  // Absent on a version written before #220: read as the product language only.
  sourceLanguages?: string[];
  // (#220) An UNOFFICIAL, AI-written translation of each non-product-language
  // quote, keyed by criterion id, kept APART from `criteria[].source.quote`.
  // It is a courtesy for a reader and is NEVER evidence: no extractor, checker,
  // question check, assessment or letter ever receives it (a test greps for
  // that), and it never replaces or edits a quote. A rule whose translation
  // failed has no entry. Absent when every source is in the product language.
  quoteTranslations?: Record<string, QuoteTranslation>;
  // sha256 over the sorted `sourceId:contentHash` pairs: the hash gate. A
  // re-run over the same snapshots writes no new version.
  sourceSetHash: string;
  extractorModel: string;
  extractorPromptVersion: string;
  extractionRunId: string;
  // What the code-side validation threw away, and why. Counted and shown,
  // never swallowed.
  discardedCount: number;
  discarded: RubricDiscard[];
  // Verbatim passages the extractor reported as addressed to a reader model
  // rather than to a caseworker (possible prompt injection). No criterion may
  // quote from them.
  suspiciousPassages: RubricCitation[];
  // Remarks from the structural validator (e.g. intent criteria without a
  // polarity). A reviewer must look at these before approving.
  flags: RubricFlag[];
  createdAt: Timestamp;
}

// ============================================
// Question plan (issue #203, part of #200)
// ============================================

/**
 * The plan for the applicant-facing questions of one version. It REMOVES
 * nothing for size: the only removals are the ones the automatic wording check
 * found wrong (a correctness removal, recorded with the reason). Everything
 * else is merging of exact duplicates, conditions and order.
 *
 * Applied on the read side (`applyExclusions`); the version's own questions
 * are never edited. Every id below is one of the version's own.
 */
export interface QuestionPlan {
  // Version of the deterministic algorithm (merge / condition / order rules).
  algorithmVersion: string;
  // Questions the wording check failed, with the failed aspects. They are removed
  // together with their dependents through the exclusion dependency logic.
  omittedQuestions: { id: string; failed: string[] }[];
  // Document items the check failed, with the failed aspects.
  omittedEvidence: { key: string; failed: string[] }[];
  // INFORMATIONAL: what else the dependency logic removed because of the above.
  droppedWithDependents: { questionIds: string[]; evidenceKeys: string[] };
  // Exact duplicate questions folded into `to` (the earlier one). Always a star:
  // no `to` is itself a `from`.
  merges: { from: string; to: string }[];
  // Conditions added to a question that had none, derived in code from its
  // rules' own validated trigger data; `derivedFromCriterionIds` are those rules.
  proposedConditions: { questionId: string; showWhen: { anyOf: IntakeCondition[] }; derivedFromCriterionIds: string[] }[];
  // The served order of the surviving questions (deciding questions first).
  order: string[];
  // INTEGRATION (#200 + #207): rules whose `trigger` the independent check could not confirm.
  // The RULE STAYS (never left out for this); only its trigger is ignored on the read side
  // (`applyExclusions` strips it), so it is read as "could not tell whether this applies"
  // (specialist) or by the legacy rule for a conditional rule without a trigger. Ids are this
  // version's own rules. Absent on a plan written before the integration.
  // (#248) A MANDATORY BAR can be listed too (its rule confirmed by both models, its trigger
  // not): `applyExclusions` then serves it without the trigger AND marks it `notCodeDecided`,
  // derived from this list on every read (no second stored list that could disagree).
  droppedTriggerCriterionIds?: string[];
  // How many questions an applicant sees, with the plan applied (before the
  // wording check's omissions, which only lower them). `exact` is false when the
  // best / worst search hit its budget and the figures are sampled bounds.
  sizing: { total: number; unconditional: number; deciding: number; best: number; typical: number; worst: number; exact: boolean; samples: number };
  // What the wording check did; null when it did not run (an offline plan).
  check: {
    promptVersion: string;
    model: string;
    calls: number;
    inputTokens: number;
    outputTokens: number;
    questionsChecked: number;
    evidenceItemsChecked: number;
    questionsFailed: number;
    evidenceItemsFailed: number;
  } | null;
}

/**
 * The fields of a version doc that a review (#125) may write. Everything else
 * is content or provenance and must never be updated.
 */
export const RUBRIC_REVIEW_FIELDS = [
  "reviewStatus",
  "intentPolarity",
  "reviewedBy",
  "reviewedAt",
  "rejectReason",
  "revision",
  "supersededAt",
  "outcomeStatistics",
  "evidenceHelpsCriterionIds",
  "excludedCriterionIds",
  "exclusionNote",
  // (#203) the automatic approval's question plan (see QuestionPlan).
  "questionPlan",
  // (#223) the automatic approval's recorded replacements of repaired protected rules.
  "ruleRepairs",
] as const;

// ============================================
// Automatic publishing (issue #201, part of #200)
// ============================================

/**
 * The NAMED system actor that publishes (and supersedes) rubric versions
 * without a person. It is written as `reviewedBy` on the version and as `by`
 * on the audit entry, so every place that shows or checks a reviewer can tell
 * a machine decision from an admin's.
 *
 * Why this exact shape: the structural validator only needs `reviewedBy` to be
 * a non-empty string, and the two audit consumers (bulk re-assessment, rule-
 * change alerts) copy `entry.by` into their records without looking it up as a
 * user. A fixed, namespaced constant (never a uid a client could send: every
 * `reviewedBy` is written by the server from the verified token or from this
 * constant) is therefore enough. The review service additionally REFUSES an
 * admin whose uid equals it, so the value can never be claimed by a person.
 */
export const RUBRIC_SYSTEM_ACTOR_ID = "system:rubric-auto-publish" as const;

/** True when a `reviewedBy` / audit `by` value is the automatic publisher. */
export function isRubricSystemActor(id: unknown): boolean {
  return id === RUBRIC_SYSTEM_ACTOR_ID;
}

/**
 * The two kinds of decider. Named constants, so the review code never writes
 * the role word as a string literal (its test refuses that).
 */
export const RUBRIC_ACTOR_KIND = { ADMIN: "admin", SYSTEM: "system" } as const;

/** Who is deciding: an admin (verified uid) or the automatic publisher. */
export type RubricReviewActor = { kind: typeof RUBRIC_ACTOR_KIND.ADMIN; uid: string } | { kind: typeof RUBRIC_ACTOR_KIND.SYSTEM; id: typeof RUBRIC_SYSTEM_ACTOR_ID };

/** How a publish run ended. `skipped`: refused before any gate ran (kill switch, allowlist, already decided). */
export const RUBRIC_PUBLISH_OUTCOMES = ["published", "held", "skipped"] as const;
export type RubricPublishOutcome = (typeof RUBRIC_PUBLISH_OUTCOMES)[number];

/** What started a run. */
export type RubricPublishTrigger = "version_created" | "admin_endpoint" | "script" | "sweep";

/** One gate's verdict, as recorded on the run. `detail` is code-written (ids, counts), never model or source text. */
export interface RubricPublishGateResult {
  gate: string;
  passed: boolean;
  detail?: string;
}

/**
 * (#240) Why the independent check left an ordinary rule out:
 *  - `found_wrong`: at least one failing verdict is a `no` (the model said the rule is wrong);
 *  - `not_confirmed`: every failing verdict is `unsure` / `na`, or there was nothing to read (the
 *    check could not confirm the rule, nobody said it is wrong).
 * Both leave the rule out and both count against the leave-out budget; the split only tells the
 * owner which kind of problem a held draft has.
 */
export type LeaveOutBasis = "found_wrong" | "not_confirmed";

/** One rule the run left out of the served rulebook, and why (a flag code, or `checker:<aspect>`). */
export interface RubricPublishLeftOut {
  criterionId: string;
  reason: string;
  // The extraction flag that caused it; null for a checker leave-out (part B).
  flagCode: string | null;
  // (#240) Only on a `checker:*` leave-out: found wrong, or not confirmed. Absent on code leave-outs
  // (they keep their own reasons) and on records written before #240.
  basis?: LeaveOutBasis;
}

/**
 * (#223) One repaired protected rule as recorded on a version (`ruleRepairs`).
 * `replacement` keeps the original's `criterionId` (every link to the rule, the
 * question plan and the exclusion list, stays valid) and its link fields
 * (`trigger`, `intakeQuestionIds`); its own text, quote and group come from the
 * re-draft, which code validated like any drafted rule.
 */
export interface RubricRuleRepair {
  criterionId: string;
  replacement: AssessmentCriterion;
  // sha256 of the original rule as drafted (the idempotency key with `criterionId`).
  originalRuleHash: string;
  // The publish run that decided it (`{routeKey}__v{version}`).
  runId: string;
  // (#244) Ids of OTHER originals this one replacement also stands for: several found-wrong items of one
  // definition can all come back as the same lead-in rule, and the draft serves it ONCE (never two copies).
  // Those originals are left out of the served rulebook (reason `checker:redraft_duplicate`); the question
  // and evidence links that named them are re-pointed to this rule by `applyRuleRepairs`.
  alsoReplaced?: string[];
}

/** How the one automatic repair of a failed protected rule ended. */
export type RubricRepairStatus =
  // Re-drafted, validated, and confirmed by both check models: it replaces the original.
  | "repaired"
  // Re-drafted and validated, but the check still did not confirm it.
  | "failed_check"
  // The model said the passage cannot be drafted into the rule (an empty answer, or none that fits).
  | "cannot_be_repaired"
  // The re-draft failed code validation (quote not found, group not in quote, wrong shape, ...).
  | "invalid_redraft"
  // No attempt was made (`detail` says why: a cap, or the failure is one a re-draft cannot change).
  | "not_attempted"
  // The attempt could not finish (provider unavailable, or a request cap was reached).
  | "attempt_unfinished";

/**
 * (#244) How the one automatic repair of an ORDINARY rule the check found wrong ended: the protected
 * statuses, plus `merged_duplicate` (the replacement was confirmed but says what another served rule, or
 * another replacement, already says, so ONE rule is served and this original is left out as covered).
 */
export type RubricOrdinaryRepairStatus = RubricRepairStatus | "merged_duplicate";

/** (#244) The run record's line for one ordinary rule that was eligible for the automatic re-draft. */
export interface RubricOrdinaryRepair {
  criterionId: string;
  ruleRef: string | null;
  title: string;
  // Aspects the check failed on the ORIGINAL (at least one a `no` on title, kind, condition or check).
  failedAspects: string[];
  // The six verdict letters of the verification model on the ORIGINAL (an audit trail, never rule content).
  verdicts: { verification?: string };
  repair: {
    status: RubricOrdinaryRepairStatus;
    // A short code (never model text): `too_many`, `cap_exceeded`, `deadline`, `quote_not_found`, ...
    detail?: string;
    // sha256 of the original rule (with `criterionId`, the key that makes the attempt happen once).
    ruleHash: string;
    // Model requests this attempt's re-draft used (a replayed attempt shows what it used when it was made).
    requests: number;
    replacementFailedAspects?: string[];
    replacementVerdicts?: { verification?: string };
    // True when the replacement quotes the same line as the original; false when it quotes another
    // (a definition item that came back as its lead-in).
    sameLine?: boolean;
    // `merged_duplicate`: the id of the rule that is served instead (another rule, or the first replacement).
    coveredBy?: string;
  };
}

/** (#244) The run record's counts of the ordinary re-draft. */
export interface RubricOrdinaryRepairCounts {
  // Rules left out by the check with at least one `no` on title, kind, condition or check (not code leave-outs).
  eligible: number;
  // Eligible rules whose ONE re-draft finished (this run's or an earlier run's):
  // `repaired + failedCheck + invalid + mergedDuplicates + checkPending`.
  attempted: number;
  // Re-drafted, validated, confirmed by the check: served as the replacement.
  repaired: number;
  // Re-drafted and validated, but the check did not confirm the replacement.
  failedCheck: number;
  // The model said it cannot be repaired, code refused the re-draft, or the replacement's quote could not be found again.
  invalid: number;
  // Confirmed, but served as another rule (see `merged_duplicate`); not counted as left out.
  mergedDuplicates: number;
  // Re-drafted, but the check of the replacement could not finish (a cap, the clock or the provider): the
  // attempt is stored, the rule stays left out for now, and a later run checks the stored replacement.
  checkPending: number;
  // Eligible rules with no finished re-draft: skipped by the guard, cut off by a cap or the clock, or the provider failed.
  notAttempted: number;
  // Requests spent: re-drafts, and the check of the replacements.
  requests: { redraft: number; check: number };
  // Set when the guard skipped every re-draft (`too_many`), recorded as `ordinary_repair_skipped:too_many`.
  skipped?: "too_many";
  // Set when a request cap, the input cap or the clock stopped the repair before every eligible rule was tried.
  cutOff?: "capped" | "deadline" | "provider";
}

/** What the held record and the alert say about one protected rule that failed the check. */
export interface RubricProtectedFailure {
  criterionId: string;
  ruleRef: string | null;
  // The rule's title (data, so alerts can name it).
  title: string;
  // Aspects (checker aspect names) that either model did not answer `yes` to, in the checker's fixed order.
  failedAspects: string[];
  // The six verdict letters of each model on the ORIGINAL rule (an audit trail, never rule content).
  verdicts: { verification?: string; judgement?: string };
  repair: {
    status: RubricRepairStatus;
    // A short code (never model text): `cap_exceeded`, `trigger_not_repairable`, `quote_not_found`, ...
    detail?: string;
    // sha256 of the original rule (with `criterionId`, the key that makes the attempt happen once).
    ruleHash: string;
    // Model requests this repair used (the re-draft and its check).
    requests: number;
    // Aspects the re-checked replacement still failed, and its verdict letters per model.
    replacementFailedAspects?: string[];
    replacementVerdicts?: { verification?: string; judgement?: string };
  };
}

/**
 * (#248) One bar served without its trigger (see `AssessmentCriterion.notCodeDecided`).
 * The trigger (the intake question and answers that narrow which applicants the bar is
 * put to) was not confirmed by both check models while every judged aspect of the rule
 * was. The rule is served with the trigger removed and is NEVER decided by code: the
 * assessment model is shown it in full and can raise a concern on it.
 */
export interface RubricJudgedBar {
  criterionId: string;
  ruleRef: string | null;
  // The rule's title (data, so alerts can name it).
  title: string;
  // True when the bar served is its one automatic re-draft (#223); false for the rule as drafted.
  replaced: boolean;
  // The trigger that was removed: its question id and answer values (ids from the draft, not text).
  removedTrigger: RuleTrigger;
}

/** (#248) The fixed words that say what happened to such a bar, in the run record, the alerts and the audit. */
export const JUDGED_BAR_NOTE = "its trigger was not confirmed by the independent check, so it is served without the trigger and is assessed by judgement (never decided by code)";

/**
 * `rubricPublishRuns/{routeKey}__v{version}`: the record of the automatic
 * publish run of ONE version (backend-only: no firestore.rules match). The id
 * is deterministic, so a re-delivered trigger finds the record and does not run
 * (or publish) twice; it is written with `create()`.
 */
export interface RubricPublishRun extends RulebookKeyFields {
  runId: string;
  // (#233) routeKey / authorityId / routeSlug (+ countryCode / visaTypeId for a country): RulebookKeyFields.
  version: number;
  outcome: RubricPublishOutcome;
  // Machine-readable reasons for a hold / skip (empty when published).
  reasonCodes: string[];
  gates: RubricPublishGateResult[];
  counts: {
    rules: number;
    kept: number;
    leftOut: number;
    leftOutByReason: Record<string, number>;
    // (#240) The `checker:*` leave-outs split by why: found wrong (a `no`) vs not confirmed (only
    // unsure / na). Code leave-outs are in neither; they keep their own reasons in `leftOutByReason`.
    // Optional: records written before #240 have neither.
    leftOutFoundWrong?: number;
    leftOutNotConfirmed?: number;
    // (#244) The automatic re-draft of ordinary rules the check found wrong. Absent on records written before #244.
    ordinaryRepairs?: RubricOrdinaryRepairCounts;
    // Rules that made the draft HOLD (a protected rule that failed a gate).
    held: number;
    informationalFlags: Record<string, number>;
  };
  leftOut: RubricPublishLeftOut[];
  // The mode the run saw (`manual` when settings were missing or unreadable).
  mode: "manual" | "auto";
  trigger: RubricPublishTrigger;
  // 1 for the first run; an admin or script re-run of a held version adds one.
  attempts: number;
  // The independent check and the question plan (parts B and C): what happened.
  checker: "not_configured" | "not_run" | "passed" | "failed";
  questionPlan: "not_configured" | "not_run" | "built" | "failed";
  // INTEGRATION: rules whose trigger the independent check could not confirm (the rule is kept, its trigger ignored).
  droppedTriggerIds?: string[];
  // (#223) Protected rules (mandatory bars) the independent check did not confirm, each with the
  // per-aspect verdicts of both models and the ONE automatic repair attempt and its result. The
  // original rule stays in the draft; a repaired rule that passed is listed here too (status
  // `repaired`) and is the one recorded on the version as `ruleRepairs`.
  protectedFailures?: RubricProtectedFailure[];
  // (#244) One line per ordinary rule that was eligible for the automatic re-draft, with how it ended.
  ordinaryRepairs?: RubricOrdinaryRepair[];
  // (#248) Bars served WITHOUT their trigger: both models confirmed every judged aspect of the
  // rule (or of its one re-draft), but not its trigger. Each is assessed by judgement, never by
  // code. Absent on records written before #248 and when there is none.
  barsJudgedWithoutTrigger?: RubricJudgedBar[];
  // (#223) Model requests the independent check made in this run, repair requests shown apart
  // (both count against `checkerMaxRequestsPerRun`; since #244 `repair` also holds the ordinary re-drafts).
  checkerRequests?: { total: number; repair: number };
  // Set when published: the audit entry and the version it replaced.
  auditId: string | null;
  previousApprovedVersion: number | null;
  startedAt: Timestamp;
  finishedAt: Timestamp;
}

/**
 * `visaRubrics/{authorityId}_{routeSlug}`: the head of one route's rubric (for
 * a country: `{countryCode}_{visaTypeId}`, unchanged).
 * Consumers read the head, then the version `approvedVersion` points at.
 */
export interface RubricHead extends RulebookKeyFields {
  // (#233) routeKey / authorityId / routeSlug (+ countryCode / visaTypeId for a country): RulebookKeyFields.
  // The guidance sources this route's rubric is extracted from. Set when the
  // route is first extracted; this is what lets a later run find "the newest
  // snapshots have no rubric version yet".
  sourceIds: string[];
  // The version consumers serve, or null when none has been approved. Written
  // by #125 only; extraction never touches it after creating the head.
  approvedVersion: number | null;
  // The newest version written (any review status).
  latestVersion: number;
  // `sourceSetHash` of that newest version (the hash gate reads this).
  latestSourceSetHash: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

// ============================================
// Extraction run record
// ============================================

/** Token counts of one run, summed over its model calls. */
export interface RubricRunUsage {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/**
 * How one extraction run ended:
 *  - succeeded: a new `pending_review` version was written;
 *  - unchanged: the hash gate matched, nothing was called or written;
 *  - skipped:   refused before any model call (kill switch, cap, settings
 *               unreadable);
 *  - failed:    a model call or a validation step failed; NO version written.
 *  - started:   written just BEFORE the first model call and replaced by the
 *               final status when the run ends. A record still `started`
 *               long after its `startedAt` is a run that died mid-way (it
 *               still counts toward the daily cap: it reached the model).
 */
export type RubricRunStatus = "started" | "succeeded" | "unchanged" | "skipped" | "failed";

/** `rubricExtractionRuns/{runId}`: the record of one run (cost + audit). */
export interface RubricExtractionRun extends RulebookKeyFields {
  runId: string;
  // (#233) routeKey / authorityId / routeSlug (+ countryCode / visaTypeId for a country): RulebookKeyFields.
  status: RubricRunStatus;
  // True once the run was about to make its first model call. The daily cap
  // counts exactly these runs.
  reachedModel: boolean;
  // Machine-readable reason for skipped / failed (e.g. "settings_unavailable").
  reasonCode: string | null;
  // One line, secret-free, never source text.
  error: string | null;
  trigger: "manual" | "guidance_changed" | "pending_sweep";
  sourceSnapshots: RubricSourceSnapshot[];
  sourceSetHash: string | null;
  model: string;
  promptVersion: string;
  // Version written (succeeded only).
  version: number | null;
  chunks: number;
  usage: RubricRunUsage;
  // Null when the model has no entry in the price table (the default).
  costUsd: number | null;
  criteriaAccepted: number;
  // (#207) How many of the accepted criteria are specialist-activity rules,
  // kept (they used to be discarded). Optional: older run records lack it.
  specialistKept?: number;
  discardedCount: number;
  // Discards by reason, for a quick look without opening the version.
  discardedByReason: Record<string, number>;
  startedAt: Timestamp;
  finishedAt: Timestamp;
}
