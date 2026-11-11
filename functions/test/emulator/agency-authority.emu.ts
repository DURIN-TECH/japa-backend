// ============================================
// Emulator tests — agency authority and membership (issue #138)
// ============================================
//
// Run with `npm run test:emulator` (Auth + Firestore emulators, the repo's
// real firestore.rules, the real Express app, real ID tokens).
//
// What is pinned here, end to end, one `describe` per item of the issue:
//  A. agency membership actions are scoped to the caller's OWN agency, and
//     only that agency's owner (or an admin by claim) may perform them;
//  B. an agency record cannot be created or given authority from a client,
//     and the agency update endpoint copies only the owner-editable fields;
//  C. the application update endpoint does not let a caller move a case to an
//     agency that is not theirs, and an applicant cannot change assignment;
//  D. `isAvailable` on PUT /agents/me passes the same verified-only check as
//     the availability endpoint;
//  E. the server flows that create an owner set the role claims, and a
//     consultation takes its agency from the resolved principal;
//  F. invitations: who may list, accept and decline;
//  G. an independent agent joins an agency only by accepting an invitation.
//
// Each test gathers what it observed into one object and compares it with the
// secure outcome, so a regression prints every observed value at once.
// (Field-by-field Firestore rules tests live in agency-rules.emu.ts.)

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

import {
  claimsAfterBackfill,
  claimsOf,
  clientDb,
  isDenied,
  refreshIdToken,
  resetEmulators,
  rulesEnv,
  RunningApi,
  signUp,
  startApi,
  withoutRules,
} from "./helpers";
import {
  makeAdmin,
  provisionUserDoc,
  put,
  seedAgency,
  seedApplication,
  seedClient,
  seedIndependentAgent,
  seedInvitation,
  seedMember,
  stored,
} from "./agency-fixtures";

/* eslint-disable @typescript-eslint/no-explicit-any */

let api: RunningApi;

/** Role + agency the API resolves for this token (GET /users/me/authorization). */
async function resolved(token: string): Promise<{ role: unknown; agencyId: unknown }> {
  const res = await api.call("GET", "/users/me/authorization", token);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return { role: res.body.data.role, agencyId: res.body.data.agencyId };
}

