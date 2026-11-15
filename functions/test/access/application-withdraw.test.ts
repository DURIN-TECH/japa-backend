// ============================================
// Unit tests — an applicant withdrawing their own application (issue #259)
// ============================================
//
// Run with `npm test`. Hermetic: NO network and NO emulator. The REAL
// ApplicationController handlers and the REAL ApplicationService run against
// the in-memory Firestore fake (test/helpers/fake-firestore.ts), so every
// assertion below is about what was actually stored: the application doc, its
// `timeline` subcollection and its `notes` subcollection.
//
// `req` carries a REAL CASL ability from @durin-tech/authz, exactly what
// `attachAuthz` puts there, so the access check is the production one.
//
// One row of the issue's acceptance criteria per `describe`:
//  1. applicant + open application            -> 200, withdrawn, 1 timeline entry, 1 note
//  2. applicant + already withdrawn           -> 409, nothing written
//  3. applicant + approved / rejected / expired -> 409, nothing written
//  4. applicant sends currentStep / nextStep / rejectionReason -> none stored, no "Reason:"
//  5. applicant + any other status            -> 403 as before
//  6. agent and admin                          -> unchanged (any status, body fields stored)
//  7. after a withdraw, POST /applications     -> created, no duplicate, slot freed

import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { defineAbilitiesFor, LIMITS } from "@durin-tech/authz";
import type { AuthzSubject } from "@durin-tech/authz";

import { applicationController } from "../../src/controllers/application.controller";
import { applicationService } from "../../src/services/application.service";
import { collections, subcollections } from "../../src/utils/firebase";
import type { Application, ApplicationStatus } from "../../src/types";
import { fakeCollection, resetStore, store, writes } from "../helpers/fake-firestore";
import { APPLICATIONS, PRINCIPALS, UID } from "./fixtures";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ============================================
// Fake Firestore wiring
// ============================================

const fb = { collections: collections as any, subcollections: subcollections as any };
const svc = applicationService as any;
const ctrl = applicationController as any;

// Originals, restored after the file so other suites in the same process
// (none today: node --test runs one process per file) see the real refs.
const original = {
  applications: fb.collections.applications,
  users: fb.collections.users,
  timeline: fb.subcollections.timeline,
  notes: fb.subcollections.notes,
  createApplication: svc.createApplication,
};

before(() => {
  fb.collections.applications = fakeCollection("applications");
  // `userService.getDisplayName` reads the actor's user doc for the note.
  fb.collections.users = fakeCollection("users");
  fb.subcollections.timeline = (id: string) => fakeCollection(`applications/${id}/timeline`);
  fb.subcollections.notes = (id: string) => fakeCollection(`applications/${id}/notes`);
});

after(() => {
  fb.collections.applications = original.applications;
  fb.collections.users = original.users;
  fb.subcollections.timeline = original.timeline;
  fb.subcollections.notes = original.notes;
  svc.createApplication = original.createApplication;
});

beforeEach(() => {
  resetStore();
  // The applicant's profile, so the activity note is attributed by name.
  store.set(`users/${UID.client1}`, { id: UID.client1, firstName: "Ada", lastName: "Obi" });
});

// ============================================
// Helpers
// ============================================

/** Every status that ends an application (the issue's "closed status"). */
const CLOSED: ApplicationStatus[] = ["approved", "rejected", "withdrawn", "expired"];

/** Store one of the fixture applications under `status`; returns its id. */
function seed(base: Application, status: ApplicationStatus): string {
  store.set(`applications/${base.id}`, { ...base, status });
  return base.id;
}

/** The stored application doc. */
const stored = (id: string) => store.get(`applications/${id}`) as Record<string, unknown>;

/** Docs of one subcollection of an application. */
function sub(id: string, name: "timeline" | "notes"): Record<string, unknown>[] {
  const prefix = `applications/${id}/${name}/`;
  return [...store.entries()].filter(([p]) => p.startsWith(prefix)).map(([, d]) => d);
}

