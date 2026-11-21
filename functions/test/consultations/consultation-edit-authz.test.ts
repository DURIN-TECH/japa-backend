// ============================================
// Unit tests — who may edit a consultation, and which fields (issue #316)
// ============================================
//
// Hermetic (test/consultations/harness.ts): in-memory Firestore, Paystack
// stubbed, a fixed clock. Requests carry a REAL CASL ability from
// @durin-tech/authz, as verifyAuth leaves them.
//
// What is covered, by acceptance criterion:
//  - `decideEdit` (the pure helper): every row of the status x field table
//    for the agent side, the client and a non-party, the order of its
//    answers, and the quote-lock boundary;
//  - `parseEditBody`: every bad value is refused, good ones are kept,
//    fields outside the editable list are dropped;
//  - PUT /consultations/:id through the controller, per role and status:
//      * agent side (the booking's agent, its agency's owner, an admin):
//        every field x every status, saved or 409 BOOKING_NOT_EDITABLE;
//      * the client, and every non-party (same-agency colleague, another
//        client, another agency's owner / agent): 403 in every status;
//      * unknown id 404; no editable field / bad values 400 (never 500);
//      * order of checks 400 -> 404 -> 403 -> 409;
//      * payment in flight: a reschedule is 409 PAYMENT_IN_PROGRESS, meeting
//        fields and `summary` are saved; one second either side of
//        `quoteExpiresAt`; an edit racing a real payment;
//      * a save writes only the editable fields and `updatedAt`;
//      * every refusal leaves the stored doc unchanged and calls
//        `notifyUser` zero times;
//      * a saved schedule CHANGE notifies the client, and the booking's agent
//        too when the owner or an admin made it;
//      * the portal's reschedule body (`{ scheduledDate, scheduledTime }`
//        with the time picker's 12-hour labels, e.g. "12:00 PM") works for
//        the booking's agent and for the agency owner, stored as HH:mm;
//      * resending the schedule a booking already has notifies nobody.
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
  EDITABLE_FIELDS,
  EDITABLE_GROUPS_BY_STATUS,
  EDIT_FIELD_GROUPS,
  EditableField,
  decideEdit,
  normalizeScheduledTime,
  parseEditBody,
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

const AGENT_SIDE = [agent, ownerA, admin];
const OUTSIDERS = [otherClient, ownerB, agentB, colleague];

/** A request for `p` as verifyAuth leaves it. */
function reqFor(p: AuthzSubject, extra: Record<string, unknown> = {}): any {
  return { userId: p.uid, authz: p, ability: defineAbilitiesFor(p), entitlements: null, query: {}, params: {}, body: {}, ...extra };
}

/** What a seeded booking holds before the request under test. */
const ORIGINAL = {
  userId: "uid-client1", agentId: "uid-agent1", agencyId: "agency-a",
  type: "initial", scheduledDate: T0, scheduledTime: "10:00", durationMinutes: 30, timezone: "Africa/Lagos",
  meetingLink: "https://meet.example.test/old", meetingPlatform: "zoom", summary: "old notes",
  priceUsdCents: 0, createdAt: T0, updatedAt: T0,
};

/**
 * Seed booking "c1" (client 1, agent 1, agency A) in `status`, then forget
 * the seed write so `writes` only holds what the request under test wrote.
 * An unpaid `pending_payment` booking has NO checkout unless `over` adds one.
 */
async function seedBooking(status: ConsultationStatus, over: Record<string, unknown> = {}, id = "c1") {
  await seed("consultations", id, {
    ...ORIGINAL, status, paymentStatus: status === "pending_payment" ? "pending" : "paid", ...over,
  });
  writes.length = 0;
}

/** A pending booking with an open checkout whose quote lock ends `lockMs` from "now" (30 minutes by default). */
async function seedInFlight(lockMs = 30 * 60_000, over: Record<string, unknown> = {}) {
  const now = harness.clock.now().getTime();
  await seedBooking("pending_payment", {
    transactionId: "ref-open", checkoutUrl: "https://checkout.paystack.test/ref-open",
    priceUsdCents: 1_000, chargedCurrency: "NGN", chargedAmountMinor: 1_500_000,
    quoteLockedAt: Timestamp.fromMillis(now - 60_000), quoteExpiresAt: Timestamp.fromMillis(now + lockMs),
    ...over,
  });
}

/** PUT /consultations/:id as `p`. */
async function edit(p: AuthzSubject, body: unknown, id = "c1") {
  const { out, res } = captureRes();
  await consultationController.updateConsultation(reqFor(p, { params: { id }, body }), res);
  return out;
}

/** The stored booking `id`. */
function stored(id = "c1"): Record<string, any> {
  return docsIn("consultations").find(([docId]) => docId === id)![1];
}

/** A refusal: the error code, the stored doc unchanged, nothing written, nobody notified. */
function assertRefused(
  out: { status: number; body: any },
  status: number,
  code: string,
  label: string,
  before?: Record<string, any>
) {
  assert.equal(out.status, status, `${label}: ${JSON.stringify(out.body)}`);
  assert.equal(out.body.error, code, label);
  assert.equal(out.body.success, false, label);
  assert.deepEqual(writes, [], `${label}: nothing written`);
  assert.deepEqual(notified, [], `${label}: nobody notified`);
  if (before) assert.deepEqual(stored(), before, `${label}: stored doc unchanged`);
}