/** All invitation documents for one agency (rules off). */
async function invitationsOf(agencyId: string): Promise<any[]> {
  const out: any[] = [];
  await withoutRules(async (db) => {
    const snap = await db.collection("agencyInvitations").where("agencyId", "==", agencyId).get();
    snap.forEach((d: any) => out.push(d.data()));
  });
  return out;
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
// A. Membership actions are scoped to the caller's own agency
// ============================================

describe("A. agency membership endpoints act only on the caller's own agency", () => {
  test("an owner cannot remove a member of ANOTHER agency through their own agency's URL", async () => {
    const mine = await seedAgency("a1-mine");
    const theirs = await seedAgency("a1-theirs");
    const victim = await seedMember(theirs, "a1-victim");

    const res = await api.call(
      "DELETE",
      `/agencies/${mine.agencyId}/members/${victim.agentDocId}`,
      mine.owner.idToken
    );
    const agent = await stored("agents", victim.agentDocId);
    const agency = await stored("agencies", theirs.agencyId);
    const myAgency = await stored("agencies", mine.agencyId);

    assert.deepEqual(
      {
        status: res.status,
        victimAgencyId: agent.agencyId,
        victimAgencyRole: agent.agencyRole,
        theirTotalAgents: agency.totalAgents,
        myTotalAgents: myAgency.totalAgents,
      },
      {
        status: 404,
        victimAgencyId: theirs.agencyId,
        victimAgencyRole: "agent",
        theirTotalAgents: 2,
        myTotalAgents: 1,
      }
    );
  });

  test("an owner cannot act on another agency's URL at all (remove, add, invite, list)", async () => {
    const mine = await seedAgency("a2-mine");
    const theirs = await seedAgency("a2-theirs");
    const victim = await seedMember(theirs, "a2-victim");
    const indie = await seedIndependentAgent("a2-indie");
    const t = mine.owner.idToken;
    const base = `/agencies/${theirs.agencyId}`;

    assert.deepEqual(
      {
        remove: (await api.call("DELETE", `${base}/members/${victim.agentDocId}`, t)).status,
        add: (await api.call("POST", `${base}/members`, t, { agentId: indie.agentDocId })).status,
        invite: (await api.call("POST", `${base}/invitations`, t, { email: "delivered+a2@resend.dev" })).status,
        listInvitations: (await api.call("GET", `${base}/invitations`, t)).status,
        listMembers: (await api.call("GET", `${base}/members`, t)).status,
        victimStillMember: (await stored("agents", victim.agentDocId)).agencyId === theirs.agencyId,
      },
      { remove: 403, add: 403, invite: 403, listInvitations: 403, listMembers: 403, victimStillMember: true }
    );
  });

  test("a member who is not the owner cannot remove, add or invite in their own agency", async () => {
    const agency = await seedAgency("a3");
    const member = await seedMember(agency, "a3-member");
    const other = await seedMember(agency, "a3-other");
    const t = member.account.idToken;
    const base = `/agencies/${agency.agencyId}`;

    assert.deepEqual(
      {
        remove: (await api.call("DELETE", `${base}/members/${other.agentDocId}`, t)).status,
        invite: (await api.call("POST", `${base}/invitations`, t, { email: "delivered+a3@resend.dev" })).status,
        listInvitations: (await api.call("GET", `${base}/invitations`, t)).status,
        otherStillMember: (await stored("agents", other.agentDocId)).agencyId === agency.agencyId,
      },
      { remove: 403, invite: 403, listInvitations: 403, otherStillMember: true }
    );
  });

  test("the owner can still remove a member of their own agency (and the member's claims follow)", async () => {
    const agency = await seedAgency("a4");
    const member = await seedMember(agency, "a4-member");

    const res = await api.call(
      "DELETE",
      `/agencies/${agency.agencyId}/members/${member.agentDocId}`,
      agency.owner.idToken
    );
    const agent = await stored("agents", member.agentDocId);
    const claims = await claimsOf(member.account.uid);

    assert.deepEqual(
      {
        status: res.status,
        agencyId: agent.agencyId ?? null,
        agencyRole: agent.agencyRole ?? null,
        totalAgents: (await stored("agencies", agency.agencyId)).totalAgents,
        roleClaim: claims.role,
        agencyClaim: claims.agencyId ?? null,
      },
      { status: 200, agencyId: null, agencyRole: null, totalAgents: 1, roleClaim: "agent", agencyClaim: null }
    );
  });

  test("an admin (by claim) can remove a member, but only through the agency the member belongs to", async () => {
    const agency = await seedAgency("a5");
    const other = await seedAgency("a5-other");
    const member = await seedMember(agency, "a5-member");
    const adminToken = await makeAdmin(await seedClient("a5-admin"));

    const wrongAgency = await api.call(
      "DELETE",
      `/agencies/${other.agencyId}/members/${member.agentDocId}`,
      adminToken
    );
    const stillMember = (await stored("agents", member.agentDocId)).agencyId === agency.agencyId;
    const rightAgency = await api.call(
      "DELETE",
      `/agencies/${agency.agencyId}/members/${member.agentDocId}`,
      adminToken
    );

    assert.deepEqual(
      {
        wrongAgency: wrongAgency.status,
        stillMember,
        rightAgency: rightAgency.status,
        agencyIdAfter: (await stored("agents", member.agentDocId)).agencyId ?? null,
      },
      { wrongAgency: 404, stillMember: true, rightAgency: 200, agencyIdAfter: null }
    );
  });

  test("an agency record that names the caller as owner is not enough without the owner role (legacy record)", async () => {
    // A record like this could be written from a client before the rules
    // were tightened (see B). It must not work as an agency.
    const attacker = await seedIndependentAgent("a6-attacker");
    const forgedId = `forged-${Date.now()}`;
    await put("agencies", forgedId, {
      id: forgedId,
      name: "Forged",
      ownerId: attacker.account.uid,
      ownerName: "Nobody",
      services: [],
      totalAgents: 1,
      status: "approved",
      compliance: { status: "verified" },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const t = attacker.account.idToken;

    const add = await api.call("POST", `/agencies/${forgedId}/members`, t, { agentId: attacker.agentDocId });
    const invite = await api.call("POST", `/agencies/${forgedId}/invitations`, t, {
      email: "delivered+a6@resend.dev",
    });
    const got = await resolved(t);

    assert.deepEqual(
      {
        add: add.status,
        invite: invite.status,
        invitationsWritten: (await invitationsOf(forgedId)).length,
        agentDocAgencyId: (await stored("agents", attacker.agentDocId)).agencyId ?? null,
        resolvedRole: got.role,
        resolvedAgencyId: got.agencyId,
      },
      {
        add: 403,
        invite: 403,
        invitationsWritten: 0,
        agentDocAgencyId: null,
        resolvedRole: "agent",
        resolvedAgencyId: null,
      }
    );
  });
});

// ============================================
// B. Agency records: no authority from a client
// ============================================

describe("B. an agency record cannot be created or promoted from a client", () => {
  test("a signed-in user cannot create an agency document (approved, verified, self-owned) from the client SDK", async () => {
    const user = await seedIndependentAgent("b1");
    const db = await clientDb(user.account.uid, { email: user.account.email });
    const forgedId = `client-made-${Date.now()}`;

    const denied = await isDenied(
      db
        .collection("agencies")
        .doc(forgedId)
        .set({
          id: forgedId,
          name: "Client Made",
          ownerId: user.account.uid,
          ownerName: "Me",
          services: [],
          totalAgents: 1,
          status: "approved",
          compliance: { status: "verified" },
        })
    );

    assert.deepEqual(
      { denied, exists: (await stored("agencies", forgedId)) !== undefined },
      { denied: true, exists: false }
    );
  });

  test("an owner cannot approve, verify, re-own or re-count their own agency from the client SDK", async () => {
    const agency = await seedAgency("b2", { status: "pending_review", compliance: { status: "in_progress" } });
    const db = await clientDb(agency.owner.uid, { email: agency.owner.email, role: "owner", agencyId: agency.agencyId });
    const ref = db.collection("agencies").doc(agency.agencyId);

    const denied = {
      status: await isDenied(ref.update({ status: "approved" })),
      compliance: await isDenied(ref.update({ compliance: { status: "verified" } })),
      complianceStatus: await isDenied(ref.update({ "compliance.status": "verified" })),
      ownerId: await isDenied(ref.update({ ownerId: "someone-else" })),
      totalAgents: await isDenied(ref.update({ totalAgents: -50 })),
    };
    const after = await stored("agencies", agency.agencyId);

    assert.deepEqual(
      {
        denied,
        status: after.status,
        complianceStatus: after.compliance.status,
        ownerId: after.ownerId,
        totalAgents: after.totalAgents,
      },
      {
        denied: { status: true, compliance: true, complianceStatus: true, ownerId: true, totalAgents: true },
        status: "pending_review",
        complianceStatus: "in_progress",
        ownerId: agency.owner.uid,
        totalAgents: 1,
      }
    );
  });

  test("PUT /agencies/me changes the owner-editable fields and nothing else", async () => {
    const agency = await seedAgency("b3", { status: "pending_review", compliance: { status: "in_progress" } });

    const res = await api.call("PUT", "/agencies/me", agency.owner.idToken, {
      // legitimate edit (exactly what the portal's agency form sends)
      name: "Renamed Agency",
      address: "1 Marina Road",
      state: "Lagos",
      description: "We help with study visas.",
      consultationFee: 25000,
      services: [{ id: "s1", name: "Study visa", price: 150000, internalFlag: true }],
      // everything below must be ignored
      status: "approved",
      compliance: { status: "verified" },
      ownerId: "someone-else",
      ownerName: "Someone Else",
      totalAgents: -50,
      totalCases: 999,
      activeCases: 999,
      slug: "taken-over",
      reviewedBy: "admin-uid",
      reviewedAt: "2026-01-01T00:00:00Z",
      rejectionReason: "",
      id: "another-id",
      createdAt: "2020-01-01T00:00:00Z",
      logoUrl: "https://example.invalid/tracker.png",
    });
    const after = await stored("agencies", agency.agencyId);

    assert.deepEqual(
      {
        httpStatus: res.status,
        name: after.name,
        address: after.address,
        state: after.state,
        description: after.description,
        consultationFee: after.consultationFee,
        services: after.services,
        status: after.status,
        complianceStatus: after.compliance.status,
        ownerId: after.ownerId,
        ownerName: after.ownerName,
        totalAgents: after.totalAgents,
        totalCases: after.totalCases,
        activeCases: after.activeCases,
        slug: after.slug,
        reviewedBy: after.reviewedBy ?? null,
        reviewedAt: after.reviewedAt ?? null,
        id: after.id,
        logoUrl: after.logoUrl ?? null,
      },
      {
        httpStatus: 200,
        name: "Renamed Agency",
        address: "1 Marina Road",
        state: "Lagos",
        description: "We help with study visas.",
        consultationFee: 25000,
        // only the known keys of a service are kept
        services: [{ id: "s1", name: "Study visa", price: 150000 }],
        status: "pending_review",
        complianceStatus: "in_progress",
        ownerId: agency.owner.uid,
        ownerName: "Real Owner",
        totalAgents: 1,
        totalCases: 0,
        activeCases: 0,
        slug: agency.agencyId,
        reviewedBy: null,
        reviewedAt: null,
        id: agency.agencyId,
        // the logo is set only through the logo upload endpoints
        logoUrl: null,
      }
    );
  });

  test("PUT /agencies/me refuses values of the wrong type instead of storing them", async () => {
    const agency = await seedAgency("b4");
    const t = agency.owner.idToken;

    assert.deepEqual(
      {
        nameObject: (await api.call("PUT", "/agencies/me", t, { name: { $set: "x" } })).status,
        emptyName: (await api.call("PUT", "/agencies/me", t, { name: "   " })).status,
        negativeFee: (await api.call("PUT", "/agencies/me", t, { consultationFee: -1 })).status,
        servicesNotArray: (await api.call("PUT", "/agencies/me", t, { services: "all of them" })).status,
        nameAfter: (await stored("agencies", agency.agencyId)).name,
      },
      { nameObject: 400, emptyName: 400, negativeFee: 400, servicesNotArray: 400, nameAfter: "Agency b4" }
    );
  });

  test("a member who is not the owner cannot update the agency through PUT /agencies/me", async () => {
    const agency = await seedAgency("b5");
    const member = await seedMember(agency, "b5-member");

    const res = await api.call("PUT", "/agencies/me", member.account.idToken, { name: "Hijacked" });
    assert.deepEqual(
      { status: res.status, name: (await stored("agencies", agency.agencyId)).name },
      { status: 403, name: "Agency b5" }
    );
  });
});

// ============================================
// C. Applications: assignment through the API
// ============================================

describe("C. application assignment cannot be changed by the wrong party through the API", () => {
  test("an applicant cannot change status, agent, agency or payment fields with PUT /applications/:id", async () => {
    const agency = await seedAgency("c1");
    const applicant = await seedClient("c1-applicant");
    const appId = `app-c1-${Date.now()}`;
    await seedApplication(appId, {
      userId: applicant.uid,
      agentId: agency.owner.uid,
      agencyId: agency.agencyId,
      paymentStatus: "pending",
    });

    const res = await api.call("PUT", `/applications/${appId}`, applicant.idToken, {
      userNotes: "my note",
      status: "approved",
      agentId: applicant.uid,
      agencyId: "another-agency",
      mode: "self",
      paymentStatus: "paid",
      totalFee: 0,
    });
    const after = await stored("applications", appId);

    assert.deepEqual(
      {
        httpStatus: res.status,
        userNotes: after.userNotes,
        status: after.status,
        agentId: after.agentId,
        agencyId: after.agencyId,
        mode: after.mode,
        paymentStatus: after.paymentStatus,
        totalFee: after.totalFee ?? null,
      },
      {
        httpStatus: 200,
        userNotes: "my note",
        status: "submitted",
        agentId: agency.owner.uid,
        agencyId: agency.agencyId,
        mode: "agent",
        paymentStatus: "pending",
        totalFee: null,
      }
    );
  });

  test("an agent cannot move a case they handle into an agency that is not theirs", async () => {
    const mine = await seedAgency("c2-mine");
    const theirs = await seedAgency("c2-theirs");
    const applicant = await seedClient("c2-applicant");
    const appId = `app-c2-${Date.now()}`;
    await seedApplication(appId, {
      userId: applicant.uid,
      agentId: mine.owner.uid,
      agencyId: mine.agencyId,
    });

    const res = await api.call("PUT", `/applications/${appId}`, mine.owner.idToken, {
      agencyId: theirs.agencyId,
    });
    assert.deepEqual(
      { status: res.status, agencyId: (await stored("applications", appId)).agencyId },
      { status: 403, agencyId: mine.agencyId }
    );
  });

  test("an agent can still take a case into their OWN agency, and an admin can move it anywhere", async () => {
    const mine = await seedAgency("c3-mine", { compliance: { status: "verified" } });
    const theirs = await seedAgency("c3-theirs");
    const applicant = await seedClient("c3-applicant");
    const adminToken = await makeAdmin(await seedClient("c3-admin"));
    const appId = `app-c3-${Date.now()}`;
    await seedApplication(appId, { userId: applicant.uid, agentId: mine.owner.uid, agencyId: mine.agencyId });

    // The portal's "accept request" sends exactly this shape.
    const own = await api.call("PUT", `/applications/${appId}`, mine.owner.idToken, {
      mode: "agent",
      agentId: mine.owner.uid,
      agencyId: mine.agencyId,
    });
    const byAdmin = await api.call("PUT", `/applications/${appId}`, adminToken, { agencyId: theirs.agencyId });

    assert.deepEqual(
      { own: own.status, byAdmin: byAdmin.status, agencyId: (await stored("applications", appId)).agencyId },
      { own: 200, byAdmin: 200, agencyId: theirs.agencyId }
    );
  });
});

// ============================================
// D. isAvailable on PUT /agents/me
// ============================================

describe("D. PUT /agents/me applies the verified-only rule to isAvailable", () => {
  test("an unverified agent cannot switch themselves available through the profile endpoint", async () => {
    const agent = await seedIndependentAgent("d1");

    const viaAvailability = await api.call("PUT", "/agents/me/availability", agent.account.idToken, {
      isAvailable: true,
    });
    const viaProfile = await api.call("PUT", "/agents/me", agent.account.idToken, {
      bio: "updated bio",
      isAvailable: true,
    });
    const after = await stored("agents", agent.agentDocId);

    assert.deepEqual(
      { viaAvailability: viaAvailability.status, viaProfile: viaProfile.status, isAvailable: after.isAvailable },
      { viaAvailability: 403, viaProfile: 403, isAvailable: false }
    );
  });

  test("a verified agent can, an unverified agent can switch OFF, and a non-boolean is refused", async () => {
    const verified = await seedIndependentAgent("d2-verified", { verificationStatus: "verified" });
    const pending = await seedIndependentAgent("d2-pending");

    const on = await api.call("PUT", "/agents/me", verified.account.idToken, { isAvailable: true });
    const off = await api.call("PUT", "/agents/me", pending.account.idToken, { isAvailable: false, bio: "hello" });
    const junk = await api.call("PUT", "/agents/me", verified.account.idToken, { isAvailable: "yes" });

    assert.deepEqual(
      {
        on: on.status,
        verifiedIsAvailable: (await stored("agents", verified.agentDocId)).isAvailable,
        off: off.status,
        pendingBio: (await stored("agents", pending.agentDocId)).bio,
        junk: junk.status,
      },
      { on: 200, verifiedIsAvailable: true, off: 200, pendingBio: "hello", junk: 400 }
    );
  });
});

// ============================================
// E. Claims on the server flows that create an owner; consultation agency
// ============================================

describe("E. server flows keep role claims and the consultation agency in step with the principal", () => {
  test("POST /agencies makes the creator an owner by claim, like onboarding does", async () => {
    const agent = await seedIndependentAgent("e1");
    // First request: the middleware backfills the (agent) claim. Wait for it
    // and use a token that carries it, as a returning user's token would.
    await resolved(agent.account.idToken);
    await claimsAfterBackfill(agent.account.uid);
    const token = await refreshIdToken(agent.account);

    const res = await api.call("POST", "/agencies", token, {
      name: "Brand New Agency",
      // must be ignored: review-gated / server-written
      status: "approved",
      compliance: { status: "verified" },
      ownerId: "someone-else",
      totalAgents: 40,
      logoUrl: "https://example.invalid/tracker.png",
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const agencyId = res.body.data.id as string;
    const agency = await stored("agencies", agencyId);
    const claims = await claimsOf(agent.account.uid);
    const fresh = await refreshIdToken(agent.account);

    assert.deepEqual(
      {
        roleClaim: claims.role,
        agencyClaim: claims.agencyId,
        resolvedWithFreshToken: await resolved(fresh),
        status: agency.status,
        compliance: agency.compliance ?? null,
        ownerId: agency.ownerId,
        totalAgents: agency.totalAgents,
        logoUrl: agency.logoUrl ?? null,
      },
      {
        roleClaim: "owner",
        agencyClaim: agencyId,
        resolvedWithFreshToken: { role: "owner", agencyId },
        status: "pending_review",
        compliance: null,
        ownerId: agent.account.uid,
        totalAgents: 1,
        logoUrl: null,
      }
    );
  });

  test("a consultation booked by an agent carries the agency of the resolved principal, not of the agent document", async () => {
    // An agent document that CLAIMS ownership of an agency whose record names
    // somebody else (data from before agent documents were server-written).
    // The role lookup does not honour it; nor may the consultation.
    const victim = await seedAgency("e2-victim");
    const agent = await seedIndependentAgent("e2-agent", {
      agencyId: victim.agencyId,
      agencyRole: "owner",
      verificationStatus: "verified",
    });
    const client = await seedClient("e2-client");

    const principal = await resolved(agent.account.idToken);
    const res = await api.call("POST", "/consultations", agent.account.idToken, {
      userId: client.uid,
      type: "video",
      scheduledDate: "2027-01-15",
      scheduledTime: "10:00",
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const consultation = await stored("consultations", res.body.data.id);

    assert.deepEqual(
      { principalAgencyId: principal.agencyId, consultationAgencyId: consultation.agencyId ?? null },
      { principalAgencyId: null, consultationAgencyId: null }
    );
  });

  test("a consultation booked by a real member still carries their agency", async () => {
    const agency = await seedAgency("e3");
    const member = await seedMember(agency, "e3-member");
    const client = await seedClient("e3-client");

    const res = await api.call("POST", "/consultations", member.account.idToken, {
      userId: client.uid,
      type: "video",
      scheduledDate: "2027-01-15",
      scheduledTime: "10:00",
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal((await stored("consultations", res.body.data.id)).agencyId, agency.agencyId);
  });
});

// ============================================
// F. Invitations: list, accept, decline
// ============================================

describe("F. invitations", () => {
  test("only the invited address can decline an invitation", async () => {
    const agency = await seedAgency("f1");
    const invitee = await seedClient("f1-invitee");
    const stranger = await seedClient("f1-stranger");
    const inviteId = `invite-f1-${Date.now()}`;
    await seedInvitation(agency, inviteId, invitee.email);

    const byStranger = await api.call("POST", `/invitations/${inviteId}/decline`, stranger.idToken, {});
    const afterStranger = (await stored("agencyInvitations", inviteId)).status;
    const byInvitee = await api.call("POST", `/invitations/${inviteId}/decline`, invitee.idToken, {});

    assert.deepEqual(
      {
        byStranger: byStranger.status,
        afterStranger,
        byInvitee: byInvitee.status,
        afterInvitee: (await stored("agencyInvitations", inviteId)).status,
      },
      { byStranger: 400, afterStranger: "pending", byInvitee: 200, afterInvitee: "declined" }
    );
  });

  test("the invited-address match holds on every redemption path (accept, join-agency)", async () => {
    const agency = await seedAgency("f2");
    const invitee = await seedClient("f2-invitee");
    const stranger = await seedClient("f2-stranger");
    const inviteId = `invite-f2-${Date.now()}`;
    await seedInvitation(agency, inviteId, invitee.email);

    const accept = await api.call("POST", `/invitations/${inviteId}/accept`, stranger.idToken, {});
    const join = await api.call("POST", "/onboarding/join-agency", stranger.idToken, {
      invitationId: inviteId,
      firstName: "Not",
      lastName: "Invited",
    });
    const listed = await api.call("GET", "/invitations/pending", stranger.idToken);

    assert.deepEqual(
      {
        accept: accept.status,
        join: join.status,
        strangerSeesIt: (listed.body.data as any[]).some((i) => i.id === inviteId),
        status: (await stored("agencyInvitations", inviteId)).status,
        totalAgents: (await stored("agencies", agency.agencyId)).totalAgents,
      },
      { accept: 400, join: 403, strangerSeesIt: false, status: "pending", totalAgents: 1 }
    );
  });

  // DECISION RECORDED, NOT A PROTECTION (issue #138, item F): the portal's
  // invite link signs the invitee up with email + password and joins the
  // agency in the same step, and nothing in the portal asks them to verify
  // the address. Requiring a verified email here would lock every such
  // invitee out, so it is NOT enforced yet. This test pins today's behaviour
  // so that changing it is a deliberate act: when the portal gains a
  // verification step, flip the expectations below.
  test("CURRENT BEHAVIOUR: an invitee whose email is not yet verified can list and accept (portal has no verify step)", async () => {
    const agency = await seedAgency("f3");
    const invitee = await signUp("f3-invitee"); // password sign-up: email_verified is false
    await provisionUserDoc(invitee);
    const inviteId = `invite-f3-${Date.now()}`;
    await seedInvitation(agency, inviteId, invitee.email);

    const payload = JSON.parse(Buffer.from(invitee.idToken.split(".")[1], "base64url").toString());
    const listed = await api.call("GET", "/invitations/pending", invitee.idToken);
    const join = await api.call("POST", "/onboarding/join-agency", invitee.idToken, {
      invitationId: inviteId,
      firstName: "Real",
      lastName: "Invitee",
    });

    assert.deepEqual(
      {
        emailVerified: payload.email_verified,
        listed: (listed.body.data as any[]).some((i) => i.id === inviteId),
        join: join.status,
      },
      { emailVerified: false, listed: true, join: 200 }
    );
  });
});

// ============================================
// G. Joining an agency needs the agent's consent
// ============================================

describe("G. an independent agent joins an agency only by accepting an invitation", () => {
  test("POST /agencies/:id/members sends an invitation instead of attaching the agent", async () => {
    const agency = await seedAgency("g1");
    const indie = await seedIndependentAgent("g1-indie", { verificationStatus: "verified" });

    const add = await api.call("POST", `/agencies/${agency.agencyId}/members`, agency.owner.idToken, {
      agentId: indie.agentDocId,
    });
    const agentAfterAdd = await stored("agents", indie.agentDocId);
    const invitations = await invitationsOf(agency.agencyId);
    const pending = invitations.filter((i) => i.status === "pending" && i.invitedEmail === indie.account.email);

    assert.deepEqual(
      {
        add: add.status,
        agencyIdAfterAdd: agentAfterAdd.agencyId ?? null,
        totalAgentsAfterAdd: (await stored("agencies", agency.agencyId)).totalAgents,
        pendingInvitations: pending.length,
        invitedBy: pending[0]?.invitedBy,
        invitedAgentId: pending[0]?.invitedAgentId,
      },
      {
        add: 202,
        agencyIdAfterAdd: null,
        totalAgentsAfterAdd: 1,
        pendingInvitations: 1,
        invitedBy: agency.owner.uid,
        invitedAgentId: indie.agentDocId,
      }
    );

    // The agent says yes: now (and only now) they are a member, with claims.
    const accept = await api.call("POST", `/invitations/${pending[0].id}/accept`, indie.account.idToken, {});
    const agentAfterAccept = await stored("agents", indie.agentDocId);
    const claims = await claimsOf(indie.account.uid);
    assert.deepEqual(
      {
        accept: accept.status,
        agencyId: agentAfterAccept.agencyId,
        agencyRole: agentAfterAccept.agencyRole,
        totalAgents: (await stored("agencies", agency.agencyId)).totalAgents,
        roleClaim: claims.role,
        agencyClaim: claims.agencyId,
      },
      {
        accept: 200,
        agencyId: agency.agencyId,
        agencyRole: "agent",
        totalAgents: 2,
        roleClaim: "agent",
        agencyClaim: agency.agencyId,
      }
    );
  });

  test("adding an agent who already belongs to an agency, or who does not exist, is refused", async () => {
    const agency = await seedAgency("g2");
    const other = await seedAgency("g2-other");
    const taken = await seedMember(other, "g2-taken");
    const t = agency.owner.idToken;
    const base = `/agencies/${agency.agencyId}/members`;

    assert.deepEqual(
      {
        taken: (await api.call("POST", base, t, { agentId: taken.agentDocId })).status,
        missing: (await api.call("POST", base, t, { agentId: "no-such-agent" })).status,
        noBody: (await api.call("POST", base, t, {})).status,
        invitationsWritten: (await invitationsOf(agency.agencyId)).length,
        takenStillThere: (await stored("agents", taken.agentDocId)).agencyId === other.agencyId,
      },
      { taken: 400, missing: 400, noBody: 400, invitationsWritten: 0, takenStillThere: true }
    );
  });
});
