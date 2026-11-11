// ============================================
// Emulator test — the read-only agency review audit (issue #138)
// ============================================
//
// Run with `npm run test:emulator`. Seeds the Auth + Firestore emulators with
// one clean approved agency, one clean pending agency and one example of each
// way an agency's `status` / `compliance` can disagree with an admin review
// record, then checks that:
//  - every planted inconsistency is reported under the right code,
//  - the clean records are NOT reported,
//  - the audit changed nothing (documents, update times and custom claims are
//    identical before and after),
//  - the command a human runs (`audit-agency-review --project <id>`) works end
//    to end and prints the report.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as path from "node:path";

import { PROJECT_ID, resetEmulators, rulesEnv, signUp, TestAccount } from "./helpers";
import { auditAgencyReview, AgencyReviewReport, formatAgencyReviewReport } from "../../src/scripts/audit-agency-review";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ============================================
// Seeded world
// ============================================

/** Accounts created in before(), by the part they play. */
const who: Record<string, TestAccount> = {};
let report: AgencyReviewReport;
/** Snapshot of all audited data taken before and after the audit ran. */
let stateBefore: unknown;
let stateAfter: unknown;

/** Everything the audit reads, in a comparable form. */
async function snapshotState(): Promise<unknown> {
  const { auth, collections } = await import("../../src/utils/firebase");
  const agencies = (await collections.agencies.get()).docs
    .map((d: any) => ({ id: d.id, data: JSON.stringify(d.data()), updated: d.updateTime.toMillis() }))
    .sort((a: any, b: any) => a.id.localeCompare(b.id));
  const users = (await auth.listUsers(1000)).users
    .map((u) => ({ uid: u.uid, claims: JSON.stringify(u.customClaims ?? {}) }))
    .sort((a, b) => a.uid.localeCompare(b.uid));
  const dump = async (c: any) =>
    (await c.get()).docs
      .map((d: any) => ({ id: d.id, data: JSON.stringify(d.data()), updated: d.updateTime.toMillis() }))
      .sort((a: any, b: any) => a.id.localeCompare(b.id));
  return {
    accounts: users,
    agencies,
    agents: await dump(collections.agents),
    applications: await dump(collections.applications),
  };
}

