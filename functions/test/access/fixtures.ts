// ============================================
// Test fixtures — application access allow/deny matrix (issue #29)
// ============================================
//
// Not a test file itself (`npm test` runs test/**/*.test.ts only). Shared by
//  - application-access.test.ts   (the boolean check, called directly), and
//  - application-handlers.test.ts (the same rule seen through the REST
//    handlers of ApplicationController),
// so both suites assert ONE table and cannot drift apart.
//
// The table is a CHARACTERIZATION of the rule `@durin-tech/authz` encodes
// (seli-authz/src/ability.ts, `defineAbilitiesFor`) as the REST handlers
// enforced it before the extraction in #29. It was written and run green
// against the old private `ApplicationController.checkApplicationAccess`
// first, then kept unchanged across the move to `src/utils/access.ts`. If a
// row here has to change, the access rule changed: that is NOT a refactor.
//
// ONE deliberate rule change since then, DURIN-TECH/japa#131 (fixed in
// `@durin-tech/authz` 0.1.7, vendored under functions/vendor/authz): a
// principal with no agency no longer matches an application through the
// agency grant. Three cells flipped from allowed to "---" and nothing else
// moved; see the note above `agentIndep` in MATRIX.
//
// Two agencies, A and B, so every row can be read as a tenant-isolation check.

import { ROLES } from "@durin-tech/authz";
import type { AuthzSubject, Entitlements } from "@durin-tech/authz";
import { Timestamp } from "firebase-admin/firestore";
import type { Application } from "../../src/types";

// ============================================
// Ids
// ============================================

/** Agency A's id. */
export const AGENCY_A = "agency-a";
/** Agency B's id. */
export const AGENCY_B = "agency-b";

/** User uids used across principals and applications. */
export const UID = {
  admin: "uid-admin",
  ownerA: "uid-owner-a",
  ownerB: "uid-owner-b",
  agentA1: "uid-agent-a1",
  agentA2: "uid-agent-a2",
  agentB1: "uid-agent-b1",
  agentIndep: "uid-agent-indep",
  ownerNoAgency: "uid-owner-none",
  client1: "uid-client-1",
  client2: "uid-client-2",
} as const;

// ============================================
// Principals (who is asking)
// ============================================

/**
 * Every principal in the matrix. `agencyId: null` is what the role claims
 * carry for a user with no agency (claims.service `setRoleClaims`).
 */
export const PRINCIPALS = {
  /** Platform admin: `manage all`. */
  admin: { uid: UID.admin, role: ROLES.ADMIN, agencyId: null },
  /** Owner of agency A. */
  ownerA: { uid: UID.ownerA, role: ROLES.OWNER, agencyId: AGENCY_A },
  /** Owner of agency B. */
  ownerB: { uid: UID.ownerB, role: ROLES.OWNER, agencyId: AGENCY_B },
  /** Agent in agency A; the assigned agent of `aAssigned`. */
  agentA1: { uid: UID.agentA1, role: ROLES.AGENT, agencyId: AGENCY_A },
  /** A colleague in agency A who is assigned to nothing. */
  agentA2: { uid: UID.agentA2, role: ROLES.AGENT, agencyId: AGENCY_A },
  /** Agent in agency B; the assigned agent of `bAssigned`. */
  agentB1: { uid: UID.agentB1, role: ROLES.AGENT, agencyId: AGENCY_B },
  /** Independent agent: agent role, no agency. */
  agentIndep: { uid: UID.agentIndep, role: ROLES.AGENT, agencyId: null },
  /** Owner role with no agency (should not exist, but the claims allow it). */
  ownerNoAgency: { uid: UID.ownerNoAgency, role: ROLES.OWNER, agencyId: null },
  /** The applicant of most applications below. */
  client1: { uid: UID.client1, role: ROLES.CLIENT, agencyId: null },
  /** Another client; applicant of `bAssigned` only. */
  client2: { uid: UID.client2, role: ROLES.CLIENT, agencyId: null },
  /**
   * What `attachAuthz` (middleware/auth.ts) falls back to when resolving the
   * principal throws: least-privilege `client` with no agency. Here it is
   * agent A1's uid, i.e. an agent whose authz resolution failed.
   */
  fallbackClient: { uid: UID.agentA1, role: ROLES.CLIENT, agencyId: null },
} satisfies Record<string, AuthzSubject>;

/** Name of a principal in the matrix. */
export type PrincipalName = keyof typeof PRINCIPALS;