/** A request as `verifyAuth` + `attachAuthz` leave it for `principal`. */
function reqFor(principal: AuthzSubject, id: string, body: Record<string, unknown>, entitlements: unknown = null): any {
  return {
    params: { id },
    body,
    userId: principal.uid,
    user: { uid: principal.uid, admin: principal.role === "admin" },
    authz: principal,
    ability: defineAbilitiesFor(principal),
    entitlements,
  };
}

/** A response that records the status code and JSON body. */
function fakeRes(): { status: number | null; body: any; res: any } {
  const out: { status: number | null; body: any; res: any } = { status: null, body: undefined, res: null };
  out.res = {
    status(code: number) {
      out.status = code;
      return out.res;
    },
    json(body: unknown) {
      out.body = body;
      return out.res;
    },
  };
  return out;
}

/** PUT /applications/:id/status as `principal`. */
async function putStatus(principal: AuthzSubject, id: string, body: Record<string, unknown>) {
  const out = fakeRes();
  await ctrl.updateStatus(reqFor(principal, id, body), out.res);
  return { status: out.status, body: out.body };
}

/** The body of the refusal for a closed application. */
const CLOSED_BODY = {
  success: false,
  error: "INVALID_STATUS_TRANSITION",
  message: "This application is already closed.",
};

// ============================================
// 1. Applicant withdraws an open application
// ============================================

describe("applicant withdraws an open application", () => {
  // Every open status, not only draft: the guard must refuse closed ones only.
  for (const from of [
    "draft",
    "pending_payment",
    "pending_documents",
    "under_review",
    "submitted_to_embassy",
    "interview_scheduled",
  ] as ApplicationStatus[]) {
    test(`${from}: 200, stored as withdrawn, one timeline entry and one activity note`, async () => {
      const id = seed(APPLICATIONS.selfServe, from);
      const r = await putStatus(PRINCIPALS.client1, id, { status: "withdrawn" });

      assert.equal(r.status, 200);
      assert.equal(r.body.success, true);
      assert.equal(r.body.data.status, "withdrawn");
      assert.equal(stored(id).status, "withdrawn");
      assert.equal(sub(id, "timeline").length, 1);
      assert.equal(sub(id, "notes").length, 1);
    });
  }

  test("the activity note names the applicant and the transition", async () => {
    const id = seed(APPLICATIONS.selfServe, "draft");
    await putStatus(PRINCIPALS.client1, id, { status: "withdrawn" });
    const [note] = sub(id, "notes");
    assert.equal(note.authorId, UID.client1);
    assert.match(String(note.content), /^Ada Obi updated the status from ".+" to ".+"\.$/);
  });
});

// ============================================
// 2 + 3. Applicant on an application that is already closed
// ============================================

describe("applicant cannot withdraw a closed application", () => {
  for (const from of CLOSED) {
    test(`${from}: 409 INVALID_STATUS_TRANSITION and nothing is written`, async () => {
      const id = seed(APPLICATIONS.selfServe, from);
      // Serialised copy: the doc holds Timestamps, which a structured clone
      // would strip of their class and so never compare equal again.
      const before = JSON.stringify(stored(id));
      const r = await putStatus(PRINCIPALS.client1, id, { status: "withdrawn" });

      assert.equal(r.status, 409);
      assert.deepEqual(r.body, CLOSED_BODY);
      // No write of any kind reached Firestore: not the status, not a
      // timeline entry, not an activity note.
      assert.deepEqual(writes, []);
      assert.equal(JSON.stringify(stored(id)), before);
      assert.equal(sub(id, "timeline").length, 0);
      assert.equal(sub(id, "notes").length, 0);
    });
  }

  test("withdrawing twice: the second call is refused and adds no second timeline entry or note", async () => {
    const id = seed(APPLICATIONS.selfServe, "draft");
    assert.equal((await putStatus(PRINCIPALS.client1, id, { status: "withdrawn" })).status, 200);
    const second = await putStatus(PRINCIPALS.client1, id, { status: "withdrawn" });
    assert.equal(second.status, 409);
    assert.deepEqual(second.body, CLOSED_BODY);
    assert.equal(sub(id, "timeline").length, 1);
    assert.equal(sub(id, "notes").length, 1);
  });

  test("the applicant of an agency case is refused the same way", async () => {
    const id = seed(APPLICATIONS.aAssigned, "approved");
    const r = await putStatus(PRINCIPALS.client1, id, { status: "withdrawn" });
    assert.equal(r.status, 409);
    assert.deepEqual(r.body, CLOSED_BODY);
    assert.deepEqual(writes, []);
  });
});

