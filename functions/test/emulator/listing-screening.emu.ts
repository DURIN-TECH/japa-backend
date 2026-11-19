// ============================================
// Emulator test — agency listing screening, role matrix (issue #120)
// ============================================
//
// Run with `npm run test:emulator` (Auth + Firestore + Storage emulators on the
// alternate ports of ../firebase.emulator-test.json, project `demo-...`, the
// repo's real firestore.rules, the real Express app, real ID tokens).
//
// The model is a RecordedLlmProvider installed on the screening service (the
// app runs in this process): a request with no recording throws, so this test
// can never reach a live model.
//
// Seven principals (anonymous, client, agent without an agency, agent of the
// agency, owner of the agency, owner of ANOTHER agency, admin) call:
//   POST  /agency/visas/:id/submit          (submit)
//   PATCH /agency/visas/:id                 (edit of an approved visa)
//   GET   /admin/visas                      (admin list, screening fields)
//   PATCH /admin/visas/:id/review           (approve without / with acknowledgeScreening)
//   POST  /admin/visas/:id/screening/rerun  (rerun)
//   GET   /admin/risk-signals[/:id]         (risk-signal routes)
// Asserted: status codes; that nothing about screening reaches any
// non-admin body (agency, other agency, applicant, anonymous); that the
// screening doc and the signals are readable by admins only; that a client
// token is denied by firestore.rules on `listingScreenings` and `riskSignals`.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

import { clientDb, isDenied, refreshIdToken, resetEmulators, RunningApi, rulesEnv, signUp, startApi, TestAccount, withoutRules } from "./helpers";

/* eslint-disable @typescript-eslint/no-explicit-any */

const CC = "GB";
const AGENCY_A = "agency-screen-a";
const AGENCY_B = "agency-screen-b";
const VERIFIED_ID = "gb-skilled-worker-visa"; // an id from the scraper registry
const VERIFIED_URL = "https://www.gov.uk/skilled-worker-visa";

let api: RunningApi;
const tokens: Record<string, string> = {};
const accounts: Record<string, TestAccount> = {};

/** Everything a non-admin must never see in a body. */
const LEAK = /"screening"|openScreeningSignals|listingScreenings|riskSignals|languageCheck|droppedFlags|injectionSuspected|signalIds|SCREENING_OPEN/;

/** A signed-in account with claims (what the backend sets) and a user doc. */
async function principal(name: string, claims: Record<string, unknown>): Promise<void> {
  const account = await signUp(name);
  const { auth } = await import("../../src/utils/firebase");
  await auth.setCustomUserClaims(account.uid, claims);
  accounts[name] = account;
  tokens[name] = await refreshIdToken(account);
  await withoutRules(async (db) => {
    await db.collection("users").doc(account.uid).set({ id: account.uid, email: account.email, firstName: name, lastName: "T" });
  });
}

/** Complete agency visa content (a fee three times the verified one, so a mismatch is raised). */
function content(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    countryCode: CC,
    name: "Partner sponsored route",
    code: "SWV",
    description: "A route we help clients with.",
    category: "work",
    processingTime: "3 to 8 weeks",
    processingDaysMin: 21,
    processingDaysMax: 56,
    validityPeriod: "Up to 5 years",
    isExtendable: true,
    eligibilityCriteria: ["A job offer from our partner"],
    baseCostUsd: 2100,
    ...over,
  };
}

/** Write an agency visa doc the way the backend would have (rules off). */
async function seedVisa(id: string, status: string, over: Record<string, unknown> = {}): Promise<void> {
  const now = new Date();
  await withoutRules(async (db) => {
    await db.collection("countries").doc(CC).collection("visaTypes").doc(id).set({
      ...content(),
      id,
      agentIds: [],
      source: "agency",
      ownerAgencyId: AGENCY_A,
      createdBy: accounts.screenowner.uid,
      visibility: "agency",
      reviewStatus: status,
      isActive: status === "approved",
      createdAt: now,
      updatedAt: now,
      ...(status === "pending_review" ? { submittedAt: now, submittedBy: accounts.screenowner.uid } : {}),
      ...over,
    });
  });
}

