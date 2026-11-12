/**
 * READ-ONLY audit of agency status / compliance against the admin review
 * record (issue #138).
 *
 * Background: `agencies` used to be client-writable, including `status`,
 * `compliance`, `reviewedBy` and `reviewedAt`. A record could therefore say
 * `status: "approved"` (or `compliance.status: "verified"`) without an admin
 * ever making that decision — or could carry review metadata that no admin
 * wrote. The rules and the API now write those fields only from the server
 * (see firestore.rules and functions/src/services/agency.service.ts). This
 * script lists the records that ALREADY disagree with their review metadata,
 * in one project, so a human can review them by hand.
 *
 * IT WRITES NOTHING. It only lists Auth users (to check who the reviewer was)
 * and reads the `agencies` collection, then prints a report. Fixing what it
 * reports is a separate, deliberate step (see "What to do with a finding" in
 * the printed report).
 *
 * It also lists two kinds of dangling authority:
 *  - agencies whose OWNER is not backed by server-written records: no agent
 *    document of the owner names the agency with `agencyRole: "owner"`, or
 *    the owner's account does not hold the owner role claim for it (the role
 *    lookup would not make them an owner);
 *  - applications whose `agencyId` names an agency that does not exist, or
 *    whose `agentId` names no agent (`agentId` is the agent's USER uid; an
 *    agent document id is also accepted, because older clients sent that).
 *
 * What counts as "an admin review record":
 *  - platform admission (`status`): `approved`, `rejected` and `suspended`
 *    are decisions, so the document must carry `reviewedBy` and `reviewedAt`.
 *    `pending_review` must carry neither (nothing has been decided yet).
 *  - the compliance file (`compliance.status`): `verified` and `rejected`
 *    are decisions, so the file must carry `compliance.reviewedBy` and
 *    `compliance.reviewedAt`. `under_review` means it was submitted, so the
 *    file must carry `compliance.submittedAt`.
 *  - the reviewer (`reviewedBy` on either) must name an account that holds
 *    the admin role claim. A reviewer that is missing from Auth is reported
 *    too: the record cannot be attributed to anybody.
 *
 * Usage (run by a human, once per project; `npm run audit:agencies` builds
 * first):
 *   GOOGLE_APPLICATION_CREDENTIALS=<sa-key.json> \
 *     npm run audit:agencies -- --project durin-seli-dev
 *   GOOGLE_APPLICATION_CREDENTIALS=<sa-key.json> \
 *     npm run audit:agencies -- --project japa-platform
 *   # add --json to print the raw report object instead of text
 *
 * A read-only role is enough: Auth viewer (to list accounts and their claims)
 * + datastore viewer.
 *
 * Emulator safety (same rule as audit-role-trust.ts and
 * audit-storage-paths.ts): when an emulator variable is set, the Admin SDK
 * reads the EMULATOR whatever --project says. The script therefore refuses a
 * non-demo project id in that case (an empty emulator would otherwise look
 * like an all-clear for the real project) and prints a banner whenever it is
 * reading an emulator. Both emulator variables are required, because the
 * audit reads both Firestore and Auth.
 *
 * Against the emulators (how it is tested, see
 * test/emulator/audit-agency-review.emu.ts): set FIRESTORE_EMULATOR_HOST and
 * FIREBASE_AUTH_EMULATOR_HOST and pass a demo- project id.
 */

import type { Auth, UserRecord } from "firebase-admin/auth";
import type { CollectionReference } from "firebase-admin/firestore";
import { ROLES } from "@durin-tech/authz";

// ============================================
// Types
// ============================================

/**
 * The read access the audit needs. Passed in (rather than imported) so the
 * audit can run against any initialised Admin SDK, and so it is obvious from
 * the signature that it gets Auth and three collections, nothing else.
 */
export interface AgencyReviewSources {
  auth: Pick<Auth, "listUsers">;
  agencies: CollectionReference;
  /** Agent documents (to confirm each agency's owner). */
  agents: CollectionReference;
  /** Applications (to find ones that point at a missing agency / agent). */
  applications: CollectionReference;
}

