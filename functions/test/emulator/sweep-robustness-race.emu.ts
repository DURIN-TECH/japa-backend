// ============================================
// Emulator test: sweep robustness races (issue #411)
// ============================================
//
// Run with `npm run test:emulator` (Auth + Firestore + Storage emulators, a
// `demo-` project, the real Express app). Paystack is the in-process stub
// below (recorders on `paystackProvider`): no real lookup, charge or refund.
//
// The unit tests (test/consultations/consultation-sweep-robustness.test.ts)
// run one transaction at a time on an in-memory store. Here real Firestore
// transactions run truly at the same time, to show:
//  1. the sweep settling a PAID retired checkout while the live one is still
//     in progress (#411 criterion 3), at the same moment as two verifies of
//     that retired checkout: ONE exception, ONE refund row, at most ONE fee
//     debit; the booking stays `pending_payment`; the sweep's bookkeeping
//     write never undoes anything (the real query, with its new
//     `sweepSetAside` filter, runs on the real query engine);
//  2. an admin's cancel of a set-aside booking (POST
//     /consultations/:id/sweep-review/cancel) racing the payer's verify of
//     its live checkout: the booking ends EITHER confirmed (and the cancel
//     refused) OR cancelled with the payment recorded and refunded; never
//     both, never a fee row on a cancelled booking;
//  3. the admin routes over real HTTP: 401 without a token, 403 for a client.
// (The emulator does not enforce composite indexes; the unit suite checks
// firestore.indexes.json statically.)

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";

import { refreshIdToken, resetEmulators, RunningApi, rulesEnv, signUp, startApi, TestAccount } from "./helpers";

/* eslint-disable @typescript-eslint/no-explicit-any */

let api: RunningApi;
const accounts: Record<string, TestAccount> = {};
/** name -> an ID token carrying the account's role claims. */
const tokens: Record<string, string> = {};
/** Every stubbed Paystack create-refund call: [reference, amountMinor, currency]. */
const refundCalls: Array<[string, number, string]> = [];
/** reference -> what the stubbed Paystack verify reports. */
const reports = new Map<string, any>();
/** Restores the real Paystack provider methods after the suite. */
let restore: () => void = () => undefined;

/** The charge of the bookings here: ₦9,000.00 in kobo. */
const FEE = 900_000;
/** Paystack's processing fee on that charge, as Paystack reports it. */
const PAYSTACK_FEE = 15_000;
const HOUR_MS = 3_600_000;

/** A signed-in account with role claims and a user doc; its claims token is kept in `tokens`. */
async function principal(name: string, claims: Record<string, unknown>): Promise<void> {
  const account = await signUp(name);
  const { auth, collections } = await import("../../src/utils/firebase");
  await auth.setCustomUserClaims(account.uid, claims);
  accounts[name] = account;
  tokens[name] = await refreshIdToken(account);
  await collections.users.doc(account.uid).set({ id: account.uid, email: account.email, firstName: name, lastName: "T" });
}

/** A Paystack "success" report for `reference` on booking `id`, for the full charge. */
function paidReport(id: string): any {
  return {
    status: "success", metadata: { purpose: "consultation", consultationId: id },
    amount: FEE, currency: "NGN", paidAt: new Date().toISOString(), fees: PAYSTACK_FEE,
  };
}

/**
 * An UNPAID booking, its quote lock ended 30 hours ago (so the sweep picks
 * it up), with a live checkout `cons-<id>-live` and optionally one checkout
 * RETIRED by an agent-side reschedule (#354) `cons-<id>-retired`.
 */
async function seedBooking(id: string, opts: { retired: boolean; extra?: Record<string, unknown> }): Promise<{ live: string; retired: string }> {
  const { collections } = await import("../../src/utils/firebase");
  const now = Date.now();
  const day = new Date(now + 7 * 86_400_000);
  const dayUtc = Timestamp.fromDate(new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate())));
  const live = `cons-${id}-live`;
  const retired = `cons-${id}-retired`;
  // The one charge snapshot both the booking and the retired entry carry.
  const snapshot = {
    priceUsdCents: 600, chargedCurrency: "NGN", chargedAmountMinor: FEE,
    fxRate: 1500, fxRateAsOf: Timestamp.fromMillis(now - 31 * HOUR_MS), fxRateSource: "cbn", fxMarginBps: 0,
    quoteLockedAt: Timestamp.fromMillis(now - 30.5 * HOUR_MS), quoteExpiresAt: Timestamp.fromMillis(now - 30 * HOUR_MS),
  };
  await collections.consultations.doc(id).set({
    id, userId: accounts.client.uid, agentId: accounts.agent.uid, clientName: "client",
    clientEmail: accounts.client.email, agentName: "agent", type: "initial", scheduledDate: dayUtc,
    scheduledTime: "12:00", durationMinutes: 30, timezone: "Africa/Lagos", status: "pending_payment",
    paymentStatus: "pending", bookedVia: "client", ...snapshot,
    transactionId: live,
    ...(opts.retired
      ? {
        supersededCheckouts: [{
          ...snapshot, reference: retired, supersededAt: Timestamp.fromMillis(now - 29 * HOUR_MS),
          retiredBy: "reschedule", retiredByAgentId: accounts.agent.uid,
        }],
      }
      : {}),
    // What booking creation writes (the sweep selects on it).
    sweepSetAside: false,
    createdAt: Timestamp.fromMillis(now - 31 * HOUR_MS), updatedAt: Timestamp.fromMillis(now - 29 * HOUR_MS),
    ...(opts.extra ?? {}),
  });
  return { live, retired };
}

