// ============================================
// Unit tests — resume a pending booking on create (issue #288)
// ============================================
//
// Hermetic, same harness as the other consultation suites: in-memory
// Firestore (transactions run one at a time, like Firestore's serializable
// ones), an in-memory rate service, Paystack stubbed. No real charge, no
// network.
//
// What is covered, by acceptance criterion:
//  - RESUME (client flow of POST /consultations): a second create for the
//    same agent, day and time writes NO new booking and answers 200 with
//    `resumed: true` in the create shape: the same checkout inside the quote
//    lock, a re-priced one after it, settled when Paystack says it was paid;
//  - Paystack in progress: 409 PAYMENT_IN_PROGRESS with the booking, nothing
//    written or re-priced;
//  - several old pending bookings of one slot: the newest is resumed;
//  - a paid, free, cancelled or legacy booking of the slot is NOT resumed;
//  - the monthly limit: a resume does not count, a new booking does;
//  - `returnTo: "app"` applies to a new checkout a resume issues;
//  - the agent flow and the guest route never resume;
//  - THE RACE: two parallel creates leave exactly one booking and one
//    Paystack checkout;
//  - every 409 CHECKOUT_OPENING carries `data.consultation.id` (fresh create,
//    resumed create, POST /:id/checkout);
//  - `scheduledTime` is normalised to `HH:mm` on create, on the signed-in and
//    the guest path (add-on from #316).
import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";

import {
  useHarness,
  harness,
  captureRes,
  docsIn,
  seed,
  setRate,
  paystackPaid,
  paystackAbandoned,
  paystackStatus,
  T0,
} from "./harness";
import { fakeCollection } from "../helpers/fake-firestore";
import { consultationController } from "../../src/controllers/consultation.controller";
import {
  consultationService,
  bookingLockId,
  isResumableForSlot,
  pickResumableBooking,
} from "../../src/services/consultation.service";
import { LIMITS } from "@durin-tech/authz";

/* eslint-disable @typescript-eslint/no-explicit-any */

before(async () => {
  await useHarness();
});
beforeEach(() => {
  harness.reset();
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  console.log = () => {};
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  console.error = () => {};
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  console.warn = () => {};
});

// ============================================
// Fixtures
// ============================================

/** $10.00 at ₦1,500/$ = 1,500,000 kobo (the agent's fee, in the client's naira). */
const AGENT_FEE_KOBO = 1_500_000;
/** The slot every test books unless it says otherwise. */
const SLOT = { type: "initial", scheduledDate: "2026-12-01", scheduledTime: "10:00", agentId: "agent1" };

/** A client and a verified, available agent with a $10 fee (`agent1`, user `uid-agent1`). */
async function seedPair(): Promise<void> {
  await seed("users", "uid-client1", {
    email: "delivered+client1@resend.dev", firstName: "Chi", lastName: "Client", createdAt: T0,
  });
  await seed("agents", "agent1", {
    userId: "uid-agent1", displayName: "Ada Agent", verificationStatus: "verified", isAvailable: true,
    consultationFeeUsd: { amountMinor: 1_000, currency: "USD" }, createdAt: T0,
  });
}

/** POST /consultations as the signed-in client. `req` adds request fields (e.g. `entitlements`). */
async function create(body: Record<string, unknown> = {}, req: Record<string, unknown> = {}) {
  const { out, res } = captureRes();
  await consultationController.createConsultation(
    { userId: "uid-client1", body: { ...SLOT, ...body }, ...req } as any,
    res
  );
  return out;
}

/** POST /consultations/:id/checkout as the booking's client. */
async function checkout(id: string) {
  const { out, res } = captureRes();
  await consultationController.checkoutConsultation({ params: { id }, userId: "uid-client1" } as any, res);
  return out;
}

/** The stored bookings, as plain data. */
function bookings(): Record<string, any>[] {
  return docsIn("consultations").map(([, data]) => data);
}

/** A stored booking by id. */
function booking(id: string): Record<string, any> {
  const found = docsIn("consultations").find(([docId]) => docId === id);
  assert.ok(found, `booking ${id} exists`);
  return found[1];
}

