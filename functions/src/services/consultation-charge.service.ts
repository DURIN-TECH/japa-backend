import { randomUUID } from "crypto";
import { Timestamp } from "firebase-admin/firestore";
import type { ChargeSnapshot, CurrencyCode, Money, QuoteLock } from "../types/money";
import type { Consultation, ConsultationPaymentException, SupersededCheckout, Transaction } from "../types";
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
//     is never charged again. Review fixes: the re-price is decided and
//     stored inside a Firestore transaction under a reference WE generate
//     (section 3), never while Paystack reports the current checkout as in
//     progress (409 PAYMENT_IN_PROGRESS), and the replaced reference is kept
//     with its own snapshot in `supersededCheckouts`.
//  5. Paystack receives `amount = chargedAmountMinor` and `currency =
//     chargedCurrency` exactly as stored. On return, what Paystack reports it
//     charged must equal the stored amount AND currency, or nothing is
//     confirmed or recorded. An exact payment on the booking's CURRENT
//     reference is honoured even when it lands after the lock, and flagged
//     `paidAfterQuoteExpiry` for review: the lock governs ISSUING a checkout,
//     not honouring one we already issued. An exact payment on a SUPERSEDED
//     reference settles a still-unpaid booking at that reference's own
//     snapshot (`paidOnSupersededReference`); on an already-paid booking it is
//     recorded in `consultationPaymentExceptions` for refund, never as a
//     second Transaction. The amount compared is Paystack's
//     `requested_amount` when reported (fees passed to the customer inflate
//     `amount`), else `amount`.
//  6. Confirmation is ONE Firestore transaction (settlePayment): re-read the
//     booking, and if it is not paid yet flip it to paid/scheduled and write
//     the fee Transaction in the same commit. A second verify finds it paid
//     and writes nothing.
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
  /** Waits `ms` (a caller that lost a checkout race waits for the winner's URL). */
  sleep: (ms: number) => Promise<void>;
} = {
  // Lazy import: money/index wires the production providers on load.
  rates: async () => (await import("../money/index")).rateService,
  profileCountry: async (uid) => {
    const snap = await collections.users.doc(uid).get();
    return snap.exists ? (snap.data() as { residentialCountry?: string }).residentialCountry : undefined;
  },
  now: () => new Date(),
  runTransaction: (fn) => db.runTransaction(fn),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
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
// 3. Opening a checkout (race-safe, issue #180 review fix)
// ============================================
//
// WHY THIS SHAPE
// The first version opened the Paystack checkout first and then wrote the
// reference onto the booking with a plain update, and re-priced with plain
// updates too. Two callers could then race:
//  - a retry re-pricing a booking that a verify had JUST confirmed as paid
//    (a new checkout on a paid booking: a second real charge);
//  - two re-prices at once, each opening its own Paystack checkout, the last
//    write winning and the other caller's checkout refused when paid.
//
// NOW every checkout is issued in three steps:
//  1. CLAIM, inside ONE Firestore transaction: re-read the booking and go on
//     only if it is still `pending_payment`, not paid, still carries the
//     reference the caller saw, and has no live checkout (no URL yet, or its
//     lock has passed). Generate OUR Paystack reference and store it, with
//     the new snapshot, in that same commit. The reference it replaces is
//     appended to `supersededCheckouts` with its own snapshot, never lost.
//  2. OPEN the checkout at Paystack under that reference (Paystack accepts a
//     caller-supplied `reference` on transaction/initialize).
//  3. PUBLISH the checkout URL, again in a transaction, only if the booking
//     still carries that reference.
// A caller whose claim (or publish) loses gets the booking's CURRENT state
// instead: paid -> success; another caller's checkout -> that checkout. So
// at most one checkout per lock is ever handed out, and both racers get it.

/** How many times a caller that lost a checkout race re-reads the booking for the winner's checkout. */
export const CHECKOUT_WAIT_ATTEMPTS = 10;
/** Pause between those re-reads (the winner is calling Paystack meanwhile). */
const CHECKOUT_WAIT_MS = 300;

/**
 * A new Paystack reference for one checkout of a booking. Ours, not
 * Paystack's, so it can be stored BEFORE the checkout is opened. Paystack
 * allows letters, digits, `-`, `.` and `=`; the booking id is stripped to
 * letters and digits and a random UUID makes each checkout unique.
 */
export function newCheckoutReference(consultationId: string): string {
  return `cons-${consultationId.replace(/[^A-Za-z0-9]/g, "")}-${randomUUID()}`;
}

/**
 * What Paystack says about a reference, reduced to what the charge path
 * needs to decide:
 *  - `paid`: status `success` (settle it, never re-charge);
 *  - `final_unpaid`: `failed` or `abandoned` (or Paystack has no such
 *    transaction): the checkout may be replaced. An `abandoned` checkout can
 *    in fact still be completed later; that is why a replaced reference is
 *    kept in `supersededCheckouts` and can still settle (see settlePayment);
 *  - `in_progress`: ANYTHING else (`ongoing`, `pending`, `processing`,
 *    `queued`, `reversed`, or a status we do not know). A bank transfer or
 *    USSD payment sits here for minutes; replacing the checkout under it
 *    would leave the payer paid with no booking. Never re-priced: the caller
 *    answers 409 PAYMENT_IN_PROGRESS and keeps the current checkout.
 */
export type PaystackState = "paid" | "final_unpaid" | "in_progress";

/** The only non-success statuses after which a checkout may be replaced. */
const REPLACEABLE_STATUSES = new Set(["failed", "abandoned"]);

/** Classify a Paystack lookup (see PaystackState). Pure. */
export function paystackState(lookup: PaystackTransactionLookup | null): PaystackState {
  if (!lookup) return "final_unpaid";
  if (lookup.status === "success") return "paid";
  if (REPLACEABLE_STATUSES.has(lookup.status)) return "final_unpaid";
  return "in_progress";
}

/** Where a booking's checkout stands, as answered to a caller. */
export type CheckoutState =
  /** A checkout the payer can use (`opened`: this caller opened it; else another caller did). */
  | { kind: "checkout"; authorizationUrl: string; reference: string; consultation: Consultation; opened: boolean }
  /** The booking is paid: nothing to charge. */
  | { kind: "paid"; consultation: Consultation }
  /** The booking is gone, cancelled, or not a #180 charge. */
  | { kind: "not_payable"; consultation: Consultation | null }
  /** Another caller is still opening the checkout: try again in a moment. */
  | { kind: "opening"; consultation: Consultation };

/**
 * The superseded-list entry for the booking's current checkout: its
 * reference with the snapshot and lock it was priced at. Firestore refuses
 * `undefined`, so absent lock fields are left out.
 */
function supersededEntryOf(c: Consultation, reference: string, at: Date): SupersededCheckout {
  return {
    ...(snapshotOf(c) as ChargeSnapshot),
    ...(c.quoteLockedAt ? { quoteLockedAt: c.quoteLockedAt } : {}),
    ...(c.quoteExpiresAt ? { quoteExpiresAt: c.quoteExpiresAt } : {}),
    reference,
    supersededAt: Timestamp.fromDate(at),
  };
}

/**
 * Re-read the booking until it shows a usable state (a caller that lost a
 * checkout race lands here). Waits up to CHECKOUT_WAIT_ATTEMPTS reads for
 * the winner to publish its checkout URL.
 */
export async function awaitCheckoutState(consultationId: string): Promise<CheckoutState> {
  let last: Consultation | null = null;
  for (let i = 0; i < CHECKOUT_WAIT_ATTEMPTS; i++) {
    const snap = await collections.consultations.doc(consultationId).get();
    if (!snap.exists) return { kind: "not_payable", consultation: null };
    const c = snap.data() as Consultation;
    last = c;
    if (c.paymentStatus === "paid") return { kind: "paid", consultation: c };
    if (c.status !== "pending_payment") return { kind: "not_payable", consultation: c };
    if (c.transactionId && c.checkoutUrl) {
      return { kind: "checkout", authorizationUrl: c.checkoutUrl, reference: c.transactionId, consultation: c, opened: false };
    }
    await consultationCharging.sleep(CHECKOUT_WAIT_MS);
  }
  return { kind: "opening", consultation: last! };
}

/**
 * Issue a checkout for a booking, race-safely (claim -> open -> publish, see
 * the section header). The amount and currency Paystack receives are the
 * STORED `chargedAmountMinor` / `chargedCurrency` after the claim, nothing
 * else.
 *
 * @param input.observedReference the reference the caller read on the
 *   booking (null when it had none). The claim goes on only if the booking
 *   still carries exactly this one.
 * @param input.charge a FRESH locked quote to store with the new reference
 *   (a re-price), or null to keep the snapshot already stored (a brand-new
 *   booking, priced a moment ago).
 * @returns the booking's checkout state: the new checkout, or, when another
 *   caller got there first, whatever the booking now shows.
 * @throws the provider's `PAYSTACK_ERROR: ...` (the controller answers 502).
 *   The booking then carries the claimed reference with no checkout URL; it
 *   was never handed out, and a retry (or verify) issues a new one.
 */
export async function issueCheckout(input: {
  consultationId: string;
  observedReference: string | null;
  charge: LockedCharge | null;
  email: string;
  callbackUrl: string;
  /** Extra metadata echoed back by Paystack (e.g. the agency slug). */
  metadata?: Record<string, unknown>;
}): Promise<CheckoutState> {
  const ref = collections.consultations.doc(input.consultationId);
  const reference = newCheckoutReference(input.consultationId);
  const at = consultationCharging.now();

  // ---- 1. CLAIM: decide and store the new reference in one transaction ----
  const claimed = await consultationCharging.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const fresh = snap.data() as Consultation;
    const current = fresh.transactionId ?? null;
    const liveCheckout = !!fresh.checkoutUrl && !isQuoteExpired(fresh, at);
    if (
      fresh.paymentStatus === "paid" ||
      fresh.status !== "pending_payment" ||
      !hasChargeSnapshot(fresh) ||
      current !== input.observedReference || // someone re-priced or confirmed since the caller read it
      liveCheckout // a usable checkout already stands: never open a second one
    ) {
      return null;
    }
    // Keep the reference being replaced, with the price IT asked for.
    const superseded = [...(fresh.supersededCheckouts ?? [])];
    if (current) superseded.push(supersededEntryOf(fresh, current, at));
    tx.update(ref, {
      ...(input.charge ?? {}),
      transactionId: reference,
      checkoutUrl: null, // set in step 3, once Paystack has opened it
      checkoutCallbackUrl: input.callbackUrl,
      ...(superseded.length ? { supersededCheckouts: superseded } : {}),
      updatedAt: Timestamp.fromDate(at),
    });
    return { ...fresh, ...(input.charge ?? {}), transactionId: reference } as Consultation;
  });
  if (!claimed) return awaitCheckoutState(input.consultationId);

  // ---- 2. OPEN the checkout at Paystack under OUR reference ---------------
  const opened = await paystackProvider.initializeCharge({
    email: input.email,
    amount: { amountMinor: claimed.chargedAmountMinor!, currency: claimed.chargedCurrency! },
    metadata: { ...(input.metadata ?? {}), purpose: "consultation", consultationId: input.consultationId },
    callbackUrl: input.callbackUrl,
    reference,
  });
  // Paystack echoes the reference it was given. Anything else means the
  // checkout is not the one stored on the booking: never hand it out.
  if (opened.reference && opened.reference !== reference) {
    throw new Error("PAYSTACK_ERROR: checkout opened under an unexpected reference");
  }

  // ---- 3. PUBLISH the URL, only if the booking still carries this reference
  const published = await consultationCharging.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const fresh = snap.data() as Consultation;
    if (fresh.transactionId !== reference || fresh.paymentStatus === "paid" || fresh.status !== "pending_payment") {
      return null;
    }
    tx.update(ref, { checkoutUrl: opened.authorizationUrl, updatedAt: Timestamp.fromDate(consultationCharging.now()) });
    return { ...fresh, checkoutUrl: opened.authorizationUrl };
  });
  // Replaced or paid meanwhile: this checkout was never handed out (it is in
  // the superseded list, so even a payment on it would be caught).
  if (!published) return awaitCheckoutState(input.consultationId);
  return { kind: "checkout", authorizationUrl: opened.authorizationUrl, reference, consultation: published, opened: true };
}

