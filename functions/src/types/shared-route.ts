import type { Timestamp } from "firebase-admin/firestore";
import type { VisaCategory } from "./index";

// ============================================
// SHARED ROUTES AND ROUTE STACKS — TYPES (issue #231, P2 of #228)
// ============================================
//
// A SHARED ROUTE is a visa defined ONCE by an issuing authority (a bloc or a
// treaty, see types/authority.ts) and inherited by the ordinary visa record
// of each member country that offers it. The applicant still applies through
// one member country's record (`countries/{cc}/visaTypes/{id}`), so every
// country-keyed place (agency prices, listing screening, revisions, rule
// change alerts) keeps keying on that record and nothing moves.
//
// Storage (backend-only: no firestore.rules match, clients are denied, like
// `authorities`; every write is audited in the source registry's trail):
//
//   sharedRoutes/{sharedRouteId}                        SharedRoute
//   countries/{cc}/visaTypes/{id}.inheritsFrom          SharedRouteRef[]  (optional)
//   applications/{id}.routeStack                        string[]          (optional)
//
// No bloc, country or visa is named in code: all of it is data an admin
// enters. Nothing here is seeded.

/** Lifecycle. Never deleted (rulebooks and applications point at it); one that no longer applies is `retired`. */
export const SHARED_ROUTE_STATUSES = ["active", "retired"] as const;
export type SharedRouteStatus = (typeof SHARED_ROUTE_STATUSES)[number];

/**
 * Which countries a shared route can be offered in.
 *  - `listed`:     the admin lists the country codes.
 *  - `members_of`: every current member of an authority (resolved on a date
 *                  through membership data, `expandDestinations`).
 */
export type SharedRouteDestinations = { mode: "listed"; countryCodes: string[] } | { mode: "members_of"; authorityId: string };

/** `sharedRoutes/{sharedRouteId}`. */
export interface SharedRoute {
  /** Same as the document id. Letters (lower case), digits and hyphens: NO underscore (it separates the parts of a rulebook key). */
  id: string;
  name: string;
  category: VisaCategory;
  /** The bloc or treaty that owns the route and its rulebook. Never changes (it is part of the rulebook key). */
  issuingAuthorityId: string;
  destinations: SharedRouteDestinations;
  status: SharedRouteStatus;
  createdBy: string;
  createdAt: Timestamp;
  updatedBy: string;
  updatedAt: Timestamp;
}

/** One entry of a visa record's `inheritsFrom`. An object (not a bare string) so it can grow fields later. */
export interface SharedRouteRef {
  sharedRouteId: string;
}

/** Which kind of layer a rulebook stack entry is. */
export type RouteLayerRole = "shared" | "own";

/**
 * One layer of a route's stack: whose rulebook, which key, and the role.
 * For `own` layers `authorityId` is the country code and `rulebookKey` is
 * `{countryCode}_{visaTypeId}` (the key that exists today); for `shared`
 * layers `authorityId` is the issuing authority and the key is
 * `{issuingAuthorityId}_{sharedRouteId}`.
 */
export interface RouteLayer {
  authorityId: string;
  rulebookKey: string;
  role: RouteLayerRole;
}
