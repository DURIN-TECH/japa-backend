// ============================================
// Emulator tests: answers to information checklist items (issue #187)
// ============================================
//
// Run with `npm run test:emulator` (real firestore.rules, real Express app,
// real ID tokens). Pins: validation (400), the edit window (409 ANSWERS_LOCKED,
// same window as STATEMENT_LOCKED, GET unaffected), cross-agency denial (403),
// clearing with "", and that client SDKs cannot touch the subcollection.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

import { clientDb, isDenied, resetEmulators, rulesEnv, RunningApi, startApi } from "./helpers";
import { put, seedAgency, seedApplication, seedClient, stored } from "./agency-fixtures";

/* eslint-disable @typescript-eslint/no-explicit-any */

let api: RunningApi;
const URL = "https://www.gov.uk/standard-visitor";

before(async () => {
  await rulesEnv();
  await resetEmulators();
  api = await startApi();
  // A scraped, approved visa with one information item (index 0) and one
  // document (index 1), as a v7 crawl stores them.
  await put("countries/GB/visaTypes", "gb-answers", {
    id: "gb-answers", countryCode: "GB", name: "Test visitor", code: "TV", description: "d", category: "tourist",
    processingTime: "3 weeks", baseCostUsd: 100, validityPeriod: "6 months", eligibilityCriteria: ["x"], agentIds: [],
    isActive: true, source: "scraped", reviewStatus: "approved", sourceUrl: URL,
    requiredDocuments: ["where you'll be staying during your visit", "a valid passport"],
    scrapeMeta: {
      sourceUrl: URL,
      citations: {
        "requiredDocuments.0": "where you'll be staying during your visit",
        "requiredDocuments.1": "You must have a passport",
      },
      requiredDocumentMeta: [
        { kind: "information", kindQuote: "You'll need to provide the following information in your online application", need: "required" },
        { kind: "document", kindQuote: "You must have a passport", need: "required" },
      ],
    },
    createdAt: new Date(), updatedAt: new Date(),
  });
});

after(async () => {
  await api.close();
  await (await rulesEnv()).cleanup();
});

/** put() above targets a collection path; make it work for the nested one. */
async function seedCase(id: string, userId: string, fields: Record<string, unknown> = {}): Promise<void> {
  await seedApplication(id, { userId, countryCode: "GB", visaTypeId: "gb-answers", mode: "self", status: "pending_documents", ...fields });
}

/** The checklist ids of the information and the document item, via the API. */
async function itemIds(token: string, appId: string): Promise<{ info: string; doc: string }> {
  const res = await api.call("GET", `/applications/${appId}/checklist`, token);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const items = res.body.data.items as any[];
  return {
    info: items.find((i) => i.kind === "information").checklistItemId,
    doc: items.find((i) => i.kind === "document").checklistItemId,
  };
}

