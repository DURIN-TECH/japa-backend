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
// PART 2 — the review, run by the real job over the service's own default
//   dependencies (real Storage and Firestore reads), with only the model and
//   the rulebook faked. The rulebook is a fictional fixture needing five
//   judgement calls: nothing is drafted, extracted or published. Three cases:
//   - the acceptance case: 1 passport PDF, statements of 3, 6 and 9.5 MB and 6
//     photos of 2-4 MB (about 40 MB) end `succeeded` at the default settings
//     (no `appConfig/aiSettings` document exists in the emulator);
//   - files the upload accepted under a wrong label are all read: the upload
//     limit and the review limit are one decision, from the file's own bytes;
//   - files adding up to more than the total attached-bytes limit end
//     `review_too_large` before any model call.
//   - (#444) on the Standard Visitor v2 rulebook fixture, one `general`
//     bank-statement upload read as financial evidence, dated 10 days before
//     the (injected) review date, stores FIN 7.1 as a pass with `measuredOn`.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { resetEmulators, rulesEnv, RunningApi, signUp, startApi, TestAccount } from "./helpers";
import { clearBucket, objectExists, recordSigning, SigningRecorder, storageRulesEnv, withClaims } from "./storage-helpers";
import { criterion, fictionalRubric, routeARubric, ScriptedProvider, type Responder } from "../ai-case-officer/harness";
// (#444) The live v2 rulebook (read-only fixture copy), for the dated-check case.
import v2Fixture from "../ai-case-officer/fixtures/uk-standard-visitor-v2-308.json";

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
function fileBytes(kind: "pdf" | "jpeg" | "heic", key: string, size: number): Buffer {
  const out = Buffer.alloc(size);
  if (kind === "pdf") out.write("%PDF-1.4 ", 0, "latin1");
  else if (kind === "jpeg") out.set([0xff, 0xd8, 0xff, 0xe0], 0);
  // HEIC: an ISO media file, "ftypheic" after a four-byte box length.
  else out.write("\u0000\u0000\u0000\u0018ftypheic", 0, "latin1");
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
          details: { maxBytes: 10 * MB, sizeBytes: 10 * MB + 1, isPdf: true },
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
        details: { maxBytes: 7 * MB, sizeBytes: 8 * MB, isPdf: false },
        objectStillThere: false,
        record: undefined,
      }
    );

    const fine = await upload(APP, "photo.jpg", fileBytes("jpeg", "photo", 4 * MB), "image/jpeg");
    const accepted = await api.call("POST", "/documents", token, registration(APP, fine, { fileName: "photo.jpg", fileType: "image/jpeg" }));
    assert.equal(accepted.status, 201);
    assert.equal((await recordFor(APP, fine)).fileSizeMb, 4);
  });

  // ---- The limit follows what the file IS, never how it was labelled ----
  // Registration and the review must agree about every file, so both decide
  // from the file's own first bytes. Each row: the real bytes, the content type
  // the object was stored with (what the client asked the upload URL for), the
  // `fileType` the registration declares, the size, and the answer.
  const LABELLED: Array<{ name: string; kind: "pdf" | "jpeg" | "heic"; contentType: string; fileType: string; mb: number; status: 201 | 413; maxMb?: number }> = [
    // The reported defect: a photo stored and declared as a PDF.
    { name: "a JPEG labelled application/pdf, 8 MB", kind: "jpeg", contentType: "application/pdf", fileType: "application/pdf", mb: 8, status: 413, maxMb: 7 },
    // What the mobile picker sends when it has no type.
    { name: "a JPEG labelled application/octet-stream, 8 MB", kind: "jpeg", contentType: "application/octet-stream", fileType: "application/octet-stream", mb: 8, status: 413, maxMb: 7 },
    { name: "a JPEG labelled application/octet-stream, 4 MB", kind: "jpeg", contentType: "application/octet-stream", fileType: "application/octet-stream", mb: 4, status: 201 },
    { name: "a PDF labelled application/octet-stream, 9 MB", kind: "pdf", contentType: "application/octet-stream", fileType: "application/octet-stream", mb: 9, status: 201 },
    { name: "a PDF labelled application/octet-stream, 11 MB", kind: "pdf", contentType: "application/octet-stream", fileType: "application/octet-stream", mb: 11, status: 413, maxMb: 10 },
    // The other way round: a real PDF labelled as an image keeps the PDF limit.
    { name: "a PDF labelled image/jpeg, 8 MB", kind: "pdf", contentType: "image/jpeg", fileType: "image/jpeg", mb: 8, status: 201 },
    { name: "a PDF labelled image/jpeg, 11 MB", kind: "pdf", contentType: "image/jpeg", fileType: "image/jpeg", mb: 11, status: 413, maxMb: 10 },
    // HEIC: accepted at upload, not a PDF, so the lower limit.
    { name: "a HEIC photo, 6 MB", kind: "heic", contentType: "image/heic", fileType: "image/heic", mb: 6, status: 201 },
    { name: "a HEIC photo, 8 MB", kind: "heic", contentType: "image/heic", fileType: "image/heic", mb: 8, status: 413, maxMb: 7 },
    { name: "a HEIC photo labelled application/pdf, 8 MB", kind: "heic", contentType: "application/pdf", fileType: "application/pdf", mb: 8, status: 413, maxMb: 7 },
    // The storage label and the declared type disagreeing changes nothing.
    { name: "a JPEG stored as application/pdf but declared image/jpeg, 8 MB", kind: "jpeg", contentType: "application/pdf", fileType: "image/jpeg", mb: 8, status: 413, maxMb: 7 },
  ];
  for (const row of LABELLED) {
    test(`${row.name}: ${row.status}`, async () => {
      const path = await upload(APP, "labelled.bin", fileBytes(row.kind, "labelled", row.mb * MB), row.contentType);
      const res = await api.call("POST", "/documents", token, registration(APP, path, { fileType: row.fileType }));
      const record = await recordFor(APP, path);
      if (row.status === 201) {
        assert.deepEqual(
          { status: res.status, objectStillThere: await objectExists(path), storedMb: record?.fileSizeMb },
          { status: 201, objectStillThere: true, storedMb: row.mb }
        );
      } else {
        assert.deepEqual(
          { status: res.status, error: res.body.error, message: res.body.message, details: res.body.details, objectStillThere: await objectExists(path), record },
          {
            status: 413,
            error: "FILE_TOO_LARGE",
            message: `This file is larger than ${row.maxMb} MB. Upload a smaller copy, for example a scan at a lower resolution.`,
            details: { maxBytes: row.maxMb! * MB, sizeBytes: row.mb * MB, isPdf: row.kind === "pdf" },
            objectStillThere: false,
            record: undefined,
          }
        );
      }
    });
  }

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
// PART 2 — the review, on the same emulators
// ============================================