/** Why an agency was reported. */
export type AgencyReviewIssueCode =
  | "STATUS_DECISION_WITHOUT_REVIEW" // approved/rejected/suspended, but no reviewedBy/reviewedAt
  | "STATUS_PENDING_WITH_REVIEW" // pending_review, but review metadata is present
  | "STATUS_REVIEWER_NOT_ADMIN" // reviewedBy does not name an admin-claim holder
  | "COMPLIANCE_DECISION_WITHOUT_REVIEW" // verified/rejected, but no compliance.reviewedBy/reviewedAt
  | "COMPLIANCE_UNDER_REVIEW_WITHOUT_SUBMISSION" // under_review, but no compliance.submittedAt
  | "COMPLIANCE_REVIEWER_NOT_ADMIN" // compliance.reviewedBy does not name an admin-claim holder
  | "OWNER_NO_AGENT_DOC" // no agent document of ownerId names this agency with agencyRole owner
  | "OWNER_NO_OWNER_CLAIM"; // ownerId has no Auth account, or it lacks the owner claim for this agency

/** Why an application was reported. */
export type ApplicationIssueCode =
  | "APPLICATION_AGENCY_MISSING" // agencyId names an agency that does not exist
  | "APPLICATION_AGENT_MISSING"; // agentId names no agent (by user uid or agent document id)

/** An application that points at an agency or agent that does not exist. */
export interface ApplicationFinding {
  applicationId: string;
  agencyId: string | null;
  agentId: string | null;
  issues: Issue<ApplicationIssueCode>[];
}

/** How serious a finding is. */
export type Severity = "high" | "review";

/** One reported issue on an agency. */
export interface Issue<Code extends string> {
  code: Code;
  severity: Severity;
  detail: string;
}

/** An agency whose status / compliance does not match an admin review record. */
export interface AgencyReviewFinding {
  agencyId: string;
  name: string | null;
  status: string | null;
  complianceStatus: string | null;
  issues: Issue<AgencyReviewIssueCode>[];
}

/** The whole report. Plain data: safe to JSON.stringify. */
export interface AgencyReviewReport {
  totals: {
    authUsers: number;
    agencies: number;
    /** Agencies whose `status` is a decision (approved / rejected / suspended). */
    statusDecided: number;
    /** Agencies whose compliance file is a decision (verified / rejected). */
    complianceDecided: number;
    applications: number;
  };
  findings: AgencyReviewFinding[];
  /** Applications pointing at an agency or agent that does not exist. */
  applicationFindings: ApplicationFinding[];
}

// ============================================
// Small helpers
// ============================================

/** A string field, or null when absent / not a string. */
function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** A nested object field as a plain record (empty when absent). */
function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** True when the account holds the admin role (claim or legacy flag). */
function holdsAdminClaim(claims: Record<string, unknown> | undefined): boolean {
  return claims?.role === ROLES.ADMIN || claims?.admin === true;
}

/** A missing review fact, phrased for the report. */
function missing(...names: string[]): string {
  return names.length === 1 ? `${names[0]} is missing` : `${names.join(" and ")} are missing`;
}

/** Every Auth user, following pagination. Read-only. */
async function listAllUsers(auth: Pick<Auth, "listUsers">): Promise<UserRecord[]> {
  const out: UserRecord[] = [];
  let pageToken: string | undefined;
  do {
    const page = await auth.listUsers(1000, pageToken);
    out.push(...page.users);
    pageToken = page.pageToken;
  } while (pageToken);
  return out;
}

// ============================================
// The audit (pure reads)
// ============================================

/** Platform statuses that are an admin's decision. */
const DECIDED_STATUSES = new Set(["approved", "rejected", "suspended"]);
/** Compliance statuses that are an admin's decision. */
const DECIDED_COMPLIANCE_STATUSES = new Set(["verified", "rejected"]);

/**
 * Read the agencies of one project and report every record whose status or
 * compliance does not match an admin review record. Performs ONLY
 * `listUsers()` and one collection `get()`.
 */
