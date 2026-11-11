// ============================================
// Unit tests — application access as the REST handlers enforce it (issue #29)
// ============================================
//
// Run with `npm test`. Hermetic: NO network and NO emulator. The handlers of
// ApplicationController are called directly with a minimal req / res; `req`
// carries a REAL CASL ability from @durin-tech/authz (defineAbilitiesFor),
// exactly what `attachAuthz` (middleware/auth.ts) puts there. The one service
// call that happens BEFORE the access check (`getApplicationById`) is stubbed;
// anything a denied request reaches after it would hit the unfaked-Firestore
// guard (test/helpers/setup.ts) and fail the test, so "403 and nothing else
// happened" is checked for free.
//
// This file does not import the access helper itself: it only sees status
// codes and bodies. It was written and run green BEFORE #29 moved
// `checkApplicationAccess` out of the controller and was not edited by the
// move, so it is the proof that no endpoint changed its answer.
//
// Covers the five call sites of the check:
//  - GET  /applications/:id                 (whole read matrix, 200 vs 403)
//  - PUT  /applications/:id                 (deny -> 403)
//  - POST /applications/:id/documents/request (deny -> 403; applicant -> 403)
//  - PUT  /applications/:id/status          (deny -> 403)
//  - GET  /applications/:id/timeline        (whole read matrix, 200 vs 403)
// plus: unknown id -> 404 for everyone (admin included), and a request with
// no ability at all -> 403.