/** The stored booking and every money row / exception for booking `id`. */
async function stateOf(id: string) {
  const { collections } = await import("../../src/utils/firebase");
  const booking = (await collections.consultations.doc(id).get()).data() as any;
  const txs = (await collections.transactions.where("consultationId", "==", id).get()).docs.map((d) => d.data() as any);
  const exceptions = (await collections.consultationPaymentExceptions.where("consultationId", "==", id).get()).docs.map((d) => d.data());
  const debits = (await collections.transactions.where("type", "==", "paystack_fee_debit").get()).docs
    .map((d) => d.data() as any)
    .filter((t) => t.consultationId === id || String(t.providerTransactionId ?? t.reference ?? "").includes(id));
  return {
    booking,
    refunds: txs.filter((t) => t.type === "refund"),
    fees: txs.filter((t) => t.type === "consultation_fee"),
    debits,
    exceptions: exceptions as any[],
  };
}

before(async () => {
  await rulesEnv();
  await resetEmulators();
  api = await startApi();

  // ---- Paystack: in-process recorders, never the network ----
  const { paystackProvider } = await import("../../src/services/billing/paystack.provider");
  const ps = paystackProvider as any;
  const saved = {
    createRefund: ps.createRefund,
    findRefundsForTransaction: ps.findRefundsForTransaction,
    getTransactionMetadata: ps.getTransactionMetadata,
  };
  let counter = 0;
  ps.createRefund = async (input: { reference: string; amount: { amountMinor: number; currency: string } }) => {
    refundCalls.push([input.reference, input.amount.amountMinor, input.amount.currency]);
    // A little latency, so the parallel calls really overlap.
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { id: String(++counter), status: "pending", transactionReference: input.reference, amount: input.amount.amountMinor, currency: input.amount.currency };
  };
  ps.findRefundsForTransaction = async () => [];
  ps.getTransactionMetadata = async (reference: string) => {
    // Latency here too, so the lookups of the racing callers interleave.
    await new Promise((resolve) => setTimeout(resolve, 10));
    return reports.get(reference) ?? null;
  };
  restore = () => {
    ps.createRefund = saved.createRefund;
    ps.findRefundsForTransaction = saved.findRefundsForTransaction;
    ps.getTransactionMetadata = saved.getTransactionMetadata;
  };

  await principal("agent", { role: "agent", agencyId: null, admin: false });
  await principal("client", { role: "client", agencyId: null, admin: false });
  await principal("admin", { role: "admin", agencyId: null, admin: true });
});

after(async () => {
  restore();
  await api.close();
  await (await rulesEnv()).cleanup();
});

describe("the sweep settles a paid retired checkout while the live one is in progress, raced by verify (#411)", () => {
  test("one exception, one refund row, at most one fee debit; the booking stays pending_payment; a second run adds nothing", async () => {
    const { live, retired } = await seedBooking("r411a", { retired: true });
    reports.set(retired, paidReport("r411a"));
    reports.set(live, { status: "ongoing", metadata: { purpose: "consultation", consultationId: "r411a" } });
    const { consultationService } = await import("../../src/services/consultation.service");

    const before = refundCalls.length;
    const [sweep, ...verifies] = await Promise.all([
      consultationService.sweepAbandonedBookings(),
      api.call("POST", "/consultations/public/verify", undefined, { reference: retired }),
      api.call("POST", "/consultations/public/verify", undefined, { reference: retired }),
    ]);
    // Verify never confirms a retired checkout (#354).
    for (const r of verifies as any[]) assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(sweep.errors, 0, JSON.stringify(sweep));
    assert.equal(sweep.cancelled, 0, JSON.stringify(sweep));
    assert.equal(sweep.leftInProgress, 1, JSON.stringify(sweep));

    const s = await stateOf("r411a");
    assert.equal(s.booking.status, "pending_payment", "the cancel waits for the live checkout");
    assert.equal(s.booking.paymentStatus, "pending");
    assert.equal(s.fees.length, 0, "never a fee Transaction");
    assert.equal(s.exceptions.length, 1, "one exception");
    assert.equal(s.exceptions[0].reason, "paid_for_rescheduled_slot");
    assert.equal(s.refunds.length, 1, "one refund row");
    assert.equal(s.refunds[0].amount, FEE);
    assert.ok(s.debits.length <= 1, "at most one fee debit");
    assert.deepEqual(refundCalls.slice(before), [[retired, FEE, "NGN"]], "one Paystack refund, in full");
    // The sweep's bookkeeping, on the real document.
    const states = Object.fromEntries(s.booking.sweepReview.checkouts.map((r: any) => [r.reference, r.state]));
    assert.equal(states[retired], "paid_handled");
    assert.equal(states[live], "in_progress");
    assert.equal(s.booking.sweepReview.unresolvedRuns, 1);

    // A second run: the handled retired checkout is not settled again; nothing new.
    const again = await consultationService.sweepAbandonedBookings();
    assert.equal(again.leftInProgress, 1);
    const s2 = await stateOf("r411a");
    assert.equal(s2.refunds.length, 1);
    assert.equal(s2.exceptions.length, 1);
    assert.equal(s2.debits.length, s.debits.length);
    assert.equal(s2.booking.sweepReview.unresolvedRuns, 2);
  });
});

