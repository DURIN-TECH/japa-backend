// ============================================
// Emulator test — the read-only role / membership audit (issue #135)
// ============================================
//
// Run with `npm run test:emulator`. Seeds the Auth + Firestore emulators with
// one clean agency (owner + invited member + a proper admin) and one example
// of each inconsistency the audit must report, then checks that:
//  - every planted inconsistency is reported under the right code,
//  - the clean records are NOT reported,
//  - the audit changed nothing (documents and custom claims are identical
//    before and after),
//  - the command a human runs (`audit-role-trust --project <id>`) works end
//    to end and prints the report.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as path from "node:path";

import { PROJECT_ID, resetEmulators, rulesEnv, signUp, TestAccount } from "./helpers";
import { auditRoleTrust, AuditReport, formatAuditReport } from "../../src/scripts/audit-role-trust";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ============================================
// Seeded world
// ============================================

/** Accounts created in before(), by the part they play. */
const who: Record<string, TestAccount> = {};
const AGENCY = "agency-clean";
let report: AuditReport;
/** Snapshot of all audited data taken before and after the audit ran. */
let stateBefore: unknown;
let stateAfter: unknown;

/** Everything the audit reads, in a comparable form. */
async function snapshotState(): Promise<unknown> {
  const { auth, collections } = await import("../../src/utils/firebase");
  const dump = async (c: any) =>
    (await c.get()).docs
      .map((d: any) => ({ id: d.id, data: JSON.stringify(d.data()), updated: d.updateTime.toMillis() }))
      .sort((a: any, b: any) => a.id.localeCompare(b.id));
  const users = (await auth.listUsers(1000)).users
    .map((u) => ({ uid: u.uid, claims: JSON.stringify(u.customClaims ?? {}) }))
    .sort((a, b) => a.uid.localeCompare(b.uid));
  return {
    accounts: users,
    users: await dump(collections.users),
    agents: await dump(collections.agents),
    agencies: await dump(collections.agencies),
    invitations: await dump(collections.agencyInvitations),
  };
}

before(async () => {
  await rulesEnv();
  await resetEmulators();
  const { auth, collections } = await import("../../src/utils/firebase");

  for (const name of [
    "owner", // real owner of AGENCY
    "member", // invited member of AGENCY
    "admin", // proper admin (role claim + profile flag), on the expected list
    "legacyAdmin", // admin by the old `admin: true` claim only, NOT on the expected list
    "flagOnly", // profile says admin, no claim
    "fakeOwner", // agent document + claims say owner of AGENCY; the agency says otherwise
    "uninvited", // member of AGENCY with no accepted invitation
    "ghostAgency", // agent document names an agency that does not exist
    "claimOnly", // claims say agent of AGENCY, no agent document
    "selfInvited", // member of AGENCY whose only "accepted invitation" they issued themselves
  ]) {
    who[name] = await signUp(`audit-${name.toLowerCase()}`);
    await collections.users.doc(who[name].uid).set({ id: who[name].uid, email: who[name].email });
  }

  /** Write an agent document for one of the accounts. */
  const agent = (name: string, fields: Record<string, unknown>) =>
    collections.agents.doc(`agent-${name}`).set({ id: `agent-${name}`, userId: who[name].uid, ...fields });

  // ---- The clean part.
  await collections.agencies.doc(AGENCY).set({ id: AGENCY, name: "Clean Agency", ownerId: who.owner.uid });
  await agent("owner", { agencyId: AGENCY, agencyRole: "owner" });
  await auth.setCustomUserClaims(who.owner.uid, { role: "owner", agencyId: AGENCY, admin: false });
  await agent("member", { agencyId: AGENCY, agencyRole: "agent" });
  await auth.setCustomUserClaims(who.member.uid, { role: "agent", agencyId: AGENCY, admin: false });
  await collections.agencyInvitations.doc("invite-member").set({
    id: "invite-member",
    agencyId: AGENCY,
    invitedBy: who.owner.uid,
    // Stored with different casing on purpose: matching is case-insensitive.
    invitedEmail: who.member.email.toUpperCase(),
    status: "accepted",
  });
  await auth.setCustomUserClaims(who.admin.uid, { role: "admin", agencyId: null, admin: true });
  await collections.users.doc(who.admin.uid).update({ admin: true });

  // ---- The planted inconsistencies.
  await auth.setCustomUserClaims(who.legacyAdmin.uid, { admin: true });
  await collections.users.doc(who.flagOnly.uid).update({ admin: true });
  await agent("fakeOwner", { agencyId: AGENCY, agencyRole: "owner" });
  await auth.setCustomUserClaims(who.fakeOwner.uid, { role: "owner", agencyId: AGENCY, admin: false });
  await agent("uninvited", { agencyId: AGENCY, agencyRole: "agent" });
  await agent("ghostAgency", { agencyId: "agency-that-is-not-there", agencyRole: "agent" });
  await auth.setCustomUserClaims(who.claimOnly.uid, { role: "agent", agencyId: AGENCY, admin: false });

  // Invitations NOT issued by the agency's owner: one accepted (it must not
  // count as backing selfInvited's membership), one still pending, and one
  // naming an agency that does not exist.
  await agent("selfInvited", { agencyId: AGENCY, agencyRole: "agent" });
  await collections.agencyInvitations.doc("invite-self-accepted").set({
    id: "invite-self-accepted",
    agencyId: AGENCY,
    invitedBy: who.selfInvited.uid,
    invitedEmail: who.selfInvited.email,
    status: "accepted",
  });
  await collections.agencyInvitations.doc("invite-self-pending").set({
    id: "invite-self-pending",
    agencyId: AGENCY,
    invitedBy: who.flagOnly.uid,
    invitedEmail: who.flagOnly.email,
    status: "pending",
  });
  await collections.agencyInvitations.doc("invite-ghost-agency").set({
    id: "invite-ghost-agency",
    agencyId: "agency-that-is-not-there",
    invitedBy: who.owner.uid,
    invitedEmail: who.claimOnly.email,
    status: "pending",
  });
  // A proper pending invitation from the real owner: must NOT be reported.
  await collections.agencyInvitations.doc("invite-real-pending").set({
    id: "invite-real-pending",
    agencyId: AGENCY,
    invitedBy: who.owner.uid,
    invitedEmail: "delivered+future-member@resend.dev",
    status: "pending",
  });

  // ---- Run the audit once, between two snapshots.
  stateBefore = await snapshotState();
  report = await auditRoleTrust({ auth, collections }, { expectedAdminEmails: [who.admin.email.toUpperCase()] });
  stateAfter = await snapshotState();
});

