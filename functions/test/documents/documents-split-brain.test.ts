// ============================================
// Unit tests — the documents "split-brain" fix (issue #28)
// ============================================
//
// Run with `npm test`. Hermetic: NO network and NO emulator. Firestore is the
// in-memory fake (test/helpers/fake-firestore.ts).
//
// Background: the seeder used to write documents to
// `applications/{id}/documents` while the API reads the TOP-LEVEL `documents`
// collection, so nothing seeded was ever visible. These tests pin the fix:
//  - seed data: every document has an `applicationId` and a deterministic,
//    unique id; six applications have documents;
//  - seedDocuments() writes to `documents/{id}` only, a second run does not
//    duplicate, and legacy subcollection copies under SEEDED apps are removed
//    (other applications are left alone);
//  - the seeded per-application counters agree with the seeded documents, and
//    the apps whose counters are aspirational are exactly the documented list;
//  - the list endpoint (GET /applications/:id/documents) returns the seeded
//    documents through the real controller + service, is not broken by an
//    orphan document, and still refuses other clients / other agencies;
//  - the per-application limit count reads the top-level collection;
//  - the dead path cannot come back unnoticed: no `subcollections.documents`
//    helper, and no `match /documents/` block in firestore.rules.

// NOTE: utils/firebase must be imported BEFORE the seeder — it owns
// initializeApp(), and the seeder calls getFirestore() at module load.
import { collections, subcollections } from "../../src/utils/firebase";

import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { defineAbilitiesFor, ROLES } from "@durin-tech/authz";

import { fakeCollection, resetStore, store } from "../helpers/fake-firestore";
import {
  buildSeedApplications,
  buildSeedDocuments,
  seedDocumentId,
  seedDocuments,
  SEED_APPS_WITH_ASPIRATIONAL_DOCUMENT_COUNTERS,
} from "../../src/data/seed-portal-data";
import { documentService } from "../../src/services/document.service";
import {
  countApplicationDocuments,
  documentController,
} from "../../src/controllers/document.controller";
import { applicationService } from "../../src/services/application.service";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ============================================
// Helpers
// ============================================

/** The six seeded applications that have documents (app1,2,3,4,7,8). */
const APPS_WITH_DOCS = [
  "seed-app-001",
  "seed-app-002",
  "seed-app-003",
  "seed-app-004",
  "seed-app-007",
  "seed-app-008",
];

/**
 * A minimal Firestore stand-in for seedDocuments(): collection() backed by the
 * in-memory store, and a write batch that applies its set/delete on commit().
 */
function fakeDb(): any {
  return {
    collection: (name: string) => fakeCollection(name),
    batch() {
      const pending: (() => Promise<void>)[] = [];
      const batch = {
        set(ref: any, data: any) {
          pending.push(() => ref.set(data));
          return batch;
        },
        delete(ref: any) {
          pending.push(() => ref.delete());
          return batch;
        },
        async commit() {
          for (const write of pending) await write();
        },
      };
      return batch;
    },
  };
}

/** Store paths directly under the top-level `documents` collection. */
const topLevelDocPaths = () => [...store.keys()].filter((p) => /^documents\/[^/]+$/.test(p));
/** Store paths under any `applications/{id}/documents` subcollection. */
const subcollectionDocPaths = () =>
  [...store.keys()].filter((p) => /^applications\/[^/]+\/documents\//.test(p));

/** A minimal Express response that records status + JSON body. */
function fakeRes(): any {
  const res: any = { statusCode: 200, body: undefined };
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body: unknown) => {
    res.body = body;
    return res;
  };
  res.send = (body: unknown) => {
    res.body = body;
    return res;
  };
  return res;
}

/** Call GET /applications/:applicationId/documents as the given principal. */
async function listDocuments(
  applicationId: string,
  principal: { uid: string; role: any; agencyId: string | null }
): Promise<any> {
  const req: any = {
    userId: principal.uid,
    params: { applicationId },
    query: {},
    ability: defineAbilitiesFor(principal),
    authz: { role: principal.role },
  };
  const res = fakeRes();
  await documentController.getApplicationDocuments(req, res);
  return res;
}

// ============================================
// Setup: route every Firestore ref these paths reach to the fake
// ============================================

before(() => {
  // utils/firebase refs (limit count + applicationService.getApplicationById).
  (collections as any).documents = fakeCollection("documents");
  (collections as any).applications = fakeCollection("applications");
  // DocumentService keeps its own private ref to the same top-level collection.
  (documentService as any).collection = fakeCollection("documents");
});

beforeEach(() => {
  resetStore();
});

/** Put the seeded applications + documents in the fake store. */
async function seedStore(): Promise<void> {
  for (const app of buildSeedApplications()) store.set(`applications/${app.id}`, app as any);
  await seedDocuments(fakeDb());
}

// ============================================
// Seed data shape
// ============================================

