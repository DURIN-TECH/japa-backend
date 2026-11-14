// ============================================
// Test harness — consultation charging (issue #180). Not a test file.
// ============================================
//
// Wires the consultation controller to in-memory everything:
//  - Firestore: the shared fake (test/helpers/fake-firestore.ts) for the
//    consultations, transactions, agents, agencies and users collections;
//  - rates: an in-memory #178 RateService (test/money/helpers.ts) with a
//    fixed clock, an NGN rate and (optionally) a second currency, GHS;
//  - Paystack: `initializeCharge` and `getTransactionMetadata` replaced by
//    recorders the test drives. NO real charge, no network;
//  - notifications: a no-op (the guest flow notifies the agency owner).
//
// `useHarness()` is called once per suite in `before`; `harness.reset()` in
// `beforeEach` clears the store, the Paystack recorders and the clock.

import { Timestamp } from "firebase-admin/firestore";
import { installFakes, resetStore, fakeCollection, fakeRunTransaction, store } from "../helpers/fake-firestore";
import { makeService, fakeClock } from "../money/helpers";
import { consultationCharging } from "../../src/services/consultation-charge.service";
import { paystackProvider, PaystackTransactionLookup } from "../../src/services/billing/paystack.provider";
import { notificationService } from "../../src/services/notification.service";
import type { Money } from "../../src/types/money";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** The fixed "now" every test starts at (the stored rates are fetched at this time). */
export const NOW_ISO = "2026-11-13T09:00:00Z";

/** NGN per USD stored by default. */
export const NGN_RATE = 1500;
/** GHS per USD stored by default (the "second, fake" charge currency). */
export const GHS_RATE = 15;

/**
 * The currencies config used by the harness: NGN as default plus GHS (mapped
 * from Ghana) so a client's local currency can be something other than naira.
 * KES is mapped to Kenya but DISABLED, to test an unchargeable currency.
 */
export const HARNESS_CONFIG = {
  defaultCurrency: "NGN",
  currencies: {
    GHS: { enabled: true, countries: ["GH", "Ghana"], minRate: 5, maxRate: 50 },
    KES: { enabled: false, countries: ["KE", "Kenya"], minRate: 50, maxRate: 500 },
  },
};

/** One recorded Paystack `initializeCharge` call. */
export interface ChargeCall {
  email: string;
  amount: Money;
  metadata?: Record<string, unknown>;
  callbackUrl?: string;
  /** Our own reference (issue #180 review fix). */
  reference?: string;
}

/** Shared state the tests read and drive. */
export const harness = {
  /** Every Paystack initialize call, in order. */
  charges: [] as ChargeCall[],
  /** reference -> what Paystack's verify reports (set by the test). */
  paystack: new Map<string, PaystackTransactionLookup>(),
  /** The rate store (tests change or drop rates to test staleness). */
  rateStore: undefined as any,
  /** The clock shared by the rate service and the charge path. */
  clock: fakeClock(NOW_ISO),
  /** uid -> profile country. */
  countries: {} as Record<string, string>,
  /** Throw this from the next initializeCharge (provider outage). */
  failNextCharge: false,
  /**
   * Review fix race tests: called on every Paystack lookup BEFORE it answers,
   * so a test can run another request "while" this one is mid-flight (e.g. a
   * verify confirming the booking between a retry's lookup and its re-price).
   * Its return value (when not undefined) replaces the lookup's answer.
   */
  onLookup: undefined as undefined | ((reference: string) => Promise<PaystackTransactionLookup | null | undefined>),

  /** Clear all state and restore the default rates and clock. */
  reset(): void {
    resetStore();
    this.charges.length = 0;
    this.paystack.clear();
    this.countries = {};
    this.failNextCharge = false;
    this.onLookup = undefined;
    const clock = fakeClock(NOW_ISO);
    this.clock = clock;
    const { service, store: rates } = makeService({ config: HARNESS_CONFIG, clock });
    this.rateStore = rates;
    setRate("NGN", NGN_RATE);
    setRate("GHS", GHS_RATE);
    setRate("KES", 130);
    consultationCharging.rates = async () => service;
    consultationCharging.now = () => harness.clock.now();
  },
};

/** Store a fresh provider rate for `currency` (dated "now" on the harness clock). */
export function setRate(currency: string, rate: number): void {
  const at = harness.clock.now();
  harness.rateStore.docs.set(currency, {
    currency,
    provider: { rate, asOf: at, fetchedAt: at, source: "cbn" },
    override: null,
    lastError: null,
  });
}

/** Drop every stored rate for `currency` (RATE_UNAVAILABLE). */
export function dropRate(currency: string): void {
  harness.rateStore.docs.delete(currency);
}

let refCounter = 0;

