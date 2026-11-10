import { FieldValue, Timestamp } from "firebase-admin/firestore";
import type { VisaType } from "../../types";
import type {
  ExtractedVisa,
  VisaFeeMeta,
  VisaScrapeMeta,
  VisaSupplementaryPageMeta,
} from "./types";
import type { ScrapeSourceMeta } from "./adapters";
import type { PricedUsage } from "../shared/cost/scrape-cost-pricing";

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
  // `processingUnknown` / `uncitedFieldsDropped` (issue #86) and
  // `processingUnverifiedReasons` (issue #87) are optional on the extraction
  // and copied only when set.
  extracted: Pick<
    ExtractedVisa,
    "confidence" | "citations" | "processingUnknown" | "uncitedFieldsDropped" | "processingUnverifiedReasons"
  >;
  extractedAt: Timestamp;
  sourceMeta?: ScrapeSourceMeta;
  // Fee as published + its USD conversion provenance (computeFee().feeMeta).
  fee?: VisaFeeMeta;
  // EXTRACTOR_PROMPT_VERSION of the prompt that produced `extracted`.
  extractorPromptVersion?: string;
  // Supplementary pages appended to the route text (issue #86); [] / absent = none.
  supplementaryPages?: VisaSupplementaryPageMeta[];
  // Issue #82: the priced usage of the LLM call behind `extracted` (absent
  // when the extractor reported none, e.g. a stub).
  llmUsage?: PricedUsage;
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
  // ---- Issue #86: uncited numeric fields + supplementary pages ----
  // Only written when they say something (no `false` / empty keys), so a
  // route with a cited processing time and no supplements keeps the old shape.
  if (params.extracted.processingUnknown) meta.processingUnknown = true;
  if (params.extracted.uncitedFieldsDropped && params.extracted.uncitedFieldsDropped.length > 0) {
    meta.uncitedFieldsDropped = [...params.extracted.uncitedFieldsDropped];
  }
  if (params.supplementaryPages && params.supplementaryPages.length > 0) {
    meta.supplementaryPages = params.supplementaryPages.map((p) => ({ ...p }));
  }
  // Issue #87: processing-range flag, only when set (never an empty array).
  const processingReasons = params.extracted.processingUnverifiedReasons;
  if (processingReasons && processingReasons.length > 0) {
    meta.processingUnverifiedReasons = [...processingReasons];
  }
  // Issue #82: token usage + cost of the call (only defined values).
  if (params.llmUsage) {
    meta.llmUsage = { ...params.llmUsage.usage };
    if (params.llmUsage.costUsd !== undefined) meta.llmCostUsd = params.llmUsage.costUsd;
    if (params.llmUsage.pricedAs) meta.llmPricedAs = params.llmUsage.pricedAs;
    if (params.llmUsage.responseModel && params.llmUsage.responseModel !== params.model) {
      meta.llmResponseModel = params.llmUsage.responseModel;
    }
  }
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
  // Issue #68 review fix: a RESTORED doc (pending_review + restoredAt) seen
  // withdrawn again before an admin reviewed it → back to "approved" (still
  // inactive, staleSince kept), i.e. out of the review queue.
  | "unqueued"
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
 * review step: planRestoredUpdate() (issue #68) only puts the doc back in the
 * admin review queue (pending_review); an admin approval reactivates it.
 *
 * Second withdrawal (issue #68): approval deletes `staleSince` (#62), so a
 * re-approved doc that is withdrawn AGAIN has no `staleSince` and gets a
 * FRESH one (`now`) here — "set once" applies per withdrawal episode.
 *
 * Withdrawn again while a restore awaits review (issue #68 review fix): see
 * the "unqueued" branch below.
 */
export function planWithdrawnUpdate(
  existing: Pick<VisaType, "source" | "isActive" | "staleSince" | "reviewStatus" | "restoredAt"> | undefined,
  now: Timestamp
): {
  outcome: WithdrawnOutcome;
  // "deactivated" writes isActive + staleSince; "unqueued" writes
  // reviewStatus + restoredAt (delete). Both write updatedAt.
  update?: {
    isActive?: false;
    staleSince?: Timestamp;
    reviewStatus?: "approved";
    restoredAt?: FieldValue;
    updatedAt: Timestamp;
  };
} {
  if (!existing) return { outcome: "missing" };
  if (existing.source !== "scraped") return { outcome: "not_scraped" };
  if (existing.isActive === false && existing.staleSince) {
    // ---- Restored, then withdrawn again before review (issue #68) ----
    // markRestored() moved this doc approved -> pending_review (restoredAt
    // set) because the guide came back. It is withdrawn again now, so it must
    // LEAVE the review queue: otherwise an admin could approve a withdrawn
    // guide's visa live (until the next weekly crawl turned it off again).
    // Back to the status it had before the restore ("approved"), still
    // inactive, staleSince kept (same episode), restoredAt removed. A
    // never-approved pending doc has no restoredAt and is left as it was.
    if (existing.reviewStatus === "pending_review" && existing.restoredAt) {
      return {
        outcome: "unqueued",
        update: { reviewStatus: "approved", restoredAt: FieldValue.delete(), updatedAt: now },
      };
    }
    return { outcome: "already_inactive" };
  }
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

// ----- Restored-guide signal (issue #68) -----

/** What the restored path does to the doc at the resolved visa id. */
export type RestoredOutcome =
  | "flagged" // withdrawn + approved scraped doc → reviewStatus back to pending_review
  | "none"; // anything else: no write (not withdrawn, not scraped, already pending, rejected, missing)

/**
 * Decide the "source came back" update for the doc at the resolved visa id,
 * called when a page that is NOT withdrawn is fetched (issue #68).
 *
 * The case it catches: a GOV.UK guide was withdrawn (#58) — the crawl
 * deactivated the scraped visa and set `staleSince` — and now the guide is
 * live again. Without a signal the visa would stay inactive forever, with no
 * admin ever finding out. So the doc goes back into the EXISTING admin
 * review queue: `reviewStatus: "pending_review"`. The portal's visa-review
 * page (admin → Visa Review) already lists, counts and filters by
 * `reviewStatus`, and only shows Approve / Reject for `pending_review` docs,
 * so this surfaces with NO portal change. Approving it (visaService
 * .updateVisaReviewStatus) sets isActive:true and clears `staleSince` (#62).
 *
 * Rules:
 *  - Only `source === "scraped"` docs, inactive, with `staleSince` (i.e.
 *    deactivated by the withdrawn path and not yet re-approved).
 *  - Only when `reviewStatus === "approved"`: that is the doc that was live
 *    before the withdrawal and now needs a human decision.
 *    - already `pending_review` → it is already in the queue: no write;
 *    - `rejected` → an admin already decided against it: a restored guide
 *      must not undo that rejection, so no write.
 *  - NEVER auto-reactivates: `isActive` stays false and `staleSince` stays
 *    set (so the admin can see it was withdrawn, and approval clears it).
 *  - Sets `restoredAt` (review fix): marks the entry as a restore, so a
 *    second withdrawal before review can take it back out of the queue.
 *  - Independent of the content hash: the caller runs it BEFORE the hash
 *    gate, so a guide restored with byte-identical text is still flagged.
 *    (When the text DID change, the now-pending doc is then refreshed in
 *    place by ingest's normal pending_review branch, so the admin reviews
 *    the restored content.)
 *
 * Pure: no Firestore I/O (VisaCatalogService.markRestored does the write).
 */
export function planRestoredUpdate(
  existing: Pick<VisaType, "source" | "isActive" | "staleSince" | "reviewStatus"> | undefined,
  now: Timestamp
): {
  outcome: RestoredOutcome;
  update?: { reviewStatus: "pending_review"; restoredAt: Timestamp; updatedAt: Timestamp };
} {
  if (!existing) return { outcome: "none" }; // nothing to flag, nothing created
  if (existing.source !== "scraped") return { outcome: "none" }; // seeded / agent: never touched
  if (existing.isActive !== false || !existing.staleSince) return { outcome: "none" }; // not withdrawn
  if (existing.reviewStatus !== "approved") return { outcome: "none" }; // pending already / rejected
  // `restoredAt` marks this queue entry as a restore (see planWithdrawnUpdate:
  // a re-withdrawal before review puts it back to approved).
  return { outcome: "flagged", update: { reviewStatus: "pending_review", restoredAt: now, updatedAt: now } };
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
 * Optional extracted VisaType fields that a refresh must DELETE from an
 * existing pending doc when the new extraction leaves them out (issue #86).
 * Without this, a merge update keeps the previous extraction's value next to
 * a scrapeMeta that no longer supports it — e.g. the old fake `0` processing
 * days staying on the KR doc after the validator started omitting them.
 * (`baseCostUsd` has its own rules in ingestExtraction: FX-flagged fees keep
 * the old cost, see the refresh branch there.)
 */
export const REFRESH_DELETABLE_FIELDS = ["processingDaysMin", "processingDaysMax", "maxExtensions"] as const;

/**
 * The FieldValue.delete() map for every REFRESH_DELETABLE_FIELDS key that is
 * absent from `fields` (the extractedToVisaFields() output). Spread into the
 * refresh update; {} when all of them are present.
 */
export function absentFieldDeletes(fields: Partial<VisaType>): Record<string, FieldValue> {
  const out: Record<string, FieldValue> = {};
  const rec = fields as Record<string, unknown>;
  for (const k of REFRESH_DELETABLE_FIELDS) if (rec[k] === undefined) out[k] = FieldValue.delete();
  return out;
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
 * Issue #86: `processingDaysMin` / `processingDaysMax` / `maxExtensions` are
 * undefined when the page did not cite them, so they are OMITTED here too
 * (never a fake 0); a refresh deletes stale values via absentFieldDeletes().
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
