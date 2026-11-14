import { collections, subcollections } from "../utils/firebase";
import type { Application } from "../types/index";
import type { RouteLayer, SharedRoute } from "../types/shared-route";
import { buildRouteStack, inheritedIds, layersFromKeys, routeStackKeys, type StackSharedRoute } from "./shared-route-rules";

// ============================================
// ROUTE RESOLVER (issue #231, P2 of #228)
// ============================================
//
// "What is the stack of rulebooks for this route?" asked in ONE place, so every
// part that today reads `countryCode` + `visaTypeId` (P4 stacked rulebooks, P6,
// P8) calls this instead of building keys itself.
//
//   resolveRouteStack(countryCode, visaTypeId)  -> RouteLayer[]
//   resolveApplicationStack(application)        -> RouteLayer[]
//   routeStackKeys(layers)                      -> string[]   (what is stored on an application)
//
// The result is ORDERED: the shared layer(s) first, in the order of the visa
// record's `inheritsFrom`, then the country's own layer LAST. A visa with no
// `inheritsFrom` (every existing one) gets just the own layer, whose key is
// `{countryCode}_{visaTypeId}` exactly as today, so behaviour is unchanged.
//
// A shared layer is included only while its shared route is ACTIVE: a missing
// or retired route contributes nothing (retiring is refused while an open
// application could still need it, so this only affects new resolutions).
//
// The resolver does NOT check visibility (`isVisaPubliclyVisible`): who may
// see a record stays the job of the callers that already apply it.

export { buildRouteStack, layersFromKeys, routeStackKeys };
export type { RouteLayer };

/**
 * Resolve the stack when the caller already holds the visa record's
 * `inheritsFrom` (saves a read). `inheritsFrom` is whatever the record stores;
 * malformed entries are ignored.
 */
export async function resolveRouteStackFor(countryCode: string, visaTypeId: string, inheritsFrom: unknown): Promise<RouteLayer[]> {
  const ids = inheritedIds(inheritsFrom);
  // Fast path: no inheritance, no reads at all.
  if (ids.length === 0) return buildRouteStack(countryCode, visaTypeId, []);
  const snaps = await Promise.all(ids.map((id) => collections.sharedRoutes.doc(id).get()));
  const routes: StackSharedRoute[] = [];
  for (const snap of snaps) {
    if (!snap.exists) continue;
    const route = snap.data() as SharedRoute;
    if (route.status !== "active") continue;
    routes.push({ id: route.id, issuingAuthorityId: route.issuingAuthorityId });
  }
  return buildRouteStack(countryCode, visaTypeId, routes);
}

/**
 * The ordered stack for a country's visa record, read live:
 * `[...shared layers in inheritsFrom order, own layer]`.
 * A record that does not exist resolves to the own layer alone (the key that
 * rulebooks already use, record or not).
 */
export async function resolveRouteStack(countryCode: string, visaTypeId: string): Promise<RouteLayer[]> {
  const snap = await subcollections.visaTypes(countryCode).doc(visaTypeId).get();
  const inheritsFrom = snap.exists ? (snap.data() as { inheritsFrom?: unknown }).inheritsFrom : undefined;
  return resolveRouteStackFor(countryCode, visaTypeId, inheritsFrom);
}

/**
 * The stack an APPLICATION runs on: the `routeStack` stored when it started
 * (so a later change of `inheritsFrom` never rewrites a running application),
 * or, for an application that has none (started before P2), a live resolve.
 */
export async function resolveApplicationStack(application: Pick<Application, "countryCode" | "visaTypeId" | "routeStack">): Promise<RouteLayer[]> {
  return layersFromKeys(application.routeStack) ?? resolveRouteStack(application.countryCode, application.visaTypeId);
}
