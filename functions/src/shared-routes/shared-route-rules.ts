import type { ApplicationStatus } from "../types/index";
import type { RouteLayer, SharedRouteRef } from "../types/shared-route";
import { buildRulebookKey, splitRulebookKey } from "../authorities/authority-ids";

// ============================================
// SHARED ROUTES — PURE RULES (issue #231, P2 of #228)
// ============================================
//
// No Firebase here: the rules that decide ids, rulebook keys, the layer order
// and "is this application still open" are unit tested directly.

/** A shared route id: lower case, digits, hyphens; 3 to 60 characters; no underscore (R5 in the overview). */
export const SHARED_ROUTE_ID_RE = /^[a-z0-9][a-z0-9-]{2,59}$/;

/** What `checkSharedRouteId` answers. */
export type SharedRouteIdCheck = { ok: true; id: string } | { ok: false; code: "INVALID_SHARED_ROUTE_ID"; message: string };

/** Validate a shared route id. */
export function checkSharedRouteId(raw: unknown): SharedRouteIdCheck {
  if (typeof raw !== "string" || !SHARED_ROUTE_ID_RE.test(raw)) {
    return {
      ok: false,
      code: "INVALID_SHARED_ROUTE_ID",
      message: "A shared route id is 3 to 60 characters: lower-case letters, digits and hyphens, with no underscore",
    };
  }
  return { ok: true, id: raw };
}

/**
 * Statuses that END an application. Mirrors `TERMINAL_STATUSES` in
 * services/application.service.ts (the "not active" set of #253); any other
 * status is an OPEN application. Kept here (pure) so the 409 rules and their
 * tests need no service import.
 */
export const CLOSED_APPLICATION_STATUSES: readonly ApplicationStatus[] = ["approved", "rejected", "withdrawn", "expired"];

/** Is the application still open (not approved, rejected, withdrawn or expired)? */
export function isApplicationOpen(status: ApplicationStatus): boolean {
  return !CLOSED_APPLICATION_STATUSES.includes(status);
}

/** The rulebook key of a shared route's layer: `{issuingAuthorityId}_{sharedRouteId}`. */
export function sharedRulebookKey(issuingAuthorityId: string, sharedRouteId: string): string {
  return buildRulebookKey(issuingAuthorityId, sharedRouteId);
}

/** The rulebook key of a country's own layer: `{countryCode}_{visaTypeId}` (unchanged from today). */
export function ownRulebookKey(countryCode: string, visaTypeId: string): string {
  return `${countryCode}_${visaTypeId}`;
}

/** A shared route as the stack builder needs it. */
export interface StackSharedRoute {
  id: string;
  issuingAuthorityId: string;
}

/**
 * Build the ordered stack from already-loaded shared routes.
 *
 * `sharedRoutes` must be in the ORDER OF `inheritsFrom` (the caller resolves
 * the references; a retired or missing route is simply not passed). Shared
 * layers come first in that order, the country's own layer is always last.
 * With no shared routes the result is the own layer alone, which is how every
 * existing route behaves.
 */
export function buildRouteStack(countryCode: string, visaTypeId: string, sharedRoutes: readonly StackSharedRoute[]): RouteLayer[] {
  const shared: RouteLayer[] = sharedRoutes.map((r) => ({
    authorityId: r.issuingAuthorityId,
    rulebookKey: sharedRulebookKey(r.issuingAuthorityId, r.id),
    role: "shared" as const,
  }));
  return [...shared, { authorityId: countryCode, rulebookKey: ownRulebookKey(countryCode, visaTypeId), role: "own" }];
}

/** The keys of a stack, in order: what an application stores as `routeStack`. */
export function routeStackKeys(layers: readonly RouteLayer[]): string[] {
  return layers.map((l) => l.rulebookKey);
}

/**
 * Read a stored `routeStack` (keys only) back into layers. The LAST key is the
 * country's own layer, every key before it is a shared layer. Returns
 * undefined when the value is not a usable stack (absent, empty, or a key that
 * is not `{authorityId}_{slug}`), so the caller falls back to resolving live.
 */
export function layersFromKeys(raw: unknown): RouteLayer[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const layers: RouteLayer[] = [];
  for (let i = 0; i < raw.length; i++) {
    const split = splitRulebookKey(raw[i]);
    if (!split.ok) return undefined;
    layers.push({ authorityId: split.authorityId, rulebookKey: raw[i] as string, role: i === raw.length - 1 ? "own" : "shared" });
  }
  return layers;
}

/** The shared route ids in a visa record's `inheritsFrom`, in order (anything malformed is ignored). */
export function inheritedIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((r) => (r && typeof (r as SharedRouteRef).sharedRouteId === "string" ? [(r as SharedRouteRef).sharedRouteId] : []));
}