/** A fictional route-A rulebook that needs FIVE judgement calls. */
function fiveBatchRubric() {
  const stages = ["validity", "suitability", "eligibility", "credibility"] as const;
  return fictionalRubric({
    countryCode: "AA",
    visaTypeId: "route-a",
    intentPolarity: "immigrant_intent_penalised",
    criteria: [
      ...routeARubric().criteria,
      ...Array.from({ length: 160 }, (_, i) =>
        criterion({ criterionId: `j${String(i).padStart(3, "0")}`, title: `Judgement rule ${i}`, kind: "judgement", stage: stages[i % 4], severity: "low", probeFactors: ["f"] })
      ),
    ],
  });
}

/** One file to upload, register and review. */
interface ReviewFile {
  key: string;
  kind: "pdf" | "jpeg" | "heic";
  mb: number;
  /** The content type to store and declare. Default: the true one. */
  label?: string;
  /** (#444) The checklist slot it is uploaded to. Default: `req-<key>`. */
  requirementId?: string;
}

/** (#444) Optional overrides of the review run: the model's answers and the clock. */
interface ReviewOptions {
  respond?: Responder;
  now?: () => Date;
}

/**
 * Seed a self-service application on the fictional route, upload each file to
 * the Storage emulator, register it through the real `POST /documents`, then
 * run the REAL review job over the service's own default dependencies (real
 * Storage download and metadata reads, real Firestore, the real settings
 * read), with only the model provider and the rulebook swapped for fakes.
 */