describe("seed documents data (issue #28)", () => {
  test("every document has an applicationId and a deterministic, unique id", () => {
    const docs = buildSeedDocuments();
    assert.equal(docs.length, 34);
    for (const doc of docs) {
      assert.ok(doc.applicationId, `applicationId on ${doc.id}`);
      assert.equal(doc.id, seedDocumentId(doc.applicationId, doc.requirementId));
    }
    // Unique: one document per (application, requirement).
    assert.equal(new Set(docs.map((d) => d.id)).size, docs.length);
    // Deterministic: a second build yields the same ids in the same order.
    assert.deepEqual(
      buildSeedDocuments().map((d) => d.id),
      docs.map((d) => d.id)
    );
    assert.equal(seedDocumentId("seed-app-001", "req-passport"), "seed-app-001-doc-passport");
  });

  test("exactly the six expected applications have documents, all of them seeded apps", () => {
    const withDocs = [...new Set(buildSeedDocuments().map((d) => d.applicationId))].sort();
    assert.deepEqual(withDocs, APPS_WITH_DOCS);
    const appIds = new Set(buildSeedApplications().map((a) => a.id));
    for (const id of withDocs) assert.ok(appIds.has(id), `${id} is a seeded application`);
  });

  test("each document belongs to its application's client", () => {
    const owner = new Map(buildSeedApplications().map((a) => [a.id, a.userId]));
    for (const doc of buildSeedDocuments()) {
      assert.equal(doc.userId, owner.get(doc.applicationId), doc.id);
    }
  });

  test("seeded counters agree with the seeded documents, except the documented aspirational apps", () => {
    const docs = buildSeedDocuments();
    const aspirational: string[] = [];
    for (const app of buildSeedApplications()) {
      const mine = docs.filter((d) => d.applicationId === app.id);
      const actual = {
        uploaded: mine.length,
        verified: mine.filter((d) => d.status === "verified").length,
        rejected: mine.filter((d) => d.status === "rejected").length,
      };
      const seeded = {
        uploaded: app.documentsUploaded,
        verified: app.documentsVerified,
        rejected: app.documentsRejected,
      };
      if (mine.length === 0 && (seeded.uploaded || seeded.verified || seeded.rejected)) {
        // Non-zero counters with no documents behind them.
        aspirational.push(app.id);
        continue;
      }
      assert.deepEqual(seeded, actual, `counters of ${app.id}`);
      // Never more uploaded than required.
      assert.ok(app.documentsUploaded <= app.documentsRequired, `required of ${app.id}`);
    }
    assert.deepEqual(aspirational.sort(), [...SEED_APPS_WITH_ASPIRATIONAL_DOCUMENT_COUNTERS].sort());
  });
});

// ============================================
// seedDocuments(): where it writes, idempotency, legacy cleanup
// ============================================

describe("seedDocuments (issue #28)", () => {
  test("writes to the top-level documents collection, never the subcollection", async () => {
    const count = await seedDocuments(fakeDb());
    assert.equal(count, 34);
    assert.equal(topLevelDocPaths().length, 34);
    assert.deepEqual(subcollectionDocPaths(), []);
    const doc = store.get("documents/seed-app-001-doc-passport") as any;
    assert.equal(doc.applicationId, "seed-app-001");
    assert.equal(doc.id, "seed-app-001-doc-passport");
  });

  test("running the seed twice does not duplicate documents", async () => {
    await seedDocuments(fakeDb());
    const first = topLevelDocPaths().sort();
    await seedDocuments(fakeDb());
    assert.deepEqual(topLevelDocPaths().sort(), first);
    assert.equal(first.length, 34);
  });

  test("removes legacy subcollection copies under seeded apps only", async () => {
    // Two earlier (pre-fix) seed runs left random-id copies behind.
    store.set("applications/seed-app-001/documents/randomA", { applicationId: "seed-app-001" });
    store.set("applications/seed-app-001/documents/randomB", { applicationId: "seed-app-001" });
    store.set("applications/seed-ss-app-001/documents/randomC", { applicationId: "seed-ss-app-001" });
    // A non-seed application must never be touched by the seeder.
    store.set("applications/real-app-1/documents/keep", { applicationId: "real-app-1" });
    // Neither must other subcollections of a seeded app.
    store.set("applications/seed-app-001/notes/n1", { content: "keep" });

    await seedDocuments(fakeDb());

    assert.deepEqual(subcollectionDocPaths(), ["applications/real-app-1/documents/keep"]);
    assert.ok(store.has("applications/seed-app-001/notes/n1"));
    assert.equal(topLevelDocPaths().length, 34);
  });
});

// ============================================
// The API reads what the seeder wrote
// ============================================