/** Record a "nothing found" reply for a listing, as the screening will request it. */
async function recordBenign(c: Record<string, unknown>): Promise<void> {
  const { buildListingScreeningRequest, listingTextFields } = await import("../../src/services/ai/listing-screening-prompt");
  provider.record(buildListingScreeningRequest(listingTextFields(c)), { text: JSON.stringify({ flags: [] }) });
}

let provider: import("../../src/services/ai/llm-provider").RecordedLlmProvider;

before(async () => {
  await resetEmulators();
  api = await startApi();

  // The model: recorded only. The review emails: swallowed (not under test).
  const { RecordedLlmProvider } = await import("../../src/services/ai/llm-provider");
  provider = new RecordedLlmProvider();
  const { agencyVisaScreeningService } = await import("../../src/agency-visas/agency-visa-screening.service");
  agencyVisaScreeningService.deps.provider = provider;
  const { agencyVisaReviewService } = await import("../../src/agency-visas/agency-visa-review.service");
  agencyVisaReviewService.notify = async () => undefined;

  await principal("screenclient", { role: "client", agencyId: null, admin: false });
  await principal("screenfree", { role: "agent", agencyId: null, admin: false });
  await principal("screenagent", { role: "agent", agencyId: AGENCY_A, admin: false });
  await principal("screenowner", { role: "owner", agencyId: AGENCY_A, admin: false });
  await principal("screenother", { role: "owner", agencyId: AGENCY_B, admin: false });
  await principal("screenadmin", { role: "admin", agencyId: null, admin: true });

  await withoutRules(async (db) => {
    const now = new Date();
    await db.collection("countries").doc(CC).set({ code: CC, name: "Fixture country", isSupported: true, popularityRank: 1, visaTypesCount: 0, minProcessingDays: 0, minCostUsd: 0, createdAt: now, updatedAt: now });
    await db.collection("agencies").doc(AGENCY_A).set({ id: AGENCY_A, name: "Agency A", ownerId: accounts.screenowner.uid });
    await db.collection("agencies").doc(AGENCY_B).set({ id: AGENCY_B, name: "Agency B", ownerId: accounts.screenother.uid });
    // The verified scraped record the listings are compared with.
    await db.collection("countries").doc(CC).collection("visaTypes").doc(VERIFIED_ID).set({
      id: VERIFIED_ID, countryCode: CC, name: "Verified", code: "SWV", description: "scraped", category: "work",
      processingTime: "weeks", processingDaysMin: 21, processingDaysMax: 56, baseCostUsd: 700, validityPeriod: "5 years",
      isExtendable: true, eligibilityCriteria: [], agentIds: [], source: "scraped", reviewStatus: "approved", isActive: true,
      scrapeMeta: {
        sourceUrl: VERIFIED_URL,
        citations: { "fee.application": "The application fee is 700 dollars." },
        fee: { components: [], totals: [] },
      },
      createdAt: now, updatedAt: now,
    });
  });
});

after(async () => {
  await api.close();
  await (await rulesEnv()).cleanup();
});

/** Names in the order the matrices use. */
const ALL = ["anon", "screenclient", "screenfree", "screenagent", "screenowner", "screenother", "screenadmin"] as const;
const tok = (who: string) => (who === "anon" ? undefined : tokens[who]);

/** Call as `who`; keep every body for the leak scan. */
const bodies: { who: string; what: string; status: number; text: string }[] = [];
async function as(who: string, method: string, path: string, body?: unknown) {
  const r = await api.call(method, path, tok(who), body);
  bodies.push({ who, what: `${method} ${path}`, status: r.status, text: JSON.stringify(r.body) });
  return r;
}

