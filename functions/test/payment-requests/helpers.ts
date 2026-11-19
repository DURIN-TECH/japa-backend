// ============================================
// Test helpers — payment requests in US dollars (issue #181). Not a test file.
// ============================================
//
// Reuses the #180 consultation charge harness (test/consultations/harness.ts)
// as is: the in-memory Firestore with transactions run one at a time (real
// Firestore transactions are serializable), the in-memory #178 rate service
// on a fixed clock (NGN 1500/$, GHS 15/$, KES disabled), and Paystack's
// `initializeCharge` / `getTransactionMetadata` replaced by recorders. NO real
// charge, no network. The shared `chargeRuntime` IS `consultationCharging`,
// so the payment-request path runs on the same stubs.
//
// On top of that this file:
//  - registers the collections the payment-request path touches;
//  - captures notifications (to check the copy) instead of dropping them;
//  - builds requests as verifyAuth leaves them (a real CASL ability);
//  - seeds two agencies' cases and agents, and a client in Nigeria and one
//    in Ghana.

import { defineAbilitiesFor, ROLES } from "@durin-tech/authz";
import type { AuthzSubject } from "@durin-tech/authz";
import { useHarness, harness, seed, T0 } from "../consultations/harness";
import { fakeCollection } from "../helpers/fake-firestore";
import { notificationService } from "../../src/services/notification.service";
import type { Money } from "../../src/types/money";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Every notification sent during a test. */
export const sent: Array<{ userId: string; type: string; title: string; body: string }> = [];

/** Install the harness plus the payment-request collections. Call in `before`. */
export async function usePaymentRequestHarness(): Promise<void> {
  await useHarness();
  const firebase: any = await import("../../src/utils/firebase");
  for (const name of ["paymentRequests", "applications", "paymentRequestExceptions", "conversations"]) {
    firebase.collections[name] = fakeCollection(name);
  }
  (notificationService as any).notifyUser = async (n: any) => {
    sent.push({ userId: n.userId, type: n.type, title: n.title, body: n.body });
  };
}

/** Reset the harness and the captured notifications, then seed the fixtures. */
export async function resetPaymentRequests(): Promise<void> {
  harness.reset();
  sent.length = 0;
  await seedFixtures();
}

// ============================================
// Principals (as verifyAuth leaves them)
// ============================================

export const agentA: AuthzSubject = { uid: "uid-agent-a", role: ROLES.AGENT, agencyId: "agency-a" };
export const colleagueA: AuthzSubject = { uid: "uid-agent-a2", role: ROLES.AGENT, agencyId: "agency-a" };
export const ownerA: AuthzSubject = { uid: "uid-owner-a", role: ROLES.OWNER, agencyId: "agency-a" };
export const agentB: AuthzSubject = { uid: "uid-agent-b", role: ROLES.AGENT, agencyId: "agency-b" };
export const independent: AuthzSubject = { uid: "uid-indie", role: ROLES.AGENT, agencyId: null };
export const clientNg: AuthzSubject = { uid: "uid-client-ng", role: ROLES.CLIENT, agencyId: null };
export const clientGh: AuthzSubject = { uid: "uid-client-gh", role: ROLES.CLIENT, agencyId: null };

/** A request object for `p`, as the auth middleware leaves it. */
export function reqFor(p: AuthzSubject, extra: Record<string, unknown> = {}): any {
  return {
    user: { uid: p.uid },
    userId: p.uid,
    authz: p,
    ability: defineAbilitiesFor(p),
    entitlements: null,
    query: {},
    params: {},
    body: {},
    ...extra,
  };
}

// ============================================
// Fixtures
// ============================================

/** Agency A's case for the Nigerian client, a $1,500 total (US cents). */
export const APP_A = "app-a";
/** Agency A's case for the Ghanaian client. */
export const APP_A_GH = "app-a-gh";
/** Agency B's case. */
export const APP_B = "app-b";
/** A self-serve case with no agency (and no agent). */
export const APP_NONE = "app-none";

