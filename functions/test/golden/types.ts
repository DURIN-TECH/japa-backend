// ============================================
// Golden set — shared types and named constants (issue #35)
// ============================================
//
// The golden set is a corpus of synthetic applications (DATA, in
// fixtures/applications/*.json) that is run through the REAL assessment engine
// offline, against recorded model answers, and checked by the gate assertions
// (assertions.ts). This file holds the fixture shape and every number the gate
// uses, so none of them is a vibe buried in a test body.

import type { ReadinessBand } from "../../src/types/assessment";

/**
 * Who set a fixture's expected band and grounds.
 *
 *  - `draft-unreviewed`: written by an engineer from the rubric's own wording,
 *    NOT checked by an immigration-advice reviewer. Its band comparison is
 *    reported but never blocks (see assertions.ts, bandIsBlocking).
 *  - `expert`: checked and signed off by an immigration-advice reviewer. ONLY
 *    this value makes the band comparison blocking. Flipping a fixture to it is
 *    a reviewer's act, documented in README.md ("How an expert reviews a fixture").
 */
export type LabelSource = "draft-unreviewed" | "expert";

/** The human label of one fixture. */
export interface FixtureLabel {
  // The readiness band a reviewer expects.
  expectedBand: ReadinessBand;
  // Criterion ids expected as REFUSAL GROUNDS (objective checks that fail and
  // mandatory bars). A judgement criterion can never be one.
  expectedGrounds: string[];
  // The Appendix V paragraph / guidance section this fixture exercises.
  paragraphs: string[];
  labelSource: LabelSource;
  // One line, tied to the rubric criterion's own wording (not to anyone's view of the law).
  rationale: string;
  // Set by the reviewer when `labelSource` becomes "expert".
  reviewedBy?: string;
  reviewedOn?: string;
}

/** One synthetic document: its text lines become a small PDF (pdf.ts). ASCII only. */
export interface FixtureDocument {
  id: string;
  // The code label the engine sends (the document type), never a file name.
  label: string;
  lines: string[];
}

/** One golden fixture: everything an application is made of, plus its label. */
export interface GoldenFixture {
  id: string;
  title: string;
  // Key of the rubric fixture to assess against (see runner.ts RUBRIC_FILES).
  rubric: string;
  // Fixtures sharing a group must have identical facts (see README: "nationality group").
  group?: string;
  applicant: {
    firstName: string;
    lastName: string;
    // Always a delivered+<name>@resend.dev address: no real person, no real mail.
    email: string;
    // ISO 3166-1 alpha-2 passport country, as the eligibility check stores it.
    nationality: string;
  };
  // The eligibility score the engine reads (it sets the base band). Synthetic input.
  eligibilityScore: number;
  // Intake answers (#113), keyed by the rubric's intake question ids.
  intake: Record<string, unknown>;
  documents: FixtureDocument[];
  // The personal / purpose-of-visit statement, one string per top-level block.
  // Null: no statement at all. [""]: a statement that is empty.
  statement: { paragraphs: string[] } | null;
  label: FixtureLabel;
  // What this fixture is for, in a sentence.
  purpose: string;
}

/** The assertions the gate applies, by the letter the issue and README use. */
export const GATE_ASSERTIONS = [
  "a-no-fabricated-criterion-id",
  "b-cited-refusal-ground",
  "c-judgement-containment",
  "d-intent-polarity",
  "e-internal-call-stripped",
  "f-no-banned-wording",
  "g-no-invented-funds-threshold",
  "h-band-within-one",
  // Not a letter in the issue: data and invariance checks of the corpus itself.
  "x-nationality-invariance",
  "x-fixture-data",
] as const;
export type GateAssertionId = (typeof GATE_ASSERTIONS)[number];

/** One failed assertion. Printed as `fixture <id>: <assertion>: <message>`. */
export interface Violation {
  fixtureId: string;
  assertion: GateAssertionId;
  message: string;
}

// ---- the numbers the gate uses ----

/**
 * Band-within-one pass threshold: the share of EXPERT-labelled fixtures whose
 * recorded band must be within one band of the label. 0.9 means at most one in
 * ten may miss by two bands or more. Every expert fixture is ALSO checked on its
 * own (a miss by two or more bands blocks regardless of the share), so this is
 * the corpus-level floor on top of the per-fixture rule.
 */
export const BAND_WITHIN_ONE_MIN_SHARE = 0.9;

/** Largest band distance that still counts as "within one". */
export const BAND_MAX_DISTANCE = 1;

/**
 * The corpus size at which the band gate starts to mean something: the issue's
 * 30 to 50 expert-labelled fixtures. NOT enforced by default (the seed corpus is
 * draft-labelled, so enforcing it would fail every PR). Set
 * GOLDEN_ENFORCE_CORPUS_SIZE=1 to turn the floor into a failure.
 */
export const MIN_EXPERT_LABELLED_FIXTURES = 30;

/** Spend cap for ONE refresh run of the recordings, in model calls. */
export const RECORD_MAX_MODEL_CALLS = 120;
