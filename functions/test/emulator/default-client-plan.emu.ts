// ============================================
// Emulator tests: a client with no plan record is on the default client plan
// from their first signed-in request (issue #311)
// ============================================
//
// Run with `npm run test:emulator` (Auth + Firestore emulators, real Express
// app, real ID tokens, real Firestore writes and transactions).
//
// What is pinned end to end, over HTTP:
//  - a brand-new sign-up, and an existing client with no record, get the
//    default client plan on their next request, with no script or migration;
//    `GET /subscriptions/me` and `GET /users/me/authorization` both show it;
//  - AI chat answers 402 UPGRADE_REQUIRED for such a client, not
//    403 ENTITLEMENTS_UNAVAILABLE; the readiness review is the free tier;
//  - plan limits and feature gates apply, proved with a TEST plan that has a
//    real limit (`max_active_applications: 1`) and lacks messaging;
//  - a client who already has a record is not rewritten;
//  - several first requests at once (a real race against Firestore) all
//    succeed and leave one correct document;
//  - with no default client plan nothing is written and chat still answers
//    403, as before; admins, owners and agents are untouched.
//
// The plan documents below are fixtures written to the EMULATOR only. The
// seeded `client_free` is used where the issue names it; the limit and
// feature-gate tests use a fixture, because the seeded free plan is unlimited
// and carries almost every feature.

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { FEATURES, LIMITS, ROLES } from "@durin-tech/authz";

import { refreshIdToken, resetEmulators, rulesEnv, RunningApi, signUp, startApi, TestAccount, withoutRules } from "./helpers";
import { makeAdmin, put, seedAgency, seedApplication, seedClient, seedIndependentAgent, stored } from "./agency-fixtures";
import { PLANS } from "../../src/scripts/seed-plans";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ============================================
// Fixtures
// ============================================

let api: RunningApi;

/** The seeded free client plan, exactly as `seedPlans()` would write it. */
const SEEDED_CLIENT_FREE = PLANS.find((p) => p.id === "client_free")!;

/** A default client plan with a real limit and without messaging or AI. */
const LIMITED_PLAN = {
  id: "test_client_limited",
  name: "Test Client Limited",
  audience: "client",
  priceKobo: 0,
  interval: "none",
  isDefault: true,
  features: [FEATURES.APPLICATIONS_CREATE, FEATURES.DOCUMENTS_UPLOAD],
  limits: { [LIMITS.MAX_ACTIVE_APPLICATIONS]: 1 },
};

/** Default plans for the agent-side audiences (see the "other roles" tests). */
const AGENT_DEFAULT = { ...LIMITED_PLAN, id: "test_agent_default", audience: "agent" };
const AGENCY_DEFAULT = { ...LIMITED_PLAN, id: "test_agency_default", audience: "agency" };

/** Remove every plan, then write `plans` (so exactly one client default exists). */
async function setPlans(...plans: Array<Record<string, any>>): Promise<void> {
  await withoutRules(async (db) => {
    const existing = await db.collection("plans").get();
    for (const doc of existing.docs) await doc.ref.delete();
    for (const plan of plans) await db.collection("plans").doc(plan.id).set(plan);
  });
  // The middleware remembers "no default plan" for a minute per instance; the
  // API runs in this process, so forget it whenever the plans change.
  const { entitlementService } = await import("../../src/services/entitlement.service");
  entitlementService.missingDefaultPlanUntil = {};
}

/** Give an account role claims the way the backend does, and a token with them. */
async function withClaims(account: TestAccount, claims: Record<string, unknown>): Promise<string> {
  const { auth } = await import("../../src/utils/firebase");
  await auth.setCustomUserClaims(account.uid, claims);
  return refreshIdToken(account);
}

/** The stored entitlements record for an id (undefined when there is none). */
const recordOf = (id: string): Promise<any> => stored("entitlements", id);

