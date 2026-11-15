// ============================================
// Unit tests — a client with no plan record is put on the default client plan
// by the sign-in middleware (issue #311)
// ============================================
//
// Run with `npm test`. Hermetic: NO network and NO emulator. The real
// `verifyAuth` (and through it the private `attachAuthz`) and the real
// `entitlementService` run against the in-memory Firestore fake; only token
// verification is a fixed table.
//
// What is pinned:
//  - a client with no `entitlements/{uid}` record gets the default client
//    plan resolved and written ONCE; later requests only read;
//  - a client who has a record is served from it with no write;
//  - a failed lookup, a failed default-plan read and a missing default plan
//    all leave entitlements unresolved (null) and write nothing: the
//    behaviour from before #311, never more access;
//  - admins, owners, agents and independent agents are untouched;
//  - two first requests at once both succeed and leave one document;
//  - a paid record written between the lazy path's reads and its write is
//    NOT replaced by the free plan (the write is create-only);
//  - the gates then bite: `requireFeature`, `checkWithinLimit`, the AI tier,
//    and `GET /subscriptions/me` reports what the request resolved.
//
// The plans here are TEST FIXTURES with real limits, not the seeded plans: on
// dev `client_free` is unlimited, which would prove nothing about limits.

import { test, describe, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { FEATURES, LIMITS, ROLES } from "@durin-tech/authz";
import type { Entitlements } from "@durin-tech/authz";

import { fakeCollection, fakeRunTransaction, resetStore, store, writes } from "../helpers/fake-firestore";
import type { AuthenticatedRequest } from "../../src/middleware/auth";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ============================================
// Fixtures
// ============================================

/** The default client plan for these tests: two features, one real limit. */
const FREE_PLAN = {
  id: "test_client_free",
  name: "Test Client Free",
  audience: "client",
  priceKobo: 0,
  interval: "none",
  isDefault: true,
  // No messaging and no `ai.case_officer`: both must answer 402.
  features: [FEATURES.APPLICATIONS_CREATE, FEATURES.DOCUMENTS_UPLOAD],
  limits: { [LIMITS.MAX_ACTIVE_APPLICATIONS]: 1 },
};

/** A paid client plan (not the default) that carries the AI case officer. */
const PAID_PLAN = {
  id: "test_client_paid",
  name: "Test Client Paid",
  audience: "client",
  priceKobo: 250000,
  interval: "month",
  features: [FEATURES.APPLICATIONS_CREATE, FEATURES.MESSAGING, FEATURES.AI_CASE_OFFICER],
  limits: { [LIMITS.MAX_ACTIVE_APPLICATIONS]: -1 },
};

/**
 * A default plan for the AGENT audience. It exists so that the agent tests
 * prove something: if the middleware ever ran the lazy path for an agent, this
 * plan would be found and a record written.
 */
const AGENT_DEFAULT_PLAN = {
  id: "test_agent_free",
  name: "Test Agent Free",
  audience: "agent",
  priceKobo: 0,
  interval: "none",
  isDefault: true,
  features: [FEATURES.MESSAGING],
  limits: {},
};

/** Same, for the AGENCY audience (owners and agents inside an agency). */
const AGENCY_DEFAULT_PLAN = { ...AGENT_DEFAULT_PLAN, id: "test_agency_free", audience: "agency" };

/** Valid bearer tokens -> the decoded token `verifyIdToken` returns. */
const TOKENS: Record<string, Record<string, unknown>> = {
  "tok-client": { uid: "uid-client", role: ROLES.CLIENT },
  "tok-admin": { uid: "uid-admin", role: ROLES.ADMIN },
  "tok-owner": { uid: "uid-owner", role: ROLES.OWNER, agencyId: "agency-1" },
  "tok-agent": { uid: "uid-agent", role: ROLES.AGENT, agencyId: "agency-1" },
  "tok-solo-agent": { uid: "uid-solo", role: ROLES.AGENT, agencyId: null },
  // A brand-new account: the token has no role claim yet.
  "tok-new": { uid: "uid-new" },
};

// ============================================
// Wiring
// ============================================

let firebase: any;
let entitlementService: any;
let verifyAuth: typeof import("../../src/middleware/auth").verifyAuth;
let requireFeature: typeof import("../../src/middleware/authz").requireFeature;
let checkWithinLimit: typeof import("../../src/middleware/authz").checkWithinLimit;
let tierFor: typeof import("../../src/services/ai/tier-serializer").tierFor;
let entitlementController: any;

/** console.error is silenced per test (the fail-safe paths log on purpose). */
const realConsoleError = console.error;

before(async () => {
  firebase = await import("../../src/utils/firebase");
  // Token verification: the fixed table, anything else is invalid.
  firebase.auth.verifyIdToken = async (token: string) => {
    const decoded = TOKENS[token];
    if (!decoded) throw new Error("invalid token");
    return decoded;
  };
  // Role lookup for the token with no role claim: a new account is a client.
  const { claimsService }: any = await import("../../src/services/claims.service");
  claimsService.resolveRoleFromDb = async () => ({ role: ROLES.CLIENT, agencyId: null });
  claimsService.setRoleClaims = async () => undefined;

  ({ entitlementService } = await import("../../src/services/entitlement.service"));
  ({ verifyAuth } = await import("../../src/middleware/auth"));
  ({ requireFeature, checkWithinLimit } = await import("../../src/middleware/authz"));
  ({ tierFor } = await import("../../src/services/ai/tier-serializer"));
  ({ entitlementController } = await import("../../src/controllers/entitlement.controller"));
});

beforeEach(() => {
  resetStore();
  // Fresh fakes each test: some tests swap one for a failing collection.
  firebase.collections.entitlements = fakeCollection("entitlements");
  firebase.collections.subscriptions = fakeCollection("subscriptions");
  firebase.collections.plans = fakeCollection("plans");
  // The default-plan memo is per instance: start every test without it.
  entitlementService.clearDefaultPlanMemo();
  // The follower refresh writes in a transaction: run it in memory.
  entitlementService.runTransaction = fakeRunTransaction;
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  console.error = () => {};
});

afterEach(() => {
  console.error = realConsoleError;
});

/** Put the fixture plans in the fake `plans` collection. */
function seedPlans(...plans: Record<string, unknown>[]): void {
  for (const plan of plans) store.set(`plans/${plan.id}`, { ...plan });
}

/** A minimal response that records the status and body it was sent. */
function fakeRes(): { res: any; sent: { status?: number; body?: any } } {
  const sent: { status?: number; body?: any } = {};
  const res: any = {
    status(code: number) {
      sent.status = code;
      return res;
    },
    json(body: unknown) {
      sent.body = body;
      return res;
    },
  };
  return { res, sent };
}

/**
 * Run the real `verifyAuth` for `token` and return the request as the next
 * handler would see it. Fails the test if the middleware answered itself.
 */
async function signIn(token: string, method = "GET"): Promise<AuthenticatedRequest> {
  const req = {
    headers: { authorization: `Bearer ${token}` },
    method,
    originalUrl: "/anything",
  } as unknown as AuthenticatedRequest;
  const { res, sent } = fakeRes();
  let nextCalled = false;
  await verifyAuth(req, res, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true, `verifyAuth did not call next(): ${JSON.stringify(sent)}`);
  return req;
}

/** Writes made to the `entitlements` collection so far. */
function entitlementWrites(): typeof writes {
  return writes.filter((w) => w.path.startsWith("entitlements/"));
}

/** Run a `requireFeature` guard; returns the status it answered, or "next". */
function gate(req: AuthenticatedRequest, feature: Parameters<typeof requireFeature>[0]): number | "next" {
  const { res, sent } = fakeRes();
  let passed = false;
  requireFeature(feature)(req, res, () => {
    passed = true;
  });
  return passed ? "next" : (sent.status as number);
}

// ============================================
// A client with no record
// ============================================

describe("client with no entitlements record", () => {
  test("the first request resolves the default client plan and writes it once", async () => {
    seedPlans(FREE_PLAN, PAID_PLAN);

    const req = await signIn("tok-client");

    // The request itself carries the resolved plan.
    assert.equal(req.entitlements?.planId, FREE_PLAN.id);
    assert.equal(req.entitlements?.status, "active");
    assert.equal(req.entitlements?.subscriberType, "client");
    assert.equal(req.entitlements?.subscriberId, "uid-client");
    assert.deepEqual(req.entitlements?.features, FREE_PLAN.features);
    // The saved record is stamped as a follower of the default plan, so later
    // edits to that plan reach it (see "the default plan changes" below).
    assert.equal(store.get("entitlements/uid-client")?.resolvedFrom, "default_plan");
    // One write, to the client's own record, and no subscription record.
    assert.equal(entitlementWrites().length, 1);
    assert.equal(entitlementWrites()[0].path, "entitlements/uid-client");
    assert.equal(store.get("entitlements/uid-client")?.planId, FREE_PLAN.id);
    assert.equal(store.has("subscriptions/uid-client"), false);
  });

  test("later requests read the stored record and write nothing more", async () => {
    seedPlans(FREE_PLAN);
    await signIn("tok-client");
    assert.equal(entitlementWrites().length, 1);

    // The lazy path must not even be entered again: make it fail loudly.
    const original = entitlementService.resolveMissingEntitlements;
    entitlementService.resolveMissingEntitlements = async () => {
      throw new Error("the lazy path ran for a client who has a record");
    };
    try {
      const second = await signIn("tok-client");
      const third = await signIn("tok-client", "POST");
      assert.equal(second.entitlements?.planId, FREE_PLAN.id);
      assert.equal(third.entitlements?.planId, FREE_PLAN.id);
      assert.equal(entitlementWrites().length, 1, "the record is not rewritten");
    } finally {
      entitlementService.resolveMissingEntitlements = original;
    }
  });

  test("a brand-new account (token with no role claim yet) is treated the same", async () => {
    seedPlans(FREE_PLAN);

    const req = await signIn("tok-new");

    assert.equal(req.authz?.role, ROLES.CLIENT);
    assert.equal(req.entitlements?.planId, FREE_PLAN.id);
    assert.equal(store.get("entitlements/uid-new")?.planId, FREE_PLAN.id);
  });

  test("the CASL ability is built with the resolved entitlements", async () => {
    // The ability factory only grants a plan-gated action when the plan has
    // the feature, so an ability built WITHOUT entitlements (role only) and
    // one built WITH the free plan differ on a feature the plan lacks.
    seedPlans(FREE_PLAN);
    const { defineAbilitiesFor } = await import("@durin-tech/authz");
    const { packRules } = await import("@casl/ability/extra");

    const req = await signIn("tok-client");

    const expected = defineAbilitiesFor(
      { uid: "uid-client", role: ROLES.CLIENT, agencyId: null },
      req.entitlements
    );
    assert.deepEqual(packRules(req.ability!.rules as any), packRules(expected.rules as any));
  });

  test("a subscription that exists is honoured (its plan, not the default)", async () => {
    // Not a normal state (a plan change always writes the record too), but if
    // the record is missing the lazy path must not hand out the free plan.
    seedPlans(FREE_PLAN, PAID_PLAN);
    store.set("subscriptions/uid-client", {
      id: "uid-client", subscriberType: "client", subscriberId: "uid-client",
      planId: PAID_PLAN.id, status: "active",
    });

    const req = await signIn("tok-client");

    assert.equal(req.entitlements?.planId, PAID_PLAN.id);
  });
});

// ============================================
// A client who already has a record
// ============================================

describe("client with a stored record", () => {
  test("is served from it: no write, no plan read", async () => {
    seedPlans(FREE_PLAN, PAID_PLAN);
    const stored: Entitlements = {
      subscriberType: "client",
      subscriberId: "uid-client",
      planId: PAID_PLAN.id,
      status: "active",
      features: [FEATURES.AI_CASE_OFFICER],
      limits: {},
    };
    store.set("entitlements/uid-client", { ...stored });
    // Any plan or subscription read would be the extra cost this guards against.
    const failing = () => {
      throw new Error("a client with a record must cost exactly one read");
    };
    firebase.collections.plans = { doc: failing, where: failing };
    firebase.collections.subscriptions = { doc: failing };

    const req = await signIn("tok-client");

    assert.equal(req.entitlements?.planId, PAID_PLAN.id);
    assert.equal(entitlementWrites().length, 0);
  });

  test("a lapsed record stays lapsed (it is not replaced by the free plan)", async () => {
    seedPlans(FREE_PLAN);
    store.set("entitlements/uid-client", {
      subscriberType: "client", subscriberId: "uid-client", planId: PAID_PLAN.id,
      status: "past_due", features: [FEATURES.MESSAGING], limits: {},
    });

    const req = await signIn("tok-client");

    assert.equal(req.entitlements?.status, "past_due");
    assert.equal(req.entitlements?.planId, PAID_PLAN.id);
    assert.equal(entitlementWrites().length, 0);
  });
});

// ============================================
// Fail-safe: behaviour stays as before #311
// ============================================

describe("failures leave entitlements unresolved", () => {
  test("the entitlements lookup throws: null, and no attempt to write a default", async () => {
    seedPlans(FREE_PLAN);
    let lazyCalls = 0;
    const original = entitlementService.resolveMissingEntitlements;
    entitlementService.resolveMissingEntitlements = async (...args: unknown[]) => {
      lazyCalls++;
      return original.apply(entitlementService, args);
    };
    firebase.collections.entitlements = {
      doc: () => ({
        get: async () => {
          throw new Error("firestore unavailable");
        },
      }),
    };
    try {
      const req = await signIn("tok-client");

      assert.equal(req.entitlements, null);
      assert.equal(req.authz?.role, ROLES.CLIENT);
      // A failed read is NOT "no record": the default plan must not be
      // written over a record that may well exist.
      assert.equal(lazyCalls, 0);
      assert.equal(writes.length, 0);
    } finally {
      entitlementService.resolveMissingEntitlements = original;
    }
  });

  test("the default-plan read throws: null, nothing written, request still served", async () => {
    firebase.collections.plans = {
      doc: () => ({ get: async () => ({ exists: false }) }),
      where: () => {
        throw new Error("firestore unavailable");
      },
    };

    const req = await signIn("tok-client");

    assert.equal(req.entitlements, null);
    assert.equal(req.authz?.role, ROLES.CLIENT);
    assert.ok(req.ability, "the role-only ability is still built");
    assert.equal(writes.length, 0);
    // A failure is not remembered as "no default plan".
    assert.deepEqual(entitlementService.defaultPlanMemo, {});
  });

  test("the write throws: null for this request (retried on the next one)", async () => {
    seedPlans(FREE_PLAN);
    firebase.collections.entitlements = {
      doc: () => ({
        get: async () => ({ exists: false }),
        create: async () => {
          throw new Error("firestore unavailable");
        },
      }),
    };

    const req = await signIn("tok-client");

    assert.equal(req.entitlements, null);
  });

  test("no default client plan: null, nothing written, nothing thrown", async () => {
    // Only a non-default plan exists.
    seedPlans(PAID_PLAN);

    const req = await signIn("tok-client");

    assert.equal(req.entitlements, null);
    assert.equal(writes.length, 0);
    assert.equal(store.has("entitlements/uid-client"), false);
  });

  test("no default plan is remembered briefly, so the plans query is not repeated per request", async () => {
    seedPlans(PAID_PLAN);
    let planQueries = 0;
    const plans = fakeCollection("plans");
    firebase.collections.plans = {
      doc: (id: string) => plans.doc(id),
      where: (...args: [string, string, unknown]) => {
        planQueries++;
        return plans.where(...args);
      },
    };

    await signIn("tok-client");
    await signIn("tok-client");
    await signIn("tok-client");

    assert.equal(planQueries, 1);

    // Once the memo has run out, a default plan seeded meanwhile is picked up.
    seedPlans(FREE_PLAN);
    entitlementService.defaultPlanMemo = { client: { plan: null, until: Date.now() - 1 } };
    const req = await signIn("tok-client");
    assert.equal(req.entitlements?.planId, FREE_PLAN.id);
    assert.equal(entitlementService.defaultPlanMemo.client.plan.id, FREE_PLAN.id);
  });

  test("with entitlements unresolved the gates behave as before (ungated; AI tier free)", async () => {
    seedPlans(PAID_PLAN); // no default plan
    const req = await signIn("tok-client");

    assert.equal(gate(req, FEATURES.MESSAGING), "next");
    assert.equal(checkWithinLimit(req, LIMITS.MAX_ACTIVE_APPLICATIONS, 99), true);
    assert.equal(tierFor(req.authz?.role, req.entitlements), "free");
  });
});

// ============================================
// Other roles: untouched
// ============================================

describe("admins, owners and agents are not given a default plan", () => {
  beforeEach(() => {
    // Default plans exist for EVERY audience: if the lazy path ran for one of
    // these roles it would find a plan and write a record.
    seedPlans(FREE_PLAN, AGENT_DEFAULT_PLAN, AGENCY_DEFAULT_PLAN);
  });

  test("admin: no entitlements, no read of the cache, no write", async () => {
    firebase.collections.entitlements = {
      doc: () => {
        throw new Error("an admin has no subscriber: the cache must not be read");
      },
    };

    const req = await signIn("tok-admin");

    assert.equal(req.authz?.role, ROLES.ADMIN);
    assert.equal(req.entitlements, null);
    assert.equal(writes.length, 0);
    assert.equal(gate(req, FEATURES.AI_CASE_OFFICER), "next");
  });

  for (const [label, token, recordId] of [
    ["owner (agency subscriber)", "tok-owner", "agency-1"],
    ["agent in an agency", "tok-agent", "agency-1"],
    ["independent agent", "tok-solo-agent", "uid-solo"],
  ] as const) {
    test(`${label} with no record: still unresolved, nothing written`, async () => {
      const req = await signIn(token);

      assert.equal(req.entitlements, null);
      assert.equal(writes.length, 0);
      assert.equal(store.has(`entitlements/${recordId}`), false);
      // Ungated, exactly as before this change (their turn is issue #315).
      assert.equal(gate(req, FEATURES.PAYMENTS_REQUEST), "next");
    });

    test(`${label} with a record of their own: served from it`, async () => {
      const type = recordId === "agency-1" ? "agency" : "agent";
      store.set(`entitlements/${recordId}`, {
        subscriberType: type, subscriberId: recordId, planId: "some_plan",
        status: "active", features: [FEATURES.MESSAGING], limits: {},
      });

      const req = await signIn(token);

      assert.equal(req.entitlements?.planId, "some_plan");
      assert.equal(entitlementWrites().length, 0);
      assert.equal(gate(req, FEATURES.PAYMENTS_REQUEST), 402);
    });
  }

  test("a client record left under an independent agent's uid does not gate the agent", async () => {
    // The user was a client on their first requests (the record below is what
    // this change writes), then finished agent onboarding. Client and
    // independent agent share the uid as record id; the agent must stay
    // ungated, as an agent with no record was before this change.
    const asClient = { ...TOKENS["tok-solo-agent"], role: ROLES.CLIENT };
    TOKENS["tok-solo-as-client"] = asClient;
    const first = await signIn("tok-solo-as-client");
    assert.equal(first.entitlements?.planId, FREE_PLAN.id);
    assert.equal(store.get("entitlements/uid-solo")?.subscriberType, "client");

    const req = await signIn("tok-solo-agent");

    assert.equal(req.authz?.role, ROLES.AGENT);
    assert.equal(req.entitlements, null);
    assert.equal(gate(req, FEATURES.PAYMENTS_REQUEST), "next");
    // The client record is left alone (no write, no delete).
    assert.equal(entitlementWrites().length, 1);
  });

  // ---- QA round 1: a client record somebody CHOSE keeps applying ----
  //
  // An assigned or bought client plan always has `subscriptions/{uid}` (the
  // real `assignPlan` is used below, so that claim is exercised, not assumed).
  // Such a record gated the agent before #311 and must keep doing so.

  test("independent agent with an ASSIGNED client plan lacking messaging is still gated (402)", async () => {
    await entitlementService.assignPlan("client", "uid-solo", FREE_PLAN.id);
    assert.equal(store.has("subscriptions/uid-solo"), true, "assignment writes a subscription document");

    const req = await signIn("tok-solo-agent");

    assert.equal(req.entitlements?.planId, FREE_PLAN.id);
    assert.equal(gate(req, FEATURES.MESSAGING), 402);
    assert.equal(tierFor(req.authz?.role, req.entitlements), "free");
  });

  test("independent agent on a paid client plan keeps the full AI tier, in step with the AI-access check", async () => {
    seedPlans(PAID_PLAN);
    await entitlementService.assignPlan("client", "uid-solo", PAID_PLAN.id);
    const { aiMessageAccessService }: any = await import("../../src/services/ai-message-access.service");

    const req = await signIn("tok-solo-agent");

    assert.equal(req.entitlements?.planId, PAID_PLAN.id);
    assert.equal(tierFor(req.authz?.role, req.entitlements), "full");
    // `GET /users/me/ai-message-access` answers `hasAiPlan` from this check,
    // which reads the stored record directly: the two must agree.
    assert.equal(await aiMessageAccessService.subjectHasAiPlan(req.authz), true);
  });

  test("the lazy leftover and the AI-access check agree too (no AI plan either way)", async () => {
    TOKENS["tok-solo-as-client"] = { ...TOKENS["tok-solo-agent"], role: ROLES.CLIENT };
    await signIn("tok-solo-as-client");
    assert.equal(store.has("subscriptions/uid-solo"), false, "the lazy path writes no subscription");
    const { aiMessageAccessService }: any = await import("../../src/services/ai-message-access.service");

    const req = await signIn("tok-solo-agent");

    assert.equal(req.entitlements, null);
    assert.equal(tierFor(req.authz?.role, req.entitlements), "free");
    assert.equal(await aiMessageAccessService.subjectHasAiPlan(req.authz), false);
  });

  test("if the subscription cannot be read, the client record is honoured (no gate is dropped)", async () => {
    store.set("entitlements/uid-solo", {
      subscriberType: "client", subscriberId: "uid-solo", planId: FREE_PLAN.id,
      status: "active", features: FREE_PLAN.features, limits: FREE_PLAN.limits,
    });
    firebase.collections.subscriptions = {
      doc: () => ({
        get: async () => {
          throw new Error("firestore unavailable");
        },
      }),
    };

    const req = await signIn("tok-solo-agent");

    assert.equal(req.entitlements?.planId, FREE_PLAN.id);
    assert.equal(gate(req, FEATURES.MESSAGING), 402);
  });

  test("the subscription is read only for an agent carrying a client record", async () => {
    // Everyone else must not pay for the check: any subscription read fails.
    const failing = () => {
      throw new Error("no subscription read is needed here");
    };
    store.set("entitlements/uid-solo", {
      subscriberType: "agent", subscriberId: "uid-solo", planId: "agent_plan",
      status: "active", features: [], limits: {},
    });
    store.set("entitlements/uid-client", {
      subscriberType: "client", subscriberId: "uid-client", planId: FREE_PLAN.id,
      status: "active", features: [], limits: {},
    });
    store.set("entitlements/agency-1", {
      subscriberType: "agency", subscriberId: "agency-1", planId: "agency_plan",
      status: "active", features: [], limits: {},
    });
    firebase.collections.subscriptions = { doc: failing };

    assert.equal((await signIn("tok-solo-agent")).entitlements?.planId, "agent_plan");
    assert.equal((await signIn("tok-client")).entitlements?.planId, FREE_PLAN.id);
    assert.equal((await signIn("tok-owner")).entitlements?.planId, "agency_plan");
  });
});

// ============================================
// The default plan changes after the record was saved (review round 2)
// ============================================
//
// A lazily saved record has no subscription, so a plan edit's recompute (which
// goes through `subscriptions`) never finds it. It must still follow the
// default client plan: an edit to that plan, or another plan becoming the
// default, reaches it on the client's next request.

describe("a saved default-plan record follows the default plan", () => {
  /** A default client plan as it stands before the admin edits anything: no limit. */
  const UNLIMITED = { ...FREE_PLAN, limits: { [LIMITS.MAX_ACTIVE_APPLICATIONS]: -1 } };

  /**
   * Change a plan the way ANY writer would (admin endpoint, seed, console):
   * just the document. `seenByInstance` = this instance's memo has expired or
   * was cleared (what the admin endpoint does on the instance it runs on).
   */
  function editPlan(plan: Record<string, unknown>, seenByInstance = true): void {
    store.set(`plans/${plan.id}`, { ...plan });
    if (seenByInstance) entitlementService.clearDefaultPlanMemo();
  }

  test("limits edited: the reviewer's scenario (unlimited, then max 1) binds on the next request", async () => {
    seedPlans(UNLIMITED);
    const before = await signIn("tok-client");
    assert.equal(checkWithinLimit(before, LIMITS.MAX_ACTIVE_APPLICATIONS, 5), true);

    editPlan({ ...UNLIMITED, limits: { [LIMITS.MAX_ACTIVE_APPLICATIONS]: 1 } });
    const after = await signIn("tok-client");

    assert.equal(checkWithinLimit(after, LIMITS.MAX_ACTIVE_APPLICATIONS, 1), false, "a second application is refused");
    assert.equal((store.get("entitlements/uid-client")?.limits as any)[LIMITS.MAX_ACTIVE_APPLICATIONS], 1);
    assert.equal(store.get("entitlements/uid-client")?.resolvedFrom, "default_plan", "still a follower");
    assert.equal(store.has("subscriptions/uid-client"), false);
    // Refreshed once: the next request compares equal and writes nothing.
    assert.equal(entitlementWrites().length, 2);
    await signIn("tok-client");
    await signIn("tok-client", "POST");
    assert.equal(entitlementWrites().length, 2);
  });

  test("a feature added to the plan unlocks it; a feature removed locks it", async () => {
    seedPlans(FREE_PLAN);
    const before = await signIn("tok-client");
    assert.equal(gate(before, FEATURES.MESSAGING), 402);
    assert.equal(gate(before, FEATURES.DOCUMENTS_UPLOAD), "next");

    editPlan({ ...FREE_PLAN, features: [FEATURES.APPLICATIONS_CREATE, FEATURES.MESSAGING] });
    const after = await signIn("tok-client");

    assert.equal(gate(after, FEATURES.MESSAGING), "next", "added feature");
    assert.equal(gate(after, FEATURES.DOCUMENTS_UPLOAD), 402, "removed feature");
    assert.equal(gate(after, FEATURES.APPLICATIONS_CREATE), "next", "kept feature");
  });

  test("isDefault moves to another plan: the client moves with it", async () => {
    seedPlans(FREE_PLAN);
    assert.equal((await signIn("tok-client")).entitlements?.planId, FREE_PLAN.id);

    const NEW_DEFAULT = {
      ...FREE_PLAN, id: "test_client_free_v2", features: [FEATURES.MESSAGING],
      limits: { [LIMITS.MAX_ACTIVE_APPLICATIONS]: 3 },
    };
    editPlan({ ...FREE_PLAN, isDefault: false });
    editPlan(NEW_DEFAULT);
    const after = await signIn("tok-client");

    assert.equal(after.entitlements?.planId, NEW_DEFAULT.id);
    assert.equal(gate(after, FEATURES.MESSAGING), "next");
    assert.equal(gate(after, FEATURES.APPLICATIONS_CREATE), 402);
    assert.equal(store.get("entitlements/uid-client")?.planId, NEW_DEFAULT.id);
    assert.equal(store.get("entitlements/uid-client")?.resolvedFrom, "default_plan");
  });

  test("the edit is seen when the instance's memo runs out, with no plans query before that", async () => {
    seedPlans(UNLIMITED);
    await signIn("tok-client");
    let planQueries = 0;
    const plans = fakeCollection("plans");
    firebase.collections.plans = {
      doc: (id: string) => plans.doc(id),
      where: (...args: [string, string, unknown]) => {
        planQueries++;
        return plans.where(...args);
      },
    };

    // Edited by another instance / the seed: this instance's memo is still warm.
    editPlan({ ...UNLIMITED, limits: { [LIMITS.MAX_ACTIVE_APPLICATIONS]: 1 } }, false);
    const stale = await signIn("tok-client");
    await signIn("tok-client");
    assert.equal(checkWithinLimit(stale, LIMITS.MAX_ACTIVE_APPLICATIONS, 1), true, "old plan until the memo expires");
    assert.equal(planQueries, 0, "a request with a warm memo reads no plan");

    // The memo expires (at most DEFAULT_PLAN_MEMO_TTL_MS after it was filled).
    entitlementService.defaultPlanMemo.client.until = Date.now() - 1;
    const fresh = await signIn("tok-client");
    await signIn("tok-client");
    assert.equal(checkWithinLimit(fresh, LIMITS.MAX_ACTIVE_APPLICATIONS, 1), false);
    assert.equal(planQueries, 1, "one plans query per memo window, not per request");
  });

  test("requests arriving together on an expired memo share one plans query", async () => {
    seedPlans(FREE_PLAN);
    await signIn("tok-client");
    let planQueries = 0;
    const plans = fakeCollection("plans");
    firebase.collections.plans = {
      doc: (id: string) => plans.doc(id),
      where: (...args: [string, string, unknown]) => {
        planQueries++;
        return plans.where(...args);
      },
    };
    entitlementService.clearDefaultPlanMemo();

    await Promise.all([signIn("tok-client"), signIn("tok-client"), signIn("tok-client")]);

    assert.equal(planQueries, 1);
  });

  test("a paid record is untouched by an edit to the free plan (no plan read, no write)", async () => {
    seedPlans(FREE_PLAN, PAID_PLAN);
    await entitlementService.assignPlan("client", "uid-client", PAID_PLAN.id);
    const paidRecord = { ...store.get("entitlements/uid-client") };
    const writesBefore = entitlementWrites().length;
    editPlan({ ...FREE_PLAN, features: [], limits: { [LIMITS.MAX_ACTIVE_APPLICATIONS]: 0 } });
    // An assigned record must not even look at the default plan.
    const failing = () => {
      throw new Error("an assigned record follows its own plan, not the default");
    };
    firebase.collections.plans = { doc: failing, where: failing };

    const req = await signIn("tok-client");

    assert.equal(req.entitlements?.planId, PAID_PLAN.id);
    assert.equal(tierFor(req.authz?.role, req.entitlements), "full");
    assert.deepEqual(store.get("entitlements/uid-client"), paidRecord);
    assert.equal(entitlementWrites().length, writesBefore);
  });

  test("a client ASSIGNED the default plan (has a subscription) is not a follower: untouched here", async () => {
    // Test user E on dev. Their record changes through the plan edit's own
    // recompute over `subscriptions`, exactly as before this issue.
    seedPlans(FREE_PLAN);
    await entitlementService.assignPlan("client", "uid-client", FREE_PLAN.id);
    assert.equal(store.get("entitlements/uid-client")?.resolvedFrom, undefined);
    const writesBefore = entitlementWrites().length;
    editPlan({ ...FREE_PLAN, features: [FEATURES.MESSAGING] });

    const req = await signIn("tok-client");

    assert.deepEqual(req.entitlements?.features, FREE_PLAN.features, "not refreshed by the request path");
    assert.equal(entitlementWrites().length, writesBefore);
  });

  test("a follower who then gets a plan assigned stops following the default", async () => {
    seedPlans(FREE_PLAN, PAID_PLAN);
    await signIn("tok-client");
    await entitlementService.assignPlan("client", "uid-client", PAID_PLAN.id);
    assert.equal(store.get("entitlements/uid-client")?.resolvedFrom, undefined, "assignment replaces the whole record");

    editPlan({ ...FREE_PLAN, features: [] });
    const req = await signIn("tok-client");

    assert.equal(req.entitlements?.planId, PAID_PLAN.id);
  });

  test("a stamped record that has a subscription after all resolves to the subscription's plan and loses the stamp", async () => {
    // The subscription seed script merges into an existing record, which keeps
    // the stamp. The refresh resolves through the subscription first, so the
    // subscriber still ends up on their own plan.
    seedPlans(FREE_PLAN, PAID_PLAN);
    await signIn("tok-client");
    store.set("subscriptions/uid-client", {
      id: "uid-client", subscriberType: "client", subscriberId: "uid-client",
      planId: PAID_PLAN.id, status: "active",
    });
    store.set("entitlements/uid-client", {
      ...store.get("entitlements/uid-client"), planId: PAID_PLAN.id,
      features: PAID_PLAN.features, limits: PAID_PLAN.limits,
    });

    const req = await signIn("tok-client");

    assert.equal(req.entitlements?.planId, PAID_PLAN.id);
    assert.equal(store.get("entitlements/uid-client")?.planId, PAID_PLAN.id);
    assert.equal(store.get("entitlements/uid-client")?.resolvedFrom, undefined);
  });

  test("a paid record written while the refresh is under way is kept (the write re-checks the stamp)", async () => {
    seedPlans(UNLIMITED, PAID_PLAN);
    await signIn("tok-client");
    editPlan({ ...UNLIMITED, limits: { [LIMITS.MAX_ACTIVE_APPLICATIONS]: 1 } });
    // The refresh reads "no subscription"; before its transaction, a plan
    // change (assignment / billing webhook) replaces the record.
    const subscriptions = fakeCollection("subscriptions");
    firebase.collections.subscriptions = {
      doc: (id: string) => {
        const ref = subscriptions.doc(id);
        return {
          ...ref,
          get: async () => {
            const snap = await ref.get();
            store.set("entitlements/uid-client", {
              subscriberType: "client", subscriberId: "uid-client", planId: PAID_PLAN.id,
              status: "active", features: PAID_PLAN.features, limits: PAID_PLAN.limits,
            });
            return snap;
          },
        };
      },
    };

    const req = await signIn("tok-client");

    assert.equal(store.get("entitlements/uid-client")?.planId, PAID_PLAN.id, "the paid record is not overwritten");
    assert.equal(req.entitlements?.planId, PAID_PLAN.id);
  });

  test("the default plan is removed altogether: the saved record is kept, nothing is un-gated", async () => {
    seedPlans(FREE_PLAN);
    await signIn("tok-client");
    editPlan({ ...FREE_PLAN, isDefault: false });

    const req = await signIn("tok-client");

    assert.equal(req.entitlements?.planId, FREE_PLAN.id);
    assert.equal(gate(req, FEATURES.MESSAGING), 402);
    assert.equal(entitlementWrites().length, 1);
  });

  test("the plan read fails: the stored record is used as it is", async () => {
    seedPlans(FREE_PLAN);
    await signIn("tok-client");
    entitlementService.clearDefaultPlanMemo();
    firebase.collections.plans = {
      where: () => {
        throw new Error("firestore unavailable");
      },
    };

    const req = await signIn("tok-client");

    assert.equal(req.entitlements?.planId, FREE_PLAN.id);
    assert.equal(gate(req, FEATURES.MESSAGING), 402);
    assert.equal(entitlementWrites().length, 1);
  });

  test("the refresh write fails: the stored record is used, and the next request tries again", async () => {
    seedPlans(UNLIMITED);
    await signIn("tok-client");
    editPlan({ ...UNLIMITED, limits: { [LIMITS.MAX_ACTIVE_APPLICATIONS]: 1 } });
    entitlementService.runTransaction = async () => {
      throw new Error("firestore unavailable");
    };

    const failed = await signIn("tok-client");
    assert.equal(checkWithinLimit(failed, LIMITS.MAX_ACTIVE_APPLICATIONS, 1), true, "still the stored (old) record");

    entitlementService.runTransaction = fakeRunTransaction;
    const retried = await signIn("tok-client");
    assert.equal(checkWithinLimit(retried, LIMITS.MAX_ACTIVE_APPLICATIONS, 1), false);
  });

  test("the leftover record under an independent agent is still ignored, and never refreshed", async () => {
    seedPlans(FREE_PLAN);
    TOKENS["tok-solo-as-client"] = { ...TOKENS["tok-solo-agent"], role: ROLES.CLIENT };
    await signIn("tok-solo-as-client");
    editPlan({ ...FREE_PLAN, features: [] });

    const req = await signIn("tok-solo-agent");

    assert.equal(req.entitlements, null);
    assert.equal(gate(req, FEATURES.PAYMENTS_REQUEST), "next");
    assert.equal(entitlementWrites().length, 1, "the agent's request does not rewrite the client record");
    assert.deepEqual(store.get("entitlements/uid-solo")?.features, FREE_PLAN.features);
  });
});

// ============================================
// Concurrency
// ============================================

describe("two first requests at once", () => {
  test("both succeed, both carry the plan, one document is written", async () => {
    seedPlans(FREE_PLAN);

    const [a, b] = await Promise.all([signIn("tok-client"), signIn("tok-client", "POST")]);

    assert.equal(a.entitlements?.planId, FREE_PLAN.id);
    assert.equal(b.entitlements?.planId, FREE_PLAN.id);
    assert.deepEqual(a.entitlements?.features, b.entitlements?.features);
    // create() lets exactly one writer through.
    assert.equal(entitlementWrites().length, 1);
    assert.equal(store.get("entitlements/uid-client")?.planId, FREE_PLAN.id);
  });

  test("a paid record written while the default is being resolved is kept, and returned", async () => {
    // The race the create-only write exists for: this request has read "no
    // record" and "no subscription"; before it writes, a plan change (admin
    // assignment / billing webhook) saves the paid record. A plain set() would
    // put the free plan back over it.
    seedPlans(FREE_PLAN, PAID_PLAN);
    const subscriptions = fakeCollection("subscriptions");
    firebase.collections.subscriptions = {
      doc: (id: string) => {
        const ref = subscriptions.doc(id);
        return {
          ...ref,
          get: async () => {
            const snap = await ref.get(); // "no subscription", as read by the lazy path
            // Lands after that read and before the lazy path's write.
            store.set("entitlements/uid-client", {
              subscriberType: "client", subscriberId: "uid-client", planId: PAID_PLAN.id,
              status: "active", features: PAID_PLAN.features, limits: PAID_PLAN.limits,
            });
            return snap;
          },
        };
      },
    };

    const req = await signIn("tok-client");

    assert.equal(store.get("entitlements/uid-client")?.planId, PAID_PLAN.id, "the paid record is not overwritten");
    assert.equal(req.entitlements?.planId, PAID_PLAN.id, "the request uses the stored record");
    assert.equal(entitlementWrites().length, 0);
  });
});

// ============================================
// The gates now apply to such a client
// ============================================

describe("gates for a client resolved to the default plan", () => {
  let req: AuthenticatedRequest;

  beforeEach(async () => {
    seedPlans(FREE_PLAN, PAID_PLAN);
    req = await signIn("tok-client", "POST");
  });

  test("requireFeature: 402 for a feature the plan lacks, through for one it has", () => {
    assert.equal(gate(req, FEATURES.MESSAGING), 402);
    assert.equal(gate(req, FEATURES.APPLICATIONS_CREATE), "next");
  });

  test("checkWithinLimit: max_active_applications of 1 refuses the second", () => {
    assert.equal(checkWithinLimit(req, LIMITS.MAX_ACTIVE_APPLICATIONS, 0), true);
    assert.equal(checkWithinLimit(req, LIMITS.MAX_ACTIVE_APPLICATIONS, 1), false);
  });

  test("paid AI stays paid: the tier is free and the case-officer feature is locked", () => {
    assert.equal(tierFor(req.authz?.role, req.entitlements), "free");
    assert.equal(gate(req, FEATURES.AI_CASE_OFFICER), 402);
    assert.equal(req.entitlements?.features.includes(FEATURES.AI_CASE_OFFICER), false);
  });

  test("the free plan is active, so writes are not blocked as read-only", async () => {
    // signIn() asserts next() was called for this POST.
    assert.equal(req.entitlements?.status, "active");
  });
});

// ============================================
// GET /subscriptions/me
// ============================================

describe("GET /subscriptions/me", () => {
  /** Call the real handler with a request `verifyAuth` has prepared. */
  async function mySubscription(token: string): Promise<any> {
    const req = await signIn(token);
    const { res, sent } = fakeRes();
    await entitlementController.getMySubscription(req, res);
    assert.equal(sent.status ?? 200, 200, JSON.stringify(sent.body));
    return sent.body.data;
  }

  test("client with no record: the default plan, with no subscription record", async () => {
    seedPlans(FREE_PLAN);

    const data = await mySubscription("tok-client");

    assert.equal(data.subscriberType, "client");
    assert.equal(data.subscription, null);
    assert.equal(data.entitlements.planId, FREE_PLAN.id);
    assert.equal(data.entitlements.status, "active");
  });

  test("client with a paid record and subscription: both returned unchanged", async () => {
    seedPlans(FREE_PLAN, PAID_PLAN);
    store.set("subscriptions/uid-client", { id: "uid-client", planId: PAID_PLAN.id, status: "active" });
    store.set("entitlements/uid-client", {
      subscriberType: "client", subscriberId: "uid-client", planId: PAID_PLAN.id,
      status: "active", features: PAID_PLAN.features, limits: PAID_PLAN.limits,
    });

    const data = await mySubscription("tok-client");

    assert.equal(data.subscription.planId, PAID_PLAN.id);
    assert.equal(data.entitlements.planId, PAID_PLAN.id);
    assert.equal(entitlementWrites().length, 0);
  });

  test("no default plan: entitlements null, as before", async () => {
    const data = await mySubscription("tok-client");

    assert.equal(data.entitlements, null);
    assert.equal(data.subscription, null);
  });

  test("agent with no record: entitlements null, as before", async () => {
    seedPlans(FREE_PLAN, AGENT_DEFAULT_PLAN, AGENCY_DEFAULT_PLAN);

    const data = await mySubscription("tok-agent");

    assert.equal(data.subscriberType, "agency");
    assert.equal(data.entitlements, null);
    assert.equal(writes.length, 0);
  });

  test("admin: unlimited, no subscriber", async () => {
    const data = await mySubscription("tok-admin");

    assert.deepEqual(data, { subscription: null, entitlements: null, unlimited: true });
  });
});