/** Check a whole matrix: expected status per principal. */
function expectMatrix(observed: Record<string, number>, expected: Record<string, number>, label: string) {
  assert.deepEqual(observed, expected, `${label}: ${JSON.stringify(observed)}`);
}

// ============================================
// 1. Submit
// ============================================

describe("submit: role matrix and screening", () => {
  test("only the agency's own agent and owner can submit; screening runs and the admin sees it", async () => {
    // A draft each for the refused callers (nothing may change) and for the two that can.
    await seedVisa("sub-refused", "draft");
    await seedVisa("sub-agent", "draft");
    await seedVisa("sub-owner", "draft");
    await recordBenign({ ...content(), code: "SWV" }); // one reply serves both identical listings

    const observed: Record<string, number> = {};
    for (const who of ["anon", "screenclient", "screenfree", "screenother", "screenadmin"]) {
      observed[who] = (await as(who, "POST", "/agency/visas/sub-refused/submit")).status;
    }
    observed.screenagent = (await as("screenagent", "POST", "/agency/visas/sub-agent/submit")).status;
    observed.screenowner = (await as("screenowner", "POST", "/agency/visas/sub-owner/submit")).status;
    expectMatrix(
      observed,
      { anon: 401, screenclient: 403, screenfree: 403, screenother: 404, screenadmin: 403, screenagent: 200, screenowner: 200 },
      "submit"
    );

    const { db } = await import("../../src/utils/firebase");
    // The refused caller changed nothing and screened nothing.
    const refused = (await db.collection("countries").doc(CC).collection("visaTypes").doc("sub-refused").get()).data() as any;
    assert.equal(refused.reviewStatus, "draft");
    assert.equal((await db.collection("listingScreenings").doc(`${CC}__sub-refused`).get()).exists, false);
    // The two submits were screened, in code against the verified record: fee 2100 vs 700 is a mismatch.
    for (const id of ["sub-agent", "sub-owner"]) {
      const doc = (await db.collection("listingScreenings").doc(`${CC}__${id}`).get()).data() as any;
      assert.equal(doc.target, "visa");
      assert.equal(doc.verifiedVisaId, VERIFIED_ID);
      assert.equal(doc.languageCheck, "done");
      assert.equal(doc.comparisons.find((c: any) => c.field === "baseCostUsd").verdict, "mismatch");
      assert.equal(doc.signalIds.length, 1);
      // The listing itself is exactly what a submit writes: pending, inactive, agency-only.
      const visa = (await db.collection("countries").doc(CC).collection("visaTypes").doc(id).get()).data() as any;
      assert.deepEqual([visa.reviewStatus, visa.isActive, visa.visibility], ["pending_review", false, "agency"]);
    }
  });
});

// ============================================
// 2. Edit of an approved visa
// ============================================

describe("edit of an approved visa: role matrix and screening", () => {
  test("the live doc is untouched, the revision is screened, and only the agency's members can edit", async () => {
    await seedVisa("live-1", "approved");
    const edit = { baseCostUsd: 3000 };
    await recordBenign({ ...content(), ...edit, code: "SWV" });

    const observed: Record<string, number> = {};
    for (const who of ["anon", "screenclient", "screenfree", "screenother", "screenadmin"]) {
      observed[who] = (await as(who, "PATCH", "/agency/visas/live-1", edit)).status;
    }
    observed.screenowner = (await as("screenowner", "PATCH", "/agency/visas/live-1", edit)).status;
    observed.screenagent = (await as("screenagent", "PATCH", "/agency/visas/live-1", edit)).status;
    expectMatrix(
      observed,
      { anon: 401, screenclient: 403, screenfree: 403, screenother: 404, screenadmin: 403, screenowner: 200, screenagent: 200 },
      "edit"
    );

    const { db } = await import("../../src/utils/firebase");
    const live = (await db.collection("countries").doc(CC).collection("visaTypes").doc("live-1").get()).data() as any;
    assert.equal(live.baseCostUsd, 2100, "live values untouched");
    assert.equal(live.isActive, true);
    assert.equal(live.reviewStatus, "approved");
    const rev = (await db.collection("visaRevisions").doc(`${CC}__live-1`).get()).data() as any;
    assert.equal(rev.reviewStatus, "pending_review");
    const screening = (await db.collection("listingScreenings").doc(`${CC}__live-1`).get()).data() as any;
    assert.equal(screening.target, "revision");
    assert.equal(screening.comparisons.find((c: any) => c.field === "baseCostUsd").listingValue, 3000);
  });
});

