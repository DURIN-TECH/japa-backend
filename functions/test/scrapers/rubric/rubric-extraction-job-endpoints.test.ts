// ============================================
// Rulebook drafting job: admin endpoints (issue #216)
// ============================================
//
// Drives POST / , GET /:id and POST /:id/cancel of /admin/rubric-extraction-jobs
// over REAL HTTP against the real router and the real `verifyAuth` (only the
// token check and the entitlements read are stubbed), on the in-memory Firestore
// fake. No model, no emulator.
//
// Covers the role matrix (no token 401; client, agent, owner 403 whatever their
// entitlements; admin 200), strict bodies, the visa-type check, and that the
// gate runs before anything is read.

import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import express from "express";
import { ROLES } from "@durin-tech/authz";
import { resetStore, store } from "../../helpers/fake-firestore";
import { adminRubricExtractionJobRoutes } from "../../../src/routes/rubric-extraction-job.routes";
import { parseStartBody } from "../../../src/controllers/rubric-extraction-job.controller";
import { rubricExtractionJobService } from "../../../src/scrapers/rubric/rubric-extraction-job";
import { installRubricFakes, makeHarness, makeJobHarness, quiet, resetBucket, runDocs, versionPaths, type Harness, type JobHarness } from "./rubric-harness";
import { ROUTE, ROUTE_KEY, setUpMulti } from "./rubric-job-fixtures";

/* eslint-disable @typescript-eslint/no-explicit-any */

const TOKENS: Record<string, any> = {
  "t-admin": { uid: "admin-uid", role: ROLES.ADMIN },
  "t-client": { uid: "client-uid", role: ROLES.CLIENT },
  "t-agent": { uid: "agent-uid", role: ROLES.AGENT, agencyId: "agency-1" },
  "t-owner": { uid: "owner-uid", role: ROLES.OWNER, agencyId: "agency-1" },
};
const NON_ADMIN = ["t-client", "t-agent", "t-owner"];

let server: http.Server;
let baseUrl = "";
let h: Harness;
let jh: JobHarness;
/** What the stubbed entitlements read returns (null = unresolved). */
let entitlements: any = null;

