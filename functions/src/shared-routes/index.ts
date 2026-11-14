// ============================================
// Shared routes (issue #231, P2 of #228) — public surface
// ============================================
//
// For P4 (stacked rulebooks) and later parts, import from here:
//
//   resolveRouteStack(countryCode, visaTypeId)  -> Promise<RouteLayer[]>
//       the ordered rulebook stack of a visa record, read live:
//       shared layer(s) first (order of `inheritsFrom`), own layer LAST.
//   resolveApplicationStack(application)        -> Promise<RouteLayer[]>
//       the stack an application runs on (its stored `routeStack`, or live
//       when it has none).
//   resolveRouteStackFor(cc, visaId, inheritsFrom) -> Promise<RouteLayer[]>
//       same as resolveRouteStack when the caller already holds the record.
//   routeStackKeys(layers) -> string[]          what is stored on an application.
//   layersFromKeys(keys)   -> RouteLayer[] | undefined
//   buildRouteStack(cc, visaId, routes)         pure builder.
//   sharedRulebookKey / ownRulebookKey          the two key shapes.
//   sharedRouteService                          get / list / destinationsOn / countOpenUsing.

export { adminSharedRouteRoutes } from "./shared-route.routes";
export { sharedRouteService } from "./shared-route.service";
export { resolveApplicationStack, resolveRouteStack, resolveRouteStackFor } from "./route-stack";
export {
  buildRouteStack,
  checkSharedRouteId,
  inheritedIds,
  isApplicationOpen,
  layersFromKeys,
  ownRulebookKey,
  routeStackKeys,
  sharedRulebookKey,
  type SharedRouteIdCheck,
  type StackSharedRoute,
} from "./shared-route-rules";
export * from "../types/shared-route";
