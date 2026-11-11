// ============================================
// Emulator tests — role resolution never trusts client-writable data (#135)
// ============================================
//
// Run with `npm run test:emulator` (Auth + Firestore emulators, real
// firestore.rules, real Express app, real ID tokens from the Auth emulator).
//
// What is pinned here, end to end: a signed-in user whose token carries no
// role claim yet (every account right after sign-up) cannot raise their own
// role or attach themselves to somebody else's agency, by ANY write path a
// user has:
//  - writing their own Firestore documents from a client SDK (firestore.rules),
//  - sending extra fields to the profile endpoints (PUT /users/me, PUT /agents/me),
//  - creating an agency invitation document for themselves and redeeming it.
// and that documents which ALREADY carry such fields (written before these
// protections existed) are not honoured by the role lookup either.
//
// Each test gathers what it observed into one object and compares it with the
// secure outcome, so a regression prints every observed value at once.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

import {
  claimsAfterBackfill,
  clientDb,
  isDenied,
  refreshIdToken,
  resetEmulators,
  rulesEnv,
  RunningApi,
  signUp,
  startApi,
  TestAccount,
  withoutRules,
} from "./helpers";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ============================================
// Fixtures
// ============================================

let api: RunningApi;

/** The agency the test user does NOT belong to. */
interface Agency {
  agencyId: string;
  owner: TestAccount;
  ownerAgentDocId: string;
}

/**
 * What the Auth onCreate trigger writes for a new account (src/index.ts).
 * The functions emulator is not running, so the tests put it in place.
 */
