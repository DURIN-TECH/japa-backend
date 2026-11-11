// ============================================
// Shared fixtures for the agency-authority emulator tests (issue #138)
// ============================================
//
// NOT a test file (the runner only picks up *.emu.ts). Everything here talks
// to the local emulators through ./helpers, so the same guard applies
// (test/emulator/setup.ts refuses anything that is not a demo- project on
// this machine).
//
// The fixtures write documents the way the BACKEND would have written them
// (rules switched off), so each test starts from a realistic, consistent
// world: an agency whose record and whose owner's agent document agree, a
// member who belongs to it, an independent agent, an applicant with a case.

import { refreshIdToken, signUp, TestAccount, withoutRules } from "./helpers";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ============================================
// Types
// ============================================

/** An agency with a real owner (agency record and owner agent document agree). */
export interface SeededAgency {
  agencyId: string;
  owner: TestAccount;
  ownerAgentDocId: string;
}

/** An agent account plus the id of its agent document. */
export interface SeededAgent {
  account: TestAccount;
  agentDocId: string;
}

// ============================================
// Accounts and profiles
// ============================================

/**
 * What the Auth onCreate trigger writes for a new account (src/index.ts).
 * The functions emulator is not running, so the tests put it in place.
 */
export async function provisionUserDoc(account: TestAccount, extra: Record<string, unknown> = {}): Promise<void> {
  await withoutRules(async (db) => {
    await db
      .collection("users")
      .doc(account.uid)
      .set({
        id: account.uid,
        email: account.email,
        firstName: "Test",
        lastName: "User",
        onboardingCompleted: false,
        hasPassport: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...extra,
      });
  });
}

/** A signed-up account with its profile document (a plain client). */
export async function seedClient(name: string): Promise<TestAccount> {
  const account = await signUp(name);
  await provisionUserDoc(account);
  return account;
}

/**
 * An agency with a real owner, shaped like what owner onboarding writes: the
 * agency document names the owner, and the owner's agent document names the
 * agency with `agencyRole: "owner"`. `fields` overrides agency fields (e.g.
 * `status`, `compliance`).
 */
export async function seedAgency(name: string, fields: Record<string, unknown> = {}): Promise<SeededAgency> {
  const owner = await signUp(`${name}-owner`);
  await provisionUserDoc(owner);
  const agencyId = `agency-${name}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const ownerAgentDocId = `agent-${owner.uid}`;
  await withoutRules(async (db) => {
    await db
      .collection("agencies")
      .doc(agencyId)
      .set({
        id: agencyId,
        name: `Agency ${name}`,
        slug: agencyId,
        ownerId: owner.uid,
        ownerName: "Real Owner",
        services: [],
        totalAgents: 1,
        totalCases: 0,
        activeCases: 0,
        status: "approved",
        createdAt: new Date(),
        updatedAt: new Date(),
        ...fields,
      });
    await db.collection("agents").doc(ownerAgentDocId).set({
      id: ownerAgentDocId,
      userId: owner.uid,
      agencyId,
      agencyRole: "owner",
      displayName: "Real Owner",
      verificationStatus: "verified",
      isAvailable: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });
  return { agencyId, owner, ownerAgentDocId };
}

/**
 * A member (non-owner agent) of `agency`, as invitation acceptance leaves
 * things: the agent document names the agency and the agency's member count
 * goes up by one.
 */
export async function seedMember(agency: SeededAgency, name: string): Promise<SeededAgent> {
  const account = await signUp(name);
  await provisionUserDoc(account);
  const agentDocId = `agent-${account.uid}`;
  await withoutRules(async (db) => {
    await db.collection("agents").doc(agentDocId).set({
      id: agentDocId,
      userId: account.uid,
      agencyId: agency.agencyId,
      agencyRole: "agent",
      displayName: `Member ${name}`,
      verificationStatus: "verified",
      isAvailable: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const ref = db.collection("agencies").doc(agency.agencyId);
    const current = (await ref.get()).data().totalAgents as number;
    await ref.update({ totalAgents: current + 1 });
  });
  return { account, agentDocId };
}

/**
 * An agent with no agency, as POST /agents creates one. `fields` overrides
 * agent fields (e.g. `verificationStatus: "verified"`).
 */
export async function seedIndependentAgent(name: string, fields: Record<string, unknown> = {}): Promise<SeededAgent> {
  const account = await signUp(name);
  await provisionUserDoc(account);
  const agentDocId = `agent-${account.uid}`;
  await withoutRules(async (db) => {
    await db
      .collection("agents")
      .doc(agentDocId)
      .set({
        id: agentDocId,
        userId: account.uid,
        displayName: `Indie ${name}`,
        bio: "",
        verificationStatus: "pending",
        isAvailable: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...fields,
      });
  });
  return { account, agentDocId };
}

/**
 * Give an account the admin role the only way that counts (custom claims,
 * written with the Admin SDK) and return a token that carries it.
 */
export async function makeAdmin(account: TestAccount): Promise<string> {
  const { auth } = await import("../../src/utils/firebase");
  await auth.setCustomUserClaims(account.uid, { role: "admin", admin: true, agencyId: null });
  return refreshIdToken(account);
}

// ============================================
// Documents
// ============================================

/** Read one document with the rules switched off (what is really stored). */
export async function stored(collection: string, id: string): Promise<any> {
  let data: any;
  await withoutRules(async (db) => {
    data = (await db.collection(collection).doc(id).get()).data();
  });
  return data;
}

/** Write one document with the rules switched off (backend / legacy data). */
export async function put(collection: string, id: string, data: Record<string, unknown>): Promise<void> {
  await withoutRules(async (db) => {
    await db.collection(collection).doc(id).set(data);
  });
}

/**
 * An application as the API creates one. `agentId` on applications is the
 * agent's USER uid (not the agent document id).
 */
export async function seedApplication(id: string, fields: Record<string, unknown>): Promise<void> {
  await put("applications", id, {
    id,
    visaTypeId: "visa-1",
    countryCode: "IE",
    visaTypeName: "Study visa",
    countryName: "Ireland",
    mode: "agent",
    status: "submitted",
    createdVia: "portal",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...fields,
  });
}

/** A pending invitation issued by the agency's real owner, as the API writes it. */
export async function seedInvitation(agency: SeededAgency, id: string, invitedEmail: string): Promise<void> {
  await put("agencyInvitations", id, {
    id,
    agencyId: agency.agencyId,
    agencyName: "Agency",
    invitedBy: agency.owner.uid,
    invitedByName: "Real Owner",
    invitedEmail,
    status: "pending",
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 7 * 86_400_000),
  });
}
