import type { Application } from "../../types";
import type { VisaRubric } from "../../types/rubric";
import type { RouteLayer } from "../../types/shared-route";
// The scrapers module through its public entry point (ESLint boundary, #91).
import { loadRulebookStack, rubricStore, stackFromReads, type RulebookStack } from "../../scrapers";
// Directly from the resolver (not the module index, which also loads the admin routes).
import { resolveApplicationStack } from "../../shared-routes/route-stack";

// ============================================
// AN APPLICATION'S RULEBOOK (issue #233, P4a of #228)
// ============================================
//
// The ONE question every consumer asks: "which rules does this application run
// on?" Answer: the merged stack of its route (scrapers/rubric/rubric-stack.ts),
// resolved from the application's stored `routeStack`, or live when it has none
// (shared-routes `resolveApplicationStack`). For an application on a visa with
// no inheritance (every application today) the stack is its own layer
// `{countryCode}_{visaTypeId}` alone, and the result is exactly the approved
// rubric `getApprovedRubric(countryCode, visaTypeId)` returned before.
//
// Consumers (assessment, bulk re-assessment, intake, checklist, document
// check, chat) inject a reader. A reader with `getRulebookStack` reads the
// whole stack; a reader that only has the historic `getApprovedRubric(cc, vt)`
// (a test fake written before #233) reads the own layer alone, which is the
// stack of every route without inheritance.
//
// Data isolation: this reads rulebooks only (public rules data); access to the
// APPLICATION is checked by each caller before it calls this, as before.

/** The reads a consumer injects. `getRulebookStack` is set by every default dependency set. */
export interface ApplicationRulebookReader {
  getApprovedRubric(countryCode: string, visaTypeId: string): Promise<VisaRubric | null>;
  getRulebookStack?(app: ApplicationStackRef): Promise<RulebookStack>;
}

/** What of an application the stack read needs. */
export type ApplicationStackRef = Pick<Application, "countryCode" | "visaTypeId" | "routeStack">;

/** The application's own layer (its route key, unchanged since before #233). */
export function ownLayerOf(app: Pick<Application, "countryCode" | "visaTypeId">): RouteLayer {
  return { authorityId: app.countryCode, rulebookKey: `${app.countryCode}_${app.visaTypeId}`, role: "own" };
}

/**
 * The default stack read: resolve the application's stack (stored, else live)
 * and load every layer's approved version. Used by the default dependencies of
 * every consumer.
 */
export async function defaultRulebookStack(app: ApplicationStackRef): Promise<RulebookStack> {
  const layers = await resolveApplicationStack(app);
  // The OWN layer is read through `getApprovedRubric(countryCode, visaTypeId)`,
  // the very read every consumer made before #233 (it is the by-key read with
  // the country checks); a SHARED layer through the by-key read. Both carry
  // all the store's guarantees (approved only, exclusions applied).
  return loadRulebookStack(layers, (layer) =>
    layer.role === "own" && layer.rulebookKey === ownLayerOf(app).rulebookKey ? rubricStore.getApprovedRubric(app.countryCode, app.visaTypeId) : rubricStore.getApprovedRubricByKey(layer.rulebookKey)
  );
}

/**
 * The stack an application runs on, through the consumer's reader. See the
 * file header for the two kinds of reader.
 */
export async function rulebookStackFor(app: ApplicationStackRef, reader: ApplicationRulebookReader): Promise<RulebookStack> {
  if (reader.getRulebookStack) return reader.getRulebookStack(app);
  const rubric = await reader.getApprovedRubric(app.countryCode, app.visaTypeId);
  return stackFromReads([{ layer: ownLayerOf(app), rubric }]);
}

/**
 * The rubric an application runs on (the merged view), or null when its stack
 * is not usable (no layer approved, or the stack plan refused it). Exactly
 * `getApprovedRubric` for a single-layer route.
 */
export async function rulebookFor(app: ApplicationStackRef, reader: ApplicationRulebookReader): Promise<VisaRubric | null> {
  const stack = await rulebookStackFor(app, reader);
  return stack.usable ? stack.rubric : null;
}
