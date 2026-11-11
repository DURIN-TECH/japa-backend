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
  return { accounts: users, agencies };
}

before(async () => {
  await rulesEnv();
  await resetEmulators();
  const { auth, collections } = await import("../../src/utils/firebase");

  for (const name of ["admin", "client", "owner"]) {
    who[name] = await signUp(`review-${name}`);
    await collections.users.doc(who[name].uid).set({ id: who[name].uid, email: who[name].email });
  }
  await auth.setCustomUserClaims(who.admin.uid, { role: "admin", agencyId: null, admin: true });
  await auth.setCustomUserClaims(who.client.uid, { role: "client", agencyId: null, admin: false });
  await auth.setCustomUserClaims(who.owner.uid, { role: "owner", agencyId: "agency-clean", admin: false });

  const now = new Date();
  const reviewed = { reviewedBy: who.admin.uid, reviewedAt: now };
  const agency = (id: string, fields: Record<string, unknown>) =>
    collections.agencies.doc(id).set({ id, name: id, ownerId: who.owner.uid, ...fields });

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
  await agency("agency-pending", {
    status: "pending_review",
    compliance: { status: "in_progress", legalFirstName: "Olu" },
  });

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

  // ---- Run the audit once, between two snapshots.
  stateBefore = await snapshotState();
  report = await auditAgencyReview({ auth, agencies: collections.agencies });
  stateAfter = await snapshotState();
});

after(async () => {
  await (await rulesEnv()).cleanup();
});

/** Issue codes reported for one agency. */
const codes = (agencyId: string) =>
  (report.findings.find((f) => f.agencyId === agencyId)?.issues ?? []).map((i) => i.code);

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

  test("totals count every agency and only the decided ones", () => {
    assert.equal(report.totals.agencies, 11);
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
    assert.match(run.stdout, /does not match an admin review record: 9/);
    // Reading an emulator is announced, so the output cannot pass for a real audit.
    assert.match(run.stdout, /EMULATOR RUN/);
    assert.match(run.stdout, /says NOTHING about durin-seli-dev or japa-platform/);
    assert.deepEqual(await snapshotState(), stateBefore);
  });
});