// ============================================
// 3. Admin list
// ============================================

describe("GET /admin/visas: screening fields are admin-only", () => {
  test("403 for every non-admin (401 anonymous); the admin gets screening and openScreeningSignals", async () => {
    const observed: Record<string, number> = {};
    for (const who of ALL) observed[who] = (await as(who, "GET", "/admin/visas")).status;
    expectMatrix(observed, { anon: 401, screenclient: 403, screenfree: 403, screenagent: 403, screenowner: 403, screenother: 403, screenadmin: 200 }, "admin list");

    const list = await as("screenadmin", "GET", "/admin/visas");
    const rows = new Map<string, any>(list.body.data.map((v: any) => [v.id, v]));
    const row = rows.get("sub-agent");
    assert.equal(row.screening.target, "visa");
    assert.equal(row.screening.languageCheck, "done");
    assert.equal(row.openScreeningSignals, 1);
    assert.equal(rows.get("live-1").screening.target, "revision");
    // Scraped rows are untouched.
    assert.equal("screening" in rows.get(VERIFIED_ID), false);
    assert.equal("openScreeningSignals" in rows.get(VERIFIED_ID), false);
  });
});

// ============================================
// 4. Approve: SCREENING_OPEN and acknowledgeScreening
// ============================================

describe("PATCH /admin/visas/:id/review: approve with and without acknowledgeScreening", () => {
  test("non-admins are refused; the admin gets 409 SCREENING_OPEN (nothing written), then 200 with the acknowledgement", async () => {
    const observed: Record<string, number> = {};
    for (const who of ALL) {
      observed[who] = (await as(who, "PATCH", "/admin/visas/sub-agent/review", { action: "approve", countryCode: CC, acknowledgeScreening: true })).status;
    }
    // Every refusal happens before the admin-only gate: only the admin gets past it, and here the answer is 200.
    const { db } = await import("../../src/utils/firebase");
    const refusedStatuses = Object.entries(observed).filter(([who]) => who !== "screenadmin").map(([, s]) => s);
    assert.ok(refusedStatuses.every((s) => s === 401 || s === 403), JSON.stringify(observed));
    assert.equal(observed.screenadmin, 200);
    const approved = (await db.collection("countries").doc(CC).collection("visaTypes").doc("sub-agent").get()).data() as any;
    assert.equal(approved.reviewStatus, "approved");
    assert.equal(approved.visibility, "agency", "approval keeps the visa agency-only");

    // A different pending visa: no acknowledgement -> 409, nothing written.
    const before = JSON.stringify((await db.collection("countries").doc(CC).collection("visaTypes").doc("sub-owner").get()).data());
    const blocked = await as("screenadmin", "PATCH", "/admin/visas/sub-owner/review", { action: "approve", countryCode: CC });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error, "SCREENING_OPEN");
    assert.equal(JSON.stringify((await db.collection("countries").doc(CC).collection("visaTypes").doc("sub-owner").get()).data()), before);
    // Reject is never blocked.
    // (Kept for a visa of its own so the next assertions stay independent.)
    await seedVisa("rej-1", "pending_review");
    const rejected = await as("screenadmin", "PATCH", "/admin/visas/rej-1/review", { action: "reject", countryCode: CC, reason: "Fee does not match the official one" });
    assert.equal(rejected.status, 200);
    // And with the acknowledgement the blocked one goes through.
    const ok = await as("screenadmin", "PATCH", "/admin/visas/sub-owner/review", { action: "approve", countryCode: CC, acknowledgeScreening: true });
    assert.equal(ok.status, 200);
  });

  test("a CLEAN screening needs no acknowledgement (matching listing)", async () => {
    await seedVisa("clean-1", "draft", { baseCostUsd: 700 });
    await recordBenign({ ...content({ baseCostUsd: 700 }), code: "SWV" });
    assert.equal((await as("screenowner", "POST", "/agency/visas/clean-1/submit")).status, 200);
    const res = await as("screenadmin", "PATCH", "/admin/visas/clean-1/review", { action: "approve", countryCode: CC });
    assert.equal(res.status, 200);
    const { db } = await import("../../src/utils/firebase");
    const snap = await db.collection("riskSignals").where("subject.id", "==", `${CC}__clean-1`).get();
    assert.equal(snap.size, 0, "a clean listing raises no signal");
  });
});

