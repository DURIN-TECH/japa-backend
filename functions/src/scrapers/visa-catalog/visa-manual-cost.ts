import { Timestamp } from "firebase-admin/firestore";
import type { VisaType } from "../../types";
import type {
  VisaFeeMeta,
  VisaManualCostMeta,
  VisaReplacedManualCostMeta,
} from "./types";
import {
  FX_SOURCE_MANUAL,
  MAX_FEE_COMPONENT_USD,
  VisaFeeNotConvertibleError,
  assertVisaApprovable,
  isIso4217,
  storedFeeUnverifiedReasons,
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
// Overwrite rule: a later scrape with CHANGED content (a new content hash)
// replaces the manual cost through the normal ingest path (a fresh
// conversion, or the flags). planManualCostOverwrite (here) decides that
// write and records the replaced entry in `scrapeMeta.fee.replacedManualCost`,
// so it is never silent. A re-extract of the SAME page text (prompt-only,
// issue #71) keeps the manual cost: the admin's confirmation still holds.
//
// Issue #77 reuses the same rules for an OPEN proposed edit to a live visa
// (PUT /admin/visa-changes/:id/manual-cost, changes/visa-change-manual-cost.ts):
// parseManualCostFields (amount / reason / rates), buildManualCostFee (rates
// check + audit block + fee block) and markManualCostReplaced (the overwrite
// record) are shared, so the two endpoints cannot drift apart.
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

/** Shortest reason accepted (characters, after trimming). Same rule as a
 *  rejection reason in the portal: enough to force a real explanation
 *  ("CBC rate 0.031", "Free per embassy page"). */
export const MANUAL_COST_REASON_MIN_LENGTH = 10;

/** Two-letter country code (the doc ids under `countries/` are upper-case). */
const COUNTRY_CODE_RE = /^[A-Za-z]{2}$/;

// ----- Errors -----

/** Codes the manual-cost endpoint can fail with (besides 401 / 403 / 500). */
export type ManualCostErrorCode =
  | "VALIDATION_ERROR" // 400: bad body (incl. rates not matching the fee's currencies)
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

/** One exchange rate the admin used: USD per ONE unit of `currency`. */
export interface ManualCostRate {
  currency: string; // ISO 4217, upper-cased, never "USD"
  usdPerUnit: number; // finite, > 0
}

/** The validated request body of PUT /admin/visas/:id/manual-cost. */
export interface ManualCostInput {
  countryCode: string; // upper-cased
  amountUsd: number; // finite, 0 <= x <= MAX_MANUAL_COST_USD (0 = free visa)
  reason: string; // trimmed, MANUAL_COST_REASON_MIN..MAX_LENGTH chars
  // One per distinct non-USD currency among the fee components (checked
  // against the stored fee in planManualCost, since only it knows them).
  // Shape-validated here: unique currencies.
  rates: ManualCostRate[];
  // Optional optimistic checks against what the admin reviewed: the
  // `scrapeMeta.contentHash`, and `scrapeMeta.extractedAt` as epoch millis
  // (parsed from the ISO string in the body). Either mismatch → STALE_VISA.
  expectedContentHash?: string;
  expectedExtractedAtMs?: number;
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

  // ---- amountUsd / reason / rates (shared with the proposal endpoint, #77) ----
  const input: ManualCostInput = { countryCode, ...parseManualCostFields(b) };

  // ---- expectedContentHash: optional string ----
  if (b.expectedContentHash !== undefined && b.expectedContentHash !== null) {
    if (typeof b.expectedContentHash !== "string" || b.expectedContentHash.length === 0) {
      throw invalid("expectedContentHash must be a non-empty string");
    }
    input.expectedContentHash = b.expectedContentHash;
  }

  // ---- expectedExtractedAt: optional ISO date-time string ----
  if (b.expectedExtractedAt !== undefined && b.expectedExtractedAt !== null) {
    const ms = typeof b.expectedExtractedAt === "string" ? Date.parse(b.expectedExtractedAt) : NaN;
    if (!Number.isFinite(ms)) {
      throw invalid("expectedExtractedAt must be an ISO 8601 date-time string");
    }
    input.expectedExtractedAtMs = ms;
  }

  return input;
}

/** The cost fields every manual-cost body carries (#70 visa, #77 proposal). */
export type ManualCostFields = Pick<ManualCostInput, "amountUsd" | "reason" | "rates">;

/**
 * Validate the cost fields shared by both manual-cost endpoints:
 * `amountUsd` (JSON number, 0..MAX_MANUAL_COST_USD), `reason` (trimmed,
 * MIN..MAX length) and `rates` (array of unique { currency, usdPerUnit },
 * never USD; the legacy single `rate` field is refused). Throws
 * ManualCostError(VALIDATION_ERROR) naming the first bad field.
 *
 * Used by parseManualCostInput (PUT /admin/visas/:id/manual-cost, #70) and
 * parseProposalManualCostInput (PUT /admin/visa-changes/:id/manual-cost,
 * #77), so the two endpoints can never drift apart on what a valid cost is.
 *
 * @param b the request body, already checked to be a plain object
 */
export function parseManualCostFields(b: Record<string, unknown>): ManualCostFields {
  // ---- amountUsd: finite number, > 0, sane max ----
  const amountUsd = b.amountUsd;
  if (typeof amountUsd !== "number" || !Number.isFinite(amountUsd)) {
    throw invalid("amountUsd must be a number");
  }
  // 0 is allowed: an admin may confirm a visa is free (e.g. a page that
  // publishes no fee). The portal warns before sending 0.
  if (amountUsd < 0) {
    throw invalid("amountUsd must be 0 or more");
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

  // ---- rates: required array of { currency, usdPerUnit } ----
  // The old single `rate` field is refused rather than silently ignored.
  if (b.rate !== undefined) {
    throw invalid("rate is not accepted; send rates: [{ currency, usdPerUnit }]");
  }
  if (!Array.isArray(b.rates)) {
    throw invalid("rates is required: an array of { currency, usdPerUnit } (empty when the fee has no non-USD currency)");
  }
  const rates: ManualCostRate[] = [];
  const seen = new Set<string>();
  for (const [n, raw] of b.rates.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw invalid(`rates[${n}] must be an object { currency, usdPerUnit }`);
    }
    const r = raw as Record<string, unknown>;
    const currency = typeof r.currency === "string" ? r.currency.trim().toUpperCase() : "";
    if (!isIso4217(currency) || currency === "USD") {
      throw invalid(`rates[${n}].currency must be an ISO 4217 currency code other than USD`);
    }
    if (typeof r.usdPerUnit !== "number" || !Number.isFinite(r.usdPerUnit) || r.usdPerUnit <= 0) {
      throw invalid(`rates[${n}].usdPerUnit must be a number greater than 0 (USD per one unit of ${currency})`);
    }
    if (seen.has(currency)) {
      throw invalid(`rates has more than one entry for ${currency}`);
    }
    seen.add(currency);
    rates.push({ currency, usdPerUnit: r.usdPerUnit });
  }

  return { amountUsd, reason, rates };
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

  // ---- Optimistic checks against the extraction the admin reviewed ----
  // The content hash catches a changed page; extractedAt also catches a
  // prompt-only re-extract (#71: same hash, possibly a different fee).
  const contentHash = visa.scrapeMeta?.contentHash ?? "";
  const extractedAt = visa.scrapeMeta?.extractedAt;
  const extractedAtMs = extractedAt instanceof Timestamp ? extractedAt.toMillis() : undefined;
  const hashMoved = input.expectedContentHash !== undefined && input.expectedContentHash !== contentHash;
  const extractionMoved =
    input.expectedExtractedAtMs !== undefined && input.expectedExtractedAtMs !== extractedAtMs;
  if (hashMoved || extractionMoved) {
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

  // ---- Rates check + the new fee block (shared with #77 proposals) ----
  // (The rates are checked after the 409 state checks above: a visa that
  // can't take a manual cost at all says so, rather than complaining about
  // the rates.)
  return buildManualCostFee({
    oldFee,
    baseCostUsd: visa.baseCostUsd,
    contentHash,
    input,
    setBy,
    now,
  });
}

/**
 * Build the manual-cost fee block, shared by a pending scraped visa (#70,
 * planManualCost) and an open proposed edit to a live visa (#77,
 * planProposalManualCost in changes/visa-change-manual-cost.ts). The caller
 * has already done its own state checks (which doc, stale, blocked);
 * this function only does what is the same for both:
 *
 *  - rates: exactly one entry per distinct non-USD currency among the fee
 *    components, no gaps, no extras (else 400 VALIDATION_ERROR);
 *  - the audit block (`manualCost`): amount, reason, rates, setBy/setAt, the
 *    content hash it was set against, `previous` (the scraper's own state, or
 *    the ORIGINAL scraper state when correcting an earlier manual cost) and
 *    `supersedes` (the corrected entry, one level only);
 *  - the fee block: published `components` / `totals` kept, `totalUsd =
 *    amountUsd`, `fxSource: "manual"`, `fxDate` = today, no flags, any
 *    `replacedManualCost` audit entry carried forward.
 *
 * @param p.oldFee the fee block the cost replaces (absent on a pre-#59 doc)
 * @param p.baseCostUsd the cost stored next to it (for `previous`)
 * @param p.contentHash the extraction's content hash (recorded in the audit)
 * @param p.input the validated cost fields
 * @param p.setBy admin uid
 * @param p.now injected clock (setAt + fxDate)
 * @returns `baseCostUsd = Math.round(amountUsd)` and the new fee block
 */
export function buildManualCostFee(p: {
  oldFee: VisaFeeMeta | undefined;
  baseCostUsd: number | undefined;
  contentHash: string;
  input: ManualCostFields;
  setBy: string;
  now: Timestamp;
}): ManualCostPlan {
  const { oldFee, contentHash, input, setBy, now } = p;
  // ---- Rates: exactly one per distinct non-USD fee currency ----
  // Every currency the admin had to convert must say which rate they used
  // (no extras, no gaps), so the audit trail can always be re-checked.
  const needed = feeCurrencies(oldFee);
  const given = input.rates.map((r) => r.currency);
  const missing = needed.filter((c) => !given.includes(c));
  const extra = given.filter((c) => !needed.includes(c));
  if (missing.length > 0 || extra.length > 0) {
    const parts: string[] = [];
    if (missing.length > 0) parts.push(`missing a rate for ${missing.join(", ")}`);
    if (extra.length > 0) parts.push(`the fee has no ${extra.join(", ")} component`);
    throw invalid(
      `rates must have exactly one entry per non-USD fee currency (${needed.join(", ") || "none"}): ${parts.join("; ")}`
    );
  }

  // ---- What the scraper said, for the audit trail ----
  // Re-editing a manual cost keeps the ORIGINAL scraper state (the old
  // manual entry's `previous`), and records the entry it supersedes.
  const previous: VisaManualCostMeta["previous"] = oldFee?.manualCost
    ? { ...oldFee.manualCost.previous }
    : scraperState(oldFee, p.baseCostUsd);

  const manualCost: VisaManualCostMeta = {
    amountUsd: input.amountUsd,
    reason: input.reason,
    rates: input.rates.map((r) => ({ ...r })),
    setBy,
    setAt: now,
    contentHash,
    previous,
  };
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

/**
 * The distinct non-USD currencies among a fee's components, in source order
 * (components with no currency — a zero part — are skipped). [] for no fee
 * block, no components, or a USD-only fee.
 */
export function feeCurrencies(fee: Pick<VisaFeeMeta, "components"> | undefined): string[] {
  const out: string[] = [];
  for (const c of fee?.components ?? []) {
    if (c.currency && c.currency !== "USD" && !out.includes(c.currency)) out.push(c.currency);
  }
  return out;
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
  // Both the #71 array and the legacy joined string, as an array.
  const reasons = storedFeeUnverifiedReasons(fee);
  if (reasons.length > 0) p.feeUnverifiedReasons = reasons;
  if (fee?.noPublishedFee) p.noPublishedFee = true;
  if (typeof fee?.totalUsd === "number") p.totalUsd = fee.totalUsd;
  if (fee?.fxSource) p.fxSource = fee.fxSource;
  if (typeof baseCostUsd === "number" && Number.isFinite(baseCostUsd)) p.baseCostUsd = baseCostUsd;
  return p;
}

// ----- A later scrape replacing a manual cost -----

/** What ingest's pending-refresh write must do about a manual cost. */
export interface ManualCostOverwritePlan {
  // The fee block to write (the new extraction's, plus the audit entry — or,
  // when the manual cost is kept, the new components with the manual total).
  fee: VisaFeeMeta;
  // True: delete `baseCostUsd` — the old value was the manual one and the new
  // extraction supports no cost (flags), so it must not stay behind.
  deleteCost: boolean;
  // Set when the manual cost is KEPT (same page text): write this as
  // `baseCostUsd`, overriding whatever the extraction converted.
  keptManualCostUsd?: number;
  // The manual entry this refresh replaced (for logging); absent when the
  // existing fee had no manual cost, or it was kept.
  replaced?: VisaReplacedManualCostMeta;
}

/**
 * Called by ingest's pending-refresh branch, inside its transaction.
 *
 * SAME content hash as the stored extraction (a prompt-only re-extract,
 * issue #71) and the stored fee has a manual cost → KEEP it: the page text
 * the admin confirmed is unchanged. The new block takes the new extraction's
 * `components` / `totals` (they are what the source publishes) and the
 * manual `totalUsd` / `fxSource` / `fxDate` / `manualCost`, with no flags;
 * `keptManualCostUsd` tells ingest to write `round(amountUsd)`.
 *
 * CHANGED content hash → the new extraction wins (the "normal path"):
 *  - it converted → its `baseCostUsd` replaces the manual one;
 *  - it is flagged (fxMissing / fxStale / feeUnverified / noPublishedFee) →
 *    the manual `baseCostUsd` is deleted, so the flags block approval until
 *    an admin sets a cost again.
 * Never silently: the replaced manual entry is stored on the new fee block as
 * `replacedManualCost` (+ when and by which content hash).
 *
 * An existing `replacedManualCost` (from an earlier overwrite) is carried
 * forward when nothing new was replaced.
 *
 * @param p.existingFee the stored `scrapeMeta.fee` (may be absent)
 * @param p.existingContentHash the stored `scrapeMeta.contentHash`
 * @param p.newFee computeFee().feeMeta for the new extraction (not mutated)
 * @param p.newBaseCostUsd computeFee().baseCostUsd (undefined = no usable cost)
 * @param p.contentHash the new extraction's content hash
 */
export function planManualCostOverwrite(p: {
  existingFee: VisaFeeMeta | undefined;
  existingContentHash: string | undefined;
  newFee: VisaFeeMeta;
  newBaseCostUsd: number | undefined;
  contentHash: string;
  now: Timestamp;
}): ManualCostOverwritePlan {
  const { existingFee, newFee } = p;
  const manual = existingFee?.manualCost;

  // ---- Same page text: the manual cost survives ----
  if (manual && p.existingContentHash === p.contentHash) {
    const fee: VisaFeeMeta = {
      components: newFee.components,
      totals: newFee.totals,
      totalUsd: manual.amountUsd,
      fxSource: FX_SOURCE_MANUAL,
      fxDate: existingFee?.fxDate ?? p.now.toDate().toISOString().slice(0, 10),
      manualCost: manual,
    };
    if (existingFee?.replacedManualCost) fee.replacedManualCost = existingFee.replacedManualCost;
    return { fee, deleteCost: false, keptManualCostUsd: Math.round(manual.amountUsd) };
  }

  // ---- Changed page: the new extraction replaces it, recorded ----
  const fee: VisaFeeMeta = { ...newFee };
  if (manual) {
    const replaced = markManualCostReplaced(manual, p.contentHash, p.now);
    fee.replacedManualCost = replaced;
    return { fee, deleteCost: p.newBaseCostUsd === undefined, replaced };
  }
  if (existingFee?.replacedManualCost) fee.replacedManualCost = existingFee.replacedManualCost;
  return { fee, deleteCost: false };
}

/**
 * The audit record of a manual cost that a newer extraction replaced:
 * the manual entry itself plus when (`replacedAt`) and by which page text
 * (`replacedByContentHash`). Shared by a pending visa's refresh
 * (planManualCostOverwrite, #70) and a re-proposal replacing an open
 * proposal that carried a manual cost (planProposalWrite, #77), so both
 * audit trails have the same shape.
 *
 * @param manual the manual cost that is being replaced
 * @param contentHash the content hash of the extraction replacing it
 * @param now when it was replaced
 */
export function markManualCostReplaced(
  manual: VisaManualCostMeta,
  contentHash: string,
  now: Timestamp
): VisaReplacedManualCostMeta {
  return { ...manual, replacedAt: now, replacedByContentHash: contentHash };
}
