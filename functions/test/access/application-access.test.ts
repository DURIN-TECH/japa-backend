// ============================================
// Unit tests — the application access check (issue #29)
// ============================================
//
// Run with `npm test`. Hermetic: NO network and NO emulator.
//
// BASELINE VERSION (first commit of #29): the check is still the private
// `ApplicationController.checkApplicationAccess(req, application, action)`.
// This file pins its allow/deny matrix (test/access/fixtures.ts) BEFORE the
// function moves to src/utils/access.ts, so the move can be shown to change
// nothing. The next commit points `check()` below at the shared function and
// leaves the table alone.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { defineAbilitiesFor } from "@durin-tech/authz";
import type { AuthzSubject, Entitlements } from "@durin-tech/authz";

import { applicationController } from "../../src/controllers/application.controller";
import type { Application } from "../../src/types";
import {
  ACTIONS,
  APPLICATIONS,
  ENT_ACTIVE,
  ENT_LAPSED,
  KNOWN_DEFECT_CELLS,
  MATRIX,
  PRINCIPALS,
  matrixCells,
} from "./fixtures";
import type { AccessAction } from "./fixtures";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * The check under test, reduced to (principal, entitlements, application,
 * action) -> boolean. `entitlements` undefined = RBAC only, which is what
 * `attachAuthz` passes when no entitlements cache exists.
 */
function check(
  principal: AuthzSubject,
  application: Application,
  action?: AccessAction,
  entitlements?: Entitlements
): boolean {
  const req = { ability: defineAbilitiesFor(principal, entitlements) };
  const fn = (applicationController as any).checkApplicationAccess;
  return action === undefined ? fn(req, application) : fn(req, application, action);
}

// ============================================
// The matrix: every role x application x action, two agencies
// ============================================

describe("checkApplicationAccess: allow/deny matrix", () => {
  for (const cell of matrixCells()) {
    test(`${cell.principal} ${cell.action} ${cell.application}: ${cell.allowed ? "allow" : "deny"}`, () => {
      assert.equal(
        check(PRINCIPALS[cell.principal], APPLICATIONS[cell.application], cell.action),
        cell.allowed
      );
    });
  }

  test("the action defaults to read", () => {
    // agentA2 may read but not update/delete an agency-A case.
    assert.equal(check(PRINCIPALS.agentA2, APPLICATIONS.aAssigned), true);
    // client2 may not read it at all.
    assert.equal(check(PRINCIPALS.client2, APPLICATIONS.aAssigned), false);
  });
});

// ============================================
// The awkward cases the issue names, spelled out
// ============================================

