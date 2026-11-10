import { Timestamp } from "firebase-admin/firestore";
import type { VisaType } from "../types";
import type {
  VisaFeeMeta,
  VisaManualCostMeta,
  VisaReplacedManualCostMeta,
} from "../types/visa-catalog";
import {
  FX_SOURCE_MANUAL,
  MAX_FEE_COMPONENT_USD,
  VisaFeeNotConvertibleError,
  assertVisaApprovable,
  isIso4217,
} from "./visa-catalog-fx";

// ============================================
// MANUAL USD COST FOR PENDING SCRAPED VISAS (issue #70)
// ============================================
//
// Some scraped visas can never be converted to USD by the scraper (#59): the
// fee is in a currency with no ECB rate and no official peg (TWD, NGN, ...),
// part of the fee could not be verified, or the page publishes no fee. Until
// now such a visa could only be rejected. This module lets an admin confirm
// the USD cost by hand:
//
//   PUT /admin/visas/:id/manual-cost  (controllers/visa.controller.ts)
//     → visaService.setManualCost (one Firestore transaction)
//     → parseManualCostInput + planManualCost (here, pure)
//
// The write puts the cost where the approval guard (assertVisaApprovable)
// already looks: `baseCostUsd = Math.round(amountUsd)` and
// `scrapeMeta.fee.totalUsd = amountUsd`, `fxSource: "manual"`, flags cleared.
// The guard itself is unchanged.
//
// Overwrite rule: a later scrape with CHANGED content replaces the manual
// cost through the normal ingest path (a fresh conversion, or the flags).
// planManualCostOverwrite (here) decides that write and records the replaced
// entry in `scrapeMeta.fee.replacedManualCost`, so it is never silent.
//
// Firebase-free apart from the Timestamp class, so it is unit-testable
// without an emulator.

// ----- Limits -----

/** Highest manual cost accepted, in USD. Same figure as the scraper's
 *  per-component plausibility cap: no visa fee we know of comes close, so a
 *  bigger number is almost certainly a typo (an extra zero, cents typed as
 *  dollars) or a value in the wrong currency. */
export const MAX_MANUAL_COST_USD = MAX_FEE_COMPONENT_USD;

/** Longest reason accepted (characters, after trimming). */
export const MANUAL_COST_REASON_MAX_LENGTH = 500;

/** Shortest reason accepted (characters, after trimming): enough to rule out
 *  "x" / "ok" while allowing a terse "CBC rate". */
export const MANUAL_COST_REASON_MIN_LENGTH = 3;

/** Two-letter country code (the doc ids under `countries/` are upper-case). */
const COUNTRY_CODE_RE = /^[A-Za-z]{2}$/;

// ----- Errors -----

/** Codes the manual-cost endpoint can fail with (besides 401 / 403 / 500). */
export type ManualCostErrorCode =
  | "VALIDATION_ERROR" // 400: bad body
  | "NOT_FOUND" // 404: no such visa
  | "NOT_PENDING_SCRAPED" // 409: not a pending_review scraped visa
  | "FEE_ALREADY_CONVERTED" // 409: the scraper's own cost is usable
  | "STALE_VISA"; // 409: the extraction changed since the admin looked

/**
 * Typed error from parseManualCostInput / planManualCost / setManualCost.
 * The controller maps it to `{ success: false, error: code, message }` with
 * `httpStatus`.
 */
export class ManualCostError extends Error {
  constructor(
    readonly code: ManualCostErrorCode,
    message: string,
    readonly httpStatus: number
  ) {
    super(message);
    this.name = "ManualCostError";
  }
}

/** Shorthand for a 400 VALIDATION_ERROR. */
function invalid(message: string): ManualCostError {
  return new ManualCostError("VALIDATION_ERROR", message, 400);
}

// ----- Input -----

