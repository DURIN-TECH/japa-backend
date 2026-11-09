import { Timestamp } from "firebase-admin/firestore";
import type { VisaType } from "../types";
import type {
  ExtractedFeeComponent,
  FxRatesDoc,
  VisaFeeComponentMeta,
  VisaFeeMeta,
} from "../types/visa-catalog";
import { VISA_CATALOG_USER_AGENT } from "./visa-catalog-fetch.service";

// ============================================
// VISA CATALOG — FEES + CURRENCY CONVERSION (pure, issue #59)
// ============================================
//
// The extractor returns each visa fee EXACTLY as the source prints it
// (amount + ISO 4217 currency + label, each cited). Everything numeric happens
// here, in code:
//   1. sum the components per currency (per:"year" amount x years),
//   2. convert each currency total to USD with a stored rate (or an official
//      peg), sum, and round ONCE to whole USD → `baseCostUsd`.
// A missing or stale rate NEVER produces a number: the fee is stored in its
// source currency with `fxMissing` / `fxStale`, `baseCostUsd` is left alone,
// and approval is blocked until a rate exists (assertVisaApprovable).
//
// This module is Firebase-free (only the `Timestamp` class, which works
// without Admin init) so it is unit-testable without an emulator. The
// Firestore side (`appConfig/fx` reads/writes, re-converting flagged visas)
// lives in visa-catalog.service.ts and calls into here.

// ----- Constants -----

/** Max age of the stored rate, measured from OUR `fetchedAt` (not the API
 *  `date`, which lags over weekends/holidays). Matches the weekly crawl. */
export const FX_MAX_AGE_DAYS = 7;

/** Max age of the rate's own ECB reference DATE (`rateDate`). The
 *  orchestrator re-fetches on every tick that crawls a source (at least once a
 *  day, since every night of the week has sources in its window — issue #63)
 *  and rewrites `fetchedAt` each time, so if Frankfurter kept serving an old
 *  `date` (an ECB or API outage) `fetchedAt` alone would make it look fresh
 *  forever. 14 days leaves plenty of slack for
 *  weekends and holiday runs (the ECB publishes each TARGET working day). */
export const FX_MAX_RATE_DATE_AGE_DAYS = 14;

/** Plausibility cap per fee component, in USD (after conversion). A component
 *  worth more than this is almost certainly a mis-read (salary, savings
 *  requirement, wrong units) — the fee is marked `feeUnverified` and approval
 *  is blocked. Checked in USD, not in the source currency, because
 *  high-denomination currencies (IDR, VND, COP, ... — all in the registry)
 *  legitimately print fees far above 100000 units. */
export const MAX_FEE_COMPONENT_USD = 100_000;

/** Frankfurter "latest" endpoint, rebased to USD, no symbol filter (~30 ECB
 *  currencies, small payload). Free, no key. The old api.frankfurter.app host
 *  301-redirects, so use the .dev/v1 host directly. */
export const FRANKFURTER_LATEST_URL = "https://api.frankfurter.dev/v1/latest?base=USD";

/** `fxSource` / `appConfig/fx.source` label for Frankfurter rates. */
export const FX_SOURCE_ECB = "frankfurter.dev (ECB reference rates)";

/** `fxSource` label for a conversion done with OFFICIAL_USD_PEGS. */
export const FX_SOURCE_PEG = "official peg";

/**
 * Official fixed USD pegs, in LOCAL currency units per 1 USD (same direction
 * as the Frankfurter `rates`). These currencies are not in the ECB reference
 * set, and their central banks hold a hard peg, so a static constant is exact
 * and never stale. Used before any stored rate. Change only if a central bank
 * changes its peg.
 */
export const OFFICIAL_USD_PEGS: Readonly<Record<string, number>> = {
  // UAE dirham — Central Bank of the UAE: pegged at AED 3.6725 = USD 1 since
  // November 1997 (centralbank.ae, "Exchange rate policy").
  AED: 3.6725,
  // Saudi riyal — Saudi Central Bank (SAMA): pegged at SAR 3.75 = USD 1 since
  // June 1986 (sama.gov.sa, monetary policy / exchange rate).
  SAR: 3.75,
  // Qatari riyal — Qatar Central Bank: pegged at QAR 3.64 = USD 1, fixed by
  // Emiri Decree No. 34 of 2001 (qcb.gov.qa, monetary policy).
  QAR: 3.64,
};

