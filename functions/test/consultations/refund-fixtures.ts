// ============================================
// Shared fixtures for the consultation refund tests (issue #317). Not a test file.
// ============================================
//
// Built on the consultation harness (in-memory Firestore, Paystack stubbed:
// `initializeCharge`, `getTransactionMetadata`, `createRefund`,
// `findRefundsForTransaction` are recorders; nothing reaches the network).
// A paid booking is made the real way: a pending, priced booking is seeded,
// "Paystack" reports its checkout paid, and `settlePayment` (what verify and
// the sweep call) confirms it and writes the fee Transaction with its hold.

import assert from "node:assert/strict";
import * as crypto from "crypto";
import { Timestamp } from "firebase-admin/firestore";
import { defineAbilitiesFor, ROLES } from "@durin-tech/authz";
import type { AuthzSubject } from "@durin-tech/authz";

import { harness, captureRes, docsIn, seed, paystackPaid, T0 } from "./harness";
import { settlePayment } from "../../src/services/consultation-charge.service";
import { consultationController } from "../../src/controllers/consultation.controller";
import { transactionController } from "../../src/controllers/transaction.controller";
import { bankAccountController } from "../../src/controllers/bank-account.controller";
import { entitlementController } from "../../src/controllers/entitlement.controller";
import type { Money } from "../../src/types/money";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ============================================
// Principals
// ============================================

/** The booking's client. */
export const client: AuthzSubject = { uid: "uid-client1", role: ROLES.CLIENT, agencyId: null };
/** The booking's agent (a member of agency A). */
export const agent: AuthzSubject = { uid: "uid-agent1", role: ROLES.AGENT, agencyId: "agency-a" };
/** The owner of the booking's agency (not the booking's agent). */
export const ownerA: AuthzSubject = { uid: "uid-owner-a", role: ROLES.OWNER, agencyId: "agency-a" };
/** A platform admin. */
export const admin: AuthzSubject = { uid: "uid-admin", role: ROLES.ADMIN, agencyId: null };

/** A request for `p` as verifyAuth leaves it. */
export function reqFor(p: AuthzSubject, extra: Record<string, unknown> = {}): any {
  return { userId: p.uid, authz: p, ability: defineAbilitiesFor(p), entitlements: null, query: {}, params: {}, body: {}, ...extra };
}

// ============================================
// Times (the harness clock starts at 2026-11-13T09:00:00Z)
// ============================================

/**
 * Every booking here is on 2026-11-20 at 10:00 in Africa/Lagos (UTC+1), so
 * its slot STARTS at 2026-11-20T09:00:00Z: exactly 168 hours after the
 * harness's "now". It lasts 30 minutes.
 */
export const SLOT_DAY = Timestamp.fromDate(new Date("2026-11-20T00:00:00Z"));
export const SLOT_TIME = "10:00";
export const SLOT_ZONE = "Africa/Lagos";
export const SLOT_START_ISO = "2026-11-20T09:00:00.000Z";
/** Hours from the harness's "now" to the slot start. */
export const HOURS_TO_SLOT = 168;

// ============================================
// Money
// ============================================

/** The fee every paid booking is charged: ₦9,000.00 in kobo ($6 at ₦1,500). */
export const FEE_NGN: Money = { amountMinor: 900_000, currency: "NGN" };

/** The Paystack reference of booking `id`'s checkout. */
export function refOf(id: string): string {
  return `cons-${id}-ref`;
}

/**
 * Seed a pending, priced booking for client 1 with agent 1 (agency A) and
 * settle its payment through `settlePayment`, as verify does. Returns the
 * fee Transaction that was written.
 */
export async function bookAndPay(
  id = "c1",
  opts: { charge?: Money; over?: Record<string, unknown> } = {}
): Promise<Record<string, any>> {
  const charge = opts.charge ?? FEE_NGN;
  const reference = refOf(id);
  await seed("consultations", id, {
    userId: client.uid,
    agentId: agent.uid,
    agencyId: "agency-a",
    clientName: "Chi Client",
    clientEmail: "delivered+client1@resend.dev",
    agentName: "Ada Agent",
    type: "initial",
    scheduledDate: SLOT_DAY,
    scheduledTime: SLOT_TIME,
    durationMinutes: 30,
    timezone: SLOT_ZONE,
    status: "pending_payment",
    paymentStatus: "pending",
    priceUsdCents: 600,
    chargedCurrency: charge.currency,
    chargedAmountMinor: charge.amountMinor,
    fxRate: 1500,
    fxRateAsOf: T0,
    fxRateSource: "cbn",
    fxMarginBps: 0,
    quoteLockedAt: T0,
    quoteExpiresAt: Timestamp.fromMillis(T0.toMillis() + 30 * 60_000),
    transactionId: reference,
    checkoutUrl: `https://checkout.paystack.test/${reference}`,
    createdAt: T0,
    updatedAt: T0,
    ...(opts.over ?? {}),
  });
  paystackPaid(reference, id, charge);
  const outcome = await settlePayment(id, reference, harness.paystack.get(reference)!);
  assert.equal(outcome?.kind, "confirmed", "the payment settles the booking");
  return feeOf(id)!;
}

/** Seed a FREE booking ($0: stored paid, no Paystack). */
export async function bookFree(id = "free1", over: Record<string, unknown> = {}): Promise<void> {
  await seed("consultations", id, {
    userId: client.uid, agentId: agent.uid, agencyId: "agency-a", clientName: "Chi Client",
    clientEmail: "delivered+client1@resend.dev", agentName: "Ada Agent", type: "initial",
    scheduledDate: SLOT_DAY, scheduledTime: SLOT_TIME, durationMinutes: 30, timezone: SLOT_ZONE,
    status: "scheduled", paymentStatus: "paid", priceUsdCents: 0, createdAt: T0, updatedAt: T0, ...over,
  });
}

