// ============================================
// Unit tests: slot time, the fee hold rule, the legacy backfill and the
// Paystack refund parsing (issue #317). Pure functions, plus one run of the
// backfill on the in-memory Firestore.
// ============================================
//
//  - `slotStartsAt` / `slotEndsAt`: the booking's UTC day + wall-clock time
//    in its zone (Lagos, a zone with daylight saving, a bad zone, a 12-hour
//    time, a bad time);
//  - `feeHoldStatusAt`: held until slot end + 24 h, or until a completion
//    once the slot started; refunded / released are final; no hold = held;
//  - `rescheduledFeeHold`: only ever later;
//  - `legacyFeeHold` + `decideFeeHoldBackfill` + `backfillFeeHolds`: the
//    decision for fees paid before #317;
//  - `decideCancellationRefund` at the 24 h boundary;
//  - `toPaystackRefund` / `refundStatusFromPaystack`.
import { describe, test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";

import { slotEndsAt, slotStartsAt } from "../../src/consultations/slot-time";
import {
  feeHoldStatusAt,
  initialFeeHold,
  legacyFeeHold,
  rescheduledFeeHold,
} from "../../src/money/fee-hold";
import { backfillFeeHolds, decideFeeHoldBackfill } from "../../src/scripts/backfill-fee-holds";
import { decideCancellationRefund, refundDocId, refundStatusFromPaystack } from "../../src/services/consultation-refund.service";
import { toPaystackRefund } from "../../src/services/billing/paystack.provider";
import { useHarness, harness, seed, docsIn } from "../consultations/harness";
import type { Consultation, Transaction } from "../../src/types";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** A booking on `day` (yyyy-MM-dd, read as its UTC day) at `time` in `zone`. */
function booking(day: string, time = "10:00", zone = "Africa/Lagos", over: Partial<Consultation> = {}): Consultation {
  return {
    id: "b1",
    userId: "u", agentId: "a", clientName: "", clientEmail: "", agentName: "", type: "initial",
    scheduledDate: Timestamp.fromDate(new Date(day)),
    scheduledTime: time,
    durationMinutes: 30,
    timezone: zone,
    status: "scheduled",
    paymentStatus: "paid",
    priceUsdCents: 600,
    chargedCurrency: "NGN",
    chargedAmountMinor: 900_000,
    transactionId: "cons-b1-ref",
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
    ...over,
  } as Consultation;
}

/** A Date from an ISO string. */
const d = (iso: string) => new Date(iso);

describe("slotStartsAt / slotEndsAt", () => {
  test("Lagos (UTC+1): 10:00 on 2026-11-20 is 09:00Z", () => {
    assert.equal(slotStartsAt(booking("2026-11-20")).toISOString(), "2026-11-20T09:00:00.000Z");
    assert.equal(slotEndsAt(booking("2026-11-20")).toISOString(), "2026-11-20T09:30:00.000Z");
  });

  test("a zone with daylight saving uses the offset of THAT day (London summer vs winter)", () => {
    assert.equal(slotStartsAt(booking("2026-07-01", "10:00", "Europe/London")).toISOString(), "2026-07-01T09:00:00.000Z");
    assert.equal(slotStartsAt(booking("2026-12-01", "10:00", "Europe/London")).toISOString(), "2026-12-01T10:00:00.000Z");
  });

  test("a 12-hour time is read; a bad zone falls back to Lagos; a bad time to midnight", () => {
    assert.equal(slotStartsAt(booking("2026-11-20", "2:30 PM")).toISOString(), "2026-11-20T13:30:00.000Z");
    assert.equal(slotStartsAt(booking("2026-11-20", "10:00", "Not/AZone")).toISOString(), "2026-11-20T09:00:00.000Z");
    assert.equal(slotStartsAt(booking("2026-11-20", "soon")).toISOString(), "2026-11-19T23:00:00.000Z");
  });

  test("no scheduledDate: throws (there is no slot)", () => {
    assert.throws(() => slotStartsAt({ scheduledTime: "10:00", timezone: "Africa/Lagos" } as any));
  });
});

describe("feeHoldStatusAt", () => {
  const hold = initialFeeHold(booking("2026-11-20"));

  test("a new hold: slot start, and release at slot end + 24 h", () => {
    assert.equal(hold.state, "held");
    assert.equal(hold.slotStartAt.toDate().toISOString(), "2026-11-20T09:00:00.000Z");
    assert.equal(hold.releaseAt.toDate().toISOString(), "2026-11-21T09:30:00.000Z");
  });

  test("held until releaseAt, released from it", () => {
    assert.equal(feeHoldStatusAt({ feeHold: hold }, d("2026-11-21T09:29:59Z")), "held");
    assert.equal(feeHoldStatusAt({ feeHold: hold }, d("2026-11-21T09:30:00Z")), "released");
  });

  test("a closed meeting releases once the slot started, not before", () => {
    const closed = { ...hold, meetingClosedAt: Timestamp.fromDate(d("2026-11-13T09:00:00Z")) };
    assert.equal(feeHoldStatusAt({ feeHold: closed }, d("2026-11-20T08:59:59Z")), "held");
    assert.equal(feeHoldStatusAt({ feeHold: closed }, d("2026-11-20T09:00:00Z")), "released");
  });

  test("refunded and released are final; no hold at all counts as held", () => {
    assert.equal(feeHoldStatusAt({ feeHold: { ...hold, state: "refunded" } }, d("2030-01-01T00:00:00Z")), "refunded");
    assert.equal(feeHoldStatusAt({ feeHold: { ...hold, state: "released" } }, d("2000-01-01T00:00:00Z")), "released");
    assert.equal(feeHoldStatusAt({}, d("2030-01-01T00:00:00Z")), "held");
  });

  test("a reschedule only ever moves the hold LATER", () => {
    const at = d("2026-11-16T00:00:00Z");
    assert.equal(rescheduledFeeHold(hold, booking("2026-11-01"), at), null, "earlier: unchanged");
    const later = rescheduledFeeHold(hold, booking("2026-11-27"), at)!;
    assert.equal(later.releaseAt.toDate().toISOString(), "2026-11-28T09:30:00.000Z");
    assert.equal(rescheduledFeeHold({ ...hold, state: "refunded" }, booking("2026-11-27"), at), null, "ended holds never move");
  });

  test("review fix: a hold RELEASED by the clock (stored state still 'held') is never moved back on hold", () => {
    const afterRelease = d("2026-11-21T09:30:00Z");
    assert.equal(feeHoldStatusAt({ feeHold: hold }, afterRelease), "released");
    assert.equal(rescheduledFeeHold(hold, booking("2026-11-27"), afterRelease), null);
    // Released by a closed meeting, too.
    const closed = { ...hold, meetingClosedAt: Timestamp.fromDate(d("2026-11-20T09:10:00Z")) };
    assert.equal(rescheduledFeeHold(closed, booking("2026-11-27"), d("2026-11-20T09:20:00Z")), null);
  });
});

describe("existing balances: legacyFeeHold / the backfill", () => {
  const now = d("2026-11-16T12:00:00Z");

  test("completed or no_show: released", () => {
    assert.equal(legacyFeeHold(booking("2026-11-30", "10:00", "Africa/Lagos", { status: "completed" }), now).state, "released");
    assert.equal(legacyFeeHold(booking("2026-11-30", "10:00", "Africa/Lagos", { status: "no_show" }), now).state, "released");
  });

  test("slot ended more than 24 h ago: released; otherwise held with the normal release time", () => {
    assert.equal(legacyFeeHold(booking("2026-11-14"), now).state, "released");
    const upcoming = legacyFeeHold(booking("2026-11-20"), now);
    assert.equal(upcoming.state, "held");
    assert.equal(upcoming.releaseAt.toDate().toISOString(), "2026-11-21T09:30:00.000Z");
  });

  test("decide: stamped fees are skipped, a missing booking is unresolved", () => {
    const fee = { id: "f", type: "consultation_fee" } as Transaction;
    assert.equal(decideFeeHoldBackfill({ ...fee, feeHold: initialFeeHold(booking("2026-11-20")) }, booking("2026-11-20"), now).kind, "skip_has_hold");
    assert.equal(decideFeeHoldBackfill(fee, null, now).kind, "skip_no_booking");
    assert.equal(decideFeeHoldBackfill(fee, { ...booking("2026-11-20"), scheduledDate: undefined } as any, now).kind, "skip_bad_slot");
  });

  describe("backfillFeeHolds on the in-memory Firestore", () => {
    before(async () => {
      await useHarness();
    });
    beforeEach(() => {
      harness.reset();
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      console.log = () => {};
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      console.warn = () => {};
    });

    test("dry run writes nothing; --apply stamps released / held; a second run is a no-op", async () => {
      await seed("consultations", "past", { ...booking("2026-11-10"), id: "past" });
      await seed("consultations", "soon", { ...booking("2026-11-20"), id: "soon" });
      for (const id of ["past", "soon"]) {
        await seed("transactions", `fee-${id}`, { type: "consultation_fee", consultationId: id, amount: 900_000, currency: "NGN", status: "completed" });
      }
      await seed("transactions", "fee-orphan", { type: "consultation_fee", consultationId: "gone", amount: 1, currency: "NGN", status: "completed" });

      const dry = await backfillFeeHolds({ apply: false, at: now });
      assert.deepEqual(dry, { scanned: 3, released: 1, held: 1, skipped: 0, unresolved: 1 });
      assert.ok(docsIn("transactions").every(([, t]) => !t.feeHold), "dry run writes nothing");

      await backfillFeeHolds({ apply: true, at: now });
      const holds = Object.fromEntries(docsIn("transactions").map(([id, t]) => [id, t.feeHold?.state]));
      assert.deepEqual(holds, { "fee-past": "released", "fee-soon": "held", "fee-orphan": undefined });

      const again = await backfillFeeHolds({ apply: true, at: now });
      assert.equal(again.skipped, 2);
    });

    test("review fix: a fee with a refund row is never stamped; the target project is printed", async () => {
      const lines: string[] = [];
      console.log = (...args: unknown[]) => {
        lines.push(args.map(String).join(" "));
      };
      await seed("consultations", "soon", { ...booking("2026-11-20"), id: "soon" });
      await seed("transactions", "fee-soon", {
        type: "consultation_fee", consultationId: "soon", amount: 900_000, currency: "NGN",
        status: "completed", providerTransactionId: "cons-soon-ref",
      });
      await seed("transactions", refundDocId("cons-soon-ref"), { type: "refund", status: "processing", amount: 900_000, currency: "NGN" });
      const result = await backfillFeeHolds({ apply: true, at: now });
      assert.equal(result.skipped, 1);
      assert.equal(docsIn("transactions").find(([id]) => id === "fee-soon")![1].feeHold, undefined);
      assert.match(lines[0], /^Fee hold backfill against /);
    });
  });
});

describe("decideCancellationRefund (pure)", () => {
  const b = booking("2026-11-20"); // slot start 2026-11-20T09:00Z

  test("agent side: always full", () => {
    assert.deepEqual(decideCancellationRefund("agent_side", b, d("2026-11-20T08:59:00Z")), { kind: "full", reason: "agent_cancelled" });
  });

  test("client: exactly 24 h before is full; one minute later is late", () => {
    assert.deepEqual(decideCancellationRefund("client", b, d("2026-11-19T09:00:00Z")), { kind: "full", reason: "client_cancelled" });
    assert.deepEqual(decideCancellationRefund("client", b, d("2026-11-19T09:01:00Z")), { kind: "late_client_cancel" });
  });

  test("free / unpaid: nothing", () => {
    assert.deepEqual(
      decideCancellationRefund("agent_side", booking("2026-11-20", "10:00", "Africa/Lagos", { priceUsdCents: 0, chargedAmountMinor: undefined, transactionId: undefined }), d("2026-11-13T00:00:00Z")),
      { kind: "nothing" }
    );
    assert.deepEqual(
      decideCancellationRefund("client", booking("2026-11-20", "10:00", "Africa/Lagos", { paymentStatus: "pending" }), d("2026-11-13T00:00:00Z")),
      { kind: "nothing" }
    );
  });

  test("review fix: the client's window counts from the PAID slot when the agent moved it earlier", () => {
    const paid = { feeHold: initialFeeHold(booking("2026-11-20")) }; // paid for 2026-11-20T09:00Z
    const movedEarlier = booking("2026-11-13", "12:00"); // now 2026-11-13T11:00Z
    const at = d("2026-11-13T10:00:00Z"); // 1 h before the moved slot
    assert.deepEqual(decideCancellationRefund("client", movedEarlier, at), { kind: "late_client_cancel" }, "without the hold");
    assert.deepEqual(decideCancellationRefund("client", movedEarlier, at, paid), { kind: "full", reason: "client_cancelled" });
    // Moved LATER: the later slot counts (the client gets more time).
    const movedLater = booking("2026-11-27");
    assert.deepEqual(decideCancellationRefund("client", movedLater, d("2026-11-25T00:00:00Z"), paid), { kind: "full", reason: "client_cancelled" });
  });

  test("the refund doc id is deterministic and hides the reference", () => {
    assert.equal(refundDocId("cons-b1-ref"), refundDocId("cons-b1-ref"));
    assert.notEqual(refundDocId("cons-b1-ref"), refundDocId("cons-b2-ref"));
    assert.ok(!refundDocId("cons-b1-ref").includes("cons-b1-ref"));
  });
});

describe("Paystack refund parsing", () => {
  test("create answer, list row and webhook data all read the same way", () => {
    assert.deepEqual(toPaystackRefund({ id: 15581137, status: "pending", amount: 900000, currency: "ngn", transaction: { reference: "r1" } }), {
      id: "15581137", status: "pending", transactionReference: "r1", amount: 900000, currency: "NGN",
    });
    assert.deepEqual(toPaystackRefund({ id: 5, status: "processed", transaction_reference: "r2", amount: 100 }), {
      id: "5", status: "processed", transactionReference: "r2", amount: 100,
    });
    // Webhooks can send the amount as a string.
    assert.equal(toPaystackRefund({ id: "9", status: "processed", amount: "900000" })?.amount, 900000);
    assert.equal(toPaystackRefund({ status: "pending" }), null, "no id: not a refund");
  });

  test("status mapping", () => {
    assert.equal(refundStatusFromPaystack("processed"), "completed");
    assert.equal(refundStatusFromPaystack("failed"), "failed");
    for (const s of ["pending", "processing", "needs-attention"]) assert.equal(refundStatusFromPaystack(s), "processing");
  });
});