/** Install the fakes once per test file. */
export async function useHarness(): Promise<void> {
  await installFakes();
  const firebase: any = await import("../../src/utils/firebase");
  for (const name of [
    "consultations", "transactions", "agents", "agencies", "users", "notifications",
    // Issue #180 review fix: payments held for refund.
    "consultationPaymentExceptions",
  ]) {
    firebase.collections[name] = fakeCollection(name);
  }
  // The shared fake transaction neither isolates nor retries. Real Firestore
  // transactions are serializable (a conflicting one is retried on fresh
  // data), so run ours one at a time: an interleaving the real database
  // would never commit can then not pass a test either.
  let txChain: Promise<unknown> = Promise.resolve();
  consultationCharging.runTransaction = ((fn: any) => {
    const run = txChain.then(() => fakeRunTransaction(fn));
    txChain = run.catch(() => undefined);
    return run;
  }) as any;
  // A caller that lost a checkout race re-reads without a real pause.
  consultationCharging.sleep = () => new Promise((resolve) => setImmediate(resolve));
  consultationCharging.profileCountry = async (uid: string) => harness.countries[uid];

  // ---- Paystack: recorders, never the network ----
  const ps: any = paystackProvider;
  ps.initializeCharge = async (input: ChargeCall) => {
    if (harness.failNextCharge) {
      harness.failNextCharge = false;
      throw new Error("PAYSTACK_ERROR: simulated outage (HTTP 503)");
    }
    harness.charges.push(input);
    // Paystack echoes a caller-supplied reference (issue #180 review fix:
    // the charge path generates its own); else it makes one up.
    const reference = input.reference ?? `ref-${++refCounter}`;
    // Yield like a network call, so concurrent requests really interleave.
    await new Promise((resolve) => setImmediate(resolve));
    return { authorizationUrl: `https://checkout.paystack.test/${reference}`, reference };
  };
  ps.getTransactionMetadata = async (reference: string) => {
    // Snapshot the answer BEFORE the hook runs: the caller saw this state.
    const seen = harness.paystack.get(reference) ?? null;
    if (harness.onLookup) {
      const hook = harness.onLookup;
      const replaced = await hook(reference);
      if (replaced !== undefined) return replaced;
    }
    return seen;
  };

  // ---- Guest account provisioning: a fake Auth user + no claim email ----
  let uidCounter = 0;
  firebase.auth.createUser = async () => ({ uid: `uid-guest-${++uidCounter}` });
  const { authController } = await import("../../src/controllers/auth.controller");
  (authController as any).sendClaimEmail = async () => undefined;

  // ---- Notifications: no-op ----
  (notificationService as any).notifyUser = async () => undefined;
  harness.reset();
}

/** Minimal Express-like res that records status + body. */
export function captureRes() {
  const out: { status: number; body: any } = { status: 0, body: undefined };
  const res = {
    status: (n: number) => ((out.status = n), res),
    json: (b: unknown) => ((out.body = b), res),
  };
  return { out, res: res as any };
}

/** Every stored doc under a collection, as [id, data]. */
export function docsIn(collection: string): Array<[string, Record<string, any>]> {
  return [...store.entries()]
    .filter(([k]) => k.startsWith(`${collection}/`) && !k.slice(collection.length + 1).includes("/"))
    .map(([k, v]) => [k.slice(collection.length + 1), v as Record<string, any>]);
}

/** Seed a doc directly (no write recorded as a "test write" concern). */
export async function seed(collection: string, id: string, data: Record<string, unknown>): Promise<void> {
  await fakeCollection(collection).doc(id).set({ id, ...data });
}

/** A fixed timestamp for seeded docs. */
export const T0 = Timestamp.fromDate(new Date(NOW_ISO));

/**
 * Mark a reference as paid at Paystack with the given amount/currency.
 * `extra` overrides lookup fields (e.g. `requestedAmount`, issue #180 review).
 */
export function paystackPaid(
  reference: string,
  consultationId: string,
  amount: Money,
  paidAt = harness.clock.now(),
  extra: Partial<PaystackTransactionLookup> = {}
): void {
  harness.paystack.set(reference, {
    status: "success",
    metadata: { purpose: "consultation", consultationId },
    amount: amount.amountMinor,
    currency: amount.currency,
    paidAt: paidAt.toISOString(),
    ...extra,
  });
}

/** Mark a reference with any Paystack status (e.g. "ongoing" for an in-flight bank transfer). */
export function paystackStatus(reference: string, consultationId: string, status: string): void {
  harness.paystack.set(reference, { status, metadata: { purpose: "consultation", consultationId } });
}

/** Mark a reference as not (yet) paid at Paystack. */
export function paystackAbandoned(reference: string, consultationId: string, extra: Record<string, unknown> = {}): void {
  harness.paystack.set(reference, {
    status: "abandoned",
    metadata: { purpose: "consultation", consultationId, ...extra },
  });
}
