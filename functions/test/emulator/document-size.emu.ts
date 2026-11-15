// ============================================
// Emulator tests — upload size limit and a normal-sized review (issue #310)
// ============================================
//
// Run with `npm run test:emulator` (Auth + Firestore + Storage emulators on the
// alternate ports of ../firebase.emulator-test.json, the real Express app, real
// ID tokens, real objects in the Storage emulator). Nothing here can reach a
// real project (./setup.ts refuses to start otherwise) and NO model is called:
// the review part runs the real job over a scripted provider.
//
// PART 1 — POST /documents reads the object's REAL size from Cloud Storage.
//   The signed upload URL carries no size range and the request's `fileSizeMb`
//   used to be stored as sent (on dev a 21 MB object was registered as
//   0.001 MB). Each test puts a real object in the bucket, registers it, and
//   checks three things: the HTTP answer, whether the object is still there,
//   and what was written to Firestore.
//
// PART 2 — the acceptance case: an application holding 1 passport PDF, 3
//   bank-statement PDFs and 6 JPEG photos of 2-4 MB, on a rulebook that needs
//   five judgement calls (as UK Standard Visitor v2 did), is reviewed to
//   `succeeded` with the default settings (no `appConfig/aiSettings` document
//   exists in the emulator). The files are registered through the real
//   endpoint and read back from the Storage emulator by the real job. The
//   rulebook is a fictional fixture: nothing is drafted, extracted or published.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { resetEmulators, rulesEnv, RunningApi, signUp, startApi, TestAccount } from "./helpers";
import { clearBucket, objectExists, recordSigning, SigningRecorder, storageRulesEnv, withClaims } from "./storage-helpers";
import { criterion, fictionalRubric, routeARubric, ScriptedProvider } from "../ai-case-officer/harness";

/* eslint-disable @typescript-eslint/no-explicit-any */

const MB = 1024 * 1024;

// ============================================
// Fixtures
// ============================================

let api: RunningApi;
let signing: SigningRecorder;
let client: TestAccount;
let token = "";

/** The application the registration tests upload to. */
const APP = "app-size-310";
/** The application the review test uploads to and reviews. */
const APP_REVIEW = "app-review-310";

/** Admin SDK Firestore (lazy: the Admin app must initialise after setup.ts). */
async function adminDb(): Promise<any> {
  return (await import("../../src/utils/firebase")).db;
}

/** Admin SDK bucket (the Storage emulator). */
async function adminBucket(): Promise<any> {
  return (await import("../../src/utils/firebase")).storage.bucket();
}

/**
 * A file of exactly `size` bytes that starts like a PDF or a JPEG, carrying
 * the harness's "KEY:<name>" marker so the scripted provider can tell which
 * document a request holds. Zero padding after that: only the header and the
 * length matter here.
 */
function fileBytes(kind: "pdf" | "jpeg", key: string, size: number): Buffer {
  const out = Buffer.alloc(size);
  if (kind === "pdf") out.write("%PDF-1.4 ", 0, "latin1");
  else out.set([0xff, 0xd8, 0xff, 0xe0], 0);
  out.write(` KEY:${key} `, 10, "latin1");
  return out;
}

/**
 * Put an object where the upload-url endpoint would have issued a path for
 * `applicationId`, standing in for the client's PUT to the signed URL (which
 * the emulator cannot mint). Returns the object's path.
 */
async function upload(applicationId: string, name: string, bytes: Buffer, contentType: string): Promise<string> {
  const path = `documents/${client.uid}/${applicationId}/${randomUUID()}_${name}`;
  await (await adminBucket()).file(path).save(bytes, { resumable: false, contentType });
  return path;
}

/** Every `documents` record registered against an application. */
async function documentsOf(applicationId: string): Promise<any[]> {
  const snap = await (await adminDb()).collection("documents").where("applicationId", "==", applicationId).get();
  return snap.docs.map((d: any) => ({ id: d.id, ...d.data() }));
}

/** The record registered for one storage path, or undefined. */
async function recordFor(applicationId: string, storagePath: string): Promise<any> {
  return (await documentsOf(applicationId)).find((d) => d.storageUrl === storagePath);
}

/** Body of a POST /documents registration. */
function registration(applicationId: string, storagePath: string, extra: Record<string, unknown> = {}) {
  return { applicationId, requirementId: "req-passport", fileName: "file.pdf", fileType: "application/pdf", storagePath, ...extra };
}

