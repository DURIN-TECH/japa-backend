import { randomUUID } from "crypto";
import { Timestamp } from "firebase-admin/firestore";
import type { ChargeSnapshot, CurrencyCode, Money, QuoteLock } from "../types/money";
import type { SupersededCheckout } from "../types";
import { collections, db } from "../utils/firebase";
import { quote, toChargeSnapshot } from "../money/quote";
import { resolveChargeCurrency } from "../money/config";
import { getCurrencyInfo } from "../money/currencies";
import { isMoneyError } from "../money/errors";
import type { RateService } from "../money/rate.service";
import {
  isPaystackReferenceNotFound,
  paystackProvider,
  PaystackTransactionLookup,
} from "./billing/paystack.provider";

// ============================================
// CHARGING A DOLLAR PRICE THROUGH A PAYSTACK CHECKOUT (shared, issue #181)
// ============================================
//
// The charge machinery that issue #180 built for consultation bookings,
// lifted out so payment requests (issue #181) use the SAME code instead of a
// copy. Both kinds of record:
//
//  - hold a price in US dollars (the agent's fee / the agent's request);
//  - are priced at checkout time with the #178 `quote()` in the payer's
//    charge currency, and keep that as a ChargeSnapshot plus a QuoteLock
//    (QUOTE_LOCK_MINUTES);
//  - open their checkout race-safely: CLAIM (our own reference, stored in a
//    Firestore transaction) -> OPEN (Paystack, under that reference) ->
//    PUBLISH (the URL, only if the record still carries that reference);
//  - never re-price while Paystack reports the current checkout as in
//    progress (`paystackState`), and keep every replaced reference with its
//    own snapshot (`supersededCheckouts`);
//  - settle only when what Paystack reports (its `requested_amount` when
//    reported, else `amount`) and the currency equal EXACTLY what the paid
//    checkout asked (`checkAgainst` / `matchPaidCheckout`).
//
// What differs between the two (which field holds the reference, which
// status means "awaiting payment", what "paid" looks like, what metadata
// Paystack echoes) is described by a `CheckoutTarget` adapter. The
// consultation module (consultation-charge.service.ts) re-exports the pieces
// it always exported, so its behaviour and its tests are unchanged.

/** How long a locked quote may be charged, in minutes (plan decision on #180, reused by #181). */
export const QUOTE_LOCK_MINUTES = 30;

/** Milliseconds per minute (kept named so the lock maths reads plainly). */
const MINUTE_MS = 60_000;

// ============================================
// Swappable dependencies (tests inject in-memory ones)
// ============================================

/**
 * Where the charge path gets its rate service, a payer's profile country,
 * the clock and the Firestore transaction runner. Defaults are the
 * production wiring; unit tests replace them (see
 * test/consultations/harness.ts) so no Firestore or network is touched.
 *
 * ONE object for every charge path: `consultationCharging` (the name the
 * consultation code and tests use) IS this object, so a test that stubs it
 * stubs payment requests too.
 */
