// ============================================
// Emulator tests — a suspended or demoted admin / agency member loses hidden
// visa reads at once, not when their ID token expires (issue #289)
// ============================================
//
// Run with `npm run test:emulator` (Auth + Firestore emulators, the real
// Express app, real ID tokens minted by the Auth emulator, and the real
// `claimsService` writing real custom claims / revoking real refresh tokens).
//
// The three single-visa reads (`GET /countries/:code/visas/:visaId`, `/full`,
// `/requirements`) are public, but serve HIDDEN visas (pending review,
// agency-only, ...) to admins and the owning agency's members. They used
// `optionalAuth`, which trusts the token's claims with no revocation check,
// and a token lives up to an hour. So:
//  - a suspended admin / agency member (`setAccountDisabled`: `disabled`
//    claim + revoked refresh tokens; the OLD token has no `disabled` claim);
//  - a demoted admin (`setAdmin(uid, false)`: nothing is revoked, the OLD
//    token still says `role: "admin"`)
// kept reading hidden visas with the token they already held. With
// `optionalAuthFresh` an agent-side token is re-verified with checkRevoked
// and answered from the account's current custom claims.
//
// Every test first proves the old token WORKS (200), then changes the account
// and calls again with the SAME token, so a pass cannot come from a broken
// fixture.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

import { refreshIdToken, resetEmulators, rulesEnv, RunningApi, startApi, withoutRules } from "./helpers";
import { makeAdmin, seedAgency, seedClient, seedMember } from "./agency-fixtures";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ============================================
// Fixtures
// ============================================

let api: RunningApi;

/** Country of every visa here. */
const CC = "GB";
/** A scraped visa still waiting for admin review: hidden from the public. */
const PENDING = "emu-289-pending";
/** A plain public visa (seed shape: no review status, active). */
const PUBLIC = "emu-289-public";
/** An approved, agency-only visa; its owner is set per test run. */
const AGENCY_ONLY = "emu-289-agency-only";

/** The three single-visa reads, as URL suffixes. */
const READS = ["", "/full", "/requirements"] as const;

/** Path of one of the reads for a visa id. */
const path = (id: string, suffix = "") => `/countries/${CC}/visas/${id}${suffix}`;

