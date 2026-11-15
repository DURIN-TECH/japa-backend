// ============================================
// E2E FIXTURE — PURE BUILDERS (issue #361)
// ============================================
//
// What the mobile Maestro suite needs on top of the full seed, as plain data:
//
//   1. An APPROVED rulebook (`visaRubrics/IE_short-stay-c`, version 1) with
//      three intake questions and two document items, so
//      `GET /applications/:id/intake` answers `available: true` and the
//      self-service hub shows an intake step and a document checklist.
//   2. One client account on the free plan, onboarding complete, with no
//      application (`seed-user-e2e-client-001`).
//
// Everything here is deterministic: fixed ids, fixed timestamps, a content
// hash computed from fixed text. Running the fixture twice writes the same
// documents.
//
// NOT REAL GUIDANCE. The rulebook's "quotes" are fixture text that says so in
// its own words, under a `.invalid` URL (a domain that can never resolve). It
// exists only on the local emulators, so no applicant ever reads it, and no
// rule here claims to be what a real caseworker checks.
//
// PURE: no Firebase calls (only the `Timestamp` value class), no network, no
// clock. The writer is scripts/seed-e2e.ts.

import { createHash } from "node:crypto";
import { Timestamp } from "firebase-admin/firestore";
import {
  DEFAULT_SEVERITY_LEVELS,
  RUBRIC_SCHEMA_VERSION,
  type AssessmentCriterion,
  type EvidenceItem,
  type IntakeQuestion,
  type RubricCitation,
  type RubricHead,
  type VisaRubric,
} from "../../types/rubric";

// ============================================
// Ids (flows deep-link and assert on these)
// ============================================

/** Every fixed id / value the fixture writes. The mobile flows read these. */
export const E2E_FIXTURE = {
  // ---- the visa the self-service flow walks (seeded by seed-countries-visas) ----
  countryCode: "IE",
  visaTypeId: "short-stay-c",
  // `${countryCode}_${visaTypeId}`: the rulebook head doc id.
  routeKey: "IE_short-stay-c",
  rubricVersion: 1,

  // ---- the client account ----
  clientUid: "seed-user-e2e-client-001",
  // Resend test inbox (team rule: never @example.com). Login email.
  clientEmailLabel: "e2e.amaka.obi",
  clientFirstName: "Amaka",
  clientLastName: "Obi",
  // Unique among seed users, so the shared-contact risk rule raises nothing.
  clientPhone: "+2348090361001",

  // ---- rulebook contents ----
  sourceId: "seed-e2e-guidance-ie-short-stay-c",
  questionIds: {
    purpose: "e2e-visit-purpose",
    visitedBefore: "e2e-visited-before",
    accommodation: "e2e-accommodation",
  },
  criterionIds: {
    purpose: "e2e-crit-purpose",
    history: "e2e-crit-travel-history",
    accommodation: "e2e-crit-accommodation",
  },
  evidenceKeys: {
    passport: "e2e-passport",
    accommodation: "e2e-accommodation-proof",
  },
} as const;

/**
 * One fixed instant for every timestamp the fixture writes, so a second run
 * writes byte-identical documents (2026-11-01T00:00:00Z).
 */
export const E2E_FIXTURE_TIME_ISO = "2026-11-01T00:00:00.000Z";

/** `E2E_FIXTURE_TIME_ISO` as a Firestore Timestamp. */
export function fixtureTime(): Timestamp {
  return Timestamp.fromDate(new Date(E2E_FIXTURE_TIME_ISO));
}

/** Who "approved" the fixture rulebook (the validator wants a reviewer). */
const FIXTURE_REVIEWER = "seed-e2e-fixture";

/** Where the fixture's citations point: a `.invalid` domain never resolves (RFC 2606). */
export const E2E_FIXTURE_SOURCE_URL = "https://seli-e2e-fixture.invalid/ie-short-stay-c";

// ============================================
// Fixture "source" text and citations
// ============================================

/**
 * The fixture's whole "source document". Every quote below is a sentence of
 * it, so the citations are internally consistent, and every sentence says it
 * is test data.
 */
const FIXTURE_SOURCE_TEXT = [
  "Seli end-to-end test fixture, not real guidance: the applicant states the main purpose of the visit.",
  "Seli end-to-end test fixture, not real guidance: the applicant says whether they have visited before.",
  "Seli end-to-end test fixture, not real guidance: the applicant gives the address where they will stay.",
  "Seli end-to-end test fixture, not real guidance: the applicant provides their passport.",
  "Seli end-to-end test fixture, not real guidance: the applicant provides proof of where they will stay.",
];