/** A success as sendSuccess leaves it (no explicit status, or 200). */
function assertOk(out: { status: number; body: any }, label: string) {
  assert.ok(out.status === 0 || out.status === 200, `${label}: ${JSON.stringify(out.body)}`);
  assert.equal(out.body.success, true, label);
}

/** One valid new value per editable field (each differs from ORIGINAL). */
const VALID: Record<EditableField, unknown> = {
  scheduledDate: "2026-12-01",
  scheduledTime: "14:30",
  durationMinutes: 45,
  timezone: "Europe/London",
  meetingLink: "https://meet.example.test/new",
  meetingPlatform: "google_meet",
  type: "follow_up",
  summary: "new notes",
};
const SCHEDULE: EditableField[] = ["scheduledDate", "scheduledTime", "durationMinutes", "timezone"];
const MEETING: EditableField[] = ["meetingLink", "meetingPlatform", "type"];
const ALL_FIELDS: EditableField[] = [...SCHEDULE, ...MEETING, "summary"];

/**
 * The acceptance criteria's table, written out again here (not read from the
 * code under test): for each status, the fields the agent side may edit.
 */
const TABLE: Record<ConsultationStatus, EditableField[]> = {
  pending_payment: ALL_FIELDS,
  scheduled: ALL_FIELDS,
  confirmed: ALL_FIELDS,
  in_progress: [...MEETING, "summary"],
  completed: ["summary"],
  cancelled: [],
  no_show: [],
};

/** A fixed instant for the pure-helper tests. */
const AT = new Date("2026-11-13T09:00:00Z");

// ============================================
// The pure helper
// ============================================

describe("decideEdit", () => {
  test("the stored field list and status table are exactly the acceptance criteria's", () => {
    assert.deepEqual([...EDIT_FIELD_GROUPS.schedule], SCHEDULE);
    assert.deepEqual([...EDIT_FIELD_GROUPS.meeting], MEETING);
    assert.deepEqual([...EDIT_FIELD_GROUPS.summary], ["summary"]);
    assert.deepEqual([...EDITABLE_FIELDS], ALL_FIELDS);
    for (const status of CONSULTATION_STATUSES) {
      const open = EDITABLE_FIELDS.filter((f) =>
        EDITABLE_GROUPS_BY_STATUS[status].some((g) => (EDIT_FIELD_GROUPS[g] as readonly string[]).includes(f))
      );
      assert.deepEqual(open, TABLE[status], status);
    }
  });

  for (const status of CONSULTATION_STATUSES) {
    test(`agent side, ${status}: each field alone is allowed or 409 BOOKING_NOT_EDITABLE as the table says`, () => {
      for (const field of ALL_FIELDS) {
        const decision = decideEdit(CONSULTATION_ACTORS.AGENT_SIDE, { status }, [field], AT);
        if (TABLE[status].includes(field)) {
          assert.deepEqual(decision, { ok: true }, `${status} ${field}`);
        } else {
          assert.equal((decision as any).code, "BOOKING_NOT_EDITABLE", `${status} ${field}`);
          assert.equal((decision as any).httpStatus, 409, `${status} ${field}`);
        }
      }
    });

    test(`client and non-party, ${status}: 403 FORBIDDEN for every field`, () => {
      for (const actor of [CONSULTATION_ACTORS.CLIENT, null]) {
        for (const field of ALL_FIELDS) {
          const decision = decideEdit(actor, { status }, [field], AT) as any;
          assert.equal(decision.code, "FORBIDDEN", `${actor} ${status} ${field}`);
          assert.equal(decision.httpStatus, 403);
        }
      }
    });
  }

  test("one closed field refuses the whole edit", () => {
    const decision = decideEdit(CONSULTATION_ACTORS.AGENT_SIDE, { status: "completed" }, ["summary", "type"], AT) as any;
    assert.equal(decision.code, "BOOKING_NOT_EDITABLE");
    assert.match(decision.message, /type/);
  });

  test("payment in flight: schedule fields are 409 PAYMENT_IN_PROGRESS, the others are allowed", () => {
    const booking = {
      status: "pending_payment" as ConsultationStatus,
      transactionId: "ref",
      // Issue #321: in flight needs a checkout that was really opened.
      checkoutUrl: "https://checkout.paystack.test/ref",
      quoteExpiresAt: Timestamp.fromDate(new Date("2026-11-13T09:30:00Z")),
    };
    for (const field of SCHEDULE) {
      const decision = decideEdit(CONSULTATION_ACTORS.AGENT_SIDE, booking, [field], AT) as any;
      assert.equal(decision.code, "PAYMENT_IN_PROGRESS", field);
      assert.equal(decision.httpStatus, 409);
    }
    for (const field of [...MEETING, "summary"] as EditableField[]) {
      assert.deepEqual(decideEdit(CONSULTATION_ACTORS.AGENT_SIDE, booking, [field], AT), { ok: true }, field);
    }
    // A schedule field mixed with allowed ones still refuses the edit.
    assert.equal(
      (decideEdit(CONSULTATION_ACTORS.AGENT_SIDE, booking, ["summary", "scheduledTime"], AT) as any).code,
      "PAYMENT_IN_PROGRESS"
    );
    // No checkout opened, or a legacy row with no lock: not in flight.
    assert.deepEqual(
      decideEdit(CONSULTATION_ACTORS.AGENT_SIDE, { ...booking, transactionId: undefined }, ["scheduledDate"], AT),
      { ok: true }
    );
    assert.deepEqual(
      decideEdit(CONSULTATION_ACTORS.AGENT_SIDE, { ...booking, quoteExpiresAt: undefined }, ["scheduledDate"], AT),
      { ok: true }
    );
    // Issue #321: a reference but NO checkoutUrl (the Paystack start failed,
    // nobody was shown a page to pay on): not in flight either.
    assert.deepEqual(
      decideEdit(CONSULTATION_ACTORS.AGENT_SIDE, { ...booking, checkoutUrl: undefined }, ["scheduledDate"], AT),
      { ok: true }
    );
  });

  test("the in-flight rule is exact at the lock boundary", () => {
    const booking = {
      status: "pending_payment" as ConsultationStatus,
      transactionId: "ref",
      // Issue #321: in flight needs a checkout that was really opened.
      checkoutUrl: "https://checkout.paystack.test/ref",
      quoteExpiresAt: Timestamp.fromDate(new Date("2026-11-13T09:30:00Z")),
    };
    const at = (iso: string) => decideEdit(CONSULTATION_ACTORS.AGENT_SIDE, booking, ["scheduledDate"], new Date(iso));
    assert.equal((at("2026-11-13T09:29:59Z") as any).code, "PAYMENT_IN_PROGRESS");
    assert.equal((at("2026-11-13T09:30:00Z") as any).code, "PAYMENT_IN_PROGRESS");
    assert.deepEqual(at("2026-11-13T09:30:01Z"), { ok: true });
  });

  test("order of the answers: 400 before 403 before 409", () => {
    const closed = { status: "cancelled" as ConsultationStatus };
    // No field at all is 400, even for a non-party on a closed booking.
    assert.equal((decideEdit(null, closed, [], AT) as any).code, "VALIDATION_ERROR");
    assert.equal((decideEdit(null, closed, [], AT) as any).httpStatus, 400);
    // A non-party and the client are 403 before the status is looked at.
    assert.equal((decideEdit(null, closed, ["summary"], AT) as any).code, "FORBIDDEN");
    assert.equal((decideEdit(CONSULTATION_ACTORS.CLIENT, closed, ["summary"], AT) as any).code, "FORBIDDEN");
    // The agent side on a closed booking is 409.
    assert.equal((decideEdit(CONSULTATION_ACTORS.AGENT_SIDE, closed, ["summary"], AT) as any).code, "BOOKING_NOT_EDITABLE");
  });
});