/**
 * Static allow-list of active ISO 4217 currency codes (no network). Used by
 * the validator: a non-zero fee component must name one of these. Excludes
 * withdrawn codes, precious metals and test codes (XAU, XTS, XXX, ...), so an
 * invented code like "XXQ" is rejected.
 */
export const ISO_4217_CODES: ReadonlySet<string> = new Set([
  "AED", "AFN", "ALL", "AMD", "ANG", "AOA", "ARS", "AUD", "AWG", "AZN",
  "BAM", "BBD", "BDT", "BGN", "BHD", "BIF", "BMD", "BND", "BOB", "BRL",
  "BSD", "BTN", "BWP", "BYN", "BZD", "CAD", "CDF", "CHF", "CLP", "CNY",
  "COP", "CRC", "CUP", "CVE", "CZK", "DJF", "DKK", "DOP", "DZD", "EGP",
  "ERN", "ETB", "EUR", "FJD", "FKP", "GBP", "GEL", "GHS", "GIP", "GMD",
  "GNF", "GTQ", "GYD", "HKD", "HNL", "HTG", "HUF", "IDR", "ILS", "INR",
  "IQD", "IRR", "ISK", "JMD", "JOD", "JPY", "KES", "KGS", "KHR", "KMF",
  "KPW", "KRW", "KWD", "KYD", "KZT", "LAK", "LBP", "LKR", "LRD", "LSL",
  "LYD", "MAD", "MDL", "MGA", "MKD", "MMK", "MNT", "MOP", "MRU", "MUR",
  "MVR", "MWK", "MXN", "MYR", "MZN", "NAD", "NGN", "NIO", "NOK", "NPR",
  "NZD", "OMR", "PAB", "PEN", "PGK", "PHP", "PKR", "PLN", "PYG", "QAR",
  "RON", "RSD", "RUB", "RWF", "SAR", "SBD", "SCR", "SDG", "SEK", "SGD",
  "SHP", "SLE", "SOS", "SRD", "SSP", "STN", "SVC", "SYP", "SZL", "THB",
  "TJS", "TMT", "TND", "TOP", "TRY", "TTD", "TWD", "TZS", "UAH", "UGX",
  "USD", "UYU", "UZS", "VES", "VND", "VUV", "WST", "XAF", "XCD", "XCG",
  "XOF", "XPF", "YER", "ZAR", "ZMW", "ZWG",
]);

/** True for a known ISO 4217 code (exact, upper-case). */
export function isIso4217(code: string): boolean {
  return ISO_4217_CODES.has(code);
}

const DAY_MS = 24 * 60 * 60 * 1000;

// ----- Fetching + storing the rate document -----

/** What a rate fetch returns (the subset of the Frankfurter payload we keep). */
export interface FetchedFxRates {
  rates: Record<string, number>; // local units per 1 USD
  rateDate: string; // API `date`, YYYY-MM-DD
}

/** Injected rate fetcher (tests pass a stub; production uses Frankfurter). */
export type FxFetcher = () => Promise<FetchedFxRates>;

/**
 * Default fetcher: GET Frankfurter latest?base=USD. Validates the payload
 * shape and keeps only finite, positive rates. Throws on HTTP error or a bad
 * payload (the caller keeps the previous stored doc).
 *
 * @param fetchImpl injectable `fetch` (defaults to the global one).
 */
export async function fetchFrankfurterRates(
  fetchImpl: typeof fetch = fetch
): Promise<FetchedFxRates> {
  const resp = await fetchImpl(FRANKFURTER_LATEST_URL, {
    headers: { "User-Agent": VISA_CATALOG_USER_AGENT, Accept: "application/json" },
  });
  if (!resp.ok) throw new Error(`Frankfurter HTTP ${resp.status}`);
  const body = (await resp.json()) as { base?: unknown; date?: unknown; rates?: unknown };
  if (body.base !== "USD" || typeof body.date !== "string" || !body.rates || typeof body.rates !== "object") {
    throw new Error("Frankfurter returned an unexpected payload");
  }
  const rates: Record<string, number> = {};
  for (const [code, v] of Object.entries(body.rates as Record<string, unknown>)) {
    if (typeof v === "number" && Number.isFinite(v) && v > 0) rates[code] = v;
  }
  if (Object.keys(rates).length === 0) throw new Error("Frankfurter returned no rates");
  return { rates, rateDate: body.date };
}

