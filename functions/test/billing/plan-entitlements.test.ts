// ============================================
// Unit tests — which seeded plans hold `ai.case_officer`, and what
// `requireFeature("ai.case_officer")` does with them (issue #30)
// ============================================
//
// Run with `npm test`. Hermetic: NO network and NO emulator. Nothing here
// touches Firestore: the plans are the in-memory seed data exported by
// src/scripts/seed-plans.ts (the same array `seedPlans()` writes), flattened
// into entitlements with the real `entitlementsFromPlan` from
// @durin-tech/authz, and fed to the real `requireFeature` middleware with a
// minimal req / res.
//
// Two things are pinned:
//  1. The seed. Free plans are built from the whole authz catalog, so a new
//     catalog key lands on every free plan unless it is listed in
//     PAID_ONLY_FEATURES. These tests fail if a free plan holds a paid-only
//     key, or if a paid plan that should carry `ai.case_officer` loses it.
//  2. The gate. A subscriber on a free plan gets 402 UPGRADE_REQUIRED; a
//     subscriber on a paid plan, and an admin, get through. The safe-rollout
//     branch (entitlements not resolved -> let through) is asserted too, so a
//     change to it shows up here: the assessment handlers (#42) rely on
//     knowing it and fail closed themselves.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { FEATURE_KEYS, FEATURES, ROLES, entitlementsFromPlan } from "@durin-tech/authz";
import type { Entitlements, Role, SubscriptionStatus } from "@durin-tech/authz";

import { requireFeature } from "../../src/middleware/authz";
import type { AuthenticatedRequest } from "../../src/middleware/auth";
import { ALL_PLANS, FREE_PLAN_FEATURES, PAID_ONLY_FEATURES, PLANS } from "../../src/scripts/seed-plans";
import type { StoredPlan } from "../../src/types/billing";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ============================================
// Expected plan sets (the contract from issue #30)
// ============================================

/** The three free default plans: none may hold `ai.case_officer`. */
const FREE_PLAN_IDS = ["client_free", "agent_free", "agency_free"];

/**
 * The monthly paid plans that carry `ai.case_officer`: both paid client plans
 * and every paid agent / agency plan. Their `_yearly` variants are derived
 * from them by the seed and must carry it too.
 */
const PAID_AI_PLAN_IDS = [
  "client_standard",
  "client_pro",
  "agent_standard",
  "agent_pro",
  "agency_standard",
  "agency_pro",
];

/** Look a seeded plan up by id; fails the test when the seed no longer has it. */
function plan(id: string): StoredPlan {
  const found = ALL_PLANS.find((p) => p.id === id);
  assert.ok(found, `seed has no plan "${id}"`);
  return found;
}

/** A plan is "free" when it costs nothing (the seed's free defaults). */
const isFree = (p: StoredPlan) => p.priceKobo === 0;

// ============================================
// Minimal req / res for the middleware
// ============================================

/** What the middleware did: called next(), or answered with a status + body. */
interface GateResult {
  nextCalled: boolean;
  status: number | null;
  body: any;
}

/**
 * Run `requireFeature(ai.case_officer)` for a principal with `role` and the
 * given resolved entitlements (null = not resolved), and report what happened.
 */
function runGate(role: Role, entitlements: Entitlements | null): GateResult {
  const result: GateResult = { nextCalled: false, status: null, body: null };
  // Only the two fields the guard reads; attachAuthz (middleware/auth.ts) sets
  // both on a real request.
  const req = { authz: { uid: "u1", role, agencyId: null }, entitlements } as unknown as AuthenticatedRequest;
  const res: any = {
    status(code: number) {
      result.status = code;
      return res;
    },
    json(payload: unknown) {
      result.body = payload;
      return res;
    },
  };
  requireFeature(FEATURES.AI_CASE_OFFICER)(req, res, () => {
    result.nextCalled = true;
  });
  return result;
}

/** Entitlements a subscriber on seeded plan `id` resolves to. */
function entitlementsOn(id: string, status: SubscriptionStatus = "active"): Entitlements {
  const p = plan(id);
  return entitlementsFromPlan(p, p.audience, `sub-${id}`, status);
}