// ============================================
// Value checks
// ============================================

/** Bad values per field: each must be answered 400, never stored, never a 500. */
const BAD_VALUES: Record<EditableField, unknown[]> = {
  scheduledDate: ["not a date", "", "   ", "2026-13-45", 1764547200000, null, {}, true],
  scheduledTime: [
    "9:30", "24:00", "12:60", "2pm", "10:30:00", " 10:30", 1030, null,
    // 12-hour forms that are still wrong.
    "13:00 PM", "0:30 AM", "00:30 AM", "12:60 PM", "12:00  PM", "12:00 XM", "12:00 P.M.", "12 PM", "9:30 AM ", "AM 9:30",
  ],
  durationMinutes: [4, 481, 0, -30, 30.5, "30", NaN, Infinity, null],
  timezone: ["", "   ", 1, null, {}],
  meetingLink: ["http://meet.example.test/x", "meet.example.test/x", "javascript:alert(1)", "", 5, null],
  meetingPlatform: ["skype", "Zoom", "", 1, null],
  type: ["chat", "Initial", "", 1, null],
  summary: [5, null, {}, ["notes"], "x".repeat(5001)],
};

describe("parseEditBody", () => {
  test("valid values are kept, and scheduledDate becomes a Timestamp", () => {
    const parsed = parseEditBody(VALID);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.deepEqual(parsed.fieldNames, ALL_FIELDS);
    assert.ok(parsed.updates.scheduledDate instanceof Timestamp);
    assert.equal((parsed.updates.scheduledDate as Timestamp).toMillis(), Date.parse("2026-12-01"));
    const { scheduledDate: _date, ...rest } = parsed.updates;
    const { scheduledDate: _validDate, ...validRest } = VALID;
    assert.deepEqual(rest, validRest);
  });

  test("scheduledTime: 24-hour is kept, 12-hour is stored as 24-hour HH:mm", () => {
    const cases: Array<[string, string]> = [
      ["00:00", "00:00"], ["09:05", "09:05"], ["23:59", "23:59"],
      ["12:00 AM", "00:00"], ["12:30 AM", "00:30"], ["12:00 PM", "12:00"], ["12:45 PM", "12:45"],
      ["1:00 AM", "01:00"], ["9:30 AM", "09:30"], ["11:59 AM", "11:59"],
      ["1:05 PM", "13:05"], ["6:00 PM", "18:00"], ["11:59 PM", "23:59"],
      // Leading zero, letter case and the space are all optional.
      ["09:30 AM", "09:30"], ["9:30 am", "09:30"], ["9:30AM", "09:30"], ["03:15pm", "15:15"], ["3:15 Pm", "15:15"],
    ];
    for (const [sent, storedAs] of cases) {
      assert.equal(normalizeScheduledTime(sent), storedAs, sent);
      const parsed = parseEditBody({ scheduledTime: sent });
      assert.equal(parsed.ok, true, sent);
      if (parsed.ok) assert.equal(parsed.updates.scheduledTime, storedAs, sent);
    }
    for (const bad of BAD_VALUES.scheduledTime) assert.equal(normalizeScheduledTime(bad), null, String(bad));
  });

  test("the limits themselves are accepted", () => {
    for (const body of [
      { durationMinutes: 5 }, { durationMinutes: 480 }, { scheduledTime: "00:00" }, { scheduledTime: "23:59" },
      { summary: "" }, { summary: "x".repeat(5000) }, { scheduledDate: "2026-12-01T10:00:00.000Z" },
    ]) {
      assert.equal(parseEditBody(body).ok, true, JSON.stringify(body).slice(0, 60));
    }
  });

  test("fields outside the editable list are dropped", () => {
    const parsed = parseEditBody({
      summary: "s", status: "scheduled", userId: "x", agentId: "x", agencyId: "x", fee: 1, priceUsdCents: 1,
      paymentStatus: "paid", transactionId: "x", id: "x", createdAt: "x", updatedAt: "x", quoteExpiresAt: "x",
    });
    assert.equal(parsed.ok, true);
    if (parsed.ok) assert.deepEqual(parsed.updates, { summary: "s" });
  });

  test("no editable field (or no body at all) is refused", () => {
    for (const body of [undefined, null, {}, [], "summary", 7, { status: "scheduled", fee: 0 }, { summary: undefined }]) {
      assert.equal(parseEditBody(body).ok, false, JSON.stringify(body));
    }
  });

  for (const field of ALL_FIELDS) {
    test(`bad ${field} values are refused`, () => {
      for (const value of BAD_VALUES[field]) {
        const parsed = parseEditBody({ [field]: value });
        assert.equal(parsed.ok, false, `${field}=${String(value).slice(0, 30)}`);
        if (!parsed.ok) assert.match(parsed.message, new RegExp(field));
      }
    });
  }
});