// ============================================
// Applications (what is being asked for)
// ============================================

/** Fixed timestamp for the fixture docs. */
const NOW = Timestamp.fromMillis(Date.UTC(2026, 10, 10));

/**
 * Build an Application with only the fields the access rule reads
 * (`userId`, `agentId`, `agencyId`) plus enough of the rest to be a valid doc.
 * Optional fields that are not passed are ABSENT (not `undefined`-valued
 * keys... see `selfServe` below for why that matters).
 */
function app(id: string, access: Pick<Application, "userId"> & Partial<Application>): Application {
  return {
    id,
    visaTypeId: "skilled-worker",
    countryCode: "GB",
    mode: access.agentId ? "agent" : "self",
    status: "draft",
    progress: 0,
    currentStep: "Getting started",
    startDate: NOW,
    lastUpdated: NOW,
    documentsRequired: 0,
    documentsUploaded: 0,
    documentsVerified: 0,
    documentsRejected: 0,
    totalCost: 0,
    amountPaid: 0,
    paymentStatus: "pending",
    clientName: "Test Client",
    clientEmail: "delivered+client@resend.dev",
    visaTypeName: "Skilled Worker",
    countryName: "United Kingdom",
    createdAt: NOW,
    updatedAt: NOW,
    ...access,
  } as Application;
}

/** Every application in the matrix. */
export const APPLICATIONS = {
  /** Agency A's case, applicant client1, assigned to agent A1. */
  aAssigned: app("app-a-assigned", { userId: UID.client1, agentId: UID.agentA1, agencyId: AGENCY_A }),
  /** Agency A's case, applicant client1, no agent assigned yet. */
  aUnassigned: app("app-a-unassigned", { userId: UID.client1, agencyId: AGENCY_A }),
  /** Agency B's case, applicant client2, assigned to agent B1. */
  bAssigned: app("app-b-assigned", { userId: UID.client2, agentId: UID.agentB1, agencyId: AGENCY_B }),
  /**
   * Self-serve application: NO `agentId` and NO `agencyId` field at all. This
   * is what application.service `createApplication` stores for mode "self"
   * (Firestore drops undefined properties).
   */
  selfServe: app("app-self", { userId: UID.client1 }),
  /** Same, but with the fields present and `null` (e.g. after an unassign). */
  nullAgency: app("app-null-agency", {
    userId: UID.client1,
    agentId: null as unknown as undefined,
    agencyId: null as unknown as undefined,
  }),
  /** Handled by the independent agent: `agentId` set, no `agencyId` field. */
  indepAssigned: app("app-indep", { userId: UID.client1, agentId: UID.agentIndep }),
  /**
   * An application whose APPLICANT is agent A1 (an agent applying for a visa
   * themselves), handled by agency B / agent B1.
   */
  ownedByAgentA1: app("app-owned-by-agent-a1", {
    userId: UID.agentA1,
    agentId: UID.agentB1,
    agencyId: AGENCY_B,
  }),
} satisfies Record<string, Application>;

/** Name of an application in the matrix. */
export type ApplicationName = keyof typeof APPLICATIONS;

// ============================================
// The matrix
// ============================================

/** The three actions `checkApplicationAccess` accepts. */
export const ACTIONS = ["read", "update", "delete"] as const;
/** One of the three actions. */
export type AccessAction = (typeof ACTIONS)[number];

/**
 * Expected result per principal x application, as a 3-letter code in the
 * order read / update / delete: a letter means ALLOWED, `-` means DENIED.
 *   "rud" = all three, "r--" = read only, "---" = nothing.
 */
