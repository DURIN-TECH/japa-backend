// ============================================
// Unit tests — who may change a consultation's status or delete it (issue #151)
// ============================================
//
// Hermetic (test/consultations/harness.ts): in-memory Firestore, Paystack
// stubbed, a fixed clock. Requests carry a REAL CASL ability from
// @durin-tech/authz, as verifyAuth leaves them.
//
// What is covered, by acceptance criterion:
//  - PUT /consultations/:id/status, EVERY cell of the table: each party
//    (client, the booking's agent, its agency's owner, an admin) x each
//    target x each starting status. Allowed cells answer 200 and store the
//    status; the others answer 403 (a client asking for anything but
//    `cancelled`) or 409 INVALID_STATUS_TRANSITION;
//  - `pending_payment` / `scheduled` as the target: 400 for anyone;
//  - an invalid status string keeps 400; an unknown id keeps 404;
//  - a non-party (another client, another agency's owner / agent, an agent
//    of the SAME agency who is not the booking's agent) gets 403;
//  - payment in flight: cancelling a pending booking with a checkout inside
//    its quote lock is 409 PAYMENT_IN_PROGRESS; allowed after the lock and
//    with no checkout; a payment landing on the cancelled booking is
//    recorded in consultationPaymentExceptions (`booking_not_payable`);
//  - every refusal writes nothing and notifies nobody; an allowed change
//    notifies the other party;
//  - DELETE /consultations/:id: admins only, and never a booking that
//    carries a payment: a `transactionId`, or `paymentStatus: "paid"` with a
//    non-zero charge (409 BOOKING_HAS_PAYMENT). A free booking ($0, marked
//    paid, no transaction) can be deleted by an admin.
import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";
import { defineAbilitiesFor, ROLES } from "@durin-tech/authz";
import type { AuthzSubject } from "@durin-tech/authz";

