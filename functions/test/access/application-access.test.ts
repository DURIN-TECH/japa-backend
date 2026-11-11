// ============================================
// Unit tests — the application access check (issue #29)
// ============================================
//
// Run with `npm test`. Hermetic: NO network and NO emulator.
//
// Pins the allow/deny matrix (test/access/fixtures.ts) of the shared
// `checkApplicationAccess` in src/utils/access.ts. The table was first run
// green against the private `ApplicationController.checkApplicationAccess`
// (commit "pin the application access allow/deny matrix before extraction"),
// then this file's `check()` was pointed at the shared function with the
// table left alone: same answers before and after the move.
//
// Every cell is asked THREE ways, which must all agree:
//  1. with an already-built ability (what REST handlers pass: `req.ability`),
//  2. with a narrow principal (what a Firestore trigger passes: no request),
//  3. through the request adapter `checkApplicationAccessForRequest`.
//
// The table changed ONCE since the extraction, on purpose: DURIN-TECH/japa#131
// (fixed in `@durin-tech/authz` 0.1.7) stopped a no-agency agent / owner from
// matching applications through the agency grant. The three cells that #29
// had pinned as a known defect are now denied; see the "#131" block below.
//
// Also covers what is new in #29, all of it fail-closed:
//  - a missing principal / missing application (admin included) is denied;
//  - `buildAbilityForPrincipal`: malformed principal -> deny-all, and
//    null entitlements behave like "none" (as on the request path);
//  - `resolveAbilityForUid` (trigger side): deny-all when the principal or
//    its entitlements cannot be resolved.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ROLES, defineAbilitiesFor } from "@durin-tech/authz";
import type { AppAbility, AuthzSubject, Entitlements } from "@durin-tech/authz";

import {
  buildAbilityForPrincipal,
  checkApplicationAccess,
  checkApplicationAccessForRequest,
  denyAllAbility,
  resolveAbilityForUid,
} from "../../src/utils/access";
import type { Application } from "../../src/types";
import {
  ACTIONS,
  APPLICATIONS,
  ENT_ACTIVE,
  ENT_LAPSED,
  MATRIX,
  PRINCIPALS,
  matrixCells,
} from "./fixtures";
import type { AccessAction } from "./fixtures";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * The check under test, reduced to (principal, application, action,
 * entitlements) -> boolean. `entitlements` undefined = RBAC only, which is
 * what `attachAuthz` passes when no entitlements cache exists.
 *
 * Asks the three entry points and fails if they disagree, so no caller style
 * can be more permissive than another.
 */
