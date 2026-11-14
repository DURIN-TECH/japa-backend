import { Timestamp } from "firebase-admin/firestore";
import type { ChargeSnapshot, CurrencyCode, Money, QuoteLock } from "../types/money";
import type { Consultation, Transaction } from "../types";
import { collections, db } from "../utils/firebase";
import { MAX_PRICE_USD_CENTS, readStoredUsd } from "../money/usd-price";
import { quote, toChargeSnapshot } from "../money/quote";
import { resolveChargeCurrency } from "../money/config";
import { fromMajor } from "../money/money";
import { getCurrencyInfo } from "../money/currencies";
import { isMoneyError } from "../money/errors";
import type { RateService } from "../money/rate.service";
import { paystackProvider, PaystackTransactionLookup } from "./billing/paystack.provider";
import { transactionService } from "./transaction.service";

// ============================================
// CONSULTATION CHARGING (issue #180, folds #166)
// ============================================
//
// How a consultation booking is priced, charged and confirmed. Shared by the
// guest booking (POST /agencies/public/:slug/consultations), the signed-in
// booking (POST /consultations), the retry (POST /consultations/:id/checkout)
// and the verify-on-return (POST /consultations/public/verify).
//
// THE RULES
//  1. The SERVER decides the price. It is read from the agency / agent record
//     (`consultationFeeUsd`, US dollars, issue #179). Any `fee`, `amount`,
//     `rate` or `currency` in a request body is never read.
//  2. Free ONLY when the stored fee is missing or a valid $0. Any other shape
//     (a string amount, a lower-case "usd", a leftover naira `consultationFee`
//     of any type, an amount over the price cap) is MALFORMED and the booking
//     is refused with 503: never booked free, never guessed.
//  3. A paid booking is priced with the #178 `quote()` at the current
//     effective rate in the client's charge currency (resolved on the server:
//     the signed-in client's profile country, or the default currency for an
//     anonymous guest). RATE_STALE / RATE_UNAVAILABLE / an unsupported or
//     disabled currency / a price that converts to zero all fail with a typed
//     MoneyError, which the controller answers 503 PRICING_UNAVAILABLE BEFORE
//     any Paystack call.
//  4. The quote is LOCKED on the booking: the ChargeSnapshot plus
//     `quoteLockedAt` and `quoteExpiresAt` (QUOTE_LOCK_MINUTES later). Inside
//     the lock a retry returns the same checkout. After it, a verify or retry
//     re-prices with a FRESH quote and opens a new checkout; a stale snapshot
//     is never charged again.
//  5. Paystack receives `amount = chargedAmountMinor` and `currency =
//     chargedCurrency` exactly as stored. On return, what Paystack reports it
//     charged must equal the stored amount AND currency, or nothing is
//     confirmed or recorded. An exact payment on the booking's CURRENT
//     reference is honoured even when it lands after the lock, and flagged
//     `paidAfterQuoteExpiry` for review: the lock governs ISSUING a checkout,
//     not honouring one we already issued. A payment on a superseded
//     reference is still refused.
//  6. Confirmation is ONE Firestore transaction: re-read the booking, and if
//     it is not paid yet flip it to paid/scheduled and write the fee
//     Transaction in the same commit. A second verify finds it paid and
//     writes nothing.
//  7. LEGACY bookings (before #180: `fee` in whole naira, no snapshot) are
//     never re-priced: they verify against `fee` read as NGN through the
//     currency table, and display as naira.

/** How long a locked quote may be charged, in minutes (plan decision on #180). */
export const QUOTE_LOCK_MINUTES = 30;

/** Milliseconds per minute (kept named so the lock maths reads plainly). */
const MINUTE_MS = 60_000;

// ============================================
// Swappable dependencies (tests inject in-memory ones)
// ============================================

/**
 * Where the charge path gets its rate service, the client's profile country,
 * the clock and the Firestore transaction runner. Defaults are the
 * production wiring; unit tests replace them (see
 * test/consultations/helpers.ts) so no Firestore or network is touched.
 */
