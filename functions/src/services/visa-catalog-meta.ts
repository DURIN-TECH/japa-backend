import { Timestamp } from "firebase-admin/firestore";
import type { VisaType } from "../types";
import type { ExtractedVisa, VisaFeeMeta, VisaScrapeMeta } from "../types/visa-catalog";
import type { ScrapeSourceMeta } from "./visa-source-adapters";

// ============================================
// VISA CATALOG — SCRAPE META + WITHDRAWN RULES (pure)
// ============================================
//
// Decisions the ingest side makes, kept free of Firestore I/O so they are
// unit-testable without an emulator (`Timestamp` from firebase-admin/firestore
// works without Admin init). `visa-catalog.service.ts` does the reads/writes.

/**
 * Build the `scrapeMeta` written on a scraped visa doc. The optional
 * `sourceMeta` (adapter provenance: provider, GOV.UK content_id / updated_at,
 * sections used, truncated) is merged in; only defined values are copied so
 * pre-adapter callers produce exactly the old shape.
 *
 * Issue #59: `fee` (the computed fee block from computeFee — components,
 * source-currency totals, FX provenance and stale/missing flags) and
 * `extractorPromptVersion` are copied when given.
 */
export function buildScrapeMeta(params: {
  sourceUrl: string;
  routeName: string;
  model: string;
  contentHash: string;
  extracted: Pick<ExtractedVisa, "confidence" | "citations">;
  extractedAt: Timestamp;
  sourceMeta?: ScrapeSourceMeta;
  // Fee as published + its USD conversion provenance (computeFee().feeMeta).
  fee?: VisaFeeMeta;
  // EXTRACTOR_PROMPT_VERSION of the prompt that produced `extracted`.
  extractorPromptVersion?: string;
}): VisaScrapeMeta {
  const meta: VisaScrapeMeta = {
    sourceUrl: params.sourceUrl,
    routeName: params.routeName,
    model: params.model,
    confidence: params.extracted.confidence,
    citations: params.extracted.citations,
    contentHash: params.contentHash,
    extractedAt: params.extractedAt,
  };
  // Only defined values — Firestore never sees `undefined`.
  if (params.fee) meta.fee = params.fee;
  if (params.extractorPromptVersion) meta.extractorPromptVersion = params.extractorPromptVersion;
  for (const [k, v] of Object.entries(params.sourceMeta ?? {})) {
    // Cast: keys are a subset of VisaScrapeMeta by construction (ScrapeSourceMeta).
    if (v !== undefined) (meta as unknown as Record<string, unknown>)[k] = v;
  }
  return meta;
}

/** What the withdrawn path does to the doc at the resolved visa id. */
export type WithdrawnOutcome =
  | "deactivated" // scraped doc flipped to isActive:false (+ staleSince if unset)
  | "already_inactive" // scraped doc already inactive with staleSince — no write
  | "not_scraped" // doc exists but is seeded/agent-authored — never touched
  | "missing"; // no doc — nothing is created

/**
 * Decide the withdrawn-guide update for the doc at the resolved visa id.
 *
 * Rules (issue #58, user-confirmed):
 *  - Only a doc with `source === "scraped"` is ever modified — whatever its
 *    `reviewStatus` (an APPROVED scraped visa that GOV.UK withdrew must come
 *    off the app). Seeded `uk-*` / agent docs are never touched.
 *  - The update is `isActive: false` + `staleSince` — `staleSince` is set ONCE
 *    (an existing value is kept). The doc is never deleted.
 *  - No doc → nothing is created.
 *
 * NOTE: there is deliberately no inverse. A guide that later stops being
 * withdrawn does NOT reactivate the doc here — reactivation stays a human
 * review step (re-extraction of a pending doc leaves isActive alone; an
 * approved doc is skipped by ingest).
 */
export function planWithdrawnUpdate(
  existing: Pick<VisaType, "source" | "isActive" | "staleSince"> | undefined,
  now: Timestamp
): { outcome: WithdrawnOutcome; update?: { isActive: false; staleSince: Timestamp; updatedAt: Timestamp } } {
  if (!existing) return { outcome: "missing" };
  if (existing.source !== "scraped") return { outcome: "not_scraped" };
  if (existing.isActive === false && existing.staleSince) return { outcome: "already_inactive" };
  return {
    outcome: "deactivated",
    update: {
      isActive: false,
      // Set once: keep the first time we saw it withdrawn.
      staleSince: existing.staleSince ?? now,
      updatedAt: now,
    },
  };
}

/**
 * Minimum of the FINITE numbers in `values`, or `fallback` when there are
 * none. Used for the denormalized country stats (`minCostUsd`,
 * `minProcessingDays`): a doc without `baseCostUsd` (e.g. a scraped fee with
 * no usable exchange rate, issue #59) must not turn the min into NaN.
 */
export function finiteMin(values: unknown[], fallback = 0): number {
  const finite = values.filter((n): n is number => typeof n === "number" && Number.isFinite(n));
  return finite.length ? Math.min(...finite) : fallback;
}

/**
 * Map a validated extraction onto VisaType fields for the ingest write.
 * `code` is the already resolved code (registry-pinned `visaCode` if any, else
 * the extracted one).
 *
 * Issue #59: `baseCostUsd` is NOT taken from the extraction any more — it is
 * the code-computed value from computeFee(), passed in here. When it is
 * undefined (fee flagged fxStale/fxMissing, or no fee stated) the key is
 * OMITTED: absent on a new doc, and left unchanged by a merge update on an
 * existing pending doc. Never a fake 0.
 *
 * Every undefined value is dropped, so no `undefined` reaches Firestore
 * (regardless of the db's ignoreUndefinedProperties setting).
 */
export function extractedToVisaFields(params: {
  countryCode: string;
  visaId: string;
  code: string;
  extracted: ExtractedVisa;
  baseCostUsd?: number;
}): Partial<VisaType> {
  const e = params.extracted;
  const fields: Record<string, unknown> = {
    id: params.visaId,
    countryCode: params.countryCode,
    name: e.name,
    code: params.code,
    description: e.description,
    category: e.category,
    processingTime: e.processingTime,
    processingDaysMin: e.processingDaysMin,
    processingDaysMax: e.processingDaysMax,
    baseCostUsd: params.baseCostUsd,
    validityPeriod: e.validityPeriod,
    isExtendable: e.isExtendable,
    maxExtensions: e.maxExtensions,
    eligibilityCriteria: e.eligibilityCriteria,
    applicationUrl: e.applicationUrl,
    applicationInstructions: e.applicationInstructions,
  };
  // Drop undefined keys (optional extraction fields, unconverted cost).
  for (const k of Object.keys(fields)) if (fields[k] === undefined) delete fields[k];
  return fields as Partial<VisaType>;
}
