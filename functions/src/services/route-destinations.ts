// ============================================
// ROUTE DESTINATIONS AS ANSWER OPTIONS (issue #235, P6 of #228)
// ============================================
//
// A shared rulebook's "which country" questions (`optionsFrom:
// "route_destinations"`) store NO country: their options are the member
// countries of the shared route, read from MEMBERSHIP DATA (P1
// `expandDestinations`, through P2 `sharedRouteService.destinationsOn`) on the
// day the question is asked. This module is the one place that turns a
// rulebook key into those options, so the intake service and the "apply
// through" service list exactly the same countries.
//
//   destinationsOfRulebookKey(key, on)  -> string[]     member codes (sorted)
//   destinationOptions(codes)           -> IntakeOption[] { value: code, label: country name }
//   withDestinationOptions(questions, defaultKey, on) -> questions with options filled
//
// A key that is not a shared route's (a country's own key, an unknown or
// retired route) has no destinations: such a question then offers only its
// stored non-country options. Nothing here names a country or bloc.

import type { IntakeOption, IntakeQuestion } from "../types/rubric";
import { splitRulebookKey, todayUtc } from "../authorities/authority-ids";
import { sharedRouteService } from "../shared-routes/shared-route.service";
import { visaService } from "./visa.service";

/**
 * The reads this module makes, swappable by tests (no Firestore needed).
 *  - `destinationsOf(sharedRouteId, on)`: the route's member codes on that day,
 *    [] for an unknown or retired route.
 *  - `countryName(code)`: the catalogue's name for a country (the code when none).
 */
export const routeDestinationReader = {
  async destinationsOf(sharedRouteId: string, on: string): Promise<string[]> {
    const route = await sharedRouteService.get(sharedRouteId);
    if (!route || route.status !== "active") return [];
    return sharedRouteService.destinationsOn(route, on);
  },
  async countryName(code: string): Promise<string> {
    const country = await visaService.getCountryByCode(code);
    return country?.name || code;
  },
};

/**
 * The member country codes of the shared route a rulebook key belongs to, on
 * `on` ("YYYY-MM-DD", default today UTC). A shared layer's key is
 * `{issuingAuthorityId}_{sharedRouteId}` with a bloc / treaty authority id; any
 * other key (a country's own) has no destinations.
 */
export async function destinationsOfRulebookKey(rulebookKey: string, on?: string): Promise<string[]> {
  const split = splitRulebookKey(rulebookKey);
  if (!split.ok || split.authorityIdKind !== "group") return [];
  return routeDestinationReader.destinationsOf(split.routeSlug, on ?? todayUtc());
}

/** One option per country code, labelled with the catalogue's country name, in the given order. */
export async function destinationOptions(codes: readonly string[]): Promise<IntakeOption[]> {
  const names = await Promise.all(codes.map((c) => routeDestinationReader.countryName(c)));
  return codes.map((value, i) => ({ value, label: names[i] }));
}

/**
 * The questions with every destination question's options filled in: the
 * member countries first (from membership data on `on`), then the question's
 * own stored non-country options. Other questions are returned unchanged (the
 * same objects); a list with no destination question is returned as it is.
 *
 * @param questions  the served questions (a merged stack's carry `layerKey`)
 * @param defaultKey the rulebook key to use for a question with no `layerKey`
 *                   (a single-layer read: the rulebook's own key)
 */
export async function withDestinationOptions(questions: IntakeQuestion[], defaultKey: string, on?: string): Promise<IntakeQuestion[]> {
  if (!questions.some((q) => q.optionsFrom === "route_destinations")) return questions;
  // One membership read per layer key, however many questions use it.
  const cache = new Map<string, Promise<IntakeOption[]>>();
  const optionsFor = (key: string) => {
    if (!cache.has(key)) cache.set(key, destinationsOfRulebookKey(key, on).then(destinationOptions));
    return cache.get(key) as Promise<IntakeOption[]>;
  };
  return Promise.all(
    questions.map(async (q) => {
      if (q.optionsFrom !== "route_destinations") return q;
      const members = await optionsFor(q.layerKey ?? defaultKey);
      const own = (q.options ?? []).filter((o) => !members.some((m) => m.value === o.value));
      return { ...q, options: [...members, ...own] };
    })
  );
}