export const consultationCharging: {
  /** The #178 rate service (production: wired to Firestore). */
  rates: () => Promise<RateService>;
  /** The stored profile country of a user, or undefined. */
  profileCountry: (uid: string) => Promise<string | undefined>;
  /** The clock (lock times and expiry checks). */
  now: () => Date;
  /** Runs `fn` in a Firestore transaction. */
  runTransaction: <T>(fn: (tx: FirebaseFirestore.Transaction) => Promise<T>) => Promise<T>;
} = {
  // Lazy import: money/index wires the production providers on load.
  rates: async () => (await import("../money/index")).rateService,
  profileCountry: async (uid) => {
    const snap = await collections.users.doc(uid).get();
    return snap.exists ? (snap.data() as { residentialCountry?: string }).residentialCountry : undefined;
  },
  now: () => new Date(),
  runTransaction: (fn) => db.runTransaction(fn),
};

// ============================================
// 1. The stored fee: free, paid, or malformed
// ============================================

/** What a stored agency / agent fee means for a booking. */
export type StoredFee =
  /** No fee set, or a valid $0: book without Paystack. */
  | { kind: "free" }
  /** A valid positive dollar fee: price it and charge it. */
  | { kind: "paid"; usd: Money }
  /** Anything else: refuse the booking (503), never book it free. */
  | { kind: "malformed"; reason: string };

/**
 * Classify the fee stored on an agency or agent doc (rule 2 in the header).
 * Pure.
 *
 * @param doc the agency or agent record as read from Firestore. Only
 *   `consultationFeeUsd` (the #179 dollar Money) and the old naira
 *   `consultationFee` are looked at.
 */
export function classifyStoredFee(doc: { consultationFeeUsd?: unknown; consultationFee?: unknown }): StoredFee {
  // A leftover naira fee of ANY type (number, string, map) means the doc was
  // never migrated, or was edited by hand: we cannot know the dollar price.
  // `null` is treated as absent, matching the #179 migration.
  if (doc.consultationFee !== undefined && doc.consultationFee !== null) {
    return { kind: "malformed", reason: "leftover naira consultationFee" };
  }
  const raw = doc.consultationFeeUsd;
  // Missing (or cleared with null) = no fee set = free.
  if (raw === undefined || raw === null) return { kind: "free" };
  // readStoredUsd accepts ONLY { amountMinor: safe integer >= 0, currency: "USD" }.
  const usd = readStoredUsd(raw);
  if (!usd) return { kind: "malformed", reason: "consultationFeeUsd is not a valid USD amount" };
  // Above the cap no API could have written it: a hand edit or corruption.
  if (usd.amountMinor > MAX_PRICE_USD_CENTS) {
    return { kind: "malformed", reason: "consultationFeeUsd is above the price cap" };
  }
  return usd.amountMinor === 0 ? { kind: "free" } : { kind: "paid", usd };
}

// ============================================
// 2. Pricing: quote + lock
// ============================================

/** The fields a paid booking stores when it is priced (snapshot + lock). */
export type LockedCharge = ChargeSnapshot & QuoteLock;

/**
 * The charge currency for a booking, resolved on the SERVER only:
 *  - a signed-in client (`uid`): their stored profile country (the #178
 *    `resolveChargeCurrency` rules; an unmapped country gets the default);
 *  - an anonymous guest (no `uid`): the config's default currency. A guest's
 *    typed email is NOT used to look up a country: that would tell an
 *    anonymous caller which country an account holder lives in, and the
 *    public page already shows the price in the default currency.
 */
export async function chargeCurrencyFor(uid: string | undefined): Promise<CurrencyCode> {
  const service = await consultationCharging.rates();
  const config = await service.getConfig();
  if (!uid) return config.defaultCurrency;
  const country = await consultationCharging.profileCountry(uid);
  return resolveChargeCurrency(country, config);
}

/**
 * Price a dollar fee in `currency` at the current effective rate and lock it
 * for QUOTE_LOCK_MINUTES. Throws the #178 MoneyError when there is no usable
 * rate, the currency is not chargeable, or the price converts to zero: the
 * caller answers 503 and calls nothing else.
 */
export async function lockQuote(usd: Money, currency: CurrencyCode): Promise<LockedCharge> {
  const service = await consultationCharging.rates();
  const q = await quote(usd, currency, service);
  const lockedAt = consultationCharging.now();
  return {
    ...toChargeSnapshot(q),
    quoteLockedAt: Timestamp.fromDate(lockedAt),
    quoteExpiresAt: Timestamp.fromMillis(lockedAt.getTime() + QUOTE_LOCK_MINUTES * MINUTE_MS),
  };
}