// ============================================
// 5. Rerun
// ============================================

describe("POST /admin/visas/:id/screening/rerun: role matrix", () => {
  test("only the admin can rerun; 404 for an unknown or non-agency visa", async () => {
    await seedVisa("rerun-1", "pending_review");
    await recordBenign({ ...content(), code: "SWV" });
    const observed: Record<string, number> = {};
    for (const who of ALL) observed[who] = (await as(who, "POST", "/admin/visas/rerun-1/screening/rerun", { countryCode: CC })).status;
    expectMatrix(observed, { anon: 401, screenclient: 403, screenfree: 403, screenagent: 403, screenowner: 403, screenother: 403, screenadmin: 200 }, "rerun");

    const again = await as("screenadmin", "POST", "/admin/visas/rerun-1/screening/rerun", { countryCode: CC });
    assert.equal(again.body.data.status, "unchanged");
    assert.equal((await as("screenadmin", "POST", "/admin/visas/nope/screening/rerun", { countryCode: CC })).status, 404);
    assert.equal((await as("screenadmin", "POST", `/admin/visas/${VERIFIED_ID}/screening/rerun`, { countryCode: CC })).status, 404);
    assert.equal((await as("screenadmin", "POST", "/admin/visas/rerun-1/screening/rerun", {})).status, 400);
  });
});

// ============================================
// 6. Risk-signal routes
// ============================================

describe("risk-signal routes show the screening signals to admins only", () => {
  test("list and detail: 401 / 403 for everyone but the admin, who sees the visa subject", async () => {
    const list = await as("screenadmin", "GET", "/admin/risk-signals?subjectType=visa&status=open");
    assert.equal(list.status, 200);
    const items: any[] = list.body.data.items;
    assert.ok(items.length >= 2);
    assert.ok(items.every((s) => s.subject.type === "visa" && s.type === "listing_contradicts_verified_record"));
    const fee = items.find((s) => s.subject.id === `${CC}__sub-agent`);
    assert.equal(fee.source.sourceUrl, VERIFIED_URL);
    assert.equal(fee.source.sourceQuote, "The application fee is 700 dollars.");
    // No listing text in the signal.
    assert.ok(!JSON.stringify(fee).includes("Partner sponsored route"));

    const observed: Record<string, number> = {};
    for (const who of ALL) observed[who] = (await as(who, "GET", `/admin/risk-signals/${fee.id}`)).status;
    expectMatrix(observed, { anon: 401, screenclient: 403, screenfree: 403, screenagent: 403, screenowner: 403, screenother: 403, screenadmin: 200 }, "signal detail");
    const listObserved: Record<string, number> = {};
    for (const who of ALL) listObserved[who] = (await as(who, "GET", "/admin/risk-signals")).status;
    expectMatrix(listObserved, { anon: 401, screenclient: 403, screenfree: 403, screenagent: 403, screenowner: 403, screenother: 403, screenadmin: 200 }, "signal list");
  });
});

