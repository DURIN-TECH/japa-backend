// ============================================
// Emulator tests — resume a pending booking, and the abandoned-booking sweep (issue #288)
// ============================================
//
// Run with `npm run test:emulator` (Auth + Firestore emulators on the
// alternate ports of ../firebase.emulator-test.json, project `demo-...`, the
// real Express app, real ID tokens, the REAL Firestore transaction and query
// engine).
//
// Why an emulator test: the unit suites (test/consultations/
// consultation-resume-booking.test.ts and consultation-abandoned-sweep.test.ts)
// run on an in-memory Firestore whose transactions are simply run one at a
// time. Only a real Firestore transaction can prove that two creates sent AT
// THE SAME TIME cannot both write a booking, and only the real query engine
// runs the sweep's `status ==` + `quoteExpiresAt <` + `orderBy` query (and
// leaves a legacy row without `quoteExpiresAt` out of it).
//
// The emulator run has no payment provider and no exchange-rate feed, so:
//  - Paystack is STUBBED in this process (`initializeCharge` and
//    `getTransactionMetadata` recorders: no network, no real charge);
//  - the rate service is an in-memory one (the money test helper), with a
//    fixed naira rate;
//  - the charge path's clock (`chargeRuntime.now`) is moved by hand for the
//    sweep, so nothing waits a day.
// Everything else is real: the route, the auth token, the transaction.
//
// What is checked:
//  1. POST /consultations twice in parallel for the same slot (repeated over
//     fresh clients, and once as a burst of six): exactly one 201, the rest
//     200 `resumed: true` with the same booking id and checkout; exactly ONE
//     `consultations` document, and one checkout handed out;
//  2. a sequential second create resumes; a different time creates;
//  3. the sweep on the real query engine: an abandoned booking is cancelled
//     as the system, a paid one is settled, one in progress and a recent one
//     are left, a legacy row is never returned by the query.
// (The emulator does not enforce composite indexes; the one the sweep needs,
// consultations(status, quoteExpiresAt), is in firestore.indexes.json and is
// asserted by the unit suite.)

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

import { resetEmulators, rulesEnv, RunningApi, startApi, TestAccount, withoutRules } from "./helpers";
import { put, seedClient, seedIndependentAgent, SeededAgent, stored } from "./agency-fixtures";
import { fakeClock, makeService } from "../money/helpers";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** $10.00 at ₦1,500/$ = 1,500,000 kobo. */
const FEE_KOBO = 1_500_000;
const HOUR_MS = 3_600_000;

let api: RunningApi;
/** A verified, available agent with a $10 fee. */
let agent: SeededAgent;
/** The clock the charge path reads (moved by the sweep tests). */
const clock = fakeClock(new Date().toISOString());
/** Every stubbed Paystack `initializeCharge` call. */
const charges: { reference?: string; email: string }[] = [];
/** reference -> what the stubbed Paystack lookup answers. */
const paystack = new Map<string, Record<string, unknown>>();
/** The real functions the stubs replace (restored in `after`). */
let restore: () => void = () => undefined;

before(async () => {
  await rulesEnv();
  await resetEmulators();
  api = await startApi();

  // ---- The charge path's rates and clock: in-memory, fixed ----
  const { chargeRuntime } = await import("../../src/services/charge-checkout.service");
  const { paystackProvider } = await import("../../src/services/billing/paystack.provider");
  const { service, store: rates } = makeService({ config: { defaultCurrency: "NGN", currencies: {} }, clock });
  const at = clock.now();
  rates.docs.set("NGN", {
    currency: "NGN",
    provider: { rate: 1500, asOf: at, fetchedAt: at, source: "cbn" },
    override: null,
    lastError: null,
  } as any);
  const saved = {
    rates: chargeRuntime.rates,
    now: chargeRuntime.now,
    initializeCharge: (paystackProvider as any).initializeCharge,
    getTransactionMetadata: (paystackProvider as any).getTransactionMetadata,
  };
  chargeRuntime.rates = async () => service;
  chargeRuntime.now = () => clock.now();

  // ---- Paystack: recorders, never the network ----
  (paystackProvider as any).initializeCharge = async (input: { reference?: string; email: string }) => {
    charges.push(input);
    // A little latency, so parallel requests really overlap.
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { authorizationUrl: `https://checkout.paystack.test/${input.reference}`, reference: input.reference };
  };
  (paystackProvider as any).getTransactionMetadata = async (reference: string) => paystack.get(reference) ?? null;
  restore = () => {
    chargeRuntime.rates = saved.rates;
    chargeRuntime.now = saved.now;
    (paystackProvider as any).initializeCharge = saved.initializeCharge;
    (paystackProvider as any).getTransactionMetadata = saved.getTransactionMetadata;
  };

  agent = await seedIndependentAgent("r288-agent", {
    verificationStatus: "verified",
    isAvailable: true,
    consultationFeeUsd: { amountMinor: 1_000, currency: "USD" },
  });
});

after(async () => {
  restore();
  await api.close();
  await (await rulesEnv()).cleanup();
});

// ============================================
// Helpers
// ============================================

