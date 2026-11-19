// ============================================
// Unit tests — the /ai plan gates fail closed, and the routes use them
// ============================================
//
// requireCaseOfficerPlanFailClosed (proposed actions) must refuse every caller
// that is not an admin or on a plan with `ai.case_officer`, INCLUDING a caller
// whose entitlements did not resolve (unlike requireFeature, which lets that
// through). And ai.routes.ts must put it on every actions route.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { FEATURES, ROLES, type Entitlements } from "@durin-tech/authz";
import { requireCaseOfficerPlanFailClosed } from "../../src/controllers/ai-action.controller";
import { tierFor } from "../../src/services/ai/tier-serializer";

/* eslint-disable @typescript-eslint/no-explicit-any */

const entitled = (features: string[]): Entitlements => ({ subscriberType: "client", subscriberId: "c1", planId: "p", status: "active", features, limits: {} }) as unknown as Entitlements;

/** Run the guard; report whether next() was called and what was sent. */
function run(role: string, entitlements: Entitlements | null | undefined) {
  const out: { next: boolean; status: number; body: any } = { next: false, status: 0, body: undefined };
  const res: any = {
    status(c: number) {
      out.status = c;
      return res;
    },
    json(b: unknown) {
      out.body = b;
      return res;
    },
  };
  requireCaseOfficerPlanFailClosed({ authz: { uid: "u1", role, agencyId: null }, entitlements } as any, res, () => void (out.next = true));
  return out;
}

describe("requireCaseOfficerPlanFailClosed", () => {
  test("unresolved entitlements are refused with 402, never let through", () => {
    for (const e of [null, undefined]) {
      const r = run(ROLES.AGENT, e);
      assert.equal(r.next, false);
      assert.equal(r.status, 402);
    }
  });

  test("a plan without ai.case_officer is refused with 402", () => {
    const r = run(ROLES.CLIENT, entitled([]));
    assert.equal(r.next, false);
    assert.equal(r.status, 402);
  });

  test("a plan with ai.case_officer passes; an admin passes with no entitlements", () => {
    assert.equal(run(ROLES.AGENT, entitled([FEATURES.AI_CASE_OFFICER])).next, true);
    assert.equal(run(ROLES.ADMIN, null).next, true);
  });

  test("the guard and the assessment tier agree (same rule)", () => {
    assert.equal(tierFor(ROLES.CLIENT, entitled([])), "free");
    assert.equal(tierFor(ROLES.CLIENT, null), "free");
    assert.equal(tierFor(ROLES.CLIENT, entitled([FEATURES.AI_CASE_OFFICER])), "full");
  });
});

describe("ai.routes.ts wiring", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "..", "src", "routes", "ai.routes.ts"), "utf8");
  // Route registrations as written, one per `aiRoutes.<verb>(` call.
  const calls = src.split(/aiRoutes\.(?=get|post|delete|put|patch)/).slice(1);

  test("every /ai route authenticates", () => {
    assert.ok(calls.length >= 10);
    for (const c of calls) assert.match(c, /verifyAuth/, c.slice(0, 80));
  });

  test("every proposed-actions route also carries the fail-closed plan guard", () => {
    const actions = calls.filter((c) => /\/actions/.test(c.split("\n")[0] + c.split("\n")[1]));
    assert.equal(actions.length, 3);
    for (const c of actions) assert.match(c, /requireCaseOfficerPlanFailClosed/, c.slice(0, 80));
  });
});