// ============================================
// 7. Nothing leaks; rules deny clients
// ============================================

describe("nothing about screening reaches a non-admin", () => {
  test("no non-admin body mentions screening, signals or the SCREENING_OPEN code", () => {
    const nonAdmin = bodies.filter((b) => b.who !== "screenadmin");
    assert.ok(nonAdmin.length > 30);
    for (const b of nonAdmin) {
      // The agency's own submit / edit bodies and every refusal are scanned.
      assert.ok(!LEAK.test(b.text), `${b.who} ${b.what} (${b.status}) leaked: ${b.text.slice(0, 200)}`);
    }
  });

  test("the agency's own views carry only the existing review state", async () => {
    for (const who of ["screenowner", "screenagent"]) {
      const list = await as(who, "GET", "/agency/visas");
      assert.equal(list.status, 200);
      assert.ok(!LEAK.test(JSON.stringify(list.body)));
      const one = await as(who, "GET", "/agency/visas/live-1");
      assert.equal(one.status, 200);
      assert.equal(one.body.data.pendingRevision.reviewStatus, "pending_review");
      assert.ok(!LEAK.test(JSON.stringify(one.body)));
    }
    // Another agency sees none of it.
    const other = await as("screenother", "GET", "/agency/visas");
    assert.equal(other.body.data.length, 0);
    assert.equal((await as("screenother", "GET", "/agency/visas/live-1")).status, 404);
  });

  test("an applicant and an anonymous caller read a public visa with nothing about screening", async () => {
    // Make the approved listing public the way an admin does, then read it.
    assert.equal((await as("screenadmin", "PATCH", "/admin/visas/sub-agent/visibility", { countryCode: CC, visibility: "global" })).status, 200);
    for (const who of ["anon", "screenclient"]) {
      const r = await as(who, "GET", `/countries/${CC}/visas/sub-agent`);
      assert.equal(r.status, 200);
      assert.ok(!LEAK.test(JSON.stringify(r.body)), who);
    }
  });

  test("firestore.rules: a client token cannot read or write listingScreenings or riskSignals", async () => {
    const observed: Record<string, boolean> = {};
    const roles: Record<string, Record<string, unknown>> = {
      screenclient: { role: "client", agencyId: null, admin: false },
      screenfree: { role: "agent", agencyId: null, admin: false },
      screenagent: { role: "agent", agencyId: AGENCY_A, admin: false },
      screenowner: { role: "owner", agencyId: AGENCY_A, admin: false },
      screenother: { role: "owner", agencyId: AGENCY_B, admin: false },
      screenadmin: { role: "admin", agencyId: null, admin: true },
    };
    for (const [name, claims] of Object.entries(roles)) {
      const db = await clientDb(accounts[name].uid, claims);
      for (const col of ["listingScreenings", "riskSignals"]) {
        observed[`${name} ${col} get`] = await isDenied(db.collection(col).doc(`${CC}__sub-agent`).get());
        observed[`${name} ${col} list`] = await isDenied(db.collection(col).get());
        observed[`${name} ${col} create`] = await isDenied(db.collection(col).doc("x").set({ a: 1 }));
        observed[`${name} ${col} update`] = await isDenied(db.collection(col).doc(`${CC}__sub-agent`).set({ a: 1 }, { merge: true }));
        observed[`${name} ${col} delete`] = await isDenied(db.collection(col).doc(`${CC}__sub-agent`).delete());
      }
    }
    assert.equal(Object.values(observed).every(Boolean), true, `every access must be denied: ${JSON.stringify(observed)}`);
    // And the data is really there for the backend.
    const { db } = await import("../../src/utils/firebase");
    assert.equal((await db.collection("listingScreenings").doc(`${CC}__sub-agent`).get()).exists, true);
  });

  test("screening wrote no notification", async () => {
    const { db } = await import("../../src/utils/firebase");
    assert.equal((await db.collection("notifications").get()).size, 0);
  });
});
