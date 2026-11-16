// ============================================
// Emulator tests — saved destinations (issue #146)
// ============================================
//
// Run with `npm run test:emulator` (Auth + Firestore emulators on the
// alternate ports of ../firebase.emulator-test.json, the real Express app,
// real ID tokens minted by the Auth emulator, the real firestore.rules).
//
// Covered, as the issue lists them: save, save twice, remove, remove twice,
// list order, hidden visa left out of the list, 404 for an unknown visa, 401
// without a token, user A cannot see user B's saves, the 200 cap, account
// deletion clears the saves. Plus what the criteria also promise: country
// code in any case, the read-only-plan write block, the response shape, and
// that no client can reach the subcollection directly (rules).
//
// Each test signs up its OWN users, so the tests do not depend on each other
// or on their order. The visas are shared fixtures and are put back by any
// test that changes one.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

import { clientDb, isDenied, resetEmulators, rulesEnv, RunningApi, startApi, withoutRules } from "./helpers";
import { seedClient } from "./agency-fixtures";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ============================================
// Fixtures
// ============================================

let api: RunningApi;

/** Base path of the feature. */
const BASE = "/users/me/saved-destinations";
/** Path of one save. */
const path = (cc: string, id: string) => `${BASE}/${cc}/${id}`;

/** Public visas (seed shape: active, no review status, no visibility). */
const GB_WORK = "emu-146-gb-work";
const GB_STUDY = "emu-146-gb-study";
const CA_VISIT = "emu-146-ca-visit";
/** A public visa one test hides and restores. */
const GB_TOGGLE = "emu-146-gb-toggle";
/** Visas that exist but are NOT publicly visible, one per reason. */
const HIDDEN: Record<string, Record<string, unknown>> = {
  "emu-146-inactive": { isActive: false },
  "emu-146-agency-only": { visibility: "agency", reviewStatus: "approved" },
  "emu-146-pending": { source: "scraped", reviewStatus: "pending_review" },
};
/** Extra public visas for the cap race. */
const RACE = ["emu-146-race-1", "emu-146-race-2", "emu-146-race-3", "emu-146-race-4"];

/** Display names of the two countries. */
const COUNTRY_NAMES: Record<string, string> = { GB: "United Kingdom", CA: "Canada" };