/**
 * Re-price an unpaid #180 booking (rule 4): a FRESH quote of the booking's
 * dollar price (`priceUsdCents`, agreed at booking time) in its charge
 * currency, a new lock, and a new checkout, issued race-safely (see
 * issueCheckout). The caller must already have checked that Paystack
 * reports the current checkout `final_unpaid` (never re-price under a
 * payment in progress).
 *
 * Throws a MoneyError (503) before any write or Paystack call when no rate
 * can price it, and the provider error (502) when Paystack fails.
 */
export async function reissueCheckout(
  c: Consultation,
  opts: { fallbackCallbackUrl: string; metadata?: Record<string, unknown> }
): Promise<CheckoutState> {
  const usd: Money = { amountMinor: c.priceUsdCents!, currency: "USD" };
  const charge = await lockQuote(usd, c.chargedCurrency!);
  return issueCheckout({
    consultationId: c.id,
    observedReference: c.transactionId ?? null,
    charge,
    email: c.clientEmail,
    callbackUrl: c.checkoutCallbackUrl || opts.fallbackCallbackUrl,
    metadata: opts.metadata,
  });
}

// ============================================
// 4. Checking what Paystack reports, and settling
// ============================================

/**
 * Whether a successful Paystack charge matches what a checkout asked for.
 *
 * Accepted (`ok: true`) carries what was charged, Paystack's own payment
 * time when it reported one, and `paidAfterQuoteExpiry` when a #180 checkout
 * was paid after its quote lock had passed (orchestrator decision on #180:
 * an EXACT payment on a checkout we issued is honoured even when late; the
 * flag marks it for review).
 */