// ============================================
// 4. Client-sent fields are ignored on the applicant path
// ============================================

describe("applicant withdraw ignores currentStep, nextStep and rejectionReason", () => {
  test("none of them is stored and the note has no Reason part", async () => {
    const id = seed(APPLICATIONS.selfServe, "draft");
    const r = await putStatus(PRINCIPALS.client1, id, {
      status: "withdrawn",
      currentStep: "Injected step",
      nextStep: "Injected next step",
      rejectionReason: "Injected reason",
    });

    assert.equal(r.status, 200);
    const doc = stored(id);
    assert.equal(doc.status, "withdrawn");
    // currentStep keeps the value the application already had.
    assert.equal(doc.currentStep, APPLICATIONS.selfServe.currentStep);
    assert.equal("nextStep" in doc, false);
    assert.equal("rejectionReason" in doc, false);
    // Nothing the client sent reached ANY write (doc, timeline or note).
    assert.equal(JSON.stringify(writes).includes("Injected"), false);
    const [note] = sub(id, "notes");
    assert.equal(String(note.content).includes("Reason:"), false);
  });
});

// ============================================
// 5. Applicant may still set nothing but `withdrawn`
// ============================================

describe("applicant setting any other status is refused as before", () => {
  for (const status of ["approved", "under_review", "draft", "rejected"]) {
    test(`${status}: 403 and nothing is written`, async () => {
      const id = seed(APPLICATIONS.selfServe, "draft");
      const r = await putStatus(PRINCIPALS.client1, id, { status });
      assert.equal(r.status, 403);
      assert.deepEqual(r.body, {
        success: false,
        error: "FORBIDDEN",
        message: "You can only withdraw your application",
      });
      assert.deepEqual(writes, []);
    });
  }

  test("a closed application: still the 403, not the 409 (the status rule comes first)", async () => {
    const id = seed(APPLICATIONS.selfServe, "withdrawn");
    const r = await putStatus(PRINCIPALS.client1, id, { status: "draft" });
    assert.equal(r.status, 403);
    assert.deepEqual(writes, []);
  });
});

// ============================================
// 6. Agent and admin behaviour is unchanged
// ============================================

