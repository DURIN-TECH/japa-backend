// ============================================
// Unit tests — no booking of a slot that has already started (issue #472)
// ============================================
//
// Reported on a hand check: a consultation was booked for 11 AM today when
// it was already 1 PM. These tests pin the backend guard, the real one.
//
// Hermetic, same harness as the other consultation suites
// (test/consultations/harness.ts): in-memory Firestore, Paystack stubbed,
// a fixed clock. The clock is moved to the issue's example "now":
// 2026-11-22 12:00 UTC, which is 13:00 in Lagos.
//
// What is covered, by acceptance criterion:
//  - `isSlotInPast` (the one pure helper): "starts exactly now" counts as
//    started, the time-zone table from the issue, a DST zone
//    (Europe/London) on its change date, a missing zone = Africa/Lagos;
//  - POST /consultations, client flow and agent-for-client flow: a past
//    slot is 400 SLOT_IN_PAST with nothing written, no quote locked and no
//    Paystack call; an unpaid booking of that past slot is NOT resumed; a
//    slot later today still books (201);
//  - POST /agencies/public/:slug/consultations (guest): 400 SLOT_IN_PAST
//    before the agency is read or an account made; a bad date is 400, not
//    500;
//  - PUT /consultations/:id: a move into the past (the MERGED slot) is 400
//    SLOT_IN_PAST with nothing written or notified; meeting fields and the
//    summary of a booking whose slot has passed are still saved, and so is
//    resending its stored schedule; a move to later today is saved;
//  - an unknown `timezone` ("Mars/Base") is 400 VALIDATION_ERROR on all
//    three routes.
import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";
import { defineAbilitiesFor, ROLES } from "@durin-tech/authz";
import type { AuthzSubject } from "@durin-tech/authz";

import { writes } from "../helpers/fake-firestore";
import { fakeClock } from "../money/helpers";
import { useHarness, harness, captureRes, docsIn, seed, setRate, T0 } from "./harness";
import { consultationController } from "../../src/controllers/consultation.controller";
import { consultationService, movesIntoPast } from "../../src/services/consultation.service";
import { agencyService } from "../../src/services/agency.service";
import { notificationService } from "../../src/services/notification.service";
import {
  isSlotInPast,
  SLOT_IN_PAST_CODE,
  SLOT_IN_PAST_MESSAGE,
} from "../../src/consultations/slot-time";
import type { Consultation } from "../../src/types";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ============================================
// Clock and spies
// ============================================

/** The issue's example "now": 12:00 UTC = 13:00 in Lagos. */
const NOW_472 = "2026-11-22T12:00:00Z";
/** That instant as a Date (for the pure helper). */
const NOW = new Date(NOW_472);

/** Every notification sent during a test (the harness's no-op, made a recorder). */
const notified: Array<{ userId: string; type: string }> = [];
/** How often the guest route read an agency, and asked for a resumable booking. */
const calls = { agencyReads: 0, resumeLookups: 0 };
/** Every guest account the route asked Firebase Auth to create. */
const firebaseAuthCalls: unknown[] = [];

before(async () => {
  await useHarness();
  // Record every guest account provisioning (the harness's fake still answers).
  const firebase: any = await import("../../src/utils/firebase");
  const realCreateUser = firebase.auth.createUser;
  firebase.auth.createUser = async (input: unknown) => {
    firebaseAuthCalls.push(input);
    return realCreateUser(input);
  };
  (notificationService as any).notifyUser = async (n: { userId: string; type: string }) => {
    notified.push({ userId: n.userId, type: n.type });
  };
  // Count the reads the guard must come BEFORE (the real calls still run).
  const realGetAgency = agencyService.getAgencyBySlug.bind(agencyService);
  (agencyService as any).getAgencyBySlug = async (slug: string) => {
    calls.agencyReads += 1;
    return realGetAgency(slug);
  };
  const realFindResumable = consultationService.findResumableBooking.bind(consultationService);
  (consultationService as any).findResumableBooking = async (...args: any[]) => {
    calls.resumeLookups += 1;
    return (realFindResumable as any)(...args);
  };
});