/** True when the booking's quote lock has passed (a missing lock counts as expired). */
export function isQuoteExpired(c: Pick<Consultation, "quoteExpiresAt">, at: Date = consultationCharging.now()): boolean {
  const expires = c.quoteExpiresAt;
  if (!expires || typeof (expires as Timestamp).toMillis !== "function") return true;
  return at.getTime() > (expires as Timestamp).toMillis();
}

/** True for a booking priced by #180 (it has a well-formed charge snapshot). */
export function hasChargeSnapshot(c: Partial<Consultation>): boolean {
  return (
    typeof c.chargedAmountMinor === "number" &&
    Number.isSafeInteger(c.chargedAmountMinor) &&
    c.chargedAmountMinor > 0 &&
    typeof c.chargedCurrency === "string" &&
    !!getCurrencyInfo(c.chargedCurrency) &&
    typeof c.priceUsdCents === "number" &&
    Number.isSafeInteger(c.priceUsdCents) &&
    c.priceUsdCents > 0
  );
}

/**
 * What Paystack must report it charged for this booking, or null when the
 * booking has nothing chargeable:
 *  - a #180 booking: exactly the stored `chargedAmountMinor` in `chargedCurrency`;
 *  - a LEGACY booking: its whole-naira `fee` as NGN, converted through the
 *    currency table (never `* 100` by hand), never re-priced.
 */
export function expectedCharge(c: Partial<Consultation>): Money | null {
  if (hasChargeSnapshot(c)) return { amountMinor: c.chargedAmountMinor!, currency: c.chargedCurrency! };
  if (typeof c.fee === "number" && c.fee > 0) {
    try {
      return fromMajor(c.fee, "NGN");
    } catch {
      return null; // a fractional / corrupt legacy fee: nothing we can verify against
    }
  }
  return null;
}

/** The snapshot fields of a booking, for a Transaction or a response. */
export function snapshotOf(c: Partial<Consultation>): Partial<ChargeSnapshot> {
  const out: Partial<ChargeSnapshot> = {};
  if (c.priceUsdCents !== undefined) out.priceUsdCents = c.priceUsdCents;
  if (c.chargedCurrency !== undefined) out.chargedCurrency = c.chargedCurrency;
  if (c.chargedAmountMinor !== undefined) out.chargedAmountMinor = c.chargedAmountMinor;
  if (c.fxRate !== undefined) out.fxRate = c.fxRate;
  if (c.fxRateAsOf !== undefined) out.fxRateAsOf = c.fxRateAsOf;
  if (c.fxRateSource !== undefined) out.fxRateSource = c.fxRateSource;
  if (c.fxMarginBps !== undefined) out.fxMarginBps = c.fxMarginBps;
  return out;
}

/** True for a typed money error the HTTP layer answers 503 PRICING_UNAVAILABLE. */
export function isPricingFailure(err: unknown): boolean {
  return isMoneyError(err);
}

// ============================================
// 3. Opening a checkout
// ============================================

/**
 * Open a Paystack checkout for a locked charge and store the reference and
 * checkout URL on the booking. The amount and currency Paystack receives are
 * the STORED `chargedAmountMinor` / `chargedCurrency`, nothing else.
 *
 * @returns the checkout URL and the Paystack reference
 * @throws the provider's `PAYSTACK_ERROR: ...` (the controller answers 502);
 *   the booking then stays pending with no reference, and a retry can open one
 */
export async function openCheckout(input: {
  consultationId: string;
  email: string;
  charge: Pick<ChargeSnapshot, "chargedAmountMinor" | "chargedCurrency">;
  callbackUrl: string;
  /** Extra metadata echoed back by Paystack (e.g. the agency slug). */
  metadata?: Record<string, unknown>;
}): Promise<{ authorizationUrl: string; reference: string }> {
  const { authorizationUrl, reference } = await paystackProvider.initializeCharge({
    email: input.email,
    amount: { amountMinor: input.charge.chargedAmountMinor, currency: input.charge.chargedCurrency },
    metadata: { ...(input.metadata ?? {}), purpose: "consultation", consultationId: input.consultationId },
    callbackUrl: input.callbackUrl,
  });
  // Stash the pending reference so verify-on-return can match it, and the
  // checkout URL so a retry inside the lock returns this same checkout.
  await collections.consultations.doc(input.consultationId).update({
    transactionId: reference,
    checkoutUrl: authorizationUrl,
    checkoutCallbackUrl: input.callbackUrl,
    updatedAt: Timestamp.now(),
  });
  return { authorizationUrl, reference };
}