/** sha256 hex of the fixture source text (the validator wants a real digest). */
export function fixtureContentHash(): string {
  return createHash("sha256").update(FIXTURE_SOURCE_TEXT.join("\n")).digest("hex");
}

/** A citation of sentence `i` of the fixture source. */
function citation(i: number): RubricCitation {
  return {
    quote: FIXTURE_SOURCE_TEXT[i],
    sourceId: E2E_FIXTURE.sourceId,
    url: E2E_FIXTURE_SOURCE_URL,
    contentHash: fixtureContentHash(),
    retrievedAt: E2E_FIXTURE_TIME_ISO,
  };
}

// ============================================
// Rulebook builders
// ============================================

/**
 * The three criteria. Each is an `objective` rule with a `present` check that
 * applies to every applicant (`all_applicants`), so the intake service serves
 * every question unconditionally (no trigger, no `showWhen`).
 */
export function buildE2eCriteria(): AssessmentCriterion[] {
  const base = {
    kind: "objective" as const,
    stage: "validity" as const,
    severity: "medium",
    applicability: "all_applicants" as const,
    confidence: 1,
  };
  return [
    {
      ...base,
      criterionId: E2E_FIXTURE.criterionIds.purpose,
      title: "Purpose of the visit is stated",
      source: citation(0),
      check: { field: `intake.${E2E_FIXTURE.questionIds.purpose}`, op: "present" },
      intakeQuestionIds: [E2E_FIXTURE.questionIds.purpose],
    },
    {
      ...base,
      criterionId: E2E_FIXTURE.criterionIds.history,
      title: "Previous visits are declared",
      source: citation(1),
      check: { field: `intake.${E2E_FIXTURE.questionIds.visitedBefore}`, op: "present" },
      intakeQuestionIds: [E2E_FIXTURE.questionIds.visitedBefore],
    },
    {
      ...base,
      criterionId: E2E_FIXTURE.criterionIds.accommodation,
      title: "Accommodation is stated",
      source: citation(2),
      check: { field: `intake.${E2E_FIXTURE.questionIds.accommodation}`, op: "present" },
      intakeQuestionIds: [E2E_FIXTURE.questionIds.accommodation],
    },
  ];
}

/**
 * The three intake questions, one per answer type that Maestro can drive
 * without a date picker: a single choice, a yes/no and a short text. All
 * required, so `openRequiredIds` lists all three until they are answered.
 */
export function buildE2eIntakeQuestions(): IntakeQuestion[] {
  return [
    {
      id: E2E_FIXTURE.questionIds.purpose,
      label: "What is the main purpose of your visit?",
      answerType: "single_choice",
      required: true,
      criterionIds: [E2E_FIXTURE.criterionIds.purpose],
      options: [
        { value: "tourism", label: "Tourism" },
        { value: "business", label: "Business" },
        { value: "family", label: "Visiting family or friends" },
      ],
    },
    {
      id: E2E_FIXTURE.questionIds.visitedBefore,
      label: "Have you visited Ireland before?",
      answerType: "yes_no",
      required: true,
      criterionIds: [E2E_FIXTURE.criterionIds.history],
    },
    {
      id: E2E_FIXTURE.questionIds.accommodation,
      label: "Where will you stay?",
      helpText: "A hotel name or the address of your host.",
      answerType: "text",
      required: true,
      criterionIds: [E2E_FIXTURE.criterionIds.accommodation],
      textLimits: { maxLength: 200 },
    },
  ];
}

/**
 * The two document items. No `when`: both are listed as soon as the intake
 * has any answer (the checklist builder holds the list back while a route
 * with questions has none answered: state `intake_needed`).
 * Checklist item ids are `ev-<key>`: `ev-e2e-passport`, `ev-e2e-accommodation-proof`.
 */
export function buildE2eEvidenceItems(): EvidenceItem[] {
  return [
    {
      key: E2E_FIXTURE.evidenceKeys.passport,
      title: "Passport",
      party: "applicant",
      criterionIds: [E2E_FIXTURE.criterionIds.purpose],
      source: citation(3),
    },
    {
      key: E2E_FIXTURE.evidenceKeys.accommodation,
      title: "Proof of accommodation",
      party: "applicant",
      criterionIds: [E2E_FIXTURE.criterionIds.accommodation],
      source: citation(4),
    },
  ];
}