/** Storage for `appConfig/fx` (Firestore in production, an in-memory stub in tests). */
export interface FxStore {
  get(): Promise<FxRatesDoc | undefined>;
  set(doc: FxRatesDoc): Promise<void>;
}

/** Outcome of one refresh attempt. `fx` is the doc to use for this run. */
export interface FxRefreshResult {
  fx: FxRatesDoc | undefined; // freshly written doc, or the previous one on failure
  refreshed: boolean;
  error?: string;
}

/**
 * Refresh the stored rates ONCE per crawl run, before extraction.
 *  - Success: write `{ base, rates, fetchedAt: now, rateDate, source }`.
 *  - Failure (network, HTTP, bad payload, store write): log, KEEP the previous
 *    doc (never overwrite with nothing), and return it so the run continues.
 *    If that previous rate is still within FX_MAX_AGE_DAYS it is still used.
 * Never throws.
 */
export async function refreshFxRates(params: {
  fetchRates: FxFetcher;
  store: FxStore;
  now: Timestamp;
  log?: (msg: string) => void;
}): Promise<FxRefreshResult> {
  const log = params.log ?? ((m: string) => console.warn(m));

  // ---- 1. Fetch. Failure → keep (and use) the previous stored doc ----
  let doc: FxRatesDoc;
  try {
    const fetched = await params.fetchRates();
    doc = {
      base: "USD",
      rates: fetched.rates,
      fetchedAt: params.now,
      rateDate: fetched.rateDate,
      source: FX_SOURCE_ECB,
    };
  } catch (err) {
    const error = (err as Error)?.message ?? String(err);
    log(`[visa-catalog-fx] FX refresh failed, keeping previous appConfig/fx: ${error}`);
    // Read the previous doc; a failing read just means "no rate".
    const previous = await params.store.get().catch(() => undefined);
    return { fx: previous, refreshed: false, error };
  }

  // ---- 2. Store. Failure → still use the FRESH rates for this run ----
  // (`refreshed:false` because nothing was persisted; the next run retries.)
  try {
    await params.store.set(doc);
    return { fx: doc, refreshed: true };
  } catch (err) {
    const error = (err as Error)?.message ?? String(err);
    log(`[visa-catalog-fx] FX fetched but storing appConfig/fx failed; using fresh rates for this run: ${error}`);
    return { fx: doc, refreshed: false, error };
  }
}

/**
 * True when the stored doc is usable at `now`: fetched no more than
 * FX_MAX_AGE_DAYS ago AND its ECB `rateDate` is no more than
 * FX_MAX_RATE_DATE_AGE_DAYS old. An unparseable `rateDate` counts as stale.
 */
export function isFxFresh(fx: FxRatesDoc | undefined, now: Timestamp): boolean {
  if (!fx?.fetchedAt) return false;
  if (now.toMillis() - fx.fetchedAt.toMillis() > FX_MAX_AGE_DAYS * DAY_MS) return false;
  // `rateDate` is a plain YYYY-MM-DD (UTC day).
  const rateMs = Date.parse(`${fx.rateDate}T00:00:00Z`);
  if (!Number.isFinite(rateMs)) return false;
  return now.toMillis() - rateMs <= FX_MAX_RATE_DATE_AGE_DAYS * DAY_MS;
}

// ----- computeFee -----

/** The result of converting one visa's fee. */
export interface ComputedFee {
  // Whole USD. UNDEFINED when any currency had no usable rate (or there are no
  // components): callers must then not write `baseCostUsd` at all.
  baseCostUsd?: number;
  feeMeta: VisaFeeMeta;
}