async function registerAndReview(applicationId: string, uploads: ReviewFile[], rubric: any = fiveBatchRubric(), opts: ReviewOptions = {}) {
  await seedApplication(applicationId, { countryCode: "AA", visaTypeId: "route-a", mode: "self_service", title: applicationId, intake: { answers: {} } });
  const statuses: number[] = [];
  for (const u of uploads) {
    const trueType = u.kind === "pdf" ? "application/pdf" : u.kind === "jpeg" ? "image/jpeg" : "image/heic";
    const path = await upload(applicationId, `${u.key}.bin`, fileBytes(u.kind, u.key, Math.round(u.mb * MB)), u.label ?? trueType);
    const res = await api.call("POST", "/documents", token, {
      applicationId,
      requirementId: u.requirementId ?? `req-${u.key}`,
      fileName: `${u.key}.bin`,
      fileType: u.label ?? trueType,
      storagePath: path,
    });
    statuses.push(res.status);
  }

  const firebase: any = await import("../../src/utils/firebase");
  const { AiCaseOfficerService, defaultDeps } = await import("../../src/services/ai-case-officer.service");
  assert.equal((await firebase.collections.appConfig.doc("aiSettings").get()).exists, false, "no settings document: the code defaults are what runs");

  const provider = new ScriptedProvider(
    opts.respond ??
      ((req) =>
        req.role === "extraction"
          ? JSON.stringify({ readable: true, values: [] })
          : JSON.stringify({ findings: [], strengths: [], statementNotes: [], suspiciousPassages: [] }))
  );
  const service = new AiCaseOfficerService({
    ...defaultDeps(),
    // (#444) A fixed clock when the case needs one (dates are never the real clock there).
    ...(opts.now ? { now: opts.now } : {}),
    provider,
    rubrics: { getApprovedRubric: async () => rubric, approvedVersionOf: async () => rubric.version },
  });

  const appSnap = await firebase.collections.applications.doc(applicationId).get();
  const out: any = await service.requestAssessment({ id: appSnap.id, ...appSnap.data() }, { tier: "full", trigger: "manual", requestedBy: client.uid });
  assert.ok(out.assessmentId, `the review was queued (got ${out.kind})`);
  const result = await service.runJob(out.assessmentId);
  const stored = (await firebase.collections.applicationAssessments.doc(out.assessmentId).get()).data();
  // The key of every document that was sent to the model for extraction.
  const read = provider.requests
    .filter((r) => r.role === "extraction")
    .map((r) => /KEY:([A-Za-z0-9_-]+)/.exec(Buffer.from(r.documents![0].data, "base64").subarray(0, 64).toString("latin1"))![1])
    .sort();
  return { statuses, result, stored, provider, read };
}

/** Today's count of reviews that reached a model, or 0. */
async function reviewsCountedToday(): Promise<number> {
  const day = new Date().toISOString().slice(0, 10);
  const snap = await (await adminDb()).collection("aiCosts").doc(day).get();
  return snap.exists ? Number(snap.data().assessments ?? 0) : 0;
}