/** Fields every visa document here shares. */
function visaDoc(cc: string, id: string, over: Record<string, unknown>): Record<string, unknown> {
  return {
    id,
    countryCode: cc,
    name: `Visa ${id}`,
    code: id.toUpperCase(),
    description: `About ${id}`,
    category: "work",
    processingTime: "3 weeks",
    processingDaysMin: 15,
    processingDaysMax: 21,
    baseCostUsd: 120,
    validityPeriod: "1 year",
    isExtendable: false,
    eligibilityCriteria: [],
    agentIds: [],
    isActive: true,
    // An internal field: must never appear in a response.
    scrapeMeta: { secret: "internal-only" },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

/** Write (or overwrite) a visa and its country, as the backend would. */
async function seedVisa(cc: string, id: string, over: Record<string, unknown> = {}): Promise<void> {
  await withoutRules(async (db) => {
    await db.collection("countries").doc(cc).set({
      code: cc, name: COUNTRY_NAMES[cc], isSupported: true, createdAt: new Date(), updatedAt: new Date(),
    });
    await db.collection("countries").doc(cc).collection("visaTypes").doc(id).set(visaDoc(cc, id, over));
  });
}

/** The Admin SDK Firestore (imported lazily: it initialises on import). */
async function adminDb(): Promise<FirebaseFirestore.Firestore> {
  return (await import("../../src/utils/firebase")).db;
}

/** Ids of the save documents really stored under a user (Admin SDK, no rules). */
async function storedSaveIds(uid: string): Promise<string[]> {
  const snap = await (await adminDb()).collection("users").doc(uid).collection("savedDestinations").get();
  return snap.docs.map((d) => d.id).sort();
}

/** GET the list with a token and return the items (asserting 200). */
async function listOf(token: string): Promise<any[]> {
  const r = await api.call("GET", BASE, token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.success, true);
  assert.ok(Array.isArray(r.body.data), "data is the array of items");
  return r.body.data;
}

/** "CC/visaId" of each item, in list order. */
const keysOf = (items: any[]) => items.map((i) => `${i.countryCode}/${i.visaId}`);

/** Put `n` save documents under a user directly (what earlier saves left behind). */
async function seedSaves(uid: string, n: number): Promise<void> {
  const db = await adminDb();
  const { Timestamp } = await import("firebase-admin/firestore");
  const batch = db.batch();
  for (let i = 0; i < n; i++) {
    const visaId = `emu-146-filler-${i}`;
    batch.set(db.collection("users").doc(uid).collection("savedDestinations").doc(`GB_${visaId}`), {
      countryCode: "GB",
      visaId,
      savedAt: Timestamp.fromMillis(1_700_000_000_000 + i),
    });
  }
  await batch.commit();
}

before(async () => {
  await rulesEnv();
  await resetEmulators();
  api = await startApi();
  await seedVisa("GB", GB_WORK, { successRate: 87, totalApplications: 12, source: "scraped", reviewStatus: "approved" });
  await seedVisa("GB", GB_STUDY, { category: "student" });
  await seedVisa("CA", CA_VISIT, { category: "tourist" });
  await seedVisa("GB", GB_TOGGLE);
  for (const [id, over] of Object.entries(HIDDEN)) await seedVisa("GB", id, over);
  for (const id of RACE) await seedVisa("GB", id);
});

after(async () => {
  await api.close();
  await (await rulesEnv()).cleanup();
});

// ============================================
// Sign-in
// ============================================

describe("saved destinations: sign-in is required (#146)", () => {
  test("no token -> 401 on GET, PUT and DELETE", async () => {
    for (const [method, p] of [["GET", BASE], ["PUT", path("GB", GB_WORK)], ["DELETE", path("GB", GB_WORK)]]) {
      const r = await api.call(method, p);
      assert.equal(r.status, 401, `${method} ${p} -> ${JSON.stringify(r.body)}`);
    }
  });

  test("a garbage token -> 401", async () => {
    const r = await api.call("GET", BASE, "not-a-real-token");
    assert.equal(r.status, 401, JSON.stringify(r.body));
  });
});

// ============================================
// Save, remove, list
// ============================================

describe("saved destinations: save, remove, list (#146)", () => {
  test("a new user's list is empty", async () => {
    const user = await seedClient("emu146-empty");
    assert.deepEqual(await listOf(user.idToken), []);
  });

  test("save returns the item with the tile data, stores one document, and nothing internal leaks", async () => {
    const user = await seedClient("emu146-save");
    const r = await api.call("PUT", path("GB", GB_WORK), user.idToken);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const item = r.body.data;

    // The exact contract: these keys and no others.
    assert.deepEqual(Object.keys(item).sort(), ["countryCode", "countryName", "savedAt", "visa", "visaId"]);
    assert.equal(item.countryCode, "GB");
    assert.equal(item.visaId, GB_WORK);
    assert.equal(item.countryName, "United Kingdom");
    assert.deepEqual(item.visa, {
      id: GB_WORK,
      countryCode: "GB",
      name: `Visa ${GB_WORK}`,
      description: `About ${GB_WORK}`,
      category: "work",
      processingTime: "3 weeks",
      baseCostUsd: 120,
      successRate: 87,
      totalApplications: 12,
      source: "scraped",
    });
    // savedAt is a Firestore Timestamp, serialised like every other one.
    assert.equal(typeof item.savedAt._seconds, "number", JSON.stringify(item.savedAt));
    assert.equal(typeof item.savedAt._nanoseconds, "number");

    // Stored: one document, under THIS user, with a real Timestamp.
    assert.deepEqual(await storedSaveIds(user.uid), [`GB_${GB_WORK}`]);
    const doc = await (await adminDb()).doc(`users/${user.uid}/savedDestinations/GB_${GB_WORK}`).get();
    const { Timestamp } = await import("firebase-admin/firestore");
    assert.ok(doc.get("savedAt") instanceof Timestamp, "savedAt is stored as a Timestamp");
    assert.deepEqual(Object.keys(doc.data()!).sort(), ["countryCode", "savedAt", "visaId"]);

    // The list returns the same item.
    assert.deepEqual(await listOf(user.idToken), [item]);
  });

  test("optional visa numbers that are missing come back as null", async () => {
    const user = await seedClient("emu146-nulls");
    const r = await api.call("PUT", path("GB", GB_STUDY), user.idToken);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.data.visa.successRate, null);
    assert.equal(r.body.data.visa.totalApplications, null);
    assert.equal(r.body.data.visa.source, null);
  });

  test("saving twice succeeds, keeps one document and the first savedAt", async () => {
    const user = await seedClient("emu146-twice");
    const first = await api.call("PUT", path("GB", GB_WORK), user.idToken);
    const second = await api.call("PUT", path("GB", GB_WORK), user.idToken);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.deepEqual(second.body.data, first.body.data);
    assert.deepEqual(await storedSaveIds(user.uid), [`GB_${GB_WORK}`]);
    assert.equal((await listOf(user.idToken)).length, 1);
  });

  test("country code matches in any case: gb and GB are one save, and either removes it", async () => {
    const user = await seedClient("emu146-case");
    const lower = await api.call("PUT", path("gb", GB_WORK), user.idToken);
    const upper = await api.call("PUT", path("GB", GB_WORK), user.idToken);
    assert.equal(lower.status, 200, JSON.stringify(lower.body));
    assert.equal(upper.status, 200);
    assert.equal(lower.body.data.countryCode, "GB");
    assert.deepEqual(upper.body.data, lower.body.data);
    assert.deepEqual(await storedSaveIds(user.uid), [`GB_${GB_WORK}`]);

    const removed = await api.call("DELETE", path("gB", GB_WORK), user.idToken);
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    assert.deepEqual(await storedSaveIds(user.uid), []);
  });

  test("remove deletes the save; removing again (or something never saved) also succeeds", async () => {
    const user = await seedClient("emu146-remove");
    await api.call("PUT", path("GB", GB_WORK), user.idToken);
    await api.call("PUT", path("GB", GB_STUDY), user.idToken);

    const first = await api.call("DELETE", path("GB", GB_WORK), user.idToken);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.deepEqual(first.body.data, { countryCode: "GB", visaId: GB_WORK, saved: false });
    assert.deepEqual(keysOf(await listOf(user.idToken)), [`GB/${GB_STUDY}`]);

    const again = await api.call("DELETE", path("GB", GB_WORK), user.idToken);
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.deepEqual(again.body.data, first.body.data);

    const never = await api.call("DELETE", path("CA", CA_VISIT), user.idToken);
    assert.equal(never.status, 200);
    const unknown = await api.call("DELETE", path("GB", "emu-146-does-not-exist"), user.idToken);
    assert.equal(unknown.status, 200);
    // The other save is untouched.
    assert.deepEqual(await storedSaveIds(user.uid), [`GB_${GB_STUDY}`]);
  });

  test("the list is newest first; saving an old one again does not move it", async () => {
    const user = await seedClient("emu146-order");
    for (const [cc, id] of [["GB", GB_WORK], ["CA", CA_VISIT], ["GB", GB_STUDY]]) {
      const r = await api.call("PUT", path(cc, id), user.idToken);
      assert.equal(r.status, 200, JSON.stringify(r.body));
    }
    const expected = [`GB/${GB_STUDY}`, `CA/${CA_VISIT}`, `GB/${GB_WORK}`];
    const items = await listOf(user.idToken);
    assert.deepEqual(keysOf(items), expected);
    assert.deepEqual(items.map((i) => i.countryName), ["United Kingdom", "Canada", "United Kingdom"]);

    // Re-saving the oldest keeps its place.
    await api.call("PUT", path("GB", GB_WORK), user.idToken);
    assert.deepEqual(keysOf(await listOf(user.idToken)), expected);
  });
});

// ============================================
// Unknown and hidden visas
// ============================================

describe("saved destinations: unknown and hidden visas (#146)", () => {
  test("saving an unknown visa, an unknown country or a malformed key -> 404, nothing stored", async () => {
    const user = await seedClient("emu146-unknown");
    for (const p of [
      path("GB", "emu-146-does-not-exist"),
      path("ZZ", GB_WORK),
      path("GBR", GB_WORK),
      path("G1", GB_WORK),
      path("GB", "__reserved__"),
      path("GB", "x".repeat(201)),
    ]) {
      const r = await api.call("PUT", p, user.idToken);
      assert.equal(r.status, 404, `${p} -> ${JSON.stringify(r.body)}`);
      assert.equal(r.body.error, "NOT_FOUND");
    }
    assert.deepEqual(await storedSaveIds(user.uid), []);
  });

  test("saving a visa that is not publicly visible -> the same 404 as an unknown one, nothing stored", async () => {
    const user = await seedClient("emu146-hidden-save");
    const unknown = await api.call("PUT", path("GB", "emu-146-does-not-exist"), user.idToken);
    for (const id of Object.keys(HIDDEN)) {
      const r = await api.call("PUT", path("GB", id), user.idToken);
      assert.equal(r.status, 404, `${id} -> ${JSON.stringify(r.body)}`);
      // Same body: a hidden visa's existence does not leak.
      assert.deepEqual(r.body, unknown.body, id);
    }
    assert.deepEqual(await storedSaveIds(user.uid), []);
  });

  test("a saved visa that becomes hidden or is deleted leaves the list; the record stays, comes back, and can be removed", async () => {
    const user = await seedClient("emu146-hidden-list");
    await api.call("PUT", path("GB", GB_WORK), user.idToken);
    const saved = await api.call("PUT", path("GB", GB_TOGGLE), user.idToken);
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.deepEqual(keysOf(await listOf(user.idToken)), [`GB/${GB_TOGGLE}`, `GB/${GB_WORK}`]);

    try {
      // Each way a visa stops being publicly visible.
      for (const over of Object.values(HIDDEN)) {
        await seedVisa("GB", GB_TOGGLE, over);
        assert.deepEqual(keysOf(await listOf(user.idToken)), [`GB/${GB_WORK}`], JSON.stringify(over));
      }
      // Deleted outright.
      await withoutRules(async (db) => {
        await db.collection("countries").doc("GB").collection("visaTypes").doc(GB_TOGGLE).delete();
      });
      assert.deepEqual(keysOf(await listOf(user.idToken)), [`GB/${GB_WORK}`]);
      // The saved record is still there...
      assert.deepEqual(await storedSaveIds(user.uid), [`GB_${GB_TOGGLE}`, `GB_${GB_WORK}`].sort());

      // ...so it comes back, in its place, when the visa does.
      await seedVisa("GB", GB_TOGGLE);
      assert.deepEqual(keysOf(await listOf(user.idToken)), [`GB/${GB_TOGGLE}`, `GB/${GB_WORK}`]);

      // And a save whose visa is hidden can still be removed.
      await seedVisa("GB", GB_TOGGLE, { isActive: false });
      const removed = await api.call("DELETE", path("GB", GB_TOGGLE), user.idToken);
      assert.equal(removed.status, 200, JSON.stringify(removed.body));
      assert.deepEqual(await storedSaveIds(user.uid), [`GB_${GB_WORK}`]);
    } finally {
      await seedVisa("GB", GB_TOGGLE);
    }
  });
});

// ============================================
// One user never reaches another user's saves
// ============================================

describe("saved destinations: users are isolated (#146)", () => {
  test("user A cannot see, add to or remove from user B's list", async () => {
    const a = await seedClient("emu146-a");
    const b = await seedClient("emu146-b");
    await api.call("PUT", path("GB", GB_WORK), b.idToken);
    await api.call("PUT", path("CA", CA_VISIT), b.idToken);

    // A sees nothing of B's.
    assert.deepEqual(await listOf(a.idToken), []);

    // A naming B in the query or the body changes nothing: the routes take no user id.
    const spoofedList = await api.call("GET", `${BASE}?userId=${b.uid}&uid=${b.uid}`, a.idToken);
    assert.equal(spoofedList.status, 200);
    assert.deepEqual(spoofedList.body.data, []);
    const spoofedSave = await api.call("PUT", `${path("GB", GB_STUDY)}?userId=${b.uid}`, a.idToken, { userId: b.uid, uid: b.uid });
    assert.equal(spoofedSave.status, 200, JSON.stringify(spoofedSave.body));
    assert.deepEqual(await storedSaveIds(a.uid), [`GB_${GB_STUDY}`]);

    // A "removing" B's save removes nothing of B's.
    const del = await api.call("DELETE", `${path("GB", GB_WORK)}?userId=${b.uid}`, a.idToken, { userId: b.uid });
    assert.equal(del.status, 200);
    assert.deepEqual(await storedSaveIds(b.uid), [`CA_${CA_VISIT}`, `GB_${GB_WORK}`]);
    assert.deepEqual(keysOf(await listOf(b.idToken)), [`CA/${CA_VISIT}`, `GB/${GB_WORK}`]);
  });

  test("there is no route for another user's saves", async () => {
    const a = await seedClient("emu146-route-a");
    const b = await seedClient("emu146-route-b");
    await api.call("PUT", path("GB", GB_WORK), b.idToken);
    const r = await api.call("GET", `/users/${b.uid}/saved-destinations`, a.idToken);
    assert.equal(r.status, 404, JSON.stringify(r.body));
  });

  test("firestore.rules: no client can read or write the subcollection directly, not even the owner or an admin", async () => {
    const owner = await seedClient("emu146-rules-owner");
    const other = await seedClient("emu146-rules-other");
    await api.call("PUT", path("GB", GB_WORK), owner.idToken);
    const docPath = `users/${owner.uid}/savedDestinations/GB_${GB_WORK}`;
    const colPath = `users/${owner.uid}/savedDestinations`;

    const actors: Array<[string, any]> = [
      ["owner", await clientDb(owner.uid)],
      ["another user", await clientDb(other.uid)],
      ["admin claim", await clientDb(other.uid, { role: "admin", admin: true })],
    ];
    for (const [who, db] of actors) {
      assert.equal(await isDenied(db.doc(docPath).get()), true, `${who} get`);
      assert.equal(await isDenied(db.collection(colPath).get()), true, `${who} list`);
      assert.equal(await isDenied(db.collectionGroup("savedDestinations").get()), true, `${who} collection group`);
      assert.equal(
        await isDenied(db.doc(`${colPath}/GB_forged`).set({ countryCode: "GB", visaId: "forged", savedAt: new Date() })),
        true,
        `${who} create`
      );
      assert.equal(await isDenied(db.doc(docPath).update({ visaId: "changed" })), true, `${who} update`);
      assert.equal(await isDenied(db.doc(docPath).delete()), true, `${who} delete`);
    }
    // Nothing changed.
    assert.deepEqual(await storedSaveIds(owner.uid), [`GB_${GB_WORK}`]);
  });
});

// ============================================
// The 200 cap
// ============================================

describe("saved destinations: at most 200 per user (#146)", () => {
  test("the 201st save -> 409 SAVED_LIMIT_REACHED, nothing stored; re-saving and removing still work", async () => {
    const user = await seedClient("emu146-cap");
    await seedSaves(user.uid, 199);

    // The 200th is allowed.
    const twoHundredth = await api.call("PUT", path("GB", GB_WORK), user.idToken);
    assert.equal(twoHundredth.status, 200, JSON.stringify(twoHundredth.body));
    assert.equal((await storedSaveIds(user.uid)).length, 200);

    // The 201st is refused with the agreed code and a plain message.
    const over = await api.call("PUT", path("GB", GB_STUDY), user.idToken);
    assert.equal(over.status, 409, JSON.stringify(over.body));
    assert.equal(over.body.success, false);
    assert.equal(over.body.error, "SAVED_LIMIT_REACHED");
    assert.match(over.body.message, /200 destinations/);
    const ids = await storedSaveIds(user.uid);
    assert.equal(ids.length, 200);
    assert.ok(!ids.includes(`GB_${GB_STUDY}`));

    // Something already saved still "saves" at the cap (it adds nothing).
    const resave = await api.call("PUT", path("GB", GB_WORK), user.idToken);
    assert.equal(resave.status, 200, JSON.stringify(resave.body));

    // Removing one makes room again.
    assert.equal((await api.call("DELETE", path("GB", GB_WORK), user.idToken)).status, 200);
    const afterRoom = await api.call("PUT", path("GB", GB_STUDY), user.idToken);
    assert.equal(afterRoom.status, 200, JSON.stringify(afterRoom.body));
    assert.equal((await storedSaveIds(user.uid)).length, 200);
  });

  test("saves sent at the same moment cannot pass the cap together", async () => {
    const user = await seedClient("emu146-cap-race");
    await seedSaves(user.uid, 199);
    const results = await Promise.all(RACE.map((id) => api.call("PUT", path("GB", id), user.idToken)));
    const statuses = results.map((r) => r.status).sort();
    // Exactly one fits; the rest are refused with the cap code.
    assert.deepEqual(statuses, [200, 409, 409, 409], JSON.stringify(results.map((r) => r.body)));
    assert.equal((await storedSaveIds(user.uid)).length, 200);
  });
});

// ============================================
// Read-only plan
// ============================================

describe("saved destinations: read-only plan (#146)", () => {
  test("PUT and DELETE get the existing 402 write block; GET still works", async () => {
    const user = await seedClient("emu146-readonly");
    // Saved while the plan was active.
    assert.equal((await api.call("PUT", path("GB", GB_WORK), user.idToken)).status, 200);

    // The plan lapses: the entitlements cache the middleware reads says so.
    await withoutRules(async (db) => {
      await db.collection("entitlements").doc(user.uid).set({
        subscriberType: "client", subscriberId: user.uid, planId: "emu-146-plan",
        status: "canceled", features: [], limits: {},
      });
    });

    const put = await api.call("PUT", path("GB", GB_STUDY), user.idToken);
    assert.equal(put.status, 402, JSON.stringify(put.body));
    assert.equal(put.body.error, "UPGRADE_REQUIRED");
    const del = await api.call("DELETE", path("GB", GB_WORK), user.idToken);
    assert.equal(del.status, 402, JSON.stringify(del.body));
    assert.equal(del.body.error, "UPGRADE_REQUIRED");

    // Nothing changed, and reading still works.
    assert.deepEqual(await storedSaveIds(user.uid), [`GB_${GB_WORK}`]);
    assert.deepEqual(keysOf(await listOf(user.idToken)), [`GB/${GB_WORK}`]);
  });
});

// ============================================
// Account deletion
// ============================================

describe("saved destinations: account deletion (#146)", () => {
  test("DELETE /users/me deletes the user's saves with the profile, and nobody else's", async () => {
    const leaving = await seedClient("emu146-leaving");
    const staying = await seedClient("emu146-staying");
    await api.call("PUT", path("GB", GB_WORK), leaving.idToken);
    await api.call("PUT", path("CA", CA_VISIT), leaving.idToken);
    await api.call("PUT", path("GB", GB_WORK), staying.idToken);
    assert.equal((await storedSaveIds(leaving.uid)).length, 2);

    const r = await api.call("DELETE", "/users/me", leaving.idToken);
    assert.equal(r.status, 200, JSON.stringify(r.body));

    assert.deepEqual(await storedSaveIds(leaving.uid), []);
    assert.equal((await (await adminDb()).collection("users").doc(leaving.uid).get()).exists, false);
    // The other user's save is untouched.
    assert.deepEqual(await storedSaveIds(staying.uid), [`GB_${GB_WORK}`]);
  });

  test("account deletion clears a full list (200 saves)", async () => {
    const user = await seedClient("emu146-leaving-full");
    await seedSaves(user.uid, 200);
    const r = await api.call("DELETE", "/users/me", user.idToken);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(await storedSaveIds(user.uid), []);
  });
});