beforeEach(() => {
  harness.reset();
  // Move the shared clock (the charge path and the guard both read it) to
  // the issue's "now", and store fresh rates dated then, so a booking that
  // IS allowed can still be priced.
  harness.clock = fakeClock(NOW_472);
  setRate("NGN", 1500);
  setRate("GHS", 15);
  notified.length = 0;
  calls.agencyReads = 0;
  calls.resumeLookups = 0;
  firebaseAuthCalls.length = 0;
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

/** A slot as the helper reads it: the day as a Timestamp, the time, the zone. */
function slot(day: string, time: string, timezone?: string) {
  return {
    scheduledDate: Timestamp.fromDate(new Date(day)),
    scheduledTime: time,
    timezone,
  } as Pick<Consultation, "scheduledDate" | "scheduledTime" | "timezone">;
}

/** The booking's client. */
const client: AuthzSubject = { uid: "uid-client1", role: ROLES.CLIENT, agencyId: null };
/** The booking's agent (a member of agency A). */
const agent: AuthzSubject = { uid: "uid-agent1", role: ROLES.AGENT, agencyId: "agency-a" };

/** A request for `p` as verifyAuth leaves it. */
function reqFor(p: AuthzSubject, extra: Record<string, unknown> = {}): any {
  return { userId: p.uid, authz: p, ability: defineAbilitiesFor(p), entitlements: null, query: {}, params: {}, body: {}, ...extra };
}

/** A client and a verified, available agent with a $10 fee, and agency A's page. */
async function seedParties(): Promise<void> {
  await seed("users", "uid-client1", {
    email: "delivered+client1@resend.dev", firstName: "Chi", lastName: "Client", createdAt: T0,
  });
  await seed("agents", "agent1", {
    userId: "uid-agent1", displayName: "Ada Agent", verificationStatus: "verified", isAvailable: true,
    agencyId: "agency-a", consultationFeeUsd: { amountMinor: 1_000, currency: "USD" }, createdAt: T0,
  });
  await seed("agencies", "agency-a", {
    name: "Acme Visas", slug: "acme", status: "approved", ownerId: "uid-owner-a", ownerName: "Ola Owner",
    services: [], consultationFeeUsd: { amountMinor: 1_000, currency: "USD" }, createdAt: T0,
  });
  // Only what the request under test writes is checked.
  writes.length = 0;
}

/** POST /consultations as the signed-in client, booking agent1. */
async function clientBooks(body: Record<string, unknown>) {
  const { out, res } = captureRes();
  await consultationController.createConsultation(
    reqFor(client, { body: { type: "initial", agentId: "agent1", ...body } }),
    res
  );
  return out;
}

/** POST /consultations as agent1, booking for the client. */
async function agentBooks(body: Record<string, unknown>) {
  const { out, res } = captureRes();
  await consultationController.createConsultation(
    reqFor(agent, { body: { type: "initial", userId: "uid-client1", ...body } }),
    res
  );
  return out;
}

/** POST /agencies/public/acme/consultations as a guest. */
async function guestBooks(body: Record<string, unknown>) {
  const { out, res } = captureRes();
  await consultationController.createPublicConsultation(
    {
      params: { slug: "acme" },
      body: { clientName: "Gina Guest", clientEmail: "delivered+guest@resend.dev", ...body },
    } as any,
    res
  );
  return out;
}

/** PUT /consultations/:id as agent1. */
async function agentEdits(body: Record<string, unknown>, id = "c1") {
  const { out, res } = captureRes();
  await consultationController.updateConsultation(reqFor(agent, { params: { id }, body }), res);
  return out;
}

/** A stored, scheduled (free) booking "c1" whose slot is `day` at `time` in Lagos. */
async function seedBooking(day: string, time: string, over: Record<string, unknown> = {}) {
  await seed("consultations", "c1", {
    userId: "uid-client1", agentId: "uid-agent1", agencyId: "agency-a", bookedVia: "client",
    type: "initial", scheduledDate: Timestamp.fromDate(new Date(day)), scheduledTime: time,
    durationMinutes: 30, timezone: "Africa/Lagos",
    meetingLink: "https://meet.example.test/old", meetingPlatform: "zoom", summary: "old notes",
    status: "scheduled", paymentStatus: "paid", priceUsdCents: 0, createdAt: T0, updatedAt: T0,
    ...over,
  });
  writes.length = 0;
}

/** The stored bookings. */
function bookings(): Record<string, any>[] {
  return docsIn("consultations").map(([, data]) => data);
}

/**
 * A SLOT_IN_PAST refusal: the exact answer, nothing written, no Paystack
 * checkout opened (so no quote was locked on a booking either), nobody told.
 */
function assertSlotInPast(out: { status: number; body: any }, label: string) {
  assert.equal(out.status, 400, `${label}: ${JSON.stringify(out.body)}`);
  assert.equal(out.body.success, false, label);
  assert.equal(out.body.error, SLOT_IN_PAST_CODE, label);
  assert.equal(out.body.message, "That time has already passed. Please pick a later time.", label);
  assert.deepEqual(writes, [], `${label}: nothing written`);
  assert.equal(harness.charges.length, 0, `${label}: no Paystack checkout`);
  assert.deepEqual(notified, [], `${label}: nobody notified`);
}

// ============================================
// The helper
// ============================================

describe("isSlotInPast (issue #472)", () => {
  test("the message is the one the apps show", () => {
    assert.equal(SLOT_IN_PAST_MESSAGE, "That time has already passed. Please pick a later time.");
  });

  test("the time-zone table from the issue (now = 2026-11-22 12:00 UTC = 13:00 Lagos)", () => {
    const table: Array<[string, string, string | undefined, boolean]> = [
      // The reported case: 11 AM Lagos booked at 1 PM Lagos.
      ["2026-11-22", "11:00", "Africa/Lagos", true],
      // Starts exactly now: counts as started.
      ["2026-11-22", "13:00", "Africa/Lagos", true],
      // One minute before now, and one minute after.
      ["2026-11-22", "12:59", "Africa/Lagos", true],
      ["2026-11-22", "13:01", "Africa/Lagos", false],
      ["2026-11-22", "13:30", "Africa/Lagos", false],
      // 11:00 New York is 16:00 UTC: still ahead.
      ["2026-11-22", "11:00", "America/New_York", false],
      // 11:00 Tokyo is 02:00 UTC: long gone.
      ["2026-11-22", "11:00", "Asia/Tokyo", true],
      // Yesterday, at any time.
      ["2026-11-21", "00:00", "Africa/Lagos", true],
      ["2026-11-21", "23:59", "Africa/Lagos", true],
      // 23:59 PST on the 21st is 07:59 UTC on the 22nd: before 12:00 UTC, so started.
      ["2026-11-21", "23:59", "America/Los_Angeles", true],
      // But 06:00 PST on the 22nd is 14:00 UTC: still ahead.
      ["2026-11-22", "06:00", "America/Los_Angeles", false],
      // Tomorrow.
      ["2026-11-23", "00:00", "Africa/Lagos", false],
      // No zone stored: read as Africa/Lagos (the default), like the reported case.
      ["2026-11-22", "11:00", undefined, true],
      ["2026-11-22", "13:30", undefined, false],
      // A 12-hour value from before #288 is read the same way.
      ["2026-11-22", "1:30 PM", "Africa/Lagos", false],
      ["2026-11-22", "11:00 AM", "Africa/Lagos", true],
    ];
    for (const [day, time, zone, expected] of table) {
      assert.equal(isSlotInPast(slot(day, time, zone), NOW), expected, `${day} ${time} ${zone ?? "(no zone)"}`);
    }
  });

  test("the boundary: starts exactly now is started, one millisecond earlier it is not", () => {
    const at = new Date("2026-11-22T12:00:00Z"); // 13:00 Lagos
    assert.equal(isSlotInPast(slot("2026-11-22", "13:00", "Africa/Lagos"), at), true);
    assert.equal(isSlotInPast(slot("2026-11-22", "13:00", "Africa/Lagos"), new Date(at.getTime() - 1)), false);
  });

  test("a DST zone on its change date (Europe/London, 2026-10-25: BST ends at 02:00 local)", () => {
    // 09:00 on the change day is GMT (UTC+0) = 09:00 UTC.
    const s = slot("2026-10-25", "09:00", "Europe/London");
    assert.equal(isSlotInPast(s, new Date("2026-10-25T08:59:00Z")), false);
    assert.equal(isSlotInPast(s, new Date("2026-10-25T09:00:00Z")), true);
    // 00:30 on the change day is still BST (UTC+1) = 23:30 UTC the day before.
    const early = slot("2026-10-25", "00:30", "Europe/London");
    assert.equal(isSlotInPast(early, new Date("2026-10-24T23:29:00Z")), false);
    assert.equal(isSlotInPast(early, new Date("2026-10-24T23:30:00Z")), true);
    // The spring change (2026-03-29, BST starts at 01:00): 10:00 is BST = 09:00 UTC.
    const spring = slot("2026-03-29", "10:00", "Europe/London");
    assert.equal(isSlotInPast(spring, new Date("2026-03-29T08:59:00Z")), false);
    assert.equal(isSlotInPast(spring, new Date("2026-03-29T09:00:00Z")), true);
  });

  test("movesIntoPast judges the MERGED slot (new values over stored ones)", () => {
    const current = {
      ...slot("2026-11-22", "15:00", "Africa/Lagos"),
    } as unknown as Consultation;
    // Only the time sent: the stored day and zone are kept.
    assert.equal(movesIntoPast(current, { scheduledTime: "11:00" }, NOW), true);
    assert.equal(movesIntoPast(current, { scheduledTime: "14:00" }, NOW), false);
    // Only the zone sent: 15:00 Tokyo on the 22nd is 06:00 UTC, gone.
    assert.equal(movesIntoPast(current, { timezone: "Asia/Tokyo" }, NOW), true);
    // Only the day sent: yesterday at the stored 15:00.
    assert.equal(
      movesIntoPast(current, { scheduledDate: Timestamp.fromDate(new Date("2026-11-21")) }, NOW),
      true
    );
  });
});

// ============================================
// POST /consultations (client and agent flows)
// ============================================

describe("POST /consultations refuses a slot that has started (issue #472)", () => {
  test("client flow: the reported case (11:00 Lagos at 13:00 Lagos) is 400 SLOT_IN_PAST, nothing written or priced", async () => {
    await seedParties();
    const out = await clientBooks({ scheduledDate: "2026-11-22", scheduledTime: "11:00", timezone: "Africa/Lagos" });
    assertSlotInPast(out, "client 11:00");
    assert.equal(bookings().length, 0);
    assert.equal(calls.resumeLookups, 0, "refused before the resume lookup");
  });

  test("client flow: a slot starting exactly now, yesterday, and a missing zone (Lagos) are all refused", async () => {
    await seedParties();
    for (const body of [
      { scheduledDate: "2026-11-22", scheduledTime: "13:00", timezone: "Africa/Lagos" },
      { scheduledDate: "2026-11-21", scheduledTime: "18:00", timezone: "Africa/Lagos" },
      { scheduledDate: "2026-11-22", scheduledTime: "11:00" },
      // 12-hour form, converted then judged.
      { scheduledDate: "2026-11-22", scheduledTime: "12:30 PM", timezone: "Africa/Lagos" },
    ]) {
      assertSlotInPast(await clientBooks(body), JSON.stringify(body));
    }
    assert.equal(bookings().length, 0);
  });

  test("agent-for-client flow: a past slot is 400 SLOT_IN_PAST, nothing written", async () => {
    await seedParties();
    const out = await agentBooks({ scheduledDate: "2026-11-22", scheduledTime: "11:00", timezone: "Asia/Tokyo" });
    assertSlotInPast(out, "agent flow");
    assert.equal(bookings().length, 0);
  });

  test("an unpaid booking of that past slot is NOT resumed: 400, the old booking untouched", async () => {
    await seedParties();
    await seed("consultations", "old-pending", {
      userId: "uid-client1", agentId: "uid-agent1", bookedVia: "client",
      type: "initial", scheduledDate: Timestamp.fromDate(new Date("2026-11-22")), scheduledTime: "11:00",
      durationMinutes: 30, timezone: "Africa/Lagos", status: "pending_payment", paymentStatus: "pending",
      transactionId: "ref-old", checkoutUrl: "https://checkout.paystack.test/ref-old",
      priceUsdCents: 1_000, createdAt: T0, updatedAt: T0,
    });
    writes.length = 0;
    const before = bookings()[0];
    const out = await clientBooks({ scheduledDate: "2026-11-22", scheduledTime: "11:00", timezone: "Africa/Lagos" });
    assertSlotInPast(out, "resume of a past slot");
    assert.notEqual(out.body.data?.resumed, true, "not resumed");
    assert.equal(calls.resumeLookups, 0, "the resume branch was never reached");
    assert.deepEqual(bookings(), [before], "the old booking is untouched, no new one");
  });

  test("a slot later today, and one in New York's morning (still ahead), still book: 201", async () => {
    await seedParties();
    const later = await clientBooks({ scheduledDate: "2026-11-22", scheduledTime: "13:30", timezone: "Africa/Lagos" });
    assert.equal(later.status, 201, JSON.stringify(later.body));
    assert.equal(later.body.data.requiresPayment, true);
    const ny = await clientBooks({ scheduledDate: "2026-11-22", scheduledTime: "11:00", timezone: "America/New_York" });
    assert.equal(ny.status, 201, JSON.stringify(ny.body));
    assert.equal(ny.body.data.timezone, "America/New_York", "the sent zone is stored");
    // A missing zone keeps the default.
    const noZone = await clientBooks({ scheduledDate: "2026-11-23", scheduledTime: "09:00" });
    assert.equal(noZone.status, 201, JSON.stringify(noZone.body));
    assert.equal(noZone.body.data.timezone, "Africa/Lagos");
  });

  test("an unknown timezone is 400 VALIDATION_ERROR (no silent Lagos fallback), nothing written", async () => {
    await seedParties();
    for (const book of [clientBooks, agentBooks]) {
      const out = await book({ scheduledDate: "2026-12-01", scheduledTime: "10:00", timezone: "Mars/Base" });
      assert.equal(out.status, 400, JSON.stringify(out.body));
      assert.equal(out.body.error, "VALIDATION_ERROR");
      assert.match(out.body.message, /timezone/);
    }
    assert.deepEqual(writes, []);
    assert.equal(harness.charges.length, 0);
  });
});

// ============================================
// POST /agencies/public/:slug/consultations (guest)
// ============================================

describe("POST /agencies/public/:slug/consultations refuses a slot that has started (issue #472)", () => {
  test("a past slot is 400 SLOT_IN_PAST before the agency is read or an account is made", async () => {
    await seedParties();
    const out = await guestBooks({ scheduledDate: "2026-11-22", scheduledTime: "11:00", timezone: "Africa/Lagos" });
    assertSlotInPast(out, "guest past");
    assert.equal(calls.agencyReads, 0, "the agency was never read");
    assert.equal(firebaseAuthCalls.length, 0, "no guest account was provisioned");
    assert.equal(docsIn("users").length, 1, "only the seeded client exists");
  });

  test("a date that is not a date is 400 VALIDATION_ERROR (it used to be a 500)", async () => {
    await seedParties();
    const out = await guestBooks({ scheduledDate: "not-a-date", scheduledTime: "10:00" });
    assert.equal(out.status, 400, JSON.stringify(out.body));
    assert.equal(out.body.error, "VALIDATION_ERROR");
    assert.deepEqual(writes, []);
    assert.equal(firebaseAuthCalls.length, 0);
  });

  test("an unknown timezone is 400 VALIDATION_ERROR before any account is made", async () => {
    await seedParties();
    const out = await guestBooks({ scheduledDate: "2026-12-01", scheduledTime: "10:00", timezone: "Mars/Base" });
    assert.equal(out.status, 400, JSON.stringify(out.body));
    assert.equal(out.body.error, "VALIDATION_ERROR");
    assert.deepEqual(writes, []);
    assert.equal(calls.agencyReads, 0);
    assert.equal(firebaseAuthCalls.length, 0);
  });

  test("a slot later today still books: 201 with a checkout", async () => {
    await seedParties();
    const out = await guestBooks({ scheduledDate: "2026-11-22", scheduledTime: "16:00", timezone: "Africa/Lagos" });
    assert.equal(out.status, 201, JSON.stringify(out.body));
    assert.equal(harness.charges.length, 1);
  });
});

// ============================================
// PUT /consultations/:id
// ============================================

describe("PUT /consultations/:id refuses a move into the past (issue #472)", () => {
  test("moving a future booking to a time that has started is 400 SLOT_IN_PAST, nothing written or notified", async () => {
    await seedParties();
    await seedBooking("2026-11-22", "15:00");
    const before = bookings()[0];
    for (const body of [
      // Only the time: the stored day (today) and zone (Lagos) are kept.
      { scheduledTime: "11:00" },
      { scheduledTime: "13:00" },
      // Only the day: yesterday at the stored 15:00.
      { scheduledDate: "2026-11-21" },
      // Only the zone: 15:00 Tokyo is 06:00 UTC.
      { timezone: "Asia/Tokyo" },
      // The portal's body, 12-hour label.
      { scheduledDate: "2026-11-22", scheduledTime: "10:00 AM" },
    ]) {
      assertSlotInPast(await agentEdits(body), JSON.stringify(body));
      assert.deepEqual(bookings()[0], before, `${JSON.stringify(body)}: booking unchanged`);
    }
  });

  test("a move to later today, or another day, is saved as before", async () => {
    await seedParties();
    await seedBooking("2026-11-22", "15:00");
    const out = await agentEdits({ scheduledTime: "13:30" });
    assert.ok(out.status === 0 || out.status === 200, JSON.stringify(out.body));
    assert.equal(bookings()[0].scheduledTime, "13:30");
    const next = await agentEdits({ scheduledDate: "2026-11-25", scheduledTime: "09:00 AM" });
    assert.ok(next.status === 0 || next.status === 200, JSON.stringify(next.body));
    assert.equal(bookings()[0].scheduledTime, "09:00");
  });

  test("a booking whose slot has passed still saves edits that do not move it (#316 table)", async () => {
    await seedParties();
    await seedBooking("2026-11-22", "10:00");
    for (const body of [
      { meetingLink: "https://meet.example.test/new" },
      { meetingPlatform: "teams" },
      { type: "follow_up" },
      { summary: "Went through the documents." },
      // Resending the stored schedule unchanged is not a move.
      { scheduledDate: "2026-11-22", scheduledTime: "10:00", timezone: "Africa/Lagos", durationMinutes: 30 },
      // The same time in 12-hour form is the same stored value.
      { scheduledTime: "10:00 AM" },
    ]) {
      const out = await agentEdits(body);
      assert.ok(out.status === 0 || out.status === 200, `${JSON.stringify(body)}: ${JSON.stringify(out.body)}`);
    }
    assert.equal(bookings()[0].summary, "Went through the documents.");
    assert.equal(bookings()[0].scheduledTime, "10:00");
  });

  test("changing only the duration of a past booking counts as a move (the criterion keys on slotChanges)", async () => {
    // `durationMinutes` is a schedule field, so `slotChanges` is true and the
    // merged slot (start unchanged, already passed) is judged: refused. A
    // booking whose slot has passed cannot be rescheduled in any way.
    await seedParties();
    await seedBooking("2026-11-22", "10:00");
    assertSlotInPast(await agentEdits({ durationMinutes: 45 }), "duration only");
    assert.equal(bookings()[0].durationMinutes, 30);
  });

  test("an unknown timezone is 400 VALIDATION_ERROR, nothing written", async () => {
    await seedParties();
    await seedBooking("2026-12-01", "10:00");
    const out = await agentEdits({ timezone: "Mars/Base" });
    assert.equal(out.status, 400, JSON.stringify(out.body));
    assert.equal(out.body.error, "VALIDATION_ERROR");
    assert.deepEqual(writes, []);
    assert.deepEqual(notified, []);
  });
});
