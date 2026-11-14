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

  /** Clear all state and restore the default rates and clock. */
  reset(): void {
    resetStore();
    this.charges.length = 0;
    this.paystack.clear();
    this.countries = {};
    this.failNextCharge = false;
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
  for (const name of ["consultations", "transactions", "agents", "agencies", "users", "notifications"]) {
    firebase.collections[name] = fakeCollection(name);
  }
  consultationCharging.runTransaction = fakeRunTransaction as any;
  consultationCharging.profileCountry = async (uid: string) => harness.countries[uid];

  // ---- Paystack: recorders, never the network ----
  const ps: any = paystackProvider;
  ps.initializeCharge = async (input: ChargeCall) => {
    if (harness.failNextCharge) {
      harness.failNextCharge = false;
      throw new Error("PAYSTACK_ERROR: simulated outage (HTTP 503)");
    }
    harness.charges.push(input);
    const reference = `ref-${++refCounter}`;
    return { authorizationUrl: `https://checkout.paystack.test/${reference}`, reference };
  };
  ps.getTransactionMetadata = async (reference: string) => harness.paystack.get(reference) ?? null;

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

/** Mark a reference as paid at Paystack with the given amount/currency. */
export function paystackPaid(reference: string, consultationId: string, amount: Money, paidAt = harness.clock.now()): void {
  harness.paystack.set(reference, {
    status: "success",
    metadata: { purpose: "consultation", consultationId },
    amount: amount.amountMinor,
    currency: amount.currency,
    paidAt: paidAt.toISOString(),
  });
}

/** Mark a reference as not (yet) paid at Paystack. */
export function paystackAbandoned(reference: string, consultationId: string, extra: Record<string, unknown> = {}): void {
  harness.paystack.set(reference, {
    status: "abandoned",
    metadata: { purpose: "consultation", consultationId, ...extra },
  });
}