describe("readiness review on the emulators", () => {
  test("1 passport PDF, statements of 3, 6 and 9.5 MB and 6 photos of 2-4 MB (about 40 MB): succeeded, every document read, no cap code", async () => {
    const uploads: ReviewFile[] = [
      { key: "passport", kind: "pdf", mb: 2.2 },
      { key: "bank1", kind: "pdf", mb: 3 },
      { key: "bank2", kind: "pdf", mb: 6 },
      { key: "bank3", kind: "pdf", mb: 9.5 },
      { key: "photo1", kind: "jpeg", mb: 2 },
      { key: "photo2", kind: "jpeg", mb: 2.5 },
      { key: "photo3", kind: "jpeg", mb: 3 },
      { key: "photo4", kind: "jpeg", mb: 3.5 },
      { key: "photo5", kind: "jpeg", mb: 4 },
      { key: "photo6", kind: "jpeg", mb: 4 },
    ];
    const before = await reviewsCountedToday();
    const { statuses, result, stored, provider, read } = await registerAndReview(APP_REVIEW, uploads);

    assert.deepEqual(statuses, uploads.map(() => 201));
    const registered = await documentsOf(APP_REVIEW);
    assert.deepEqual(registered.map((d) => d.fileSizeMb).sort((a, b) => a - b), uploads.map((u) => u.mb).sort((a, b) => a - b), "each record holds its real size");

    assert.deepEqual({ result, status: stored.status, error: stored.error }, { result: "succeeded", status: "succeeded", error: null });
    assert.deepEqual(read, uploads.map((u) => u.key).sort(), "every document got an extraction call");
    assert.equal(provider.callsFor("judgement"), 5);
    // (#384) 10 extractions + 5 judgement batches + the one narrative call
    // written after the findings are assembled.
    assert.equal(provider.callsFor("narrative"), 1);
    assert.equal(provider.requests.length, 16, "inside the default cap of 30");
    // (#418) The caseworker read rides on the SAME extraction calls (still 10,
    // no new call): each one asks for the general caseworker fields and the
    // document's kind, and each judgement call carries the document list.
    const { CASEWORKER_FIELD_NAMES } = await import("../../src/services/ai/assessment-engine");
    for (const r of provider.requests.filter((x) => x.role === "extraction")) {
      const listed = /Fields to report: ([^\n]*)\./.exec(r.user)?.[1].split(", ") ?? [];
      for (const f of CASEWORKER_FIELD_NAMES) assert.ok(listed.includes(f), `the extraction request asks for ${f}`);
      assert.ok((r.schema as any).properties.documentKind, "the extraction schema asks for the document kind");
    }
    for (const r of provider.requests.filter((x) => x.role === "judgement")) {
      const list = /<user_uploaded_document source="documents">\n([\s\S]*?)\n<\/user_uploaded_document>/.exec(r.user)?.[1] ?? "";
      assert.equal(list.split("\n").length, uploads.length, "the judgement request lists every upload");
      assert.ok(list.split("\n").every((l) => / \| read: yes$/.test(l)), "every upload is listed as read");
    }
    // The 4 MB photos went out whole, and under what the provider accepts for one image.
    const largestImage = Math.max(...provider.requests.filter((r) => r.documents?.[0]?.mediaType === "image/jpeg").map((r) => r.documents![0].data.length));
    assert.ok(largestImage > 5_000_000 && largestImage < 10_000_000);
    assert.equal(await reviewsCountedToday(), before + 1, "counted once against today's reviews");
  });

  test("(#444) v2 rulebook: one general bank statement read as financial evidence, dated 10 days before the review date: FIN 7.1 passes, measuredOn stored, no FIN 7.1 ground", async () => {
    const FIN = "crit_a441f774ac3adf58";
    const reviewNow = new Date("2026-11-21T09:00:00Z");
    const rubric = v2Fixture.rubric as any;
    // The financial evidence item's E-id, from the list the extraction request carries.
    const respond: Responder = (req) => {
      if (req.role === "extraction") {
        const code = /(E\d+): Financial evidence/.exec(req.user)?.[1];
        return JSON.stringify({
          readable: true,
          documentKind: "bank_statement",
          values: [{ field: "statementPeriodEnd", value: "2026-11-11", unit: null, page: 1, quote: "to 11 Nov 2026" }],
          evidenceItems: code ? [code] : [],
        });
      }
      if (req.role === "judgement") return JSON.stringify({ findings: [], strengths: [], statementNotes: [], suspiciousPassages: [] });
      const lead = /Required opening of the conclusion: "([^"]+)"/.exec(req.user)![1];
      return JSON.stringify({ paragraphs: ["Your statement is recent."], conclusion: `${lead} your statement is recent.`, nextSteps: [] });
    };
    const { statuses, stored, provider } = await registerAndReview("app-dated-444", [{ key: "bank", kind: "pdf", mb: 1, requirementId: "general" }], rubric, { respond, now: () => reviewNow });
    assert.deepEqual(statuses, [201]);
    assert.equal(stored.status, "succeeded");
    // No new call: one extraction, the rulebook's judgement batches, one narrative.
    assert.equal(provider.callsFor("extraction"), 1);
    const extraction = provider.requests.find((r) => r.role === "extraction")!;
    assert.ok(!/Fields to report: [^\n]*mostRecentDaysBeforeApplication/.test(extraction.user), "the day count is never asked of the model");
    assert.ok((extraction.schema as any).properties.evidenceItems, "the evidence items ride on the same call");
    // FIN 7.1 passed: no refusal ground, no open item.
    assert.equal(stored.refusalGrounds.some((g: any) => g.criterionId === FIN), false);
    assert.equal(stored.insufficientInformation.some((i: any) => i.criterionId === FIN), false);
    assert.equal(stored.measuredOn, "2026-11-21");
    assert.deepEqual(stored.documentsRead.map((d: any) => [d.evidenceItems, d.documentDate]), [[["financial_evidence"], "2026-11-11"]]);
  });

  test("every mislabelled file the upload accepted is read by the review; none is left out for its size", async () => {
    // The largest of each kind that registration accepts under a wrong label.
    const uploads: ReviewFile[] = [
      { key: "pdf-as-image", kind: "pdf", mb: 9.5, label: "image/jpeg" },
      { key: "pdf-as-binary", kind: "pdf", mb: 9.5, label: "application/octet-stream" },
      { key: "jpeg-as-pdf", kind: "jpeg", mb: 7, label: "application/pdf" },
      { key: "jpeg-as-binary", kind: "jpeg", mb: 7, label: "application/octet-stream" },
      { key: "heic", kind: "heic", mb: 7 },
    ];
    const { statuses, stored, read } = await registerAndReview("app-labels-310", uploads);
    assert.deepEqual(statuses, uploads.map(() => 201));
    assert.equal(stored.status, "succeeded");
    // Everything the review can read was sent. The HEIC is not a readable type
    // (a known gap, not a size problem), so it is the only one missing.
    assert.deepEqual(read, ["jpeg-as-binary", "jpeg-as-pdf", "pdf-as-binary", "pdf-as-image"]);
    assert.equal(JSON.stringify(stored).includes("file is larger than the limit"), false, "no document is reported as too large");
  });

  test("files adding up to more than 60 MB: review_too_large before any model call, and today's count does not move", async () => {
    // Seven PDFs of 9.5 MB: each is within its own limit, together 66.5 MB.
    const uploads: ReviewFile[] = Array.from({ length: 7 }, (_, i) => ({ key: `big${i}`, kind: "pdf" as const, mb: 9.5 }));
    const before = await reviewsCountedToday();
    const { statuses, result, stored, provider } = await registerAndReview("app-total-310", uploads);
    assert.deepEqual(statuses, uploads.map(() => 201), "each file is accepted at upload");
    assert.deepEqual(
      { result, status: stored.status, error: stored.error, modelCalls: provider.requests.length, countedToday: (await reviewsCountedToday()) - before },
      { result: "failed", status: "failed", error: { code: "review_too_large", message: "the application is larger than one review can read" }, modelCalls: 0, countedToday: 0 }
    );
  });
});