/** The validated request body of PUT /admin/visas/:id/manual-cost. */
export interface ManualCostInput {
  countryCode: string; // upper-cased
  amountUsd: number; // finite, > 0, <= MAX_MANUAL_COST_USD, rounds to >= 1
  reason: string; // trimmed
  rate?: { currency: string; usdPerUnit: number }; // currency upper-cased
  // Optional optimistic check: the `scrapeMeta.contentHash` the admin saw.
  expectedContentHash?: string;
}

/**
 * Validate the raw request body. Throws ManualCostError(VALIDATION_ERROR)
 * with a message naming the first bad field.
 *
 * Deliberately strict about types: `amountUsd` must be a JSON number (a
 * string "120" is refused rather than coerced), so a portal bug cannot slip
 * a wrong value through.
 */
export function parseManualCostInput(body: unknown): ManualCostInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw invalid("Request body must be a JSON object");
  }
  const b = body as Record<string, unknown>;

  // ---- countryCode ----
  if (typeof b.countryCode !== "string" || !COUNTRY_CODE_RE.test(b.countryCode.trim())) {
    throw invalid("countryCode must be a 2-letter country code");
  }
  const countryCode = b.countryCode.trim().toUpperCase();

  // ---- amountUsd: finite number, > 0, sane max ----
  const amountUsd = b.amountUsd;
  if (typeof amountUsd !== "number" || !Number.isFinite(amountUsd)) {
    throw invalid("amountUsd must be a number");
  }
  if (amountUsd <= 0) {
    throw invalid("amountUsd must be greater than 0");
  }
  // baseCostUsd is whole USD; a value that rounds to 0 would publish a free
  // visa by accident (a genuinely free visa converts on its own: a 0 fee
  // needs no exchange rate).
  if (Math.round(amountUsd) < 1) {
    throw invalid("amountUsd must be at least 1 USD once rounded to whole dollars");
  }
  if (amountUsd > MAX_MANUAL_COST_USD) {
    throw invalid(`amountUsd must be at most ${MAX_MANUAL_COST_USD} USD`);
  }

  // ---- reason: required ----
  if (typeof b.reason !== "string") {
    throw invalid("reason is required");
  }
  const reason = b.reason.trim();
  if (reason.length < MANUAL_COST_REASON_MIN_LENGTH) {
    throw invalid(`reason must be at least ${MANUAL_COST_REASON_MIN_LENGTH} characters`);
  }
  if (reason.length > MANUAL_COST_REASON_MAX_LENGTH) {
    throw invalid(`reason must be at most ${MANUAL_COST_REASON_MAX_LENGTH} characters`);
  }

  const input: ManualCostInput = { countryCode, amountUsd, reason };

  // ---- rate: optional { currency, usdPerUnit } ----
  if (b.rate !== undefined && b.rate !== null) {
    if (typeof b.rate !== "object" || Array.isArray(b.rate)) {
      throw invalid("rate must be an object { currency, usdPerUnit }");
    }
    const r = b.rate as Record<string, unknown>;
    const currency = typeof r.currency === "string" ? r.currency.trim().toUpperCase() : "";
    if (!isIso4217(currency) || currency === "USD") {
      throw invalid("rate.currency must be an ISO 4217 currency code other than USD");
    }
    if (typeof r.usdPerUnit !== "number" || !Number.isFinite(r.usdPerUnit) || r.usdPerUnit <= 0) {
      throw invalid("rate.usdPerUnit must be a number greater than 0 (USD per one unit of rate.currency)");
    }
    input.rate = { currency, usdPerUnit: r.usdPerUnit };
  }

  // ---- expectedContentHash: optional string ----
  if (b.expectedContentHash !== undefined && b.expectedContentHash !== null) {
    if (typeof b.expectedContentHash !== "string" || b.expectedContentHash.length === 0) {
      throw invalid("expectedContentHash must be a non-empty string");
    }
    input.expectedContentHash = b.expectedContentHash;
  }

  return input;
}

// ----- Planning the manual write -----