import { writes } from "../helpers/fake-firestore";
import { useHarness, harness, captureRes, docsIn, seed, paystackPaid, T0 } from "./harness";
import { consultationController } from "../../src/controllers/consultation.controller";
import {
  CONSULTATION_ACTORS,
  CONSULTATION_STATUSES,
  STATUS_TRANSITIONS,
  decideStatusChange,
  isPaymentInFlight,
} from "../../src/services/consultation.service";
import { notificationService } from "../../src/services/notification.service";
import type { ConsultationStatus } from "../../src/types";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Every notification sent during a test (the harness's no-op, made a recorder). */
const notified: Array<{ userId: string; type: string }> = [];

before(async () => {
  await useHarness();
  (notificationService as any).notifyUser = async (n: { userId: string; type: string }) => {
    notified.push({ userId: n.userId, type: n.type });
  };
});
beforeEach(() => {
  harness.reset();
  notified.length = 0;
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  console.log = () => {};
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  console.error = () => {};
});

// ============================================
// Principals and fixtures
// ============================================

/** The booking's client. */
const client: AuthzSubject = { uid: "uid-client1", role: ROLES.CLIENT, agencyId: null };
/** The booking's agent (a member of agency A). */
const agent: AuthzSubject = { uid: "uid-agent1", role: ROLES.AGENT, agencyId: "agency-a" };
/** The owner of the booking's agency (NOT the booking's agent). */
const ownerA: AuthzSubject = { uid: "uid-owner-a", role: ROLES.OWNER, agencyId: "agency-a" };
/** A platform admin. */
const admin: AuthzSubject = { uid: "uid-admin", role: ROLES.ADMIN, agencyId: null };
/** People who are NOT a party of the booking. */
const otherClient: AuthzSubject = { uid: "uid-client2", role: ROLES.CLIENT, agencyId: null };
const ownerB: AuthzSubject = { uid: "uid-owner-b", role: ROLES.OWNER, agencyId: "agency-b" };
const agentB: AuthzSubject = { uid: "uid-agent-b", role: ROLES.AGENT, agencyId: "agency-b" };
/** Same agency as the booking, but not its agent. */
const colleague: AuthzSubject = { uid: "uid-agent2", role: ROLES.AGENT, agencyId: "agency-a" };
/** An owner whose principal names no agency (must never match a booking without one). */
const ownerNoAgency: AuthzSubject = { uid: "uid-owner-x", role: ROLES.OWNER, agencyId: null };

const AGENT_SIDE = [agent, ownerA, admin];
const OUTSIDERS = [otherClient, ownerB, agentB, colleague];

/** A request for `p` as verifyAuth leaves it. */
function reqFor(p: AuthzSubject, extra: Record<string, unknown> = {}): any {
  return { userId: p.uid, authz: p, ability: defineAbilitiesFor(p), entitlements: null, query: {}, params: {}, body: {}, ...extra };
}

/**
 * Seed booking "c1" (client 1, agent 1, agency A) in `status`, then forget
 * the seed write so `writes` only holds what the request under test wrote.
 * An unpaid `pending_payment` booking has NO checkout unless `over` adds one.
 */
async function seedBooking(status: ConsultationStatus, over: Record<string, unknown> = {}, id = "c1") {
  await seed("consultations", id, {
    userId: "uid-client1", agentId: "uid-agent1", agencyId: "agency-a", status,
    paymentStatus: status === "pending_payment" ? "pending" : "paid",
    scheduledDate: T0, priceUsdCents: 0, createdAt: T0, updatedAt: T0, ...over,
  });
  writes.length = 0;
}

/** PUT /consultations/:id/status as `p`. */
async function setStatus(p: AuthzSubject, status: unknown, id = "c1", body: Record<string, unknown> = {}) {
  const { out, res } = captureRes();
  await consultationController.updateStatus(reqFor(p, { params: { id }, body: { status, ...body } }), res);
  return out;
}

/** DELETE /consultations/:id as `p`. */
async function del(p: AuthzSubject, id = "c1") {
  const out: { status: number; body: any; sent: boolean } = { status: 0, body: undefined, sent: false };
  const res: any = {
    status: (n: number) => ((out.status = n), res),
    json: (b: unknown) => ((out.body = b), res),
    send: () => ((out.sent = true), res),
  };
  await consultationController.deleteConsultation(reqFor(p, { params: { id } }), res);
  return out;
}

/** The stored status of booking `id`. */
function statusOf(id = "c1"): string | undefined {
  return docsIn("consultations").find(([docId]) => docId === id)?.[1].status;
}

/** A refusal: the error code, nothing written, nobody notified. */
function assertRefused(out: { status: number; body: any }, status: number, code: string, label: string) {
  assert.equal(out.status, status, label);
  assert.equal(out.body.error, code, label);
  assert.equal(out.body.success, false, label);
  assert.deepEqual(writes, [], `${label}: nothing written`);
  assert.deepEqual(notified, [], `${label}: nobody notified`);
}

/** A success as sendSuccess leaves it (no explicit status, or 200). */
function assertOk(out: { status: number; body: any }, label: string) {
  assert.ok(out.status === 0 || out.status === 200, `${label}: ${JSON.stringify(out.body)}`);
  assert.equal(out.body.success, true, label);
}

/** The targets a caller may ask for at all (the other two are always 400). */
const SETTABLE: ConsultationStatus[] = ["confirmed", "in_progress", "completed", "no_show", "cancelled"];

/** The acceptance criteria's table, written out again here (not read from the code under test). */
const AGENT_SIDE_TABLE: Record<string, ConsultationStatus[]> = {
  confirmed: ["scheduled"],
  in_progress: ["scheduled", "confirmed"],
  completed: ["scheduled", "confirmed", "in_progress"],
  no_show: ["scheduled", "confirmed", "in_progress"],
  cancelled: ["pending_payment", "scheduled", "confirmed"],
};
const CLIENT_CANCEL_FROM: ConsultationStatus[] = ["pending_payment", "scheduled", "confirmed"];

// ============================================
// The table, cell by cell
// ============================================

describe("PUT /consultations/:id/status — agent side (agent, agency owner, admin)", () => {
  for (const target of SETTABLE) {
    for (const from of CONSULTATION_STATUSES) {
      const allowed = AGENT_SIDE_TABLE[target].includes(from);
      test(`${from} -> ${target}: ${allowed ? "allowed" : "409 INVALID_STATUS_TRANSITION"}`, async () => {
        for (const p of AGENT_SIDE) {
          harness.reset();
          notified.length = 0;
          await seedBooking(from);
          const out = await setStatus(p, target);
          const label = `${p.uid} ${from} -> ${target}`;
          if (allowed) {
            assertOk(out, label);
            assert.equal(out.body.data.status, target, label);
            assert.equal(statusOf(), target, label);
          } else {
            assertRefused(out, 409, "INVALID_STATUS_TRANSITION", label);
            assert.equal(statusOf(), from, label);
          }
        }
      });
    }
  }
});

describe("PUT /consultations/:id/status — the booking's client", () => {
  for (const from of CONSULTATION_STATUSES) {
    const allowed = CLIENT_CANCEL_FROM.includes(from);
    test(`${from} -> cancelled: ${allowed ? "allowed" : "409 INVALID_STATUS_TRANSITION"}`, async () => {
      await seedBooking(from);
      const out = await setStatus(client, "cancelled");
      if (allowed) {
        assertOk(out, from);
        assert.equal(statusOf(), "cancelled");
      } else {
        assertRefused(out, 409, "INVALID_STATUS_TRANSITION", from);
        assert.equal(statusOf(), from);
      }
    });
  }

  for (const target of SETTABLE.filter((t) => t !== "cancelled")) {
    test(`any status -> ${target}: 403 FORBIDDEN`, async () => {
      for (const from of CONSULTATION_STATUSES) {
        harness.reset();
        await seedBooking(from);
        const out = await setStatus(client, target);
        assertRefused(out, 403, "FORBIDDEN", `${from} -> ${target}`);
        assert.equal(statusOf(), from);
      }
    });
  }
});

// ============================================
// 400 / 404 / non-parties
// ============================================

describe("PUT /consultations/:id/status — validation and non-parties", () => {
  test("pending_payment or scheduled as the target is 400 VALIDATION_ERROR for anyone, from any status", async () => {
    for (const target of ["pending_payment", "scheduled"]) {
      for (const p of [client, ...AGENT_SIDE, ...OUTSIDERS]) {
        for (const from of CONSULTATION_STATUSES) {
          harness.reset();
          await seedBooking(from);
          const out = await setStatus(p, target);
          assertRefused(out, 400, "VALIDATION_ERROR", `${p.uid} ${from} -> ${target}`);
          assert.equal(statusOf(), from);
        }
      }
    }
  });

  test("an unpaid pending_payment booking cannot be marked scheduled or confirmed by either party", async () => {
    await seedBooking("pending_payment");
    assertRefused(await setStatus(client, "scheduled"), 400, "VALIDATION_ERROR", "client scheduled");
    assertRefused(await setStatus(agent, "scheduled"), 400, "VALIDATION_ERROR", "agent scheduled");
    assertRefused(await setStatus(client, "confirmed"), 403, "FORBIDDEN", "client confirmed");
    assertRefused(await setStatus(agent, "confirmed"), 409, "INVALID_STATUS_TRANSITION", "agent confirmed");
    assert.equal(statusOf(), "pending_payment");
  });

  test("a missing or unknown status keeps 400 VALIDATION_ERROR", async () => {
    await seedBooking("scheduled");
    for (const bad of [undefined, "", "done", "CANCELLED", 7, { $ne: "x" }]) {
      const out = await setStatus(admin, bad);
      assertRefused(out, 400, "VALIDATION_ERROR", String(bad));
    }
    assert.equal(statusOf(), "scheduled");
  });

  test("an unknown id keeps 404", async () => {
    await seedBooking("scheduled");
    for (const p of [client, agent, admin]) {
      const out = await setStatus(p, "cancelled", "nope");
      assertRefused(out, 404, "NOT_FOUND", p.uid);
    }
  });

  test("a non-party gets 403 FORBIDDEN for every settable target", async () => {
    for (const p of OUTSIDERS) {
      for (const target of SETTABLE) {
        harness.reset();
        await seedBooking("scheduled");
        const out = await setStatus(p, target);
        assertRefused(out, 403, "FORBIDDEN", `${p.uid} -> ${target}`);
        assert.equal(statusOf(), "scheduled");
      }
    }
  });

  test("an owner with no agency is not the owner of a booking with no agency", async () => {
    await seedBooking("scheduled", { agencyId: undefined });
    const out = await setStatus(ownerNoAgency, "cancelled");
    assertRefused(out, 403, "FORBIDDEN", "owner without agency");
    // The booking's own (independent) agent still can.
    assertOk(await setStatus({ uid: "uid-agent1", role: ROLES.AGENT, agencyId: null }, "confirmed"), "independent agent");
  });
});

// ============================================
// Former agents (issue #321)
// ============================================
//
// `booking.agentId` is never cleared, so a user who is no longer an agent
// (their resolved role is back to `client`) must not keep agent-side rights
// on their old bookings.

describe("PUT /consultations/:id/status — a former agent (#321)", () => {
  /** The booking's `agentId`, whose role has gone back to client. */
  const formerAgent: AuthzSubject = { uid: "uid-agent1", role: ROLES.CLIENT, agencyId: null };
  /** The agent-only targets, each with a status it may be reached from. */
  const AGENT_ONLY: Array<[ConsultationStatus, ConsultationStatus]> = [
    ["confirmed", "scheduled"],
    ["in_progress", "confirmed"],
    ["completed", "in_progress"],
    ["no_show", "confirmed"],
  ];

  test("role client on the booking's agentId: 403 for every agent-only target, nothing written", async () => {
    for (const [target, from] of AGENT_ONLY) {
      harness.reset();
      await seedBooking(from);
      // The same move is allowed for the same uid while they ARE an agent...
      assert.deepEqual(
        decideStatusChange(CONSULTATION_ACTORS.AGENT_SIDE, { status: from }, target, harness.clock.now()),
        { ok: true },
        `${from} -> ${target} is a legal agent-side move`
      );
      // ...and refused once their role is client.
      assertRefused(await setStatus(formerAgent, target), 403, "FORBIDDEN", `former agent ${from} -> ${target}`);
      assert.equal(statusOf(), from);
    }
  });

  test("a former agent cannot cancel their old booking either (they are no party of it)", async () => {
    await seedBooking("scheduled");
    assertRefused(await setStatus(formerAgent, "cancelled"), 403, "FORBIDDEN", "former agent cancel");
    assert.equal(statusOf(), "scheduled");
  });

  test("the same uid with role agent or owner is still agent side", async () => {
    for (const role of [ROLES.AGENT, ROLES.OWNER]) {
      harness.reset();
      await seedBooking("scheduled");
      // No agency on the principal: only `booking.agentId === uid` can match.
      assertOk(await setStatus({ uid: "uid-agent1", role, agencyId: null }, "confirmed"), role);
      assert.equal(statusOf(), "confirmed", role);
    }
  });

  test("a former agent who is also the booking's userId is its CLIENT: may cancel, nothing else", async () => {
    // A booking the former agent holds as a client of themselves (both ids).
    await seedBooking("scheduled", { userId: "uid-agent1" });
    for (const [target] of AGENT_ONLY) {
      assertRefused(await setStatus(formerAgent, target), 403, "FORBIDDEN", `as client -> ${target}`);
    }
    assertOk(await setStatus(formerAgent, "cancelled"), "as client -> cancelled");
    assert.equal(statusOf(), "cancelled");
  });

  test("admins and the owner of the booking's agency are unchanged", async () => {
    for (const p of [admin, ownerA]) {
      harness.reset();
      await seedBooking("scheduled");
      assertOk(await setStatus(p, "confirmed"), p.uid);
      assert.equal(statusOf(), "confirmed", p.uid);
    }
  });
});

// ============================================
// Allowed changes: response, stored fields, notification
// ============================================

describe("PUT /consultations/:id/status — an allowed change", () => {
  test("a client cancel stores who and why, and notifies the agent", async () => {
    await seedBooking("confirmed");
    const out = await setStatus(client, "cancelled", "c1", { cancellationReason: "Travel moved" });
    assertOk(out, "cancel");
    const stored = docsIn("consultations")[0][1];
    assert.equal(stored.status, "cancelled");
    assert.equal(stored.cancelledBy, "uid-client1");
    assert.equal(stored.cancellationReason, "Travel moved");
    assert.ok(stored.cancelledAt instanceof Timestamp);
    assert.equal(out.body.data.id, "c1");
    // (#332) The client is answered with the client view: why and when it
    // was cancelled, not the stored `cancelledBy` user id.
    assert.equal(out.body.data.cancellationReason, "Travel moved");
    assert.equal("cancelledBy" in out.body.data, false);
    assert.deepEqual(notified, [{ userId: "uid-agent1", type: "consultation_cancelled" }]);
  });

  test("agent, owner and admin changes notify the client", async () => {
    for (const p of AGENT_SIDE) {
      harness.reset();
      notified.length = 0;
      await seedBooking("scheduled");
      assertOk(await setStatus(p, "confirmed"), p.uid);
      assert.deepEqual(notified, [{ userId: "uid-client1", type: "consultation_confirmed" }], p.uid);
    }
  });

  test("completing stores the summary; in_progress and no_show send no notification (as before)", async () => {
    await seedBooking("scheduled");
    assertOk(await setStatus(agent, "in_progress"), "in_progress");
    assert.deepEqual(notified, []);
    const out = await setStatus(agent, "completed", "c1", { summary: "Discussed the skilled worker route" });
    assertOk(out, "completed");
    assert.equal(docsIn("consultations")[0][1].summary, "Discussed the skilled worker route");
    assert.deepEqual(notified, [{ userId: "uid-client1", type: "consultation_completed" }]);

    harness.reset();
    notified.length = 0;
    await seedBooking("confirmed");
    assertOk(await setStatus(ownerA, "no_show"), "no_show");
    assert.deepEqual(notified, []);
  });

  test("nothing leaves a terminal status, even for an admin", async () => {
    for (const from of ["completed", "cancelled", "no_show"] as ConsultationStatus[]) {
      for (const target of SETTABLE) {
        harness.reset();
        await seedBooking(from);
        assertRefused(await setStatus(admin, target), 409, "INVALID_STATUS_TRANSITION", `${from} -> ${target}`);
      }
    }
  });
});

// ============================================
// Payment in flight
// ============================================

/** A pending booking with an open checkout whose quote lock ends 30 minutes from "now". */
async function seedInFlight(over: Record<string, unknown> = {}) {
  const now = harness.clock.now().getTime();
  await seedBooking("pending_payment", {
    transactionId: "ref-open", checkoutUrl: "https://checkout.paystack.test/ref-open",
    priceUsdCents: 1_000, chargedCurrency: "NGN", chargedAmountMinor: 1_500_000,
    quoteLockedAt: Timestamp.fromMillis(now), quoteExpiresAt: Timestamp.fromMillis(now + 30 * 60_000),
    ...over,
  });
}

describe("PUT /consultations/:id/status — cancelling while a payment is in flight", () => {
  test("inside the quote lock: 409 PAYMENT_IN_PROGRESS for the client and the agent side", async () => {
    for (const p of [client, ...AGENT_SIDE]) {
      harness.reset();
      await seedInFlight();
      const out = await setStatus(p, "cancelled");
      assertRefused(out, 409, "PAYMENT_IN_PROGRESS", p.uid);
      assert.equal(statusOf(), "pending_payment");
    }
  });

  test("after quoteExpiresAt has passed the cancel is allowed", async () => {
    for (const p of [client, agent]) {
      harness.reset();
      await seedInFlight();
      harness.clock.advanceHours(1); // past the 30-minute lock
      assertOk(await setStatus(p, "cancelled"), p.uid);
      assert.equal(statusOf(), "cancelled");
    }
  });

  test("with no transactionId (no checkout was opened) the cancel is allowed inside the lock", async () => {
    await seedInFlight({ transactionId: undefined, checkoutUrl: undefined });
    assertOk(await setStatus(client, "cancelled"), "no checkout");
    assert.equal(statusOf(), "cancelled");
  });

  test("#321: a failed Paystack start (a transactionId, no checkoutUrl) can be cancelled inside the lock: 200", async () => {
    // The charge path claimed its reference, then Paystack refused to open
    // the checkout: the booking has a reference and a live quote lock, but
    // nobody was ever shown a page to pay on.
    for (const p of [client, agent, ownerA, admin]) {
      harness.reset();
      await seedInFlight({ checkoutUrl: undefined });
      const out = await setStatus(p, "cancelled");
      assertOk(out, p.uid);
      assert.equal(out.status, 200, p.uid);
      assert.equal(statusOf(), "cancelled", p.uid);
    }
  });

  test("a legacy pending booking (a reference, no quote lock) can be cancelled", async () => {
    await seedBooking("pending_payment", { transactionId: "ref-legacy", fee: 50_000 });
    assertOk(await setStatus(agent, "cancelled"), "legacy");
  });

  test("a real booking: refused while its checkout is open, then cancelled; a payment that lands later is recorded for refund", async () => {
    // A guest booking on agency A's page: priced, quote locked, checkout opened.
    await seed("agencies", "agency-a", {
      name: "Acme Visas", slug: "acme", status: "approved", ownerId: "uid-owner-a", ownerName: "Ola Owner",
      services: [], consultationFeeUsd: { amountMinor: 10_000, currency: "USD" }, createdAt: T0,
    });
    const booked = captureRes();
    await consultationController.createPublicConsultation(
      {
        params: { slug: "acme" },
        body: {
          clientName: "Gina Guest", clientEmail: "delivered+guest@resend.dev",
          scheduledDate: "2026-12-01", scheduledTime: "10:00",
        },
      } as any,
      booked.res
    );
    assert.equal(booked.out.status, 201, JSON.stringify(booked.out.body));
    const id: string = booked.out.body.data.consultationId;
    const reference: string = booked.out.body.data.reference;
    writes.length = 0;
    notified.length = 0;

    // The agency's owner cannot cancel while the checkout can still be paid.
    assertRefused(await setStatus(ownerA, "cancelled", id), 409, "PAYMENT_IN_PROGRESS", "open checkout");

    // After the lock they can.
    harness.clock.advanceHours(1);
    assertOk(await setStatus(ownerA, "cancelled", id), "after the lock");
    assert.equal(statusOf(id), "cancelled");

    // The guest pays the old checkout anyway: held for refund, never a Transaction.
    paystackPaid(reference, id, { amountMinor: 15_000_000, currency: "NGN" });
    const verified = captureRes();
    await consultationController.verifyPublicConsultation({ body: { reference } } as any, verified.res);
    assert.equal(verified.out.status, 409);
    assert.equal(verified.out.body.error, "BOOKING_NOT_PAYABLE");
    // Issue #354: never a fee Transaction; the automatic refund row only.
    assert.equal(docsIn("transactions").filter(([, t]) => t.type !== "refund").length, 0);
    const exceptions = docsIn("consultationPaymentExceptions");
    assert.equal(exceptions.length, 1);
    assert.equal(exceptions[0][1].reason, "booking_not_payable");
    assert.equal(exceptions[0][1].consultationId, id);
    assert.equal(statusOf(id), "cancelled");
  });
});

// ============================================
// The helper itself (reused by the PUT /consultations/:id follow-up)
// ============================================

describe("decideStatusChange", () => {
  test("the stored table is exactly the acceptance criteria's", () => {
    assert.deepEqual(STATUS_TRANSITIONS[CONSULTATION_ACTORS.AGENT_SIDE], AGENT_SIDE_TABLE);
    assert.deepEqual(STATUS_TRANSITIONS[CONSULTATION_ACTORS.CLIENT], { cancelled: CLIENT_CANCEL_FROM });
  });

  test("order of the answers: 400 before 403 before 409", () => {
    const at = new Date("2026-11-13T09:00:00Z");
    const booking = { status: "completed" as ConsultationStatus };
    // A system-only target is 400 even for a non-party.
    assert.equal((decideStatusChange(null, booking, "scheduled", at) as any).code, "VALIDATION_ERROR");
    // A non-party is 403 before the transition is looked at.
    assert.equal((decideStatusChange(null, booking, "cancelled", at) as any).code, "FORBIDDEN");
    // A client asking for a target it may never set is 403, whatever the status.
    assert.equal((decideStatusChange(CONSULTATION_ACTORS.CLIENT, booking, "completed", at) as any).code, "FORBIDDEN");
    // A target the party may set, from the wrong status, is 409.
    assert.equal(
      (decideStatusChange(CONSULTATION_ACTORS.CLIENT, booking, "cancelled", at) as any).code,
      "INVALID_STATUS_TRANSITION"
    );
  });

  test("the in-flight rule is exact at the lock boundary", () => {
    const expires = Timestamp.fromDate(new Date("2026-11-13T09:30:00Z"));
    const booking = {
      status: "pending_payment" as ConsultationStatus, transactionId: "ref",
      // Issue #321: in flight needs a checkout that was really opened.
      checkoutUrl: "https://checkout.paystack.test/ref", quoteExpiresAt: expires,
    };
    const at = (iso: string) => decideStatusChange(CONSULTATION_ACTORS.CLIENT, booking, "cancelled", new Date(iso));
    assert.equal((at("2026-11-13T09:29:59Z") as any).code, "PAYMENT_IN_PROGRESS");
    assert.equal((at("2026-11-13T09:30:00Z") as any).code, "PAYMENT_IN_PROGRESS");
    assert.deepEqual(at("2026-11-13T09:30:01Z"), { ok: true });
  });

  test("#321: a reference with no checkoutUrl is not in flight, even inside the lock", () => {
    const expires = Timestamp.fromDate(new Date("2026-11-13T09:30:00Z"));
    const booking = { status: "pending_payment" as ConsultationStatus, transactionId: "ref", quoteExpiresAt: expires };
    const inside = new Date("2026-11-13T09:10:00Z");
    assert.equal(isPaymentInFlight(booking, inside), false);
    assert.equal(isPaymentInFlight({ ...booking, checkoutUrl: "" }, inside), false);
    assert.equal(isPaymentInFlight({ ...booking, checkoutUrl: "https://checkout.paystack.test/ref" }, inside), true);
    for (const actor of [CONSULTATION_ACTORS.CLIENT, CONSULTATION_ACTORS.AGENT_SIDE]) {
      assert.deepEqual(decideStatusChange(actor, booking, "cancelled", inside), { ok: true }, actor);
    }
  });
});

// ============================================
// DELETE
// ============================================

describe("DELETE /consultations/:id", () => {
  test("the client, the agent, the agency owner and non-parties get 403; nothing removed, nobody notified", async () => {
    for (const p of [client, agent, ownerA, ...OUTSIDERS]) {
      harness.reset();
      await seedBooking("scheduled", { paymentStatus: "pending" });
      const out = await del(p);
      assertRefused(out, 403, "FORBIDDEN", p.uid);
      assert.equal(docsIn("consultations").length, 1, p.uid);
    }
  });

  test("a non-admin gets 403 for an unknown id too (no hint about which ids exist)", async () => {
    const out = await del(agent, "nope");
    assertRefused(out, 403, "FORBIDDEN", "unknown id");
  });

  test("an admin deletes a booking with no payment: 204, the client is told", async () => {
    for (const status of ["pending_payment", "cancelled"] as ConsultationStatus[]) {
      harness.reset();
      notified.length = 0;
      await seedBooking(status, { paymentStatus: "pending" });
      const out = await del(admin);
      assert.equal(out.status, 204, status);
      assert.equal(out.sent, true, status);
      assert.equal(docsIn("consultations").length, 0, status);
      assert.deepEqual(notified, [{ userId: "uid-client1", type: "consultation_cancelled" }], status);
    }
  });

  test("an admin cannot delete a booking with a transactionId: 409 BOOKING_HAS_PAYMENT", async () => {
    // An open checkout, an expired one, and a cancelled booking that had one.
    const cases: Array<[ConsultationStatus, Record<string, unknown>]> = [
      ["pending_payment", { transactionId: "ref-1" }],
      ["cancelled", { transactionId: "ref-1", paymentStatus: "pending" }],
      ["scheduled", { transactionId: "ref-1", paymentStatus: "paid" }],
    ];
    for (const [status, over] of cases) {
      harness.reset();
      await seedBooking(status, over);
      const out = await del(admin);
      assertRefused(out, 409, "BOOKING_HAS_PAYMENT", status);
      assert.equal(docsIn("consultations").length, 1, status);
    }
  });

  test("an admin cannot delete a booking paid a non-zero charge, even with no reference", async () => {
    // A dollar price, a local charge, or a legacy naira fee: each is money.
    const charges: Array<Record<string, unknown>> = [
      { priceUsdCents: 1_000 },
      { priceUsdCents: undefined, chargedAmountMinor: 1_500_000, chargedCurrency: "NGN" },
      { priceUsdCents: undefined, fee: 50_000 },
    ];
    for (const charge of charges) {
      harness.reset();
      await seedBooking("completed", { paymentStatus: "paid", ...charge });
      const out = await del(admin);
      assertRefused(out, 409, "BOOKING_HAS_PAYMENT", JSON.stringify(charge));
      assert.equal(docsIn("consultations").length, 1);
    }
  });

  test("an admin CAN delete a free booking ($0, marked paid, no transaction)", async () => {
    // Exactly what a free booking is stored as at creation.
    for (const status of ["scheduled", "completed"] as ConsultationStatus[]) {
      harness.reset();
      notified.length = 0;
      await seedBooking(status, { paymentStatus: "paid", priceUsdCents: 0 });
      const out = await del(admin);
      assert.equal(out.status, 204, status);
      assert.equal(docsIn("consultations").length, 0, status);
      assert.deepEqual(notified, [{ userId: "uid-client1", type: "consultation_cancelled" }], status);
    }
  });

  test("a free booking is still not deletable by its client, agent or agency owner", async () => {
    for (const p of [client, agent, ownerA]) {
      harness.reset();
      await seedBooking("scheduled", { paymentStatus: "paid", priceUsdCents: 0 });
      assertRefused(await del(p), 403, "FORBIDDEN", p.uid);
      assert.equal(docsIn("consultations").length, 1, p.uid);
    }
  });

  test("an unknown id is 404 for an admin", async () => {
    const out = await del(admin, "nope");
    assertRefused(out, 404, "NOT_FOUND", "unknown id");
  });
});