/** Fields every visa document here shares. */
function visaDoc(id: string, over: Record<string, unknown>): Record<string, unknown> {
  return {
    id,
    countryCode: CC,
    name: `Visa ${id}`,
    code: id.toUpperCase(),
    description: "emulator fixture",
    category: "work",
    processingTime: "3 weeks",
    processingDaysMin: 15,
    processingDaysMax: 21,
    baseCostUsd: 100,
    validityPeriod: "1 year",
    isExtendable: false,
    eligibilityCriteria: [],
    agentIds: [],
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

/** Write the country and a visa (with one requirement), as the backend would. */
async function seedVisa(id: string, over: Record<string, unknown>): Promise<void> {
  await withoutRules(async (db) => {
    await db.collection("countries").doc(CC).set({
      code: CC, name: "United Kingdom", isSupported: true, createdAt: new Date(), updatedAt: new Date(),
    });
    const ref = db.collection("countries").doc(CC).collection("visaTypes").doc(id);
    await ref.set(visaDoc(id, over));
    await ref.collection("requirements").doc("r1").set({ title: `Req of ${id}`, orderIndex: 0, requiredDocuments: [] });
  });
}

/** The real claims service (imported lazily: the Admin SDK initialises on import). */
async function claims(): Promise<any> {
  return (await import("../../src/services/claims.service")).claimsService;
}

/** The 404 an unknown visa id gets on a read: every denial must equal it. */
async function unknown(suffix: string): Promise<{ status: number; body: any }> {
  const r = await api.call("GET", path("emu-289-does-not-exist", suffix));
  assert.equal(r.status, 404, JSON.stringify(r.body));
  assert.equal(r.body.error?.code ?? r.body.error, "NOT_FOUND", JSON.stringify(r.body));
  return r;
}

/** Assert `token` gets the unknown-id 404 on all three reads of visa `id`. */
async function assertHidden(id: string, token: string, label: string): Promise<void> {
  for (const suffix of READS) {
    const r = await api.call("GET", path(id, suffix), token);
    assert.equal(r.status, 404, `${label}: ${id}${suffix} -> ${JSON.stringify(r.body)}`);
    assert.deepEqual(r.body, (await unknown(suffix)).body, `${label}: ${id}${suffix}`);
  }
}

/** Assert `token` gets 200 on all three reads of visa `id`. */
async function assertServed(id: string, token: string | undefined, label: string): Promise<void> {
  for (const suffix of READS) {
    const r = await api.call("GET", path(id, suffix), token);
    assert.equal(r.status, 200, `${label}: ${id}${suffix} -> ${JSON.stringify(r.body)}`);
  }
}

before(async () => {
  await rulesEnv();
  await resetEmulators();
  api = await startApi();
  await seedVisa(PENDING, { source: "scraped", reviewStatus: "pending_review" });
  await seedVisa(PUBLIC, {});
});

after(async () => {
  await api.close();
  await (await rulesEnv()).cleanup();
});

// ============================================
// Admins
// ============================================

describe("hidden visa reads with a token issued BEFORE the account changed (#289)", () => {
  test("guests never see the hidden visa; the public one is open (baseline)", async () => {
    for (const suffix of READS) {
      const r = await api.call("GET", path(PENDING, suffix));
      assert.equal(r.status, 404);
      assert.deepEqual(r.body, (await unknown(suffix)).body);
    }
    await assertServed(PUBLIC, undefined, "guest");
  });

  test("suspended admin (setAccountDisabled) with the old token: 404, same body as an unknown id", async () => {
    const account = await seedClient("emu289-admin-suspended");
    const oldToken = await makeAdmin(account);

    // Before: a current admin reads the hidden visa.
    await assertServed(PENDING, oldToken, "current admin");

    // Suspend exactly as the product does (disabled claim + revoked tokens).
    await (await claims()).setAccountDisabled(account.uid, true);

    // After: the SAME token is answered as a guest.
    await assertHidden(PENDING, oldToken, "suspended admin");
    // A public visa still loads, with exactly the guest's answer.
    for (const suffix of READS) {
      const guest = await api.call("GET", path(PUBLIC, suffix));
      const r = await api.call("GET", path(PUBLIC, suffix), oldToken);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(r.body, guest.body);
    }
  });

  test("admin whose refresh tokens were revoked (no disabled claim) with the old token: 404", async () => {
    const account = await seedClient("emu289-admin-revoked");
    const oldToken = await makeAdmin(account);
    await assertServed(PENDING, oldToken, "current admin");

    // Revocation compares whole seconds (token auth_time < tokensValidAfter),
    // so let the clock move past the second the account signed in.
    await new Promise((r) => setTimeout(r, 1100));
    const { auth } = await import("../../src/utils/firebase");
    await auth.revokeRefreshTokens(account.uid);

    // This case is caught by checkRevoked alone: the claims still say admin.
    await assertHidden(PENDING, oldToken, "revoked admin");
  });

  test("demoted admin (setAdmin false) with the old token that still says admin: 404", async () => {
    const account = await seedClient("emu289-admin-demoted");
    const oldToken = await makeAdmin(account);
    await assertServed(PENDING, oldToken, "current admin");

    // A demotion revokes nothing: only the account's current claims changed.
    await (await claims()).setAdmin(account.uid, false);

    await assertHidden(PENDING, oldToken, "demoted admin");
    // Not a guest, though: still a signed-in client, so public reads work.
    await assertServed(PUBLIC, oldToken, "demoted admin");
  });

  // ============================================
  // Agency members
  // ============================================

  test("suspended owner and member of the owning agency with their old tokens: 404 on its agency-only visa", async () => {
    const agency = await seedAgency("emu289");
    const member = await seedMember(agency, "emu289-member");
    await seedVisa(AGENCY_ONLY, {
      source: "agency",
      ownerAgencyId: agency.agencyId,
      createdBy: agency.owner.uid,
      visibility: "agency",
      reviewStatus: "approved",
    });

    // Put the owner / agent role in the claims (as onboarding does), then
    // take tokens that carry it.
    const service = await claims();
    await service.syncClaimsFromDb(agency.owner.uid);
    await service.syncClaimsFromDb(member.account.uid);
    const ownerToken = await refreshIdToken(agency.owner);
    const memberToken = await refreshIdToken(member.account);

    // Before: both read their agency's visa; a guest does not.
    await assertServed(AGENCY_ONLY, ownerToken, "current owner");
    await assertServed(AGENCY_ONLY, memberToken, "current member");
    assert.equal((await api.call("GET", path(AGENCY_ONLY))).status, 404);

    // Suspend the member: their old token stops working, the owner's does not.
    await service.setAccountDisabled(member.account.uid, true);
    await assertHidden(AGENCY_ONLY, memberToken, "suspended member");
    await assertServed(AGENCY_ONLY, ownerToken, "owner, member suspended");

    // Suspend the owner too.
    await service.setAccountDisabled(agency.owner.uid, true);
    await assertHidden(AGENCY_ONLY, ownerToken, "suspended owner");
  });
});
