import type { Timestamp } from "firebase-admin/firestore";

// ============================================
// ISSUING AUTHORITIES AND BLOC MEMBERSHIP — TYPES (issue #230, P1 of #228)
// ============================================
//
// An AUTHORITY is whoever sets the rules for a visa: a single country, a bloc
// of countries, or a treaty between countries. A country is simply an
// authority of kind "country" whose id is its two-letter code, so every
// existing country-keyed record (rulebooks `{countryCode}_{visaTypeId}`,
// official websites, visa sources) already reads as an authority key and
// nothing has to move.
//
// MEMBERSHIP (which countries belong to a bloc or treaty, and from when to
// when) is a LEGAL CLAIM. It is never inferred, seeded from memory or written
// by code: an admin records each member with the verbatim sentence from an
// official page and that page's address. A member without both is refused.
//
// Storage (both backend-only: no firestore.rules match, so client SDKs are
// denied, like `visaRubrics` and the source registry):
//
//   authorities/{authorityId}                        Authority
//   authorities/{authorityId}/members/{countryCode}  AuthorityMember
//
// Every write is audited in the source registry's append-only trail (see
// scrapers/shared/registry/registry-audit.ts).
//
// Pure module: types and constant lists only. No Firebase call, no SDK, and
// no country, bloc or nationality named anywhere: authorities are data.
//
// Later parts build on these: P2 (shared routes owned by an authority), P3
// (official websites belong to an authority), P4 (rulebooks keyed
// `{authorityId}_{routeSlug}`), P5/P7 ("members of authority X on date D").

// ============================================
// Enumerations
// ============================================

/**
 * What kind of body sets the rules.
 *  - `country`: one state. Id = its upper-case two-letter country code.
 *  - `bloc`:    a standing group of states with shared rules.
 *  - `treaty`:  an agreement between states (for example a joint visa).
 * `bloc` and `treaty` behave the same in code (both have members); the kind
 * only records what the official source calls it.
 */
export const AUTHORITY_KINDS = ["country", "bloc", "treaty"] as const;
export type AuthorityKind = (typeof AUTHORITY_KINDS)[number];

/** Kinds that have members (every kind except `country`). */
export const MEMBERSHIP_KINDS = ["bloc", "treaty"] as const satisfies readonly AuthorityKind[];
export type MembershipKind = (typeof MEMBERSHIP_KINDS)[number];

/**
 * Lifecycle. An authority is never deleted (rulebooks and audit entries point
 * at it); one that no longer applies is `retired`.
 */
export const AUTHORITY_STATUSES = ["active", "retired"] as const;
export type AuthorityStatus = (typeof AUTHORITY_STATUSES)[number];

// ============================================
// Stored documents
// ============================================

/** `authorities/{authorityId}`. */
export interface Authority {
  /** Same as the document id (stored too, so a listed doc is self-describing). */
  id: string;
  kind: AuthorityKind;
  /** Display name as the official source writes it. Plain text, never empty. */
  name: string;
  status: AuthorityStatus;
  /** uid of the admin who created it. */
  createdBy: string;
  createdAt: Timestamp;
  /** uid of the admin who last changed it (same as createdBy until an edit). */
  updatedBy: string;
  updatedAt: Timestamp;
}

/**
 * `authorities/{authorityId}/members/{countryCode}`: one country's membership
 * of a bloc or treaty.
 *
 * Dates are CALENDAR dates as "YYYY-MM-DD" strings, not Timestamps: a legal
 * text says "from 1 March", not an instant in a time zone, and the string
 * form compares correctly as text. The membership is the half-open range
 * [joinedOn, leftOn): a country is a member ON `joinedOn` and is no longer a
 * member ON `leftOn` (the day it left).
 */
export interface AuthorityMember {
  /** Upper-case two-letter code; same as the document id. */
  countryCode: string;
  /** First day of membership, "YYYY-MM-DD". */
  joinedOn: string;
  /** First day it is NO LONGER a member, "YYYY-MM-DD". Absent while it is still a member. */
  leftOn?: string;
  /** The sentence from the official page that states the membership, verbatim. */
  sourceQuote: string;
  /** The official page (https, on a confirmed official host). */
  sourceUrl: string;
  createdBy: string;
  createdAt: Timestamp;
  updatedBy: string;
  updatedAt: Timestamp;
}

// ============================================
// Rulebook keys
// ============================================

/**
 * A rulebook key split into its parts (see `splitRulebookKey` in
 * authorities/authority-ids.ts). For a country authority the key is today's
 * `{countryCode}_{visaTypeId}`, so `routeSlug` is the visa type id.
 */
export interface RulebookKeyParts {
  authorityId: string;
  /** Which shape the id has: a country code or a bloc/treaty id. */
  authorityIdKind: "country" | "group";
  routeSlug: string;
}