/** When the record was last written, as Firestore reports it (ms). */
async function recordUpdateTime(id: string): Promise<number> {
  const { collections } = await import("../../src/utils/firebase");
  return (await collections.entitlements.doc(id).get()).updateTime!.toMillis();
}

/** `GET /subscriptions/me` data, asserting 200. */
async function subscriptionOf(token: string): Promise<any> {
  const res = await api.call("GET", "/subscriptions/me", token);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.data;
}

/** `GET /users/me/authorization` data (what mobile `useAuthorization` reads). */
async function authorizationOf(token: string): Promise<any> {
  const res = await api.call("GET", "/users/me/authorization", token);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.data;
}

before(async () => {
  await rulesEnv();
  await resetEmulators();
  api = await startApi();
});

after(async () => {
  await api.close();
  await (await rulesEnv()).cleanup();
});

// ============================================
// The seeded free plan: sign-up, existing users, chat, AI tier
// ============================================

describe("default plan = the seeded client_free", () => {
  beforeEach(async () => {
    await setPlans(SEEDED_CLIENT_FREE, PLANS.find((p) => p.id === "client_pro")!);
  });

  test("brand-new sign-up: client_free right after signup, and again after onboarding", async () => {
    const user = await seedClient("new-signup");
    assert.equal(await recordOf(user.uid), undefined, "no record before the first request");

    // Right after sign-up (the token has no role claim yet).
    const first = await subscriptionOf(user.idToken);
    assert.equal(first.subscriberType, "client");
    assert.equal(first.subscription, null);
    assert.equal(first.entitlements.planId, "client_free");
    assert.equal(first.entitlements.status, "active");

    // The record now exists, and no subscription record was created.
    const record = await recordOf(user.uid);
    assert.equal(record.planId, "client_free");
    assert.equal(record.subscriberType, "client");
    assert.equal(record.subscriberId, user.uid);
    assert.equal(await stored("subscriptions", user.uid), undefined);

    // After onboarding.
    const onboarding = await api.call("POST", "/users/onboarding", user.idToken, {
      firstName: "Ada", lastName: "Obi", residentialCountry: "NG", hasPassport: true,
    });
    assert.equal(onboarding.status, 200, JSON.stringify(onboarding.body));
    const second = await subscriptionOf(user.idToken);
    assert.equal(second.entitlements.planId, "client_free");
    assert.equal(second.entitlements.status, "active");
    assert.equal(second.subscription, null);

    // The endpoint mobile reads carries the same entitlements, not null.
    const authz = await authorizationOf(user.idToken);
    assert.equal(authz.role, ROLES.CLIENT);
    assert.equal(authz.entitlements.planId, "client_free");
    assert.deepEqual(authz.entitlements.features, second.entitlements.features);
    assert.deepEqual(authz.entitlements.limits, second.entitlements.limits);
  });

  test("the free plan does not carry the AI case officer", async () => {
    const user = await seedClient("no-ai");
    const { entitlements } = await authorizationOf(user.idToken);
    assert.equal(entitlements.features.includes(FEATURES.AI_CASE_OFFICER), false);
  });

  test("existing client with no record: resolved on the next request, record written once", async () => {
    // An account from before this change: profile, role claim, a live case,
    // and no entitlements record (test users A, B and C on dev).
    const user = await seedClient("existing");
    const token = await withClaims(user, { role: ROLES.CLIENT, agencyId: null, admin: false });
    await seedApplication("app-existing", { userId: user.uid, mode: "self", status: "draft" });
    assert.equal(await recordOf(user.uid), undefined);

    const authz = await authorizationOf(token);
    assert.equal(authz.entitlements.planId, "client_free");
    const writtenAt = await recordUpdateTime(user.uid);

    // Later requests, reads and a write, do not touch the record again.
    await subscriptionOf(token);
    await authorizationOf(token);
    await api.call("PUT", "/users/me", token, { firstName: "Changed" });
    assert.equal(await recordUpdateTime(user.uid), writtenAt, "the record is not rewritten");
  });

  test("a client who already has a record (paid) is unchanged", async () => {
    const user = await seedClient("has-record");
    const paid = {
      subscriberType: "client", subscriberId: user.uid, planId: "client_pro", status: "active",
      features: [FEATURES.MESSAGING, FEATURES.AI_CASE_OFFICER], limits: { [LIMITS.MAX_ACTIVE_APPLICATIONS]: -1 },
    };
    await put("entitlements", user.uid, paid);
    const writtenAt = await recordUpdateTime(user.uid);

    const data = await subscriptionOf(user.idToken);
    await authorizationOf(user.idToken);

    assert.equal(data.entitlements.planId, "client_pro");
    assert.deepEqual(await recordOf(user.uid), paid);
    assert.equal(await recordUpdateTime(user.uid), writtenAt);
  });

  test("AI chat: 402 UPGRADE_REQUIRED with the upgrade message, not 403", async () => {
    const user = await seedClient("chat");
    await seedApplication("app-chat", { userId: user.uid, mode: "self", status: "draft" });

    // The very first request of a client with no record is the chat call.
    const res = await api.call("POST", "/ai/applications/app-chat/chat", user.idToken, { message: "Am I ready?" });

    assert.equal(res.status, 402, JSON.stringify(res.body));
    assert.equal(res.body.error, "UPGRADE_REQUIRED");
    assert.equal(res.body.message, "Chat is not included in your plan. Upgrade to use the AI case officer and chat.");

    // Same answer as a client who was put on client_free by hand (test user E).
    const byHand = await seedClient("chat-by-hand");
    await seedApplication("app-chat-hand", { userId: byHand.uid, mode: "self", status: "draft" });
    const { entitlementService } = await import("../../src/services/entitlement.service");
    await entitlementService.assignPlan("client", byHand.uid, "client_free");
    const handRes = await api.call("POST", "/ai/applications/app-chat-hand/chat", byHand.idToken, { message: "Am I ready?" });
    assert.deepEqual({ status: handRes.status, body: handRes.body }, { status: res.status, body: res.body });
  });

  test("paid AI stays paid: free-tier readiness review, proposed actions refused", async () => {
    const user = await seedClient("ai-tier");
    await seedApplication("app-tier", { userId: user.uid, mode: "self", status: "draft" });
    // A finished assessment with full findings stored on it.
    await put("applicationAssessments", "assess-tier", {
      id: "assess-tier", applicationId: "app-tier", userId: user.uid, agencyId: null,
      countryCode: "IE", visaTypeId: "visa-1", rubricVersion: 1, inputHash: "h", model: null,
      createdAt: new Date(), status: "succeeded", error: null, attempt: 1, trigger: "manual",
      requestedBy: user.uid, startedAt: new Date(), finishedAt: new Date(), stageOutcomes: {},
      score: 71, readiness: "amber", refusalGrounds: [{ id: "g1", title: "Funds", detail: "PAID DETAIL" }],
      topIssues: [
        { criterionId: "c1", title: "Funds", detail: "PAID DETAIL" },
        { criterionId: "c2", title: "Ties", detail: "PAID DETAIL" },
        { criterionId: "c3", title: "History", detail: "PAID DETAIL" },
      ],
      criteria: [{ id: "c1", finding: "PAID DETAIL" }], hasBlockingRule: false,
    });

    const review = await api.call("GET", "/ai/assessments/assess-tier", user.idToken);
    assert.equal(review.status, 200, JSON.stringify(review.body));
    assert.equal(review.body.data.meta.tier, "free");
    // The band and the top three, and nothing from the full review.
    assert.deepEqual(Object.keys(review.body.data.data).sort(), ["hasBlockingRule", "readiness", "topIssues"]);
    assert.equal(review.body.data.data.readiness, "amber");
    assert.equal(review.body.data.data.topIssues.length, 3);
    assert.equal(JSON.stringify(review.body).includes("PAID DETAIL"), false);

    const actions = await api.call("GET", "/ai/assessments/assess-tier/actions", user.idToken);
    assert.equal(actions.status, 402, JSON.stringify(actions.body));
    assert.equal(actions.body.error, "UPGRADE_REQUIRED");
  });

  test("several first requests at once all succeed and leave one correct record", async () => {
    const user = await seedClient("race");
    const token = await withClaims(user, { role: ROLES.CLIENT, agencyId: null, admin: false });

    const results = await Promise.all([
      api.call("GET", "/subscriptions/me", token),
      api.call("GET", "/users/me/authorization", token),
      api.call("GET", "/subscriptions/me", token),
      api.call("GET", "/users/me/authorization", token),
      api.call("GET", "/subscriptions/me", token),
      api.call("GET", "/users/me/authorization", token),
    ]);

    for (const res of results) {
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.entitlements.planId, "client_free");
      assert.equal(res.body.data.entitlements.status, "active");
    }
    const record = await recordOf(user.uid);
    assert.equal(record.planId, "client_free");
    assert.equal(record.subscriberId, user.uid);
    assert.deepEqual(record.features, SEEDED_CLIENT_FREE.features);
    // Written once: create() refused every writer after the first, so the
    // document was created and never updated.
    const { collections } = await import("../../src/utils/firebase");
    const snap = await collections.entitlements.doc(user.uid).get();
    assert.equal(snap.updateTime!.toMillis(), snap.createTime!.toMillis());
  });
});