// ============================================
// The route: agent side, field by field and status by status
// ============================================

describe("PUT /consultations/:id — agent side (agent, agency owner, admin)", () => {
  for (const status of CONSULTATION_STATUSES) {
    for (const field of ALL_FIELDS) {
      const allowed = TABLE[status].includes(field);
      test(`${status}, ${field}: ${allowed ? "saved" : "409 BOOKING_NOT_EDITABLE"}`, async () => {
        for (const p of AGENT_SIDE) {
          harness.reset();
          notified.length = 0;
          await seedBooking(status);
          const before = stored();
          const out = await edit(p, { [field]: VALID[field] });
          const label = `${p.uid} ${status} ${field}`;
          if (allowed) {
            assertOk(out, label);
            const after = stored();
            const expected = field === "scheduledDate" ? Date.parse("2026-12-01") : VALID[field];
            const got = field === "scheduledDate" ? after.scheduledDate.toMillis() : after[field];
            assert.equal(got, expected, label);
            assert.equal(out.body.data.id, "c1", label);
            assert.equal(out.body.data.status, status, label);
          } else {
            assertRefused(out, 409, "BOOKING_NOT_EDITABLE", label, before);
          }
        }
      });
    }
  }

  test("scheduled / confirmed / unpaid with no checkout: every field in one body is saved", async () => {
    for (const status of ["scheduled", "confirmed", "pending_payment"] as ConsultationStatus[]) {
      for (const p of AGENT_SIDE) {
        harness.reset();
        await seedBooking(status);
        const out = await edit(p, VALID);
        assertOk(out, `${p.uid} ${status}`);
        const after = stored();
        for (const field of ALL_FIELDS.filter((f) => f !== "scheduledDate")) {
          assert.equal(after[field], VALID[field], `${status} ${field}`);
          assert.equal(out.body.data[field], VALID[field], `${status} ${field} in the response`);
        }
        assert.equal(after.scheduledDate.toMillis(), Date.parse("2026-12-01"));
      }
    }
  });

  test("in_progress: meeting fields and summary together are saved; adding a schedule field refuses it all", async () => {
    await seedBooking("in_progress");
    const body = { meetingLink: VALID.meetingLink, meetingPlatform: VALID.meetingPlatform, type: VALID.type, summary: VALID.summary };
    assertOk(await edit(agent, body), "meeting + summary");
    assert.equal(stored().meetingLink, VALID.meetingLink);

    harness.reset();
    await seedBooking("in_progress");
    const before = stored();
    assertRefused(await edit(agent, { ...body, scheduledTime: "16:00" }), 409, "BOOKING_NOT_EDITABLE", "mixed", before);
  });

  test("completed: only summary is saved; summary plus another field refuses it all", async () => {
    await seedBooking("completed");
    assertOk(await edit(ownerA, { summary: "Wrapped up" }), "summary");
    assert.equal(stored().summary, "Wrapped up");

    harness.reset();
    await seedBooking("completed");
    const before = stored();
    assertRefused(await edit(ownerA, { summary: "x", meetingLink: VALID.meetingLink }), 409, "BOOKING_NOT_EDITABLE", "mixed", before);
  });

  test("an independent agent (no agency on either side) can edit their own booking", async () => {
    await seedBooking("scheduled", { agencyId: undefined });
    assertOk(await edit({ uid: "uid-agent1", role: ROLES.AGENT, agencyId: null }, { summary: "solo" }), "independent");
    // An owner with no agency never matches a booking with no agency.
    harness.reset();
    await seedBooking("scheduled", { agencyId: undefined });
    assertRefused(
      await edit({ uid: "uid-owner-x", role: ROLES.OWNER, agencyId: null }, { summary: "x" }),
      403, "FORBIDDEN", "owner without agency", stored()
    );
  });
});