/**
 * Seed a `pending_payment` booking of the default slot directly (a row made
 * before this issue, or one in a state a request cannot produce on demand).
 */
async function seedPending(id: string, overrides: Record<string, unknown> = {}): Promise<void> {
  const now = harness.clock.now();
  await seed("consultations", id, {
    userId: "uid-client1", agentId: "uid-agent1", bookedVia: "client",
    clientName: "Chi Client", clientEmail: "delivered+client1@resend.dev", agentName: "Ada Agent",
    type: "initial", scheduledDate: Timestamp.fromDate(new Date("2026-12-01")), scheduledTime: "10:00",
    durationMinutes: 30, timezone: "Africa/Lagos",
    status: "pending_payment", paymentStatus: "pending",
    // The #180 snapshot: $10 charged as ₦15,000, locked for 30 minutes from "now".
    priceUsdCents: 1_000, chargedCurrency: "NGN", chargedAmountMinor: AGENT_FEE_KOBO,
    fxRate: 1500, fxRateAsOf: Timestamp.fromDate(now), fxRateSource: "cbn", fxMarginBps: 0,
    quoteLockedAt: Timestamp.fromDate(now),
    quoteExpiresAt: Timestamp.fromMillis(now.getTime() + 30 * 60_000),
    createdAt: Timestamp.fromDate(now), updatedAt: Timestamp.fromDate(now),
    ...overrides,
  });
}

// ============================================
// Resume: the same slot again
// ============================================