describe("agent and admin are not on the applicant path", () => {
  const FIELDS = { currentStep: "Step from handler", nextStep: "Next from handler", rejectionReason: "Missing funds" };

  for (const [who, principal] of [
    ["assigned agent", PRINCIPALS.agentA1],
    ["agency owner", PRINCIPALS.ownerA],
    ["admin", PRINCIPALS.admin],
  ] as const) {
    test(`${who}: sets any status and the body fields are stored`, async () => {
      const id = seed(APPLICATIONS.aAssigned, "under_review");
      const r = await putStatus(principal, id, { status: "rejected", ...FIELDS });

      assert.equal(r.status, 200);
      const doc = stored(id);
      assert.equal(doc.status, "rejected");
      assert.equal(doc.currentStep, FIELDS.currentStep);
      assert.equal(doc.nextStep, FIELDS.nextStep);
      assert.equal(doc.rejectionReason, FIELDS.rejectionReason);
      const [note] = sub(id, "notes");
      assert.match(String(note.content), /Reason: Missing funds$/);
    });

    test(`${who}: may move a closed application (no closed-status guard)`, async () => {
      const id = seed(APPLICATIONS.aAssigned, "withdrawn");
      const r = await putStatus(principal, id, { status: "under_review" });
      assert.equal(r.status, 200);
      assert.equal(stored(id).status, "under_review");
    });

    test(`${who}: withdrawing an already-withdrawn application is still accepted, with their reason stored`, async () => {
      const id = seed(APPLICATIONS.aAssigned, "withdrawn");
      const r = await putStatus(principal, id, { status: "withdrawn", ...FIELDS });
      assert.equal(r.status, 200);
      assert.equal(stored(id).rejectionReason, FIELDS.rejectionReason);
      // As today: a timeline entry is added even for the same status (the
      // duplicate entry for agents/admins is a separate follow-up).
      assert.equal(sub(id, "timeline").length, 1);
    });
  }

  test("an admin who is also the applicant is not limited to withdraw", async () => {
    const id = seed({ ...APPLICATIONS.selfServe, userId: UID.admin }, "approved");
    const r = await putStatus(PRINCIPALS.admin, id, { status: "under_review", ...FIELDS });
    assert.equal(r.status, 200);
    assert.equal(stored(id).status, "under_review");
    assert.equal(stored(id).currentStep, FIELDS.currentStep);
  });

  test("an agent who is the applicant AND the agent of their own case keeps the agent path", async () => {
    const own = { ...APPLICATIONS.aAssigned, userId: UID.agentA1 };
    const id = seed(own, "approved");
    const r = await putStatus(PRINCIPALS.agentA1, id, { status: "rejected", ...FIELDS });
    assert.equal(r.status, 200);
    assert.equal(stored(id).status, "rejected");
    assert.equal(stored(id).rejectionReason, FIELDS.rejectionReason);
  });
});

// ============================================
// 7. A withdrawn application no longer blocks a new start
// ============================================

describe("after a withdraw, starting the same visa again", () => {
  /** A plan that allows exactly ONE active application. */
  const ONE_APPLICATION_PLAN = {
    status: "active",
    features: [],
    limits: { [LIMITS.MAX_ACTIVE_APPLICATIONS]: 1 },
  };
  let created = 0;

  beforeEach(() => {
    created = 0;
    // Creation itself (visa lookup, intake, timeline) is outside this issue:
    // only whether the handler REACHES it matters. The duplicate lookup and
    // the active-application count are the real ones, reading the fake store.
    svc.createApplication = async () => {
      created++;
      return { id: "new-app" };
    };
  });

  /** POST /applications for the fixture's visa, self mode, no `confirmNew`. */
  async function postSameVisa(extra: Record<string, unknown> = {}) {
    const out = fakeRes();
    const body = {
      visaTypeId: APPLICATIONS.selfServe.visaTypeId,
      countryCode: APPLICATIONS.selfServe.countryCode,
      mode: "self",
      ...extra,
    };
    await ctrl.createApplication(reqFor(PRINCIPALS.client1, "", body, ONE_APPLICATION_PLAN), out.res);
    return { status: out.status, body: out.body };
  }

  test("control: while the application is open, the start is answered with the duplicate", async () => {
    seed(APPLICATIONS.selfServe, "draft");
    const r = await postSameVisa();
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "DUPLICATE_ACTIVE_APPLICATION");
    assert.equal(created, 0);
  });

  test("control: while it is open it uses the plan's one slot", async () => {
    seed(APPLICATIONS.selfServe, "draft");
    // `confirmNew` skips the duplicate prompt, so the plan limit is what answers.
    const r = await postSameVisa({ confirmNew: true });
    assert.equal(r.status, 402);
    assert.equal(created, 0);
  });

  test("once withdrawn: created, no duplicate prompt, and the plan's one slot is free", async () => {
    const id = seed(APPLICATIONS.selfServe, "draft");
    assert.equal((await putStatus(PRINCIPALS.client1, id, { status: "withdrawn" })).status, 200);

    const r = await postSameVisa();
    assert.equal(r.status, 201);
    assert.equal(r.body.success, true);
    assert.equal(created, 1);
  });
});