describe("documents list endpoint over seeded data (issue #28)", () => {
  test("the service returns the seeded documents for each of the six applications", async () => {
    await seedStore();
    const expected = buildSeedDocuments();
    for (const appId of APPS_WITH_DOCS) {
      const got = await documentService.getApplicationDocuments(appId);
      const want = expected.filter((d) => d.applicationId === appId);
      assert.equal(got.length, want.length, appId);
      assert.deepEqual(got.map((d) => d.id).sort(), want.map((d) => d.id).sort());
      assert.ok(got.every((d) => d.applicationId === appId));
    }
    // An application with no documents gets an empty list, not an error.
    assert.deepEqual(await documentService.getApplicationDocuments("seed-app-005"), []);
  });

  test("the applicant gets their documents; the counters match the response", async () => {
    await seedStore();
    const res = await listDocuments("seed-app-001", {
      uid: "seed-user-client-001",
      role: ROLES.CLIENT,
      agencyId: null,
    });
    assert.equal(res.statusCode, 200);
    const app = buildSeedApplications().find((a) => a.id === "seed-app-001")!;
    assert.equal(res.body.data.length, app.documentsUploaded);
    assert.equal(
      res.body.data.filter((d: any) => d.status === "verified").length,
      app.documentsVerified
    );
  });

  test("an orphan document (no matching application) does not break the list", async () => {
    await seedStore();
    // Orphans: one pointing at a missing application, one with no applicationId.
    store.set("documents/orphan-1", {
      id: "orphan-1",
      applicationId: "no-such-application",
      userId: "seed-user-client-001",
      status: "uploaded",
    });
    store.set("documents/orphan-2", { id: "orphan-2", userId: "seed-user-client-001" });

    const res = await listDocuments("seed-app-001", {
      uid: "seed-user-client-001",
      role: ROLES.CLIENT,
      agencyId: null,
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.length, 5);
    assert.ok(res.body.data.every((d: any) => !d.id.startsWith("orphan")));

    // Listing the orphan's (missing) application is a clean 404, not a 500.
    const missing = await listDocuments("no-such-application", {
      uid: "seed-user-client-001",
      role: ROLES.CLIENT,
      agencyId: null,
    });
    assert.equal(missing.statusCode, 404);
  });

  test("access is unchanged: admin and same-agency staff may list, others may not", async () => {
    await seedStore();
    const admin = await listDocuments("seed-app-001", { uid: "uid-admin", role: ROLES.ADMIN, agencyId: null });
    assert.equal(admin.statusCode, 200);
    const assigned = await listDocuments("seed-app-001", {
      uid: "seed-user-agent-001",
      role: ROLES.AGENT,
      agencyId: "seed-agency-001",
    });
    assert.equal(assigned.statusCode, 200);
    const owner = await listDocuments("seed-app-001", {
      uid: "seed-user-owner-001",
      role: ROLES.OWNER,
      agencyId: "seed-agency-001",
    });
    assert.equal(owner.statusCode, 200);

    // Another applicant, and staff of a different agency, are refused.
    const otherClient = await listDocuments("seed-app-001", {
      uid: "seed-user-client-002",
      role: ROLES.CLIENT,
      agencyId: null,
    });
    assert.equal(otherClient.statusCode, 403);
    const otherOwner = await listDocuments("seed-app-001", {
      uid: "uid-other-owner",
      role: ROLES.OWNER,
      agencyId: "other-agency",
    });
    assert.equal(otherOwner.statusCode, 403);
    const otherAgent = await listDocuments("seed-app-001", {
      uid: "uid-other-agent",
      role: ROLES.AGENT,
      agencyId: "other-agency",
    });
    assert.equal(otherAgent.statusCode, 403);
  });
});

// ============================================
// Per-application limit count
// ============================================

describe("countApplicationDocuments (issue #28)", () => {
  test("counts the top-level documents of that application only", async () => {
    await seedStore();
    assert.equal(await countApplicationDocuments("seed-app-001"), 5);
    assert.equal(await countApplicationDocuments("seed-app-004"), 7);
    assert.equal(await countApplicationDocuments("seed-app-005"), 0);
  });

  test("ignores anything in the old subcollection path", async () => {
    store.set("applications/app-x/documents/legacy", { applicationId: "app-x" });
    assert.equal(await countApplicationDocuments("app-x"), 0);
    store.set("documents/d1", { applicationId: "app-x" });
    assert.equal(await countApplicationDocuments("app-x"), 1);
  });
});

// ============================================
// The second path cannot be reintroduced unnoticed
// ============================================

describe("no second documents path (issue #28)", () => {
  test("subcollections.documents() is gone", () => {
    assert.equal((subcollections as any).documents, undefined);
  });

  test("firestore.rules has no documents match (nested or top-level)", () => {
    const rules = fs.readFileSync(path.resolve(__dirname, "../../../firestore.rules"), "utf8");
    // Strip comments so the explanatory notes do not count.
    const code = rules.replace(/\/\/.*$/gm, "");
    assert.equal(/match\s+\/documents\//.test(code), false);
  });

  test("setup check: applicationService reads the fake applications collection", async () => {
    // Guards the setup above: getApplicationById must read the fake store.
    store.set("applications/a1", { id: "a1", userId: "u1" });
    assert.deepEqual(await applicationService.getApplicationById("a1"), { id: "a1", userId: "u1" });
  });
});