/** The visa fields the manual-cost write sets (field-path update). */
export interface ManualCostPlan {
  baseCostUsd: number;
  fee: VisaFeeMeta; // replaces `scrapeMeta.fee` wholesale
}

/**
 * Decide the write for a manual cost on `visa`, or throw ManualCostError.
 *
 * Refused (409) when:
 *  - the visa is not a `source: "scraped"`, `reviewStatus: "pending_review"`
 *    doc (approved visas change through pendingVisaChanges; seeded and agent
 *    visas carry their own cost) — NOT_PENDING_SCRAPED;
 *  - `expectedContentHash` was given and the stored extraction is a different
 *    one (the crawl refreshed it after the admin looked) — STALE_VISA;
 *  - the scraper's own cost is already approvable and there is no earlier
 *    manual cost to correct — FEE_ALREADY_CONVERTED. A manual value must not
 *    quietly replace a verified conversion.
 *
 * The new fee block keeps the published `components` / `totals` (and any
 * `replacedManualCost` audit entry), drops the scraper's conversion and
 * flags (they move to `manualCost.previous`), and sets `totalUsd`,
 * `fxSource: "manual"`, `fxDate` and `manualCost`. A visa without a fee block
 * (pre-#59 scrape) gets one with empty components.
 *
 * @param setBy the admin's uid
 * @param now injected clock (setAt + fxDate)
 */
export function planManualCost(
  visa: Pick<VisaType, "source" | "reviewStatus" | "scrapeMeta" | "baseCostUsd">,
  input: ManualCostInput,
  setBy: string,
  now: Timestamp
): ManualCostPlan {
  // ---- Only pending scraped visas ----
  if (visa.source !== "scraped" || visa.reviewStatus !== "pending_review") {
    throw new ManualCostError(
      "NOT_PENDING_SCRAPED",
      "A manual cost can only be set on a scraped visa that is pending review",
      409
    );
  }

  // ---- Optimistic check against the extraction the admin reviewed ----
  const contentHash = visa.scrapeMeta?.contentHash ?? "";
  if (input.expectedContentHash !== undefined && input.expectedContentHash !== contentHash) {
    throw new ManualCostError(
      "STALE_VISA",
      "This visa was re-scraped since you opened it. Reload and review it again.",
      409
    );
  }

  const oldFee: VisaFeeMeta | undefined = visa.scrapeMeta?.fee;

  // ---- Only when the scraper's own cost can't be approved ----
  // (or to correct an earlier manual cost on the same extraction)
  if (!oldFee?.manualCost && isApprovable(visa)) {
    throw new ManualCostError(
      "FEE_ALREADY_CONVERTED",
      "This visa already has a USD cost converted from the published fee; a manual cost is only for fees the scraper could not convert",
      409
    );
  }

  // ---- What the scraper said, for the audit trail ----
  // Re-editing a manual cost keeps the ORIGINAL scraper state (the old
  // manual entry's `previous`), and records the entry it supersedes.
  const previous: VisaManualCostMeta["previous"] = oldFee?.manualCost
    ? { ...oldFee.manualCost.previous }
    : scraperState(oldFee, visa.baseCostUsd);

  const manualCost: VisaManualCostMeta = {
    amountUsd: input.amountUsd,
    reason: input.reason,
    setBy,
    setAt: now,
    contentHash,
    previous,
  };
  if (input.rate) manualCost.rate = { ...input.rate };
  if (oldFee?.manualCost) {
    // One level only: the superseded entry without its own history.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { previous: _p, supersedes: _s, ...earlier } = oldFee.manualCost;
    manualCost.supersedes = earlier;
  }

  // ---- The new fee block ----
  // Built field by field (not `{...oldFee}` minus keys) so no scraper
  // conversion field (fxRateToUsd, an ECB fxDate, ...) can linger next to a
  // manual total.
  const fee: VisaFeeMeta = {
    components: oldFee?.components ?? [],
    totals: oldFee?.totals ?? [],
    totalUsd: input.amountUsd,
    fxSource: FX_SOURCE_MANUAL,
    fxDate: now.toDate().toISOString().slice(0, 10),
    manualCost,
  };
  if (oldFee?.replacedManualCost) fee.replacedManualCost = oldFee.replacedManualCost;

  return { baseCostUsd: Math.round(input.amountUsd), fee };
}