export type ChargeCheck =
  | { ok: true; charged: Money; paidAfterQuoteExpiry: boolean; providerPaidAt: Date | null }
  /** The amount or currency differs from what was asked (underpayment, wrong currency). */
  | { ok: false; reason: "mismatch" }
  /** Nothing chargeable is stored for that checkout. */
  | { ok: false; reason: "not_chargeable" };

/**
 * The amount Paystack reports for comparison: `requested_amount` (what the
 * checkout ASKED for) when Paystack reports it, else `amount`. When the
 * Paystack account passes transaction fees to the customer, `amount`
 * includes those fees, so comparing it would refuse every honest payment.
 */
export function reportedAskedAmount(reported: PaystackTransactionLookup): number | undefined {
  return reported.requestedAmount ?? reported.amount;
}

/**
 * Compare what Paystack reports with what one checkout asked for (rule 5).
 * Pure. A missing amount / currency in the report is a mismatch.
 *
 * @param expected what the checkout asked (null: nothing chargeable)
 * @param expiresAt that checkout's quote expiry, or null for a legacy row
 *   (a legacy naira booking has no lock and is never "late")
 * @param at the time of this check (stands in for Paystack's `paid_at` when
 *   it did not report one)
 */
export function checkAgainst(
  expected: Money | null,
  expiresAt: Timestamp | null,
  reported: PaystackTransactionLookup,
  at: Date
): ChargeCheck {
  if (!expected) return { ok: false, reason: "not_chargeable" };
  if (reportedAskedAmount(reported) !== expected.amountMinor || reported.currency !== expected.currency) {
    return { ok: false, reason: "mismatch" };
  }
  const paidAtMs = reported.paidAt ? Date.parse(reported.paidAt) : NaN;
  const providerPaidAt = Number.isNaN(paidAtMs) ? null : new Date(paidAtMs);
  const paidAfterQuoteExpiry = expiresAt !== null && isQuoteExpired({ quoteExpiresAt: expiresAt }, providerPaidAt ?? at);
  return { ok: true, charged: expected, paidAfterQuoteExpiry, providerPaidAt };
}