/**
 * Compute the fee totals and the USD cost from the extracted components.
 *
 * Rules:
 *  - Component total = amount (per:"application") or amount x years (per:"year").
 *  - Totals are summed per currency; each currency is converted separately.
 *  - Rate per currency: USD → 1; OFFICIAL_USD_PEGS → peg (never stale, works
 *    with no stored doc); else the stored Frankfurter rate if the doc is
 *    within FX_MAX_AGE_DAYS. A currency with a stored-but-old rate is
 *    `fxStale`; a currency with no rate at all is `fxMissing`. Any such
 *    currency → no `baseCostUsd`, no `totalUsd` (never a fake 0).
 *  - Zero-amount totals need no rate (a free visa converts to 0 without FX).
 *  - USD = sum(total / ratePerUsd); `baseCostUsd = Math.round(totalUsd)`
 *    (rounded once, whole USD).
 *  - Empty components (the page states no fee) → no `baseCostUsd`: the
 *    reviewer sets the cost by hand (approval is blocked until then).
 *
 *  - Unverified fee (review fix): when the validator dropped a per-year
 *    surcharge it could not verify (`opts.unverifiedReasons`), or a component
 *    converts to more than MAX_FEE_COMPONENT_USD, the fee is marked
 *    `feeUnverified` (+ reason) and no `baseCostUsd` is produced — the total
 *    would be incomplete or implausible. Approval is blocked.
 *
 * @param now injected clock (staleness + the peg conversion date).
 * @param opts.unverifiedReasons why parts of the fee could not be verified.
 */
export function computeFee(
  components: ExtractedFeeComponent[],
  fx: FxRatesDoc | undefined,
  now: Timestamp,
  opts?: { unverifiedReasons?: string[] }
): ComputedFee {
  const unverified: string[] = [...(opts?.unverifiedReasons ?? [])];
  // ---- 1. Per-component totals (arithmetic in code, never in the LLM) ----
  const metaComponents: VisaFeeComponentMeta[] = components.map((c) => {
    const totalInCurrency = c.per === "year" ? c.amount * (c.years ?? 0) : c.amount;
    const m: VisaFeeComponentMeta = {
      kind: c.kind,
      label: c.label,
      amount: c.amount,
      currency: c.currency,
      per: c.per,
      totalInCurrency,
    };
    // Only copy `years` when present — no `undefined` reaches Firestore.
    if (c.years !== undefined) m.years = c.years;
    return m;
  });

  // ---- 2. Per-currency totals (insertion order = source order) ----
  const byCurrency = new Map<string, number>();
  for (const c of metaComponents) {
    // A zero component may have no currency; it adds nothing to any total.
    if (!c.currency) continue;
    byCurrency.set(c.currency, (byCurrency.get(c.currency) ?? 0) + c.totalInCurrency);
  }
  const totals = [...byCurrency.entries()].map(([currency, amount]) => ({ currency, amount }));

  const feeMeta: VisaFeeMeta = { components: metaComponents, totals };

  // Nothing published → nothing to convert, and no cost to claim. Recorded
  // explicitly so an existing doc's old `baseCostUsd` is removed on ingest
  // (never left standing next to a fee block that no longer supports it).
  if (metaComponents.length === 0) {
    feeMeta.noPublishedFee = true;
    applyUnverified(feeMeta, unverified);
    return { feeMeta };
  }

  // ---- 3. Convert each currency total ----
  const fresh = isFxFresh(fx, now);
  const fxRateToUsd: Record<string, number> = {};
  const sources = new Set<string>();
  let usedEcb = false;
  let usedPeg = false;
  let totalUsd = 0;
  let stale = false;
  let missing = false;

  for (const { currency, amount } of totals) {
    if (amount === 0) continue; // 0 in any currency is 0 USD — no rate needed
    if (currency === "USD") {
      totalUsd += amount; // rate 1, no FX source
      continue;
    }
    const peg = OFFICIAL_USD_PEGS[currency];
    if (peg !== undefined) {
      totalUsd += amount / peg;
      fxRateToUsd[currency] = 1 / peg;
      usedPeg = true;
      continue;
    }
    const stored = fx?.rates?.[currency];
    if (typeof stored !== "number" || !Number.isFinite(stored) || stored <= 0) {
      missing = true; // e.g. TWD / NGN: ECB does not publish it
      continue;
    }
    if (!fresh) {
      stale = true; // a rate exists but is older than FX_MAX_AGE_DAYS
      continue;
    }
    totalUsd += amount / stored;
    fxRateToUsd[currency] = 1 / stored;
    usedEcb = true;
  }

  // ---- 4. Provenance (only fields that apply; never `undefined`) ----
  if (usedEcb) sources.add(FX_SOURCE_ECB);
  if (usedPeg) sources.add(FX_SOURCE_PEG);
  if (Object.keys(fxRateToUsd).length > 0) feeMeta.fxRateToUsd = fxRateToUsd;
  if (sources.size > 0) {
    feeMeta.fxSource = [...sources].join(" + ");
    // ECB date when ECB rates were used, else the conversion date (pegs).
    feeMeta.fxDate = usedEcb && fx ? fx.rateDate : now.toDate().toISOString().slice(0, 10);
  }
  if (stale) feeMeta.fxStale = true;
  if (missing) feeMeta.fxMissing = true;

  // ---- 5. Plausibility: each converted component <= MAX_FEE_COMPONENT_USD ----
  for (const c of metaComponents) {
    const usdPerUnit = c.currency === "USD" ? 1 : fxRateToUsd[c.currency];
    if (usdPerUnit !== undefined && c.totalInCurrency * usdPerUnit > MAX_FEE_COMPONENT_USD) {
      unverified.push(
        `"${c.label}" (${c.totalInCurrency} ${c.currency}) exceeds the ${MAX_FEE_COMPONENT_USD} USD plausibility cap`
      );
    }
  }
  applyUnverified(feeMeta, unverified);

  // Any unconverted currency, or an unverified fee → no USD figure at all
  // (never a partial, implausible or fake-0 number).
  if (stale || missing || feeMeta.feeUnverified) return { feeMeta };

  feeMeta.totalUsd = totalUsd;
  return { baseCostUsd: Math.round(totalUsd), feeMeta };
}