describe("POST /consultations resumes the client's pending booking of the same slot", () => {
  beforeEach(seedPair);

  test("inside the quote lock: 200, resumed, the SAME booking and checkout, nothing new written", async () => {
    const first = await create();
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(first.body.data.resumed, undefined, "a fresh create is not marked resumed");

    const again = await create();
    assert.equal(again.status, 200, JSON.stringify(again.body));
    const data = again.body.data;
    assert.equal(data.resumed, true);
    // The create shape: the booking's own fields at the top level.
    assert.equal(data.id, first.body.data.id);
    assert.equal(data.status, "pending_payment");
    assert.equal(data.scheduledTime, "10:00");
    assert.equal(data.agentName, "Ada Agent");
    assert.equal(data.requiresPayment, true);
    assert.equal(data.authorizationUrl, first.body.data.authorizationUrl);
    assert.equal(data.reference, first.body.data.reference);
    assert.equal(data.transactionId, first.body.data.reference);
    assert.equal(data.checkoutUrl, first.body.data.authorizationUrl);

    assert.equal(bookings().length, 1, "no second booking");
    assert.equal(harness.charges.length, 1, "no second Paystack checkout");
  });

  test("after the quote lock: 200, resumed, the same booking with a FRESH quote and a new checkout", async () => {
    const first = await create();
    harness.clock.advanceHours(1); // past the 30-minute lock
    setRate("NGN", 1600); // the naira moved
    paystackAbandoned(first.body.data.reference, first.body.data.id);

    const again = await create();
    assert.equal(again.status, 200, JSON.stringify(again.body));
    const data = again.body.data;
    assert.equal(data.resumed, true);
    assert.equal(data.id, first.body.data.id);
    assert.equal(data.requiresPayment, true);
    assert.notEqual(data.reference, first.body.data.reference, "a new checkout");
    assert.equal(data.chargedAmountMinor, 1_600_000, "re-priced at the new rate");

    assert.equal(bookings().length, 1);
    const stored = booking(data.id);
    assert.equal(stored.transactionId, data.reference);
    assert.equal(stored.checkoutUrl, data.authorizationUrl);
    // The replaced checkout is remembered with its own price.
    assert.deepEqual(stored.supersededCheckouts.map((s: any) => s.reference), [first.body.data.reference]);
    assert.equal(harness.charges.length, 2);
    assert.equal(harness.charges[1].amount.amountMinor, 1_600_000);
  });

  test("Paystack says the checkout was paid: settled, 200 resumed with requiresPayment false", async () => {
    const first = await create();
    const { id, reference } = first.body.data;
    paystackPaid(reference, id, { amountMinor: AGENT_FEE_KOBO, currency: "NGN" });

    const again = await create();
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.data.resumed, true);
    assert.equal(again.body.data.id, id);
    assert.equal(again.body.data.requiresPayment, false);
    assert.equal(again.body.data.status, "scheduled");
    assert.equal(again.body.data.paymentStatus, "paid");

    assert.equal(bookings().length, 1);
    assert.equal(booking(id).paymentStatus, "paid");
    assert.equal(docsIn("transactions").length, 1, "the fee Transaction was written once");
    assert.equal(harness.charges.length, 1, "never re-charged");
  });

  test("Paystack reports the checkout in progress: 409 PAYMENT_IN_PROGRESS with the booking, nothing written", async () => {
    const first = await create();
    const { id, reference, authorizationUrl } = first.body.data;
    harness.clock.advanceHours(1); // even past the lock: never re-priced under a live payment
    paystackStatus(reference, id, "ongoing");
    const before = JSON.stringify(booking(id));

    const again = await create();
    assert.equal(again.status, 409);
    assert.equal(again.body.error, "PAYMENT_IN_PROGRESS");
    assert.match(again.body.message, /^A payment for this booking is still being processed/);
    assert.equal(again.body.data.authorizationUrl, authorizationUrl);
    assert.equal(again.body.data.reference, reference);
    assert.equal(again.body.data.consultation.id, id);

    assert.equal(JSON.stringify(booking(id)), before, "the booking is untouched");
    assert.equal(bookings().length, 1);
    assert.equal(harness.charges.length, 1, "nothing re-priced");
  });

  test("several old pending bookings of the slot: the NEWEST by createdAt is resumed, the others are left", async () => {
    const now = harness.clock.now().getTime();
    // Three unpaid rows from before this change (no checkout was ever claimed).
    await seedPending("old-1", { createdAt: Timestamp.fromMillis(now - 3_000) });
    await seedPending("newest", { createdAt: Timestamp.fromMillis(now - 1_000) });
    await seedPending("old-2", { createdAt: Timestamp.fromMillis(now - 2_000) });
    const untouched = { a: JSON.stringify(booking("old-1")), b: JSON.stringify(booking("old-2")) };

    const out = await create();
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.body.data.resumed, true);
    assert.equal(out.body.data.id, "newest");
    assert.equal(out.body.data.requiresPayment, true);

    assert.equal(bookings().length, 3, "no fourth booking");
    assert.equal(JSON.stringify(booking("old-1")), untouched.a);
    assert.equal(JSON.stringify(booking("old-2")), untouched.b);
    assert.equal(booking("newest").transactionId, out.body.data.reference);
  });

  test("a stored time from before normalisation ('10:00 AM') is matched by '10:00'", async () => {
    await seedPending("old-format", { scheduledTime: "10:00 AM" });
    const out = await create();
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.body.data.id, "old-format");
    assert.equal(bookings().length, 1);
  });

  test("'10:00 AM' in the request resumes the booking stored as '10:00'", async () => {
    const first = await create();
    const again = await create({ scheduledTime: "10:00 AM" });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.data.id, first.body.data.id);
    assert.equal(bookings().length, 1);
  });

  test("the same day sent in another form (same instant) is the same slot", async () => {
    const first = await create();
    const again = await create({ scheduledDate: "2026-12-01T00:00:00.000Z" });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.data.id, first.body.data.id);
    assert.equal(bookings().length, 1);
  });

  test("returnTo: 'app' on a resume applies to the NEW checkout it issues, not to one still live", async () => {
    // The app return URL is built from the project id.
    const saved = { g: process.env.GCLOUD_PROJECT, a: process.env.API_PUBLIC_URL, f: process.env.FUNCTIONS_EMULATOR };
    delete process.env.API_PUBLIC_URL;
    delete process.env.FUNCTIONS_EMULATOR;
    process.env.GCLOUD_PROJECT = "japa-platform";
    try {
      const first = await create(); // web return page
      const webReturn = harness.charges[0].callbackUrl;

      // Inside the lock: the same checkout comes back, its return URL stays.
      const inside = await create({ returnTo: "app" });
      assert.equal(inside.status, 200);
      assert.equal(inside.body.data.reference, first.body.data.reference);
      assert.equal(booking(first.body.data.id).checkoutCallbackUrl, webReturn);

      // After the lock: the new checkout returns to the app.
      harness.clock.advanceHours(1);
      setRate("NGN", 1500);
      const after = await create({ returnTo: "app" });
      assert.equal(after.status, 200, JSON.stringify(after.body));
      assert.equal(harness.charges.length, 2);
      assert.match(harness.charges[1].callbackUrl!, /\/api\/payments\/return$/);
      assert.equal(booking(first.body.data.id).checkoutCallbackUrl, harness.charges[1].callbackUrl);

      // A bad value is still a 400 before anything happens.
      const bad = await create({ returnTo: "web" });
      assert.equal(bad.status, 400);
    } finally {
      for (const [key, value] of [["GCLOUD_PROJECT", saved.g], ["API_PUBLIC_URL", saved.a], ["FUNCTIONS_EMULATOR", saved.f]] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

// ============================================
// Not resumed: create behaves as before
// ============================================

describe("POST /consultations still creates when there is nothing to resume", () => {
  beforeEach(seedPair);

  test("a different time, day or agent is a different slot: 201 each", async () => {
    await seed("agents", "agent2", {
      userId: "uid-agent2", displayName: "Bola Agent", verificationStatus: "verified", isAvailable: true,
      consultationFeeUsd: { amountMinor: 1_000, currency: "USD" }, createdAt: T0,
    });
    const first = await create();
    const otherTime = await create({ scheduledTime: "11:00" });
    const otherDay = await create({ scheduledDate: "2026-12-02" });
    const otherAgent = await create({ agentId: "agent2" });
    for (const out of [first, otherTime, otherDay, otherAgent]) {
      assert.equal(out.status, 201, JSON.stringify(out.body));
      assert.equal(out.body.data.resumed, undefined);
    }
    assert.equal(bookings().length, 4);
  });

  test("another client's pending booking of the slot is never resumed", async () => {
    await seedPending("theirs", { userId: "uid-someone-else" });
    const out = await create();
    assert.equal(out.status, 201, JSON.stringify(out.body));
    assert.notEqual(out.body.data.id, "theirs");
    assert.equal(bookings().length, 2);
  });

  for (const [label, overrides] of [
    ["scheduled (paid)", { status: "scheduled", paymentStatus: "paid", transactionId: "ref-paid", paidAt: T0 }],
    ["confirmed (paid)", { status: "confirmed", paymentStatus: "paid", transactionId: "ref-paid", paidAt: T0 }],
    ["scheduled (free)", { status: "scheduled", paymentStatus: "paid", priceUsdCents: 0, chargedAmountMinor: undefined }],
    ["cancelled", { status: "cancelled", cancelledAt: T0 }],
  ] as const) {
    test(`a ${label} booking of the slot is not resumed: a new booking is created`, async () => {
      // Firestore refuses undefined: drop the keys a variant clears.
      const clean = Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined));
      await seedPending("earlier", clean);
      const before = JSON.stringify(booking("earlier"));

      const out = await create();
      assert.equal(out.status, 201, JSON.stringify(out.body));
      assert.equal(out.body.data.resumed, undefined);
      assert.notEqual(out.body.data.id, "earlier");
      assert.equal(out.body.data.requiresPayment, true);
      assert.equal(bookings().length, 2);
      assert.equal(JSON.stringify(booking("earlier")), before, "the earlier booking is untouched");
    });
  }

  test("a legacy pending row (naira fee, no charge snapshot) is not resumed", async () => {
    await seed("consultations", "legacy", {
      userId: "uid-client1", agentId: "uid-agent1", clientName: "Chi Client",
      clientEmail: "delivered+client1@resend.dev", agentName: "Ada Agent", type: "initial",
      scheduledDate: Timestamp.fromDate(new Date("2026-12-01")), scheduledTime: "10:00",
      durationMinutes: 30, timezone: "Africa/Lagos", status: "pending_payment", paymentStatus: "pending",
      fee: 25_000, createdAt: T0, updatedAt: T0,
    });
    const out = await create();
    assert.equal(out.status, 201, JSON.stringify(out.body));
    assert.notEqual(out.body.data.id, "legacy");
    assert.equal(bookings().length, 2);
  });

  test("a free agent: every create is its own booking (a free booking is never pending)", async () => {
    await seed("agents", "agent-free", {
      userId: "uid-agent-free", displayName: "Free Agent", verificationStatus: "verified", isAvailable: true, createdAt: T0,
    });
    const a = await create({ agentId: "agent-free" });
    const b = await create({ agentId: "agent-free" });
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    assert.equal(b.body.data.requiresPayment, false);
    assert.equal(bookings().length, 2);
    assert.equal(harness.charges.length, 0);
  });
});

// ============================================
// The monthly limit
// ============================================

describe("POST /consultations monthly limit and resume", () => {
  beforeEach(seedPair);

  /** A plan that allows ONE consultation a month. */
  const oneAMonth = {
    entitlements: { status: "active", features: [], limits: { [LIMITS.MAX_CONSULTATIONS_PER_MONTH]: 1 } },
  };

  test("a resume is not a new booking: it passes at the limit; a NEW booking is refused", async () => {
    const first = await create({}, oneAMonth);
    assert.equal(first.status, 201, JSON.stringify(first.body));

    // At the limit now. The same slot again resumes (200), it does not count.
    const again = await create({}, oneAMonth);
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.data.resumed, true);
    assert.equal(again.body.data.id, first.body.data.id);

    // A different slot would be a second booking this month: refused.
    const other = await create({ scheduledTime: "11:00" }, oneAMonth);
    assert.equal(other.status, 402, JSON.stringify(other.body));

    assert.equal(bookings().length, 1);
    assert.equal(harness.charges.length, 1);
  });

  test("a resume also works when no rate can price a new booking (inside the lock)", async () => {
    const first = await create();
    harness.rateStore.docs.delete("NGN"); // pricing a NEW booking would be 503
    const again = await create();
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.data.reference, first.body.data.reference);
  });
});