/**
 * The current-checkout form of checkAgainst: compare a report with what the
 * booking's CURRENT checkout asked (the stored snapshot, or a legacy `fee`).
 */
export function checkReportedCharge(c: Consultation, reported: PaystackTransactionLookup, at: Date): ChargeCheck {
  const expiresAt = hasChargeSnapshot(c) ? (c.quoteExpiresAt ?? Timestamp.fromMillis(0)) : null;
  return checkAgainst(expectedCharge(c), expiresAt, reported, at);
}

/** What settling a successful Paystack payment did. */
export type SettleOutcome =
  /** The booking is now paid by this payment and its fee Transaction is written. */
  | { kind: "confirmed"; consultation: Consultation; transaction: Transaction; viaSuperseded: boolean }
  /** This very payment already settled the booking: nothing written. */
  | { kind: "already_paid"; consultation: Consultation }
  /**
   * A SECOND payment: the booking was already paid by another reference.
   * Recorded in consultationPaymentExceptions for a refund; no Transaction.
   */
  | { kind: "refund_recorded"; consultation: Consultation; exception: ConsultationPaymentException }
  /** The booking is no longer awaiting payment (cancelled...): recorded for a refund; no Transaction. */
  | { kind: "not_payable_recorded"; consultation: Consultation; exception: ConsultationPaymentException }
  /** Paystack's amount or currency differs from what that checkout asked: nothing written. */
  | { kind: "mismatch" }
  /** Nothing chargeable stored for that checkout: nothing written. */
  | { kind: "not_chargeable" }
  /** The reference was never a checkout of this booking: nothing written. */
  | { kind: "unknown_reference"; consultation: Consultation };

