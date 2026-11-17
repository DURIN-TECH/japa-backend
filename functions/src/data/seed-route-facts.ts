import type { VisaSourcedFact, VisaSourcedFacts } from "../types";
import type { SharedRouteRef } from "../types/shared-route";
import { routeFactsFor, type DataRouteFactSource, type RouteFactsFor, type SharedVisaData } from "./shared-visa-data-format";

// ============================================
// SEED — THE SOURCED PROCESSING TIME AND STAY LIMIT OF A SHARED ROUTE (issue #339)
// ============================================
//
// WHY THIS EXISTS
// A shared route's official source can set one processing time and one stay
// limit for every member country. The data file (shared-visa-data.ts)
// records each fact once, on the route, with its verbatim quote(s). Every
// reader in the app (the visa screen's "Processing time" and "Valid for"
// rows) reads the visa record's own `processingTime` / `validityPeriod`, so
// the seed writes the fact onto each record the data file lists under the
// route's `inheritedBy`, with a `sourcedFacts` citation per fact.
//
// This is the sibling of seed-sourced-fee.ts and follows the same rules,
// minus the currency conversion (nothing here is converted or computed:
// the values are written exactly as the data file gives them).
//
// WHAT THIS MODULE DECIDES (no Firebase call: the seed does the reads)
// For one seed visa record:
//   1. The record takes on no route facts            -> "none": untouched,
//      its own fields (if any) are written exactly as before.
//   2. The stored `inheritsFrom` no longer names the route -> "omit": no
//      route fact is written (a stored `inheritsFrom` wins over the data
//      file, see buildVisaTypeDoc and planSourcedFee).
//   3. Per fact: the stored official source (`guidanceSources/{id}`) does
//      not exist                                     -> that fact is left out.
//   4. Otherwise                                     -> "write" the facts
//      left, each with its citation. None left       -> "omit".
// A value is NEVER guessed: a fact the route does not state (for example a
// minimum processing time) is simply absent, never 0, "" or false.
//
// No bloc, country or figure is named here: they are in the data file.

/** The fields `buildVisaTypeDoc` writes for a record with sourced route facts. */
export interface RouteFactFields {
  /** From the route's `processing` block (absent when it has none or it was left out). */
  processingTime?: string;
  processingDaysMin?: number;
  processingDaysMax?: number;
  /** From the route's `validity` block. */
  validityPeriod?: string;
  /** One citation per fact written above (always at least one key). */
  sourcedFacts: VisaSourcedFacts;
}

/** What the seed should do about one record's route facts. */
export type RouteFactsDecision =
  /** The record takes on no route facts: this logic does not touch it. */
  | { action: "none" }
  /** Write these fields. `skipped` lists any fact left out, with why (for the seed log). */
  | { action: "write"; fields: RouteFactFields; skipped: string[] }
  /** Write no route fact at all (the seed logs `reason`). */
  | { action: "omit"; reason: string };

/** The fields of a decision that carries facts ("write"), else undefined. */
export function routeFactFields(decision: RouteFactsDecision): RouteFactFields | undefined {
  return decision.action === "write" ? decision.fields : undefined;
}

/** The citation stored for one fact: the route plus a copy of the block's source. */
function citationOf(sharedRouteId: string, source: DataRouteFactSource): VisaSourcedFact {
  return { sharedRouteId, quote: [...source.quote], url: source.url, guidanceSourceId: source.guidanceSourceId };
}

/**
 * Decide what the seed writes for one record's route facts.
 *
 * @param routeFacts  the route facts the DATA FILE gives this record
 *                    (`routeFactsFor`); `[]` for every record it does not list
 * @param existing    the stored visa doc, if any
 * @param guidanceSourceExists  whether `guidanceSources/{id}` exists, per id
 */
