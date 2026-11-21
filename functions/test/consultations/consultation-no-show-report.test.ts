// ============================================
// Unit tests: a client reports "the meeting didn't happen" (issue #382)
// ============================================
//
// Hermetic (test/consultations/harness.ts): in-memory Firestore, Paystack
// stubbed (lookups, refund create / list are recorders; nothing reaches the
// network), a fixed clock the tests move.
//
// Decisions under test (user, 2026-11-21): an admin always decides, no
// default; "agent didn't show" is the existing admin_agent_no_show refund
// (full refund, the agent pays Paystack's fee, from the hold); "meeting
// happened" releases the fee with no refund; the fee is frozen until then;
// a report only while the fee is held, after the slot started, once per booking.

import { test, describe, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";
import { ROLES } from "@durin-tech/authz";
import type { AuthzSubject } from "@durin-tech/authz";

import { useHarness, harness, docsIn, captureRes } from "./harness";
import {
  admin, adminRefund, agent, balanceOf, bookAndPay, bookFree, bookingOf, client, feeOf, getBooking, ownerA, refOf,
  refundRows, reqFor, setStatus, withdraw, TEST_PAYSTACK_SECRET,
} from "./refund-fixtures";
import { notificationService } from "../../src/services/notification.service";
import { consultationController } from "../../src/controllers/consultation.controller";
import { consultationRoutes } from "../../src/routes/consultation.routes";
import { NO_SHOW_NOTE_MAX_LENGTH } from "../../src/services/no-show-report.service";
import { CLIENT_CONSULTATION_FIELDS } from "../../src/consultations/client-consultation";
import { toTransactionLookup } from "../../src/services/billing/paystack.provider";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ============================================
// Setup
// ============================================

/** Every notification sent during a test. */
const notified: Array<{ userId: string; type: string; body: string }> = [];
const realError = console.error;
const realWarn = console.warn;
const realSecret = process.env.PAYSTACK_SECRET_KEY;
/** Make every notification throw (a notification failure must never fail the report). */
let notificationsFail = false;

before(async () => {
  await useHarness();
  (notificationService as any).notifyUser = async (n: { userId: string; type: string; body: string }) => {
    if (notificationsFail) throw new Error("push service down");
    notified.push({ userId: n.userId, type: n.type, body: n.body });
  };
});
beforeEach(() => {
  harness.reset();
  notified.length = 0;
  notificationsFail = false;
  process.env.PAYSTACK_SECRET_KEY = TEST_PAYSTACK_SECRET;
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  console.error = () => {};
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  console.warn = () => {};
});
afterEach(() => {
  console.error = realError;
  console.warn = realWarn;
  if (realSecret === undefined) delete process.env.PAYSTACK_SECRET_KEY;
  else process.env.PAYSTACK_SECRET_KEY = realSecret;
});

// ============================================
// Helpers
// ============================================

/** A: ₦9,000.00 in kobo; F: Paystack's fee, ₦150.00. */
const A = 900_000;
const F = 15_000;
/** The slot starts 2026-11-20T09:00Z; it ends 09:30Z; the fee releases 24 h later. */
const SLOT_START_MS = new Date("2026-11-20T09:00:00Z").getTime();
const RELEASE_AT_MS = new Date("2026-11-21T09:30:00Z").getTime();

/** Another client (not the booking's). */
const otherClient: AuthzSubject = { uid: "uid-client2", role: ROLES.CLIENT, agencyId: null };

/** Move the harness clock to `ms`. */
function clockTo(ms: number): void {
  harness.clock.advanceHours((ms - harness.clock.now().getTime()) / 3_600_000);
}

/** POST /consultations/:id/no-show-report as `p`. */
async function report(p: AuthzSubject, body: Record<string, unknown> = {}, id = "c1") {
  const { out, res } = captureRes();
  await consultationController.reportNoShow(reqFor(p, { params: { id }, body }), res);
  return out;
}

/** POST /consultations/:id/no-show-report/resolve as `p`. */
async function resolve(p: AuthzSubject, body: Record<string, unknown>, id = "c1") {
  const { out, res } = captureRes();
  await consultationController.resolveNoShowReport(reqFor(p, { params: { id }, body }), res);
  return out;
}

/** GET /consultations/no-show-reports as `p`. */
async function listReports(p: AuthzSubject, query: Record<string, unknown> = {}) {
  const { out, res } = captureRes();
  await consultationController.listNoShowReports(reqFor(p, { query }), res);
  return out;
}

/** GET /consultations?role=client as the client. */
async function listMine() {
  const { out, res } = captureRes();
  await consultationController.getConsultations(reqFor(client, { query: { role: "client" } }), res);
  return out;
}

/** The stored report of booking `id`. */
function reportOf(id = "c1"): Record<string, any> | undefined {
  return docsIn("noShowReports").find(([docId]) => docId === id)?.[1];
}

/** Every stored Paystack-fee debit. */
function debitRows(): Record<string, any>[] {
  return docsIn("transactions").map(([, d]) => d).filter((d) => d.type === "paystack_fee_debit");
}

/** Everything stored (for "nothing written" checks). */
function snapshot(): string {
  return JSON.stringify([docsIn("transactions"), docsIn("consultations"), docsIn("noShowReports")]);
}

/** A paid booking (A, fee F known), the clock just after its slot started. */
async function paidAndStarted(id = "c1"): Promise<void> {
  await bookAndPay(id, { fees: F });
  clockTo(SLOT_START_MS + 10 * 60_000);
}

/** The agent's whole balance in NGN (held + available). */
async function agentTotal(): Promise<number> {
  const b = await balanceOf(agent);
  return b.heldBalance + b.availableBalance;
}

// ============================================
// Report
// ============================================

describe("POST /consultations/:id/no-show-report", () => {
  test("the booking's client reports: 201; one report at noShowReports/{id}; the fee is frozen; both sides told", async () => {
    await paidAndStarted();
    const out = await report(client, { note: "  The agent never joined.  " });
    assert.equal(out.status, 201, JSON.stringify(out.body));
    assert.equal(out.body.data.noShowReport.status, "open");
    const stored = reportOf()!;
    assert.equal(stored.id, "c1");
    assert.equal(stored.clientId, client.uid);
    assert.equal(stored.agentId, agent.uid);
    assert.equal(stored.agencyId, "agency-a");
    assert.equal(stored.feeTransactionId, feeOf("c1")!.id);
    assert.equal(stored.amountMinor, A);
    assert.equal(stored.currency, "NGN");
    assert.equal(stored.note, "The agent never joined.");
    assert.equal(stored.status, "open");
    assert.ok(stored.createdAt instanceof Timestamp);
    assert.equal(feeOf("c1")!.feeHoldFrozenByReportId, "c1");
    assert.equal(bookingOf("c1")!.noShowReport.status, "open");
    const lock = docsIn("withdrawalLocks").find(([uid]) => uid === agent.uid)![1];
    assert.equal(lock.lastNoShowReportId, "c1", "taken under the agent's withdrawal lock");
    const toAgent = notified.find((n) => n.userId === agent.uid)!;
    assert.equal(toAgent.type, "consultation_no_show_reported");
    assert.ok(toAgent.body.includes("payment is paused"));
    assert.ok(notified.some((n) => n.userId === client.uid && n.type === "consultation_no_show_reported"));
    // The client view answers it, with nothing internal.
    const view = out.body.data.consultation;
    for (const key of Object.keys(view)) assert.ok((CLIENT_CONSULTATION_FIELDS as readonly string[]).includes(key), key);
    assert.equal(view.canReportNoShow, false);
    assert.equal(view.noShowReport.status, "open");
  });

  test("a notification failure never fails the report", async () => {
    await paidAndStarted();
    notificationsFail = true;
    assert.equal((await report(client)).status, 201);
    assert.equal(reportOf()!.status, "open");
  });

  test("authz: agent, owner, another client and an admin get 403 and nothing is written; unknown booking 404; 401 at the route", async () => {
    await paidAndStarted();
    const before = snapshot();
    for (const p of [agent, ownerA, otherClient, admin]) {
      const out = await report(p);
      assert.equal(out.status, 403, String(p.uid));
    }
    assert.equal(snapshot(), before);
    assert.equal((await report(client, {}, "nope")).status, 404);
    for (const path of ["/:id/no-show-report", "/:id/no-show-report/resolve", "/no-show-reports"]) {
      const layer = (consultationRoutes as any).stack.find((l: any) => l.route?.path === path);
      assert.ok(layer, path);
      assert.equal(layer.route.stack[0].name, "verifyAuth", `${path}: 401 without a token`);
    }
    // The list is registered before /:id, so "no-show-reports" is never a booking id.
    const paths = (consultationRoutes as any).stack.filter((l: any) => l.route?.methods.get).map((l: any) => l.route.path);
    assert.ok(paths.indexOf("/no-show-reports") < paths.indexOf("/:id"));
  });

  test("a note that is not text, or too long: 400", async () => {
    await paidAndStarted();
    assert.equal((await report(client, { note: 5 })).status, 400);
    assert.equal((await report(client, { note: "x".repeat(NO_SHOW_NOTE_MAX_LENGTH + 1) })).status, 400);
    assert.equal(reportOf(), undefined);
  });

  test("twice: 409 NO_SHOW_REPORT_EXISTS, nothing written; two at once: one report", async () => {
    await paidAndStarted();
    const [one, two] = await Promise.all([report(client), report(client)]);
    assert.deepEqual([one.status, two.status].sort(), [201, 409]);
    const before = snapshot();
    const again = await report(client);
    assert.equal(again.status, 409);
    assert.equal(again.body.error, "NO_SHOW_REPORT_EXISTS");
    assert.equal(snapshot(), before);
  });

  test("before the slot starts: 409 MEETING_NOT_STARTED", async () => {
    await bookAndPay("c1", { fees: F });
    clockTo(SLOT_START_MS - 1);
    const out = await report(client);
    assert.equal(out.status, 409);
    assert.equal(out.body.error, "MEETING_NOT_STARTED");
  });

  test("a free booking: 409 NOT_PAID", async () => {
    await bookFree("c1");
    clockTo(SLOT_START_MS + 60_000);
    assert.equal((await report(client)).body.error, "NOT_PAID");
  });

  test("after the fee is released (by the clock, or the meeting marked done): 409 FEE_NOT_HELD", async () => {
    await paidAndStarted("c1");
    clockTo(RELEASE_AT_MS);
    assert.equal((await report(client, {}, "c1")).body.error, "FEE_NOT_HELD");

    harness.reset();
    await paidAndStarted("c2");
    assert.equal((await setStatus(agent, "completed", "c2")).status, 200);
    const out = await report(client, {}, "c2");
    assert.equal(out.status, 409);
    assert.equal(out.body.error, "FEE_NOT_HELD");
  });

  test("a refund exists: 409 ALREADY_REFUNDED; cancelled with no refund: 409 BOOKING_CANCELLED", async () => {
    await paidAndStarted("c1");
    assert.equal((await adminRefund(admin, { reason: "goodwill", feeBorneBy: "agent" }, "c1")).status, 201);
    assert.equal((await report(client, {}, "c1")).body.error, "ALREADY_REFUNDED");

    // Late client cancel: no refund (the agent keeps the held fee).
    await bookAndPay("c2", { fees: F });
    clockTo(SLOT_START_MS + 20 * 60_000);
    assert.equal((await setStatus(client, "cancelled", "c2")).status, 200);
    assert.equal((await report(client, {}, "c2")).body.error, "BOOKING_CANCELLED");
  });

  test("the freeze: past releaseAt the fee still counts held, and a withdrawal of it is refused", async () => {
    await paidAndStarted();
    await report(client);
    clockTo(RELEASE_AT_MS + 3 * 24 * 3_600_000);
    const b = await balanceOf(agent);
    assert.equal(b.heldBalance, A - F, "still held");
    assert.equal(b.availableBalance, 0);
    assert.equal((await withdraw(A - F)).status, 400, "the frozen fee cannot be withdrawn");
  });

  test("while open: the agent marking it completed does not release the fee", async () => {
    await paidAndStarted();
    await report(client);
    assert.equal((await setStatus(agent, "completed", "c1")).status, 200);
    harness.clock.advanceHours(1);
    assert.equal((await balanceOf(agent)).heldBalance, A - F, "the freeze wins over the closed meeting");
  });

  test("while open: a client or agent cancel, and a direct admin refund, are refused (409 NO_SHOW_REPORT_OPEN), nothing written", async () => {
    await paidAndStarted();
    await report(client);
    const before = snapshot();
    for (const p of [client, agent, admin]) {
      const out = await setStatus(p, "cancelled", "c1");
      assert.equal(out.status, 409, String(p.uid));
      assert.equal(out.body.error, "NO_SHOW_REPORT_OPEN");
    }
    const direct = await adminRefund(admin, { reason: "agent_no_show" });
    assert.equal(direct.status, 409);
    assert.equal(direct.body.error, "NO_SHOW_REPORT_OPEN");
    assert.equal(snapshot(), before);
    assert.equal(harness.refundCalls.length, 0);
  });

  test("concurrency: a report and a cancel at once: exactly one wins", async () => {
    await paidAndStarted();
    const [r, c] = await Promise.all([report(client), setStatus(agent, "cancelled", "c1")]);
    const reported = r.status === 201;
    const cancelled = c.status === 200;
    assert.ok(reported !== cancelled, `report ${r.status}, cancel ${c.status}`);
    if (reported) assert.equal(refundRows().length, 0);
    else assert.equal(reportOf(), undefined);
  });
});

// ============================================
// The client's booking fields (for #442)
// ============================================

describe("the client view: canReportNoShow and noShowReport", () => {
  test("GET /consultations/:id and GET /consultations?role=client say when a report can be made", async () => {
    await bookAndPay("c1", { fees: F });
    // Before the slot: no.
    let one = await getBooking(client);
    assert.equal(one.body.data.canReportNoShow, false);
    assert.equal(one.body.data.noShowReport, null);
    // Started, fee held: yes, on both routes.
    clockTo(SLOT_START_MS + 60_000);
    one = await getBooking(client);
    assert.equal(one.body.data.canReportNoShow, true);
    let list = await listMine();
    assert.equal(list.body.data.find((c: any) => c.id === "c1").canReportNoShow, true);
    // Reported: no longer; the report's status shows.
    await report(client);
    one = await getBooking(client);
    assert.equal(one.body.data.canReportNoShow, false);
    assert.deepEqual(Object.keys(one.body.data.noShowReport).sort(), ["createdAt", "status"]);
    assert.equal(one.body.data.noShowReport.status, "open");
    list = await listMine();
    assert.equal(list.body.data.find((c: any) => c.id === "c1").noShowReport.status, "open");
    // Nothing internal: no admin id, no agent fee, no freeze.
    const json = JSON.stringify(one.body.data);
    for (const key of ["resolvedBy", "feeTransactionId", "feeHoldFrozenByReportId", "agentCreditMinor", "paystackFeeMinor"]) {
      assert.ok(!json.includes(`"${key}"`), key);
    }
  });

  test("after release the client can no longer report (normal support)", async () => {
    await bookAndPay("c1", { fees: F });
    clockTo(RELEASE_AT_MS + 1);
    assert.equal((await getBooking(client)).body.data.canReportNoShow, false);
  });

  test("the agent side's view carries the stored mirror but never canReportNoShow", async () => {
    await paidAndStarted();
    await report(client);
    const view = await getBooking(agent);
    assert.equal(view.body.data.noShowReport.status, "open");
    assert.equal("canReportNoShow" in view.body.data, false);
  });
});

// ============================================
// Admin list and resolve (for #443)
// ============================================

describe("GET /consultations/no-show-reports (admin)", () => {
  test("open by default, newest first, with the queue's fields; resolved on request; non-admin 403; bad status 400", async () => {
    await bookAndPay("c1", { fees: F });
    await bookAndPay("c2", { fees: F });
    clockTo(SLOT_START_MS + 60_000);
    await report(client, { note: "No one came" }, "c1");
    harness.clock.advanceHours(0.1);
    await report(client, {}, "c2");

    for (const p of [agent, ownerA, client]) assert.equal((await listReports(p)).status, 403);
    assert.equal((await listReports(admin, { status: "all" })).status, 400);

    const open = await listReports(admin);
    assert.equal(open.status, 200);
    assert.deepEqual(open.body.data.map((r: any) => r.consultationId), ["c2", "c1"], "newest first");
    const item = open.body.data[1];
    assert.deepEqual(item.amount, { amountMinor: A, currency: "NGN" });
    assert.equal(item.note, "No one came");
    assert.equal(item.clientName, "Chi Client");
    assert.equal(item.agentName, "Ada Agent");
    assert.equal(item.agencyId, "agency-a");
    assert.equal(item.bookingStatus, "scheduled");
    assert.equal(item.slotStartAt, new Date(SLOT_START_MS).toISOString());
    assert.equal(item.status, "open");
    assert.equal(item.decision, null);
    assert.equal(item.resolvedAt, null);

    await resolve(admin, { decision: "meeting_happened" }, "c1");
    const resolved = await listReports(admin, { status: "resolved" });
    assert.deepEqual(resolved.body.data.map((r: any) => [r.consultationId, r.status, r.decision]), [["c1", "released", "meeting_happened"]]);
    assert.ok(resolved.body.data[0].resolvedAt);
    assert.deepEqual((await listReports(admin)).body.data.map((r: any) => r.consultationId), ["c2"]);
  });
});

describe("POST /consultations/:id/no-show-report/resolve (admin)", () => {
  test("validation and authz: non-admin 403; decision missing or anything else 400; no report 404", async () => {
    await paidAndStarted();
    await report(client);
    for (const p of [agent, ownerA, client]) assert.equal((await resolve(p, { decision: "meeting_happened" })).status, 403);
    assert.equal((await resolve(admin, {})).status, 400, "no default");
    assert.equal((await resolve(admin, { decision: "refund" })).status, 400);
    await bookAndPay("c2", { fees: F });
    assert.equal((await resolve(admin, { decision: "meeting_happened" }, "c2")).status, 404);
    assert.equal(reportOf()!.status, "open");
  });

  test("agent_no_show: full refund out of the hold, the agent pays Paystack's fee once, the freeze lifted in the same commit", async () => {
    await paidAndStarted();
    await report(client);
    notified.length = 0;
    const out = await resolve(admin, { decision: "agent_no_show" });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    const [row] = refundRows();
    assert.equal(row.reason, "admin_agent_no_show");
    assert.equal(row.feeBorneBy, "agent");
    assert.equal(row.amount, A, "the client gets everything back");
    assert.equal(row.refundFundedFrom, "hold");
    assert.equal(debitRows().length, 1);
    assert.equal(debitRows()[0].amount, F);
    assert.deepEqual(harness.refundCalls.map((c) => c.amount), [{ amountMinor: A, currency: "NGN" }]);
    const stored = reportOf()!;
    assert.equal(stored.status, "refunded");
    assert.equal(stored.decision, "agent_no_show");
    assert.equal(stored.resolvedBy, admin.uid);
    assert.equal(stored.refundId, row.id);
    assert.equal(feeOf("c1")!.feeHoldFrozenByReportId, undefined);
    assert.equal(feeOf("c1")!.feeHold.state, "refunded");
    assert.equal(bookingOf("c1")!.noShowReport.status, "refunded");
    assert.equal(out.body.data.noShowReport.status, "refunded");
    assert.equal(out.body.data.refundId, row.id);
    // Agent at -F (the fee once); Seli at 0.
    assert.equal(await agentTotal(), -F);
    assert.ok(notified.some((n) => n.userId === client.uid && n.type === "consultation_no_show_resolved"));
    assert.ok(notified.some((n) => n.userId === agent.uid && n.type === "consultation_no_show_resolved"));
  });

  test("agent_no_show when the refund cannot be written: the report stays open and frozen, the refund's answer (409 / 502)", async () => {
    await bookAndPay("c1", { fees: undefined });
    clockTo(SLOT_START_MS + 60_000);
    await report(client);
    let out = await resolve(admin, { decision: "agent_no_show" });
    assert.equal(out.status, 409);
    assert.equal(out.body.error, "PAYSTACK_FEE_UNKNOWN");
    harness.failNextLookup = true;
    out = await resolve(admin, { decision: "agent_no_show" });
    assert.equal(out.status, 502);
    assert.equal(reportOf()!.status, "open");
    assert.equal(feeOf("c1")!.feeHoldFrozenByReportId, "c1");
    assert.equal(refundRows().length, 0);
    // Once Paystack reports the fee, the same decision goes through.
    const reference = refOf("c1");
    const seen = harness.paystack.get(reference)!;
    harness.paystack.set(reference, toTransactionLookup({ ...seen, paid_at: seen.paidAt, fees: F }));
    out = await resolve(admin, { decision: "agent_no_show" });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(reportOf()!.status, "refunded");
  });

  test("meeting_happened before releaseAt: no refund, no Paystack call; released; the fee releases at its stored time, not earlier", async () => {
    await paidAndStarted();
    await report(client);
    const calls = { refunds: harness.refundCalls.length, lookups: harness.refundLookups.length };
    const out = await resolve(admin, { decision: "meeting_happened" });
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.body.data.noShowReport.status, "released");
    assert.equal(refundRows().length, 0);
    assert.deepEqual({ refunds: harness.refundCalls.length, lookups: harness.refundLookups.length }, calls);
    assert.equal(feeOf("c1")!.feeHoldFrozenByReportId, undefined);
    assert.equal(bookingOf("c1")!.noShowReport.status, "released");
    // Still before releaseAt: held, exactly as without the report.
    assert.equal((await balanceOf(agent)).heldBalance, A - F);
    clockTo(RELEASE_AT_MS);
    assert.equal((await balanceOf(agent)).availableBalance, A - F, "released at its stored time");
  });

  test("meeting_happened after releaseAt: the fee is available at once", async () => {
    await paidAndStarted();
    await report(client);
    clockTo(RELEASE_AT_MS + 24 * 3_600_000);
    assert.equal((await balanceOf(agent)).availableBalance, 0, "frozen");
    await resolve(admin, { decision: "meeting_happened" });
    assert.equal((await balanceOf(agent)).availableBalance, A - F);
    assert.equal((await withdraw(A - F)).status, 201);
  });

  test("resolving twice: 409 NO_SHOW_REPORT_RESOLVED, nothing written; two admins at once: one wins", async () => {
    await paidAndStarted();
    await report(client);
    const [one, two] = await Promise.all([
      resolve(admin, { decision: "agent_no_show" }),
      resolve(admin, { decision: "meeting_happened" }),
    ]);
    const statuses = [one.status, two.status].sort();
    assert.deepEqual(statuses, [200, 409], JSON.stringify([one.body, two.body]));
    const before = snapshot();
    for (const decision of ["agent_no_show", "meeting_happened"]) {
      const again = await resolve(admin, { decision });
      assert.equal(again.status, 409);
      assert.equal(again.body.error, "NO_SHOW_REPORT_RESOLVED");
    }
    assert.equal(snapshot(), before);
    assert.ok(refundRows().length <= 1);
  });

  test("after a resolve the client can no longer report, and cancels are judged as usual again", async () => {
    await paidAndStarted();
    await report(client);
    await resolve(admin, { decision: "meeting_happened" });
    assert.equal((await report(client)).body.error, "NO_SHOW_REPORT_EXISTS");
    assert.equal((await getBooking(client)).body.data.canReportNoShow, false);
    // The report no longer blocks a cancel (the normal rules decide).
    const out = await setStatus(agent, "cancelled", "c1");
    assert.notEqual(out.body.error, "NO_SHOW_REPORT_OPEN");
  });
});