import { test, describe, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { defineAbilitiesFor } from "@durin-tech/authz";
import type { AuthzSubject } from "@durin-tech/authz";

import { applicationController } from "../../src/controllers/application.controller";
import { applicationService } from "../../src/services/application.service";
import { ErrorMessages } from "../../src/utils/response";
import type { Application } from "../../src/types";
import { APPLICATIONS, MATRIX, PRINCIPALS, expected } from "./fixtures";
import type { ApplicationName, PrincipalName } from "./fixtures";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ============================================
// Stubs
// ============================================

/** The application `getApplicationById` returns (null = does not exist). */
let stored: Application | null = null;

// Keep the originals so the stubs can be removed after the file.
const svc = applicationService as any;
const ctrl = applicationController as any;
const original = {
  getApplicationById: svc.getApplicationById,
  getTimeline: svc.getTimeline,
  withHandlerNames: ctrl.withHandlerNames,
};

// The lookup that precedes the access check.
svc.getApplicationById = async () => stored;
// What an ALLOWED read goes on to do (both would otherwise hit Firestore).
svc.getTimeline = async () => [];
ctrl.withHandlerNames = async (apps: Application[]) => apps;

after(() => {
  svc.getApplicationById = original.getApplicationById;
  svc.getTimeline = original.getTimeline;
  ctrl.withHandlerNames = original.withHandlerNames;
});

beforeEach(() => {
  stored = null;
});

// ============================================
// req / res
// ============================================

/** The body every 403 from these handlers carries. */
const FORBIDDEN_BODY = { success: false, error: "FORBIDDEN", message: ErrorMessages.FORBIDDEN };
/** The body every 404 from these handlers carries. */
const NOT_FOUND_BODY = { success: false, error: "NOT_FOUND", message: "Application not found" };

/** A request as `verifyAuth` leaves it for `principal` (no ability when null). */
function reqFor(principal: AuthzSubject | null, body: Record<string, unknown> = {}): any {
  return {
    params: { id: "any-id" },
    body,
    userId: principal?.uid ?? "uid-nobody",
    user: principal ? { uid: principal.uid, admin: principal.role === "admin" } : undefined,
    authz: principal ?? undefined,
    ability: principal ? defineAbilitiesFor(principal) : undefined,
    entitlements: null,
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
    send() {
      return out.res;
    },
  };
  return out;
}

/** Call one handler and return what it answered. */
async function call(
  handler: "getApplication" | "updateApplication" | "requestDocument" | "updateStatus" | "getTimeline",
  principal: AuthzSubject | null,
  body: Record<string, unknown> = {}
): Promise<{ status: number | null; body: any }> {
  const out = fakeRes();
  await ctrl[handler](reqFor(principal, body), out.res);
  return { status: out.status, body: out.body };
}

/** A valid body for each mutating handler (so validation passes and the access check is reached). */
const BODY = {
  updateApplication: { userNotes: "note" },
  requestDocument: { documentType: "passport" },
  updateStatus: { status: "in_review" },
} as const;

// ============================================
// Read matrix through the two GET handlers
// ============================================

for (const handler of ["getApplication", "getTimeline"] as const) {
  describe(`${handler}: read matrix across roles and two agencies`, () => {
    for (const p of Object.keys(MATRIX) as PrincipalName[]) {
      for (const a of Object.keys(MATRIX[p]) as ApplicationName[]) {
        const allowed = expected(MATRIX[p][a], "read");
        test(`${p} -> ${a}: ${allowed ? "200" : "403"}`, async () => {
          stored = APPLICATIONS[a];
          const r = await call(handler, PRINCIPALS[p]);
          if (allowed) {
            assert.equal(r.status, 200);
            assert.equal(r.body.success, true);
          } else {
            assert.equal(r.status, 403);
            assert.deepEqual(r.body, FORBIDDEN_BODY);
          }
        });
      }
    }
  });
}

// ============================================
// Deny path of the three mutating handlers
// ============================================
// These three call the check with its default action ("read") and then apply
// their own extra rules. Only the deny side is driven here: an allowed call
// goes on to write through several services, which is outside this issue.

for (const handler of ["updateApplication", "requestDocument", "updateStatus"] as const) {
  describe(`${handler}: every principal without read access gets 403`, () => {
    for (const p of Object.keys(MATRIX) as PrincipalName[]) {
      for (const a of Object.keys(MATRIX[p]) as ApplicationName[]) {
        if (expected(MATRIX[p][a], "read")) continue;
        test(`${p} -> ${a}: 403`, async () => {
          stored = APPLICATIONS[a];
          const r = await call(handler, PRINCIPALS[p], BODY[handler]);
          assert.equal(r.status, 403);
          assert.deepEqual(r.body, FORBIDDEN_BODY);
        });
      }
    }
  });
}

describe("requestDocument: the applicant is refused even though they can read", () => {
  test("client1 on their own agency-A case: 403", async () => {
    stored = APPLICATIONS.aAssigned;
    const r = await call("requestDocument", PRINCIPALS.client1, BODY.requestDocument);
    assert.equal(r.status, 403);
    assert.deepEqual(r.body, FORBIDDEN_BODY);
  });
});

// ============================================
// Not found and no ability
// ============================================

describe("an application that does not exist is 404 before any access decision", () => {
  for (const handler of ["getApplication", "updateApplication", "requestDocument", "updateStatus", "getTimeline"] as const) {
    for (const p of ["admin", "ownerA", "agentA1", "client1"] as const) {
      test(`${handler} as ${p}: 404`, async () => {
        stored = null;
        const body = handler in BODY ? BODY[handler as keyof typeof BODY] : {};
        const r = await call(handler, PRINCIPALS[p], body);
        assert.equal(r.status, 404);
        assert.deepEqual(r.body, NOT_FOUND_BODY);
      });
    }
  }
});

describe("a request with no ability attached is denied", () => {
  for (const handler of ["getApplication", "updateApplication", "requestDocument", "updateStatus", "getTimeline"] as const) {
    test(`${handler}: 403`, async () => {
      stored = APPLICATIONS.selfServe;
      const body = handler in BODY ? BODY[handler as keyof typeof BODY] : {};
      const r = await call(handler, null, body);
      assert.equal(r.status, 403);
      assert.deepEqual(r.body, FORBIDDEN_BODY);
    });
  }
});