/** Set `feeUnverified` + a joined reason when there are reasons (else nothing). */
function applyUnverified(feeMeta: VisaFeeMeta, reasons: string[]): void {
  if (reasons.length === 0) return;
  feeMeta.feeUnverified = true;
  feeMeta.feeUnverifiedReason = reasons.join("; ");
}

/** True when a stored fee block is flagged as not converted. */
export function isFeeFxFlagged(fee: VisaFeeMeta | undefined): boolean {
  return Boolean(fee?.fxStale || fee?.fxMissing);
}

// ----- Re-converting flagged visas after a refresh (no LLM call) -----

/** The write planned for one flagged visa: the new fee block, plus the USD
 *  cost when a rate now exists. */
export interface FeeReconvertPlan {
  fee: VisaFeeMeta;
  baseCostUsd?: number;
}

/**
 * After `appConfig/fx` refreshes, decide whether a stored visa's fee can be
 * re-converted from its stored `scrapeMeta.fee.components` — no LLM call, and
 * the content hash is not touched.
 *
 * Returns null (no write) when:
 *  - the doc is not a PENDING SCRAPED visa (approved / seeded / agent docs are
 *    never touched), or
 *  - its fee is not flagged fxStale / fxMissing, or
 *  - the re-computation is still flagged with the SAME flags (avoid a no-op
 *    write every run for e.g. a TWD fee).
 * Otherwise returns the new fee block, with `baseCostUsd` when it converted
 * (the flags are then cleared because the new block has none).
 */