/**
 * Settle a SUCCESSFUL Paystack payment on a booking, atomically and once
 * (rules 5 and 6, and the review fix for superseded references). Everything
 * is decided on the FRESH booking inside ONE Firestore transaction, so a
 * concurrent re-price or confirmation can never slip between the check and
 * the write:
 *
 *  1. Which checkout was paid? The booking's current reference, or one in
 *     `supersededCheckouts`. Neither: `unknown_reference`.
 *  2. Does Paystack's amount (its `requested_amount` when reported) and
 *     currency equal what THAT checkout asked? No: `mismatch`.
 *  3. Booking already paid: by this reference, `already_paid`; by another
 *     one, this is a second charge: a `consultationPaymentExceptions` record
 *     (reason `paid_on_superseded_reference_after_booking_paid`), an
 *     error-level log, and NEVER a second Transaction.
 *  4. Booking no longer awaiting payment (cancelled while paying): an
 *     exception record (reason `booking_not_payable`), no Transaction.
 *  5. Otherwise confirm: paid/scheduled plus the fee Transaction in the same
 *     commit. Settled on a superseded reference, the booking takes THAT
 *     checkout's snapshot and lock (so booking and Transaction agree), its
 *     then-current checkout moves to the superseded list (a later payment on
 *     it is a second charge, step 3), and both records carry
 *     `paidOnSupersededReference: true`.
 *
 * A late exact payment is honoured and flagged `paidAfterQuoteExpiry`
 * against the lock of the checkout that was paid; Paystack's `paid_at` is
 * stored as `paystackPaidAt` whenever reported.
 *
 * @returns null when the booking does not exist
 */