async function provisionUserDoc(account: TestAccount): Promise<void> {
  await withoutRules(async (db) => {
    await db.collection("users").doc(account.uid).set({
      id: account.uid,
      email: account.email,
      firstName: "",
      lastName: "",
      onboardingCompleted: false,
      hasPassport: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });
}

/**
 * An approved agency with a real owner, shaped like what owner onboarding
 * writes (agency doc + the owner's agent doc, cross-referencing each other).
 */
async function seedAgency(name: string): Promise<Agency> {
  const owner = await signUp(`${name}-owner`);
  await provisionUserDoc(owner);
  const agencyId = `agency-${name}-${Date.now()}`;
  const ownerAgentDocId = `agent-${owner.uid}`;
  await withoutRules(async (db) => {
    await db.collection("agencies").doc(agencyId).set({
      id: agencyId,
      name: `Agency ${name}`,
      ownerId: owner.uid,
      ownerName: "Real Owner",
      services: [],
      totalAgents: 1,
      totalCases: 0,
      activeCases: 0,
      status: "approved",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.collection("agents").doc(ownerAgentDocId).set({
      id: ownerAgentDocId,
      userId: owner.uid,
      agencyId,
      agencyRole: "owner",
      displayName: "Real Owner",
      verificationStatus: "verified",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });
  return { agencyId, owner, ownerAgentDocId };
}

/** Role + agency the API resolves for this token (GET /users/me/authorization). */
async function resolved(token: string): Promise<{ role: unknown; agencyId: unknown }> {
  const res = await api.call("GET", "/users/me/authorization", token);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return { role: res.body.data.role, agencyId: res.body.data.agencyId };
}

before(async () => {
  await rulesEnv();
  await resetEmulators();
  api = await startApi();
});

after(async () => {
  await api.close();
  await (await rulesEnv()).cleanup();
});

// ============================================
// Baseline: how a token comes to lack the role claim
// ============================================

describe("baseline: a new account's token has no role claim", () => {
  test("sign-up token carries no role; the API resolves client and backfills the claim", async () => {
    const user = await signUp("baseline");
    await provisionUserDoc(user);

    // Decode the token payload (no signature check needed to read it).
    const payload = JSON.parse(Buffer.from(user.idToken.split(".")[1], "base64url").toString());
    assert.equal(payload.role, undefined, "a freshly minted token has no role claim");

    assert.deepEqual(await resolved(user.idToken), { role: "client", agencyId: null });
    const claims = await claimsAfterBackfill(user.uid);
    assert.equal(claims.role, "client");
    assert.equal(claims.admin, false);
  });
});

// ============================================
// Path (a): admin through the user's own user document
// ============================================

describe("path (a): a user cannot make themselves admin", () => {
  test("client SDK update of users/{uid}.admin is refused, and a document that already has it is not honoured", async () => {
    const user = await signUp("a1");
    await provisionUserDoc(user);
    const db = await clientDb(user.uid, { email: user.email });

    const clientWriteDenied = await isDenied(db.collection("users").doc(user.uid).update({ admin: true }));
    // Whatever the rules said, make sure the field IS there, as it would be on
    // a document written before the rules were tightened: the lookup has to
    // hold on its own.
    await withoutRules(async (admin) => {
      await admin.collection("users").doc(user.uid).update({ admin: true });
    });

    const { role } = await resolved(user.idToken);
    const adminEndpoint = await api.call("GET", "/admin/users", user.idToken);
    const claims = await claimsAfterBackfill(user.uid);

    assert.deepEqual(
      {
        clientWriteDenied,
        resolvedRole: role,
        adminEndpointStatus: adminEndpoint.status,
        backfilledRoleClaim: claims.role,
        backfilledAdminClaim: claims.admin,
      },
      {
        clientWriteDenied: true,
        resolvedRole: "client",
        adminEndpointStatus: 403,
        backfilledRoleClaim: "client",
        backfilledAdminClaim: false,
      }
    );

    // And the next token (which now has claims) is still not an admin.
    const fresh = await refreshIdToken(user);
    assert.equal((await api.call("GET", "/admin/users", fresh)).status, 403);
  });

  test("client SDK create of users/{uid} carrying admin / role is refused", async () => {
    // No provisioned document: the client races the onCreate trigger.
    const user = await signUp("a1b");
    const db = await clientDb(user.uid, { email: user.email });
    const ref = db.collection("users").doc(user.uid);

    assert.equal(await isDenied(ref.set({ id: user.uid, email: user.email, admin: true })), true);
    assert.equal(await isDenied(ref.set({ id: user.uid, email: user.email, role: "admin" })), true);
    assert.deepEqual(await resolved(user.idToken), { role: "client", agencyId: null });
  });

  test("PUT /users/me drops fields that are not profile fields", async () => {
    const user = await signUp("a2");
    await provisionUserDoc(user);

    const put = await api.call("PUT", "/users/me", user.idToken, {
      firstName: "Ada",
      admin: true,
      role: "admin",
      identityVerification: { status: "verified" },
      isProvisional: true,
    });
    assert.equal(put.status, 200, JSON.stringify(put.body));

    let stored: any;
    await withoutRules(async (admin) => {
      stored = (await admin.collection("users").doc(user.uid).get()).data();
    });
    const { role } = await resolved(user.idToken);
    const claims = await claimsAfterBackfill(user.uid);

    assert.deepEqual(
      {
        firstName: stored.firstName,
        adminField: stored.admin ?? null,
        roleField: stored.role ?? null,
        identityVerification: stored.identityVerification ?? null,
        isProvisional: stored.isProvisional ?? null,
        resolvedRole: role,
        backfilledRoleClaim: claims.role,
        backfilledAdminClaim: claims.admin,
      },
      {
        firstName: "Ada", // the legitimate part of the update still lands
        adminField: null,
        roleField: null,
        identityVerification: null,
        isProvisional: null,
        resolvedRole: "client",
        backfilledRoleClaim: "client",
        backfilledAdminClaim: false,
      }
    );
  });
});

// ============================================
// Path (b): agency membership through the user's own agent document
// ============================================

describe("path (b): a user cannot attach themselves to an agency", () => {
  test("client SDK create of an agent document naming another agency is refused, and such a document is not honoured as ownership", async () => {
    const victim = await seedAgency("b1");
    const user = await signUp("b1");
    await provisionUserDoc(user);
    const db = await clientDb(user.uid, { email: user.email });
    const forged = {
      id: `agent-${user.uid}`,
      userId: user.uid,
      agencyId: victim.agencyId,
      agencyRole: "owner",
      displayName: "Not The Owner",
      verificationStatus: "verified",
    };

    const clientWriteDenied = await isDenied(db.collection("agents").doc(forged.id).set(forged));
    // As above: put the document in place regardless (pre-existing data).
    await withoutRules(async (admin) => {
      await admin.collection("agents").doc(forged.id).set(forged);
    });

    const got = await resolved(user.idToken);
    const claims = await claimsAfterBackfill(user.uid);

    assert.deepEqual(
      {
        clientWriteDenied,
        resolvedRole: got.role,
        resolvedAgencyId: got.agencyId,
        backfilledRoleClaim: claims.role,
        backfilledAgencyClaim: claims.agencyId,
      },
      {
        clientWriteDenied: true,
        // The agent document exists, so they are an (independent) agent; the
        // agency's own record names a different owner, so no agency is granted.
        resolvedRole: "agent",
        resolvedAgencyId: null,
        backfilledRoleClaim: "agent",
        backfilledAgencyClaim: null,
      }
    );
  });

  test("client SDK update of agencyId / agencyRole / verification fields on an own agent document is refused", async () => {
    const victim = await seedAgency("b2");
    const user = await signUp("b2");
    await provisionUserDoc(user);
    const agentDocId = `agent-${user.uid}`;
    // An independent agent profile, as POST /agents creates it.
    await withoutRules(async (admin) => {
      await admin.collection("agents").doc(agentDocId).set({
        id: agentDocId,
        userId: user.uid,
        displayName: "Indie Agent",
        bio: "",
        verificationStatus: "pending",
        isAvailable: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    });
    const ref = (await clientDb(user.uid, { email: user.email })).collection("agents").doc(agentDocId);

    assert.deepEqual(
      {
        agencyId: await isDenied(ref.update({ agencyId: victim.agencyId })),
        agencyRole: await isDenied(ref.update({ agencyRole: "owner" })),
        both: await isDenied(ref.update({ agencyId: victim.agencyId, agencyRole: "agent" })),
        verificationStatus: await isDenied(ref.update({ verificationStatus: "verified" })),
      },
      { agencyId: true, agencyRole: true, both: true, verificationStatus: true }
    );
    assert.deepEqual(await resolved(user.idToken), { role: "agent", agencyId: null });
  });

  test("PUT /agents/me drops membership, verification and stats fields", async () => {
    const victim = await seedAgency("b3");
    const user = await signUp("b3");
    await provisionUserDoc(user);

    // A legitimate independent agent profile through the API.
    const created = await api.call("POST", "/agents", user.idToken, {
      displayName: "Indie Agent",
      bio: "Hello",
      yearsOfExperience: 3,
      specializations: ["Student Visa"],
      languages: ["English"],
      consultationFee: 5000,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));

    const put = await api.call("PUT", "/agents/me", user.idToken, {
      bio: "Updated bio",
      agencyId: victim.agencyId,
      agencyRole: "owner",
      verificationStatus: "verified",
      verifiedBy: "nobody",
      rating: 5,
      totalReviews: 999,
      userId: victim.owner.uid,
    });
    assert.equal(put.status, 200, JSON.stringify(put.body));

    let stored: any;
    await withoutRules(async (admin) => {
      stored = (await admin.collection("agents").doc(created.body.data.id).get()).data();
    });
    const got = await resolved(user.idToken);

    assert.deepEqual(
      {
        bio: stored.bio,
        agencyId: stored.agencyId ?? null,
        agencyRole: stored.agencyRole ?? null,
        verificationStatus: stored.verificationStatus,
        verifiedBy: stored.verifiedBy ?? null,
        rating: stored.rating,
        totalReviews: stored.totalReviews,
        userId: stored.userId,
        resolvedRole: got.role,
        resolvedAgencyId: got.agencyId,
      },
      {
        bio: "Updated bio", // the legitimate part of the update still lands
        agencyId: null,
        agencyRole: null,
        verificationStatus: "pending",
        verifiedBy: null,
        rating: 0,
        totalReviews: 0,
        userId: user.uid,
        resolvedRole: "agent",
        resolvedAgencyId: null,
      }
    );
  });
});

// ============================================
// Path (c): agency membership through a self-made invitation
// ============================================

describe("path (c): a user cannot invite themselves into an agency", () => {
  test("client SDK create of an agency invitation is refused, so there is nothing to redeem", async () => {
    const victim = await seedAgency("c1");
    const user = await signUp("c1");
    await provisionUserDoc(user);
    const db = await clientDb(user.uid, { email: user.email });
    const invitationId = `invite-${user.uid}`;

    const clientWriteDenied = await isDenied(
      db.collection("agencyInvitations").doc(invitationId).set({
        id: invitationId,
        agencyId: victim.agencyId,
        agencyName: "Agency c1",
        invitedBy: user.uid,
        invitedByName: "Self",
        invitedEmail: user.email,
        status: "pending",
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 86_400_000),
      })
    );

    // Try to redeem it through the real endpoint either way.
    const join = await api.call("POST", "/onboarding/join-agency", user.idToken, {
      invitationId,
      firstName: "Self",
      lastName: "Invited",
    });
    const got = await resolved(await refreshIdToken(user));

    assert.deepEqual(
      {
        clientWriteDenied,
        joinStatus: join.status,
        resolvedRole: got.role,
        resolvedAgencyId: got.agencyId,
      },
      { clientWriteDenied: true, joinStatus: 404, resolvedRole: "client", resolvedAgencyId: null }
    );
  });
});

// ============================================
// No behaviour change for correctly provisioned principals
// ============================================

describe("correctly provisioned admins, owners and agents are unaffected", () => {
  test("an owner whose token has no role claim yet still resolves owner of their agency", async () => {
    const agency = await seedAgency("ok-owner");
    assert.deepEqual(await resolved(agency.owner.idToken), { role: "owner", agencyId: agency.agencyId });
    const claims = await claimsAfterBackfill(agency.owner.uid);
    assert.equal(claims.role, "owner");
    assert.equal(claims.agencyId, agency.agencyId);
  });

  test("a member agent written by the server flows still resolves agent of that agency", async () => {
    const agency = await seedAgency("ok-agent");
    const member = await signUp("ok-agent-member");
    await provisionUserDoc(member);
    await withoutRules(async (admin) => {
      await admin.collection("agents").doc(`agent-${member.uid}`).set({
        id: `agent-${member.uid}`,
        userId: member.uid,
        agencyId: agency.agencyId,
        agencyRole: "agent",
        displayName: "Member",
        verificationStatus: "verified",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    });
    assert.deepEqual(await resolved(member.idToken), { role: "agent", agencyId: agency.agencyId });
  });

  test("an admin by custom claim is an admin, with or without the legacy document field", async () => {
    const { auth } = await import("../../src/utils/firebase");
    const adminUser = await signUp("ok-admin");
    await provisionUserDoc(adminUser); // note: NO admin field on the document
    // Legacy claim shape (what the seeder writes): only `admin: true`, no role.
    await auth.setCustomUserClaims(adminUser.uid, { admin: true });
    const token = await refreshIdToken(adminUser);

    assert.deepEqual(await resolved(token), { role: "admin", agencyId: null });
    assert.equal((await api.call("GET", "/admin/users", token)).status, 200);
    const claims = await claimsAfterBackfill(adminUser.uid);
    assert.equal(claims.role, "admin");
    assert.equal(claims.admin, true);
  });

  test("a real invitation written by the backend can still be redeemed by its recipient", async () => {
    const agency = await seedAgency("ok-invite");
    const invitee = await signUp("ok-invitee");
    await provisionUserDoc(invitee);
    const invitationId = `invite-${invitee.uid}`;
    await withoutRules(async (admin) => {
      await admin.collection("agencyInvitations").doc(invitationId).set({
        id: invitationId,
        agencyId: agency.agencyId,
        agencyName: "Agency ok-invite",
        invitedBy: agency.owner.uid,
        invitedByName: "Real Owner",
        invitedEmail: invitee.email,
        status: "pending",
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 86_400_000),
      });
    });

    const join = await api.call("POST", "/onboarding/join-agency", invitee.idToken, {
      invitationId,
      firstName: "Real",
      lastName: "Invitee",
    });
    assert.equal(join.status, 200, JSON.stringify(join.body));
    assert.deepEqual(await resolved(await refreshIdToken(invitee)), {
      role: "agent",
      agencyId: agency.agencyId,
    });
  });
});

// ============================================
// Invitations: only one issued by the agency's owner can be redeemed
// ============================================

describe("an invitation is honoured only when the agency's owner issued it", () => {
  /** Put an invitation document in place with the Admin SDK (bypasses rules). */
  async function seedInvitation(id: string, fields: Record<string, unknown>): Promise<void> {
    await withoutRules(async (admin) => {
      await admin.collection("agencyInvitations").doc(id).set({
        id,
        agencyName: "Some Agency",
        invitedByName: "Someone",
        status: "pending",
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 86_400_000),
        ...fields,
      });
    });
  }

  test("a pre-existing invitation whose inviter is not the agency's owner is refused on both redemption paths", async () => {
    const victim = await seedAgency("inv-forged");
    const user = await signUp("inv-forged");
    await provisionUserDoc(user);
    const invitationId = `invite-${user.uid}`;
    // Simulates a document written before clients were stopped from writing
    // this collection: it names the user as BOTH inviter and invitee.
    await seedInvitation(invitationId, {
      agencyId: victim.agencyId,
      invitedBy: user.uid,
      invitedEmail: user.email,
    });

    const join = await api.call("POST", "/onboarding/join-agency", user.idToken, {
      invitationId,
      firstName: "Self",
      lastName: "Invited",
    });
    const accept = await api.call("POST", `/invitations/${invitationId}/accept`, user.idToken);
    const got = await resolved(await refreshIdToken(user));
    let invitationStatus: unknown;
    let agentDocs = -1;
    await withoutRules(async (admin) => {
      invitationStatus = (await admin.collection("agencyInvitations").doc(invitationId).get()).data().status;
      agentDocs = (await admin.collection("agents").where("userId", "==", user.uid).get()).size;
    });

    assert.deepEqual(
      {
        joinStatus: join.status,
        acceptStatus: accept.status,
        acceptMessage: accept.body.message,
        resolvedRole: got.role,
        resolvedAgencyId: got.agencyId,
        invitationStatus,
        agentDocs,
      },
      {
        joinStatus: 404,
        acceptStatus: 400,
        acceptMessage: "Invitation not found",
        resolvedRole: "client",
        resolvedAgencyId: null,
        invitationStatus: "pending", // untouched
        agentDocs: 0, // no membership was created
      }
    );
  });

  test("an invitation naming an agency that does not exist is refused", async () => {
    const user = await signUp("inv-noagency");
    await provisionUserDoc(user);
    const invitationId = `invite-${user.uid}`;
    await seedInvitation(invitationId, {
      agencyId: "agency-that-is-not-there",
      invitedBy: user.uid,
      invitedEmail: user.email,
    });
    const join = await api.call("POST", "/onboarding/join-agency", user.idToken, {
      invitationId,
      firstName: "A",
      lastName: "B",
    });
    assert.equal(join.status, 404);
    assert.equal((await api.call("POST", `/invitations/${invitationId}/accept`, user.idToken)).status, 400);
  });

  test("an owner-issued invitation is still accepted through POST /invitations/:id/accept", async () => {
    const agency = await seedAgency("inv-real");
    const invitee = await signUp("inv-real-invitee");
    await provisionUserDoc(invitee);
    const invitationId = `invite-${invitee.uid}`;
    await seedInvitation(invitationId, {
      agencyId: agency.agencyId,
      invitedBy: agency.owner.uid,
      invitedEmail: invitee.email,
    });

    const accept = await api.call("POST", `/invitations/${invitationId}/accept`, invitee.idToken);
    assert.equal(accept.status, 200, JSON.stringify(accept.body));
    assert.deepEqual(await resolved(await refreshIdToken(invitee)), {
      role: "agent",
      agencyId: agency.agencyId,
    });
  });

  test("an owner-issued invitation cannot be redeemed by another address, even by a user who already has an agent profile", async () => {
    const agency = await seedAgency("inv-email");
    const other = await signUp("inv-email-other");
    await provisionUserDoc(other);
    // `other` already has an (independent) agent profile.
    await withoutRules(async (admin) => {
      await admin.collection("agents").doc(`agent-${other.uid}`).set({
        id: `agent-${other.uid}`,
        userId: other.uid,
        displayName: "Other",
        verificationStatus: "pending",
      });
    });
    const invitationId = `invite-for-someone-else-${other.uid}`;
    await seedInvitation(invitationId, {
      agencyId: agency.agencyId,
      invitedBy: agency.owner.uid,
      invitedEmail: "delivered+the-real-invitee@resend.dev",
    });

    const accept = await api.call("POST", `/invitations/${invitationId}/accept`, other.idToken);
    const join = await api.call("POST", "/onboarding/join-agency", other.idToken, {
      invitationId,
      firstName: "A",
      lastName: "B",
    });
    assert.deepEqual(
      { accept: accept.status, acceptMessage: accept.body.message, join: join.status },
      { accept: 400, acceptMessage: "This invitation was sent to a different email address.", join: 403 }
    );
    assert.deepEqual(await resolved(other.idToken), { role: "agent", agencyId: null });
  });
});

// ============================================
// Agency views take the role and agency from the resolved principal
// ============================================

describe("agency views (applications, payment requests, transactions) ignore the caller's agent document", () => {
  let agency: Agency;
  /** Owner / member tokens that carry their proper claims. */
  let ownerToken: string;
  let member: TestAccount;
  let memberToken: string;
  const APP_ID = "b2-app-1";
  const PR_OWNER = "b2-pr-owner";
  const PR_MEMBER = "b2-pr-member";
  const TXN_ID = "b2-txn-1";

  /** Set claims the way the server flows do, and return a token carrying them. */
  async function withClaims(account: TestAccount, role: string, agencyId: string | null): Promise<string> {
    const { auth } = await import("../../src/utils/firebase");
    await auth.setCustomUserClaims(account.uid, { role, agencyId, admin: false });
    return refreshIdToken(account);
  }

  /**
   * A user whose agent document claims `agencyRole` in the test agency
   * (written with the Admin SDK: data from before the protections), while
   * their custom claims say `claimRole` with no agency.
   */
  async function outsider(name: string, agencyRole: string, claimRole: string): Promise<string> {
    const user = await signUp(name);
    await provisionUserDoc(user);
    await withoutRules(async (admin) => {
      await admin.collection("agents").doc(`agent-${user.uid}`).set({
        id: `agent-${user.uid}`,
        userId: user.uid,
        agencyId: agency.agencyId,
        agencyRole,
        displayName: "Outsider",
        verificationStatus: "verified",
      });
    });
    return withClaims(user, claimRole, null);
  }

  /** Status of the three agency views for one token. */
  async function views(token: string) {
    const [apps, prs, txn] = await Promise.all([
      api.call("GET", "/applications?role=owner", token),
      api.call("GET", "/payment-requests?role=owner", token),
      api.call("GET", `/transactions/${TXN_ID}`, token),
    ]);
    return {
      applications: apps.status,
      applicationIds: apps.status === 200 ? apps.body.data.map((a: any) => a.id) : null,
      paymentRequests: prs.status,
      paymentRequestIds: prs.status === 200 ? prs.body.data.map((p: any) => p.id).sort() : null,
      transaction: txn.status,
    };
  }

  before(async () => {
    agency = await seedAgency("b2");
    ownerToken = await withClaims(agency.owner, "owner", agency.agencyId);
    member = await signUp("b2-member");
    await provisionUserDoc(member);
    await withoutRules(async (admin) => {
      await admin.collection("agents").doc(`agent-${member.uid}`).set({
        id: `agent-${member.uid}`,
        userId: member.uid,
        agencyId: agency.agencyId,
        agencyRole: "agent",
        displayName: "Member",
        verificationStatus: "verified",
      });
      // One case, two payment requests and one transaction belonging to the agency.
      await admin.collection("applications").doc(APP_ID).set({
        id: APP_ID,
        userId: "some-client",
        agencyId: agency.agencyId,
        agentId: agency.owner.uid,
        status: "in_progress",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await admin.collection("paymentRequests").doc(PR_OWNER).set({
        id: PR_OWNER,
        agencyId: agency.agencyId,
        agentId: agency.ownerAgentDocId,
        applicationId: APP_ID,
        status: "pending",
        createdAt: new Date(),
      });
      await admin.collection("paymentRequests").doc(PR_MEMBER).set({
        id: PR_MEMBER,
        agencyId: agency.agencyId,
        agentId: `agent-${member.uid}`,
        applicationId: APP_ID,
        status: "pending",
        createdAt: new Date(),
      });
      await admin.collection("transactions").doc(TXN_ID).set({
        id: TXN_ID,
        agentId: agency.owner.uid,
        userId: "some-client",
        applicationId: APP_ID,
        amount: 50000,
        status: "completed",
        createdAt: new Date(),
      });
    });
    memberToken = await withClaims(member, "agent", agency.agencyId);
  });

  test("agent document says OWNER of the agency, claims say client -> nothing from any of the three", async () => {
    assert.deepEqual(await views(await outsider("b2-fake-owner", "owner", "client")), {
      applications: 403,
      applicationIds: null,
      paymentRequests: 403,
      paymentRequestIds: null,
      transaction: 403,
    });
  });

  test("agent document says MEMBER of the agency, claims say independent agent -> nothing from any of the three", async () => {
    assert.deepEqual(await views(await outsider("b2-fake-member", "agent", "agent")), {
      applications: 403,
      applicationIds: null,
      paymentRequests: 403,
      paymentRequestIds: null,
      transaction: 403,
    });
  });

  test("the real owner sees the agency's cases, payment requests and transaction, as before", async () => {
    assert.deepEqual(await views(ownerToken), {
      applications: 200,
      applicationIds: [APP_ID],
      paymentRequests: 200,
      paymentRequestIds: [PR_MEMBER, PR_OWNER].sort(),
      transaction: 200,
    });
  });

  test("a real member: no owner views; own payment requests and same-agency transaction still work", async () => {
    assert.deepEqual(await views(memberToken), {
      applications: 403, // unchanged: this view was already owner-only
      applicationIds: null,
      paymentRequests: 403, // owner view is now owner-only
      paymentRequestIds: null,
      transaction: 200, // unchanged: same agency
    });
    // The member's own (default "agent") view is untouched.
    const own = await api.call("GET", "/payment-requests", memberToken);
    assert.equal(own.status, 200, JSON.stringify(own.body));
    assert.deepEqual(own.body.data.map((p: any) => p.id), [PR_MEMBER]);
  });
});