// ============================================
// A default plan with real limits
// ============================================

describe("default plan with a real limit and without messaging", () => {
  beforeEach(async () => {
    await setPlans(LIMITED_PLAN);
  });

  test("limit: a client with one active application is refused a second with the 402 message", async () => {
    const user = await seedClient("limit");
    await seedApplication("app-limit-1", { userId: user.uid, mode: "self", status: "draft" });
    assert.equal(await recordOf(user.uid), undefined, "no prior record");

    const res = await api.call("POST", "/applications", user.idToken, {
      visaTypeId: "visa-other", countryCode: "IE", mode: "self", confirmNew: true,
    });

    assert.equal(res.status, 402, JSON.stringify(res.body));
    assert.equal(res.body.error, "UPGRADE_REQUIRED");
    assert.equal(res.body.message, "You've reached your plan's active application limit. Upgrade to start more.");
    assert.equal((await recordOf(user.uid)).planId, LIMITED_PLAN.id);
  });

  test("limit: a client with no active application is not stopped by it", async () => {
    const user = await seedClient("limit-zero");

    const res = await api.call("POST", "/applications", user.idToken, {
      visaTypeId: "visa-other", countryCode: "IE", mode: "self", confirmNew: true,
    });

    // Whatever the handler says about this made-up visa, it is not the plan.
    assert.notEqual(res.status, 402, JSON.stringify(res.body));
  });

  test("feature gate: a route behind requireFeature answers 402 for a feature the plan lacks", async () => {
    const user = await seedClient("feature");

    const res = await api.call("POST", "/conversations", user.idToken, { participantId: "someone" });

    assert.equal(res.status, 402, JSON.stringify(res.body));
    assert.equal(res.body.error, "UPGRADE_REQUIRED");
    assert.equal(res.body.message, `Your plan does not include "${FEATURES.MESSAGING}". Upgrade to unlock it.`);
  });
});