/**
 * Version 1 of the fixture rulebook, APPROVED. Shape: `VisaRubric` exactly as
 * `rubricStore.getApprovedRubric` reads it (and as `validateVisaRubric`
 * accepts it; the unit test checks that). Written straight to Firestore by
 * the fixture, NOT through the extraction/approval path: that path is the
 * only way real rulebooks are made and it calls a model, which the suite must
 * never do. Because `reviewStatus` is already `approved`, the
 * `onRubricVersionCreated` trigger (auto-publish) returns at once.
 */
export function buildE2eRubricVersion(): VisaRubric {
  const now = fixtureTime();
  return {
    // ---- key (country authority: both pairs, equal) ----
    routeKey: E2E_FIXTURE.routeKey,
    authorityId: E2E_FIXTURE.countryCode,
    routeSlug: E2E_FIXTURE.visaTypeId,
    countryCode: E2E_FIXTURE.countryCode,
    visaTypeId: E2E_FIXTURE.visaTypeId,
    schemaVersion: RUBRIC_SCHEMA_VERSION,
    version: E2E_FIXTURE.rubricVersion,

    // ---- review: approved, attributable, polarity decided ----
    reviewStatus: "approved",
    intentPolarity: "not_assessed",
    reviewedBy: FIXTURE_REVIEWER,
    reviewedAt: now,
    rejectReason: null,
    revision: 1,
    supersededAt: null,

    // ---- content ----
    intentPolarityProposal: null,
    severityLevels: [...DEFAULT_SEVERITY_LEVELS],
    criteria: buildE2eCriteria(),
    intake: {
      title: "About your visit",
      cardTitle: "Your visit",
      intro: "A few questions about your trip.",
    },
    intakeQuestions: buildE2eIntakeQuestions(),
    evidenceItems: buildE2eEvidenceItems(),

    // ---- provenance ----
    sourceSnapshots: [
      { sourceId: E2E_FIXTURE.sourceId, contentHash: fixtureContentHash(), url: E2E_FIXTURE_SOURCE_URL, docType: "html" },
    ],
    sourceSetHash: createHash("sha256").update(`${E2E_FIXTURE.sourceId}:${fixtureContentHash()}`).digest("hex"),
    extractorModel: "none (seed-e2e fixture)",
    extractorPromptVersion: "seed-e2e",
    extractionRunId: "seed-e2e-fixture",
    discardedCount: 0,
    discarded: [],
    suspiciousPassages: [],
    flags: [],
    createdAt: now,
  };
}

/** The rulebook head: `approvedVersion` points at version 1, the only version. */
export function buildE2eRubricHead(): RubricHead {
  const now = fixtureTime();
  const version = buildE2eRubricVersion();
  return {
    routeKey: E2E_FIXTURE.routeKey,
    authorityId: E2E_FIXTURE.countryCode,
    routeSlug: E2E_FIXTURE.visaTypeId,
    countryCode: E2E_FIXTURE.countryCode,
    visaTypeId: E2E_FIXTURE.visaTypeId,
    sourceIds: [E2E_FIXTURE.sourceId],
    approvedVersion: E2E_FIXTURE.rubricVersion,
    latestVersion: E2E_FIXTURE.rubricVersion,
    latestSourceSetHash: version.sourceSetHash,
    createdAt: now,
    updatedAt: now,
  };
}

// ============================================
// Client account builder
// ============================================

/**
 * The client's `users/{uid}` document: the same shape as the seeded clients in
 * data/seed-portal-data.ts, onboarding complete, Nigerian passport.
 *
 * @param email the login email (`delivered+e2e.amaka.obi@resend.dev`), passed
 *   in so the Resend-address helper stays the seed's own.
 */
export function buildE2eClientUserDoc(email: string): Record<string, unknown> {
  const now = fixtureTime();
  return {
    id: E2E_FIXTURE.clientUid,
    email,
    firstName: E2E_FIXTURE.clientFirstName,
    lastName: E2E_FIXTURE.clientLastName,
    phone: E2E_FIXTURE.clientPhone,
    residentialCountry: "NG",
    onboardingCompleted: true,
    onboardingCompletedAt: now,
    hasPassport: true,
    passportCountry: "NG",
    createdAt: now,
    updatedAt: now,
  };
}