export function planFeeReconvert(
  visa: Pick<VisaType, "source" | "reviewStatus" | "scrapeMeta">,
  fx: FxRatesDoc | undefined,
  now: Timestamp
): FeeReconvertPlan | null {
  if (visa.source !== "scraped" || visa.reviewStatus !== "pending_review") return null;
  const fee = visa.scrapeMeta?.fee;
  if (!fee || !isFeeFxFlagged(fee)) return null;

  // Strip the derived `totalInCurrency` back to the extracted component shape.
  const components: ExtractedFeeComponent[] = fee.components.map((c) => {
    const e: ExtractedFeeComponent = {
      kind: c.kind,
      label: c.label,
      amount: c.amount,
      currency: c.currency,
      per: c.per,
    };
    if (c.years !== undefined) e.years = c.years;
    return e;
  });
  // Carry a stored "unverified" reason through: the dropped component isn't in
  // `components`, so the fee stays unverified (and unapprovable) after a
  // re-convert. (A plausibility reason is re-derived by computeFee itself.)
  const storedReasons = (fee.feeUnverifiedReason ?? "")
    .split("; ")
    .filter((r) => r && !r.includes("plausibility cap"));
  const result = computeFee(components, fx, now, { unverifiedReasons: storedReasons });

  if (result.baseCostUsd === undefined) {
    // Still no usable rate. Only write if the flags themselves changed
    // (e.g. stale → missing); otherwise leave the doc alone.
    const sameFlags =
      Boolean(result.feeMeta.fxStale) === Boolean(fee.fxStale) &&
      Boolean(result.feeMeta.fxMissing) === Boolean(fee.fxMissing);
    return sameFlags ? null : { fee: result.feeMeta };
  }
  return { fee: result.feeMeta, baseCostUsd: result.baseCostUsd };
}

// ----- Approval guard -----

/** Message returned to the reviewer when approval is refused because the
 *  fee could not be turned into a trustworthy USD cost. (There is no API to
 *  set a cost by hand yet — follow-up issue — so it names what works today.) */
export const FEE_NOT_CONVERTED_MESSAGE =
  "Fee could not be converted to USD (stale/missing exchange rate or unverified fee). " +
  "Re-run the crawl or reject.";

/** Message when the visa has no valid USD cost (missing, or out of step with
 *  its stored published fee). */
export const FEE_MISSING_COST_MESSAGE =
  "Visa has no valid USD cost (baseCostUsd is missing or does not match the published fee). " +
  "Re-run the crawl or reject.";

/**
 * Typed error thrown by visaService.updateVisaReviewStatus when an approval is
 * refused because the visa has no usable USD cost. The controller maps it to
 * HTTP 409 with `message`.
 */
export class VisaFeeNotConvertibleError extends Error {
  readonly code = "FEE_NOT_CONVERTED";
  constructor(message: string = FEE_NOT_CONVERTED_MESSAGE) {
    super(message);
    this.name = "VisaFeeNotConvertibleError";
  }
}

/**
 * Throw VisaFeeNotConvertibleError when `visa` must not be approved:
 *  - a scraped visa whose `scrapeMeta.fee` is fxMissing / fxStale, or
 *    feeUnverified (a surcharge was dropped, or a component is implausible);
 *  - any visa whose `baseCostUsd` is not a finite number (approving it would
 *    make e.g. application totals NaN);
 *  - a scraped visa whose `baseCostUsd` is not exactly
 *    `Math.round(scrapeMeta.fee.totalUsd)` — the cost must be the one its
 *    stored published fee supports (catches an old cost left behind when the
 *    page changed, and pre-#59 scraped docs that have no fee block at all).
 * Only called for `approve`; rejecting is never blocked.
 */
export function assertVisaApprovable(
  visa: Pick<VisaType, "source" | "scrapeMeta" | "baseCostUsd">
): void {
  const fee = visa.scrapeMeta?.fee;
  if (visa.source === "scraped" && (isFeeFxFlagged(fee) || fee?.feeUnverified)) {
    throw new VisaFeeNotConvertibleError(FEE_NOT_CONVERTED_MESSAGE);
  }
  if (typeof visa.baseCostUsd !== "number" || !Number.isFinite(visa.baseCostUsd)) {
    throw new VisaFeeNotConvertibleError(FEE_MISSING_COST_MESSAGE);
  }
  if (visa.source === "scraped") {
    const totalUsd = fee?.totalUsd;
    if (typeof totalUsd !== "number" || !Number.isFinite(totalUsd) || visa.baseCostUsd !== Math.round(totalUsd)) {
      throw new VisaFeeNotConvertibleError(FEE_MISSING_COST_MESSAGE);
    }
  }
}