// ============================================
// The race: two creates at once
// ============================================

describe("POST /consultations find-or-create is one transaction", () => {
  beforeEach(seedPair);

  test("two parallel creates for the same slot leave exactly ONE booking and ONE checkout", async () => {
    const [a, b] = await Promise.all([create(), create()]);
    assert.deepEqual([a.status, b.status].sort(), [200, 201], JSON.stringify([a.body, b.body]));

    const created = a.status === 201 ? a : b;
    const resumed = a.status === 201 ? b : a;
    assert.equal(resumed.body.data.resumed, true);
    assert.equal(created.body.data.resumed, undefined);
    // Both callers hold the same booking and the same checkout.
    assert.equal(resumed.body.data.id, created.body.data.id);
    assert.equal(resumed.body.data.reference, created.body.data.reference);
    assert.equal(resumed.body.data.authorizationUrl, created.body.data.authorizationUrl);

    assert.equal(bookings().length, 1, "exactly one booking");
    assert.equal(harness.charges.length, 1, "exactly one Paystack checkout");
    assert.equal(booking(created.body.data.id).transactionId, created.body.data.reference);
  });

  test("five parallel creates still leave one booking and one checkout", async () => {
    const outs = await Promise.all([create(), create(), create(), create(), create()]);
    assert.equal(outs.filter((o) => o.status === 201).length, 1, JSON.stringify(outs.map((o) => o.status)));
    assert.equal(outs.filter((o) => o.status === 200).length, 4);
    assert.equal(new Set(outs.map((o) => o.body.data.id)).size, 1);
    assert.equal(new Set(outs.map((o) => o.body.data.reference)).size, 1);
    assert.equal(bookings().length, 1);
    assert.equal(harness.charges.length, 1);
  });

  test("createOrResumePendingBooking: the second call for a slot returns the first call's booking", async () => {
    const data: any = {
      userId: "uid-client1", agentId: "uid-agent1", bookedVia: "client", clientName: "Chi Client",
      clientEmail: "delivered+client1@resend.dev", agentName: "Ada Agent", type: "initial",
      scheduledDate: Timestamp.fromDate(new Date("2026-12-01")), scheduledTime: "10:00",
      durationMinutes: 30, timezone: "Africa/Lagos", status: "pending_payment", paymentStatus: "pending",
      priceUsdCents: 1_000, chargedCurrency: "NGN", chargedAmountMinor: AGENT_FEE_KOBO,
    };
    const [x, y] = await Promise.all([
      consultationService.createOrResumePendingBooking(data),
      consultationService.createOrResumePendingBooking(data),
    ]);
    assert.deepEqual([x.kind, y.kind].sort(), ["created", "existing"]);
    assert.equal(x.consultation.id, y.consultation.id);
    assert.equal(bookings().length, 1);
  });
});