/** Assert the gate let the request through and wrote no response. */
function assertAllowed(r: GateResult, who: string): void {
  assert.equal(r.nextCalled, true, `${who}: next() should be called`);
  assert.equal(r.status, null, `${who}: no response should be written`);
}

/** Assert the gate answered 402 UPGRADE_REQUIRED and did not call next(). */
function assertUpgradeRequired(r: GateResult, who: string): void {
  assert.equal(r.nextCalled, false, `${who}: next() must not be called`);
  assert.equal(r.status, 402, `${who}: status`);
  assert.equal(r.body?.success, false, `${who}: success flag`);
  assert.equal(r.body?.error, "UPGRADE_REQUIRED", `${who}: error code`);
  assert.match(r.body?.message, /ai\.case_officer/, `${who}: message names the feature`);
}

// ============================================
// 1. The seed: who holds ai.case_officer
// ============================================

describe("plan seed: ai.case_officer (#30)", () => {
  test("ai.case_officer is a catalog key and is listed as paid-only", () => {
    assert.ok((FEATURE_KEYS as readonly string[]).includes("ai.case_officer"));
    assert.equal(FEATURES.AI_CASE_OFFICER, "ai.case_officer");
    assert.ok(PAID_ONLY_FEATURES.includes(FEATURES.AI_CASE_OFFICER));
  });

  test("the seed still has exactly the three free plans this contract names", () => {
    // If a fourth free plan is added, it must be added to FREE_PLAN_IDS (and so
    // to every assertion below) rather than slipping past them.
    assert.deepEqual(ALL_PLANS.filter(isFree).map((p) => p.id).sort(), [...FREE_PLAN_IDS].sort());
  });

  for (const id of FREE_PLAN_IDS) {
    test(`free plan ${id} does NOT hold ai.case_officer`, () => {
      assert.equal(plan(id).features.includes(FEATURES.AI_CASE_OFFICER), false);
    });
  }

  test("no free plan holds ANY paid-only feature", () => {
    for (const p of ALL_PLANS.filter(isFree)) {
      for (const key of PAID_ONLY_FEATURES) {
        assert.equal(p.features.includes(key), false, `${p.id} must not hold ${key}`);
      }
    }
  });

  test("free plans keep every other catalog feature (nothing else was taken away)", () => {
    const expected = FEATURE_KEYS.filter((k) => !PAID_ONLY_FEATURES.includes(k));
    assert.deepEqual(FREE_PLAN_FEATURES, expected);
    for (const id of FREE_PLAN_IDS) {
      assert.deepEqual(plan(id).features, expected, id);
    }
    // The eleven pre-#30 features, spelled out so a silent catalog change that
    // also shrinks the free plans is caught.
    assert.deepEqual(expected, [
      "applications.create",
      "applications.bulk",
      "messaging",
      "consultations.book",
      "documents.upload",
      "analytics.view",
      "agency.invite_agents",
      "self_service",
      "priority_support",
      "news.alerts",
      "payments.request",
    ]);
  });

  for (const id of PAID_AI_PLAN_IDS) {
    test(`paid plan ${id} holds ai.case_officer, and so does ${id}_yearly`, () => {
      assert.equal(plan(id).features.includes(FEATURES.AI_CASE_OFFICER), true, id);
      assert.equal(plan(`${id}_yearly`).features.includes(FEATURES.AI_CASE_OFFICER), true, `${id}_yearly`);
    });
  }

  test("the holders are exactly the paid plans: no plan is unaccounted for", () => {
    const holders = ALL_PLANS.filter((p) => p.features.includes(FEATURES.AI_CASE_OFFICER)).map((p) => p.id);
    const expected = [...PAID_AI_PLAN_IDS, ...PAID_AI_PLAN_IDS.map((id) => `${id}_yearly`)];
    assert.deepEqual([...holders].sort(), [...expected].sort());
    // Every seeded plan is either a named free plan or a named holder.
    assert.equal(ALL_PLANS.length, FREE_PLAN_IDS.length + expected.length);
  });

  test("every seeded feature is a catalog key, with no duplicates inside a plan", () => {
    for (const p of ALL_PLANS) {
      for (const f of p.features) {
        assert.ok((FEATURE_KEYS as readonly string[]).includes(f), `${p.id}: unknown feature ${f}`);
      }
      assert.equal(new Set(p.features).size, p.features.length, `${p.id}: duplicate feature`);
    }
  });

  test("ALL_PLANS is the monthly/free source plans plus one yearly variant per paid plan", () => {
    assert.equal(PLANS.length, 9);
    assert.equal(ALL_PLANS.length, 15);
  });
});

