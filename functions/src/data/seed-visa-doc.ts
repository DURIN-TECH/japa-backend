import type { Timestamp } from "firebase-admin/firestore";
import type { SharedRouteRef } from "../types/shared-route";

// ============================================
// SEED VISA DOCUMENT BUILDER (issue #239, P10 of #228)
// ============================================
//
// Pure (no Firebase call) so the seed's rules are unit tested: what the seed
// owns and refreshes, what it keeps from the stored doc, and `inheritsFrom`.
//
// The seed writes each visa record with a WHOLE-DOCUMENT `set`, so any field
// it does not name is dropped from an existing doc. `inheritsFrom` (written by
// the shared-routes admin API, or by the migration script from the data file)
// must therefore survive a re-seed, which runs on every dev deploy.

/** The seed-owned fields of one visa record (the optional ones may be absent: see seed-countries-visas.ts). */
export interface SeedVisaFields {
  id: string;
  countryCode: string;
  name: string;
  code: string;
  description: string;
  category: string;
  processingTime: string;
  processingDaysMin: number;
  processingDaysMax: number;
  /** Absent when no official source for the fee is recorded: the displayed fee then comes from the rulebook / scrape, not the seed. */
  baseCostUsd?: number;
  /** Absent when no official source for the validity is recorded. */
  validityPeriod?: string;
  isExtendable: boolean;
  maxExtensions?: number;
  eligibilityCriteria: string[];
  applicationUrl?: string;
  applicationInstructions?: string;
}

/**
 * Build the document the seed writes for one visa record.
 *
 * @param visa      the seed entry
 * @param existing  the stored doc, if any (runtime-owned fields are kept from it)
 * @param now       timestamp for createdAt (new doc) and updatedAt
 * @param fromData  shared routes the DATA FILE says this record inherits
 *                  (`inheritsFromFor`); the seed itself names none
 *
 * `inheritsFrom`: a stored value always wins (it was set deliberately by the
 * admin API or the migration, and may have been changed since); the data
 * file's value is used only for a record that has none. Absent and empty
 * stay absent: the field is never written as `[]`.
 */
export function buildVisaTypeDoc(
  visa: SeedVisaFields,
  existing: Record<string, unknown> | undefined,
  now: Timestamp,
  fromData: SharedRouteRef[] = []
): Record<string, unknown> {
  const storedInherits = Array.isArray(existing?.inheritsFrom) ? (existing!.inheritsFrom as SharedRouteRef[]) : undefined;
  const inheritsFrom = storedInherits && storedInherits.length > 0 ? storedInherits : fromData.length > 0 ? fromData : undefined;
  return {
    id: visa.id,
    countryCode: visa.countryCode,
    name: visa.name,
    code: visa.code,
    description: visa.description,
    category: visa.category,
    processingTime: visa.processingTime,
    processingDaysMin: visa.processingDaysMin,
    processingDaysMax: visa.processingDaysMax,
    // Omitted (not 0, not ""), exactly like a scraped visa whose page states no fee.
    ...(visa.baseCostUsd !== undefined && { baseCostUsd: visa.baseCostUsd }),
    ...(visa.validityPeriod !== undefined && { validityPeriod: visa.validityPeriod }),
    isExtendable: visa.isExtendable,
    ...(visa.maxExtensions !== undefined && { maxExtensions: visa.maxExtensions }),
    eligibilityCriteria: visa.eligibilityCriteria,
    ...(visa.applicationUrl && { applicationUrl: visa.applicationUrl }),
    ...(visa.applicationInstructions && { applicationInstructions: visa.applicationInstructions }),
    // #239: keep the shared-route inheritance across a whole-document re-seed.
    ...(inheritsFrom && { inheritsFrom }),
    // Runtime-owned fields. A NEW doc starts active, with no agents and
    // createdAt = now. An EXISTING doc keeps what is stored; the `??` default
    // covers a legacy doc missing the field. Everything above is seed-owned.
    isActive: existing ? (existing.isActive as boolean | undefined) ?? true : true,
    agentIds: existing ? (existing.agentIds as string[] | undefined) ?? [] : [],
    createdAt: existing ? (existing.createdAt as Timestamp | undefined) ?? now : now,
    updatedAt: now,
  };
}