describe("the per-pair booking lock (consultationBookingLocks)", () => {
  beforeEach(seedPair);

  test("a create writes the pair's lock in the same commit; a resume writes nothing", async () => {
    const first = await create();
    const lockId = bookingLockId("uid-client1", "uid-agent1");
    let locks = docsIn("consultationBookingLocks");
    assert.equal(locks.length, 1);
    assert.equal(locks[0][0], lockId);
    assert.equal(locks[0][1].userId, "uid-client1");
    assert.equal(locks[0][1].agentId, "uid-agent1");
    assert.equal(locks[0][1].lastConsultationId, first.body.data.id);
    assert.equal(locks[0][1].bookingCount, 1);

    // A resume: the lock is read, never written.
    const before = JSON.stringify(locks[0][1]);
    await create();
    locks = docsIn("consultationBookingLocks");
    assert.equal(JSON.stringify(locks[0][1]), before);

    // Another slot of the same pair: the same lock document, counted up.
    const other = await create({ scheduledTime: "11:00" });
    locks = docsIn("consultationBookingLocks");
    assert.equal(locks.length, 1);
    assert.equal(locks[0][1].bookingCount, 2);
    assert.equal(locks[0][1].lastConsultationId, other.body.data.id);
  });

  test("free bookings, the agent flow and the guest route take no lock", async () => {
    await seed("agents", "agent-free", {
      userId: "uid-agent-free", displayName: "Free Agent", verificationStatus: "verified", isAvailable: true, createdAt: T0,
    });
    await create({ agentId: "agent-free" });
    assert.equal(docsIn("consultationBookingLocks").length, 0);
  });

  test("bookingLockId is a stable, document-safe id that differs per pair", () => {
    const id = bookingLockId("uid-client1", "uid-agent1");
    assert.match(id, /^[0-9a-f]{64}$/);
    assert.equal(bookingLockId("uid-client1", "uid-agent1"), id);
    assert.notEqual(bookingLockId("uid-agent1", "uid-client1"), id);
    // The separator keeps ("ab","c") and ("a","bc") apart.
    assert.notEqual(bookingLockId("ab", "c"), bookingLockId("a", "bc"));
    // Characters Firestore refuses in an id never reach it.
    assert.match(bookingLockId("a/b", ".."), /^[0-9a-f]{64}$/);
  });
});