export async function auditAgencyReview(sources: AgencyReviewSources): Promise<AgencyReviewReport> {
  const { auth, agencies, agents, applications } = sources;

  const [authUsers, agencySnap, agentSnap, applicationSnap] = await Promise.all([
    listAllUsers(auth),
    agencies.get(),
    agents.get(),
    applications.get(),
  ]);

  /** "agencyId|userId" of every agent document that says owner of that agency. */
  const ownerAgentDocs = new Set<string>();
  /** Agent user uids and agent document ids (an application's agentId may be either). */
  const agentIdentifiers = new Set<string>();
  for (const d of agentSnap.docs) {
    const a = d.data();
    agentIdentifiers.add(d.id);
    const userId = str(a.userId);
    if (userId) agentIdentifiers.add(userId);
    const agencyId = str(a.agencyId);
    if (userId && agencyId && a.agencyRole === ROLES.OWNER) ownerAgentDocs.add(`${agencyId}|${userId}`);
  }
  const agencyIds = new Set(agencySnap.docs.map((d) => d.id));

  /** Auth account by uid, for the reviewer check. */
  const accountByUid = new Map(authUsers.map((u) => [u.uid, u]));

  const findings: AgencyReviewFinding[] = [];
  let statusDecided = 0;
  let complianceDecided = 0;

  for (const doc of agencySnap.docs) {
    const agency = doc.data();
    const status = str(agency.status);
    const compliance = obj(agency.compliance);
    const complianceStatus = str(compliance.status);
    const issues: Issue<AgencyReviewIssueCode>[] = [];

    // ---- Platform admission: status vs reviewedBy / reviewedAt.
    const reviewedBy = str(agency.reviewedBy);
    const reviewedAt = agency.reviewedAt ?? null;

    if (status && DECIDED_STATUSES.has(status)) {
      statusDecided++;
      const absent = [reviewedBy ? null : "reviewedBy", reviewedAt ? null : "reviewedAt"].filter(
        (x): x is string => Boolean(x)
      );
      if (absent.length > 0) {
        issues.push({
          code: "STATUS_DECISION_WITHOUT_REVIEW",
          severity: "high",
          detail: `status is "${status}" but ${missing(...absent)}: no admin decision is recorded`,
        });
      }
    } else if (status === "pending_review" && (reviewedBy || reviewedAt)) {
      issues.push({
        code: "STATUS_PENDING_WITH_REVIEW",
        severity: "review",
        detail:
          "status is pending_review but a review decision is recorded " +
          `(reviewedBy=${reviewedBy ?? "-"}, reviewedAt=${reviewedAt ? "set" : "-"}); ` +
          "the agency may have been re-opened without clearing the metadata",
      });
    }

    if (reviewedBy) {
      const reviewer = accountByUid.get(reviewedBy);
      if (!reviewer) {
        issues.push({
          code: "STATUS_REVIEWER_NOT_ADMIN",
          severity: "high",
          detail: `reviewedBy=${reviewedBy} has no Auth account`,
        });
      } else if (!holdsAdminClaim(reviewer.customClaims)) {
        issues.push({
          code: "STATUS_REVIEWER_NOT_ADMIN",
          severity: "high",
          detail: `reviewedBy=${reviewedBy} (${reviewer.email ?? "no email"}) holds no admin claim`,
        });
      }
    }

    // ---- The compliance file: status vs its own review metadata.
    const complianceReviewedBy = str(compliance.reviewedBy);
    const complianceReviewedAt = compliance.reviewedAt ?? null;

    if (complianceStatus && DECIDED_COMPLIANCE_STATUSES.has(complianceStatus)) {
      complianceDecided++;
      const absent = [
        complianceReviewedBy ? null : "compliance.reviewedBy",
        complianceReviewedAt ? null : "compliance.reviewedAt",
      ].filter((x): x is string => Boolean(x));
      if (absent.length > 0) {
        issues.push({
          code: "COMPLIANCE_DECISION_WITHOUT_REVIEW",
          severity: "high",
          detail: `compliance.status is "${complianceStatus}" but ${missing(...absent)}: no admin decision is recorded`,
        });
      }
    }
    if (complianceStatus === "under_review" && !compliance.submittedAt) {
      issues.push({
        code: "COMPLIANCE_UNDER_REVIEW_WITHOUT_SUBMISSION",
        severity: "review",
        detail: "compliance.status is under_review but compliance.submittedAt is missing",
      });
    }

    if (complianceReviewedBy) {
      const reviewer = accountByUid.get(complianceReviewedBy);
      if (!reviewer) {
        issues.push({
          code: "COMPLIANCE_REVIEWER_NOT_ADMIN",
          severity: "high",
          detail: `compliance.reviewedBy=${complianceReviewedBy} has no Auth account`,
        });
      } else if (!holdsAdminClaim(reviewer.customClaims)) {
        issues.push({
          code: "COMPLIANCE_REVIEWER_NOT_ADMIN",
          severity: "high",
          detail:
            `compliance.reviewedBy=${complianceReviewedBy} (${reviewer.email ?? "no email"}) ` +
            "holds no admin claim",
        });
      }
    }

    // ---- The owner: backed by an owner agent document and an owner claim.
    const ownerId = str(agency.ownerId);
    if (!ownerId || !ownerAgentDocs.has(`${doc.id}|${ownerId}`)) {
      issues.push({
        code: "OWNER_NO_AGENT_DOC",
        severity: "high",
        detail:
          `ownerId is ${ownerId ?? "(unset)"}, but no agent document of that user names ` +
          "this agency with agencyRole owner (the role lookup would not make them its owner)",
      });
    }
    const ownerAccount = ownerId ? accountByUid.get(ownerId) : undefined;
    const ownerClaims = ownerAccount?.customClaims;
    if (!ownerAccount) {
      issues.push({
        code: "OWNER_NO_OWNER_CLAIM",
        severity: "high",
        detail: `ownerId ${ownerId ?? "(unset)"} has no Auth account`,
      });
    } else if (ownerClaims?.role !== ROLES.OWNER || ownerClaims?.agencyId !== doc.id) {
      issues.push({
        code: "OWNER_NO_OWNER_CLAIM",
        severity: "review",
        detail:
          `the owner's claims are role=${String(ownerClaims?.role ?? "-")}, ` +
          `agencyId=${String(ownerClaims?.agencyId ?? "-")}, not owner of ${doc.id} ` +
          "(their next request without a role claim, or src/scripts/backfill-claims.ts, rewrites it)",
      });
    }

    if (issues.length > 0) {
      findings.push({
        agencyId: doc.id,
        name: str(agency.name),
        status,
        complianceStatus,
        issues,
      });
    }
  }

  // ---- Applications that point at an agency or agent that does not exist.
  const applicationFindings: ApplicationFinding[] = [];
  for (const doc of applicationSnap.docs) {
    const app = doc.data();
    const agencyId = str(app.agencyId);
    const agentId = str(app.agentId);
    const issues: Issue<ApplicationIssueCode>[] = [];
    if (agencyId && !agencyIds.has(agencyId)) {
      issues.push({
        code: "APPLICATION_AGENCY_MISSING",
        severity: "high",
        detail: `agencyId ${agencyId} names no agency`,
      });
    }
    if (agentId && !agentIdentifiers.has(agentId)) {
      issues.push({
        code: "APPLICATION_AGENT_MISSING",
        severity: "high",
        detail: `agentId ${agentId} names no agent`,
      });
    }
    if (issues.length > 0) applicationFindings.push({ applicationId: doc.id, agencyId, agentId, issues });
  }

  return {
    totals: {
      authUsers: authUsers.length,
      agencies: agencySnap.size,
      statusDecided,
      complianceDecided,
      applications: applicationSnap.size,
    },
    findings,
    applicationFindings,
  };
}

