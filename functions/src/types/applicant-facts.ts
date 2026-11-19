import type { Timestamp } from "firebase-admin/firestore";

// ============================================
// WHAT THE APPLICANT HOLDS (issue #234, P5 of #228)
// ============================================
//
// The applicant states ONCE, on their own profile, what they already hold:
//   - their nationalities (one or more two-letter country codes),
//   - the country they live in (`User.residentialCountry`, kept as it is),
//   - the visas, residence permits and travel authorisations they hold, each
//     with who issued it and the date it is valid until.
//
// When an application starts, these are COPIED onto it as `applicantFacts`
// with the time they were taken (the same "copy onto the application"
// pattern as the intake answers, services/intake.service.ts), so a later
// profile edit never rewrites what a running application was assessed on.
// Assessment reads the application's copy, never the live profile.
//
// PRIVACY. Every value here is personal data:
//   - only the signed-in user reads or changes their own profile holdings
//     (GET/PUT /users/me/holdings and the document sub-routes);
//   - the agent side sees an application's COPY only through the existing
//     case access check (`checkApplicationAccess`, GET /applications/:id);
//   - values are never logged, and nothing is inferred (no nationality is
//     ever derived from a passport photo, a phone number or anything else).
//
// Generic by design: no country, nationality or bloc is named here; codes and
// authority ids are data.

/**
 * The kinds of document an applicant can say they hold. A closed list: a
 * rule's `holds` group names one of these, and the profile endpoints refuse
 * anything else.
 */
export const HELD_DOCUMENT_KINDS = ["visa", "residence_permit", "travel_authorisation"] as const;
export type HeldDocumentKind = (typeof HELD_DOCUMENT_KINDS)[number];

/**
 * The facts a rule's fact trigger can read (`FactTrigger.fact`, types/rubric.ts):
 * the applicant's nationalities, their country of residence, or the documents
 * they hold.
 */
export const APPLICANT_FACT_KINDS = ["nationality", "residence", "holds"] as const;
export type ApplicantFactKind = (typeof APPLICANT_FACT_KINDS)[number];

/**
 * One document the applicant holds, as stored on their profile
 * (`users/{uid}.heldDocuments[]`).
 *
 * Exactly ONE of `issuerCountryCode` / `issuerAuthorityId` is set:
 *   - `issuerCountryCode`: the two-letter code of the country that issued it;
 *   - `issuerAuthorityId`: the id of a bloc or treaty authority
 *     (`authorities/{id}`, P1 of #228) when the applicant records the
 *     document as issued under that authority.
 * A rule's `holds` group matches the issuer EXACTLY as recorded: code never
 * widens a country to the bloc it belongs to, or a bloc to its members.
 */
export interface HeldDocument {
  // Server-made id, so the mobile screen can remove one document.
  id: string;
  kind: HeldDocumentKind;
  issuerCountryCode?: string;
  issuerAuthorityId?: string;
  // Calendar date "YYYY-MM-DD" (validated). A document whose date is in the
  // past is STORED (the applicant's own record) but reported `expired` and
  // never matches a rule.
  validUntil: string;
  // The applicant's own short note (for example "multiple entry"). Shown back
  // to them and to the agent side on the case copy; NEVER sent to any model.
  note?: string;
}

/**
 * One held document on an application's COPY. Same fields as the profile's,
 * plus whether it had already expired when the copy was taken (informative
 * only: rule matching always re-checks `validUntil` against the date the rule
 * is checked on).
 */
export interface ApplicantHeldDocument extends HeldDocument {
  expiredWhenTaken: boolean;
}

/**
 * The applicant's holdings, copied onto an application when it starts
 * (`applications/{id}.applicantFacts`). Absent on applications started before
 * #234 (assessment then falls back to the latest eligibility check's
 * nationality, dev data only).
 *
 * "Not stated" is kept apart from "none":
 *   - `nationalities: []`        the applicant has not said (everyone has one);
 *   - `residentialCountry: null` not said, or the profile value is not a
 *                                two-letter code (it is never guessed from it);
 *   - `heldDocuments: null`      the applicant never said what they hold;
 *     `heldDocuments: []`        the applicant said they hold none.
 * A rule that needs a fact that is not stated is "could not be assessed: we
 * need to know ...", never "applies" and never "does not apply".
 */
export interface ApplicantFacts {
  nationalities: string[];
  residentialCountry: string | null;
  heldDocuments: ApplicantHeldDocument[] | null;
  // When the copy was taken (the moment the application started).
  takenAt: Timestamp;
}

/**
 * Bounds on what the profile accepts (keeps documents small and stops a
 * client from filling a profile with junk). Plain constants, not plan limits.
 */
export const HOLDINGS_LIMITS = {
  maxNationalities: 5,
  maxHeldDocuments: 20,
  maxNoteChars: 200,
  // Earliest / latest `validUntil` accepted (a typo guard, not a rule).
  earliestValidUntil: "1990-01-01",
  latestValidUntil: "2100-12-31",
} as const;
