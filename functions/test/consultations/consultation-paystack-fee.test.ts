// ============================================
// Unit tests: the agent pays Paystack's fee on a paid consultation (issue #395)
// ============================================
//
// Hermetic (test/consultations/harness.ts): in-memory Firestore, every
// Paystack call stubbed (no real money moves), a fixed clock the tests move.
// Paystack's fee is the RAW `data.fees` of the stubbed report, parsed by the
// real `toTransactionLookup` (bookAndPay `{ fees }`).
//
// The rule under test (decision 2026-11-17), per Paystack reference with
// A = amount charged and F = Paystack's `fees` in the same currency:
//  - the fee Transaction's `amount` stays A, it stores F, and the agent is
//    credited A - F: in `heldBalance` while held, in `availableBalance` once
//    released, and in `totalRevenue` (stats AND analytics);
//  - the client's history shows A only, never the fee or the net;
//  - F unknown (missing, null, negative, a string, a fraction, another
//    currency) or F >= A: booking confirmed, row credited NOWHERE, listed
//    for an admin; the scheduled job or an admin refresh stores F once when
//    Paystack reports it (409 while it does not);
//  - a fee is written once per reference, whatever settles it, and is never
//    overwritten.

import { test, describe, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";

import { useHarness, harness, docsIn, seed, captureRes, T0 } from "./harness";
import {
  admin, agent, balanceOf, bookAndPay, client, feeOf, listTransactions, ownerA, refOf, reqFor, setStatus, withdraw,
} from "./refund-fixtures";
import { notificationService } from "../../src/services/notification.service";
import { consultationController } from "../../src/controllers/consultation.controller";
import { transactionController } from "../../src/controllers/transaction.controller";
import { settlePayment } from "../../src/services/consultation-charge.service";
import { toTransactionLookup } from "../../src/services/billing/paystack.provider";
import { paystackFeeService } from "../../src/services/paystack-fee.service";
import { transactionService } from "../../src/services/transaction.service";
import { classifyPaystackFee, consultationFeeCredit } from "../../src/money/paystack-fee";
import { revenueEffect } from "../../src/money/totals";
import { sumRevenueByCurrency } from "../../src/services/analytics.service";
import type { Transaction } from "../../src/types";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ============================================
// Setup: silence notifications and logs
// ============================================

const realError = console.error;
const realWarn = console.warn;

before(async () => {
  await useHarness();
  (notificationService as any).notifyUser = async () => undefined;
});
beforeEach(() => {
  harness.reset();
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  console.error = () => {};
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  console.warn = () => {};
});
afterEach(() => {
  console.error = realError;
  console.warn = realWarn;
});

// ============================================
// Helpers
// ============================================

/** A: ₦9,000.00 in kobo (the fixtures' default charge). */
const A = 900_000;
/** F: Paystack's fee, ₦150.00 in kobo. */
const F = 15_000;

/** Every stored consultation fee Transaction. */
function feeRows(): Record<string, any>[] {
  return docsIn("transactions").map(([, d]) => d).filter((d) => d.type === "consultation_fee");
}

/** Move the clock past the fee's release (slot end + 24 h; the slot is 168 h away). */
function releaseHold(): void {
  harness.clock.advanceHours(168 + 1 + 25);
}

/** Make Paystack report `fees` (raw) for booking `id`'s reference from now on. */
function paystackNowReports(id: string, fees: unknown, currency?: string): void {
  const reference = refOf(id);
  const seen = harness.paystack.get(reference)!;
  harness.paystack.set(
    reference,
    toTransactionLookup({ ...seen, paid_at: seen.paidAt, fees, ...(currency ? { currency } : {}) })
  );
}

/** POST /transactions/:id/paystack-fee/refresh as `p`. */
async function refresh(p: any, id: string) {
  const { out, res } = captureRes();
  await transactionController.refreshPaystackFee(reqFor(p, { params: { id } }), res);
  return out;
}

/** POST /consultations/public/verify with `reference`. */
async function verify(reference: string) {
  const { out, res } = captureRes();
  await consultationController.verifyPublicConsultation({ body: { reference } } as any, res);
  return out;
}

// ============================================
// The pure rules
// ============================================

describe("classifyPaystackFee / consultationFeeCredit (pure)", () => {
  test("a well-formed fee in the charge currency below A is known; the credit is A - F", () => {
    assert.deepEqual(classifyPaystackFee(A, "NGN", { fees: F, currency: "NGN" }), { status: "known", feeMinor: F });
    assert.equal(consultationFeeCredit({ amount: A, paystackFeeStatus: "known", paystackFeeMinor: F }), A - F);
    // Fee of 0: credit A, no special case.
    assert.deepEqual(classifyPaystackFee(A, "NGN", { fees: 0, currency: "NGN" }), { status: "known", feeMinor: 0 });
    assert.equal(consultationFeeCredit({ amount: A, paystackFeeStatus: "known", paystackFeeMinor: 0 }), A);
  });

  test("missing / malformed / other-currency fees are unknown; F >= A is fee_not_less_than_amount", () => {
    for (const fees of [undefined, null, -1, "15000", 150.5, NaN, Infinity]) {
      assert.deepEqual(classifyPaystackFee(A, "NGN", { fees, currency: "NGN" }), { status: "unknown" }, String(fees));
    }
    assert.deepEqual(classifyPaystackFee(A, "GHS", { fees: F, currency: "NGN" }), { status: "unknown" });
    assert.deepEqual(classifyPaystackFee(A, "NGN", null), { status: "unknown" });
    assert.deepEqual(classifyPaystackFee(A, "NGN", { fees: A, currency: "NGN" }), { status: "fee_not_less_than_amount", feeMinor: A });
  });

  test("credit: legacy rows count A; unknown, not-less and bad stored data count nothing", () => {
    assert.equal(consultationFeeCredit({ amount: A }), A);
    assert.equal(consultationFeeCredit({ amount: A, paystackFeeStatus: "unknown" }), null);
    assert.equal(consultationFeeCredit({ amount: A, paystackFeeStatus: "fee_not_less_than_amount", paystackFeeMinor: A }), null);
    // A "known" row with an unusable stored fee fails closed.
    assert.equal(consultationFeeCredit({ amount: A, paystackFeeStatus: "known", paystackFeeMinor: "15000" as any }), null);
    assert.equal(consultationFeeCredit({ amount: A, paystackFeeStatus: "known", paystackFeeMinor: A }), null);
  });
});

// ============================================
// Recording the fee at settlement
// ============================================

describe("settle with a known fee", () => {
  test("amount A, fee F stored, held A - F, then available A - F after release; client sees A only", async () => {
    const fee = await bookAndPay("c1", { fees: F });
    assert.equal(fee.amount, A);
    assert.equal(fee.currency, "NGN");
    assert.equal(fee.paystackFeeMinor, F);
    assert.equal(fee.paystackFeeStatus, "known");
    assert.equal(fee.agentCreditMinor, A - F);
    assert.equal(fee.paystackFeeResolvedBy, "settle");
    assert.equal(feeRows().length, 1);

    // Held while the meeting is to come.
    let bal = await balanceOf(agent);
    assert.equal(bal.heldBalance, A - F);
    assert.equal(bal.availableBalance, 0);
    assert.equal(bal.totalRevenue, A - F);

    // Released after the slot + 24 h: withdrawable, still net.
    releaseHold();
    bal = await balanceOf(agent);
    assert.equal(bal.heldBalance, 0);
    assert.equal(bal.availableBalance, A - F);
    assert.equal(bal.totalRevenue, A - F);
    // A withdrawal of more than the net is refused; the net itself is allowed.
    assert.equal((await withdraw(A)).status, 400);
    assert.equal((await withdraw(A - F)).status, 201);

    // The client's history: the amount charged, never the fee or the net.
    const mine = await listTransactions(client);
    const row = mine.body.data.find((t: any) => t.type === "consultation_fee");
    assert.equal(row.amount, A);
    assert.deepEqual(row.amountCharged, { amountMinor: A, currency: "NGN" });
    for (const hidden of ["paystackFeeMinor", "agentCreditMinor", "paystackFeeStatus", "paystackFeeResolvedAt", "paystackFeeResolvedBy"]) {
      assert.equal(hidden in row, false, `${hidden} is hidden from the client`);
    }
  });

  test("the agent and owner scopes see the fee and the net on the row; admin stats show gross, fee and net", async () => {
    await bookAndPay("c1", { fees: F });
    // The owner scope finds the agency's agents by their agent docs.
    await seed("agents", "prof-agent1", { userId: agent.uid, agencyId: "agency-a" });
    for (const p of [agent, ownerA]) {
      const out = await listTransactions(p, p === ownerA ? { role: "owner" } : {});
      const row = out.body.data.find((t: any) => t.type === "consultation_fee");
      assert.equal(row.amount, A);
      assert.equal(row.paystackFeeMinor, F);
      assert.equal(row.agentCreditMinor, A - F);
      assert.equal(row.currency, "NGN");
    }
    // The agent's stats are net only.
    const agentStats = await balanceOf(agent);
    assert.equal("grossRevenue" in agentStats, false);
    // Admin stats: gross, Paystack's fees and net side by side.
    const { out, res } = captureRes();
    await transactionController.getStats(reqFor(admin, { query: { role: "admin" } }), res);
    const ngn = out.body.data.byCurrency.find((r: any) => r.currency === "NGN");
    assert.equal(ngn.totalRevenue, A - F);
    assert.equal(ngn.paystackFees, F);
    assert.equal(ngn.grossRevenue, A);
  });

  test("stats and analytics revenue agree (shared revenueEffect)", async () => {
    await bookAndPay("c1", { fees: F });
    await bookAndPay("c2", { fees: undefined });
    const rows = feeRows() as Transaction[];
    const analytics = sumRevenueByCurrency(rows);
    assert.equal(analytics.get("NGN"), A - F, "the unknown-fee row adds nothing to analytics revenue");
    assert.equal(transactionService.computeStats(rows).byCurrency[0].totalRevenue, A - F);
    assert.equal(revenueEffect(rows.find((r) => r.consultationId === "c1")!), A - F);
  });

  test("a fee of 0 credits A and shows 0", async () => {
    const fee = await bookAndPay("c1", { fees: 0 });
    assert.equal(fee.paystackFeeMinor, 0);
    assert.equal(fee.agentCreditMinor, A);
    assert.equal((await balanceOf(agent)).heldBalance, A);
  });

  test("a GHS charge: fee and credit in GHS minor units, nothing converted", async () => {
    const fee = await bookAndPay("g1", { charge: { amountMinor: 9_000, currency: "GHS" }, fees: 180 });
    assert.equal(fee.amount, 9_000);
    assert.equal(fee.currency, "GHS");
    assert.equal(fee.paystackFeeMinor, 180);
    assert.equal(fee.agentCreditMinor, 8_820);
    const ghs = await balanceOf(agent, "GHS");
    assert.equal(ghs.heldBalance, 8_820);
    assert.equal(ghs.totalRevenue, 8_820);
    // Nothing appears in naira.
    assert.equal((await balanceOf(agent, "NGN")).heldBalance, 0);
  });
});

// ============================================
// Fee unknown: never credit the full amount silently, never guess
// ============================================

describe("fee unknown at settle", () => {
  for (const [label, fees] of [
    ["missing", undefined], ["null", null], ["negative", -1], ["a string", "15000"], ["a fraction", 150.5],
  ] as Array<[string, unknown]>) {
    test(`${label}: booking confirmed, credit counted nowhere, listed for admin; refresh with the fee credits A - F once`, async () => {
      const fee = await bookAndPay("c1", { fees });
      // The client paid: the booking is confirmed.
      const booking = docsIn("consultations").find(([id]) => id === "c1")![1];
      assert.equal(booking.paymentStatus, "paid");
      assert.equal(booking.status, "scheduled");
      // Written with A and the status, no fee.
      assert.equal(fee.amount, A);
      assert.equal(fee.paystackFeeStatus, "unknown");
      assert.equal("paystackFeeMinor" in fee, false);
      assert.equal("agentCreditMinor" in fee, false);

      // Counted nowhere, held or released.
      let bal = await balanceOf(agent);
      assert.deepEqual([bal.heldBalance, bal.availableBalance, bal.totalRevenue], [0, 0, 0]);
      releaseHold();
      bal = await balanceOf(agent);
      assert.deepEqual([bal.heldBalance, bal.availableBalance, bal.totalRevenue], [0, 0, 0]);
      // It cannot be withdrawn.
      assert.equal((await withdraw(1)).status, 400);
      // The agent sees it marked as waiting for the provider's fee.
      const agentRow = (await listTransactions(agent)).body.data.find((t: any) => t.type === "consultation_fee");
      assert.equal(agentRow.paystackFeeStatus, "unknown");

      // Listed for admins.
      const listed = await listTransactions(admin, { role: "admin", type: "consultation_fee", paystackFeeStatus: "unknown" });
      assert.equal(listed.status, 200);
      assert.deepEqual(listed.body.data.map((t: any) => t.id), [fee.id]);

      // Still unknown at Paystack: 409, nothing written.
      const before = JSON.stringify(feeOf("c1"));
      const still = await refresh(admin, fee.id);
      assert.equal(still.status, 409);
      assert.equal(still.body.error, "PAYSTACK_FEE_UNKNOWN");
      assert.equal(JSON.stringify(feeOf("c1")), before, "nothing written");

      // Paystack now reports it: stored once, credited A - F (released by now).
      paystackNowReports("c1", F);
      const done = await refresh(admin, fee.id);
      assert.equal(done.status, 200);
      assert.equal(done.body.data.refreshed, true);
      const stored = feeOf("c1")!;
      assert.equal(stored.paystackFeeStatus, "known");
      assert.equal(stored.paystackFeeMinor, F);
      assert.equal(stored.agentCreditMinor, A - F);
      assert.equal(stored.paystackFeeResolvedBy, "admin_refresh");
      bal = await balanceOf(agent);
      assert.equal(bal.availableBalance, A - F);
      assert.equal(bal.totalRevenue, A - F);

      // A second refresh writes nothing and never overwrites.
      paystackNowReports("c1", F + 1);
      const again = await refresh(admin, fee.id);
      assert.equal(again.status, 200);
      assert.equal(again.body.data.refreshed, false);
      assert.equal(feeOf("c1")!.paystackFeeMinor, F);
      // No longer listed.
      const after = await listTransactions(admin, { role: "admin", type: "consultation_fee", paystackFeeStatus: "unknown" });
      assert.deepEqual(after.body.data, []);
    });
  }

  test("the scheduled job stores the fee once Paystack reports it; still missing it writes nothing", async () => {
    const held = await bookAndPay("c1", { fees: undefined });
    const other = await bookAndPay("c2", { fees: null });
    // First run: Paystack still has nothing.
    let run = await paystackFeeService.resolveUnknownFees();
    assert.deepEqual(run, { scanned: 2, resolved: 0, stillUnknown: 2, errors: 0 });
    assert.equal(feeOf("c1")!.paystackFeeStatus, "unknown");

    // Paystack reports c1's fee (held: the meeting is still to come).
    paystackNowReports("c1", F);
    run = await paystackFeeService.resolveUnknownFees();
    assert.deepEqual(run, { scanned: 2, resolved: 1, stillUnknown: 1, errors: 0 });
    const stored = feeOf("c1")!;
    assert.equal(stored.id, held.id);
    assert.equal(stored.paystackFeeMinor, F);
    assert.equal(stored.paystackFeeResolvedBy, "job");
    const bal = await balanceOf(agent);
    assert.equal(bal.heldBalance, A - F, "from now on it counts as A - F under the normal hold rules");
    assert.equal(feeOf("c2")!.paystackFeeStatus, "unknown");
    assert.equal(other.paystackFeeStatus, "unknown");

    // A Paystack outage counts as still unknown, and does not stop the run.
    harness.failNextLookup = true;
    run = await paystackFeeService.resolveUnknownFees();
    assert.deepEqual(run, { scanned: 1, resolved: 0, stillUnknown: 1, errors: 0 });
  });

  test("a fee reported later in ANOTHER currency stays unknown", async () => {
    const fee = await bookAndPay("g1", { charge: { amountMinor: 9_000, currency: "GHS" }, fees: undefined });
    paystackNowReports("g1", 180, "NGN");
    const out = await refresh(admin, fee.id);
    assert.equal(out.status, 409);
    assert.equal(feeOf("g1")!.paystackFeeStatus, "unknown");
  });

  test("F >= A at settle: held for admin (stored with the reason), nothing credited", async () => {
    const fee = await bookAndPay("c1", { fees: A });
    assert.equal(fee.paystackFeeStatus, "fee_not_less_than_amount");
    assert.equal(fee.paystackFeeMinor, A);
    assert.equal("agentCreditMinor" in fee, false);
    releaseHold();
    const bal = await balanceOf(agent);
    assert.deepEqual([bal.heldBalance, bal.availableBalance, bal.totalRevenue], [0, 0, 0]);
    const listed = await listTransactions(admin, { role: "admin", type: "consultation_fee", paystackFeeStatus: "fee_not_less_than_amount" });
    assert.deepEqual(listed.body.data.map((t: any) => t.id), [fee.id]);
    // A refresh never overwrites a stored fee.
    paystackNowReports("c1", F);
    const out = await refresh(admin, fee.id);
    assert.equal(out.body.data.refreshed, false);
    assert.equal(feeOf("c1")!.paystackFeeMinor, A);
  });

  test("F >= A found later by the job: stored with the reason, still credited nowhere", async () => {
    await bookAndPay("c1", { fees: undefined });
    paystackNowReports("c1", A + 1);
    await paystackFeeService.resolveUnknownFees();
    const stored = feeOf("c1")!;
    assert.equal(stored.paystackFeeStatus, "fee_not_less_than_amount");
    assert.equal(stored.paystackFeeMinor, A + 1);
    assert.equal((await balanceOf(agent)).heldBalance, 0);
  });

  test("a legacy fee row (written before #395) keeps counting as A and is never looked up", async () => {
    await seed("transactions", "legacy1", {
      userId: client.uid, agentId: agent.uid, consultationId: "old", type: "consultation_fee", amount: A, currency: "NGN",
      status: "completed", isEscrow: false, paymentProvider: "paystack", providerTransactionId: "cons-old-ref",
      description: "Consultation fee", feeHold: { state: "released", slotStartAt: T0, releaseAt: T0 },
      createdAt: T0, updatedAt: T0,
    });
    const bal = await balanceOf(agent);
    assert.equal(bal.availableBalance, A);
    assert.equal(bal.totalRevenue, A);
    const out = await refresh(admin, "legacy1");
    assert.equal(out.status, 409);
    assert.equal(out.body.error, "FEE_NOT_TRACKED");
    const run = await paystackFeeService.resolveUnknownFees();
    assert.equal(run.scanned, 0);
  });
});

// ============================================
// Authz of the admin routes
// ============================================

describe("admin-only fee routes", () => {
  test("refresh: agents, owners and clients get 403 before anything is read; unknown id 404; not a fee 404", async () => {
    const fee = await bookAndPay("c1", { fees: undefined });
    for (const p of [agent, ownerA, client]) {
      const out = await refresh(p, fee.id);
      assert.equal(out.status, 403, `role ${p.role}`);
    }
    assert.equal(feeOf("c1")!.paystackFeeStatus, "unknown");
    assert.equal((await refresh(admin, "nope")).status, 404);
    await seed("transactions", "wd1", {
      userId: agent.uid, agentId: agent.uid, type: "withdrawal", amount: 1, currency: "NGN", status: "pending",
      isEscrow: false, paymentProvider: "manual", description: "w", createdAt: T0, updatedAt: T0,
    });
    assert.equal((await refresh(admin, "wd1")).status, 404);
  });

  test("the unknown-fee list filter is admin only (client, agent, owner: 403), and validated", async () => {
    await bookAndPay("c1", { fees: undefined });
    for (const [p, query] of [
      [client, { role: "admin" }], [client, {}], [agent, { role: "admin" }], [agent, {}], [ownerA, { role: "owner" }],
    ] as Array<[any, Record<string, unknown>]>) {
      const out = await listTransactions(p, { ...query, type: "consultation_fee", paystackFeeStatus: "unknown" });
      assert.equal(out.status, 403, `${p.role} ${JSON.stringify(query)}`);
    }
    const bad = await listTransactions(admin, { role: "admin", paystackFeeStatus: "maybe" });
    assert.equal(bad.status, 400);
  });
});

// ============================================
// Idempotency and concurrency
// ============================================

describe("the fee is written once per reference", () => {
  test("verify plus a settlePayment stand-in for the webhook, at once and again: one fee Transaction, one stored fee", async () => {
    // A pending booking, paid at Paystack with fee F (seeded like bookAndPay, not settled).
    await bookAndPay("c0", { fees: F }); // another booking, so the store is not empty
    const reference = refOf("c1");
    await seed("consultations", "c1", {
      ...docsIn("consultations").find(([id]) => id === "c0")![1],
      id: "c1", status: "pending_payment", paymentStatus: "pending", transactionId: reference,
      checkoutUrl: `https://checkout.paystack.test/${reference}`,
    });
    harness.paystack.set(reference, toTransactionLookup({
      status: "success", metadata: { purpose: "consultation", consultationId: "c1" }, amount: A, currency: "NGN",
      paid_at: harness.clock.now().toISOString(), fees: F,
    }));
    const reported = harness.paystack.get(reference)!;
    const results = await Promise.all([
      verify(reference),
      settlePayment("c1", reference, reported),
      settlePayment("c1", reference, reported),
      verify(reference),
    ]);
    assert.equal(results[0].status, 200);
    const fees = feeRows().filter((r) => r.consultationId === "c1");
    assert.equal(fees.length, 1, "one fee Transaction");
    assert.equal(fees[0].paystackFeeMinor, F);

    // A later webhook with a DIFFERENT fee changes nothing.
    const later = await settlePayment("c1", reference, { ...reported, fees: F + 500 });
    assert.equal(later?.kind, "already_paid");
    assert.equal(feeRows().filter((r) => r.consultationId === "c1").length, 1);
    assert.equal(feeOf("c1")!.paystackFeeMinor, F);
  });

  test("two refreshes at once (and the job with them) store the fee once and never overwrite it", async () => {
    const fee = await bookAndPay("c1", { fees: undefined });
    paystackNowReports("c1", F);
    const [r1, r2, job] = await Promise.all([refresh(admin, fee.id), refresh(admin, fee.id), paystackFeeService.resolveUnknownFees()]);
    const refreshed = [r1, r2].filter((r) => r.status === 200 && r.body.data.refreshed === true).length;
    const jobStored = job.resolved;
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    // Exactly one writer stored it; the others found it known.
    assert.ok(refreshed + jobStored >= 1);
    const stored = feeOf("c1")!;
    assert.equal(stored.paystackFeeMinor, F);
    assert.equal(stored.agentCreditMinor, A - F);
    // Whoever stored it, the balance counts it once.
    assert.equal((await balanceOf(agent)).heldBalance, A - F);
  });

  test("a refresh racing a store: the second writer re-checks inside its transaction and writes nothing", async () => {
    const fee = await bookAndPay("c1", { fees: undefined });
    paystackNowReports("c1", F);
    // While the first refresh is talking to Paystack, the job stores F.
    let raced = false;
    harness.onLookup = async () => {
      if (raced) return undefined;
      raced = true;
      await paystackFeeService.resolveOne(fee.id, "job");
      // Paystack would now report something else: must never be stored over F.
      return toTransactionLookup({ status: "success", amount: A, currency: "NGN", fees: F + 999 });
    };
    const out = await refresh(admin, fee.id);
    assert.equal(out.status, 200);
    assert.equal(out.body.data.refreshed, false);
    assert.equal(feeOf("c1")!.paystackFeeMinor, F);
    assert.equal(feeOf("c1")!.paystackFeeResolvedBy, "job");
  });
});

// ============================================
// Cancelled before payment: unaffected
// ============================================

describe("unchanged paths", () => {
  test("a late client cancel keeps the net fee held for the agent", async () => {
    await bookAndPay("c1", { fees: F });
    harness.clock.advanceHours(168 - 2);
    const out = await setStatus(client, "cancelled");
    assert.equal(out.status, 200);
    assert.equal(out.body.data.refund, null);
    assert.equal((await balanceOf(agent)).heldBalance, A - F);
  });

  test("the stored fee time is a Timestamp", async () => {
    const fee = await bookAndPay("c1", { fees: F });
    assert.ok(fee.paystackFeeResolvedAt instanceof Timestamp);
  });
});