// ============================================
// The route: everyone else
// ============================================

describe("PUT /consultations/:id — the client and non-parties", () => {
  for (const status of CONSULTATION_STATUSES) {
    test(`${status}: the booking's client gets 403 FORBIDDEN for every field`, async () => {
      await seedBooking(status);
      const before = stored();
      for (const field of ALL_FIELDS) {
        assertRefused(await edit(client, { [field]: VALID[field] }), 403, "FORBIDDEN", `${status} ${field}`, before);
      }
      assertRefused(await edit(client, VALID), 403, "FORBIDDEN", `${status} all fields`, before);
    });

    test(`${status}: a same-agency colleague, another client, another agency's owner and agent get 403`, async () => {
      await seedBooking(status);
      const before = stored();
      for (const p of OUTSIDERS) {
        assertRefused(await edit(p, { summary: "x" }), 403, "FORBIDDEN", `${p.uid} ${status}`, before);
        assertRefused(await edit(p, { scheduledDate: "2026-12-01", scheduledTime: "11:00" }), 403, "FORBIDDEN", `${p.uid} ${status}`, before);
      }
    });
  }

  test("an unknown id is 404 NOT_FOUND for everyone", async () => {
    await seedBooking("scheduled");
    for (const p of [client, ...AGENT_SIDE, ...OUTSIDERS]) {
      assertRefused(await edit(p, { summary: "x" }, "nope"), 404, "NOT_FOUND", p.uid);
    }
  });
});

// ============================================
// Former agents (issue #321): the edit route uses the same party rule
// ============================================

describe("PUT /consultations/:id — a former agent (#321)", () => {
  /** The booking's `agentId`, whose role has gone back to client. */
  const formerAgent: AuthzSubject = { uid: "uid-agent1", role: ROLES.CLIENT, agencyId: null };

  test("role client on the booking's agentId: 403 for every field, nothing written", async () => {
    await seedBooking("scheduled");
    const before = stored();
    for (const field of ALL_FIELDS) {
      assertRefused(await edit(formerAgent, { [field]: VALID[field] }), 403, "FORBIDDEN", `former agent ${field}`, before);
    }
  });

  test("a former agent who is also the booking's userId is its client: still 403 (a client edits nothing)", async () => {
    await seedBooking("scheduled", { userId: "uid-agent1" });
    const before = stored();
    assertRefused(await edit(formerAgent, { summary: "x" }), 403, "FORBIDDEN", "former agent as client", before);
  });

  test("the same uid with role agent or owner (no agency on the principal) still edits", async () => {
    for (const role of [ROLES.AGENT, ROLES.OWNER]) {
      harness.reset();
      await seedBooking("scheduled");
      assertOk(await edit({ uid: "uid-agent1", role, agencyId: null }, { summary: "new notes" }), role);
      assert.equal(stored().summary, "new notes", role);
    }
  });
});

// ============================================
// Input
// ============================================

describe("PUT /consultations/:id — input", () => {
  test("a body with no editable field is 400 VALIDATION_ERROR", async () => {
    await seedBooking("scheduled");
    const before = stored();
    for (const body of [{}, undefined, { status: "completed" }, { fee: 0, paymentStatus: "paid" }]) {
      assertRefused(await edit(agent, body), 400, "VALIDATION_ERROR", JSON.stringify(body), before);
    }
  });

  for (const field of ALL_FIELDS) {
    test(`bad ${field}: 400 VALIDATION_ERROR, nothing written`, async () => {
      await seedBooking("scheduled");
      const before = stored();
      for (const value of BAD_VALUES[field]) {
        // A good field next to the bad one must not be saved either.
        const companion = field === "summary" ? { type: "general" } : { summary: "should not be stored" };
        const out = await edit(agent, { ...companion, [field]: value });
        assertRefused(out, 400, "VALIDATION_ERROR", `${field}=${String(value).slice(0, 30)}`, before);
      }
    });
  }

  test("a scheduledDate that does not parse is 400, not the old 500", async () => {
    await seedBooking("scheduled");
    const out = await edit(agent, { scheduledDate: "next tuesday-ish" });
    assertRefused(out, 400, "VALIDATION_ERROR", "bad date", stored());
  });

  test("fields outside the editable list never reach Firestore", async () => {
    await seedBooking("scheduled");
    const before = stored();
    const out = await edit(agent, {
      summary: "kept",
      status: "completed", userId: "uid-evil", agentId: "uid-evil", agencyId: "agency-evil",
      fee: 1, priceUsdCents: 999, chargedAmountMinor: 1, chargedCurrency: "USD", paymentStatus: "refunded",
      transactionId: "ref-evil", quoteExpiresAt: "2030-01-01", id: "c2", createdAt: "2020-01-01", updatedAt: "2020-01-01",
    });
    assertOk(out, "edit");
    // Exactly one write, holding only the editable field and updatedAt.
    assert.equal(writes.length, 1);
    assert.deepEqual(Object.keys(writes[0].data).sort(), ["summary", "updatedAt"]);
    const after = stored();
    assert.deepEqual({ ...after, summary: before.summary, updatedAt: before.updatedAt }, before);
    assert.equal(after.summary, "kept");
  });

  test("a save sets updatedAt to now and leaves id, createdAt and the money fields alone (the open checkout is retired, #354)", async () => {
    await seedInFlight(-1_000); // unpaid, lock already passed: every field is editable
    const before = stored();
    harness.clock.advanceHours(2);
    assertOk(await edit(agent, VALID), "edit");
    const after = stored();
    assert.equal(after.updatedAt.toMillis(), harness.clock.now().getTime());
    for (const untouched of [
      "id", "createdAt", "status", "userId", "agentId", "agencyId", "paymentStatus",
      "priceUsdCents", "chargedCurrency", "chargedAmountMinor", "quoteLockedAt", "quoteExpiresAt",
    ]) {
      assert.deepEqual(after[untouched], before[untouched], untouched);
    }
    // Issue #354: this is a reschedule of an unpaid booking after its lock,
    // so its checkout is retired in the same write (no checkout for the old slot stays open).
    assert.equal(after.transactionId, undefined);
    assert.equal(after.checkoutUrl, undefined);
    assert.equal(after.supersededCheckouts.at(-1).reference, before.transactionId);
    assert.equal(after.supersededCheckouts.at(-1).retiredBy, "reschedule");
    // Issue #405: the move also restarts the 24-hour payment grace, from now.
    assert.equal(after.paymentGraceStartsAt.toMillis(), harness.clock.now().getTime());
    // Issue #411: the move is counted and takes the booking out of the sweep's set-aside.
    assert.equal(after.graceRestartCount, 1);
    assert.equal(after.sweepSetAside, false);
    assert.deepEqual(
      Object.keys(writes[0].data).sort(),
      [
        ...ALL_FIELDS, "updatedAt", "supersededCheckouts", "transactionId", "checkoutUrl", "paymentGraceStartsAt",
        "graceRestartCount", "sweepSetAside",
      ].sort()
    );
  });
});