function check(
  principal: AuthzSubject,
  application: Application,
  action?: AccessAction,
  entitlements?: Entitlements
): boolean {
  // 1. Built ability, exactly as `attachAuthz` builds `req.ability`.
  const ability = defineAbilitiesFor(principal, entitlements);
  const viaAbility =
    action === undefined
      ? checkApplicationAccess(ability, application)
      : checkApplicationAccess(ability, application, action);
  // 2. Narrow principal, no request and no pre-built ability.
  const who = { authz: principal, entitlements };
  const viaPrincipal =
    action === undefined
      ? checkApplicationAccess(who, application)
      : checkApplicationAccess(who, application, action);
  // 3. Request adapter (reads `req.ability` only).
  const req = { ability };
  const viaRequest =
    action === undefined
      ? checkApplicationAccessForRequest(req, application)
      : checkApplicationAccessForRequest(req, application, action);

  assert.equal(viaPrincipal, viaAbility, "principal and ability entry points disagree");
  assert.equal(viaRequest, viaAbility, "request adapter and ability entry points disagree");
  return viaAbility;
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
// #131: a principal with no agency never matches through the agency grant
// ============================================

describe("checkApplicationAccess: no agency, no agency grant (#131, was a pinned known defect)", () => {
  // Until `@durin-tech/authz` 0.1.7 a no-agency agent / owner was granted on
  // `{ agencyId: undefined }`, which matched any application with no
  // `agencyId` field. #29 pinned the three affected cells as allowed
  // (KNOWN_DEFECT_CELLS, now removed); the fix flipped them to deny. They are
  // spelled out here, independently of MATRIX, so the fix cannot be undone by
  // editing the table alone.

  /** The cells #29 pinned as allowed and #131 flipped to deny. */
  const FIXED_CELLS = [
    [PRINCIPALS.agentIndep, APPLICATIONS.selfServe],
    [PRINCIPALS.ownerNoAgency, APPLICATIONS.selfServe],
    [PRINCIPALS.ownerNoAgency, APPLICATIONS.indepAssigned],
  ] as const;

  test("the three formerly-allowed cells are denied for every action, and MATRIX says so", () => {
    assert.equal(MATRIX.agentIndep.selfServe, "---");
    assert.equal(MATRIX.ownerNoAgency.selfServe, "---");
    assert.equal(MATRIX.ownerNoAgency.indepAssigned, "---");
    for (const [principal, application] of FIXED_CELLS) {
      for (const action of ACTIONS) {
        assert.equal(check(principal, application, action), false, `${principal.uid} ${action} ${application.id}`);
      }
    }
  });

  test("an independent agent cannot read a stranger's self-serve application", () => {
    for (const action of ACTIONS) {
      assert.equal(check(PRINCIPALS.agentIndep, APPLICATIONS.selfServe, action), false);
    }
  });

  test("an independent agent still has full access to the application assigned to them", () => {
    // The assigned-agent grant is keyed on `agentId`, not on the agency.
    for (const action of ACTIONS) {
      assert.equal(check(PRINCIPALS.agentIndep, APPLICATIONS.indepAssigned, action), true);
    }
  });

  test("an owner with no agency has no access to any application", () => {
    for (const application of Object.values(APPLICATIONS)) {
      for (const action of ACTIONS) {
        assert.equal(check(PRINCIPALS.ownerNoAgency, application, action), false, `${action} ${application.id}`);
      }
    }
  });

  test("no agency in any spelling (absent, null) x application agencyId absent, null or set: denied", () => {
    // Principals: the claims carry `null`; a hand-built principal may omit it.
    const noAgency: AuthzSubject[] = [
      PRINCIPALS.agentIndep,
      { uid: PRINCIPALS.agentIndep.uid, role: ROLES.AGENT },
      PRINCIPALS.ownerNoAgency,
      { uid: PRINCIPALS.ownerNoAgency.uid, role: ROLES.OWNER },
    ];
    // Applications none of them is assigned to: field absent, null, set.
    const strangers = [APPLICATIONS.selfServe, APPLICATIONS.nullAgency, APPLICATIONS.aUnassigned, APPLICATIONS.bAssigned];
    for (const principal of noAgency) {
      for (const application of strangers) {
        for (const action of ACTIONS) {
          assert.equal(check(principal, application, action), false, `${principal.role} ${action} ${application.id}`);
        }
      }
    }
  });

  test("a lapsed or active plan does not bring the access back", () => {
    for (const entitlements of [ENT_ACTIVE, ENT_LAPSED]) {
      for (const [principal, application] of FIXED_CELLS) {
        for (const action of ACTIONS) {
          assert.equal(check(principal, application, action, entitlements), false);
        }
      }
    }
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

// ============================================
// Fail closed: missing principal / application
// ============================================

describe("checkApplicationAccess: missing inputs are denied", () => {
  test("no principal: denied", () => {
    for (const action of ACTIONS) {
      assert.equal(checkApplicationAccess(null, APPLICATIONS.selfServe, action), false);
      assert.equal(checkApplicationAccess(undefined, APPLICATIONS.selfServe, action), false);
    }
  });

  test("an application that does not exist: denied, even for an admin", () => {
    const adminAbility = defineAbilitiesFor(PRINCIPALS.admin);
    for (const action of ACTIONS) {
      assert.equal(checkApplicationAccess(adminAbility, null, action), false);
      assert.equal(checkApplicationAccess(adminAbility, undefined, action), false);
      assert.equal(checkApplicationAccess({ authz: PRINCIPALS.admin }, null, action), false);
      assert.equal(checkApplicationAccessForRequest({ ability: adminAbility }, null, action), false);
    }
  });

  test("a request with no ability: denied, and not rebuilt from other request fields", () => {
    // `authz` says admin, but only `ability` counts.
    const req = { authz: PRINCIPALS.admin, ability: undefined } as any;
    assert.equal(checkApplicationAccessForRequest(req, APPLICATIONS.selfServe), false);
  });

  test("the deny-all ability denies everything", () => {
    const none = denyAllAbility();
    for (const app of Object.values(APPLICATIONS)) {
      for (const action of ACTIONS) {
        assert.equal(checkApplicationAccess(none, app, action), false);
      }
    }
    assert.equal(none.can("manage", "all"), false);
  });
});

// ============================================
// buildAbilityForPrincipal (sync, no request)
// ============================================

/** True when `ability` grants nothing on any fixture application. */
function deniesEverything(ability: AppAbility): boolean {
  return Object.values(APPLICATIONS).every((app) =>
    ACTIONS.every((action) => !checkApplicationAccess(ability, app, action))
  );
}

describe("buildAbilityForPrincipal", () => {
  test("builds the same ability the request path would", () => {
    for (const cell of matrixCells()) {
      const ability = buildAbilityForPrincipal({ authz: PRINCIPALS[cell.principal] });
      assert.equal(
        checkApplicationAccess(ability, APPLICATIONS[cell.application], cell.action),
        cell.allowed,
        `${cell.principal} ${cell.action} ${cell.application}`
      );
    }
  });

  test("null entitlements mean 'no plan resolved': role rules only, as on the request path", () => {
    for (const action of ACTIONS) {
      assert.equal(
        checkApplicationAccess({ authz: PRINCIPALS.ownerA, entitlements: null }, APPLICATIONS.aAssigned, action),
        true
      );
    }
    // And it is the request path's ability rule for rule (undefined, not null).
    assert.deepEqual(
      buildAbilityForPrincipal({ authz: PRINCIPALS.ownerA, entitlements: null }).rules,
      defineAbilitiesFor(PRINCIPALS.ownerA).rules
    );
  });

  test("resolved entitlements are applied (lapsed plan = read-only)", () => {
    const ability = buildAbilityForPrincipal({ authz: PRINCIPALS.ownerA, entitlements: ENT_LAPSED });
    assert.equal(checkApplicationAccess(ability, APPLICATIONS.aAssigned, "read"), true);
    assert.equal(checkApplicationAccess(ability, APPLICATIONS.aAssigned, "update"), false);
    assert.equal(checkApplicationAccess(ability, APPLICATIONS.aAssigned, "delete"), false);
  });

  test("a missing or malformed principal gets the deny-all ability", () => {
    const bad: any[] = [
      null,
      undefined,
      {},
      { authz: null },
      { authz: undefined },
      { authz: "uid-admin" },
      { authz: { role: ROLES.ADMIN } }, // no uid
      { authz: { uid: "", role: ROLES.ADMIN } }, // empty uid
      { authz: { uid: 42, role: ROLES.ADMIN } }, // non-string uid
      { authz: { uid: "uid-x" } }, // no role
      { authz: { uid: "uid-x", role: "superuser" } }, // unknown role
      { authz: { uid: "uid-x", role: "ADMIN" } }, // wrong case is not admin
      // agencyId that is not null / undefined / a non-empty string. An object
      // here would be read by CASL as a Mongo operator (review of #29).
      { authz: { uid: "uid-x", role: ROLES.OWNER, agencyId: { $ne: null } } },
      { authz: { uid: "uid-x", role: ROLES.OWNER, agencyId: { $exists: true } } },
      { authz: { uid: "uid-x", role: ROLES.AGENT, agencyId: { $in: ["agency-a", "agency-b"] } } },
      { authz: { uid: "uid-x", role: ROLES.OWNER, agencyId: ["agency-b"] } },
      { authz: { uid: "uid-x", role: ROLES.OWNER, agencyId: 0 } },
      { authz: { uid: "uid-x", role: ROLES.OWNER, agencyId: "" } },
      // Same trick on the uid (used in `userId` / `agentId` conditions).
      { authz: { uid: { $ne: null }, role: ROLES.CLIENT } },
    ];
    for (const principal of bad) {
      const ability = buildAbilityForPrincipal(principal);
      assert.equal(ability.rules.length, 0, `expected no rules for ${JSON.stringify(principal)}`);
      assert.equal(deniesEverything(ability), true);
    }
  });

  test("an operator-valued agencyId never reaches another agency's application", () => {
    // The attack from the review of #29: an owner/agent principal whose
    // agencyId is a Mongo operator instead of an id.
    const operators: any[] = [{ $ne: null }, { $exists: true }, { $in: ["agency-a", "agency-b"] }];
    for (const role of [ROLES.OWNER, ROLES.AGENT]) {
      for (const agencyId of operators) {
        const who: any = { authz: { uid: "uid-attacker", role, agencyId } };
        for (const app of Object.values(APPLICATIONS)) {
          for (const action of ACTIONS) {
            assert.equal(
              checkApplicationAccess(who, app, action),
              false,
              `${role} ${JSON.stringify(agencyId)} ${action} ${app.id}`
            );
          }
        }
      }
    }
  });

  test("an object that only looks like an ability is treated as a principal, and denied", () => {
    // Has a `can` function but is not a CASL ability: must not be trusted.
    const fake: any = { can: () => true };
    assert.equal(checkApplicationAccess(fake, APPLICATIONS.selfServe), false);
    // A real principal with a stray `can` is still judged by its role.
    const who: any = { authz: PRINCIPALS.client2, can: () => true };
    assert.equal(checkApplicationAccess(who, APPLICATIONS.aAssigned), false);
    assert.equal(checkApplicationAccess(who, APPLICATIONS.bAssigned), true);
  });

  test("a malformed principal passed straight to the check is denied too", () => {
    const who: any = { authz: { uid: "", role: ROLES.ADMIN } };
    assert.equal(checkApplicationAccess(who, APPLICATIONS.selfServe), false);
  });
});

// ============================================
// resolveAbilityForUid (trigger side: uid in, ability out, never throws)
// ============================================

describe("resolveAbilityForUid: resolves like the request path", () => {
  test("principal + no entitlements: role rules only", async () => {
    const ability = await resolveAbilityForUid(PRINCIPALS.agentA1.uid, {
      resolvePrincipal: async () => PRINCIPALS.agentA1,
      resolveEntitlements: async () => null,
    });
    assert.equal(checkApplicationAccess(ability, APPLICATIONS.aAssigned, "update"), true);
    assert.equal(checkApplicationAccess(ability, APPLICATIONS.aUnassigned, "read"), true);
    assert.equal(checkApplicationAccess(ability, APPLICATIONS.aUnassigned, "update"), false);
    assert.equal(checkApplicationAccess(ability, APPLICATIONS.bAssigned, "read"), false);
  });

  test("the whole matrix holds for a resolved principal", async () => {
    for (const cell of matrixCells()) {
      const principal = PRINCIPALS[cell.principal];
      const ability = await resolveAbilityForUid(principal.uid, {
        resolvePrincipal: async () => principal,
        resolveEntitlements: async () => undefined,
      });
      assert.equal(
        checkApplicationAccess(ability, APPLICATIONS[cell.application], cell.action),
        cell.allowed,
        `${cell.principal} ${cell.action} ${cell.application}`
      );
    }
  });

  test("resolved entitlements are applied (lapsed plan = read-only)", async () => {
    const ability = await resolveAbilityForUid(PRINCIPALS.ownerA.uid, {
      resolvePrincipal: async () => PRINCIPALS.ownerA,
      resolveEntitlements: async () => ENT_LAPSED,
    });
    assert.equal(checkApplicationAccess(ability, APPLICATIONS.aAssigned, "read"), true);
    assert.equal(checkApplicationAccess(ability, APPLICATIONS.aAssigned, "update"), false);
  });

  test("admins skip the entitlements lookup", async () => {
    let asked = false;
    const ability = await resolveAbilityForUid(PRINCIPALS.admin.uid, {
      resolvePrincipal: async () => PRINCIPALS.admin,
      resolveEntitlements: async () => {
        asked = true;
        throw new Error("must not be called for an admin");
      },
    });
    assert.equal(asked, false);
    assert.equal(checkApplicationAccess(ability, APPLICATIONS.bAssigned, "delete"), true);
  });
});

describe("resolveAbilityForUid: defaults to deny when something cannot be resolved", () => {
  /** Entitlements resolver for cases that must never reach it. */
  const neverEntitlements = async (): Promise<null> => {
    throw new Error("resolveEntitlements must not be reached");
  };

  test("empty / missing uid: deny-all, resolvers not called", async () => {
    for (const uid of ["", null, undefined, 42 as any]) {
      let called = false;
      const ability = await resolveAbilityForUid(uid, {
        resolvePrincipal: async () => {
          called = true;
          return PRINCIPALS.admin;
        },
        resolveEntitlements: neverEntitlements,
      });
      assert.equal(called, false);
      assert.equal(ability.rules.length, 0);
    }
  });

  test("principal lookup throws: deny-all", async () => {
    const ability = await resolveAbilityForUid(PRINCIPALS.admin.uid, {
      resolvePrincipal: async () => {
        throw new Error("firestore unavailable");
      },
      resolveEntitlements: neverEntitlements,
    });
    assert.equal(ability.rules.length, 0);
    assert.equal(deniesEverything(ability), true);
  });

  test("principal not found (null / undefined): deny-all", async () => {
    for (const found of [null, undefined]) {
      const ability = await resolveAbilityForUid("uid-ghost", {
        resolvePrincipal: async () => found,
        resolveEntitlements: neverEntitlements,
      });
      assert.equal(ability.rules.length, 0);
    }
  });

  test("malformed principal (unknown role, empty uid, bad agencyId): deny-all", async () => {
    const malformed = [
      { uid: "uid-x", role: "superuser" },
      { uid: "", role: ROLES.ADMIN },
      { uid: "uid-x" },
      // agencyId as a Mongo operator / non-id value (review of #29).
      { uid: "uid-x", role: ROLES.OWNER, agencyId: { $ne: null } },
      { uid: "uid-x", role: ROLES.AGENT, agencyId: { $exists: true } },
      { uid: "uid-x", role: ROLES.OWNER, agencyId: ["agency-b"] },
      { uid: "uid-x", role: ROLES.OWNER, agencyId: "" },
    ];
    for (const found of malformed) {
      const ability = await resolveAbilityForUid("uid-x", {
        resolvePrincipal: async () => found as any,
        resolveEntitlements: neverEntitlements,
      });
      assert.equal(ability.rules.length, 0);
    }
  });

  test("resolver answers for a different uid: deny-all", async () => {
    // Asked about client2, got the admin back: must not become admin.
    const ability = await resolveAbilityForUid(PRINCIPALS.client2.uid, {
      resolvePrincipal: async () => PRINCIPALS.admin,
      resolveEntitlements: neverEntitlements,
    });
    assert.equal(ability.rules.length, 0);
  });

  test("entitlements lookup throws: deny-all (not role-only)", async () => {
    // The applicant would be allowed on role rules alone; an unresolvable
    // subscription state must not be read as "no restrictions".
    const ability = await resolveAbilityForUid(PRINCIPALS.client1.uid, {
      resolvePrincipal: async () => PRINCIPALS.client1,
      resolveEntitlements: async () => {
        throw new Error("entitlements cache unavailable");
      },
    });
    assert.equal(ability.rules.length, 0);
    assert.equal(checkApplicationAccess(ability, APPLICATIONS.selfServe, "read"), false);
  });

  test("never throws, even when a resolver throws synchronously", async () => {
    const ability = await resolveAbilityForUid("uid-x", {
      resolvePrincipal: () => {
        throw new Error("sync failure");
      },
      resolveEntitlements: neverEntitlements,
    });
    assert.equal(ability.rules.length, 0);
  });
});
