// ============================================
// Emulator tests — a client can only register, and get download links for,
// storage objects under its own upload prefix (issue #141)
// ============================================
//
// Run with `npm run test:emulator` (Auth + Firestore + Storage emulators, the
// real Express app, real ID tokens from the Auth emulator, real objects in the
// Storage emulator).
//
// WHAT THESE TESTS PROVE, AND WHAT THEY DO NOT
// The emulator holds no service-account key, so a real signed URL cannot be
// minted here. `recordSigning()` (./storage-helpers.ts) therefore replaces the
// library's `File#getSignedUrl` with a recorder. Each test asserts three
// things at the points that matter:
//   1. the HTTP status of the registration request,
//   2. what was STORED (the Firestore record the download path later reads),
//   3. which object names REACHED the signing call when the download / list
//      endpoint was then used.
// (3) is the security fact: on a deployed backend, every path that reaches
// that call comes back to the caller as a working download link. The tests do
// not prove anything about the signature itself.
//
// Each security test gathers what it observed into one object and compares it
// with the secure outcome, so a regression prints every observed value at once.
//
// The cast (all roles come from server-written custom claims):
//   client   — applicant on `appClient`; owns the objects others must not reach
//   agent    — the agent ASSIGNED to appClient, member of the agency
//   owner    — owner of that agency
//   admin    — platform admin
//   other    — a second, unrelated client with their own application
//   outsider — an independent agent with their own client case, unrelated to
//              `client`, `agent` or the agency

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { resetEmulators, rulesEnv, RunningApi, signUp, startApi, TestAccount, withoutRules } from "./helpers";
import {
  clearBucket,
  FAKE_SIGNED_PREFIX,
  objectExists,
  putObject,
  recordSigning,
  SigningRecorder,
  storageRulesEnv,
  withClaims,
} from "./storage-helpers";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ============================================
// Fixtures
// ============================================

let api: RunningApi;
let signing: SigningRecorder;

/** Accounts by the part they play (see the header). */
const who: Record<string, TestAccount> = {};
/** A current ID token (with role claims) for each account. */
const token: Record<string, string> = {};

const AGENCY = "agency-141";
const APP_CLIENT = "app-client-141"; // client's case, assigned to `agent`, in AGENCY
const APP_OTHER = "app-other-141"; // other's own case, nobody assigned
const APP_OUTSIDER = "app-outsider-141"; // a case of `outsiderClient`, assigned to `outsider`

/** Objects that exist in the bucket and that the wrong caller must never reach. */
const victim = {
  /** client's application document. */
  clientDocument: "",
  /** agent's verification document. */
  agentVerification: "",
  /** A backend-only object (written by a backend job, never by a client). */
  guidanceSnapshot: "guidance-snapshots/source-1/0123abcd.json",
  /** The agency's compliance (KYC) document. */
  complianceDocument: "",
};

/** A file name in the shape the upload-URL endpoints issue: `<uuid>_<name>`. */
const issuedName = (name: string) => `${randomUUID()}_${name}`;

/** Admin SDK Firestore (lazy: the Admin app must initialise after setup.ts). */
async function adminDb(): Promise<any> {
  return (await import("../../src/utils/firebase")).db;
}

/** Write an application document as the backend would have. */
async function seedApplication(id: string, fields: Record<string, unknown>): Promise<void> {
  await (await adminDb())
    .collection("applications")
    .doc(id)
    .set({
      id,
      status: "in_progress",
      documentsUploaded: 0,
      documentsVerified: 0,
      documentsRejected: 0,
      clientName: "Test Client",
      createdAt: new Date(),
      updatedAt: new Date(),
      ...fields,
    });
}

/** Write an agent profile document for an account. */
async function seedAgentDoc(account: TestAccount, fields: Record<string, unknown> = {}): Promise<string> {
  const id = `agent-${account.uid}`;
  await (await adminDb())
    .collection("agents")
    .doc(id)
    .set({
      id,
      userId: account.uid,
      displayName: "Agent",
      verificationStatus: "pending",
      createdAt: new Date(),
      updatedAt: new Date(),
      ...fields,
    });
  return id;
}

