// ============================================
// Unit tests — cancel legacy pending consultations (issue #180), hermetic
// ============================================
//  - the pure decision: only a pending, unpaid, un-priced booking with a
//    client-supplied fee and no Paystack reference is cancelled; paid legacy
//    rows, #180 rows and legacy guest checkouts are left alone;
//  - the dry run writes nothing; apply cancels with an audit and keeps the
//    fee; a second apply changes nothing (idempotent);
//  - a booking that changed between the listing and the write is left alone.
import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";

import { installFakes, resetStore, fakeCollection, fakeRunTransaction, writes, store } from "../helpers/fake-firestore";
import {
  cancelLegacyPendingConsultations,
  planLegacyPending,
  LEGACY_CANCELLATION_REASON,
} from "../../src/scripts/cancel-legacy-pending-consultations";

/* eslint-disable @typescript-eslint/no-explicit-any */

before(async () => {
  await installFakes();
});
beforeEach(() => {
  resetStore();
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  console.log = () => {};
});

const AT = Timestamp.fromMillis(Date.UTC(2026, 10, 14));
const col = () => fakeCollection("consultations");
const deps = () => ({ pending: col().where("status", "==", "pending_payment"), runTransaction: fakeRunTransaction as any });
const doc = (id: string) => store.get(`consultations/${id}`) as Record<string, any>;

/** The rows a real project may hold. */
async function seedRows() {
  // Signed-in legacy: client-supplied fee, never charged -> CANCEL.
  await col().doc("legacy-signed-in").set({ id: "legacy-signed-in", status: "pending_payment", paymentStatus: "pending", fee: 1 });
  // Paid legacy: untouched, still naira.
  await col().doc("legacy-paid").set({ id: "legacy-paid", status: "scheduled", paymentStatus: "paid", fee: 50000 });
  // Legacy guest checkout that can still be paid: left alone.
  await col().doc("legacy-guest").set({
    id: "legacy-guest", status: "pending_payment", paymentStatus: "pending", fee: 50000, transactionId: "ref-g",
  });
  // A #180 booking: never touched.
  await col().doc("new").set({
    id: "new", status: "pending_payment", paymentStatus: "pending", priceUsdCents: 1000, chargedAmountMinor: 1_500_000, chargedCurrency: "NGN",
  });
  // Pending with no fee at all: manual review.
  await col().doc("odd").set({ id: "odd", status: "pending_payment", paymentStatus: "pending" });
}

describe("planLegacyPending", () => {
  test("cancels only a pending, unpaid, un-priced booking with a fee and no reference", () => {
    assert.deepEqual(planLegacyPending({ status: "pending_payment", paymentStatus: "pending", fee: 0.01 }), { action: "cancel", fee: 0.01 });
    assert.deepEqual(planLegacyPending({ status: "scheduled", paymentStatus: "paid", fee: 5 }), { action: "skip", reason: "not-pending" });
    assert.deepEqual(planLegacyPending({ status: "pending_payment", paymentStatus: "paid", fee: 5 }), { action: "skip", reason: "already-paid" });
    assert.deepEqual(
      planLegacyPending({ status: "pending_payment", paymentStatus: "pending", fee: 5, priceUsdCents: 0 }),
      { action: "skip", reason: "has-snapshot" }
    );
    assert.deepEqual(
      planLegacyPending({ status: "pending_payment", paymentStatus: "pending", fee: 5, transactionId: "r" }),
      { action: "skip", reason: "has-paystack-reference" }
    );
    assert.deepEqual(planLegacyPending({ status: "pending_payment", paymentStatus: "pending" }), { action: "review", reason: "no-fee" });
    assert.deepEqual(planLegacyPending(undefined), { action: "skip", reason: "not-pending" });
  });
});

describe("cancelLegacyPendingConsultations", () => {
  test("dry run reports the plan and writes nothing", async () => {
    await seedRows();
    writes.length = 0;
    const c = await cancelLegacyPendingConsultations({ apply: false, now: () => AT }, deps());
    assert.equal(c.scanned, 4); // legacy-paid is not pending, so not listed
    assert.equal(c.cancelled, 1);
    assert.deepEqual(c.skipped, { "has-paystack-reference": 1, "has-snapshot": 1 });
    assert.deepEqual(c.review, [{ path: "consultations/odd", reason: "no-fee" }]);
    assert.deepEqual(writes, []);
  });

  test("apply cancels with an audit and keeps the fee; paid, guest and #180 rows are untouched; a rerun changes nothing", async () => {
    await seedRows();
    const before = {
      paid: { ...doc("legacy-paid") },
      guest: { ...doc("legacy-guest") },
      fresh: { ...doc("new") },
    };
    const c = await cancelLegacyPendingConsultations({ apply: true, now: () => AT }, deps());
    assert.equal(c.cancelled, 1);
    const d = doc("legacy-signed-in");
    assert.equal(d.status, "cancelled");
    assert.equal(d.cancelledBy, "system");
    assert.equal(d.cancellationReason, LEGACY_CANCELLATION_REASON);
    assert.equal(d.cancelledAt.toMillis(), AT.toMillis());
    assert.deepEqual(d.legacyCancellation, { issue: 180, previousStatus: "pending_payment", fee: 1, at: AT });
    assert.equal(d.fee, 1);
    assert.deepEqual(doc("legacy-paid"), before.paid);
    assert.deepEqual(doc("legacy-guest"), before.guest);
    assert.deepEqual(doc("new"), before.fresh);

    writes.length = 0;
    const again = await cancelLegacyPendingConsultations({ apply: true, now: () => AT }, deps());
    assert.equal(again.cancelled, 0);
    assert.deepEqual(writes, []);
  });

  test("a booking paid between the listing and the write is left alone", async () => {
    await col().doc("racy").set({ id: "racy", status: "pending_payment", paymentStatus: "pending", fee: 1 });
    const listed = await col().where("status", "==", "pending_payment").get();
    // It gets paid after the listing.
    await col().doc("racy").update({ paymentStatus: "paid", status: "scheduled" });
    const c = await cancelLegacyPendingConsultations(
      { apply: true, now: () => AT },
      { pending: { get: async () => listed }, runTransaction: fakeRunTransaction as any }
    );
    assert.equal(c.cancelled, 0);
    assert.deepEqual(c.skipped, { "changed-during-run": 1 });
    assert.equal(doc("racy").status, "scheduled");
  });
});
