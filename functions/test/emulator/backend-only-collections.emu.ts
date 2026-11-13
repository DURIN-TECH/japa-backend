// ============================================
// Emulator test — deny-by-default for every backend-only collection
// ============================================
//
// Run with `npm run test:emulator`. Same pattern as firestore-rules.emu.ts and
// risk-signals.emu.ts: the repo's real firestore.rules, loaded by the emulator,
// exercised through @firebase/rules-unit-testing with real-shaped tokens.
//
// The AI batch added many collections that ONLY the backend (Admin SDK) may
// touch. firestore.rules has deliberately NO `match` for them, so Firestore's
// default-deny applies. This test pins that: if anyone later adds a match
// block (or a permissive wildcard) for one of these, a client could read
// assessments, conversations, extracted document data or rubrics directly, and
// this test fails.
//
// For each collection (and the subcollections the backend writes under it) a
// document is seeded with rules OFF, then every actor -- signed out, client,
// agent, owner, admin (claims as the backend sets them, plus the owner of the
// document where one is obvious) -- must be refused a get, a list, a create,
// an update and a delete. riskSignals is covered in depth by
// risk-signals.emu.ts and is repeated here only so this list is complete.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

import { anonymousDb, clientDb, isDenied, resetEmulators, rulesEnv, withoutRules } from "./helpers";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Top-level backend-only collections (names from src/utils/firebase.ts). */
const COLLECTIONS = [
  "riskSignals",
  "rubricReviewHistory",
  // Automatic rubric publishing (issue #201): the run record of each version
  // and the audit of changes to the publish settings. Internal notes: an
  // applicant (or anyone) must never read or write them from a client.
  "rubricPublishRuns",
  "rubricPublishSettingsHistory",
  // appConfig/{docId} is backend config. It now holds the automatic-publishing
  // kill switch (appConfig/rubricPublishSettings, issue #201), so a client that
  // could write it could turn automatic publishing on.
  "appConfig",
  "applicationAssessments",
  "aiConversations",
  "aiChatUsage",
  "documentChecks",
  "documentCheckCaps",
  "refusalAnalyses",
  "bulkReassessments",
  "assessmentBatches",
  "documentExtractions",
  "ruleChangeEvents",
  "ruleChangeNotices",
  "assessmentDebounce",
  "assessmentNotifications",
  "outcomeStatistics",
  "outcomeStatisticsReleases",
  "outcomeStatisticsRuns",
  "outcomeStatisticsRunRequests",
  // Rubric tree: the parent and its backend-only version subcollection.
  "visaRubrics",
  // AI message access (issue #172): approvals + the append-only audit trail.
  "aiMessageAccess",
  "aiMessageAccessAudit",
];

/** Subcollections the backend writes (parent collection, parent id, name). */
const SUBCOLLECTIONS: [string, string, string][] = [
  ["applicationAssessments", "seed", "proposedActions"],
  ["aiConversations", "seed", "messages"],
  ["riskSignals", "seed", "events"],
  ["visaRubrics", "seed", "rubricVersions"],
];

/** Who is asking. `uid` is the owner id seeded on documents so "own data" is tried too. */
const ACTORS: { name: string; claims: Record<string, unknown> | null }[] = [
  { name: "signed-out", claims: null },
  { name: "client", claims: { role: "client", agencyId: null, admin: false } },
  { name: "agent", claims: { role: "agent", agencyId: "agency-1", admin: false } },
  { name: "owner", claims: { role: "owner", agencyId: "agency-1", admin: false } },
  { name: "admin", claims: { role: "admin", agencyId: null, admin: true } },
];

const UID = "backend-only-user";

async function dbFor(actor: (typeof ACTORS)[number]): Promise<any> {
  return actor.claims ? clientDb(UID, actor.claims) : anonymousDb();
}

before(async () => {
  await resetEmulators();
  await withoutRules(async (db) => {
    // Seed docs that name the actor as owner, to prove ownership grants nothing.
    const owned = { userId: UID, uid: UID, applicationId: "app-1", agencyId: "agency-1", a: 1 };
    for (const c of COLLECTIONS) await db.collection(c).doc("seed").set(owned);
    for (const [c, id, sub] of SUBCOLLECTIONS) await db.collection(c).doc(id).collection(sub).doc("seed").set(owned);
  });
});

after(async () => {
  await (await rulesEnv()).cleanup();
});

describe("backend-only collections are denied to every client role", () => {
  for (const actor of ACTORS) {
    test(`${actor.name}: get, list, create, update and delete are refused on every collection`, async () => {
      const db = await dbFor(actor);
      const observed: Record<string, boolean> = {};
      for (const c of COLLECTIONS) {
        observed[`${c} get`] = await isDenied(db.collection(c).doc("seed").get());
        observed[`${c} list`] = await isDenied(db.collection(c).get());
        observed[`${c} query own`] = await isDenied(db.collection(c).where("userId", "==", UID).get());
        observed[`${c} create`] = await isDenied(db.collection(c).doc("new").set({ userId: UID, a: 1 }));
        observed[`${c} update`] = await isDenied(db.collection(c).doc("seed").update({ a: 2 }));
        observed[`${c} delete`] = await isDenied(db.collection(c).doc("seed").delete());
      }
      for (const [c, id, sub] of SUBCOLLECTIONS) {
        const col = db.collection(c).doc(id).collection(sub);
        observed[`${c}/${sub} get`] = await isDenied(col.doc("seed").get());
        observed[`${c}/${sub} list`] = await isDenied(col.get());
        observed[`${c}/${sub} create`] = await isDenied(col.doc("new").set({ a: 1 }));
        observed[`${c}/${sub} update`] = await isDenied(col.doc("seed").update({ a: 2 }));
        observed[`${c}/${sub} delete`] = await isDenied(col.doc("seed").delete());
      }
      // Collection-group reads must not be a side door either.
      // (`messages` is left out: that name is shared with the user-facing conversations rules.)
      for (const sub of ["proposedActions", "rubricVersions", "events"]) {
        observed[`group ${sub}`] = await isDenied(db.collectionGroup(sub).get());
      }
      const leaks = Object.entries(observed).filter(([, denied]) => !denied).map(([k]) => k);
      assert.deepEqual(leaks, [], `${actor.name} was NOT denied on: ${leaks.join(", ")}`);
    });
  }

  test("the seeded documents are still intact afterwards (denied writes changed nothing)", async () => {
    await withoutRules(async (db) => {
      for (const c of COLLECTIONS) {
        const snap = await db.collection(c).doc("seed").get();
        assert.equal(snap.exists, true, `${c}/seed must still exist`);
        assert.equal(snap.data().a, 1, `${c}/seed must be unchanged`);
        assert.equal((await db.collection(c).doc("new").get()).exists, false, `${c}/new must not exist`);
      }
    });
  });
});