after(async () => {
  await (await rulesEnv()).cleanup();
});

/** Issue codes reported for one agent document. */
const agentCodes = (name: string) =>
  (report.agentFindings.find((f) => f.agentDocId === `agent-${name}`)?.issues ?? []).map((i) => i.code);

/** Issue codes reported for one account's claims. */
const claimCodes = (name: string) =>
  report.claimFindings.filter((f) => f.uid === who[name].uid).flatMap((f) => f.issues.map((i) => i.code));

// ============================================
// Tests
// ============================================

describe("audit-role-trust (read-only)", () => {
  test("changes nothing: documents, update times and custom claims are identical afterwards", () => {
    assert.deepEqual(stateAfter, stateBefore);
  });

  test("section 1: lists a profile flagged admin without the claim, and only that one", () => {
    assert.deepEqual(
      report.adminFieldWithoutClaim.map((f) => f.uid),
      [who.flagOnly.uid]
    );
    assert.equal(report.adminFieldWithoutClaim[0].email, who.flagOnly.email);
  });

  test("section 2: lists every admin-claim holder and marks the unexpected one", () => {
    const byUid = new Map(report.adminClaimHolders.map((h) => [h.uid, h]));
    assert.deepEqual([...byUid.keys()].sort(), [who.admin.uid, who.legacyAdmin.uid].sort());
    assert.equal(byUid.get(who.admin.uid)?.expected, true);
    assert.equal(byUid.get(who.admin.uid)?.profileAdminField, true);
    assert.equal(byUid.get(who.legacyAdmin.uid)?.expected, false);
    assert.equal(byUid.get(who.legacyAdmin.uid)?.claimRole, null);
    assert.equal(byUid.get(who.legacyAdmin.uid)?.legacyAdminClaim, true);
  });

  test("section 3: reports each kind of unbacked agent document under its code", () => {
    assert.deepEqual(agentCodes("fakeOwner"), ["OWNER_NOT_CONFIRMED"]);
    assert.deepEqual(agentCodes("uninvited"), ["MEMBER_NO_INVITATION"]);
    assert.deepEqual(agentCodes("ghostAgency"), ["AGENCY_MISSING"]);
  });

  test("section 3: a real owner and an invited member are not reported", () => {
    assert.deepEqual(agentCodes("owner"), []);
    assert.deepEqual(agentCodes("member"), []);
  });

  test("section 5: reports every invitation not issued by the agency's owner, pending or accepted", () => {
    const byId = new Map(report.invitationFindings.map((f) => [f.invitationId, f]));
    assert.deepEqual([...byId.keys()].sort(), ["invite-ghost-agency", "invite-self-accepted", "invite-self-pending"]);
    assert.deepEqual(byId.get("invite-self-accepted")?.issues.map((i) => [i.code, i.severity]), [
      ["INVITER_NOT_AGENCY_OWNER", "high"],
    ]);
    assert.equal(byId.get("invite-self-accepted")?.status, "accepted");
    assert.deepEqual(byId.get("invite-self-pending")?.issues.map((i) => [i.code, i.severity]), [
      ["INVITER_NOT_AGENCY_OWNER", "high"],
    ]);
    assert.deepEqual(byId.get("invite-ghost-agency")?.issues.map((i) => i.code), ["INVITATION_AGENCY_MISSING"]);
    assert.equal(report.totals.invitations, 5);
    assert.equal(report.totals.acceptedInvitations, 1); // only the owner-issued one
  });

  test("section 3: an invitation the member issued to themselves does not back their membership", () => {
    assert.deepEqual(agentCodes("selfInvited"), ["MEMBER_NO_INVITATION"]);
  });

  test("section 4: reports claims the records do not confirm", () => {
    assert.deepEqual(claimCodes("fakeOwner"), ["OWNER_CLAIM_NOT_CONFIRMED"]);
    assert.deepEqual(claimCodes("claimOnly"), ["AGENT_CLAIM_NO_AGENT_DOC"]);
    assert.deepEqual(claimCodes("owner"), []);
    assert.deepEqual(claimCodes("member"), []);
  });

  test("the text report names the project, says it is read-only and shows the findings", () => {
    const text = formatAuditReport(report, PROJECT_ID);
    assert.match(text, new RegExp(`project: ${PROJECT_ID}`));
    assert.match(text, /READ-ONLY: nothing was changed/);
    assert.match(text, /NOT ON THE EXPECTED LIST/);
    assert.match(text, /OWNER_NOT_CONFIRMED/);
    assert.match(text, /5\. Invitations NOT issued by the agency's owner \(any status\): 3/);
    assert.match(text, /INVITER_NOT_AGENCY_OWNER/);
    assert.ok(text.includes(who.flagOnly.uid));
  });

  test("the command a human runs works end to end (and still changes nothing)", async () => {
    const cwd = path.resolve(__dirname, "../..");
    const run = spawnSync(
      process.execPath,
      ["--import", "tsx", "src/scripts/audit-role-trust.ts", "--project", PROJECT_ID, "--expected-admins", who.admin.email],
      { cwd, env: process.env, encoding: "utf8" }
    );
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /Role \/ membership audit for project/);
    assert.match(run.stdout, /1\. Profile says admin, account has NO admin claim: 1/);
    assert.match(run.stdout, /2\. Accounts holding the admin claim: 2/);
    // Reading an emulator is announced, so the output cannot pass for a real audit.
    assert.match(run.stdout, /EMULATOR RUN/);
    assert.match(run.stdout, /says NOTHING about durin-seli-dev or japa-platform/);
    assert.deepEqual(await snapshotState(), stateBefore);
  });

  test("with an emulator variable set, a real project id is refused (no silent all-clear)", () => {
    const cwd = path.resolve(__dirname, "../..");
    /** Run the CLI with the given project id and environment overrides. */
    const run = (project: string, env: Record<string, string | undefined>) =>
      spawnSync(process.execPath, ["--import", "tsx", "src/scripts/audit-role-trust.ts", "--project", project], {
        cwd,
        env: { ...process.env, ...env },
        encoding: "utf8",
      });

    for (const project of ["durin-seli-dev", "japa-platform"]) {
      const refused = run(project, {});
      assert.equal(refused.status, 1, refused.stdout);
      assert.match(refused.stderr, new RegExp(`Refusing to audit project "${project}"`));
      assert.match(refused.stderr, /would read the EMULATOR/);
      assert.doesNotMatch(refused.stdout, /Role \/ membership audit/); // no report printed
    }

    // Only ONE emulator variable set (the other service would be real): refused too.
    const half = run("demo-half", { FIREBASE_AUTH_EMULATOR_HOST: undefined });
    assert.equal(half.status, 1, half.stdout);
    assert.match(half.stderr, /Set both FIRESTORE_EMULATOR_HOST and FIREBASE_AUTH_EMULATOR_HOST/);
  });
});