// ============================================
// Text report
// ============================================

/** Render the report as plain text for a terminal. */
export function formatAgencyReviewReport(report: AgencyReviewReport, projectId: string): string {
  const lines: string[] = [];
  const add = (s = "") => lines.push(s);

  add(`Agency review audit for project: ${projectId}   (READ-ONLY: nothing was changed)`);
  add(
    `Scanned ${report.totals.agencies} agencies and ${report.totals.authUsers} accounts. ` +
      `${report.totals.statusDecided} have an admission decision recorded; ` +
      `${report.totals.complianceDecided} have a compliance decision recorded.`
  );

  add();
  add(`Agencies whose status / compliance does not match an admin review record: ${report.findings.length}`);
  for (const f of report.findings) {
    add(
      `   - agencies/${f.agencyId}  ${f.name ?? "(no name)"}  ` +
        `status=${f.status ?? "-"} compliance=${f.complianceStatus ?? "-"}`
    );
    for (const i of f.issues) add(`       [${i.severity}] ${i.code}: ${i.detail}`);
  }

  add();
  add(`Applications pointing at an agency or agent that does not exist: ${report.applicationFindings.length}`);
  for (const f of report.applicationFindings) {
    add(`   - applications/${f.applicationId}  agencyId=${f.agencyId ?? "-"} agentId=${f.agentId ?? "-"}`);
    for (const i of f.issues) add(`       [${i.severity}] ${i.code}: ${i.detail}`);
  }

  add();
  add("What to do with a finding (by hand, after confirming with the people involved):");
  add("  - [high] a decision without a review record: ask the admin team whether that decision was made.");
  add("    If it was not, set the agency back to pending_review (or the compliance file to in_progress)");
  add("    and clear reviewedBy / reviewedAt, through the admin review flow where possible.");
  add("  - [high] the reviewer is not an admin: treat the decision as unauthorised and re-review it.");
  add("  - owner without an agent document or owner claim [high]: the agency has no working owner; confirm who");
  add("    owns it and correct the agent document through the admin flow (do not edit ownerId blindly).");
  add("  - application pointing at a missing agency / agent: the case is invisible to its agent side; reassign");
  add("    it (PUT /applications/:id as an admin) or restore the missing record.");
  add("  - [review] pending_review with review metadata, or under_review without a submission: confirm");
  add("    the record's history and correct the metadata; neither grants access on its own.");
  return lines.join("\n");
}