export const MATRIX: Record<PrincipalName, Record<ApplicationName, string>> = {
  // Admin: everything, whatever the agency.
  admin: {
    aAssigned: "rud", aUnassigned: "rud", bAssigned: "rud", selfServe: "rud",
    nullAgency: "rud", indepAssigned: "rud", ownedByAgentA1: "rud",
  },
  // Owner: manages every case of their own agency, nothing else.
  ownerA: {
    aAssigned: "rud", aUnassigned: "rud", bAssigned: "---", selfServe: "---",
    nullAgency: "---", indepAssigned: "---", ownedByAgentA1: "---",
  },
  ownerB: {
    aAssigned: "---", aUnassigned: "---", bAssigned: "rud", selfServe: "---",
    nullAgency: "---", indepAssigned: "---", ownedByAgentA1: "rud",
  },
  // Assigned agent: manages their own case; READS the rest of their agency.
  // Being the applicant (ownedByAgentA1) grants an agent-role principal
  // nothing: the applicant grant belongs to the client role only.
  agentA1: {
    aAssigned: "rud", aUnassigned: "r--", bAssigned: "---", selfServe: "---",
    nullAgency: "---", indepAssigned: "---", ownedByAgentA1: "---",
  },
  // Same-agency colleague: read only, own agency only.
  agentA2: {
    aAssigned: "r--", aUnassigned: "r--", bAssigned: "---", selfServe: "---",
    nullAgency: "---", indepAssigned: "---", ownedByAgentA1: "---",
  },
  agentB1: {
    aAssigned: "---", aUnassigned: "---", bAssigned: "rud", selfServe: "---",
    nullAgency: "---", indepAssigned: "---", ownedByAgentA1: "rud",
  },
  // FIXED BY DURIN-TECH/japa#131 (the only cells that ever changed here):
  //   agentIndep    -> selfServe      was "r--", now "---"
  //   ownerNoAgency -> selfServe      was "rud", now "---"
  //   ownerNoAgency -> indepAssigned  was "rud", now "---"
  // Before `@durin-tech/authz` 0.1.7 a no-agency `agent` / `owner` was
  // granted on `{ agencyId: undefined }`, which CASL matches against any
  // application with NO `agencyId` field (undefined === undefined), i.e.
  // self-serve applications and the cases of independent agents. The agency
  // grant is now only added when the principal has a non-empty `agencyId`.
  //
  // Independent agent: denied every agency's cases AND every application
  // that merely lacks an agency; still fully manages the case assigned to
  // them (`indepAssigned`, through the assigned-agent grant on `agentId`).
  agentIndep: {
    aAssigned: "---", aUnassigned: "---", bAssigned: "---", selfServe: "---",
    nullAgency: "---", indepAssigned: "rud", ownedByAgentA1: "---",
  },
  // Owner role without an agency: nothing. The owner role has only the
  // agency grant on applications, and with no agency that grant is not added.
  ownerNoAgency: {
    aAssigned: "---", aUnassigned: "---", bAssigned: "---", selfServe: "---",
    nullAgency: "---", indepAssigned: "---", ownedByAgentA1: "---",
  },
  // Applicant: manages their own applications, whoever handles them.
  client1: {
    aAssigned: "rud", aUnassigned: "rud", bAssigned: "---", selfServe: "rud",
    nullAgency: "rud", indepAssigned: "rud", ownedByAgentA1: "---",
  },
  client2: {
    aAssigned: "---", aUnassigned: "---", bAssigned: "rud", selfServe: "---",
    nullAgency: "---", indepAssigned: "---", ownedByAgentA1: "---",
  },
  // Least-privilege fallback (agent A1's uid, client role): loses the agent
  // grants (aAssigned is denied) and keeps only what a client would have.
  fallbackClient: {
    aAssigned: "---", aUnassigned: "---", bAssigned: "---", selfServe: "---",
    nullAgency: "---", indepAssigned: "---", ownedByAgentA1: "rud",
  },
};

/** True when `code` (e.g. "r--") allows `action`. */
export function expected(code: string, action: AccessAction): boolean {
  return code[ACTIONS.indexOf(action)] !== "-";
}

/** Every (principal, application, action, expected) cell of the matrix. */
export function matrixCells(): {
  principal: PrincipalName;
  application: ApplicationName;
  action: AccessAction;
  allowed: boolean;
}[] {
  const cells = [];
  for (const principal of Object.keys(MATRIX) as PrincipalName[]) {
    for (const application of Object.keys(MATRIX[principal]) as ApplicationName[]) {
      for (const action of ACTIONS) {
        cells.push({
          principal,
          application,
          action,
          allowed: expected(MATRIX[principal][application], action),
        });
      }
    }
  }
  return cells;
}

// ============================================
// Entitlements (subscription state layered over the role rule)
// ============================================

/** Agency A's entitlements with a paid-up plan: no effect on access. */
export const ENT_ACTIVE: Entitlements = {
  subscriberType: "agency",
  subscriberId: AGENCY_A,
  planId: "plan-test",
  status: "active",
  features: [],
  limits: {},
};

/** Agency A's entitlements with a lapsed plan: read-only (writes stripped). */
export const ENT_LAPSED: Entitlements = { ...ENT_ACTIVE, status: "past_due" };