describe("answers API", () => {
  test("save, read back, replace and clear an answer", async () => {
    const me = await seedClient("ans-a");
    await seedCase("app-a", me.uid);
    const { info } = await itemIds(me.idToken, "app-a");

    const put1 = await api.call("PUT", `/applications/app-a/answers/${info}`, me.idToken, { text: "  12 High St  " });
    assert.equal(put1.status, 200, JSON.stringify(put1.body));
    assert.equal(put1.body.data.text, "12 High St");
    assert.equal(put1.body.data.itemId, info);

    const get1 = await api.call("GET", "/applications/app-a/answers", me.idToken);
    assert.equal(get1.body.data.answers[info].text, "12 High St");
    assert.ok(typeof get1.body.data.answers[info].updatedAt === "string");

    await api.call("PUT", `/applications/app-a/answers/${info}`, me.idToken, { text: "new" });
    assert.equal((await api.call("GET", "/applications/app-a/answers", me.idToken)).body.data.answers[info].text, "new");

    const cleared = await api.call("PUT", `/applications/app-a/answers/${info}`, me.idToken, { text: "" });
    assert.equal(cleared.status, 200);
    assert.deepEqual((await api.call("GET", "/applications/app-a/answers", me.idToken)).body.data.answers, {});
  });

  test("400 VALIDATION_ERROR: non-string, over 2000 chars, unknown item, document item", async () => {
    const me = await seedClient("ans-b");
    await seedCase("app-b", me.uid);
    const { info, doc } = await itemIds(me.idToken, "app-b");
    const attempt = async (id: string, body: unknown) => {
      const r = await api.call("PUT", `/applications/app-b/answers/${id}`, me.idToken, body);
      return { status: r.status, error: r.body.error };
    };
    const bad = { status: 400, error: "VALIDATION_ERROR" };
    assert.deepEqual(await attempt(info, { text: 5 }), bad);
    assert.deepEqual(await attempt(info, {}), bad);
    assert.deepEqual(await attempt(info, { text: "x".repeat(2001) }), bad);
    assert.deepEqual(await attempt("vr-unknown", { text: "a" }), bad);
    assert.deepEqual(await attempt(doc, { text: "a" }), bad);
    assert.equal((await attempt(info, { text: "x".repeat(2000) })).status, 200);
  });

  test("409 ANSWERS_LOCKED once under review (same window as the statement); GET still works", async () => {
    const me = await seedClient("ans-c");
    await seedCase("app-c", me.uid);
    const { info } = await itemIds(me.idToken, "app-c");
    await api.call("PUT", `/applications/app-c/answers/${info}`, me.idToken, { text: "kept" });
    await put("applications", "app-c", { id: "app-c", userId: me.uid, countryCode: "GB", visaTypeId: "gb-answers", mode: "self", status: "under_review", createdAt: new Date(), updatedAt: new Date() });

    const locked = await api.call("PUT", `/applications/app-c/answers/${info}`, me.idToken, { text: "late" });
    assert.deepEqual({ status: locked.status, error: locked.body.error }, { status: 409, error: "ANSWERS_LOCKED" });
    const get = await api.call("GET", "/applications/app-c/answers", me.idToken);
    assert.equal(get.status, 200);
    assert.equal(get.body.data.answers[info].text, "kept");
  });

  test("another agency's agent and an unrelated user are denied (403), and nothing is written", async () => {
    const me = await seedClient("ans-d");
    const mine = await seedAgency("ans-mine");
    const theirs = await seedAgency("ans-theirs");
    await seedCase("app-d", me.uid, { mode: "agent", agentId: mine.owner.uid, agencyId: mine.agencyId });
    const { info } = await itemIds(me.idToken, "app-d");
    const stranger = await seedClient("ans-stranger");

    const seen: Record<string, number> = {};
    for (const [who, token] of [["otherAgency", theirs.owner.idToken], ["stranger", stranger.idToken]] as const) {
      seen[`${who}-get`] = (await api.call("GET", "/applications/app-d/answers", token)).status;
      seen[`${who}-put`] = (await api.call("PUT", `/applications/app-d/answers/${info}`, token, { text: "x" })).status;
    }
    assert.deepEqual(seen, { "otherAgency-get": 403, "otherAgency-put": 403, "stranger-get": 403, "stranger-put": 403 });
    assert.equal(await stored("applications/app-d/answers", info), undefined);
    // The owning agency can read it.
    assert.equal((await api.call("GET", "/applications/app-d/answers", mine.owner.idToken)).status, 200);
  });

  test("firestore.rules: no client read or write on applications/{id}/answers", async () => {
    const me = await seedClient("ans-e");
    await seedCase("app-e", me.uid);
    const { info } = await itemIds(me.idToken, "app-e");
    await api.call("PUT", `/applications/app-e/answers/${info}`, me.idToken, { text: "secret" });
    const db = await clientDb(me.uid);
    const ref = db.collection("applications").doc("app-e").collection("answers").doc(info);
    assert.equal(await isDenied(ref.get()), true);
    assert.equal(await isDenied(ref.set({ text: "x" })), true);
    assert.equal(await isDenied(db.collection("applications").doc("app-e").collection("answers").get()), true);
  });
});