before(async () => {
  await rulesEnv();
  await resetEmulators();
  const { auth, collections } = await import("../../src/utils/firebase");

  for (const name of ["admin", "client", "owner", "ownerPending", "ownerNoClaim", "ownerNoDoc"]) {
    who[name] = await signUp(`review-${name}`);
    await collections.users.doc(who[name].uid).set({ id: who[name].uid, email: who[name].email });
  }
  await auth.setCustomUserClaims(who.admin.uid, { role: "admin", agencyId: null, admin: true });
  await auth.setCustomUserClaims(who.client.uid, { role: "client", agencyId: null, admin: false });
  await auth.setCustomUserClaims(who.owner.uid, { role: "owner", agencyId: "agency-clean", admin: false });
  await auth.setCustomUserClaims(who.ownerPending.uid, { role: "owner", agencyId: "agency-pending", admin: false });
  // ownerNoClaim keeps the agent document but the claims say independent agent.
  await auth.setCustomUserClaims(who.ownerNoClaim.uid, { role: "agent", agencyId: null, admin: false });
  // ownerNoDoc has the claim but no agent document.
  await auth.setCustomUserClaims(who.ownerNoDoc.uid, { role: "owner", agencyId: "agency-owner-no-doc", admin: false });

  const now = new Date();
  const reviewed = { reviewedBy: who.admin.uid, reviewedAt: now };
  const agency = (id: string, fields: Record<string, unknown>) =>
    collections.agencies.doc(id).set({ id, name: id, ownerId: who.owner.uid, ...fields });
  /** The owner's agent document, as owner onboarding writes it. */
  const ownerDoc = (agencyId: string, owner: TestAccount) =>
    collections.agents
      .doc(`agent-${owner.uid}`)
      .set({ id: `agent-${owner.uid}`, userId: owner.uid, agencyId, agencyRole: "owner" });

  // ---- Clean records: a reviewed approval and an undecided pending agency.
  await agency("agency-clean", {
    status: "approved",
    ...reviewed,
    compliance: {
      status: "verified",
      submittedAt: now,
      reviewedBy: who.admin.uid,
      reviewedAt: now,
    },
  });
  await ownerDoc("agency-clean", who.owner);
  await agency("agency-pending", {
    ownerId: who.ownerPending.uid,
    status: "pending_review",
    compliance: { status: "in_progress", legalFirstName: "Olu" },
  });
  await ownerDoc("agency-pending", who.ownerPending);

  // ---- Inconsistencies.
  await agency("agency-approved-no-review", { status: "approved" });
  await agency("agency-pending-with-review", { status: "pending_review", ...reviewed });
  await agency("agency-reviewer-not-admin", {
    status: "approved",
    reviewedBy: who.client.uid,
    reviewedAt: now,
  });
  await agency("agency-reviewer-ghost", {
    status: "rejected",
    reviewedBy: "no-such-account",
    reviewedAt: now,
  });
  await agency("agency-approved-missing-at", {
    status: "approved",
    reviewedBy: who.admin.uid,
  });
  await agency("agency-compliance-forged", {
    status: "pending_review",
    compliance: { status: "verified", submittedAt: now },
  });
  await agency("agency-compliance-missing-at", {
    status: "pending_review",
    compliance: { status: "verified", submittedAt: now, reviewedBy: who.admin.uid },
  });
  await agency("agency-compliance-under-review-no-submit", {
    status: "pending_review",
    compliance: { status: "under_review" },
  });
  await agency("agency-compliance-reviewer-not-admin", {
    status: "pending_review",
    compliance: {
      status: "rejected",
      submittedAt: now,
      reviewedBy: who.client.uid,
      reviewedAt: now,
    },
  });

  // ---- Owner and application inconsistencies.
  await agency("agency-owner-no-doc", { ownerId: who.ownerNoDoc.uid, status: "pending_review" });
  await agency("agency-owner-no-claim", { ownerId: who.ownerNoClaim.uid, status: "pending_review" });
  await ownerDoc("agency-owner-no-claim", who.ownerNoClaim);
  const applicant = who.client.uid;
  const app = (id: string, fields: Record<string, unknown>) =>
    collections.applications.doc(id).set({ id, userId: applicant, ...fields });
  await app("app-clean", { agencyId: "agency-clean", agentId: who.owner.uid });
  await app("app-self-service", { mode: "self" }); // no agency, no agent: nothing to check
  await app("app-agent-doc-id", { agencyId: "agency-clean", agentId: `agent-${who.owner.uid}` }); // legacy id: accepted
  await app("app-ghost-agency", { agencyId: "agency-gone", agentId: who.owner.uid });
  await app("app-ghost-agent", { agencyId: "agency-clean", agentId: "no-such-agent" });
  await app("app-ghost-both", { agencyId: "agency-gone", agentId: "no-such-agent" });

  // ---- Run the audit once, between two snapshots.
  stateBefore = await snapshotState();
  report = await auditAgencyReview({
    auth,
    agencies: collections.agencies,
    agents: collections.agents,
    applications: collections.applications,
  });
  stateAfter = await snapshotState();
});

after(async () => {
  await (await rulesEnv()).cleanup();
});

/** All issue codes reported for one agency. */
const allCodes = (agencyId: string) =>
  (report.findings.find((f) => f.agencyId === agencyId)?.issues ?? []).map((i) => i.code);
/**
 * Review-record codes only. The agencies planted for the review-record tests
 * share one owner without an agent document of their own, so they also carry
 * OWNER_* findings; those are asserted separately below.
 */
const codes = (agencyId: string) => allCodes(agencyId).filter((c) => !c.startsWith("OWNER_"));
/** Issue codes reported for one application. */
const appCodes = (id: string) =>
  (report.applicationFindings.find((f) => f.applicationId === id)?.issues ?? []).map((i) => i.code);

// ============================================
// Tests
// ============================================