// ============================================
// No default client plan: as before
// ============================================

describe("no default client plan", () => {
  beforeEach(async () => {
    // A client plan exists, but none is the default.
    await setPlans({ ...LIMITED_PLAN, isDefault: false });
  });

  test("entitlements stay null, nothing is written, chat still answers 403", async () => {
    const user = await seedClient("no-default");
    await seedApplication("app-no-default", { userId: user.uid, mode: "self", status: "draft" });

    const sub = await subscriptionOf(user.idToken);
    const authz = await authorizationOf(user.idToken);
    const chat = await api.call("POST", "/ai/applications/app-no-default/chat", user.idToken, { message: "Hi" });
    // Ungated, as before: the feature gate lets the request through to the
    // handler (which then answers something other than 402).
    const gated = await api.call("POST", "/conversations", user.idToken, {});

    assert.equal(sub.entitlements, null);
    assert.equal(sub.subscription, null);
    assert.equal(authz.entitlements, null);
    assert.equal(chat.status, 403, JSON.stringify(chat.body));
    assert.equal(chat.body.error, "ENTITLEMENTS_UNAVAILABLE");
    assert.equal(gated.status, 400, JSON.stringify(gated.body));
    assert.equal(await recordOf(user.uid), undefined);
  });
});

// ============================================
// Other roles: untouched
// ============================================