async function seedFixtures(): Promise<void> {
  // Agent profiles (doc id = profile id; `userId` = the user uid).
  await seed("agents", "prof-agent-a", { userId: agentA.uid, agencyId: "agency-a", displayName: "Ada Agent" });
  await seed("agents", "prof-agent-a2", { userId: colleagueA.uid, agencyId: "agency-a", displayName: "Ayo Colleague" });
  await seed("agents", "prof-owner-a", { userId: ownerA.uid, agencyId: "agency-a", displayName: "Ola Owner" });
  await seed("agents", "prof-agent-b", { userId: agentB.uid, agencyId: "agency-b", displayName: "Bola Other" });
  await seed("agents", "prof-indie", { userId: independent.uid, displayName: "Ike Independent" });
  // Clients: profile country decides the charge currency (#178).
  await seed("users", clientNg.uid, { email: "delivered+client-ng@resend.dev", residentialCountry: "NG" });
  await seed("users", clientGh.uid, { email: "delivered+client-gh@resend.dev", residentialCountry: "GH" });
  harness.countries[clientNg.uid] = "NG";
  harness.countries[clientGh.uid] = "GH";
  // Cases. `agentId` on an application is the agent's USER uid.
  const base = { status: "in_progress", paymentStatus: "pending", amountPaid: 0, createdAt: T0 };
  await seed("applications", APP_A, {
    ...base, userId: clientNg.uid, agentId: agentA.uid, agencyId: "agency-a",
    clientName: "Ngozi Client", clientEmail: "delivered+client-ng@resend.dev",
    totalCost: 150_000, costCurrency: "USD",
  });
  await seed("applications", APP_A_GH, {
    ...base, userId: clientGh.uid, agentId: agentA.uid, agencyId: "agency-a",
    clientName: "Kofi Client", clientEmail: "delivered+client-gh@resend.dev",
    totalCost: 20_000, costCurrency: "USD",
  });
  await seed("applications", APP_B, {
    ...base, userId: clientNg.uid, agentId: agentB.uid, agencyId: "agency-b",
    clientName: "Ngozi Client", clientEmail: "delivered+client-ng@resend.dev", totalCost: 0,
  });
  await seed("applications", APP_NONE, {
    ...base, userId: clientNg.uid, clientName: "Ngozi Client", clientEmail: "delivered+client-ng@resend.dev", totalCost: 0,
  });
}

// ============================================
// Paystack answers for a payment-request reference
// ============================================

/** Mark `reference` paid at Paystack with `amount` (metadata names request `id`). */
export function paystackPaidRequest(
  reference: string,
  id: string,
  amount: Money,
  extra: Record<string, unknown> = {}
): void {
  harness.paystack.set(reference, {
    status: "success",
    metadata: { purpose: "payment_request", paymentRequestId: id },
    amount: amount.amountMinor,
    currency: amount.currency,
    paidAt: harness.clock.now().toISOString(),
    ...extra,
  });
}

/** Mark `reference` with any non-success status at Paystack. */
export function paystackRequestStatus(reference: string, id: string, status: string): void {
  harness.paystack.set(reference, { status, metadata: { purpose: "payment_request", paymentRequestId: id } });
}

/** Seed a LEGACY (pre-#181) naira request: kobo, "NGN", no priceUsd, no snapshot. */
export async function seedLegacyRequest(id: string, data: Record<string, unknown> = {}): Promise<void> {
  await seed("paymentRequests", id, {
    applicationId: APP_A, agentId: "prof-agent-a", agencyId: "agency-a", clientId: clientNg.uid,
    clientName: "Ngozi Client", clientEmail: "delivered+client-ng@resend.dev",
    amount: 2_500_000, currency: "NGN", description: "Document Authentication Fee", category: "other",
    status: "pending", createdAt: T0, updatedAt: T0,
    ...data,
  });
}

export { harness, seed, T0 };
