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
  // Issue #187 regroom: a visa with one information item per answer type (as a
  // v9 crawl stores them), one item with NO stored type (read as text), and one
  // LEGACY-style visa item used for the plain-string re-read test.
  const typed: Array<[string, string?]> = [
    ["a date of birth item", "date"], ["the dates you're travelling", "date_range"],
    ["how much the trip will cost", "money"], ["where you'll be staying", "address"],
    ["details of your travel history", "list"], ["a free text item", "text"], ["an old untyped item"],
  ];
  const q = "You'll need to provide the following information in your online application";
  await put("countries/GB/visaTypes", "gb-typed", {
    id: "gb-typed", countryCode: "GB", name: "Typed visitor", code: "TT", description: "d", category: "tourist",
    processingTime: "3 weeks", baseCostUsd: 100, validityPeriod: "6 months", eligibilityCriteria: ["x"], agentIds: [],
    isActive: true, source: "scraped", reviewStatus: "approved", sourceUrl: URL,
    requiredDocuments: typed.map(([n]) => n),
    scrapeMeta: {
      sourceUrl: URL,
      citations: Object.fromEntries(typed.map(([n], i) => [`requiredDocuments.${i}`, n])),
      requiredDocumentMeta: typed.map(([n, t]) => ({
        item: n, kind: "information", kindQuote: q, need: "required", ...(t ? { answerType: t } : {}),
      })),
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

// ---- Typed answers (issue #187 regroom) ----

/** Checklist ids of the typed visa's items, keyed by answerType (the untyped one as "untyped"). */
async function typedIds(token: string, appId: string): Promise<Record<string, string>> {
  const res = await api.call("GET", `/applications/${appId}/checklist`, token);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const out: Record<string, string> = {};
  for (const i of res.body.data.items as any[]) out[i.title === "an old untyped item" ? "untyped" : i.answerType] = i.checklistItemId;
  return out;
}

describe("typed answers", () => {
  test("the checklist carries answerType on information items (text when none is stored)", async () => {
    const me = await seedClient("ty-a");
    await seedApplication("app-ty-a", { userId: me.uid, countryCode: "GB", visaTypeId: "gb-typed", mode: "self", status: "pending_documents" });
    const ids = await typedIds(me.idToken, "app-ty-a");
    assert.deepEqual(Object.keys(ids).sort(), ["address", "date", "date_range", "list", "money", "text", "untyped"]);
    // The untyped item reads as text.
    const res = await api.call("GET", "/applications/app-ty-a/checklist", me.idToken);
    assert.equal((res.body.data.items as any[]).find((i) => i.checklistItemId === ids.untyped).answerType, "text");
  });

  test("save and read back each type; an empty value clears; 400 names the bad field", async () => {
    const me = await seedClient("ty-b");
    await seedApplication("app-ty-b", { userId: me.uid, countryCode: "GB", visaTypeId: "gb-typed", mode: "self", status: "pending_documents" });
    const ids = await typedIds(me.idToken, "app-ty-b");
    const put = (id: string, body: unknown) => api.call("PUT", `/applications/app-ty-b/answers/${id}`, me.idToken, body);
    const values: Record<string, unknown> = {
      date: "1990-04-23",
      date_range: { from: "2027-01-10", to: "2027-01-24" },
      money: { amount: 2500, currency: "gbp" },
      address: { line1: " 12 High St ", city: "London", country: "United Kingdom", note: "3 years" },
      list: ["  Paris 2023 ", "", "Rome 2024"],
      text: "  hello ",
    };
    const expected: Record<string, unknown> = {
      ...values,
      money: { amount: 2500, currency: "GBP" },
      address: { line1: "12 High St", city: "London", country: "United Kingdom", note: "3 years" },
      list: ["Paris 2023", "Rome 2024"],
      text: "hello",
    };
    for (const [type, v] of Object.entries(values)) {
      const r = await put(ids[type], { value: v });
      assert.equal(r.status, 200, `${type}: ${JSON.stringify(r.body)}`);
      assert.deepEqual(r.body.data.value, expected[type], type);
      assert.equal(r.body.data.answerType, type);
    }
    const got = (await api.call("GET", "/applications/app-ty-b/answers", me.idToken)).body.data.answers;
    for (const type of Object.keys(values)) {
      assert.deepEqual(got[ids[type]].value, expected[type], type);
      assert.equal(got[ids[type]].answerType, type);
      assert.equal(got[ids[type]].legacy, undefined);
    }

    // Wrong shapes: 400 and the message names the field.
    const bad = async (type: string, v: unknown, field: string) => {
      const r = await put(ids[type], { value: v });
      assert.equal(r.status, 400, `${type} ${JSON.stringify(v)}`);
      assert.equal(r.body.error, "VALIDATION_ERROR");
      assert.ok(String(r.body.message ?? r.body.error_description ?? JSON.stringify(r.body)).includes(field), `${field} in ${JSON.stringify(r.body)}`);
    };
    await bad("date", "2026-02-31", "value");
    await bad("date_range", { from: "2027-02-01", to: "2027-01-01" }, "value.to");
    await bad("date_range", { from: "2027-02-01" }, "value.to");
    await bad("money", { amount: -1, currency: "GBP" }, "value.amount");
    await bad("money", { amount: 5, currency: "pounds" }, "value.currency");
    await bad("address", { line1: "x", city: "y" }, "value.country");
    await bad("list", Array.from({ length: 21 }, (_, i) => `e${i}`), "value");
    await bad("list", ["x".repeat(501)], "value[0]");
    await bad("text", "x".repeat(2001), "value");

    // A wrong-typed save never overwrites the good answer.
    const still = (await api.call("GET", "/applications/app-ty-b/answers", me.idToken)).body.data.answers;
    assert.deepEqual(still[ids.date_range].value, expected.date_range);

    // Empty values clear, whatever the type.
    for (const [type, empty] of [["date", ""], ["date_range", { from: "", to: "" }], ["money", null], ["address", {}], ["list", []], ["text", "  "]] as const) {
      const r = await put(ids[type], { value: empty });
      assert.equal(r.status, 200, `${type}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.data.value, null);
    }
    assert.deepEqual((await api.call("GET", "/applications/app-ty-b/answers", me.idToken)).body.data.answers, {});
  });

  test("legacy plain-string answers are read back without loss (text as text, others as one-entry list / note)", async () => {
    const me = await seedClient("ty-c");
    await seedApplication("app-ty-c", { userId: me.uid, countryCode: "GB", visaTypeId: "gb-typed", mode: "self", status: "pending_documents" });
    const ids = await typedIds(me.idToken, "app-ty-c");
    for (const type of ["text", "list", "address", "date"]) {
      await put("applications/app-ty-c/answers", ids[type], { text: `legacy ${type}`, updatedAt: new Date(), updatedBy: me.uid });
    }
    const got = (await api.call("GET", "/applications/app-ty-c/answers", me.idToken)).body.data.answers;
    assert.deepEqual([got[ids.text].value, got[ids.text].legacy], ["legacy text", undefined]);
    assert.deepEqual([got[ids.list].value, got[ids.list].legacy], [["legacy list"], true]);
    assert.deepEqual([got[ids.address].value, got[ids.address].legacy], [{ note: "legacy address" }, true]);
    assert.deepEqual([got[ids.date].value, got[ids.date].legacy], ["legacy date", true]);
    // A plain `{ text }` body is still accepted for a text item.
    const r = await api.call("PUT", `/applications/app-ty-c/answers/${ids.text}`, me.idToken, { text: "via text" });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.value, "via text");
  });
});