describe("admins, owners and agents", () => {
  beforeEach(async () => {
    // A default plan exists for every audience, so a record WOULD be written
    // if the lazy path ran for these roles.
    await setPlans(LIMITED_PLAN, AGENT_DEFAULT, AGENCY_DEFAULT);
  });

  test("admin: unlimited, no entitlements, no record", async () => {
    const account: TestAccount = await signUp("admin");
    const token = await makeAdmin(account);

    const sub = await subscriptionOf(token);
    const authz = await authorizationOf(token);

    assert.deepEqual(sub, { subscription: null, entitlements: null, unlimited: true });
    assert.equal(authz.role, ROLES.ADMIN);
    assert.equal(authz.entitlements, null);
    assert.equal(await recordOf(account.uid), undefined);
  });

  test("owner and agency: no record written, entitlements null", async () => {
    const agency = await seedAgency("untouched");
    const token = await withClaims(agency.owner, { role: ROLES.OWNER, agencyId: agency.agencyId, admin: false });

    const sub = await subscriptionOf(token);
    const authz = await authorizationOf(token);

    assert.equal(sub.subscriberType, "agency");
    assert.equal(sub.entitlements, null);
    assert.equal(authz.role, ROLES.OWNER);
    assert.equal(authz.entitlements, null);
    assert.equal(await recordOf(agency.agencyId), undefined);
    assert.equal(await recordOf(agency.owner.uid), undefined);
  });

  test("independent agent: no record written, entitlements null", async () => {
    const agent = await seedIndependentAgent("solo");
    const token = await withClaims(agent.account, { role: ROLES.AGENT, agencyId: null, admin: false });

    const sub = await subscriptionOf(token);
    const authz = await authorizationOf(token);

    assert.equal(sub.subscriberType, "agent");
    assert.equal(sub.entitlements, null);
    assert.equal(authz.entitlements, null);
    assert.equal(await recordOf(agent.account.uid), undefined);
  });

  test("independent agent who made requests as a client first is still ungated", async () => {
    // Sign-up: the account is a client and gets the client record.
    const account = await seedClient("client-then-agent");
    assert.equal((await authorizationOf(account.idToken)).entitlements.planId, LIMITED_PLAN.id);

    // Agent onboarding completes: same uid, now an independent agent.
    await put("agents", `agent-${account.uid}`, {
      id: `agent-${account.uid}`, userId: account.uid, displayName: "Now an agent",
      verificationStatus: "verified", isAvailable: true, createdAt: new Date(), updatedAt: new Date(),
    });
    const token = await withClaims(account, { role: ROLES.AGENT, agencyId: null, admin: false });

    const authz = await authorizationOf(token);
    const sub = await subscriptionOf(token);
    // Messaging is not in the client plan; the agent must not be gated by it.
    const gated = await api.call("POST", "/conversations", token, {});

    assert.equal(authz.role, ROLES.AGENT);
    assert.equal(authz.entitlements, null);
    assert.equal(sub.entitlements, null);
    assert.equal(gated.status, 400, JSON.stringify(gated.body));
  });
});