/**
 * Re-price an unpaid #180 booking whose lock has passed (rule 4): a FRESH
 * quote of the booking's dollar price (`priceUsdCents`, the price agreed at
 * booking time) in its charge currency, a new lock, and a new checkout.
 * Throws a MoneyError (503) before any Paystack call when no rate can price
 * it, and the provider error (502) when Paystack fails.
 */
export async function requote(c: Consultation, fallbackCallbackUrl: string): Promise<{
  authorizationUrl: string;
  reference: string;
  charge: LockedCharge;
}> {
  const usd: Money = { amountMinor: c.priceUsdCents!, currency: "USD" };
  const charge = await lockQuote(usd, c.chargedCurrency!);
  // Store the new snapshot and lock first, and clear the old reference and
  // checkout, so the stale reference can never be confirmed (verify refuses a
  // reference that is not the one stored on the booking).
  await collections.consultations.doc(c.id).update({
    ...charge,
    transactionId: null,
    checkoutUrl: null,
    updatedAt: Timestamp.now(),
  });
  const callbackUrl = c.checkoutCallbackUrl || fallbackCallbackUrl;
  const opened = await openCheckout({ consultationId: c.id, email: c.clientEmail, charge, callbackUrl });
  return { ...opened, charge };
}

// ============================================
// 4. Checking what Paystack reports, and confirming
// ============================================

/**
 * Whether a successful Paystack charge is accepted for a booking.
 *
 * Accepted (`ok: true`) carries what was charged, Paystack's own payment
 * time when it reported one, and `paidAfterQuoteExpiry` when a #180 booking
 * was paid after its quote lock had passed (orchestrator decision on #180:
 * an EXACT payment on the checkout we issued is honoured even when late; the
 * flag marks it for review).
 */
export type ChargeCheck =
  | { ok: true; charged: Money; paidAfterQuoteExpiry: boolean; providerPaidAt: Date | null }
  /** The amount or currency differs from the stored charge (underpayment, wrong currency). */
  | { ok: false; reason: "mismatch" }
  /** The booking has nothing chargeable stored. */
  | { ok: false; reason: "not_chargeable" };

/**
 * Compare what Paystack reports it charged with what the booking stored
 * (rule 5). Pure. A missing amount / currency in the report is a mismatch.
 *
 * Late payments (issue #180 decision): "never reuse a stale quote" governs
 * ISSUING a checkout, not honouring one we already issued. A payment of
 * exactly the stored amount and currency on the booking's current reference
 * is accepted even when it completed after `quoteExpiresAt` (Paystack's
 * `paidAt`; when absent, the time of this check); it is then flagged
 * `paidAfterQuoteExpiry`. The reference check (only the reference stored on
 * the booking may settle it) is done by the callers and again in confirmPaid.
 */
export function checkReportedCharge(c: Consultation, reported: PaystackTransactionLookup, at: Date): ChargeCheck {
  const expected = expectedCharge(c);
  if (!expected) return { ok: false, reason: "not_chargeable" };
  if (reported.amount !== expected.amountMinor || reported.currency !== expected.currency) {
    return { ok: false, reason: "mismatch" };
  }
  const paidAtMs = reported.paidAt ? Date.parse(reported.paidAt) : NaN;
  const providerPaidAt = Number.isNaN(paidAtMs) ? null : new Date(paidAtMs);
  // Only a #180 booking has a lock; a legacy naira row is never "late".
  const paidAfterQuoteExpiry = hasChargeSnapshot(c) && isQuoteExpired(c, providerPaidAt ?? at);
  return { ok: true, charged: expected, paidAfterQuoteExpiry, providerPaidAt };
}

/** Result of confirming a payment. */
export interface ConfirmOutcome {
  /** The booking after confirmation (or as found when it was already paid). */
  consultation: Consultation;
  /** True when it was already paid: nothing was written. */
  alreadyPaid: boolean;
  /** The fee Transaction written (absent when alreadyPaid). */
  transaction?: Transaction;
}