/** The stored consultation_fee Transaction of booking `id`. */
export function feeOf(id: string): Record<string, any> | undefined {
  return docsIn("transactions").map(([, d]) => d).find((d) => d.type === "consultation_fee" && d.consultationId === id);
}

/** Every stored refund row. */
export function refundRows(): Record<string, any>[] {
  return docsIn("transactions").map(([, d]) => d).filter((d) => d.type === "refund");
}

/** The stored booking `id`. */
export function bookingOf(id: string): Record<string, any> | undefined {
  return docsIn("consultations").find(([docId]) => docId === id)?.[1];
}

/** Seed a payment the agent earned that is NOT a consultation fee (available at once). */
export async function seedEarned(id: string, amount: number, currency = "NGN"): Promise<void> {
  await seed("transactions", id, {
    userId: "uid-other-client", agentId: agent.uid, type: "escrow_release", amount, currency,
    status: "released", isEscrow: false, paymentProvider: "paystack", description: "earned",
    createdAt: Timestamp.fromMillis(T0.toMillis() - 86_400_000), updatedAt: T0,
  });
}

// ============================================
// Requests
// ============================================

/** PUT /consultations/:id/status as `p`. */
export async function setStatus(p: AuthzSubject, status: string, id = "c1", body: Record<string, unknown> = {}) {
  const { out, res } = captureRes();
  await consultationController.updateStatus(reqFor(p, { params: { id }, body: { status, ...body } }), res);
  return out;
}

/** PUT /consultations/:id as `p` (an edit / reschedule). */
export async function edit(p: AuthzSubject, body: Record<string, unknown>, id = "c1") {
  const { out, res } = captureRes();
  await consultationController.updateConsultation(reqFor(p, { params: { id }, body }), res);
  return out;
}

/** GET /consultations/:id as `p`. */
export async function getBooking(p: AuthzSubject, id = "c1") {
  const { out, res } = captureRes();
  await consultationController.getConsultation(reqFor(p, { params: { id } }), res);
  return out;
}

/** POST /consultations/:id/refund as `p`. */
export async function adminRefund(p: AuthzSubject, body: Record<string, unknown>, id = "c1") {
  const { out, res } = captureRes();
  await consultationController.refundConsultation(reqFor(p, { params: { id }, body }), res);
  return out;
}

/** GET /transactions/stats as `p`: the row of `currency` (zeros when absent). */
export async function balanceOf(p: AuthzSubject, currency = "NGN") {
  const { out, res } = captureRes();
  await transactionController.getStats(reqFor(p), res);
  assert.equal(out.status, 200);
  const row = (out.body.data.byCurrency as any[]).find((r) => r.currency === currency);
  return row ?? { currency, totalRevenue: 0, pendingPayments: 0, availableBalance: 0, heldBalance: 0 };
}

/** GET /transactions with a query, as `p`. */
export async function listTransactions(p: AuthzSubject, query: Record<string, unknown> = {}) {
  const { out, res } = captureRes();
  await transactionController.getTransactions(reqFor(p, { query }), res);
  return out;
}

/** The agent's bank account (seeded on first use). */
const AGENT_ACCOUNT = "bank-agent1";

/** POST /bank-accounts/withdraw as the agent, for `amount` kobo. */
export async function withdraw(amount: number, p: AuthzSubject = agent) {
  if (!docsIn("bankAccounts").some(([id]) => id === AGENT_ACCOUNT)) {
    await seed("bankAccounts", AGENT_ACCOUNT, {
      userId: p.uid, accountName: "Ada Agent", bankName: "Test Bank", accountNumber: "0123456789",
      isMain: true, createdAt: T0, updatedAt: T0,
    });
  }
  const out: { status: number; body: any } = { status: 0, body: undefined };
  const res: any = { status: (n: number) => ((out.status = n), res), json: (b: unknown) => ((out.body = b), res) };
  await bankAccountController.withdraw(reqFor(p, { body: { bankAccountId: AGENT_ACCOUNT, amount } }), res);
  return out;
}

/** The Paystack secret the webhook tests sign with (a dummy, tests only). */
export const TEST_PAYSTACK_SECRET = "sk_test_refund_engine_dummy";

/** POST /webhooks/paystack with a body signed by `secret`. */
export async function webhook(body: Record<string, unknown>, secret = TEST_PAYSTACK_SECRET) {
  const raw = JSON.stringify(body);
  const signature = crypto.createHmac("sha512", secret).update(raw).digest("hex");
  const out: { status: number; body: any } = { status: 0, body: undefined };
  const res: any = { status: (n: number) => ((out.status = n), res), json: (b: unknown) => ((out.body = b), res) };
  await entitlementController.handlePaystackWebhook(
    { body: Buffer.from(raw, "utf8"), headers: { "x-paystack-signature": signature } } as any,
    res
  );
  return out;
}

/** A Paystack refund webhook body for the charge `reference`. */
export function refundEvent(event: string, reference: string, extra: Record<string, unknown> = {}) {
  return {
    event,
    data: {
      status: event.slice("refund.".length),
      transaction_reference: reference,
      id: "1",
      amount: String(FEE_NGN.amountMinor),
      currency: "NGN",
      ...extra,
    },
  };
}
