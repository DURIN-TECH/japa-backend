/**
 * READ-ONLY audit of role and agency-membership data (issue #135).
 *
 * Background: role and agency membership must come only from server-written
 * data. Before that was enforced, some of the fields the role lookup read
 * could also be written by the user they belonged to, and the lookup's answer
 * was then copied into the account's custom claims. This script lists every
 * record that a human should look at, in one project, so leftovers from that
 * period can be found and corrected by hand.
 *
 * IT WRITES NOTHING. It only lists Auth users and reads Firestore documents
 * (`users`, `agents`, `agencies`, `agencyInvitations`), then prints a report.
 * Fixing what it reports is a separate, deliberate step (see "What to do with
 * a finding" in the printed report).
 *
 * What it reports:
 *  1. Profile documents that say `admin: true` while the account holds no
 *     admin custom claim. (The field grants nothing any more, but a real
 *     legacy admin in this list would have lost admin access: re-grant with
 *     `npm run admin:grant`. Anyone else: clear the field.)
 *  2. EVERY account that holds the admin claim, for a human to compare with
 *     the list of people who should be admins. This matters because a claim
 *     that was derived from a self-written field looks exactly like a proper
 *     one. Pass `--expected-admins a@x,b@y` to have the unexpected ones marked.
 *  3. Agent documents whose `agencyId` / `agencyRole` are not backed by the
 *     server-side membership records: the agency is missing, the agency's own
 *     `ownerId` names somebody else, there is no accepted invitation for a
 *     member, the account's claims disagree, or the user has several agent
 *     documents.
 *  4. Accounts whose custom claims place them in an agency that the records
 *     do not confirm, and agencies whose owner has no owner agent document.
 *
 * Usage (run by a human, once per project):
 *   npm run build
 *   GOOGLE_APPLICATION_CREDENTIALS=<sa-key.json> \
 *     node lib/scripts/audit-role-trust.js --project durin-seli-dev
 *   GOOGLE_APPLICATION_CREDENTIALS=<sa-key.json> \
 *     node lib/scripts/audit-role-trust.js --project japa-platform \
 *       --expected-admins first@weareseli.com,second@weareseli.com
 *   # add --json to print the raw report object instead of text
 *
 * A service-account key is needed for the same reason as seed-all.ts: user
 * ADC cannot list Auth users. A read-only role is enough
 * (roles/firebaseauth.viewer + roles/datastore.viewer).
 *
 * Against the emulators (how it is tested, see
 * test/emulator/audit-role-trust.emu.ts): set FIRESTORE_EMULATOR_HOST and
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
 * audit can be run against any initialised Admin SDK, and so it is obvious
 * from the signature that it gets collections and Auth, nothing else.
 */
export interface AuditSources {
  auth: Pick<Auth, "listUsers">;
  collections: {
    users: CollectionReference;
    agents: CollectionReference;
    agencies: CollectionReference;
    agencyInvitations: CollectionReference;
  };
}

/** Options for one audit run. */
export interface AuditOptions {
  /** Emails (any case) of the people who SHOULD hold the admin role. */
  expectedAdminEmails?: string[];
}

/**
 * How serious a finding is:
 *  - "high": the records contradict each other; access may be wrong.
 *  - "review": nothing contradicts, but no independent record confirms it
 *    either (also true of members who were seeded or added directly).
 */
export type Severity = "high" | "review";

/** Why an agent document was reported. */
export type AgentIssueCode =
  | "AGENCY_MISSING" // agencyId names an agency that does not exist
  | "OWNER_NOT_CONFIRMED" // agencyRole owner, but agencies/{id}.ownerId is someone else
  | "ROLE_WITHOUT_AGENCY" // agencyRole set with no agencyId
  | "MEMBER_NO_INVITATION" // member with no accepted invitation on record
  | "CLAIMS_DISAGREE" // the account's role / agencyId claims differ from the document
  | "NO_AUTH_ACCOUNT" // userId has no Auth account
  | "DUPLICATE_AGENT_DOCS"; // the user has more than one agent document

/** Why an account's claims (or an agency) were reported. */
export type ClaimIssueCode =
  | "OWNER_CLAIM_NOT_CONFIRMED" // claims say owner of X; agencies/X.ownerId is someone else / missing
  | "AGENT_CLAIM_NO_AGENT_DOC" // claims say agent of X; no agent document places them in X
  | "AGENCY_OWNER_NO_AGENT_DOC"; // agencies/X.ownerId has no owner agent document for X