// ============================================
// CLI
// ============================================

/** Parse --project <id> | --project=<id> | -p <id>, --json. */
function parseArgs(argv: string[]): { project?: string; json: boolean } {
  let project: string | undefined;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--project" || a === "-p") project = argv[++i];
    else if (a.startsWith("--project=")) project = a.slice("--project=".length);
    else if (a === "--json") json = true;
  }
  return { project, json };
}

/** Entry point when run as `node lib/scripts/audit-agency-review.js`. */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  // EITHER variable redirects part of the Admin SDK to an emulator.
  const emulatorHosts = [
    ["FIRESTORE_EMULATOR_HOST", process.env.FIRESTORE_EMULATOR_HOST],
    ["FIREBASE_AUTH_EMULATOR_HOST", process.env.FIREBASE_AUTH_EMULATOR_HOST],
  ].filter(([, value]) => Boolean(value));
  const onEmulator = emulatorHosts.length > 0;

  // Same project resolution as the other audits: no silent default to a real
  // project.
  const projectId =
    args.project ||
    process.env.SEED_PROJECT ||
    process.env.GCLOUD_PROJECT ||
    process.env.GOOGLE_CLOUD_PROJECT ||
    (onEmulator ? "demo-seli" : undefined);
  if (!projectId) {
    console.error("\nNo target project. Pass --project <id> (or run against the emulators).\n");
    process.exit(1);
  }

  // Emulator safety. With an emulator variable set, the SDK reads the emulator
  // no matter which project is named, so "nothing found" would say nothing
  // about the real project. Refuse a real project id outright, and require
  // BOTH emulators (one alone would mix emulator data with a real service).
  if (onEmulator) {
    const names = emulatorHosts.map(([name, value]) => `${name}=${value}`).join(", ");
    if (!projectId.startsWith("demo-")) {
      console.error(
        `\nRefusing to audit project "${projectId}": ${names} is set, so this run would read the ` +
          "EMULATOR, not that project, and its result would look like an all-clear.\n" +
          "Unset the emulator variable(s) to audit the real project, or pass a demo- project id " +
          "to audit the emulator.\n"
      );
      process.exit(1);
    }
    if (emulatorHosts.length < 2) {
      console.error(
        `\nRefusing to run: only ${names} is set. Set both FIRESTORE_EMULATOR_HOST and ` +
          "FIREBASE_AUTH_EMULATOR_HOST (emulator audit) or neither (real project).\n"
      );
      process.exit(1);
    }
    console.log(
      "\n************************************************************\n" +
        `* EMULATOR RUN (${names})\n` +
        `* Project "${projectId}" is a local emulator project.\n` +
        "* This says NOTHING about durin-seli-dev or japa-platform.\n" +
        "************************************************************"
    );
  }

  // Point the shared Admin SDK at this project BEFORE importing utils/firebase
  // (which initialises the app on import). Mirrors audit-role-trust.ts.
  process.env.GCLOUD_PROJECT = projectId;
  process.env.GOOGLE_CLOUD_PROJECT = projectId;
  if (!onEmulator && !process.env.FIREBASE_STORAGE_BUCKET) {
    process.env.FIREBASE_STORAGE_BUCKET = `${projectId}.firebasestorage.app`;
  }

  const { auth, collections } = await import("../utils/firebase");
  const report = await auditAgencyReview({
    auth,
    agencies: collections.agencies,
    agents: collections.agents,
    applications: collections.applications,
  });
  console.log(args.json ? JSON.stringify(report, null, 2) : `\n${formatAgencyReviewReport(report, projectId)}\n`);
  process.exit(0);
}

// Only when executed directly: importing this module (tests) runs nothing.
if (require.main === module) {
  main().catch((error) => {
    console.error("\naudit-agency-review failed:", error);
    process.exit(1);
  });
}
