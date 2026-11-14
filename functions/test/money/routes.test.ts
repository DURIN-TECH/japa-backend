// ============================================
// Unit tests: /rates and /admin/exchange-rates routes (issue #178)
// ============================================
//
// Hermetic: no network, no emulator. Admin gating is exercised on the REAL app
// (src/app.ts) with auth.verifyIdToken stubbed, the way the risk-signal routes
// are; the rate behaviour is exercised on a small Express app that mounts the
// route factories over an in-memory rate service.

import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { app } from "../../src/app";
import { auth } from "../../src/utils/firebase";
import { createAdminExchangeRateRouter, createPublicRatesRouter } from "../../src/routes/exchange-rate.routes";
import { installFakes, resetStore } from "../helpers/fake-firestore";
import { makeService } from "./helpers";

/* eslint-disable @typescript-eslint/no-explicit-any */

const PRINCIPALS: Record<string, any> = {
  admin: { uid: "uid-admin", role: "admin" },
  client: { uid: "uid-client", role: "client" },
  agent: { uid: "uid-agent", role: "agent", agencyId: "agency-1" },
  owner: { uid: "uid-owner", role: "owner", agencyId: "agency-1" },
};

let realServer: Server;
let realBase = "";
let originalVerify: typeof auth.verifyIdToken;