// ============================================
// 2. The gate: requireFeature("ai.case_officer") with seeded plans
// ============================================

describe("requireFeature(ai.case_officer) with seeded plans (#30)", () => {
  // ---- 402 path: every free plan, for the role that draws from it ----
  const freeCases: Array<[string, Role]> = [
    ["client_free", ROLES.CLIENT], // free self-service user
    ["agent_free", ROLES.AGENT], // independent agent on the free plan
    ["agency_free", ROLES.OWNER], // agency owner on the free plan
    ["agency_free", ROLES.AGENT], // agent inside a free agency
  ];
  for (const [id, role] of freeCases) {
    test(`402 UPGRADE_REQUIRED: ${role} on ${id}`, () => {
      assertUpgradeRequired(runGate(role, entitlementsOn(id)), `${role} on ${id}`);
    });
  }

  // ---- allow path: every paid plan (monthly and yearly) ----
  const paidCases: Array<[string, Role]> = [
    ["client_standard", ROLES.CLIENT],
    ["client_pro", ROLES.CLIENT],
    ["agent_standard", ROLES.AGENT],
    ["agent_pro", ROLES.AGENT],
    ["agency_standard", ROLES.OWNER],
    ["agency_standard", ROLES.AGENT],
    ["agency_pro", ROLES.OWNER],
    ["agency_pro", ROLES.AGENT],
  ];
  for (const [id, role] of paidCases) {
    test(`allowed: ${role} on ${id} (and ${id}_yearly)`, () => {
      assertAllowed(runGate(role, entitlementsOn(id)), `${role} on ${id}`);
      assertAllowed(runGate(role, entitlementsOn(`${id}_yearly`)), `${role} on ${id}_yearly`);
    });
  }

  test("allowed: a trialing paid subscription counts as holding the key", () => {
    assertAllowed(runGate(ROLES.CLIENT, entitlementsOn("client_pro", "trialing")), "trialing client_pro");
  });

  test("402: a lapsed paid subscription no longer holds the key", () => {
    for (const status of ["past_due", "canceled", "inactive"] as SubscriptionStatus[]) {
      assertUpgradeRequired(runGate(ROLES.CLIENT, entitlementsOn("client_pro", status)), `client_pro ${status}`);
    }
  });

  // ---- safe-rollout branches (middleware/authz.ts requireFeature), unchanged by #30 ----
  test("allowed: an admin bypasses the gate, whatever the entitlements say", () => {
    assertAllowed(runGate(ROLES.ADMIN, null), "admin, no entitlements");
    // Even handed a free plan's entitlements (never happens: admins resolve none).
    assertAllowed(runGate(ROLES.ADMIN, entitlementsOn("client_free")), "admin, free entitlements");
  });

  test("allowed (safe rollout): a non-admin whose entitlements are NOT resolved is let through", () => {
    // This is today's middleware behaviour and #30 does not change it: nobody
    // is locked out before plans/entitlements exist. It also means this guard
    // alone does not protect a paid response for such a caller, which is why
    // the assessment handlers (#42) resolve the tier themselves and fail
    // closed to the free response.
    for (const role of [ROLES.CLIENT, ROLES.AGENT, ROLES.OWNER]) {
      assertAllowed(runGate(role, null), `${role}, entitlements unresolved`);
    }
  });
});