// ============================================
// Order of checks
// ============================================

describe("PUT /consultations/:id — order of checks: 400, 404, 403, 409", () => {
  test("a bad body is 400 before the booking is looked up, for anyone", async () => {
    await seedBooking("cancelled");
    for (const p of [client, agent, otherClient]) {
      // Unknown id + bad body: 400, not 404.
      assertRefused(await edit(p, { durationMinutes: 1 }, "nope"), 400, "VALIDATION_ERROR", `${p.uid} unknown id`);
      // Existing closed booking + bad body: 400, not 403 / 409.
      assertRefused(await edit(p, {}, "c1"), 400, "VALIDATION_ERROR", `${p.uid} empty`);
    }
  });

  test("an unknown id is 404 before the caller's party is judged", async () => {
    assertRefused(await edit(otherClient, { summary: "x" }, "nope"), 404, "NOT_FOUND", "outsider");
  });

  test("the client and a non-party are 403 before the status is looked at (closed or mid-payment)", async () => {
    await seedBooking("cancelled");
    assertRefused(await edit(client, { summary: "x" }), 403, "FORBIDDEN", "client, cancelled");
    assertRefused(await edit(colleague, { summary: "x" }), 403, "FORBIDDEN", "colleague, cancelled");
    harness.reset();
    await seedInFlight();
    assertRefused(await edit(client, { scheduledTime: "11:00" }), 403, "FORBIDDEN", "client, in flight");
  });
});

// ============================================
// Payment in flight
// ============================================

describe("PUT /consultations/:id — while a payment is in flight", () => {
  test("any schedule field is 409 PAYMENT_IN_PROGRESS for the agent, the owner and an admin", async () => {
    for (const p of AGENT_SIDE) {
      for (const field of SCHEDULE) {
        harness.reset();
        await seedInFlight();
        const before = stored();
        assertRefused(await edit(p, { [field]: VALID[field] }), 409, "PAYMENT_IN_PROGRESS", `${p.uid} ${field}`, before);
      }
    }
  });

  test("a schedule field next to allowed fields refuses the whole body", async () => {
    await seedInFlight();
    const before = stored();
    assertRefused(await edit(agent, { summary: "x", scheduledTime: "11:00" }), 409, "PAYMENT_IN_PROGRESS", "mixed", before);
  });

  test("meeting fields and summary are still saved", async () => {
    await seedInFlight();
    const body = { meetingLink: VALID.meetingLink, meetingPlatform: VALID.meetingPlatform, type: VALID.type, summary: VALID.summary };
    assertOk(await edit(agent, body), "meeting + summary");
    const after = stored();
    assert.equal(after.meetingLink, VALID.meetingLink);
    assert.equal(after.summary, VALID.summary);
    assert.equal(after.status, "pending_payment");
    assert.deepEqual(notified, [], "not a reschedule: nobody is notified");
  });

  test("the lock boundary: refused one second before quoteExpiresAt, saved one second after", async () => {
    await seedInFlight(1_000); // the lock ends in one second
    const before = stored();
    assertRefused(await edit(agent, { scheduledTime: "11:00" }), 409, "PAYMENT_IN_PROGRESS", "1s before", before);

    harness.reset();
    await seedInFlight(-1_000); // the lock ended one second ago
    assertOk(await edit(agent, { scheduledTime: "11:00" }), "1s after");
    assert.equal(stored().scheduledTime, "11:00");
  });

  test("no checkout opened (no transactionId), or a legacy row with no lock: the reschedule is saved", async () => {
    await seedInFlight(30 * 60_000, { transactionId: undefined, checkoutUrl: undefined });
    assertOk(await edit(agent, { scheduledTime: "11:00" }), "no checkout");

    harness.reset();
    await seedBooking("pending_payment", { transactionId: "ref-legacy", fee: 50_000 });
    assertOk(await edit(ownerA, { scheduledTime: "11:00" }), "legacy");
  });
});