/** True when the approval guard would accept `visa` as it stands. */
function isApprovable(visa: Pick<VisaType, "source" | "scrapeMeta" | "baseCostUsd">): boolean {
  try {
    assertVisaApprovable(visa);
    return true;
  } catch (e) {
    if (e instanceof VisaFeeNotConvertibleError) return false;
    throw e;
  }
}

/** The scraper's flags + conversion on `fee` (only keys that are set). */
function scraperState(fee: VisaFeeMeta | undefined, baseCostUsd: number | undefined): VisaManualCostMeta["previous"] {
  const p: VisaManualCostMeta["previous"] = {};
  if (fee?.fxMissing) p.fxMissing = true;
  if (fee?.fxStale) p.fxStale = true;
  if (fee?.feeUnverified) p.feeUnverified = true;
  if (fee?.feeUnverifiedReason) p.feeUnverifiedReason = fee.feeUnverifiedReason;
  if (fee?.noPublishedFee) p.noPublishedFee = true;
  if (typeof fee?.totalUsd === "number") p.totalUsd = fee.totalUsd;
  if (fee?.fxSource) p.fxSource = fee.fxSource;
  if (typeof baseCostUsd === "number" && Number.isFinite(baseCostUsd)) p.baseCostUsd = baseCostUsd;
  return p;
}

// ----- A later scrape replacing a manual cost -----

/** What ingest's pending-refresh write must do about a manual cost. */
export interface ManualCostOverwritePlan {
  // The fee block to write (the new extraction's, plus the audit entry).
  fee: VisaFeeMeta;
  // True: delete `baseCostUsd` — the old value was the manual one and the new
  // extraction supports no cost (flags), so it must not stay behind.
  deleteCost: boolean;
  // The manual entry this refresh replaced (for logging); absent when the
  // existing fee had no manual cost.
  replaced?: VisaReplacedManualCostMeta;
}

/**
 * Called by ingest's pending-refresh branch (the extraction's content hash
 * changed). The new extraction ALWAYS wins — that is the "normal path":
 *  - it converted → its `baseCostUsd` replaces the manual one;
 *  - it is flagged (fxMissing / fxStale / feeUnverified / noPublishedFee) →
 *    the manual `baseCostUsd` is deleted, so the flags block approval until
 *    an admin sets a cost again.
 * Never silently: the replaced manual entry is stored on the new fee block as
 * `replacedManualCost` (+ when and by which content hash). An existing
 * `replacedManualCost` (from an earlier overwrite) is carried forward when
 * nothing new was replaced.
 *
 * @param existingFee the stored `scrapeMeta.fee` (may be absent)
 * @param newFee computeFee().feeMeta for the new extraction (not mutated)
 * @param newBaseCostUsd computeFee().baseCostUsd (undefined = no usable cost)
 * @param contentHash the new extraction's content hash
 */
export function planManualCostOverwrite(
  existingFee: VisaFeeMeta | undefined,
  newFee: VisaFeeMeta,
  newBaseCostUsd: number | undefined,
  contentHash: string,
  now: Timestamp
): ManualCostOverwritePlan {
  const fee: VisaFeeMeta = { ...newFee };
  if (existingFee?.manualCost) {
    const replaced: VisaReplacedManualCostMeta = {
      ...existingFee.manualCost,
      replacedAt: now,
      replacedByContentHash: contentHash,
    };
    fee.replacedManualCost = replaced;
    return { fee, deleteCost: newBaseCostUsd === undefined, replaced };
  }
  if (existingFee?.replacedManualCost) fee.replacedManualCost = existingFee.replacedManualCost;
  return { fee, deleteCost: false };
}
