// ============================================
// Unit tests — duplicate active application guard (issue #253)
// ============================================
//
// Hermetic (no emulator). Two layers:
//  1. applicationService.findActiveDuplicate: the Firestore query is faked
//     (records the three equality filters, returns canned docs) so we check
//     which statuses count as "active" and which match wins.
//  2. applicationController.createApplication: the service calls are stubbed
//     to check the 409 body, the `confirmNew` bypass, and that a first-time
//     start is untouched.

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

import { applicationController } from "../../src/controllers/application.controller";
import { applicationService } from "../../src/services/application.service";
import { collections } from "../../src/utils/firebase";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---- fake Firestore query for the service layer ----
const realApplications = collections.applications;
let filters: Array<[string, string, unknown]> = [];
let docs: any[] = [];

/** A fake Timestamp: only `toMillis` is used. */
const ts = (ms: number) => ({ toMillis: () => ms });
const app = (id: string, status: string, ms: number) => ({ id, status, lastUpdated: ts(ms) });

function installFakeQuery() {
  const query: any = {
    where(field: string, op: string, value: unknown) {
      filters.push([field, op, value]);
      return query;
    },
    get: async () => ({ docs: docs.map((d) => ({ data: () => d })) }),
  };
  (collections as any).applications = query;
}

describe("findActiveDuplicate", () => {
  beforeEach(() => {
    filters = [];
    docs = [];
    installFakeQuery();
  });
  after(() => {
    (collections as any).applications = realApplications;
  });

  test("queries the user's applications for this exact country + visa", async () => {
    await applicationService.findActiveDuplicate("u1", "GB", "visa-1");
    assert.deepEqual(filters, [
      ["userId", "==", "u1"],
      ["countryCode", "==", "GB"],
      ["visaTypeId", "==", "visa-1"],
    ]);
  });

  test("terminal statuses never count as a duplicate", async () => {
    docs = ["approved", "rejected", "withdrawn", "expired"].map((s, i) => app(`a${i}`, s, i));
    assert.equal(await applicationService.findActiveDuplicate("u1", "GB", "v"), null);
  });

  test("every non-terminal status counts", async () => {
    for (const s of [
      "draft",
      "pending_payment",
      "pending_documents",
      "under_review",
      "submitted_to_embassy",
      "interview_scheduled",
    ]) {
      docs = [app("a", s, 1)];
      assert.equal((await applicationService.findActiveDuplicate("u1", "GB", "v"))?.id, "a", s);
    }
  });

  test("with several live matches the most recently updated wins", async () => {
    docs = [app("old", "draft", 100), app("new", "under_review", 500), app("done", "approved", 900)];
    assert.equal((await applicationService.findActiveDuplicate("u1", "GB", "v"))?.id, "new");
  });
});

// ---- controller layer ----
const svc = applicationService as any;
const ctrl = applicationController as any;
const original = {
  findActiveDuplicate: svc.findActiveDuplicate,
  createApplication: svc.createApplication,
  countActiveApplications: ctrl.countActiveApplications,
};
let existing: any = null;
let created = 0;
let lookups = 0;

// Stubs are installed per-test (beforeEach below), not at module load, so the
// service tests above exercise the REAL findActiveDuplicate.

async function post(extra: Record<string, unknown> = {}) {
  const out: { status: number | null; body: any } = { status: null, body: undefined };
  const res: any = {
    status(c: number) {
      out.status = c;
      return res;
    },
    json(b: unknown) {
      out.body = b;
      return res;
    },
  };
  const req: any = {
    userId: "u1",
    body: { visaTypeId: "v", countryCode: "GB", mode: "self", ...extra },
    entitlements: null,
  };
  await ctrl.createApplication(req, res);
  return out;
}

describe("POST /applications duplicate guard", () => {
  beforeEach(() => {
    existing = null;
    created = 0;
    lookups = 0;
    svc.findActiveDuplicate = async () => {
      lookups++;
      return existing;
    };
    svc.createApplication = async () => {
      created++;
      return { id: "new-app" };
    };
    ctrl.countActiveApplications = async () => 0;
  });
  after(() => {
    svc.findActiveDuplicate = original.findActiveDuplicate;
    svc.createApplication = original.createApplication;
    ctrl.countActiveApplications = original.countActiveApplications;
  });

  test("no existing application: created (201), as before", async () => {
    const r = await post();
    assert.equal(r.status, 201);
    assert.equal(created, 1);
  });

  test("existing active application: 409 with it, nothing created", async () => {
    existing = {
      id: "app-1",
      status: "draft",
      progress: 10,
      mode: "self",
      visaTypeName: "Skilled Worker",
      countryName: "United Kingdom",
      lastUpdated: "t",
      // must NOT leak:
      agentNotes: "secret",
      clientEmail: "a@b.c",
      totalCost: 5,
    };
    const r = await post();
    assert.equal(r.status, 409);
    assert.equal(r.body.success, false);
    assert.equal(r.body.error, "DUPLICATE_ACTIVE_APPLICATION");
    assert.deepEqual(r.body.data.existingApplication, {
      id: "app-1",
      status: "draft",
      progress: 10,
      mode: "self",
      visaTypeName: "Skilled Worker",
      countryName: "United Kingdom",
      lastUpdated: "t",
    });
    assert.equal(created, 0);
  });

  test("agent mode is unaffected: no lookup, created", async () => {
    existing = { id: "app-1", status: "draft" };
    const r = await post({ mode: "agent", agentId: "ag1" });
    assert.equal(r.status, 201);
    assert.equal(created, 1);
    assert.equal(lookups, 0);
  });

  test("confirmNew: true bypasses the guard (no lookup) and creates", async () => {
    existing = { id: "app-1", status: "draft" };
    const r = await post({ confirmNew: true });
    assert.equal(r.status, 201);
    assert.equal(created, 1);
    assert.equal(lookups, 0);
  });

  test("confirmNew must be the boolean true: the string 'true' still gets 409", async () => {
    existing = { id: "app-1", status: "draft" };
    const r = await post({ confirmNew: "true" });
    assert.equal(r.status, 409);
    assert.equal(created, 0);
  });
});
