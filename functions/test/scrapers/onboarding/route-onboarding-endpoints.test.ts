// ============================================
// Route onboarding: admin endpoints (issue #217)
// ============================================
//
// Every route over REAL HTTP against the real router and the real `verifyAuth`
// and `verifyAdmin` (only the token check and the entitlements read are
// stubbed), on the Firestore fake: no token 401; client, agent and owner 403
// whatever their entitlements; admin 200. Strict bodies, field whitelist,
// error codes and the exact response shapes the portal builds against.

import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { ROLES } from "@durin-tech/authz";
import { resetStore, store } from "../../helpers/fake-firestore";
import { resetBucket } from "../rubric/rubric-harness";
import { quiet } from "../rubric/rubric-harness";
import { adminRouteOnboardingRoutes } from "../../../src/scrapers/onboarding/onboarding.routes";
import { routeOnboardingService } from "../../../src/scrapers/onboarding/route-onboarding.service";
import { COUNTRY, ROUTE_KEY, VISA_ID, driveJob, installOnboardingFakes, makeOnboarding, pump, runOf, type OnboardingHarness } from "./onboarding-harness";

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
let oh: OnboardingHarness;
let entitlements: any = null;

before(async () => {
  await installOnboardingFakes();
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
  app.use("/admin/route-onboarding", adminRouteOnboardingRoutes);
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

beforeEach(async () => {
  resetStore();
  resetBucket();
  entitlements = null;
  oh = await makeOnboarding();
  // The handlers use the service singleton: point it at the fakes.
  (routeOnboardingService as any).overrides = oh.deps;
});

async function api(method: string, urlPath: string, token: string | null, payload?: unknown): Promise<{ status: number; body: any }> {
  const { result } = await quiet(async () => {
    const res = await fetch(`${baseUrl}/admin/route-onboarding${urlPath}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
      ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
    });
    const text = await res.text();
    return { status: res.status, body: text.startsWith("{") ? JSON.parse(text) : { raw: text } };
  });
  return result;
}

const START = { countryCode: COUNTRY, visaTypeId: VISA_ID };
const FAKE_ID = `${ROUTE_KEY}__r1`;
const runDocs = () => [...store.keys()].filter((k) => /^routeOnboardingRuns\/[^/]+$/.test(k));

describe("who may call", () => {
  const ROUTES: [string, string, unknown][] = [
    ["POST", "", START],
    ["GET", "", undefined],
    ["GET", "/settings", undefined],
    ["PATCH", "/settings", { enabled: true }],
    ["GET", `/${FAKE_ID}`, undefined],
    ["POST", `/${FAKE_ID}/confirm`, { estimateId: "est_0123456789abcdef", statementAccepted: true }],
    ["POST", `/${FAKE_ID}/cancel`, {}],
  ];

  test("no token: 401 on every route, before anything is read", async () => {
    for (const [m, p, b] of ROUTES) assert.equal((await api(m, p, null, b)).status, 401, `${m} ${p}`);
    assert.equal((await api("GET", "", "bad-token")).status, 401);
    assert.equal(runDocs().length, 0);
  });

  for (const entitled of [null, { resolved: true }]) {
    test(`client, agent and owner: 403 on every route (entitlements ${entitled ? "resolved" : "unresolved"}), nothing created, even for an invalid body`, async () => {
      const { FEATURES }: any = await import("@durin-tech/authz");
      entitlements = entitled === null ? null : { subscriberType: "agency", subscriberId: "agency-1", planId: "top", status: "active", features: Object.values(FEATURES), limits: {} };
      for (const token of NON_ADMIN) {
        for (const [m, p, b] of ROUTES) {
          const r = await api(m, p, token, b);
          assert.equal(r.status, 403, `${token} ${m} ${p}`);
          assert.equal(r.body.success, false);
        }
        assert.equal((await api("POST", "", token, { nonsense: true })).status, 403);
      }
      assert.equal(runDocs().length, 0);
      assert.equal(oh.onboarding.settings.enabled, true);
    });
  }

  test("admin: 200 / 201 on every route", async () => {
    const started = await api("POST", "", "t-admin", START);
    assert.equal(started.status, 201);
    const id = started.body.data.runId;
    assert.equal((await api("GET", "", "t-admin")).status, 200);
    assert.equal((await api("GET", "/settings", "t-admin")).status, 200);
    assert.equal((await api("PATCH", "/settings", "t-admin", { maxRunsPerDay: 5 })).status, 200);
    assert.equal((await api("GET", `/${id}`, "t-admin")).status, 200);
    assert.equal((await api("POST", `/${id}/cancel`, "t-admin", {})).status, 200);
  });
});

describe("the contract the portal builds against", () => {
  test("start: 201 { runId, status, run } and the exact error codes", async () => {
    const ok = await api("POST", "", "t-admin", START);
    assert.equal(ok.status, 201);
    assert.equal(ok.body.data.runId, FAKE_ID);
    assert.equal(ok.body.data.status, "preparing");
    assert.deepEqual(ok.body.data.run.steps.map((s: any) => s.id), ["check_setup", "read_visa_page", "read_rule_pages", "plan", "confirm", "draft", "safeguards"]);
    const dup = await api("POST", "", "t-admin", START);
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error, "RUN_ACTIVE");
    assert.equal(dup.body.activeRunId, FAKE_ID);
    assert.equal(dup.body.success, false);
    assert.equal((await api("POST", "", "t-admin", { countryCode: COUNTRY, visaTypeId: "xa-nope" })).status, 404);
    assert.equal((await api("POST", "", "t-admin", { countryCode: COUNTRY })).status, 400);
    assert.equal((await api("POST", "", "t-admin", { countryCode: "xa", visaTypeId: VISA_ID })).status, 400);
    assert.equal((await api("POST", "", "t-admin", { ...START, extra: 1 })).status, 400);
    oh.onboarding.settings.enabled = false;
    store.delete(`routeOnboardingRoutes/${ROUTE_KEY}`);
    const off = await api("POST", "", "t-admin", START);
    assert.equal(off.status, 503);
    assert.equal(off.body.error, "ONBOARDING_DISABLED");
    oh.onboarding.settings.enabled = true;
    oh.onboarding.settings.maxRunsPerDay = 1;
    const over = await api("POST", "", "t-admin", START);
    assert.equal(over.status, 429);
    assert.equal(over.body.error, "DAILY_LIMIT_REACHED");
  });

  test("get: the run with steps, estimate, counters, links, checklist; no lease or retry internals", async () => {
    const run = await oh.svc.start(COUNTRY, VISA_ID, "admin-uid");
    await pump(oh, run.runId);
    const r = await api("GET", `/${run.runId}`, "t-admin");
    assert.equal(r.status, 200);
    const v = r.body.data.run;
    assert.equal(v.status, "awaiting_confirmation");
    assert.deepEqual(Object.keys(v).sort(), ["allowlist", "cancelRequested", "confirmation", "counters", "countryCode", "createdAt", "createdBy", "estimate", "finishedAt", "holdReason", "links", "routeKey", "runId", "status", "steps", "summary", "unchanged", "updatedAt", "visaTypeId", "voidedConfirmations"].sort());
    assert.equal(typeof v.createdAt, "string");
    assert.equal(typeof v.estimate.createdAt, "string");
    assert.deepEqual(Object.keys(v.counters).sort(), ["calls", "chunksDone", "chunksTotal", "costUsd", "inputTokens", "outputTokens"]);
    assert.equal(r.body.data.checklist.length, 2);
    assert.equal((await api("GET", "/XA_x__r99", "t-admin")).status, 404);
    assert.equal((await api("GET", "/not-an-id", "t-admin")).status, 404);
  });

  test("list: rows newest first, status filter, strict query", async () => {
    await oh.svc.start(COUNTRY, VISA_ID, "admin-uid");
    const all = await api("GET", "", "t-admin");
    assert.equal(all.body.data.total, 1);
    assert.deepEqual(Object.keys(all.body.data.runs[0]).sort(), ["countryCode", "counters", "createdAt", "createdBy", "finishedAt", "holdReason", "routeKey", "runId", "status", "summary", "visaTypeId"].sort());
    assert.equal((await api("GET", "?status=failed", "t-admin")).body.data.total, 0);
    assert.equal((await api("GET", "?status=bogus", "t-admin")).status, 400);
    assert.equal((await api("GET", "?limit=0", "t-admin")).status, 400);
  });

  test("confirm: 400 without the statement or with a bad body, 409 for a wrong id or status, 200 once and on a repeat", async () => {
    const run = await oh.svc.start(COUNTRY, VISA_ID, "admin-uid");
    await pump(oh, run.runId);
    const id = (runOf(run.runId).estimate as any).estimateId;
    const url = `/${run.runId}/confirm`;
    assert.equal((await api("POST", url, "t-admin", { estimateId: id })).body.error, "STATEMENT_REQUIRED");
    assert.equal((await api("POST", url, "t-admin", { estimateId: id, statementAccepted: false })).status, 400);
    assert.equal((await api("POST", url, "t-admin", { estimateId: id, statementAccepted: "yes" })).status, 400);
    assert.equal((await api("POST", url, "t-admin", { statementAccepted: true })).status, 400);
    assert.equal((await api("POST", url, "t-admin", { estimateId: id, statementAccepted: true, addToAllowlist: "x" })).status, 400);
    assert.equal((await api("POST", url, "t-admin", { estimateId: id, statementAccepted: true, who: "me" })).status, 400);
    assert.equal(runOf(run.runId).status, "awaiting_confirmation");
    const wrong = await api("POST", url, "t-admin", { estimateId: "est_0000000000000000", statementAccepted: true });
    assert.equal(wrong.status, 409);
    assert.equal(wrong.body.error, "ESTIMATE_MISMATCH");
    assert.equal(wrong.body.currentEstimateId, id);
    const ok = await api("POST", url, "t-admin", { estimateId: id, statementAccepted: true });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.data.alreadyConfirmed, false);
    assert.equal(ok.body.data.run.status, "running");
    assert.equal(ok.body.data.run.confirmation.by, "admin-uid");
    const again = await api("POST", url, "t-admin", { estimateId: id, statementAccepted: true });
    assert.equal(again.status, 200);
    assert.equal(again.body.data.alreadyConfirmed, true);
    const other = await api("POST", url, "t-admin", { estimateId: "est_0000000000000000", statementAccepted: true });
    assert.equal(other.body.error, "NOT_AWAITING_CONFIRMATION");
    await pump(oh, run.runId);
    await pump(oh, run.runId);
    assert.equal([...store.keys()].filter((k) => /^rubricExtractionJobs\/[^/]+$/.test(k)).length, 1);
    await driveJob(oh, runOf(run.runId).links.jobId as string);
  });

  test("cancel: 200, then 409 RUN_FINISHED; a body is refused; unknown run 404", async () => {
    const run = await oh.svc.start(COUNTRY, VISA_ID, "admin-uid");
    assert.equal((await api("POST", `/${run.runId}/cancel`, "t-admin", { reason: "x" })).status, 400);
    const ok = await api("POST", `/${run.runId}/cancel`, "t-admin");
    assert.equal(ok.status, 200);
    assert.equal(ok.body.data.run.status, "cancelled");
    const again = await api("POST", `/${run.runId}/cancel`, "t-admin");
    assert.equal(again.status, 409);
    assert.equal(again.body.error, "RUN_FINISHED");
    assert.equal((await api("POST", `/${ROUTE_KEY}__r77/cancel`, "t-admin")).status, 404);
  });

  test("settings: GET and an audited, strict PATCH that leaves the registry's fields alone", async () => {
    store.set("appConfig/routeOnboardingSettings", { supportedLanguages: ["en"], previewsPerHour: 7 });
    const patched = await api("PATCH", "/settings", "t-admin", { enabled: true, maxChunksPerRun: 9 });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.data.settings.maxChunksPerRun, 9);
    const stored: any = store.get("appConfig/routeOnboardingSettings");
    assert.deepEqual(stored.supportedLanguages, ["en"]);
    assert.equal(stored.previewsPerHour, 7);
    const audits = [...store.keys()].filter((k) => k.startsWith("sourceRegistryAudit/")).map((k) => store.get(k) as any).filter((a) => a.action === "onboarding_settings_changed");
    assert.equal(audits.length, 1);
    assert.equal(audits[0].actorUid, "admin-uid");
    assert.equal(audits[0].before.previewsPerHour, 7);
    for (const bad of [{}, { enabled: "yes" }, { maxRunsPerDay: 0 }, { maxRunsPerDay: 1.5 }, { supportedLanguages: ["es"] }, { nonsense: 1 }]) {
      assert.equal((await api("PATCH", "/settings", "t-admin", bad)).status, 400, JSON.stringify(bad));
    }
    assert.equal((await api("GET", "/settings", "t-admin")).body.data.settings.maxChunksPerRun, 9);
  });
});