export function planRouteFacts(params: {
  routeFacts: RouteFactsFor[];
  existing: Record<string, unknown> | undefined;
  guidanceSourceExists: (guidanceSourceId: string) => boolean;
}): RouteFactsDecision {
  const { routeFacts, existing } = params;
  // ---- 1. Not a record the data file gives facts: leave it alone ----
  if (routeFacts.length === 0) return { action: "none" };
  // More than one source is refused before any write (`seedRouteFactProblems`);
  // this guard only keeps the function total.
  if (routeFacts.length > 1) return { action: "omit", reason: `it takes route facts from more than one shared route (${routeFacts.map((r) => r.sharedRouteId).join(", ")})` };
  const route = routeFacts[0];

  // ---- 2. A stored `inheritsFrom` wins over the data file ----
  // If an admin has since pointed the record at other routes, it no longer
  // inherits this one, so it must not take this route's facts.
  const storedInherits = Array.isArray(existing?.inheritsFrom) ? (existing!.inheritsFrom as SharedRouteRef[]) : [];
  if (storedInherits.length > 0 && !storedInherits.some((r) => r?.sharedRouteId === route.sharedRouteId)) {
    return { action: "omit", reason: `the stored record no longer inherits "${route.sharedRouteId}"` };
  }

  // ---- 3. Each fact needs its official source on record ----
  const skipped: string[] = [];
  const sourcedFacts: VisaSourcedFacts = {};
  const fields: Omit<RouteFactFields, "sourcedFacts"> = {};

  const { processing, validity } = route;
  if (processing) {
    if (!params.guidanceSourceExists(processing.guidanceSourceId)) {
      skipped.push(`processing: guidanceSources/${processing.guidanceSourceId} does not exist`);
    } else {
      fields.processingTime = processing.processingTime;
      // Only the day counts the route states (an unstated one stays absent).
      if (processing.processingDaysMin !== undefined) fields.processingDaysMin = processing.processingDaysMin;
      if (processing.processingDaysMax !== undefined) fields.processingDaysMax = processing.processingDaysMax;
      sourcedFacts.processing = citationOf(route.sharedRouteId, processing);
    }
  }
  if (validity) {
    if (!params.guidanceSourceExists(validity.guidanceSourceId)) {
      skipped.push(`validity: guidanceSources/${validity.guidanceSourceId} does not exist`);
    } else {
      fields.validityPeriod = validity.validityPeriod;
      sourcedFacts.validity = citationOf(route.sharedRouteId, validity);
    }
  }

  // ---- 4. Write what is left, or nothing ----
  if (Object.keys(sourcedFacts).length === 0) return { action: "omit", reason: skipped.join("; ") || "the route records no fact" };
  return { action: "write", fields: { ...fields, sourcedFacts }, skipped };
}

/** The part of a seed visa entry the fact checks read. */
export interface SeedRouteFactEntry {
  id: string;
  countryCode: string;
  processingTime?: string;
  processingDaysMin?: number;
  processingDaysMax?: number;
  validityPeriod?: string;
}

/**
 * Problems that must STOP the seed before it writes anything (issue #339,
 * the same two-sources rule as `seedFeeProblems`): a fact cannot have two sources.
 *  - a seed entry that sets a processing field (`processingTime`,
 *    `processingDaysMin`, `processingDaysMax`) while a route it inherits
 *    records a processing time;
 *  - a seed entry that sets `validityPeriod` while a route it inherits
 *    records a stay limit;
 *  - a seed entry that takes route facts from more than one shared route.
 * Returns one line per problem, `[]` when there is none.
 */
export function seedRouteFactProblems(visas: SeedRouteFactEntry[], data: SharedVisaData): string[] {
  const problems: string[] = [];
  for (const visa of visas) {
    const routeFacts = routeFactsFor(data, visa.countryCode, visa.id);
    if (routeFacts.length === 0) continue;
    const at = `${visa.countryCode}/${visa.id}`;
    const withProcessing = routeFacts.filter((r) => r.processing).map((r) => `"${r.sharedRouteId}"`);
    const withValidity = routeFacts.filter((r) => r.validity).map((r) => `"${r.sharedRouteId}"`);
    // Every processing field the entry sets itself, by name.
    const ownProcessing = (["processingTime", "processingDaysMin", "processingDaysMax"] as const).filter((f) => visa[f] !== undefined);
    if (withProcessing.length > 0 && ownProcessing.length > 0) {
      problems.push(`${at} has its own ${ownProcessing.join(", ")} in the seed and also inherits a shared route with a processing time (${withProcessing.join(", ")}): a fact cannot have two sources`);
    }
    if (withValidity.length > 0 && visa.validityPeriod !== undefined) {
      problems.push(`${at} has its own validityPeriod in the seed and also inherits a shared route with a stay limit (${withValidity.join(", ")}): a fact cannot have two sources`);
    }
    if (routeFacts.length > 1) {
      problems.push(`${at} inherits more than one shared route with route facts (${routeFacts.map((r) => `"${r.sharedRouteId}"`).join(", ")}): a fact cannot have two sources`);
    }
  }
  return problems;
}