export const chargeRuntime: {
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
// 1. Pricing: charge currency, quote + lock
// ============================================

/** The fields a priced record stores (snapshot + lock). */
export type LockedCharge = ChargeSnapshot & QuoteLock;

/**
 * The charge currency for a payer, resolved on the SERVER only:
 *  - a signed-in payer (`uid`): their stored profile country (the #178
 *    `resolveChargeCurrency` rules; an unmapped country gets the default);
 *  - no `uid` (an anonymous guest): the config's default currency. A typed
 *    email is never used to look a country up (it would tell an anonymous
 *    caller which country an account holder lives in).
 */
export async function chargeCurrencyForPayer(uid: string | undefined): Promise<CurrencyCode> {
  const service = await chargeRuntime.rates();
  const config = await service.getConfig();
  if (!uid) return config.defaultCurrency;
  const country = await chargeRuntime.profileCountry(uid);
  return resolveChargeCurrency(country, config);
}

/**
 * Price a dollar amount in `currency` at the current effective rate and lock
 * it for QUOTE_LOCK_MINUTES. Throws the #178 MoneyError when there is no
 * usable rate, the currency is not chargeable, or the price converts to
 * zero: the caller answers 503 and calls nothing else.
 */
export async function lockQuote(usd: Money, currency: CurrencyCode): Promise<LockedCharge> {
  const service = await chargeRuntime.rates();
  const q = await quote(usd, currency, service);
  const lockedAt = chargeRuntime.now();
  return {
    ...toChargeSnapshot(q),
    quoteLockedAt: Timestamp.fromDate(lockedAt),
    quoteExpiresAt: Timestamp.fromMillis(lockedAt.getTime() + QUOTE_LOCK_MINUTES * MINUTE_MS),
  };
}

/** True when a record's quote lock has passed (a missing lock counts as expired). */
export function isQuoteExpired(c: { quoteExpiresAt?: Timestamp | null }, at: Date = chargeRuntime.now()): boolean {
  const expires = c.quoteExpiresAt;
  if (!expires || typeof (expires as Timestamp).toMillis !== "function") return true;
  return at.getTime() > (expires as Timestamp).toMillis();
}

/** True for a record priced at checkout time (it has a well-formed, positive charge snapshot). */
export function hasChargeSnapshot(c: Partial<ChargeSnapshot>): boolean {
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

/** The snapshot fields of a record (only those present), for a Transaction or a response. */
export function snapshotOf(c: Partial<ChargeSnapshot>): Partial<ChargeSnapshot> {
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
// 2. What Paystack says about a reference
// ============================================

/**
 * What Paystack says about a reference, reduced to what the charge path
 * needs to decide:
 *  - `paid`: status `success` (settle it, never re-charge);
 *  - `final_unpaid`: `failed` or `abandoned` (or Paystack has no such
 *    transaction): the checkout may be replaced. An `abandoned` checkout can
 *    in fact still be completed later; that is why a replaced reference is
 *    kept in `supersededCheckouts` and can still settle;
 *  - `in_progress`: ANYTHING else (`ongoing`, `pending`, `processing`,
 *    `queued`, `reversed`, or a status we do not know). A bank transfer or
 *    USSD payment sits here for minutes; replacing the checkout under it
 *    would leave the payer paid with nothing to show. Never re-priced: the
 *    caller answers 409 PAYMENT_IN_PROGRESS and keeps the current checkout.
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

/**
 * Whether `reference` is one WE generated for a checkout
 * (`newPrefixedReference`: `preq-<id>-<uuid>` for a payment request,
 * `cons-<id>-<uuid>` for a consultation). A Paystack-generated reference
 * (pre-#180 bookings, pre-#181 requests) never matches.
 */
const OWN_REFERENCE =
  /^(preq|cons)-[A-Za-z0-9]*-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isOwnCheckoutReference(reference: string): boolean {
  return OWN_REFERENCE.test(reference);
}

/**
 * Ask Paystack about a record's current checkout and classify the answer
 * (`paystackState`). Issue #181 review round 2.
 *
 * Why not just `paystackState(await getTransactionMetadata(ref))`: the
 * charge path stores OUR reference in the claim BEFORE Paystack's
 * transaction/initialize (claim -> open -> publish). When initialize fails
 * (an outage, a timeout) or the function dies between the claim and the
 * open, the record keeps a reference Paystack has never seen. Paystack's
 * verify then answers HTTP 400 "Transaction reference not found", which the
 * client turns into a PAYSTACK_ERROR, and every cancel / re-checkout of that
 * record failed with 502 forever.
 *
 * So, for a reference we generated ONLY, Paystack's precise "not found"
 * answer means "that checkout was never opened": nobody can have paid it,
 * and it is `final_unpaid` (replaceable, cancellable). Its URL was never
 * handed out either: the publish step only runs after a successful open.
 *
 * Everything else still fails closed (the error is rethrown, the controller
 * answers 502 and changes nothing):
 *  - a network failure, a timeout or a Paystack 5xx;
 *  - any other 4xx (e.g. 401 "Invalid key");
 *  - "not found" for a reference Paystack generated: that one Paystack did
 *    issue, so "not found" there is an anomaly, not proof of "unpaid".
 *
 * @param reference the record's current checkout reference
 * @returns the state, and Paystack's lookup (null when there is none)
 */
export async function lookupCheckoutState(
  reference: string
): Promise<{ state: PaystackState; result: PaystackTransactionLookup | null }> {
  try {
    const result = await paystackProvider.getTransactionMetadata(reference);
    return { state: paystackState(result), result };
  } catch (err) {
    if (isOwnCheckoutReference(reference) && isPaystackReferenceNotFound(err)) {
      console.warn(
        `[charge-checkout] ${reference} is unknown at Paystack (never opened); treating it as final unpaid`
      );
      return { state: "final_unpaid", result: null };
    }
    throw err;
  }
}

// ============================================
// 3. Checking what Paystack charged
// ============================================

/**
 * Whether a successful Paystack charge matches what a checkout asked for.
 *
 * Accepted (`ok: true`) carries what was charged, Paystack's own payment
 * time when it reported one, and `paidAfterQuoteExpiry` when a priced
 * checkout was paid after its quote lock had passed (orchestrator decision on
 * #180: an EXACT payment on a checkout we issued is honoured even when late;
 * the flag marks it for review).
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
 * Compare what Paystack reports with what one checkout asked for. Pure. A
 * missing amount / currency in the report is a mismatch.
 *
 * @param expected what the checkout asked (null: nothing chargeable)
 * @param expiresAt that checkout's quote expiry, or null for a legacy record
 *   (a legacy naira record has no lock and is never "late")
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
 * Which checkout of a record a paid reference was, and whether Paystack's
 * report matches what THAT checkout asked. The decision step shared by both
 * settlements (consultation `settlePayment`, payment request
 * `settlePaymentRequest`); each then writes its own records.
 *
 * @param input.currentReference the record's current checkout reference
 * @param input.currentExpected what the current checkout asked (a priced
 *   record's snapshot, or a legacy record's own stored amount); null when
 *   nothing chargeable is stored
 * @param input.currentExpiresAt the current checkout's lock expiry, or null
 *   for a legacy record (never "late")
 * @param input.superseded the record's replaced checkouts
 * @returns `unknown_reference` when the reference is neither the current one
 *   nor a superseded one; else which one it was plus the check
 */
export function matchPaidCheckout(input: {
  reference: string;
  currentReference: string | null;
  currentExpected: Money | null;
  currentExpiresAt: Timestamp | null;
  superseded: SupersededCheckout[] | undefined;
  reported: PaystackTransactionLookup;
  at: Date;
}):
  | { kind: "unknown_reference" }
  | { kind: "checked"; isCurrent: boolean; entry: SupersededCheckout | undefined; check: ChargeCheck } {
  const isCurrent = input.currentReference === input.reference;
  const entry = isCurrent ? undefined : (input.superseded ?? []).find((s) => s.reference === input.reference);
  if (!isCurrent && !entry) return { kind: "unknown_reference" };
  const check = isCurrent
    ? checkAgainst(input.currentExpected, input.currentExpiresAt, input.reported, input.at)
    : checkAgainst(
      { amountMinor: entry!.chargedAmountMinor, currency: entry!.chargedCurrency },
      entry!.quoteExpiresAt ?? Timestamp.fromMillis(0),
      input.reported,
      input.at
    );
  return { kind: "checked", isCurrent, entry, check };
}

/**
 * The superseded-list entry for a record's current checkout: its reference
 * with the snapshot and lock it was priced at. Firestore refuses
 * `undefined`, so absent lock fields are left out.
 */
export function supersededEntryOf(
  c: Partial<ChargeSnapshot> & Partial<QuoteLock>,
  reference: string,
  at: Date
): SupersededCheckout {
  return {
    ...(snapshotOf(c) as ChargeSnapshot),
    ...(c.quoteLockedAt ? { quoteLockedAt: c.quoteLockedAt } : {}),
    ...(c.quoteExpiresAt ? { quoteExpiresAt: c.quoteExpiresAt } : {}),
    reference,
    supersededAt: Timestamp.fromDate(at),
  };
}

/**
 * The fields a record takes when it settles on a SUPERSEDED checkout: THAT
 * checkout's snapshot and lock (so the record and its Transaction agree), and
 * a superseded list without that entry but with the record's then-current
 * checkout added (a later payment on it is then a second charge). Empty when
 * the current checkout was paid.
 */
export function supersededSwap(
  current: Partial<ChargeSnapshot> & Partial<QuoteLock> & { supersededCheckouts?: SupersededCheckout[] },
  currentReference: string | null,
  entry: SupersededCheckout | undefined,
  at: Date
): Record<string, unknown> {
  if (!entry) return {};
  return {
    ...snapshotOf(entry),
    ...(entry.quoteLockedAt ? { quoteLockedAt: entry.quoteLockedAt } : {}),
    ...(entry.quoteExpiresAt ? { quoteExpiresAt: entry.quoteExpiresAt } : {}),
    supersededCheckouts: [
      ...(current.supersededCheckouts ?? []).filter((s) => s.reference !== entry.reference),
      ...(currentReference && hasChargeSnapshot(current) ? [supersededEntryOf(current, currentReference, at)] : []),
    ],
  };
}

// ============================================
// 4. Opening a checkout, race-safely (claim -> open -> publish)
// ============================================
//
// WHY THIS SHAPE (issue #180 review)
// Opening the Paystack checkout first and then writing the reference with a
// plain update lets two callers race: a retry re-pricing a record that a
// verify had JUST confirmed as paid (a second real charge), or two re-prices
// each opening their own checkout. So every checkout is issued in three
// steps:
//  1. CLAIM, inside ONE Firestore transaction: re-read the record and go on
//     only if it is still awaiting payment, not paid, chargeable, still
//     carries the reference the caller saw, and has no live checkout (no URL
//     yet, or its lock has passed). Generate OUR Paystack reference and store
//     it, with the new snapshot, in that same commit. The reference it
//     replaces is appended to `supersededCheckouts` with its own snapshot.
//  2. OPEN the checkout at Paystack under that reference.
//  3. PUBLISH the checkout URL, again in a transaction, only if the record
//     still carries that reference.
// A caller whose claim (or publish) loses gets the record's CURRENT state
// instead: paid -> paid; another caller's checkout -> that checkout. So at
// most one checkout per lock is ever handed out, and both racers get it.

/** How many times a caller that lost a checkout race re-reads the record for the winner's checkout. */
export const CHECKOUT_WAIT_ATTEMPTS = 10;
/** Pause between those re-reads (the winner is calling Paystack meanwhile). */
const CHECKOUT_WAIT_MS = 300;

/**
 * The fields every chargeable record carries for its checkout (the snapshot
 * and lock, the checkout page, the return URL and the replaced checkouts).
 */
export type ChargeableRecord = Partial<ChargeSnapshot> &
  Partial<QuoteLock> & {
    checkoutUrl?: string | null;
    checkoutCallbackUrl?: string;
    supersededCheckouts?: SupersededCheckout[];
  };

/**
 * How one kind of record is charged: where it lives, which field holds the
 * current Paystack reference, and which states mean "paid" and "awaiting
 * payment". The consultation and payment-request modules each define one.
 */
export interface CheckoutTarget<T extends ChargeableRecord> {
  /** The record's document. */
  doc: (id: string) => FirebaseFirestore.DocumentReference;
  /** The field that holds the current checkout's reference ("transactionId", "paystackReference"). */
  referenceField: string;
  /** The current checkout's reference on a record, or null. */
  currentReference: (r: T) => string | null;
  /** True once the record is paid (nothing more to charge). */
  isPaid: (r: T) => boolean;
  /** True while the record waits for a payment (a checkout may be issued). */
  isAwaitingPayment: (r: T) => boolean;
  /**
   * True when a checkout may be claimed for this record with `charge` (a
   * fresh locked quote, or null to charge the snapshot already stored).
   */
  isChargeable: (r: T, charge: LockedCharge | null) => boolean;
  /** A new reference of OUR own for one checkout of record `id`. */
  newReference: (id: string) => string;
  /** The metadata Paystack echoes back (`purpose` plus the record id). */
  metadata: (id: string) => Record<string, unknown>;
}

/**
 * A new Paystack reference for one checkout. Ours, not Paystack's, so it can
 * be stored BEFORE the checkout is opened. Paystack allows letters, digits,
 * `-`, `.` and `=`; the record id is stripped to letters and digits and a
 * random UUID makes each checkout unique.
 *
 * @param prefix the record kind ("cons" for consultations, "preq" for payment requests)
 */
export function newPrefixedReference(prefix: string, id: string): string {
  return `${prefix}-${id.replace(/[^A-Za-z0-9]/g, "")}-${randomUUID()}`;
}

/** Where a record's checkout stands, as answered to a caller. */
export type RecordCheckoutState<T> =
  /** A checkout the payer can use (`opened`: this caller opened it; else another caller did). */
  | { kind: "checkout"; authorizationUrl: string; reference: string; record: T; opened: boolean }
  /** The record is paid: nothing to charge. */
  | { kind: "paid"; record: T }
  /** The record is gone, closed, or not chargeable. */
  | { kind: "not_payable"; record: T | null }
  /** Another caller is still opening the checkout: try again in a moment. */
  | { kind: "opening"; record: T };

/**
 * Re-read the record until it shows a usable state (a caller that lost a
 * checkout race lands here). Waits up to CHECKOUT_WAIT_ATTEMPTS reads for the
 * winner to publish its checkout URL.
 */
export async function awaitRecordCheckoutState<T extends ChargeableRecord>(
  target: CheckoutTarget<T>,
  id: string
): Promise<RecordCheckoutState<T>> {
  let last: T | null = null;
  for (let i = 0; i < CHECKOUT_WAIT_ATTEMPTS; i++) {
    const snap = await target.doc(id).get();
    if (!snap.exists) return { kind: "not_payable", record: null };
    const r = snap.data() as T;
    last = r;
    if (target.isPaid(r)) return { kind: "paid", record: r };
    if (!target.isAwaitingPayment(r)) return { kind: "not_payable", record: r };
    const current = target.currentReference(r);
    if (current && r.checkoutUrl) {
      return { kind: "checkout", authorizationUrl: r.checkoutUrl, reference: current, record: r, opened: false };
    }
    await chargeRuntime.sleep(CHECKOUT_WAIT_MS);
  }
  return { kind: "opening", record: last! };
}

/**
 * Issue a checkout for a record, race-safely (claim -> open -> publish, see
 * the section header). The amount and currency Paystack receives are the
 * STORED `chargedAmountMinor` / `chargedCurrency` after the claim, nothing
 * else.
 *
 * @param target how this kind of record is charged
 * @param input.id the record id
 * @param input.observedReference the reference the caller read on the record
 *   (null when it had none). The claim goes on only if the record still
 *   carries exactly this one.
 * @param input.charge a FRESH locked quote to store with the new reference
 *   (a first pricing or a re-price), or null to keep the snapshot already
 *   stored (a brand-new booking, priced a moment ago).
 * @returns the record's checkout state: the new checkout, or, when another
 *   caller got there first, whatever the record now shows.
 * @throws the provider's `PAYSTACK_ERROR: ...` (the controller answers 502).
 *   The record then carries the claimed reference with no checkout URL; it
 *   was never handed out, and a retry (or verify) issues a new one.
 */
export async function issueRecordCheckout<T extends ChargeableRecord>(
  target: CheckoutTarget<T>,
  input: {
    id: string;
    observedReference: string | null;
    charge: LockedCharge | null;
    email: string;
    callbackUrl: string;
    /** Extra metadata echoed back by Paystack (e.g. the agency slug). */
    metadata?: Record<string, unknown>;
  }
): Promise<RecordCheckoutState<T>> {
  const ref = target.doc(input.id);
  const reference = target.newReference(input.id);
  const at = chargeRuntime.now();

  // ---- 1. CLAIM: decide and store the new reference in one transaction ----
  const claimed = await chargeRuntime.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const fresh = snap.data() as T;
    const current = target.currentReference(fresh);
    const liveCheckout = !!fresh.checkoutUrl && !isQuoteExpired(fresh, at);
    if (
      target.isPaid(fresh) ||
      !target.isAwaitingPayment(fresh) ||
      !target.isChargeable(fresh, input.charge) ||
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
      [target.referenceField]: reference,
      checkoutUrl: null, // set in step 3, once Paystack has opened it
      checkoutCallbackUrl: input.callbackUrl,
      ...(superseded.length ? { supersededCheckouts: superseded } : {}),
      updatedAt: Timestamp.fromDate(at),
    });
    return { ...fresh, ...(input.charge ?? {}), [target.referenceField]: reference } as T;
  });
  if (!claimed) return awaitRecordCheckoutState(target, input.id);

  // ---- 2. OPEN the checkout at Paystack under OUR reference ---------------
  const opened = await paystackProvider.initializeCharge({
    email: input.email,
    amount: { amountMinor: claimed.chargedAmountMinor!, currency: claimed.chargedCurrency! },
    metadata: { ...(input.metadata ?? {}), ...target.metadata(input.id) },
    callbackUrl: input.callbackUrl,
    reference,
  });
  // Paystack echoes the reference it was given. Anything else means the
  // checkout is not the one stored on the record: never hand it out.
  if (opened.reference && opened.reference !== reference) {
    throw new Error("PAYSTACK_ERROR: checkout opened under an unexpected reference");
  }

  // ---- 3. PUBLISH the URL, only if the record still carries this reference
  const published = await chargeRuntime.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const fresh = snap.data() as T;
    if (target.currentReference(fresh) !== reference || target.isPaid(fresh) || !target.isAwaitingPayment(fresh)) {
      return null;
    }
    tx.update(ref, { checkoutUrl: opened.authorizationUrl, updatedAt: Timestamp.fromDate(chargeRuntime.now()) });
    return { ...fresh, checkoutUrl: opened.authorizationUrl } as T;
  });
  // Replaced or paid meanwhile: this checkout was never handed out (it is in
  // the superseded list, so even a payment on it would be caught).
  if (!published) return awaitRecordCheckoutState(target, input.id);
  return { kind: "checkout", authorizationUrl: opened.authorizationUrl, reference, record: published, opened: true };
}