/** The client flow of POST /consultations. */
function book(client: TestAccount, extra: Record<string, unknown> = {}) {
  return api.call("POST", "/consultations", client.idToken, {
    agentId: agent.agentDocId,
    type: "initial",
    scheduledDate: "2027-03-01",
    scheduledTime: "10:00",
    ...extra,
  });
}

/** Every stored consultation of one client. */
async function bookingsOf(uid: string): Promise<Record<string, any>[]> {
  let rows: Record<string, any>[] = [];
  await withoutRules(async (db) => {
    rows = (await db.collection("consultations").where("userId", "==", uid).get()).docs.map((d: any) => d.data());
  });
  return rows;
}

/** Assert that a round of parallel creates left one booking and one checkout. */
async function assertOneBooking(client: TestAccount, outs: { status: number; body: any }[]): Promise<void> {
  const statuses = outs.map((o) => o.status).sort();
  assert.deepEqual(
    statuses,
    [...Array(outs.length - 1).fill(200), 201],
    `one 201 and the rest 200: ${JSON.stringify(outs.map((o) => [o.status, o.body?.error]))}`
  );
  const ids = new Set(outs.map((o) => o.body.data.id));
  assert.equal(ids.size, 1, "every caller holds the same booking");
  for (const out of outs) {
    assert.equal(out.body.data.resumed, out.status === 200 ? true : undefined);
    assert.equal(out.body.data.requiresPayment, true);
  }
  assert.equal(new Set(outs.map((o) => o.body.data.reference)).size, 1, "and the same checkout");

  const rows = await bookingsOf(client.uid);
  assert.equal(rows.length, 1, "exactly one consultations document");
  assert.equal(rows[0].status, "pending_payment");
  assert.equal(rows[0].transactionId, outs[0].body.data.reference);
  // Every caller was handed the SAME checkout (asserted above), and it is the
  // booking's current one. Usually Paystack was asked for exactly one; when a
  // second request reads the booking between the first one's claim and its
  // publish, the charge path may replace that not-yet-published checkout
  // (issue #180's claim -> open -> publish rules): the replaced reference was
  // never handed out and is kept in `supersededCheckouts`.
  const opened = charges.filter((c) => c.email === client.email).map((c) => c.reference);
  assert.ok(opened.length >= 1, "a Paystack checkout was opened");
  assert.ok(opened.includes(rows[0].transactionId), "the booking's checkout is one that was opened");
  const superseded = (rows[0].supersededCheckouts ?? []).map((s: any) => s.reference);
  assert.deepEqual(
    opened.filter((reference) => reference !== rows[0].transactionId).sort(),
    [...superseded].sort(),
    "any other opened checkout is recorded as superseded"
  );
}

// ============================================
// 1 + 2. Resume on create, on real transactions
// ============================================

describe("POST /consultations find-or-create on real Firestore transactions (issue #288)", () => {
  test("two creates sent together for the same slot leave ONE booking (three fresh clients)", async () => {
    for (let round = 0; round < 3; round++) {
      const client = await seedClient(`r288-pair-${round}`);
      const outs = await Promise.all([book(client), book(client)]);
      await assertOneBooking(client, outs);
    }
  });

  test("a burst of six creates for the same slot still leaves ONE booking", async () => {
    const client = await seedClient("r288-burst");
    const outs = await Promise.all(Array.from({ length: 6 }, () => book(client)));
    await assertOneBooking(client, outs);
  });

  test("a later create for the same slot resumes; another time is a new booking", async () => {
    const client = await seedClient("r288-seq");
    const first = await book(client);
    assert.equal(first.status, 201, JSON.stringify(first.body));

    // The same slot, sent as a 12-hour time: normalised, so it matches.
    const again = await book(client, { scheduledTime: "10:00 AM" });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.data.resumed, true);
    assert.equal(again.body.data.id, first.body.data.id);
    assert.equal(again.body.data.reference, first.body.data.reference);
    assert.equal(again.body.data.authorizationUrl, first.body.data.authorizationUrl);

    const other = await book(client, { scheduledTime: "11:00" });
    assert.equal(other.status, 201, JSON.stringify(other.body));
    assert.notEqual(other.body.data.id, first.body.data.id);

    const rows = await bookingsOf(client.uid);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.scheduledTime).sort(), ["10:00", "11:00"]);
  });

  test("a scheduledTime that is neither accepted form is 400 and writes nothing", async () => {
    const client = await seedClient("r288-badtime");
    const out = await book(client, { scheduledTime: "ten o'clock" });
    assert.equal(out.status, 400);
    assert.equal(out.body.error, "VALIDATION_ERROR");
    assert.equal((await bookingsOf(client.uid)).length, 0);
  });
});

// ============================================
// 3. The sweep, on the real query engine
// ============================================