export async function settlePayment(
  consultationId: string,
  reference: string,
  reported: PaystackTransactionLookup
): Promise<SettleOutcome | null> {
  const ref = collections.consultations.doc(consultationId);
  const exceptionRef = collections.consultationPaymentExceptions.doc(reference);
  const txRef = collections.transactions.doc();
  return consultationCharging.runTransaction(async (tx) => {
    // All reads first (Firestore transactions require reads before writes).
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const exceptionSnap = await tx.get(exceptionRef);
    const current = snap.data() as Consultation;
    const at = consultationCharging.now();

    // (1) Which checkout was paid, and what did it ask?
    const isCurrent = current.transactionId === reference;
    const entry = isCurrent ? undefined : (current.supersededCheckouts ?? []).find((s) => s.reference === reference);
    if (!isCurrent && !entry) return { kind: "unknown_reference", consultation: current };

    // (2) Exactly what that checkout asked?
    const check = isCurrent
      ? checkReportedCharge(current, reported, at)
      : checkAgainst(
        { amountMinor: entry!.chargedAmountMinor, currency: entry!.chargedCurrency },
        entry!.quoteExpiresAt ?? Timestamp.fromMillis(0),
        reported,
        at
      );
    if (!check.ok) return { kind: check.reason };

    /** Record money we hold but cannot apply (idempotent: doc id = reference). */
    const recordException = (reason: ConsultationPaymentException["reason"]): ConsultationPaymentException => {
      if (exceptionSnap.exists) return exceptionSnap.data() as ConsultationPaymentException;
      const exception: ConsultationPaymentException = {
        id: reference,
        consultationId,
        reference,
        amountMinor: check.charged.amountMinor,
        currency: check.charged.currency,
        paystackPaidAt: check.providerPaidAt ? Timestamp.fromDate(check.providerPaidAt) : null,
        reason,
        status: "open",
        createdAt: Timestamp.fromDate(at),
      };
      tx.set(exceptionRef, exception);
      console.error(
        `[consultation] Paystack charge ${reference} on ${consultationId} cannot be applied (${reason}): ` +
          `${check.charged.amountMinor} ${check.charged.currency} recorded in consultationPaymentExceptions for refund`
      );
      return exception;
    };

    // (3) Already paid.
    if (current.paymentStatus === "paid") {
      if (isCurrent) return { kind: "already_paid", consultation: current };
      return {
        kind: "refund_recorded",
        consultation: current,
        exception: recordException("paid_on_superseded_reference_after_booking_paid"),
      };
    }
    // (4) No longer awaiting payment.
    if (current.status !== "pending_payment") {
      return { kind: "not_payable_recorded", consultation: current, exception: recordException("booking_not_payable") };
    }

    // (5) Confirm + record, in this same commit.
    const now = Timestamp.fromDate(at);
    const review: { paidAfterQuoteExpiry?: true; paystackPaidAt?: Timestamp; paidOnSupersededReference?: true } = {
      ...(check.paidAfterQuoteExpiry ? { paidAfterQuoteExpiry: true as const } : {}),
      ...(check.providerPaidAt ? { paystackPaidAt: Timestamp.fromDate(check.providerPaidAt) } : {}),
      ...(entry ? { paidOnSupersededReference: true as const } : {}),
    };
    // Settled on a superseded checkout: the booking takes THAT price, and its
    // then-current checkout becomes superseded in turn.
    const supersededSwap: Partial<Consultation> = entry
      ? {
        ...snapshotOf(entry as unknown as Partial<Consultation>),
        ...(entry.quoteLockedAt ? { quoteLockedAt: entry.quoteLockedAt } : {}),
        ...(entry.quoteExpiresAt ? { quoteExpiresAt: entry.quoteExpiresAt } : {}),
        supersededCheckouts: [
          ...(current.supersededCheckouts ?? []).filter((s) => s.reference !== reference),
          ...(current.transactionId && hasChargeSnapshot(current)
            ? [supersededEntryOf(current, current.transactionId, at)]
            : []),
        ],
      }
      : {};
    const updates = {
      ...supersededSwap,
      paymentStatus: "paid" as const,
      status: "scheduled" as const,
      transactionId: reference,
      paidAt: now,
      ...review,
      updatedAt: now,
    };
    const settled = { ...current, ...updates } as Consultation;
    const transaction = transactionService.buildConsultationFee(txRef.id, now, {
      consultationId,
      clientUserId: current.userId,
      agentUserId: current.agentId,
      amount: check.charged.amountMinor,
      currency: check.charged.currency,
      reference,
      clientName: current.clientName,
      clientEmail: current.clientEmail,
      snapshot: snapshotOf(settled),
    });
    // The review fields ride on the Transaction too.
    const recorded: Transaction = { ...transaction, ...review };
    if (check.paidAfterQuoteExpiry) {
      // Honoured, but flagged: the FX exposure is small, a human checks it.
      console.warn(
        `[consultation] ${consultationId} paid after its quote expired (reference ${reference}, ` +
          `paid ${check.providerPaidAt?.toISOString() ?? "time not reported"}); confirmed and flagged paidAfterQuoteExpiry`
      );
    }
    if (entry) {
      console.warn(
        `[consultation] ${consultationId} settled on superseded reference ${reference} at that checkout's own price; ` +
          "flagged paidOnSupersededReference"
      );
    }
    tx.update(ref, updates);
    tx.set(txRef, recorded);
    return { kind: "confirmed", consultation: settled, transaction: recorded, viaSuperseded: !!entry };
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