// ============================================
// The agent flow and the guest route are unchanged
// ============================================

describe("resume applies to the client flow only", () => {
  beforeEach(seedPair);

  test("the agent flow never resumes: the same slot twice is two bookings", async () => {
    // The caller is agent1's user; the client already works with them (#246).
    await seed("applications", "app1", { userId: "uid-client1", agentId: "uid-agent1", createdAt: T0 });
    const asAgent = async () => {
      const { out, res } = captureRes();
      await consultationController.createConsultation(
        {
          userId: "uid-agent1",
          body: { userId: "uid-client1", type: "initial", scheduledDate: "2026-12-01", scheduledTime: "10:00 AM" },
        } as any,
        res
      );
      return out;
    };
    const a = await asAgent();
    const b = await asAgent();
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.equal(b.status, 201, JSON.stringify(b.body));
    assert.equal(b.body.data.resumed, undefined);
    assert.notEqual(a.body.data.id, b.body.data.id);
    assert.equal(bookings().length, 2);
    // The time is normalised on this flow too.
    assert.deepEqual(bookings().map((x) => x.scheduledTime), ["10:00", "10:00"]);
  });

  test("the guest route never resumes: the same guest and slot twice is two bookings", async () => {
    await seed("agencies", "ag1", {
      name: "Acme Visas", slug: "acme", status: "approved", ownerId: "owner-ag1", ownerName: "Ola Owner",
      services: [], consultationFeeUsd: { amountMinor: 10_000, currency: "USD" }, createdAt: T0,
    });
    const asGuest = async (scheduledTime: string) => {
      const { out, res } = captureRes();
      await consultationController.createPublicConsultation(
        {
          params: { slug: "acme" },
          body: {
            clientName: "Gina Guest", clientEmail: "delivered+guest@resend.dev",
            scheduledDate: "2026-12-01", scheduledTime,
          },
        } as any,
        res
      );
      return out;
    };
    const a = await asGuest("14:30");
    const b = await asGuest("2:30 PM");
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.equal(b.status, 201, JSON.stringify(b.body));
    assert.notEqual(a.body.data.consultationId, b.body.data.consultationId);
    assert.equal(bookings().length, 2);
    // Both forms are stored as 24-hour HH:mm.
    assert.deepEqual(bookings().map((x) => x.scheduledTime), ["14:30", "14:30"]);

    // Neither form: 400, and nothing more is written (no booking, no account).
    const usersBefore = docsIn("users").length;
    const bad = await asGuest("half past two");
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, "VALIDATION_ERROR");
    assert.equal(bookings().length, 2);
    assert.equal(docsIn("users").length, usersBefore);
  });
});