/** The agent profile document of an account, read with the Admin SDK. */
async function agentDoc(account: TestAccount): Promise<any> {
  return (await (await adminDb()).collection("agents").doc(`agent-${account.uid}`).get()).data();
}

/** Every `documents` record registered against an application. */
async function documentsOf(applicationId: string): Promise<any[]> {
  const snap = await (await adminDb()).collection("documents").where("applicationId", "==", applicationId).get();
  return snap.docs.map((d: any) => ({ id: d.id, ...d.data() }));
}

/** Body of a POST /documents registration. */
function registration(applicationId: string, storagePath: unknown, extra: Record<string, unknown> = {}) {
  return {
    applicationId,
    requirementId: "req-passport",
    fileName: "passport.pdf",
    fileType: "application/pdf",
    fileSizeMb: 0.1,
    storagePath,
    ...extra,
  };
}

before(async () => {
  await rulesEnv();
  await storageRulesEnv();
  await resetEmulators();
  await clearBucket();
  signing = recordSigning();
  api = await startApi();

  for (const name of ["client", "agent", "owner", "admin", "other", "outsider", "outsiderClient"]) {
    who[name] = await signUp(`sp-${name.toLowerCase()}`);
    await withoutRules(async (db) => {
      await db.collection("users").doc(who[name].uid).set({
        id: who[name].uid,
        email: who[name].email,
        firstName: name,
        lastName: "Test",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    });
  }

  // ---- The agency, its owner, and its member agent.
  const db = await adminDb();
  await db.collection("agencies").doc(AGENCY).set({
    id: AGENCY,
    name: "Agency 141",
    ownerId: who.owner.uid,
    status: "approved",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await seedAgentDoc(who.owner, { agencyId: AGENCY, agencyRole: "owner" });
  await seedAgentDoc(who.agent, { agencyId: AGENCY, agencyRole: "agent" });
  await seedAgentDoc(who.outsider); // independent agent
  await seedAgentDoc(who.admin); // so the admin can also be tried on the agent-only routes

  // ---- Roles, as custom claims.
  token.client = await withClaims(who.client, { role: "client", agencyId: null, admin: false });
  token.other = await withClaims(who.other, { role: "client", agencyId: null, admin: false });
  token.outsiderClient = await withClaims(who.outsiderClient, { role: "client", agencyId: null, admin: false });
  token.agent = await withClaims(who.agent, { role: "agent", agencyId: AGENCY, admin: false });
  token.owner = await withClaims(who.owner, { role: "owner", agencyId: AGENCY, admin: false });
  token.outsider = await withClaims(who.outsider, { role: "agent", agencyId: null, admin: false });
  token.admin = await withClaims(who.admin, { role: "admin", agencyId: null, admin: true });

  // ---- Applications.
  await seedApplication(APP_CLIENT, { userId: who.client.uid, agentId: who.agent.uid, agencyId: AGENCY });
  await seedApplication(APP_OTHER, { userId: who.other.uid });
  await seedApplication(APP_OUTSIDER, { userId: who.outsiderClient.uid, agentId: who.outsider.uid });

  // ---- Objects that already exist in the bucket.
  victim.clientDocument = `documents/${who.client.uid}/${APP_CLIENT}/${issuedName("bank-statement.pdf")}`;
  victim.agentVerification = `verification/${who.agent.uid}/${issuedName("licence.pdf")}`;
  victim.complianceDocument = `compliance/${AGENCY}/idDocument/${issuedName("id.pdf")}`;
  for (const path of Object.values(victim)) await putObject(path);
});

after(async () => {
  signing.restore();
  await api.close();
  await (await rulesEnv()).cleanup();
  await (await storageRulesEnv()).cleanup();
});

beforeEach(() => signing.clear());

// ============================================
// Path (a): agent verification documents
//   POST / GET / DELETE /agents/me/verification/documents
// ============================================

describe("path (a): agent verification documents", () => {
  test("an agent cannot register an object outside their own verification prefix, and gets no link to it", async () => {
    const foreign = Object.values(victim);
    const statuses: number[] = [];
    for (const storagePath of foreign) {
      statuses.push((await api.call("POST", "/agents/me/verification/documents", token.outsider, { storagePath })).status);
    }
    const stored = (await agentDoc(who.outsider)).verificationDocuments ?? [];
    const list = await api.call("GET", "/agents/me/verification/documents", token.outsider);

    assert.deepEqual(
      {
        registrationStatuses: statuses,
        storedPaths: stored,
        pathsThatReachedSigning: signing.readPaths(),
        linksReturned: (list.body.data ?? []).filter((d: any) => d.downloadUrl).map((d: any) => d.storagePath),
      },
      {
        registrationStatuses: foreign.map(() => 400),
        storedPaths: [],
        pathsThatReachedSigning: [],
        linksReturned: [],
      }
    );
  });

  test("an admin cannot register a backend-only object either", async () => {
    const res = await api.call("POST", "/agents/me/verification/documents", token.admin, {
      storagePath: victim.guidanceSnapshot,
    });
    assert.deepEqual(
      { status: res.status, stored: (await agentDoc(who.admin)).verificationDocuments ?? [] },
      { status: 400, stored: [] }
    );
  });

  test("a path that is not a plain key under the caller's prefix is refused", async () => {
    const me = who.outsider.uid;
    const name = issuedName("licence.pdf");
    await putObject(`verification/${me}/${name}`);
    const malformed: unknown[] = [
      `gs://any-bucket/verification/${me}/${name}`, // scheme + bucket
      `https://storage.googleapis.com/b/verification/${me}/${name}`, // URL
      `/verification/${me}/${name}`, // leading slash
      `verification/${me}/../${who.agent.uid}/${name}`, // dot-dot segment
      `verification/${me}//${name}`, // empty segment
      `verification/${me}/sub/${name}`, // deeper than what is issued
      `verification/${me}/`, // the prefix itself
      { path: `verification/${me}/${name}` }, // not a string
      [`verification/${me}/${name}`], // not a string
    ];
    const statuses: number[] = [];
    for (const storagePath of malformed) {
      statuses.push((await api.call("POST", "/agents/me/verification/documents", token.outsider, { storagePath })).status);
    }
    assert.deepEqual(
      { statuses, stored: (await agentDoc(who.outsider)).verificationDocuments ?? [] },
      { statuses: malformed.map(() => 400), stored: [] }
    );
  });

  test("a record that already holds a foreign path is never signed, and removing it does not delete the object", async () => {
    // Data as it could have been written before the path was validated.
    const foreign = [victim.agentVerification, victim.guidanceSnapshot, victim.clientDocument];
    await (await adminDb())
      .collection("agents")
      .doc(`agent-${who.outsider.uid}`)
      .update({ verificationDocuments: foreign });

    const list = await api.call("GET", "/agents/me/verification/documents", token.outsider);
    const removals: number[] = [];
    for (const p of foreign) {
      removals.push(
        (await api.call("DELETE", `/agents/me/verification/documents?storagePath=${encodeURIComponent(p)}`, token.outsider))
          .status
      );
    }

    assert.deepEqual(
      {
        listStatus: list.status,
        pathsThatReachedSigning: signing.readPaths(),
        linksReturned: list.body.data.filter((d: any) => d.downloadUrl).length,
        // The entries are still listed (without a link) so the agent can see
        // and remove them.
        listed: list.body.data.map((d: any) => d.storagePath),
        removalStatuses: removals,
        recordAfterRemoval: (await agentDoc(who.outsider)).verificationDocuments,
        objectsStillThere: await Promise.all(foreign.map(objectExists)),
      },
      {
        listStatus: 200,
        pathsThatReachedSigning: [],
        linksReturned: 0,
        listed: foreign,
        removalStatuses: [200, 200, 200], // the bad entry is dropped from the caller's own record…
        recordAfterRemoval: [],
        objectsStillThere: [true, true, true], // …and the object it pointed at is left alone
      }
    );
  });

  test("an agent cannot delete an object by naming a path that is not theirs", async () => {
    const res = await api.call(
      "DELETE",
      `/agents/me/verification/documents?storagePath=${encodeURIComponent(victim.agentVerification)}`,
      token.outsider
    );
    assert.deepEqual(
      { status: res.status, victimObjectExists: await objectExists(victim.agentVerification) },
      { status: 400, victimObjectExists: true }
    );
  });

  test("the legitimate flow still works: upload URL, register, list with a link, remove", async () => {
    // 1. Upload URL: issued under the caller's own verification prefix.
    const up = await api.call("POST", "/agents/me/verification/upload-url", token.agent, {
      fileName: "my licence (2).pdf",
      contentType: "application/pdf",
    });
    assert.equal(up.status, 200, JSON.stringify(up.body));
    const storagePath: string = up.body.data.storagePath;
    assert.match(storagePath, new RegExp(`^verification/${who.agent.uid}/[0-9a-f-]{36}_my_licence__2_\\.pdf$`));

    // 2. The client PUTs the bytes to the signed URL (stand-in: backend write).
    await putObject(storagePath);

    // 3. Register exactly the path that was issued.
    const reg = await api.call("POST", "/agents/me/verification/documents", token.agent, { storagePath });
    assert.equal(reg.status, 200, JSON.stringify(reg.body));
    assert.deepEqual((await agentDoc(who.agent)).verificationDocuments, [storagePath]);

    // 4. List: a link, signed for that path and no other.
    signing.clear();
    const list = await api.call("GET", "/agents/me/verification/documents", token.agent);
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.data, [{ storagePath, downloadUrl: `${FAKE_SIGNED_PREFIX}${storagePath}?action=read` }]);
    assert.deepEqual(signing.readPaths(), [storagePath]);

    // 5. Remove: the record entry and the object both go.
    const del = await api.call(
      "DELETE",
      `/agents/me/verification/documents?storagePath=${encodeURIComponent(storagePath)}`,
      token.agent
    );
    assert.equal(del.status, 200, JSON.stringify(del.body));
    assert.deepEqual((await agentDoc(who.agent)).verificationDocuments, []);
    assert.equal(await objectExists(storagePath), false);
  });
});

// ============================================
// Path (b): application documents
//   POST /documents, GET /documents/:id/download, DELETE /documents/:id
// ============================================

describe("path (b): application documents", () => {
  test("a client cannot register another user's object (or a backend-only one) on their own application", async () => {
    const foreign = Object.values(victim);
    const statuses: number[] = [];
    for (const storagePath of foreign) {
      statuses.push((await api.call("POST", "/documents", token.other, registration(APP_OTHER, storagePath))).status);
    }
    // Whatever got stored, ask for a download link for it.
    const stored = await documentsOf(APP_OTHER);
    for (const doc of stored) await api.call("GET", `/documents/${doc.id}/download`, token.other);
    const app = (await (await adminDb()).collection("applications").doc(APP_OTHER).get()).data();

    assert.deepEqual(
      {
        registrationStatuses: statuses,
        storedPaths: stored.map((d) => d.storageUrl),
        pathsThatReachedSigning: signing.readPaths(),
        documentsUploadedCounter: app.documentsUploaded,
      },
      {
        registrationStatuses: foreign.map(() => 400),
        storedPaths: [],
        pathsThatReachedSigning: [],
        documentsUploadedCounter: 0,
      }
    );
  });

  test("an agent uploading on a client's behalf cannot register an object from a different client's folder", async () => {
    // `outsider` IS authorised for APP_OUTSIDER (assigned agent) and gives an
    // upload reason, so everything except the path is a valid on-behalf upload.
    const res = await api.call(
      "POST",
      "/documents",
      token.outsider,
      registration(APP_OUTSIDER, victim.clientDocument, { uploadReason: "Client emailed it", uploadSource: "email" })
    );
    assert.deepEqual(
      { status: res.status, stored: (await documentsOf(APP_OUTSIDER)).map((d) => d.storageUrl) },
      { status: 400, stored: [] }
    );
  });

  test("an admin cannot register a backend-only object on any application", async () => {
    const res = await api.call(
      "POST",
      "/documents",
      token.admin,
      registration(APP_OTHER, victim.guidanceSnapshot, { uploadReason: "Admin filing" })
    );
    assert.deepEqual(
      { status: res.status, stored: (await documentsOf(APP_OTHER)).map((d) => d.storageUrl) },
      { status: 400, stored: [] }
    );
  });

  test("the same object cannot be registered against a different application of the same client", async () => {
    // A second application of `client`; the object was issued for APP_CLIENT.
    const second = "app-client-141-second";
    await seedApplication(second, { userId: who.client.uid });
    const res = await api.call("POST", "/documents", token.client, registration(second, victim.clientDocument));
    assert.deepEqual(
      { status: res.status, stored: (await documentsOf(second)).length },
      { status: 400, stored: 0 }
    );
  });

  test("a record that already holds a foreign path is never signed, and deleting it leaves the object alone", async () => {
    // Records as they could have been written before the path was validated:
    // owned by `other`, on `other`'s application, pointing elsewhere.
    const db = await adminDb();
    const bad: Record<string, string> = {
      "legacy-bad-foreign": victim.clientDocument,
      "legacy-bad-backend": victim.guidanceSnapshot,
      // The seeder's placeholder shape (data/seed-portal-data.ts): a gs:// URL
      // to an object that never existed.
      "legacy-bad-seed": "gs://japa-platform.firebasestorage.app/documents/seed-app-001/passport.pdf",
    };
    for (const [id, storageUrl] of Object.entries(bad)) {
      await db.collection("documents").doc(id).set({
        applicationId: APP_OTHER,
        requirementId: "req-x",
        userId: who.other.uid,
        fileName: "x.pdf",
        fileType: "application/pdf",
        fileSizeMb: 0.1,
        storageUrl,
        status: "uploaded",
        resubmissionCount: 0,
        uploadedAt: new Date(),
        updatedAt: new Date(),
        uploadedByUserId: who.other.uid,
      });
    }

    const downloads: Record<string, number> = {};
    for (const id of Object.keys(bad)) {
      // As the record's owner, and as an admin: nobody gets a link.
      downloads[`${id}:owner`] = (await api.call("GET", `/documents/${id}/download`, token.other)).status;
      downloads[`${id}:admin`] = (await api.call("GET", `/documents/${id}/download`, token.admin)).status;
    }
    const deletes: number[] = [];
    for (const id of Object.keys(bad)) deletes.push((await api.call("DELETE", `/documents/${id}`, token.other)).status);

    assert.deepEqual(
      {
        downloadStatuses: downloads,
        pathsThatReachedSigning: signing.readPaths(),
        deleteStatuses: deletes,
        recordsLeft: (await documentsOf(APP_OTHER)).length,
        objectsStillThere: [await objectExists(victim.clientDocument), await objectExists(victim.guidanceSnapshot)],
      },
      {
        downloadStatuses: Object.fromEntries(Object.keys(downloads).map((k) => [k, 409])),
        pathsThatReachedSigning: [],
        deleteStatuses: [204, 204, 204], // the owner can still clear the bad record…
        recordsLeft: 0,
        objectsStillThere: [true, true], // …without the backend deleting what it pointed at
      }
    );
  });

  test("the legitimate self-upload still works, and applicant, assigned agent, agency owner and admin can all download", async () => {
    // 1. Upload URL for the client's own application: issued in the client's folder.
    const up = await api.call("POST", "/documents/upload-url", token.client, {
      applicationId: APP_CLIENT,
      fileName: "passport scan.pdf",
      contentType: "application/pdf",
    });
    assert.equal(up.status, 200, JSON.stringify(up.body));
    const storagePath: string = up.body.data.storagePath;
    assert.match(
      storagePath,
      new RegExp(`^documents/${who.client.uid}/${APP_CLIENT}/[0-9a-f-]{36}_passport_scan\\.pdf$`)
    );
    await putObject(storagePath); // stand-in for the client's PUT

    // 2. Register it.
    const reg = await api.call("POST", "/documents", token.client, registration(APP_CLIENT, storagePath));
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    const id: string = reg.body.data.id;
    assert.equal(reg.body.data.storageUrl, storagePath);
    assert.equal(reg.body.data.uploadedOnBehalf, false);

    // 3. Everyone who could download before still can; the link is for that object.
    signing.clear();
    const statuses: Record<string, number> = {};
    for (const role of ["client", "agent", "owner", "admin", "other", "outsider"]) {
      const res = await api.call("GET", `/documents/${id}/download`, token[role]);
      statuses[role] = res.status;
      if (res.status === 200) {
        assert.equal(res.body.data.downloadUrl, `${FAKE_SIGNED_PREFIX}${storagePath}?action=read`);
      }
    }
    assert.deepEqual(statuses, { client: 200, agent: 200, owner: 200, admin: 200, other: 403, outsider: 403 });
    assert.deepEqual(signing.readPaths(), [storagePath, storagePath, storagePath, storagePath]);

    // 4. The uploader can delete it; record and object both go.
    assert.equal((await api.call("DELETE", `/documents/${id}`, token.client)).status, 204);
    assert.equal(await objectExists(storagePath), false);
  });

  test("on-behalf uploads still work for the assigned agent, the agency owner and an admin, into the CLIENT's folder", async () => {
    for (const role of ["agent", "owner", "admin"]) {
      // 1. The upload URL is issued in the client's folder, not the staff member's.
      const up = await api.call("POST", "/documents/upload-url", token[role], {
        applicationId: APP_CLIENT,
        fileName: `${role}-filed.pdf`,
        contentType: "application/pdf",
      });
      assert.equal(up.status, 200, `${role}: ${JSON.stringify(up.body)}`);
      const storagePath: string = up.body.data.storagePath;
      assert.ok(storagePath.startsWith(`documents/${who.client.uid}/${APP_CLIENT}/`), `${role}: ${storagePath}`);
      await putObject(storagePath);

      // 2. Without a reason it is refused (unchanged rule) and nothing is stored.
      const noReason = await api.call("POST", "/documents", token[role], registration(APP_CLIENT, storagePath));
      assert.equal(noReason.status, 400, `${role}: ${JSON.stringify(noReason.body)}`);

      // 3. With a reason it is registered, owned by the client, authored by staff.
      const reg = await api.call(
        "POST",
        "/documents",
        token[role],
        registration(APP_CLIENT, storagePath, { uploadReason: "Client sent it by email", uploadSource: "email" })
      );
      assert.equal(reg.status, 201, `${role}: ${JSON.stringify(reg.body)}`);
      assert.deepEqual(
        {
          userId: reg.body.data.userId,
          uploadedByUserId: reg.body.data.uploadedByUserId,
          uploadedOnBehalf: reg.body.data.uploadedOnBehalf,
          storageUrl: reg.body.data.storageUrl,
        },
        { userId: who.client.uid, uploadedByUserId: who[role].uid, uploadedOnBehalf: true, storageUrl: storagePath }
      );

      // 4. The client can download what was filed for them.
      const dl = await api.call("GET", `/documents/${reg.body.data.id}/download`, token.client);
      assert.equal(dl.status, 200, `${role}: ${JSON.stringify(dl.body)}`);
    }
  });

  test("a caller with no access to the application is still refused before the path is looked at", async () => {
    const upload = await api.call("POST", "/documents/upload-url", token.outsider, {
      applicationId: APP_CLIENT,
      fileName: "x.pdf",
      contentType: "application/pdf",
    });
    const register = await api.call(
      "POST",
      "/documents",
      token.outsider,
      registration(APP_CLIENT, victim.clientDocument, { uploadReason: "none" })
    );
    assert.deepEqual({ upload: upload.status, register: register.status }, { upload: 403, register: 403 });
  });
});

// ============================================
// The routes that were already prefix-checked (confirmation)
//   POST /users/me/photo, POST /agencies/me/logo, POST /agencies/me/compliance/documents
// ============================================

describe("already prefix-checked routes stay closed", () => {
  test("profile photo, agency logo and compliance registration refuse a path outside the caller's prefix", async () => {
    const otherUsersPhoto = `users/${who.client.uid}/profile/${issuedName("me.png")}`;
    const otherAgencyLogo = `agency-logos/some-other-agency/${issuedName("logo.png")}`;
    const otherAgencyKyc = `compliance/some-other-agency/idDocument/${issuedName("id.pdf")}`;
    for (const p of [otherUsersPhoto, otherAgencyLogo, otherAgencyKyc]) await putObject(p, "x", "image/png");

    const photo = await api.call("POST", "/users/me/photo", token.other, { storagePath: otherUsersPhoto });
    const photoBackend = await api.call("POST", "/users/me/photo", token.other, { storagePath: victim.guidanceSnapshot });
    const logo = await api.call("POST", "/agencies/me/logo", token.owner, { storagePath: otherAgencyLogo });
    const logoBackend = await api.call("POST", "/agencies/me/logo", token.owner, { storagePath: victim.guidanceSnapshot });
    const kyc = await api.call("POST", "/agencies/me/compliance/documents", token.owner, {
      slot: "idDocument",
      storagePath: otherAgencyKyc,
    });
    const kycBackend = await api.call("POST", "/agencies/me/compliance/documents", token.owner, {
      slot: "idDocument",
      storagePath: victim.guidanceSnapshot,
    });

    assert.deepEqual(
      {
        photo: photo.status,
        photoBackend: photoBackend.status,
        logo: logo.status,
        logoBackend: logoBackend.status,
        kyc: kyc.status,
        kycBackend: kycBackend.status,
      },
      { photo: 400, photoBackend: 400, logo: 400, logoBackend: 400, kyc: 400, kycBackend: 400 }
    );
  });

  test("their legitimate flows still work", async () => {
    // Profile photo.
    const photoUp = await api.call("POST", "/users/me/photo/upload-url", token.other, {
      fileName: "me.png",
      contentType: "image/png",
    });
    assert.equal(photoUp.status, 200, JSON.stringify(photoUp.body));
    assert.ok(photoUp.body.data.storagePath.startsWith(`users/${who.other.uid}/profile/`));
    await putObject(photoUp.body.data.storagePath, "png", "image/png");
    const photo = await api.call("POST", "/users/me/photo", token.other, { storagePath: photoUp.body.data.storagePath });
    assert.equal(photo.status, 200, JSON.stringify(photo.body));

    // Agency logo.
    const logoUp = await api.call("POST", "/agencies/me/logo/upload-url", token.owner, {
      fileName: "logo.png",
      contentType: "image/png",
    });
    assert.equal(logoUp.status, 200, JSON.stringify(logoUp.body));
    assert.ok(logoUp.body.data.storagePath.startsWith(`agency-logos/${AGENCY}/`));
    await putObject(logoUp.body.data.storagePath, "png", "image/png");
    const logo = await api.call("POST", "/agencies/me/logo", token.owner, { storagePath: logoUp.body.data.storagePath });
    assert.equal(logo.status, 200, JSON.stringify(logo.body));

    // Compliance document, then the owner's and the admin's view of it.
    const kycUp = await api.call("POST", "/agencies/me/compliance/upload-url", token.owner, {
      slot: "cacDocument",
      fileName: "cac.pdf",
      contentType: "application/pdf",
    });
    assert.equal(kycUp.status, 200, JSON.stringify(kycUp.body));
    const kycPath: string = kycUp.body.data.storagePath;
    assert.ok(kycPath.startsWith(`compliance/${AGENCY}/cacDocument/`));
    await putObject(kycPath);
    const kyc = await api.call("POST", "/agencies/me/compliance/documents", token.owner, {
      slot: "cacDocument",
      storagePath: kycPath,
    });
    assert.equal(kyc.status, 200, JSON.stringify(kyc.body));

    signing.clear();
    const review = await api.call("GET", `/agencies/${AGENCY}/compliance`, token.admin);
    assert.equal(review.status, 200, JSON.stringify(review.body));
    assert.equal(review.body.data.documents.cacDocument, `${FAKE_SIGNED_PREFIX}${kycPath}?action=read`);
    assert.deepEqual(signing.readPaths(), [kycPath]);
  });

  test("a compliance record that already holds a foreign path is not signed for the reviewing admin", async () => {
    const db = await adminDb();
    const before = (await db.collection("agencies").doc(AGENCY).get()).data();
    await db
      .collection("agencies")
      .doc(AGENCY)
      .update({
        "compliance.idDocumentPath": victim.clientDocument,
        "compliance.proofOfAddressPath": victim.guidanceSnapshot,
      });
    signing.clear();
    const review = await api.call("GET", `/agencies/${AGENCY}/compliance`, token.admin);
    assert.deepEqual(
      {
        status: review.status,
        idDocument: review.body.data.documents.idDocument,
        proofOfAddress: review.body.data.documents.proofOfAddress,
        foreignPathsSigned: signing.readPaths().filter((p) => !p.startsWith(`compliance/${AGENCY}/`)),
      },
      { status: 200, idDocument: null, proofOfAddress: null, foreignPathsSigned: [] }
    );
    await db.collection("agencies").doc(AGENCY).set(before);
  });
});