describe("sweepAbandonedBookings on the real query engine (issue #288)", () => {
  /** Seed an unpaid, priced booking whose quote lock ended `hoursAgo` hours before the clock's now. */
  async function seedPending(id: string, hoursAgo: number, extra: Record<string, unknown> = {}): Promise<void> {
    const expiresAt = clock.now().getTime() - hoursAgo * HOUR_MS;
    // Plain Dates: the fixture writer (rules off) stores them as Timestamps.
    const now = clock.now();
    await put("consultations", id, {
      id, userId: `client-of-${id}`, agentId: agent.account.uid, bookedVia: "client",
      clientName: "Sweep Client", clientEmail: "delivered+sweep@resend.dev", agentName: "Indie r288-agent",
      type: "initial", scheduledDate: new Date("2027-03-01"), scheduledTime: "10:00",
      durationMinutes: 30, timezone: "Africa/Lagos", status: "pending_payment", paymentStatus: "pending",
      priceUsdCents: 1_000, chargedCurrency: "NGN", chargedAmountMinor: FEE_KOBO,
      fxRate: 1500, fxRateAsOf: now, fxRateSource: "cbn", fxMarginBps: 0,
      quoteLockedAt: new Date(expiresAt - 30 * 60_000),
      quoteExpiresAt: new Date(expiresAt),
      createdAt: now, updatedAt: now,
      ...extra,
    });
  }

  test("cancels the abandoned, settles the paid, leaves the in-progress, the recent and the legacy row", async () => {
    // Start from an empty collection, so the counts below are exact.
    await withoutRules(async (db) => {
      const all = await db.collection("consultations").get();
      await Promise.all(all.docs.map((d: any) => d.ref.delete()));
    });

    await seedPending("s288-abandoned", 30, { transactionId: "ref-s288-abandoned", checkoutUrl: "https://checkout.paystack.test/a" });
    await seedPending("s288-no-checkout", 49);
    await seedPending("s288-paid", 40, { transactionId: "ref-s288-paid", checkoutUrl: "https://checkout.paystack.test/p" });
    await seedPending("s288-in-progress", 60, { transactionId: "ref-s288-progress", checkoutUrl: "https://checkout.paystack.test/i" });
    await seedPending("s288-recent", 23);
    // A legacy row: pending, a naira fee, no quote lock at all.
    await put("consultations", "s288-legacy", {
      id: "s288-legacy", userId: "client-legacy", agentId: agent.account.uid, clientName: "Old Client",
      clientEmail: "delivered+legacy@resend.dev", agentName: "Indie r288-agent", type: "initial",
      scheduledDate: new Date("2026-01-01"), scheduledTime: "10:00", durationMinutes: 30,
      timezone: "Africa/Lagos", status: "pending_payment", paymentStatus: "pending", fee: 25_000,
      createdAt: new Date("2026-01-01"), updatedAt: new Date("2026-01-01"),
    });
    paystack.set("ref-s288-abandoned", { status: "abandoned", metadata: { purpose: "consultation", consultationId: "s288-abandoned" } });
    paystack.set("ref-s288-progress", { status: "ongoing", metadata: { purpose: "consultation", consultationId: "s288-in-progress" } });
    paystack.set("ref-s288-paid", {
      status: "success", metadata: { purpose: "consultation", consultationId: "s288-paid" },
      amount: FEE_KOBO, currency: "NGN", paidAt: clock.now().toISOString(),
    });

    const { consultationService } = await import("../../src/services/consultation.service");
    const result = await consultationService.sweepAbandonedBookings();
    // The query returned the four bookings past the cutoff, and only those.
    assert.deepEqual(result, { scanned: 4, cancelled: 2, settled: 1, leftInProgress: 1, skipped: 0, errors: 0 });

    for (const id of ["s288-abandoned", "s288-no-checkout"]) {
      const b = await stored("consultations", id);
      assert.equal(b.status, "cancelled", id);
      assert.equal(b.cancelledBy, "system");
      assert.equal(b.cancellationReason, "Cancelled by Seli: this booking wasn't paid in time. Please book again.");
      assert.equal(b.cancelledAt.toMillis(), clock.now().getTime());
      assert.equal(b.paymentStatus, "pending");
    }
    const paid = await stored("consultations", "s288-paid");
    assert.equal(paid.status, "scheduled");
    assert.equal(paid.paymentStatus, "paid");
    assert.equal(paid.cancelledBy, undefined);
    for (const id of ["s288-in-progress", "s288-recent", "s288-legacy"]) {
      const b = await stored("consultations", id);
      assert.equal(b.status, "pending_payment", id);
      assert.equal(b.cancelledBy, undefined, id);
    }

    // No notification was written for the system cancels.
    await withoutRules(async (db) => {
      for (const id of ["s288-abandoned", "s288-no-checkout"]) {
        const notes = await db.collection("notifications").where("relatedEntityId", "==", id).get();
        assert.equal(notes.size, 0, `no notification for ${id}`);
      }
    });

    // One clock hour and a bit later the "recent" one is past the cutoff too.
    clock.advanceHours(2);
    const next = await consultationService.sweepAbandonedBookings();
    assert.equal(next.cancelled, 1);
    assert.equal((await stored("consultations", "s288-recent")).status, "cancelled");
    // The in-progress one was looked at again and left again.
    assert.equal(next.leftInProgress, 1);
    assert.equal((await stored("consultations", "s288-legacy")).status, "pending_payment");
  });
});