// ============================================
// An edit racing a payment
// ============================================

describe("PUT /consultations/:id — an edit racing a payment", () => {
  /** A real guest booking on agency A's page: priced, quote locked, checkout opened. */
  async function bookAndOpenCheckout(): Promise<{ id: string; reference: string }> {
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
    const out = { id: booked.out.body.data.consultationId as string, reference: booked.out.body.data.reference as string };
    writes.length = 0;
    notified.length = 0;
    return out;
  }

  /** The guest pays and the app verifies the reference. */
  async function verify(reference: string) {
    const verified = captureRes();
    await consultationController.verifyPublicConsultation({ body: { reference } } as any, verified.res);
    return verified.out;
  }

  test("a reschedule that arrives while the payment is being verified is refused; the paid booking keeps its time", async () => {
    const { id, reference } = await bookAndOpenCheckout();
    paystackPaid(reference, id, { amountMinor: 15_000_000, currency: "NGN" });

    // While verify is waiting on Paystack, the owner tries to move the booking.
    let racing: { status: number; body: any } | undefined;
    harness.onLookup = async () => {
      harness.onLookup = undefined;
      racing = await edit(ownerA, { scheduledDate: "2026-12-05", scheduledTime: "16:00" }, id);
      return undefined;
    };
    const verified = await verify(reference);

    assert.equal(racing?.status, 409, JSON.stringify(racing?.body));
    assert.equal(racing?.body.error, "PAYMENT_IN_PROGRESS");
    assert.ok(verified.status === 0 || verified.status === 200, JSON.stringify(verified.body));
    const after = stored(id);
    assert.equal(after.status, "scheduled");
    assert.equal(after.paymentStatus, "paid");
    assert.equal(after.scheduledTime, "10:00", "the time the client paid for");
    assert.equal(docsIn("transactions").length, 1);
    assert.ok(!notified.some((n) => n.type === "consultation_rescheduled"), "the refused reschedule notified nobody");
  });

  test("fired together: the payment always lands, and the edit is judged on one side of it or the other", async () => {
    for (const editFirst of [true, false]) {
      harness.reset();
      notified.length = 0;
      const { id, reference } = await bookAndOpenCheckout();
      paystackPaid(reference, id, { amountMinor: 15_000_000, currency: "NGN" });

      const body = { scheduledDate: "2026-12-05", scheduledTime: "16:00" };
      const [edited] = editFirst
        ? await Promise.all([edit(ownerA, body, id), verify(reference)])
        : (await Promise.all([verify(reference), edit(ownerA, body, id)])).reverse();

      const after = stored(id);
      // The payment is never lost, whichever ran first.
      assert.equal(after.status, "scheduled", `editFirst=${editFirst}`);
      assert.equal(after.paymentStatus, "paid");
      assert.equal(docsIn("transactions").length, 1);
      if (edited.status === 409) {
        // Decided before the payment landed: refused, the time is untouched.
        assert.equal(edited.body.error, "PAYMENT_IN_PROGRESS");
        assert.equal(after.scheduledTime, "10:00");
      } else {
        // Decided after the payment landed: an ordinary reschedule of a
        // SCHEDULED booking (never a write on top of a half-paid one).
        assertOk(edited, `editFirst=${editFirst}`);
        assert.equal(edited.body.data.status, "scheduled");
        assert.equal(edited.body.data.paymentStatus, "paid");
        assert.equal(after.scheduledTime, "16:00");
      }
    }
  });

  test("after the payment has landed the reschedule goes through and keeps the payment", async () => {
    const { id, reference } = await bookAndOpenCheckout();
    paystackPaid(reference, id, { amountMinor: 15_000_000, currency: "NGN" });
    await verify(reference);
    const paid = stored(id);

    assertOk(await edit(ownerA, { scheduledDate: "2026-12-05", scheduledTime: "16:00" }, id), "reschedule");
    const after = stored(id);
    assert.equal(after.scheduledTime, "16:00");
    for (const money of ["status", "paymentStatus", "transactionId", "priceUsdCents", "chargedAmountMinor", "chargedCurrency"]) {
      assert.deepEqual(after[money], paid[money], money);
    }
  });
});

// ============================================
// Notifications
// ============================================

