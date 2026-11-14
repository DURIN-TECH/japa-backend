import type { Timestamp } from "firebase-admin/firestore";
import type { FxRatesDoc, VisaSourcedFee } from "../types";
import type { SharedRouteRef } from "../types/shared-route";
// Through the scrapers module's public entry point (its boundary rule, see src/scrapers/README.md).
import { computeFee } from "../scrapers";
import { routeFeesFor, type RouteFeeFor, type SharedVisaData } from "./shared-visa-data-format";

// ============================================
// SEED — THE SOURCED FEE OF A SHARED ROUTE (issue #299)
// ============================================
//
// WHY THIS EXISTS
// A shared route's official source can set one government fee for every
// member country. The data file (shared-visa-data.ts) records that fact once,
// on the route, in the source's own currency, with its verbatim quote. Every
// price reader in the app reads a visa record's stored `baseCostUsd`, so the
// seed writes the USD figure onto each record the data file lists under the
// route's `inheritedBy`, with a `sourcedFee` block that says where it came
// from and at which dated rate it was converted.
//
// WHAT THIS MODULE DECIDES (its functions make no Firebase call: the seed does the reads)
// For one seed visa record: write a freshly converted fee, keep the stored
// one, or write none. The rules:
//   1. The record takes on no route fee              -> "none": untouched,
//      its own `baseCostUsd` (if any) is written exactly as before.
//   2. The stored official source does not exist     -> "omit": no fee.
//   3. The rate is usable (`computeFee` gives a USD figure) -> "write".
//   4. No usable rate (missing, stale, or the currency is not in it):
//        a. the record already stores a fee for the SAME route, amount,
//           currency and quote                       -> "keep" it unchanged;
//        b. otherwise                                -> "omit": no fee.
// A figure is NEVER guessed, never 0, and an old figure is never kept for an
// amount the data file has since changed.
//
// The conversion itself is `computeFee` (visa-catalog-fx.ts), the one a
// scraped visa uses: no second rate table, no second rounding rule.
//
// No bloc, country, currency or fee is named here: they are in the data file.

/** What the seed should do about one record's fee. */
export type SourcedFeeDecision =
  /** The record takes on no route fee: this logic does not touch it. */
  | { action: "none" }
  /** Converted with a usable rate now: write both fields. */
  | { action: "write"; baseCostUsd: number; sourcedFee: VisaSourcedFee }
  /** No usable rate, but the stored fee is for the same fact: write the stored fields back unchanged. */
  | { action: "keep"; baseCostUsd: number; sourcedFee: VisaSourcedFee; reason: string }
  /** Write neither `baseCostUsd` nor `sourcedFee` (the seed logs `reason`). */
  | { action: "omit"; reason: string };

/** The two fields `buildVisaTypeDoc` writes for a record with a sourced fee. */
export interface SourcedFeeFields {
  baseCostUsd: number;
  sourcedFee: VisaSourcedFee;
}