describe("audit-agency-review (read-only)", () => {
  test("changes nothing: documents, update times and custom claims are identical afterwards", () => {
    assert.deepEqual(stateAfter, stateBefore);
  });

  test("reports a decision without a review record, and only the planted ones", () => {
    assert.deepEqual(codes("agency-approved-no-review"), ["STATUS_DECISION_WITHOUT_REVIEW"]);
    assert.deepEqual(codes("agency-approved-missing-at"), ["STATUS_DECISION_WITHOUT_REVIEW"]);
    assert.deepEqual(codes("agency-reviewer-ghost"), ["STATUS_REVIEWER_NOT_ADMIN"]);
    assert.deepEqual(codes("agency-reviewer-not-admin"), ["STATUS_REVIEWER_NOT_ADMIN"]);
    assert.deepEqual(codes("agency-pending-with-review"), ["STATUS_PENDING_WITH_REVIEW"]);
  });

  test("reports a compliance decision without its own review record", () => {
    assert.deepEqual(codes("agency-compliance-forged"), ["COMPLIANCE_DECISION_WITHOUT_REVIEW"]);
    assert.deepEqual(codes("agency-compliance-missing-at"), ["COMPLIANCE_DECISION_WITHOUT_REVIEW"]);
    assert.deepEqual(codes("agency-compliance-under-review-no-submit"), [
      "COMPLIANCE_UNDER_REVIEW_WITHOUT_SUBMISSION",
    ]);
    assert.deepEqual(codes("agency-compliance-reviewer-not-admin"), [
      "COMPLIANCE_REVIEWER_NOT_ADMIN",
    ]);
  });

  test("does NOT report the clean agencies", () => {
    assert.deepEqual(codes("agency-clean"), []);
    assert.deepEqual(codes("agency-pending"), []);
    assert.equal(
      report.findings.some((f) => f.agencyId === "agency-clean" || f.agencyId === "agency-pending"),
      false
    );
  });

  test("reports an owner with no owner agent document or no owner claim, and not a backed owner", () => {
    assert.deepEqual(allCodes("agency-owner-no-doc"), ["OWNER_NO_AGENT_DOC"]);
    assert.deepEqual(allCodes("agency-owner-no-claim"), ["OWNER_NO_OWNER_CLAIM"]);
    assert.deepEqual(allCodes("agency-clean"), []);
    assert.deepEqual(allCodes("agency-pending"), []);
    // The shared-owner planted agencies have the claim for agency-clean only.
    assert.deepEqual(allCodes("agency-approved-no-review"), [
      "STATUS_DECISION_WITHOUT_REVIEW",
      "OWNER_NO_AGENT_DOC",
      "OWNER_NO_OWNER_CLAIM",
    ]);
  });

  test("reports applications pointing at a missing agency or agent, and nothing else", () => {
    assert.deepEqual(appCodes("app-ghost-agency"), ["APPLICATION_AGENCY_MISSING"]);
    assert.deepEqual(appCodes("app-ghost-agent"), ["APPLICATION_AGENT_MISSING"]);
    assert.deepEqual(appCodes("app-ghost-both"), ["APPLICATION_AGENCY_MISSING", "APPLICATION_AGENT_MISSING"]);
    assert.equal(report.applicationFindings.length, 3);
    for (const clean of ["app-clean", "app-self-service", "app-agent-doc-id"]) {
      assert.deepEqual(appCodes(clean), [], clean);
    }
    assert.equal(report.totals.applications, 6);
  });

  test("totals count every agency and only the decided ones", () => {
    assert.equal(report.totals.agencies, 13);
    // approved / rejected decisions: clean, approved-no-review,
    // reviewer-not-admin, reviewer-ghost, approved-missing-at = 5.
    assert.equal(report.totals.statusDecided, 5);
    // compliance verified / rejected: clean, forged, missing-at,
    // reviewer-not-admin = 4.
    assert.equal(report.totals.complianceDecided, 4);
  });

  test("the text report names the project, says it is read-only and shows the findings", () => {
    const text = formatAgencyReviewReport(report, PROJECT_ID);
    assert.match(text, new RegExp(`project: ${PROJECT_ID}`));
    assert.match(text, /READ-ONLY: nothing was changed/);
    assert.match(text, /STATUS_DECISION_WITHOUT_REVIEW/);
    assert.match(text, /COMPLIANCE_DECISION_WITHOUT_REVIEW/);
    assert.ok(text.includes("agency-approved-no-review"));
  });

  test("the command a human runs works end to end (and still changes nothing)", async () => {
    const cwd = path.resolve(__dirname, "../..");
    const run = spawnSync(
      process.execPath,
      ["--import", "tsx", "src/scripts/audit-agency-review.ts", "--project", PROJECT_ID],
      { cwd, env: process.env, encoding: "utf8" }
    );
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /Agency review audit for project/);
    assert.match(run.stdout, /does not match an admin review record: 11/);
    assert.match(run.stdout, /pointing at an agency or agent that does not exist: 3/);
    // Reading an emulator is announced, so the output cannot pass for a real audit.
    assert.match(run.stdout, /EMULATOR RUN/);
    assert.match(run.stdout, /says NOTHING about durin-seli-dev or japa-platform/);
    assert.deepEqual(await snapshotState(), stateBefore);
  });
});