/** Write an application as the backend would have. */
async function seedApplication(id: string, fields: Record<string, unknown> = {}): Promise<void> {
  await (await adminDb())
    .collection("applications")
    .doc(id)
    .set({
      id,
      userId: client.uid,
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

before(async () => {
  await rulesEnv();
  await storageRulesEnv();
  await resetEmulators();
  await clearBucket();
  // The emulator has no signing key; nothing here needs a signed URL, but a
  // code path that asks for one must not throw.
  signing = recordSigning();
  api = await startApi();

  // Resend's test address, never a real mailbox.
  client = await signUp("size310-client");
  await (await adminDb()).collection("users").doc(client.uid).set({
    id: client.uid,
    email: client.email,
    firstName: "Ada",
    lastName: "Lovelace",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  token = await withClaims(client, { role: "client", agencyId: null, admin: false });
  await seedApplication(APP);
});

after(async () => {
  signing.restore();
  await api.close();
  await (await rulesEnv()).cleanup();
  await (await storageRulesEnv()).cleanup();
});

// ============================================
// PART 1 — registration reads the real size
// ============================================

describe("POST /documents: the size comes from Cloud Storage, never from the request", () => {
  test("a file over the limit: 413 FILE_TOO_LARGE, the object is deleted, no record is created", async () => {
    const path = await upload(APP, "huge.pdf", fileBytes("pdf", "huge", 10 * MB + 1), "application/pdf");
    const before = (await documentsOf(APP)).length;
    // The request claims 0.001 MB, as the registration that slipped through on dev did.
    const res = await api.call("POST", "/documents", token, registration(APP, path, { fileSizeMb: 0.001 }));

    assert.deepEqual(
      {
        status: res.status,
        body: res.body,
        objectStillThere: await objectExists(path),
        recordsAdded: (await documentsOf(APP)).length - before,
      },
      {
        status: 413,
        body: {
          success: false,
          error: "FILE_TOO_LARGE",
          message: "This file is larger than 10 MB. Upload a smaller copy, for example a scan at a lower resolution.",
          details: { maxBytes: 10 * MB, sizeBytes: 10 * MB + 1, isImage: false },
        },
        objectStillThere: false,
        recordsAdded: 0,
      }
    );
    const app = (await (await adminDb()).collection("applications").doc(APP).get()).data();
    assert.equal(app.documentsUploaded, 0, "the application's document count did not move");
  });

  test("a file of exactly the limit is accepted", async () => {
    const path = await upload(APP, "at-limit.pdf", fileBytes("pdf", "at-limit", 10 * MB), "application/pdf");
    const res = await api.call("POST", "/documents", token, registration(APP, path));
    assert.equal(res.status, 201);
    assert.equal((await recordFor(APP, path)).fileSizeMb, 10);
    assert.equal(await objectExists(path), true);
  });

  test("within the limit, the stored fileSizeMb is the real size, whatever the request says", async () => {
    // Every value QA found accepted and stored as sent, plus "not sent at all".
    const claims: unknown[] = [0.001, -5, "big", 99999, undefined];
    for (const claimed of claims) {
      const path = await upload(APP, "bank.pdf", fileBytes("pdf", "bank", 2 * MB), "application/pdf");
      const extra = claimed === undefined ? {} : { fileSizeMb: claimed };
      const res = await api.call("POST", "/documents", token, registration(APP, path, extra));
      assert.equal(res.status, 201, `claimed ${String(claimed)}`);
      assert.equal(res.body.data.fileSizeMb, 2, `the response carries the real size (claimed ${String(claimed)})`);
      assert.equal((await recordFor(APP, path)).fileSizeMb, 2, `the record holds the real size (claimed ${String(claimed)})`);
    }
  });

  test("a small file is stored with its real size to the kilobyte, never 0", async () => {
    const path = await upload(APP, "tiny.pdf", fileBytes("pdf", "tiny", 300 * 1024), "application/pdf");
    const res = await api.call("POST", "/documents", token, registration(APP, path, { fileSizeMb: 21 }));
    assert.equal(res.status, 201);
    assert.equal((await recordFor(APP, path)).fileSizeMb, 0.293);
  });

  test("a missing object (a path that was never uploaded to) is a 400, not a 500, and creates nothing", async () => {
    const path = `documents/${client.uid}/${APP}/${randomUUID()}_never-uploaded.pdf`;
    const before = (await documentsOf(APP)).length;
    const res = await api.call("POST", "/documents", token, registration(APP, path, { fileSizeMb: 1 }));
    assert.deepEqual(
      { status: res.status, error: res.body.error, message: res.body.message, recordsAdded: (await documentsOf(APP)).length - before },
      { status: 400, error: "VALIDATION_ERROR", message: "File not found in storage", recordsAdded: 0 }
    );
  });

  test("an image is held to the lower limit the model accepts (7 MB); a 4 MB phone photo is fine", async () => {
    // 8 MB: under the 10 MB file limit, over what the model takes for one image.
    const tooBig = await upload(APP, "photo-big.jpg", fileBytes("jpeg", "photo-big", 8 * MB), "image/jpeg");
    const refused = await api.call("POST", "/documents", token, registration(APP, tooBig, { fileName: "photo-big.jpg", fileType: "image/jpeg" }));
    assert.deepEqual(
      { status: refused.status, error: refused.body.error, message: refused.body.message, details: refused.body.details, objectStillThere: await objectExists(tooBig), record: await recordFor(APP, tooBig) },
      {
        status: 413,
        error: "FILE_TOO_LARGE",
        message: "This file is larger than 7 MB. Upload a smaller copy, for example a scan at a lower resolution.",
        details: { maxBytes: 7 * MB, sizeBytes: 8 * MB, isImage: true },
        objectStillThere: false,
        record: undefined,
      }
    );

    const fine = await upload(APP, "photo.jpg", fileBytes("jpeg", "photo", 4 * MB), "image/jpeg");
    const accepted = await api.call("POST", "/documents", token, registration(APP, fine, { fileName: "photo.jpg", fileType: "image/jpeg" }));
    assert.equal(accepted.status, 201);
    assert.equal((await recordFor(APP, fine)).fileSizeMb, 4);
  });

  test("the image limit follows what Storage recorded, not only what the request declares", async () => {
    // Uploaded as a JPEG, registered as if it were a PDF: still an image.
    const path = await upload(APP, "photo-as-pdf.jpg", fileBytes("jpeg", "sneaky", 8 * MB), "image/jpeg");
    const res = await api.call("POST", "/documents", token, registration(APP, path, { fileType: "application/pdf" }));
    assert.equal(res.status, 413);
    assert.equal(res.body.details.isImage, true);
    assert.equal(await objectExists(path), false);
  });

  test("the same check applies to an upload made against a document request", async () => {
    // No `requirementId`: the upload answers an agent's ask (`documentRequestId`).
    const base = { applicationId: APP, documentRequestId: "docreq-310", fileName: "statement.pdf", fileType: "application/pdf" };

    const tooBig = await upload(APP, "statement-big.pdf", fileBytes("pdf", "st-big", 11 * MB), "application/pdf");
    const refused = await api.call("POST", "/documents", token, { ...base, storagePath: tooBig, fileSizeMb: 1 });
    assert.deepEqual(
      { status: refused.status, error: refused.body.error, objectStillThere: await objectExists(tooBig), record: await recordFor(APP, tooBig) },
      { status: 413, error: "FILE_TOO_LARGE", objectStillThere: false, record: undefined }
    );

    const fine = await upload(APP, "statement.pdf", fileBytes("pdf", "st", 3 * MB), "application/pdf");
    const accepted = await api.call("POST", "/documents", token, { ...base, storagePath: fine, fileSizeMb: 0.001 });
    assert.equal(accepted.status, 201);
    const record = await recordFor(APP, fine);
    assert.deepEqual({ size: record.fileSizeMb, requirementId: record.requirementId }, { size: 3, requirementId: "docreq:docreq-310" });
  });

  test("an oversized object that an OLDER record already points at is refused again but not deleted", async () => {
    // A record written before this check existed (the 21 MB case on dev).
    const path = await upload(APP, "legacy.pdf", fileBytes("pdf", "legacy", 12 * MB), "application/pdf");
    await (await adminDb()).collection("documents").doc("legacy-310").set({
      applicationId: APP,
      requirementId: "req-legacy",
      userId: client.uid,
      fileName: "legacy.pdf",
      fileType: "application/pdf",
      fileSizeMb: 0.001,
      storageUrl: path,
      status: "uploaded",
      resubmissionCount: 0,
      uploadedAt: new Date(),
      updatedAt: new Date(),
    });
    const res = await api.call("POST", "/documents", token, registration(APP, path));
    assert.deepEqual(
      { status: res.status, objectStillThere: await objectExists(path), records: (await documentsOf(APP)).filter((d) => d.storageUrl === path).length },
      { status: 413, objectStillThere: true, records: 1 }
    );
  });
});

// ============================================
// PART 2 — an ordinary application is reviewed
// ============================================

describe("readiness review of a normal-sized application, on the emulators", () => {
  test("1 passport PDF, 3 bank statements and 6 photos of 2-4 MB: succeeded, every document read, no cap code", async () => {
    // ---- the application, on a fictional route whose rulebook needs 5 judgement calls ----
    await seedApplication(APP_REVIEW, {
      countryCode: "AA",
      visaTypeId: "route-a",
      mode: "self_service",
      status: "in_progress",
      title: "Review 310",
      intake: { answers: {} },
    });
    const stages = ["validity", "suitability", "eligibility", "credibility"] as const;
    const base = routeARubric();
    const rubric = fictionalRubric({
      countryCode: "AA",
      visaTypeId: "route-a",
      intentPolarity: "immigrant_intent_penalised",
      criteria: [
        ...base.criteria,
        ...Array.from({ length: 160 }, (_, i) =>
          criterion({ criterionId: `j${String(i).padStart(3, "0")}`, title: `Judgement rule ${i}`, kind: "judgement", stage: stages[i % 4], severity: "low", probeFactors: ["f"] })
        ),
      ],
    });

    // ---- the ten files, uploaded to the Storage emulator and registered through the real endpoint ----
    const uploads: Array<{ key: string; kind: "pdf" | "jpeg"; mb: number }> = [
      { key: "passport", kind: "pdf", mb: 1 },
      { key: "bank1", kind: "pdf", mb: 1.5 },
      { key: "bank2", kind: "pdf", mb: 2 },
      { key: "bank3", kind: "pdf", mb: 1.5 },
      { key: "photo1", kind: "jpeg", mb: 2 },
      { key: "photo2", kind: "jpeg", mb: 2.5 },
      { key: "photo3", kind: "jpeg", mb: 3 },
      { key: "photo4", kind: "jpeg", mb: 3.5 },
      { key: "photo5", kind: "jpeg", mb: 4 },
      { key: "photo6", kind: "jpeg", mb: 4 },
    ];
    for (const u of uploads) {
      const contentType = u.kind === "pdf" ? "application/pdf" : "image/jpeg";
      const path = await upload(APP_REVIEW, `${u.key}.${u.kind === "pdf" ? "pdf" : "jpg"}`, fileBytes(u.kind, u.key, u.mb * MB), contentType);
      const res = await api.call("POST", "/documents", token, {
        applicationId: APP_REVIEW,
        requirementId: `req-${u.key}`,
        fileName: `${u.key}.${u.kind === "pdf" ? "pdf" : "jpg"}`,
        fileType: contentType,
        storagePath: path,
      });
      assert.equal(res.status, 201, `registering ${u.key}`);
    }
    const registered = await documentsOf(APP_REVIEW);
    assert.equal(registered.length, 10);
    assert.deepEqual(registered.map((d) => d.fileSizeMb).sort((a, b) => a - b), uploads.map((u) => u.mb).sort((a, b) => a - b), "each record holds its real size");

    // ---- the real job: real Firestore + Storage (emulators), real settings read, scripted model ----
    const firebase: any = await import("../../src/utils/firebase");
    const { AiCaseOfficerService } = await import("../../src/services/ai-case-officer.service");
    const { readAiSettings } = await import("../../src/services/ai/ai-settings");
    assert.equal((await firebase.collections.appConfig.doc("aiSettings").get()).exists, false, "no settings document: the code defaults are what runs");

    const provider = new ScriptedProvider((req) =>
      req.role === "extraction"
        ? JSON.stringify({ readable: true, values: [] })
        : JSON.stringify({ findings: [], strengths: [], statementNotes: [], suspiciousPassages: [] })
    );
    const service = new AiCaseOfficerService({
      provider,
      rubrics: { getApprovedRubric: async () => rubric, approvedVersionOf: async () => rubric.version },
      loadBytes: async (storagePath: string) => (await firebase.storage.bucket().file(storagePath).download())[0],
      runTransaction: (fn: any) => firebase.db.runTransaction(fn),
      readSettings: readAiSettings,
      now: () => new Date(),
    });

    const appSnap = await firebase.collections.applications.doc(APP_REVIEW).get();
    const app = { id: appSnap.id, ...appSnap.data() };
    const out: any = await service.requestAssessment(app, { tier: "full", trigger: "manual", requestedBy: client.uid });
    assert.ok(out.assessmentId, `the review was queued (got ${out.kind})`);
    const result = await service.runJob(out.assessmentId);
    const stored = (await firebase.collections.applicationAssessments.doc(out.assessmentId).get()).data();

    assert.deepEqual({ result, status: stored.status, error: stored.error }, { result: "succeeded", status: "succeeded", error: null });
    // Every document got an extraction call, carrying that document's bytes.
    const read = provider.requests
      .filter((r) => r.role === "extraction")
      .map((r) => /KEY:([A-Za-z0-9_-]+)/.exec(Buffer.from(r.documents![0].data, "base64").subarray(0, 64).toString("latin1"))![1])
      .sort();
    assert.deepEqual(read, uploads.map((u) => u.key).sort());
    assert.equal(provider.callsFor("judgement"), 5);
    assert.equal(provider.requests.length, 15, "inside the default cap of 30");
    // The 4 MB photos went out whole, and under what the provider accepts for one image.
    const largestImage = Math.max(...provider.requests.filter((r) => r.documents?.[0]?.mediaType === "image/jpeg").map((r) => r.documents![0].data.length));
    assert.ok(largestImage > 5_000_000 && largestImage < 10_000_000);
  });
});
