import { splitRulebookKey } from "../authorities/authority-ids";
import type { RulebookStackLayer } from "../types/rubric";
import { visaService } from "../services/visa.service";
import { sharedRouteService } from "./shared-route.service";

// ============================================
// THE RULEBOOK STACK, FOR THE APPLICANT'S APP (issue #237, P8 of #228)
// ============================================
//
// An application on a shared route is assessed on a STACK: the shared
// layer(s) first and the country's own layer last. Findings, checklist items
// and questions carry `layerKey` (the layer's rulebook key). The app needs to
// say whose rule each one is, so the intake, checklist and assessment reads
// also return:
//
//   stackLayers: [{ key, kind: "shared"|"country", countryCode?, countryName?,
//                   name? (the shared route's name), status: "ready"|"missing" }]
//
// `key` equals the `layerKey` of the items of that layer. Built from the
// existing stack read (`RulebookStackLayer`: key, authority, role, approved /
// missing); nothing new is read from the rulebooks. Names are read once per
// distinct layer.
//
// A single-layer route (no inheritance) has no stack list on the rubric, and
// its items carry no `layerKey`: the field is then OMITTED, as `layers` /
// `rulebookLayers` already are.

export interface PublicStackLayer {
  key: string;
  kind: "shared" | "country";
  countryCode?: string;
  countryName?: string;
  /** The shared route's name (shared layers). */
  name?: string;
  status: "ready" | "missing";
}

/** `layers` (the stored / served stack list) as the app's `stackLayers`; undefined for a single-layer route. */
export async function publicStackLayers(layers: readonly RulebookStackLayer[] | undefined): Promise<PublicStackLayer[] | undefined> {
  if (!layers || layers.length <= 1) return undefined;
  try {
    return await Promise.all(
      layers.map(async (l): Promise<PublicStackLayer> => {
        const status = l.status === "approved" ? "ready" : "missing";
        if (l.role === "own") {
          // The own layer's authority id is the country code.
          const country = await visaService.getCountryByCode(l.authorityId);
          return { key: l.rulebookKey, kind: "country", countryCode: l.authorityId, countryName: country?.name || l.authorityId, status };
        }
        // A shared layer's key is `{authority}_{sharedRouteId}`.
        const split = splitRulebookKey(l.rulebookKey);
        const route = split.ok ? await sharedRouteService.get(split.routeSlug) : undefined;
        return { key: l.rulebookKey, kind: "shared", ...(route ? { name: route.name } : {}), status };
      })
    );
  } catch (err) {
    // Names are a courtesy: never fail the read for them.
    console.error("Error building stackLayers:", err instanceof Error ? err.message : "unknown");
    return undefined;
  }
}

/** `{ stackLayers }` to spread into a response, or nothing. */
export async function stackLayersField(layers: readonly RulebookStackLayer[] | undefined): Promise<{ stackLayers?: PublicStackLayer[] }> {
  const s = await publicStackLayers(layers);
  return s ? { stackLayers: s } : {};
}