describe("checkApplicationAccess: named edge cases", () => {
  test("a cross-agency agent is denied every action", () => {
    for (const action of ACTIONS) {
      assert.equal(check(PRINCIPALS.agentB1, APPLICATIONS.aAssigned, action), false);
      assert.equal(check(PRINCIPALS.agentA1, APPLICATIONS.bAssigned, action), false);
    }
  });

  test("a cross-agency owner is denied every action", () => {
    for (const action of ACTIONS) {
      assert.equal(check(PRINCIPALS.ownerB, APPLICATIONS.aAssigned, action), false);
      assert.equal(check(PRINCIPALS.ownerA, APPLICATIONS.bAssigned, action), false);
    }
  });

  test("an agent with no agencyId is denied another user's agency application", () => {
    for (const action of ACTIONS) {
      assert.equal(check(PRINCIPALS.agentIndep, APPLICATIONS.aAssigned, action), false);
      assert.equal(check(PRINCIPALS.agentIndep, APPLICATIONS.aUnassigned, action), false);
      assert.equal(check(PRINCIPALS.agentIndep, APPLICATIONS.bAssigned, action), false);
      // agencyId present but null: still denied.
      assert.equal(check(PRINCIPALS.agentIndep, APPLICATIONS.nullAgency, action), false);
    }
  });

  test("an application with no agencyId: agency members are denied, the applicant and admin are allowed", () => {
    for (const action of ACTIONS) {
      assert.equal(check(PRINCIPALS.ownerA, APPLICATIONS.selfServe, action), false);
      assert.equal(check(PRINCIPALS.agentA1, APPLICATIONS.selfServe, action), false);
      assert.equal(check(PRINCIPALS.client2, APPLICATIONS.selfServe, action), false);
      assert.equal(check(PRINCIPALS.client1, APPLICATIONS.selfServe, action), true);
      assert.equal(check(PRINCIPALS.admin, APPLICATIONS.selfServe, action), true);
    }
  });

  test("the least-privilege client fallback keeps only what a client would have", () => {
    // Agent A1's uid with the fallback `client` role: the assigned-agent and
    // same-agency grants are gone...
    assert.equal(check(PRINCIPALS.fallbackClient, APPLICATIONS.aAssigned), false);
    assert.equal(check(PRINCIPALS.fallbackClient, APPLICATIONS.aUnassigned), false);
    // ...and only applications that uid applied for remain.
    assert.equal(check(PRINCIPALS.fallbackClient, APPLICATIONS.ownedByAgentA1), true);
  });

  test("update and delete: assigned agent yes, same-agency colleague no", () => {
    assert.equal(check(PRINCIPALS.agentA1, APPLICATIONS.aAssigned, "update"), true);
    assert.equal(check(PRINCIPALS.agentA1, APPLICATIONS.aAssigned, "delete"), true);
    assert.equal(check(PRINCIPALS.agentA2, APPLICATIONS.aAssigned, "read"), true);
    assert.equal(check(PRINCIPALS.agentA2, APPLICATIONS.aAssigned, "update"), false);
    assert.equal(check(PRINCIPALS.agentA2, APPLICATIONS.aAssigned, "delete"), false);
  });

  test("the applicant grant belongs to the client role: an agent-role applicant gets nothing from it", () => {
    for (const action of ACTIONS) {
      assert.equal(check(PRINCIPALS.agentA1, APPLICATIONS.ownedByAgentA1, action), false);
    }
  });
});

// ============================================
// Known defect, pinned so the refactor cannot hide or widen it
// ============================================

describe("checkApplicationAccess: KNOWN DEFECT in the rule (pinned, not endorsed)", () => {
  // See KNOWN_DEFECT_CELLS in fixtures.ts: a no-agency agent/owner matches
  // applications that have no `agencyId` field. Reported on #29; the fix
  // belongs in @durin-tech/authz. These assertions exist so that (a) the
  // refactor provably did not change it and (b) the fix has a test to flip.
  test("the listed cells are exactly the allowed ones the stated rule would deny", () => {
    for (const [p, a] of KNOWN_DEFECT_CELLS) {
      assert.notEqual(MATRIX[p][a], "---", `${p} -> ${a} is pinned as allowed`);
      assert.equal(check(PRINCIPALS[p], APPLICATIONS[a], "read"), true);
    }
  });

  test("an independent agent can READ (not write) a stranger's self-serve application", () => {
    assert.equal(check(PRINCIPALS.agentIndep, APPLICATIONS.selfServe, "read"), true);
    assert.equal(check(PRINCIPALS.agentIndep, APPLICATIONS.selfServe, "update"), false);
    assert.equal(check(PRINCIPALS.agentIndep, APPLICATIONS.selfServe, "delete"), false);
  });
});

// ============================================
// Entitlements layered over the role rule
// ============================================

describe("checkApplicationAccess: subscription state", () => {
  test("an active plan changes nothing", () => {
    for (const action of ACTIONS) {
      assert.equal(check(PRINCIPALS.ownerA, APPLICATIONS.aAssigned, action, ENT_ACTIVE), true);
    }
  });

  test("a lapsed plan is read-only: read stays, update and delete go", () => {
    assert.equal(check(PRINCIPALS.ownerA, APPLICATIONS.aAssigned, "read", ENT_LAPSED), true);
    assert.equal(check(PRINCIPALS.ownerA, APPLICATIONS.aAssigned, "update", ENT_LAPSED), false);
    assert.equal(check(PRINCIPALS.ownerA, APPLICATIONS.aAssigned, "delete", ENT_LAPSED), false);
    assert.equal(check(PRINCIPALS.agentA1, APPLICATIONS.aAssigned, "update", ENT_LAPSED), false);
  });

  test("a lapsed plan never widens access: cross-agency stays denied", () => {
    for (const action of ACTIONS) {
      assert.equal(check(PRINCIPALS.ownerA, APPLICATIONS.bAssigned, action, ENT_LAPSED), false);
    }
  });
});