async function call(base: string, path: string, opts: { token?: string; method?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  return { status: res.status, text, json: text ? JSON.parse(text) : null, headers: res.headers };
}

before(async () => {
  await installFakes();
  originalVerify = auth.verifyIdToken;
  (auth as any).verifyIdToken = async (token: string) => {
    const p = PRINCIPALS[token];
    if (!p) throw new Error("unknown test token");
    return { ...p, admin: p.role === "admin" };
  };
  await new Promise<void>((resolve) => {
    realServer = app.listen(0, "127.0.0.1", resolve);
  });
  realBase = `http://127.0.0.1:${(realServer.address() as AddressInfo).port}`;
});
after(async () => {
  (auth as any).verifyIdToken = originalVerify;
  await new Promise<void>((resolve) => realServer.close(() => resolve()));
});
beforeEach(() => resetStore());

describe("admin routes are admin-only (real app mount)", () => {
  const routes: [string, string][] = [
    ["GET", "/admin/exchange-rates"],
    ["PUT", "/admin/exchange-rates/NGN"],
    ["DELETE", "/admin/exchange-rates/NGN"],
    // Issue #214: reset-reference and the new refresh-now route on the real app.
    ["POST", "/admin/exchange-rates/NGN/reset-reference"],
    ["POST", "/admin/exchange-rates/NGN/refresh"],
  ];
  test("no token -> 401", async () => {
    for (const [method, path] of routes) {
      const r = await call(realBase, path, { method, body: method === "GET" ? undefined : { rate: 1500, reason: "should not work" } });
      assert.equal(r.status, 401, `${method} ${path}`);
    }
  });
  test("client, agent and agency owner -> 403 on read and write, with nothing in the body", async () => {
    for (const who of ["client", "agent", "owner"]) {
      for (const [method, path] of routes) {
        const r = await call(realBase, path, { token: who, method, body: method === "GET" ? undefined : { rate: 1500, reason: "should not work" } });
        assert.equal(r.status, 403, `${who} ${method} ${path}`);
        assert.ok(!/rate|audit|override/i.test(JSON.stringify(r.json.data ?? {})));
      }
    }
  });
});

describe("public /rates on the real app mount (issue #214)", () => {
  test("reachable with no token", async () => {
    const r = await call(realBase, "/rates");
    assert.equal(r.status, 200);
    assert.equal(r.json.data.base, "USD");
  });
});

describe("rate behaviour (in-memory service)", () => {
  let server: Server;
  let base = "";
  let ctx: ReturnType<typeof makeService>;

  before(async () => {
    ctx = makeService();
    await ctx.service.refreshAll();
    const a = express();
    a.use(express.json());
    // The router's cache follows the test clock, so moving the clock ages it.
    a.use("/rates", createPublicRatesRouter(ctx.service, { now: () => ctx.clock.now().getTime() }));
    a.use("/admin/exchange-rates", createAdminExchangeRateRouter(ctx.service));
    await new Promise<void>((resolve) => {
      server = a.listen(0, "127.0.0.1", resolve);
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("GET /rates is unauthenticated, cacheable, and exposes only currency, exponent, available, rate, asOf", async () => {
    // an override with a sensitive reason and an audit entry exist; none may leak
    await ctx.service.setOverride("NGN", { rate: 1520, reason: "SECRET-INTERNAL-REASON" }, "uid-admin-secret");
    const r = await call(base, "/rates");
    assert.equal(r.status, 200);
    assert.match(r.headers.get("cache-control") ?? "", /public/);
    assert.deepEqual(Object.keys(r.json.data).sort(), ["base", "currencies"]);
    assert.equal(r.json.data.base, "USD");
    assert.deepEqual(Object.keys(r.json.data.currencies[0]).sort(), ["asOf", "available", "currency", "exponent", "rate"]);
    assert.equal(r.json.data.currencies[0].rate, 1520);
    for (const forbidden of ["SECRET-INTERNAL-REASON", "uid-admin-secret", "marginBps", "margin", "manual", "source", "audit", "override", "setBy", "lastError"]) {
      assert.ok(!r.text.includes(forbidden), `public body leaked "${forbidden}"`);
    }
    await ctx.service.clearOverride("NGN", "test cleanup done", "uid-admin-secret");
  });

  test("GET /rates reports a stale rate as unavailable, never a number", async () => {
    ctx.clock.advanceHours(100);
    const r = await call(base, "/rates");
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.data.currencies[0], { currency: "NGN", exponent: 2, available: false, rate: null, asOf: null });
    await ctx.service.refreshAll(); // restore for later tests
  });

  test("PUT validates and stores; GET shows override and audit; bad input is 400", async () => {
    // (auth is not mounted in this app's gating sense: verifyAuth is, so use the real principals)
    const put = await call(base, "/admin/exchange-rates/NGN", { token: "admin", method: "PUT", body: { rate: 1510, reason: "CBN outage today" } });
    assert.equal(put.status, 200);
    const bad = await call(base, "/admin/exchange-rates/NGN", { token: "admin", method: "PUT", body: { rate: 5000, reason: "way outside band" } });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error, "INVALID_INPUT");
    const unknown = await call(base, "/admin/exchange-rates/XXX", { token: "admin", method: "PUT", body: { rate: 1, reason: "no such currency" } });
    assert.equal(unknown.status, 404);
    const list = await call(base, "/admin/exchange-rates", { token: "admin" });
    assert.equal(list.status, 200);
    const row = list.json.data.currencies[0];
    assert.equal(row.stored.override.reason, "CBN outage today");
    assert.equal(row.audit[0].by, "uid-admin");
  });
});

// ============================================
// Issue #214: refresh-now route and the in-process GET /rates cache
// ============================================

describe("POST /admin/exchange-rates/:currency/refresh and the /rates cache", () => {
  let server: Server;
  let base = "";
  let ctx: ReturnType<typeof makeService>;
  /** How many times the router asked the service for the config (one per uncached build). */
  let builds = 0;

  before(async () => {
    ctx = makeService();
    const realGetConfig = ctx.service.getConfig.bind(ctx.service);
    ctx.service.getConfig = async () => {
      builds++;
      return realGetConfig();
    };
    const a = express();
    a.use(express.json());
    a.use("/rates", createPublicRatesRouter(ctx.service, { now: () => ctx.clock.now().getTime() }));
    a.use("/admin/exchange-rates", createAdminExchangeRateRouter(ctx.service));
    await new Promise<void>((resolve) => {
      server = a.listen(0, "127.0.0.1", resolve);
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("refresh: 200 with the outcome, then 429 with Retry-After inside the cooldown", async () => {
    const ok = await call(base, "/admin/exchange-rates/NGN/refresh", { token: "admin", method: "POST", body: {} });
    assert.equal(ok.status, 200);
    assert.deepEqual([ok.json.data.ok, ok.json.data.rate], [true, 1500]);
    const again = await call(base, "/admin/exchange-rates/NGN/refresh", { token: "admin", method: "POST", body: { reason: "second try now" } });
    assert.equal(again.status, 429);
    assert.equal(again.json.error, "RATE_LIMITED");
    assert.ok(Number(again.headers.get("retry-after")) > 0);
    const audit = await ctx.store.listAudit("NGN", 5);
    assert.equal(audit.filter((x) => x.action === "provider_refresh").length, 1);
  });

  test("GET /rates is served from cache within 60s, rebuilt after it, and rebuilt at once after an override", async () => {
    builds = 0;
    const first = await call(base, "/rates");
    const second = await call(base, "/rates");
    assert.equal(builds, 1, "second call served from cache");
    assert.deepEqual(second.json, first.json);

    await ctx.service.setOverride("NGN", { rate: 1520, reason: "cache invalidation test" }, "uid-admin");
    builds = 1; // setOverride reads the config itself; count router builds only
    const afterOverride = await call(base, "/rates");
    assert.equal(builds, 2, "override invalidates the cache");
    assert.equal(afterOverride.json.data.currencies[0].rate, 1520);

    ctx.clock.advanceHours(61 / 3600);
    await call(base, "/rates");
    assert.equal(builds, 3, "expired after 60s");
  });
});