// ============================================
// scheduledTime / scheduledDate on create
// ============================================

describe("POST /consultations normalises scheduledTime", () => {
  beforeEach(seedPair);

  for (const [sent, stored] of [
    ["10:00", "10:00"], ["9:30 AM", "09:30"], ["12:00 AM", "00:00"], ["12:30 PM", "12:30"], ["2:30 pm", "14:30"],
  ] as const) {
    test(`'${sent}' is stored as '${stored}'`, async () => {
      const out = await create({ scheduledTime: sent });
      assert.equal(out.status, 201, JSON.stringify(out.body));
      assert.equal(out.body.data.scheduledTime, stored);
      assert.equal(booking(out.body.data.id).scheduledTime, stored);
    });
  }

  for (const bad of ["9:30", "25:00", "13:00 PM", "2pm", "soon", 1000]) {
    test(`a scheduledTime of ${JSON.stringify(bad)} is 400 and nothing is written`, async () => {
      const out = await create({ scheduledTime: bad });
      assert.equal(out.status, 400);
      assert.equal(out.body.error, "VALIDATION_ERROR");
      assert.equal(bookings().length, 0);
      assert.equal(harness.charges.length, 0);
    });
  }

  test("a scheduledDate that is not a date is 400 (it used to be a 500)", async () => {
    const out = await create({ scheduledDate: "not-a-date" });
    assert.equal(out.status, 400);
    assert.equal(out.body.error, "VALIDATION_ERROR");
    assert.equal(bookings().length, 0);
  });
});

// ============================================
// 409 CHECKOUT_OPENING names the booking
// ============================================

