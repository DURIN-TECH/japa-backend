import { collectionGroups } from "../utils/firebase";
import type { VisaType } from "../types/index";
import type { SharedRoute } from "../types/shared-route";
import { sharedRouteService } from "./shared-route.service";
import { isVisaPubliclyVisible, visaService } from "../services/visa.service";

// ============================================
// SHARED ROUTE ON PUBLIC VISA READS (issue #237, P8 of #228)
// ============================================
//
// The mobile destination and visa screens need to say "this visa is one route
// shared by several countries" and list those countries. Every public visa
// read (country visa list, single visa, /full, /visas, /visas/search,
// /visas/popular) therefore gets one extra field:
//
//   sharedRoute: { id, name, covers: [{ countryCode, countryName }] } | null
//
//  - `null` when the visa record has no `inheritsFrom`, when none of the routes
//    it inherits exists / is active (a retired route is offered to nobody).
//  - `covers` = the route's destinations TODAY, limited to the countries that
//    have a PUBLICLY VISIBLE visa record inheriting the route (the app must
//    never list a country it cannot offer: a member with a draft, pending,
//    inactive or agency-only record is left out).
//
// Cost: reads are batched per request, not per visa. For N visas that inherit
// R distinct routes: R shared-route reads, R destination expansions, R
// collection-group queries for the member records, and one country-name read
// per distinct covered country. Never one read per visa.
//
// What is exposed: the route's id and name and each covered country's code and
// name. Never the rulebook, members' quotes, audit data or any admin field.

/** The public shape of a shared route on a visa read. */
export interface PublicSharedRoute {
  id: string;
  name: string;
  covers: { countryCode: string; countryName: string }[];
}

/** Any visa-shaped object (a full record or an applicant-safe projection); only `inheritsFrom` is read, when present. */
type WithInherits = object;

/** The routes a visa-shaped object inherits, in order ([] when the field is absent). */
const inheritedOf = (v: WithInherits): NonNullable<VisaType["inheritsFrom"]> => (v as Pick<VisaType, "inheritsFrom">).inheritsFrom ?? [];

/** Resolve one ACTIVE route's public view (covers filtered to publicly offered countries). */
async function buildPublicRoute(route: SharedRoute, countryNames: Map<string, Promise<string>>): Promise<PublicSharedRoute> {
  // Today's destinations (listed codes, or the authority's current members).
  const destinations = new Set(await sharedRouteService.destinationsOn(route));
  // ONE collection-group query for every record that inherits this route
  // (the `inheritsFrom` array-contains index already exists, see
  // firestore.indexes.json), then the public visibility rule in code, exactly
  // as the public list reads apply it.
  const records = await collectionGroups.visaTypes().where("inheritsFrom", "array-contains", { sharedRouteId: route.id }).get();
  const offered = new Set<string>();
  for (const doc of records.docs) {
    const v = doc.data() as VisaType;
    if (destinations.has(v.countryCode) && isVisaPubliclyVisible(v)) offered.add(v.countryCode);
  }
  // Names: one lookup per distinct country across the whole request.
  const codes = [...offered].sort();
  const names = await Promise.all(
    codes.map((code) => {
      if (!countryNames.has(code)) {
        countryNames.set(code, visaService.getCountryByCode(code).then((c) => c?.name || code));
      }
      return countryNames.get(code) as Promise<string>;
    })
  );
  const covers = codes.map((countryCode, i) => ({ countryCode, countryName: names[i] }));
  // Alphabetical by name for display (code breaks ties), so the app needs no sorting.
  covers.sort((a, b) => a.countryName.localeCompare(b.countryName) || a.countryCode.localeCompare(b.countryCode));
  return { id: route.id, name: route.name, covers };
}

/**
 * Add `sharedRoute` to each visa (see the header). Returns NEW objects, input
 * untouched, same order. A visa that inherits several routes gets the first,
 * in `inheritsFrom` order, that is still active.
 *
 * Best effort: if the shared-route reads fail, every visa gets `sharedRoute:
 * null` (the visa itself is still returned; null never lists a country that
 * cannot be offered) and the error is logged.
 */
export async function attachSharedRoutes<T extends WithInherits>(visas: T[]): Promise<Array<T & { sharedRoute: PublicSharedRoute | null }>> {
  const ids = new Set<string>();
  for (const v of visas) for (const ref of inheritedOf(v)) ids.add(ref.sharedRouteId);
  // Fast path: nothing inherits, no reads at all (the common case today).
  if (ids.size === 0) return visas.map((v) => ({ ...v, sharedRoute: null }));

  const resolved = new Map<string, PublicSharedRoute | null>();
  try {
    const countryNames = new Map<string, Promise<string>>();
    await Promise.all(
      [...ids].map(async (id) => {
        const route = await sharedRouteService.get(id);
        // Unknown or retired: null (never offered).
        resolved.set(id, route && route.status === "active" ? await buildPublicRoute(route, countryNames) : null);
      })
    );
  } catch (err) {
    console.error("Error reading shared routes for visa reads:", err);
    return visas.map((v) => ({ ...v, sharedRoute: null }));
  }
  return visas.map((v) => {
    const first = inheritedOf(v).map((r) => resolved.get(r.sharedRouteId)).find((r): r is PublicSharedRoute => !!r);
    return { ...v, sharedRoute: first ?? null };
  });
}