describe("PUT /consultations/:id — notifications", () => {
  test("the booking's agent reschedules: only the client is told", async () => {
    for (const field of SCHEDULE) {
      harness.reset();
      notified.length = 0;
      await seedBooking("scheduled");
      assertOk(await edit(agent, { [field]: VALID[field] }), field);
      assert.deepEqual(notified, [{ userId: "uid-client1", type: "consultation_rescheduled" }], field);
    }
  });

  test("the agency owner or an admin reschedules: the client AND the booking's agent are told", async () => {
    for (const p of [ownerA, admin]) {
      harness.reset();
      notified.length = 0;
      await seedBooking("confirmed");
      assertOk(await edit(p, { scheduledDate: "2026-12-01", scheduledTime: "11:00" }), p.uid);
      assert.deepEqual(
        notified,
        [
          { userId: "uid-client1", type: "consultation_rescheduled" },
          { userId: "uid-agent1", type: "consultation_rescheduled" },
        ],
        p.uid
      );
    }
  });

  test("resending the schedule the booking already has saves, but notifies nobody", async () => {
    // Same instant, same time (24-hour and its 12-hour label), same length, same zone.
    const same = [
      { scheduledDate: T0.toDate().toISOString(), scheduledTime: "10:00" },
      { scheduledDate: T0.toDate().toISOString(), scheduledTime: "10:00 AM" },
      { scheduledTime: "10:00 am", durationMinutes: 30, timezone: "Africa/Lagos" },
    ];
    for (const p of AGENT_SIDE) {
      for (const body of same) {
        harness.reset();
        notified.length = 0;
        await seedBooking("scheduled");
        harness.clock.advanceHours(1);
        assertOk(await edit(p, body), `${p.uid} ${JSON.stringify(body)}`);
        // It was saved (updatedAt moved, the time is stored as HH:mm) ...
        assert.equal(writes.length, 1);
        assert.equal(stored().updatedAt.toMillis(), harness.clock.now().getTime());
        assert.equal(stored().scheduledTime, "10:00");
        // ... but nothing moved, so nobody is told it was rescheduled.
        assert.deepEqual(notified, [], `${p.uid} ${JSON.stringify(body)}`);
      }
    }
  });

  test("one schedule value that really changes, next to unchanged ones, still notifies", async () => {
    await seedBooking("scheduled");
    // The portal always sends date and time together: same day, new time.
    assertOk(await edit(ownerA, { scheduledDate: T0.toDate().toISOString(), scheduledTime: "2:30 PM" }), "new time");
    assert.equal(stored().scheduledTime, "14:30");
    assert.deepEqual(notified, [
      { userId: "uid-client1", type: "consultation_rescheduled" },
      { userId: "uid-agent1", type: "consultation_rescheduled" },
    ]);
  });

  test("an edit that is not a schedule change notifies nobody", async () => {
    await seedBooking("scheduled");
    assertOk(await edit(ownerA, { meetingLink: VALID.meetingLink, type: "general", summary: "x" }), "meeting");
    assert.deepEqual(notified, []);
  });

  test("a failing notification does not fail the saved edit", async () => {
    await seedBooking("scheduled");
    const original = (notificationService as any).notifyUser;
    (notificationService as any).notifyUser = async () => {
      throw new Error("push is down");
    };
    try {
      assertOk(await edit(agent, { scheduledTime: "11:00" }), "edit");
      assert.equal(stored().scheduledTime, "11:00");
    } finally {
      (notificationService as any).notifyUser = original;
    }
  });
});

// ============================================
// The portal's reschedule
// ============================================

/**
 * The portal's time picker options, copied from `TIME_OPTIONS` in
 * seli-portal/src/components/appointments/AppointmentDetailsModal.tsx, each
 * with the 24-hour value it must be stored as.
 */
const PORTAL_TIME_OPTIONS: Array<[label: string, storedAs: string]> = [
  ["8:00 AM", "08:00"], ["8:30 AM", "08:30"], ["9:00 AM", "09:00"], ["9:30 AM", "09:30"],
  ["10:00 AM", "10:00"], ["10:30 AM", "10:30"], ["11:00 AM", "11:00"], ["11:30 AM", "11:30"],
  ["12:00 PM", "12:00"], ["12:30 PM", "12:30"], ["1:00 PM", "13:00"], ["1:30 PM", "13:30"],
  ["2:00 PM", "14:00"], ["2:30 PM", "14:30"], ["3:00 PM", "15:00"], ["3:30 PM", "15:30"],
  ["4:00 PM", "16:00"], ["4:30 PM", "16:30"], ["5:00 PM", "17:00"], ["5:30 PM", "17:30"],
  ["6:00 PM", "18:00"],
];

describe("PUT /consultations/:id — the portal appointments page reschedule", () => {
  // seli-portal: updateConsultation(id, { scheduledDate, scheduledTime }).
  // The date is an <input type="date"> ("YYYY-MM-DD"); the time is a
  // <select> over TIME_OPTIONS, so a 12-hour LABEL ("12:00 PM" by default).
  test("every time the picker offers is saved as HH:mm, for the booking's agent and the agency owner", async () => {
    for (const p of [agent, ownerA]) {
      for (const [label, storedAs] of PORTAL_TIME_OPTIONS) {
        harness.reset();
        notified.length = 0;
        await seedBooking("scheduled");
        const out = await edit(p, { scheduledDate: "2026-11-20", scheduledTime: label });
        assertOk(out, `${p.uid} ${label}`);
        const after = stored();
        assert.ok(after.scheduledDate instanceof Timestamp);
        assert.equal(after.scheduledDate.toMillis(), Date.parse("2026-11-20"));
        assert.equal(after.scheduledTime, storedAs, label);
        assert.equal(out.body.data.scheduledTime, storedAs, label);
        // The client is told; the agent too when the owner did it.
        assert.equal(notified.filter((n) => n.userId === "uid-client1").length, 1, label);
        assert.equal(notified.filter((n) => n.userId === "uid-agent1").length, p === ownerA ? 1 : 0, label);
      }
    }
  });

  test("the same body on a confirmed booking works too", async () => {
    for (const p of [agent, ownerA]) {
      harness.reset();
      await seedBooking("confirmed");
      assertOk(await edit(p, { scheduledDate: "2026-11-20", scheduledTime: "12:00 PM" }), p.uid);
      assert.equal(stored().scheduledTime, "12:00");
    }
  });
});