describe("every 409 CHECKOUT_OPENING carries data.consultation.id", () => {
  beforeEach(seedPair);

  /** Assert the CHECKOUT_OPENING body for booking `id`. */
  function assertOpening(out: { status: number; body: any }, id: string): void {
    assert.equal(out.status, 409, JSON.stringify(out.body));
    assert.equal(out.body.success, false);
    assert.equal(out.body.error, "CHECKOUT_OPENING");
    assert.equal(out.body.message, "Your checkout is being prepared. Please try again in a moment.");
    assert.equal(out.body.data.consultation.id, id);
    // The payer-safe summary, not the raw booking.
    assert.equal(out.body.data.consultation.status, "pending_payment");
    assert.equal(out.body.data.consultation.userId, undefined);
    assert.equal(out.body.data.consultation.transactionId, undefined);
  }

  /**
   * Make the next Paystack lookup happen "while" another request is opening
   * a checkout for the booking: that request has claimed its own reference
   * and not published a URL yet. The caller's re-price then loses the claim
   * and finds no checkout to hand out.
   */
  function anotherRequestIsOpening(id: string): void {
    harness.onLookup = async () => {
      harness.onLookup = undefined;
      await fakeCollection("consultations").doc(id).update({ transactionId: "cons-claimed-by-another-request", checkoutUrl: null });
      return undefined;
    };
  }

  test("POST /consultations/:id/checkout", async () => {
    const first = await create();
    const { id, reference } = first.body.data;
    harness.clock.advanceHours(1);
    paystackAbandoned(reference, id);
    anotherRequestIsOpening(id);
    assertOpening(await checkout(id), id);
  });

  test("a resumed POST /consultations", async () => {
    const first = await create();
    const { id, reference } = first.body.data;
    harness.clock.advanceHours(1);
    paystackAbandoned(reference, id);
    anotherRequestIsOpening(id);
    const out = await create();
    assertOpening(out, id);
    assert.equal(bookings().length, 1, "still one booking");
  });

  test("a fresh POST /consultations whose checkout another request is opening", async () => {
    // Between this create's write and its checkout claim, another request
    // claims a reference for the new booking and has not published yet.
    const original = consultationService.createOrResumePendingBooking.bind(consultationService);
    (consultationService as any).createOrResumePendingBooking = async (data: any) => {
      const outcome = await original(data);
      await fakeCollection("consultations").doc(outcome.consultation.id).update({ transactionId: "cons-claimed-by-another-request" });
      return outcome;
    };
    try {
      const out = await create();
      const [stored] = bookings();
      assertOpening(out, stored.id);
      assert.equal(harness.charges.length, 0, "this request opened nothing");
    } finally {
      (consultationService as any).createOrResumePendingBooking = original;
    }
  });
});

// ============================================
// The pure matching helpers
// ============================================

describe("pickResumableBooking", () => {
  const day = Timestamp.fromDate(new Date("2026-12-01"));
  const slot = { userId: "u1", agentId: "a1", scheduledDate: day, scheduledTime: "10:00" };
  /** An unpaid, #180-priced booking of `slot`. */
  const row = (id: string, overrides: Record<string, unknown> = {}): any => ({
    id, userId: "u1", agentId: "a1", scheduledDate: day, scheduledTime: "10:00",
    status: "pending_payment", paymentStatus: "pending",
    priceUsdCents: 1_000, chargedCurrency: "NGN", chargedAmountMinor: AGENT_FEE_KOBO,
    createdAt: Timestamp.fromMillis(1_000), ...overrides,
  });

  test("matches only an unpaid, priced booking of exactly this slot", () => {
    assert.equal(isResumableForSlot(row("ok"), slot), true);
    assert.equal(isResumableForSlot(row("x", { userId: "u2" }), slot), false);
    assert.equal(isResumableForSlot(row("x", { agentId: "a2" }), slot), false);
    assert.equal(isResumableForSlot(row("x", { scheduledTime: "10:30" }), slot), false);
    assert.equal(isResumableForSlot(row("x", { scheduledDate: Timestamp.fromDate(new Date("2026-12-02")) }), slot), false);
    assert.equal(isResumableForSlot(row("x", { status: "scheduled" }), slot), false);
    assert.equal(isResumableForSlot(row("x", { status: "cancelled" }), slot), false);
    assert.equal(isResumableForSlot(row("x", { paymentStatus: "paid" }), slot), false);
    assert.equal(isResumableForSlot(row("x", { chargedAmountMinor: undefined }), slot), false);
    // A stored 12-hour time is normalised before the comparison.
    assert.equal(isResumableForSlot(row("x", { scheduledTime: "10:00 am" }), slot), true);
  });

  test("picks the newest by createdAt, or null when nothing matches", () => {
    const picked = pickResumableBooking(
      [
        row("older", { createdAt: Timestamp.fromMillis(1_000) }),
        row("newest", { createdAt: Timestamp.fromMillis(3_000) }),
        row("paid-and-newer", { createdAt: Timestamp.fromMillis(9_000), status: "scheduled", paymentStatus: "paid" }),
        row("middle", { createdAt: Timestamp.fromMillis(2_000) }),
      ],
      slot
    );
    assert.equal(picked?.id, "newest");
    assert.equal(pickResumableBooking([], slot), null);
    assert.equal(pickResumableBooking([row("x", { status: "cancelled" })], slot), null);
  });
});