/** One reported issue on a record. */
export interface Issue<Code extends string> {
  code: Code;
  severity: Severity;
  detail: string;
}

/** A profile document flagged admin without the claim (section 1). */
export interface AdminFieldFinding {
  uid: string;
  email: string | null;
  hasAuthAccount: boolean;
  claimRole: string | null;
}

/** An account holding the admin claim (section 2). */
export interface AdminClaimHolder {
  uid: string;
  email: string | null;
  claimRole: string | null;
  legacyAdminClaim: boolean;
  profileAdminField: boolean;
  createdAt: string | null;
  lastSignInAt: string | null;
  /** null when no expected list was given; otherwise whether the email is on it. */
  expected: boolean | null;
}

/** An agent document with at least one issue (section 3). */
export interface AgentFinding {
  agentDocId: string;
  userId: string | null;
  email: string | null;
  agencyId: string | null;
  agencyRole: string | null;
  issues: Issue<AgentIssueCode>[];
}

/** An account or agency whose claims / ownership do not check out (section 4). */
export interface ClaimFinding {
  uid: string;
  email: string | null;
  claimRole: string | null;
  claimAgencyId: string | null;
  issues: Issue<ClaimIssueCode>[];
}

/** The whole report. Plain data: safe to JSON.stringify. */
export interface AuditReport {
  totals: { authUsers: number; agentDocs: number; agencies: number; acceptedInvitations: number };
  adminFieldWithoutClaim: AdminFieldFinding[];
  adminClaimHolders: AdminClaimHolder[];
  agentFindings: AgentFinding[];
  claimFindings: ClaimFinding[];
}

// ============================================
// Small helpers
// ============================================

/** True when a set of custom claims carries either admin signal. */
function claimsSayAdmin(claims: Record<string, unknown> | undefined): boolean {
  return claims?.role === ROLES.ADMIN || claims?.admin === true;
}