/**
 * Confirm a booking as paid and record its fee Transaction, atomically and
 * once (rule 6). Inside ONE transaction: re-read the booking; if it is
 * already paid, write nothing; if it is no longer the same pending charge
 * (re-priced or cancelled meanwhile), refuse; else flip it to paid/scheduled
 * and write the Transaction (`amount = chargedAmountMinor` in
 * `chargedCurrency`, plus `priceUsdCents` and the rate snapshot; a legacy
 * booking records its naira fee in kobo and no snapshot).
 *
 * A payment accepted after the quote lock (see checkReportedCharge) stores
 * `paidAfterQuoteExpiry: true` on BOTH the booking and the Transaction, and
 * Paystack's own payment time as `paystackPaidAt` (whenever Paystack reports
 * it), so late payments can be listed for review.
 *
 * @param reference the Paystack reference that settled it
 * @param check the accepted check (what Paystack charged, when, late or not)
 * @returns null when the booking vanished or changed under us
 */
export async function confirmPaid(
  consultationId: string,
  reference: string,
  check: Extract<ChargeCheck, { ok: true }>
): Promise<ConfirmOutcome | null> {
  const charged = check.charged;
  // Review fields, written on the booking and the transaction alike.
  const review: { paidAfterQuoteExpiry?: true; paystackPaidAt?: Timestamp } = {
    ...(check.paidAfterQuoteExpiry ? { paidAfterQuoteExpiry: true as const } : {}),
    ...(check.providerPaidAt ? { paystackPaidAt: Timestamp.fromDate(check.providerPaidAt) } : {}),
  };
  const ref = collections.consultations.doc(consultationId);
  const txRef = collections.transactions.doc();
  return consultationCharging.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const current = snap.data() as Consultation;
    if (current.paymentStatus === "paid") return { consultation: current, alreadyPaid: true };
    // Re-check on the FRESH doc: still pending, still this reference, still
    // this amount (a concurrent re-price would have changed both).
    const expected = expectedCharge(current);
    if (
      current.status !== "pending_payment" ||
      current.transactionId !== reference ||
      !expected ||
      expected.amountMinor !== charged.amountMinor ||
      expected.currency !== charged.currency
    ) {
      return null;
    }
    // The charging clock (tests drive it), so paidAt lines up with the lock.
    const now = Timestamp.fromDate(consultationCharging.now());
    const updates = {
      paymentStatus: "paid" as const,
      status: "scheduled" as const,
      transactionId: reference,
      paidAt: now,
      ...review,
      updatedAt: now,
    };
    const transaction = transactionService.buildConsultationFee(txRef.id, now, {
      consultationId,
      clientUserId: current.userId,
      agentUserId: current.agentId,
      amount: charged.amountMinor,
      currency: charged.currency,
      reference,
      clientName: current.clientName,
      clientEmail: current.clientEmail,
      snapshot: snapshotOf(current),
    });
    // The review fields ride on the Transaction too (see the doc comment).
    const recorded: Transaction = { ...transaction, ...review };
    if (check.paidAfterQuoteExpiry) {
      // Honoured, but flagged: the FX exposure is small, a human checks it.
      console.warn(
        `[consultation] ${consultationId} paid after its quote expired (reference ${reference}, ` +
          `paid ${check.providerPaidAt?.toISOString() ?? "time not reported"}); confirmed and flagged paidAfterQuoteExpiry`
      );
    }
    tx.update(ref, updates);
    tx.set(txRef, recorded);
    return { consultation: { ...current, ...updates }, alreadyPaid: false, transaction: recorded };
  });
}

// ============================================
// 5. The payer-safe booking summary
// ============================================

/**
 * What a payer sees of their booking (verify response). Allow-listed field by
 * field: no ids of other people, no checkout internals. A #180 booking
 * carries its snapshot (the amount charged, the rate and when the quote
 * expires); a legacy one carries its naira `fee`.
 */
export function bookingSummary(c: Consultation): Record<string, unknown> {
  return {
    id: c.id,
    agentName: c.agentName,
    type: c.type,
    scheduledDate: c.scheduledDate,
    scheduledTime: c.scheduledTime,
    timezone: c.timezone,
    status: c.status,
    paymentStatus: c.paymentStatus,
    ...(hasChargeSnapshot(c)
      ? { ...snapshotOf(c), quoteExpiresAt: c.quoteExpiresAt }
      : c.fee !== undefined
        ? { fee: c.fee, feeCurrency: "NGN" }
        : { priceUsdCents: c.priceUsdCents ?? 0 }),
  };
}