before(async () => {
  await installRubricFakes();
  const firebase: any = await import("../../../src/utils/firebase");
  firebase.auth.verifyIdToken = async (token: string) => {
    const decoded = TOKENS[token];
    if (!decoded) throw new Error("invalid token");
    return decoded;
  };
  const { entitlementService }: any = await import("../../../src/services/entitlement.service");
  entitlementService.getEntitlements = async () => entitlements;
  const { claimsService }: any = await import("../../../src/services/claims.service");
  claimsService.resolveRoleFromDb = async () => ({ role: ROLES.CLIENT, agencyId: null });
  claimsService.setRoleClaims = async () => undefined;

  const app = express();
  app.use(express.json());
  app.use("/admin/rubric-extraction-jobs", adminRubricExtractionJobRoutes);
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

beforeEach(() => {
  resetStore();
  resetBucket();
  entitlements = null;
  h = makeHarness();
  jh = makeJobHarness(h);
  // The route handlers use the service singleton: point it at the fakes.
  (rubricExtractionJobService as any).deps = (jh.jobs as any).deps;
});

/** One HTTP call. `token` null sends no Authorization header. */
async function api(method: string, urlPath: string, token: string | null, payload?: unknown): Promise<{ status: number; body: any }> {
  const { result } = await quiet(async () => {
    const res = await fetch(`${baseUrl}/admin/rubric-extraction-jobs${urlPath}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
      ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
    });
    const text = await res.text();
    // Express answers a body that is not JSON with an HTML page: not our shape, still a 400.
    return { status: res.status, body: text.startsWith("{") ? JSON.parse(text) : { raw: text } };
  });
  return result;
}

const jobDocs = () => [...store.keys()].filter((k) => /^rubricExtractionJobs\/[^/]+$/.test(k));
const FAKE_ID = "XA_none__0123456789abcdef";

describe("who may call", () => {
  test("no token: 401 on every route, before anything is read", async () => {
    for (const [method, p, body] of [["POST", "", { countryCode: "XA", visaTypeId: "x" }], ["GET", `/${FAKE_ID}`, undefined], ["POST", `/${FAKE_ID}/cancel`, {}]] as const) {
      assert.equal((await api(method, p, null, body)).status, 401, `${method} ${p}`);
    }
    assert.equal((await api("GET", `/${FAKE_ID}`, "bad-token")).status, 401);
  });

  for (const entitled of [null, { resolved: true }]) {
    test(`client, agent and owner: 403 on every route (entitlements ${entitled ? "resolved" : "unresolved"}), and nothing is created`, async () => {
      const { FEATURES }: any = await import("@durin-tech/authz");
      entitlements = entitled === null ? null : { subscriberType: "agency", subscriberId: "agency-1", planId: "top", status: "active", features: Object.values(FEATURES), limits: {} };
      const setup = await setUpMulti(h, 1, 3);
      for (const token of NON_ADMIN) {
        const start = await api("POST", "", token, { countryCode: ROUTE.countryCode, visaTypeId: ROUTE.visaTypeId, sourceIds: setup.sourceIds });
        assert.equal(start.status, 403, token);
        assert.equal(start.body.error, "FORBIDDEN");
        assert.equal((await api("GET", `/${FAKE_ID}`, token)).status, 403, token);
        assert.equal((await api("POST", `/${FAKE_ID}/cancel`, token, {})).status, 403, token);
        // Refused before validation: an invalid body is still a 403, not a 400.
        assert.equal((await api("POST", "", token, { nonsense: true })).status, 403);
      }
      assert.equal(jobDocs().length, 0);
      assert.equal(jh.calls.length, 0);
    });
  }

  test("an admin starts a job (201), reads its status (200) and cancels it (200)", async () => {
    const setup = await setUpMulti(h, 2, 5);
    const started = await api("POST", "", "t-admin", { countryCode: ROUTE.countryCode, visaTypeId: ROUTE.visaTypeId, sourceIds: setup.sourceIds });
    assert.equal(started.status, 201, JSON.stringify(started.body));
    assert.equal(started.body.success, true);
    assert.equal(started.body.data.outcome, "started");
    const id = started.body.data.jobId as string;
    assert.match(id, new RegExp(`^${ROUTE_KEY}__[0-9a-f]{16}$`));
    assert.equal(started.body.data.estimate.chunks, setup.chunks);
    // The record names who started it.
    assert.equal((store.get(`rubricExtractionJobs/${id}`) as any).requestedBy, "admin-uid");
    // A duplicate start: 200, the same job.
    const again = await api("POST", "", "t-admin", { countryCode: ROUTE.countryCode, visaTypeId: ROUTE.visaTypeId, sourceIds: setup.sourceIds });
    assert.equal(again.status, 200);
    assert.equal(again.body.data.outcome, "existing");
    assert.equal(again.body.data.jobId, id);
    // Status.
    const status = await api("GET", `/${id}`, "t-admin");
    assert.equal(status.status, 200);
    assert.equal(status.body.data.status, "queued");
    assert.equal(status.body.data.stepsDone, 0);
    assert.equal(status.body.data.chunks, setup.chunks);
    assert.equal(status.body.data.cancelRequested, false);
    // Cancel.
    const cancelled = await api("POST", `/${id}/cancel`, "t-admin");
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.data.status, "cancelled");
    assert.equal(versionPaths().length, 0);
    assert.equal(runDocs()[0].reasonCode, "cancelled");
    assert.equal((await api("GET", `/${id}`, "t-admin")).body.data.status, "cancelled");
  });

  test("a plan (dryRun) returns the plan and creates nothing", async () => {
    const setup = await setUpMulti(h, 1, 5);
    const r = await api("POST", "", "t-admin", { countryCode: ROUTE.countryCode, visaTypeId: ROUTE.visaTypeId, sourceIds: setup.sourceIds, dryRun: true });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.outcome, "dry_run");
    assert.equal(r.body.data.plan.length, 1);
    assert.equal(jobDocs().length, 0);
  });
});

describe("requests are strict", () => {
  const good = { countryCode: "XA", visaTypeId: "xa-short-visit", sourceIds: ["src-1"] };

  test("unknown fields, wrong types and malformed ids are 400", async () => {
    const bad: unknown[] = [
      { ...good, extra: 1 },
      { ...good, countryCode: "xa" },
      { ...good, countryCode: "XAA" },
      { ...good, visaTypeId: "" },
      { ...good, visaTypeId: "a/b" },
      { ...good, sourceIds: [] },
      { ...good, sourceIds: "src-1" },
      { ...good, sourceIds: [1] },
      { ...good, sourceIds: ["../x"] },
      { ...good, dryRun: "yes" },
      { ...good, force: 1 },
      [],
      "text",
    ];
    for (const body of bad) {
      const r = await api("POST", "", "t-admin", body);
      assert.equal(r.status, 400, JSON.stringify(body));
      if (r.body.error !== undefined) assert.equal(r.body.error, "VALIDATION_ERROR");
    }
    assert.equal(jobDocs().length, 0);
  });

  test("the parser accepts exactly the documented keys", () => {
    assert.deepEqual(parseStartBody({ ...good, dryRun: true, force: true }), { ok: true, input: { ...good, dryRun: true, force: true } });
    assert.deepEqual(parseStartBody({ countryCode: "XA", visaTypeId: "x" }), { ok: true, input: { countryCode: "XA", visaTypeId: "x" } });
  });

  test("cancel takes no body, and a malformed job id is a 404", async () => {
    assert.equal((await api("POST", `/${FAKE_ID}/cancel`, "t-admin", { x: 1 })).status, 400);
    assert.equal((await api("GET", "/not-a-job-id", "t-admin")).status, 404);
    assert.equal((await api("GET", `/${FAKE_ID}`, "t-admin")).status, 404);
    assert.equal((await api("POST", `/${FAKE_ID}/cancel`, "t-admin")).status, 404);
  });
});

describe("refusals carry the service's own clear message", () => {
  test("a route whose visa type does not exist: 404 with the existing message, and no job", async () => {
    const setup = await setUpMulti(h, 1, 3);
    h.state.knownVisaTypes.clear();
    const r = await api("POST", "", "t-admin", { countryCode: ROUTE.countryCode, visaTypeId: ROUTE.visaTypeId, sourceIds: setup.sourceIds });
    assert.equal(r.status, 404);
    assert.equal(r.body.error, "NOT_FOUND");
    assert.match(r.body.message, new RegExp(`no visa type ${ROUTE.visaTypeId} under ${ROUTE.countryCode}`));
    assert.equal(jobDocs().length, 0);
  });

  test("the switch off, the settings unreadable and a cap used up are refused (409 / 503) with a reason", async () => {
    const setup = await setUpMulti(h, 1, 3);
    const body = { countryCode: ROUTE.countryCode, visaTypeId: ROUTE.visaTypeId, sourceIds: setup.sourceIds };
    h.settings.enabled = false;
    assert.equal((await api("POST", "", "t-admin", body)).status, 409);
    h.settings.enabled = true;
    h.state.readError = "boom";
    assert.equal((await api("POST", "", "t-admin", body)).status, 503);
    h.state.readError = undefined;
    h.settings.maxRequestsPerRun = 1;
    const capped = await api("POST", "", "t-admin", body);
    assert.equal(capped.status, 409);
    assert.match(capped.body.message, /cap/);
    assert.equal(jobDocs().length, 0);
  });

  test("nothing in the response carries source text", async () => {
    const setup = await setUpMulti(h, 1, 3);
    const r = await api("POST", "", "t-admin", { countryCode: ROUTE.countryCode, visaTypeId: ROUTE.visaTypeId, sourceIds: setup.sourceIds });
    assert.doesNotMatch(JSON.stringify(r.body), /The applicant must provide evidence/);
  });
});

describe("how the routes are wired", () => {
  const SRC = path.join(__dirname, "..", "..", "..", "src");

  test("exactly three routes, each behind verifyAuth, requireRubricAdmin and verifyAdmin in that order", () => {
    const stack = (adminRubricExtractionJobRoutes as any).stack.filter((l: any) => l.route);
    assert.deepEqual(stack.map((l: any) => `${Object.keys(l.route.methods)[0]} ${l.route.path}`), ["post /", "get /:id", "post /:id/cancel"]);
    for (const l of stack) {
      assert.deepEqual(l.route.stack.slice(0, 3).map((s: any) => s.name), ["verifyAuth", "requireRubricAdmin", "verifyAdmin"]);
    }
  });

  test("app.ts mounts them once, under /admin/rubric-extraction-jobs", () => {
    const app = fs.readFileSync(path.join(SRC, "app.ts"), "utf8");
    assert.deepEqual([...app.matchAll(/app\.use\("([^"]*)",\s*adminRubricExtractionJobRoutes\)/g)].map((m) => m[1]), ["/admin/rubric-extraction-jobs"]);
  });

  test("the worker trigger and the sweep: right paths, only the worker binds the AI key, the sweep takes no secret", () => {
    const index = fs.readFileSync(path.join(SRC, "index.ts"), "utf8");
    const block = (name: string) => {
      const at = index.indexOf(`export const ${name}`);
      assert.ok(at > 0, name);
      return index.slice(at, index.indexOf("\n  });\n", at));
    };
    const worker = block("processRubricExtractionJob");
    assert.match(worker, /secrets: \[\.\.\.AI_SECRETS\]/);
    assert.match(worker, /timeoutSeconds: 540/);
    assert.match(worker, /\.firestore\.document\("rubricExtractionJobs\/\{jobId\}"\)\s*\.onWrite/);
    // Only a new job or a changed `kick` wakes it.
    assert.match(worker, /before\.kick === after\.kick/);
    assert.match(worker, /rubricExtractionJobService\.advance\(/);
    const sweep = block("sweepRubricExtractionJobs");
    assert.doesNotMatch(sweep, /secrets/);
    assert.match(sweep, /schedule\("\*\/5 \* \* \* \*"\)/);
    assert.match(sweep, /rubricExtractionJobService\.sweep\(\)/);
    // The guidance trigger still goes through the service's listener.
    assert.match(index, /rubricExtractionService\.onGuidanceChanged\(/);
  });
});