describe("an admin cancel of a set-aside booking raced by the payer's verify (#411)", () => {
  test("ends either confirmed (cancel refused) or cancelled with the payment refunded; never both", async () => {
    const { consultationService, SWEEP_SET_ASIDE_AFTER_RUNS } = await import("../../src/services/consultation.service");
    const { collections } = await import("../../src/utils/firebase");
    const { live } = await seedBooking("r411b", { retired: false });
    // Set aside as the sweep would leave it (its fingerprint matches, so the release pass keeps it).
    const fresh = (await collections.consultations.doc("r411b").get()).data() as any;
    const { sweepFingerprint } = await import("../../src/services/consultation.service");
    await collections.consultations.doc("r411b").update({
      sweepSetAside: true,
      sweepReview: {
        unresolvedRuns: SWEEP_SET_ASIDE_AFTER_RUNS, fingerprint: sweepFingerprint(fresh),
        lastOutcome: "in_progress", lastRunAt: Timestamp.now(), setAsideAt: Timestamp.now(), checkouts: [],
      },
    });
    // The sweep no longer selects it (real query engine).
    const swept = await consultationService.sweepAbandonedBookings();
    assert.equal((await stateOf("r411b")).booking.status, "pending_payment", JSON.stringify(swept));

    // Listed for admins.
    const list = await api.call("GET", "/consultations/sweep-review", tokens.admin);
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.ok(list.body.data.some((item: any) => item.consultationId === "r411b"));

    // Paystack: the live checkout has just been paid.
    reports.set(live, paidReport("r411b"));
    const [cancel, verify] = await Promise.all([
      api.call("POST", "/consultations/r411b/sweep-review/cancel", tokens.admin),
      api.call("POST", "/consultations/public/verify", undefined, { reference: live }),
    ]);
    const s = await stateOf("r411b");
    if (s.booking.status === "cancelled") {
      // The cancel won: the late payment is recorded and refunded, never a fee row.
      assert.equal(cancel.status, 200, JSON.stringify(cancel.body));
      assert.equal(s.booking.cancelledBy, accounts.admin.uid);
      assert.equal(s.fees.length, 0);
      assert.equal(s.exceptions.length, 1);
      assert.equal(s.exceptions[0].reason, "booking_not_payable");
      assert.equal(s.refunds.length, 1);
      assert.equal(verify.status, 409, JSON.stringify(verify.body));
    } else {
      // The payment won (through settlePayment, by the verify or the admin's own check).
      assert.equal(s.booking.status, "scheduled");
      assert.equal(s.booking.paymentStatus, "paid");
      assert.equal(cancel.status, 409, JSON.stringify(cancel.body));
      assert.ok(["BOOKING_PAID", "BOOKING_CHANGED", "NOT_PENDING"].includes(cancel.body.error), JSON.stringify(cancel.body));
      assert.equal(s.fees.length, 1, "one fee Transaction");
      assert.equal(s.exceptions.length, 0);
      assert.equal(s.refunds.length, 0);
    }
  });
});

describe("admin sweep-review routes over HTTP (#411)", () => {
  test("401 without a token, 403 for a client, 200 for an admin", async () => {
    for (const [method, path] of [
      ["GET", "/consultations/sweep-review"],
      ["POST", "/consultations/r411a/sweep-review/check"],
      ["POST", "/consultations/r411a/sweep-review/cancel"],
    ] as const) {
      assert.equal((await api.call(method, path)).status, 401, `${method} ${path} without a token`);
      const asClient = await api.call(method, path, tokens.client);
      assert.equal(asClient.status, 403, `${method} ${path} as a client`);
      assert.equal(asClient.body.error, "FORBIDDEN");
    }
    assert.equal((await api.call("GET", "/consultations/sweep-review", tokens.admin)).status, 200);
  });
});