/** The fields of a decision that carries a fee ("write" / "keep"), else undefined. */
export function sourcedFeeFields(decision: SourcedFeeDecision): SourcedFeeFields | undefined {
  return decision.action === "write" || decision.action === "keep" ? { baseCostUsd: decision.baseCostUsd, sourcedFee: decision.sourcedFee } : undefined;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * The stored `baseCostUsd` + `sourcedFee` of a record, when they state the
 * SAME fact as the data file's fee: same route, same quote, and one stored
 * component with the same amount and currency. Undefined otherwise (nothing
 * stored, a different route, or the data file's amount / currency / quote
 * changed), so a stale figure can never outlive the fact it was computed from.
 */
function matchingStoredFee(existing: Record<string, unknown> | undefined, route: RouteFeeFor): SourcedFeeFields | undefined {
  const stored = existing?.sourcedFee;
  const cost = existing?.baseCostUsd;
  if (!isObject(stored) || typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) return undefined;
  if (stored.sharedRouteId !== route.sharedRouteId || stored.quote !== route.fee.quote) return undefined;
  // The stored conversion block must be for exactly one component: this amount in this currency.
  const components = isObject(stored.fee) && Array.isArray(stored.fee.components) ? (stored.fee.components as unknown[]) : [];
  const only = components.length === 1 ? components[0] : undefined;
  if (!isObject(only) || only.amount !== route.fee.amount || only.currency !== route.fee.currency) return undefined;
  return { baseCostUsd: cost, sourcedFee: stored as unknown as VisaSourcedFee };
}

/**
 * Decide what the seed writes for one record's fee.
 *
 * @param routeFees  the route fees the DATA FILE gives this record
 *                   (`routeFeesFor`); `[]` for every record it does not list
 * @param existing   the stored visa doc, if any
 * @param fx         the stored `appConfig/fx` document, if any
 * @param now        the seed's clock (rate freshness)
 * @param guidanceSourceExists  whether `guidanceSources/{id}` exists, per id
 */
export function planSourcedFee(params: {
  routeFees: RouteFeeFor[];
  existing: Record<string, unknown> | undefined;
  fx: FxRatesDoc | undefined;
  now: Timestamp;
  guidanceSourceExists: (guidanceSourceId: string) => boolean;
}): SourcedFeeDecision {
  const { routeFees, existing, fx, now } = params;
  // ---- 1. Not a record the data file gives a fee: leave it alone ----
  if (routeFees.length === 0) return { action: "none" };
  // More than one fee source is refused before any write (`seedFeeProblems`);
  // this guard only keeps the function total.
  if (routeFees.length > 1) return { action: "omit", reason: `it takes a fee from more than one shared route (${routeFees.map((r) => r.sharedRouteId).join(", ")})` };
  const route = routeFees[0];
  const { fee } = route;

  // A stored `inheritsFrom` wins over the data file (buildVisaTypeDoc). If an
  // admin has since pointed the record at other routes, it no longer inherits
  // this one, so it must not be priced from it.
  const storedInherits = Array.isArray(existing?.inheritsFrom) ? (existing!.inheritsFrom as SharedRouteRef[]) : [];
  if (storedInherits.length > 0 && !storedInherits.some((r) => r?.sharedRouteId === route.sharedRouteId)) {
    return { action: "omit", reason: `the stored record no longer inherits "${route.sharedRouteId}"` };
  }

  // ---- 2. The official source the quote is in must be on record ----
  if (!params.guidanceSourceExists(fee.guidanceSourceId)) {
    return { action: "omit", reason: `guidanceSources/${fee.guidanceSourceId} does not exist` };
  }

  // ---- 3. Convert with the stored rate, exactly like a scraped visa's fee ----
  const computed = computeFee([{ kind: "application", label: fee.label, amount: fee.amount, currency: fee.currency, per: "application" }], fx, now);
  if (computed.baseCostUsd !== undefined) {
    return {
      action: "write",
      baseCostUsd: computed.baseCostUsd,
      sourcedFee: {
        sharedRouteId: route.sharedRouteId,
        quote: fee.quote,
        url: fee.url,
        guidanceSourceId: fee.guidanceSourceId,
        // Absent when the data file gives none (no `undefined` reaches Firestore).
        ...(fee.ruleRef ? { ruleRef: { ...fee.ruleRef } } : {}),
        fee: computed.feeMeta,
      },
    };
  }

  // ---- 4. No USD figure. Say why, in the seed log's words ----
  const meta = computed.feeMeta;
  // Not a rate problem (the figure failed computeFee's plausibility check):
  // a stored figure for the same amount would be just as implausible.
  if (!meta.fxMissing && !meta.fxStale) {
    return { action: "omit", reason: `the fee could not be converted (${(meta.feeUnverifiedReasons ?? ["no figure"]).join("; ")})` };
  }
  const why = !fx ? "appConfig/fx is missing" : meta.fxMissing ? `appConfig/fx has no ${fee.currency} rate` : `the appConfig/fx rate is stale (rate date ${fx.rateDate})`;

  // 4a. The same fact is already stored: keep the figure and its dated rate as they are.
  const stored = matchingStoredFee(existing, route);
  if (stored) return { action: "keep", ...stored, reason: `${why}; the stored fee (same route, amount, currency and quote) is kept and not re-converted` };

  // 4b. Nothing to keep: no figure at all, rather than a guess or a 0.
  return { action: "omit", reason: `${why}, and no stored fee matches the data file's route, amount, currency and quote` };
}

/** The part of a seed visa entry the fee checks read. */
export interface SeedFeeEntry {
  id: string;
  countryCode: string;
  baseCostUsd?: number;
}

/**
 * Problems that must STOP the seed before it writes anything (issue #299):
 * a record cannot have two fee sources.
 *  - a seed entry with its own `baseCostUsd` that also inherits a route with a fee;
 *  - a seed entry that takes a fee from more than one shared route.
 * Returns one line per problem, `[]` when there is none.
 */
export function seedFeeProblems(visas: SeedFeeEntry[], data: SharedVisaData): string[] {
  const problems: string[] = [];
  for (const visa of visas) {
    const routeFees = routeFeesFor(data, visa.countryCode, visa.id);
    if (routeFees.length === 0) continue;
    const at = `${visa.countryCode}/${visa.id}`;
    const routes = routeFees.map((r) => `"${r.sharedRouteId}"`).join(", ");
    if (visa.baseCostUsd !== undefined) problems.push(`${at} has its own baseCostUsd in the seed and also inherits a shared route with a fee (${routes}): a record cannot have two fee sources`);
    if (routeFees.length > 1) problems.push(`${at} inherits more than one shared route with a fee (${routes}): a record cannot have two fee sources`);
  }
  return problems;
}

/**
 * The fee the seed counts for a record: the sourced figure when there is one,
 * else the seed entry's own `baseCostUsd`, else undefined (no fee on record).
 * Used for the country's minimum cost, so a sourced fee counts exactly like
 * any other seed fee.
 */
export function effectiveSeedCost(visa: SeedFeeEntry, decision: SourcedFeeDecision | undefined): number | undefined {
  return (decision && sourcedFeeFields(decision)?.baseCostUsd) ?? visa.baseCostUsd;
}