/** A string claim / field, or null when absent or not a string. */
function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Lower-cased email, or null. */
function lower(value: unknown): string | null {
  const s = str(value);
  return s ? s.toLowerCase() : null;
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

/**
 * Read the role / membership records of one project and report every
 * inconsistency. Performs ONLY `listUsers()` and collection `get()` calls.
 */
export async function auditRoleTrust(sources: AuditSources, options: AuditOptions = {}): Promise<AuditReport> {
  const { auth, collections } = sources;

  // ---- Load everything once (these collections are small).
  const [authUsers, adminFlagSnap, agentSnap, agencySnap, acceptedInviteSnap] = await Promise.all([
    listAllUsers(auth),
    collections.users.where("admin", "==", true).get(),
    collections.agents.get(),
    collections.agencies.get(),
    collections.agencyInvitations.where("status", "==", "accepted").get(),
  ]);

  /** Auth account by uid. */
  const accountByUid = new Map(authUsers.map((u) => [u.uid, u]));
  /** agencyId -> ownerId, straight from the agency documents. */
  const ownerByAgency = new Map<string, string | null>(
    agencySnap.docs.map((d) => [d.id, str(d.data().ownerId)])
  );
  /** "agencyId|email" and "agencyId|agentDocId" keys of accepted invitations. */
  const acceptedInvites = new Set<string>();
  for (const d of acceptedInviteSnap.docs) {
    const inv = d.data();
    const agencyId = str(inv.agencyId);
    if (!agencyId) continue;
    const email = lower(inv.invitedEmail);
    if (email) acceptedInvites.add(`${agencyId}|${email}`);
    const agentId = str(inv.invitedAgentId);
    if (agentId) acceptedInvites.add(`${agencyId}|${agentId}`);
  }

  // ---- Section 1: profile says admin, the account's claims do not.
  const adminFieldWithoutClaim: AdminFieldFinding[] = [];
  /** uids whose profile document carries admin: true (used by section 2). */
  const profileAdminUids = new Set<string>();
  for (const d of adminFlagSnap.docs) {
    profileAdminUids.add(d.id);
    const account = accountByUid.get(d.id);
    if (account && claimsSayAdmin(account.customClaims)) continue;
    adminFieldWithoutClaim.push({
      uid: d.id,
      email: account?.email ?? str(d.data().email),
      hasAuthAccount: Boolean(account),
      claimRole: str(account?.customClaims?.role),
    });
  }

  // ---- Section 2: every admin-claim holder, for comparison with the
  //      expected list.
  const expected = options.expectedAdminEmails?.length
    ? new Set(options.expectedAdminEmails.map((e) => e.trim().toLowerCase()).filter(Boolean))
    : null;
  const adminClaimHolders: AdminClaimHolder[] = authUsers
    .filter((u) => claimsSayAdmin(u.customClaims))
    .map((u) => ({
      uid: u.uid,
      email: u.email ?? null,
      claimRole: str(u.customClaims?.role),
      legacyAdminClaim: u.customClaims?.admin === true,
      profileAdminField: profileAdminUids.has(u.uid),
      createdAt: u.metadata.creationTime ?? null,
      lastSignInAt: u.metadata.lastSignInTime ?? null,
      expected: expected ? Boolean(u.email && expected.has(u.email.toLowerCase())) : null,
    }));

  // ---- Section 3: agent documents vs the membership records.
  /** How many agent documents each user has. */
  const agentDocCount = new Map<string, number>();
  for (const d of agentSnap.docs) {
    const userId = str(d.data().userId);
    if (userId) agentDocCount.set(userId, (agentDocCount.get(userId) ?? 0) + 1);
  }
  /** "uid|agencyId" for every agent document that places a user in an agency. */
  const agentDocMemberships = new Set<string>();
  /** "uid|agencyId" for agent documents with the owner role. */
  const ownerAgentDocs = new Set<string>();

  const agentFindings: AgentFinding[] = [];
  for (const d of agentSnap.docs) {
    const agent = d.data();
    const userId = str(agent.userId);
    const agencyId = str(agent.agencyId);
    const agencyRole = str(agent.agencyRole);
    const account = userId ? accountByUid.get(userId) : undefined;
    const issues: Issue<AgentIssueCode>[] = [];

    if (userId && agencyId) {
      agentDocMemberships.add(`${userId}|${agencyId}`);
      if (agencyRole === ROLES.OWNER) ownerAgentDocs.add(`${userId}|${agencyId}`);
    }

    if (userId && (agentDocCount.get(userId) ?? 0) > 1) {
      issues.push({
        code: "DUPLICATE_AGENT_DOCS",
        severity: "high",
        detail: `user has ${agentDocCount.get(userId)} agent documents (the flows create exactly one)`,
      });
    }

    // Only documents that claim an agency or an agency role need the
    // membership checks; a plain independent profile claims nothing.
    if (agencyId || agencyRole) {
      if (!account) {
        issues.push({
          code: "NO_AUTH_ACCOUNT",
          severity: "review",
          detail: "userId has no Auth account (deleted user, or a wrong userId)",
        });
      }

      if (!agencyId) {
        issues.push({
          code: "ROLE_WITHOUT_AGENCY",
          severity: "high",
          detail: `agencyRole "${agencyRole}" with no agencyId`,
        });
      } else if (!ownerByAgency.has(agencyId)) {
        issues.push({
          code: "AGENCY_MISSING",
          severity: "high",
          detail: `agencies/${agencyId} does not exist`,
        });
      } else if (agencyRole === ROLES.OWNER) {
        const recordedOwner = ownerByAgency.get(agencyId) ?? null;
        if (recordedOwner !== userId) {
          issues.push({
            code: "OWNER_NOT_CONFIRMED",
            severity: "high",
            detail: `agencies/${agencyId}.ownerId is ${recordedOwner ?? "(unset)"}, not this user`,
          });
        }
      } else {
        // A member: the invitation flows leave an accepted invitation behind.
        const email = account?.email?.toLowerCase();
        const invited =
          (email !== undefined && acceptedInvites.has(`${agencyId}|${email}`)) ||
          acceptedInvites.has(`${agencyId}|${d.id}`);
        if (!invited) {
          issues.push({
            code: "MEMBER_NO_INVITATION",
            severity: "review",
            detail:
              "no accepted invitation for this agency and account email (expected for members who " +
              "were seeded, added directly by an owner/admin, or changed email since)",
          });
        }
      }

      // The account's claims should say the same thing as the document.
      if (account) {
        const claimRole = str(account.customClaims?.role);
        const claimAgency = str(account.customClaims?.agencyId);
        const docRole = agencyRole === ROLES.OWNER ? ROLES.OWNER : ROLES.AGENT;
        // Admins keep their agent document; their claims say admin, not agent.
        const isAdmin = claimsSayAdmin(account.customClaims);
        if (!isAdmin && claimRole && (claimRole !== docRole || claimAgency !== agencyId)) {
          issues.push({
            code: "CLAIMS_DISAGREE",
            severity: "high",
            detail:
              `claims say role=${claimRole} agencyId=${claimAgency ?? "-"}; ` +
              `document says role=${docRole} agencyId=${agencyId ?? "-"}`,
          });
        }
      }
    }

    if (issues.length > 0) {
      agentFindings.push({
        agentDocId: d.id,
        userId,
        email: account?.email ?? null,
        agencyId,
        agencyRole,
        issues,
      });
    }
  }

  // ---- Section 4: claims (and agency ownership) the records do not confirm.
  const claimFindings: ClaimFinding[] = [];
  for (const u of authUsers) {
    const claimRole = str(u.customClaims?.role);
    const claimAgency = str(u.customClaims?.agencyId);
    const issues: Issue<ClaimIssueCode>[] = [];

    if (claimRole === ROLES.OWNER) {
      const recordedOwner = claimAgency ? ownerByAgency.get(claimAgency) : undefined;
      if (!claimAgency || recordedOwner !== u.uid) {
        issues.push({
          code: "OWNER_CLAIM_NOT_CONFIRMED",
          severity: "high",
          detail: claimAgency
            ? `claims say owner of ${claimAgency}; that agency's ownerId is ${recordedOwner ?? "(missing agency)"}`
            : "claims say owner with no agencyId",
        });
      }
    } else if (claimRole === ROLES.AGENT && claimAgency) {
      if (!agentDocMemberships.has(`${u.uid}|${claimAgency}`)) {
        issues.push({
          code: "AGENT_CLAIM_NO_AGENT_DOC",
          severity: "high",
          detail: `claims say agent of ${claimAgency}; no agent document places this user there`,
        });
      }
    }

    if (issues.length > 0) {
      claimFindings.push({
        uid: u.uid,
        email: u.email ?? null,
        claimRole,
        claimAgencyId: claimAgency,
        issues,
      });
    }
  }
  // Agencies whose recorded owner has no owner agent document for them:
  // every server flow that creates an agency writes both in one step.
  for (const [agencyId, ownerId] of ownerByAgency) {
    if (ownerId && ownerAgentDocs.has(`${ownerId}|${agencyId}`)) continue;
    const account = ownerId ? accountByUid.get(ownerId) : undefined;
    claimFindings.push({
      uid: ownerId ?? "(unset)",
      email: account?.email ?? null,
      claimRole: str(account?.customClaims?.role),
      claimAgencyId: str(account?.customClaims?.agencyId),
      issues: [
        {
          code: "AGENCY_OWNER_NO_AGENT_DOC",
          severity: "review",
          detail: `agencies/${agencyId}.ownerId has no agent document with agencyRole owner for it`,
        },
      ],
    });
  }

  return {
    totals: {
      authUsers: authUsers.length,
      agentDocs: agentSnap.size,
      agencies: agencySnap.size,
      acceptedInvitations: acceptedInviteSnap.size,
    },
    adminFieldWithoutClaim,
    adminClaimHolders,
    agentFindings,
    claimFindings,
  };
}

// ============================================
// Text report
// ============================================

/** Render the report as plain text for a terminal. */
export function formatAuditReport(report: AuditReport, projectId: string): string {
  const lines: string[] = [];
  const add = (s = "") => lines.push(s);

  add(`Role / membership audit for project: ${projectId}   (READ-ONLY: nothing was changed)`);
  add(
    `Scanned ${report.totals.authUsers} accounts, ${report.totals.agentDocs} agent documents, ` +
      `${report.totals.agencies} agencies, ${report.totals.acceptedInvitations} accepted invitations.`
  );

  add();
  add(`1. Profile says admin, account has NO admin claim: ${report.adminFieldWithoutClaim.length}`);
  for (const f of report.adminFieldWithoutClaim) {
    add(
      `   - ${f.uid}  ${f.email ?? "(no email)"}  claim role=${f.claimRole ?? "(none)"}` +
        (f.hasAuthAccount ? "" : "  [no Auth account]")
    );
  }

  add();
  add(`2. Accounts holding the admin claim: ${report.adminClaimHolders.length}  (check EVERY line against who should be an admin)`);
  for (const h of report.adminClaimHolders) {
    const mark = h.expected === null ? "" : h.expected ? "  [expected]" : "  [NOT ON THE EXPECTED LIST]";
    add(
      `   - ${h.uid}  ${h.email ?? "(no email)"}  role=${h.claimRole ?? "(legacy admin flag only)"}` +
        `  created=${h.createdAt ?? "?"}  lastSignIn=${h.lastSignInAt ?? "never"}` +
        `  profileAdminField=${h.profileAdminField}${mark}`
    );
  }

  add();
  add(`3. Agent documents not backed by the membership records: ${report.agentFindings.length}`);
  for (const f of report.agentFindings) {
    add(
      `   - agents/${f.agentDocId}  user=${f.userId ?? "(none)"} ${f.email ?? ""}  ` +
        `agencyId=${f.agencyId ?? "-"} agencyRole=${f.agencyRole ?? "-"}`
    );
    for (const i of f.issues) add(`       [${i.severity}] ${i.code}: ${i.detail}`);
  }

  add();
  add(`4. Claims / agency ownership the records do not confirm: ${report.claimFindings.length}`);
  for (const f of report.claimFindings) {
    add(
      `   - ${f.uid}  ${f.email ?? "(no email)"}  claims role=${f.claimRole ?? "(none)"} ` +
        `agencyId=${f.claimAgencyId ?? "-"}`
    );
    for (const i of f.issues) add(`       [${i.severity}] ${i.code}: ${i.detail}`);
  }

  add();
  add("What to do with a finding (by hand, after confirming with the people involved):");
  add("  - A real admin in section 1: `npm run admin:grant -- --project <id> <email>`. Anyone else: clear users/{uid}.admin.");
  add("  - An unexpected admin in section 2: `npm run admin:revoke -- --project <id> <email>`, then review what the account did.");
  add("  - [high] items in 3 and 4: correct the agent document / claims to match the agency's real membership");
  add("    (PUT /users/:uid/role as an admin rewrites the claims), then have the user sign in again.");
  add("  - [review] items: confirm with the agency owner that the person is a member.");
  return lines.join("\n");
}

// ============================================
// CLI
// ============================================

/** Parse --project <id> | --project=<id> | -p <id>, --expected-admins a,b, --json. */
function parseArgs(argv: string[]): { project?: string; expectedAdmins: string[]; json: boolean } {
  let project: string | undefined;
  let expectedAdmins: string[] = [];
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--project" || a === "-p") project = argv[++i];
    else if (a.startsWith("--project=")) project = a.slice("--project=".length);
    else if (a === "--expected-admins") expectedAdmins = (argv[++i] ?? "").split(",");
    else if (a.startsWith("--expected-admins=")) expectedAdmins = a.slice("--expected-admins=".length).split(",");
    else if (a === "--json") json = true;
  }
  return { project, expectedAdmins: expectedAdmins.map((e) => e.trim()).filter(Boolean), json };
}

/** Entry point when run as `node lib/scripts/audit-role-trust.js`. */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const onEmulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

  // Same project resolution as seed-all.ts / grant-admin.ts: no silent default
  // to a real project.
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

  // Point the shared Admin SDK at this project BEFORE importing utils/firebase
  // (which initialises the app on import). Mirrors grant-admin.ts.
  process.env.GCLOUD_PROJECT = projectId;
  process.env.GOOGLE_CLOUD_PROJECT = projectId;
  if (!onEmulator && !process.env.FIREBASE_STORAGE_BUCKET) {
    process.env.FIREBASE_STORAGE_BUCKET = `${projectId}.firebasestorage.app`;
  }

  const { auth, collections } = await import("../utils/firebase");
  const report = await auditRoleTrust({ auth, collections }, { expectedAdminEmails: args.expectedAdmins });
  console.log(args.json ? JSON.stringify(report, null, 2) : `\n${formatAuditReport(report, projectId)}\n`);
  process.exit(0);
}

// Only when executed directly: importing this module (tests) runs nothing.
if (require.main === module) {
  main().catch((error) => {
    console.error("\naudit-role-trust failed:", error);
    process.exit(1);
  });
}
