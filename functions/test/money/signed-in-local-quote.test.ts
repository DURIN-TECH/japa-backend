// ============================================
// Unit tests — signed-in clients are quoted in their own currency on the
// public agent and agency reads (issue #286)
// ============================================
//
// Before #286, GET /agents* and GET /agencies/browse* (and the slug page)
// called `loadLocalPricer({ uid: req.userId })` but had no auth middleware,
// so `uid` was always undefined and everyone was quoted in naira, while
// POST /consultations charges in the client's profile-country currency.
//
// Hermetic: the REAL agent and agency routers on a local HTTP server, the
// in-memory Firestore fake, an in-memory rate service with NGN (default) and
// a second currency GHS (Ghana), and `verifyIdToken` replaced by a fixed
// token table. Covers:
//  - guest (no header): default currency (NGN);
//  - signed-in Nigerian client: NGN;
//  - signed-in Ghanaian client: GHS on `consultationFeeLocal` and `priceLocal`;
//  - an invalid token, a non-Bearer header and a disabled account's token are
//    all served as a guest (200, NGN), never a 401 and never trusted;
//  - one shared rule: the read's currency equals `chargeCurrencyForPayer`
//    (what POST /consultations charges) for the same client.
import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { Timestamp } from "firebase-admin/firestore";
import { ROLES } from "@durin-tech/authz";

import { fakeCollection, installFakes, resetStore, store } from "../helpers/fake-firestore";
import { fakeCollectionGroup } from "../helpers/fake-collection-group";
import { makeService, fakeClock } from "./helpers";
import { localPricing } from "../../src/money/local-price";
import { payerCurrency } from "../../src/money/payer-currency";
import { parseCurrenciesConfig } from "../../src/money/config";
import { chargeRuntime, chargeCurrencyForPayer } from "../../src/services/charge-checkout.service";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ============================================
// Fixtures
// ============================================

/** The clock and rate date of the suite. */
const NOW = "2026-11-13T09:00:00Z";
/** Naira per dollar. */
const NGN_RATE = 1500;
/** Cedis per dollar (the second, made-up charge currency). */
const GHS_RATE = 15;

/** Currencies config: NGN default plus GHS mapped from Ghana. */
const CONFIG = {
  defaultCurrency: "NGN",
  currencies: { GHS: { enabled: true, countries: ["GH", "Ghana"], minRate: 5, maxRate: 50 } },
};

/** uid -> stored profile country. */
const COUNTRIES: Record<string, string> = { "uid-ng": "Nigeria", "uid-gh": "Ghana" };

/** Valid tokens -> decoded token. Anything else fails verification. */
const TOKENS: Record<string, Record<string, unknown>> = {
  "tok-ng": { uid: "uid-ng", role: ROLES.CLIENT },
  "tok-gh": { uid: "uid-gh", role: ROLES.CLIENT },
  // A Ghanaian account that has been disabled (suspended): served as a guest.
  "tok-gh-disabled": { uid: "uid-gh", role: ROLES.CLIENT, disabled: true },
};

/** USD Money in cents. */
const usd = (cents: number) => ({ amountMinor: cents, currency: "USD" });
const T0 = Timestamp.fromMillis(1_700_000_000_000);

/** One approved agency ($100 fee, one $25 service) with one $10 agent. */
function seedWorld(): void {
  store.set("agencies/agency-a", {
    id: "agency-a", slug: "acme", name: "Acme Visas", ownerId: "uid-owner", ownerName: "Ola Owner",
    consultationFeeUsd: usd(10_000), services: [{ id: "svc-1", name: "CV review", priceUsd: usd(2_500) }],
    totalAgents: 1, totalCases: 0, status: "approved", compliance: { status: "verified" }, createdAt: T0, updatedAt: T0,
  });
  store.set("agents/agent-1", {
    id: "agent-1", userId: "uid-agent-1", agencyId: "agency-a", agencyRole: "member", displayName: "Ada Agent",
    bio: "Bio", yearsOfExperience: 5, specializations: ["Work Visa"], languages: ["English"], featuredVisas: [],
    verificationStatus: "verified", rating: 4.5, totalReviews: 0, totalApplications: 0, successRate: 90,
    responseTime: "24 hours", consultationFeeUsd: usd(1_000), isAvailable: true, createdAt: T0, updatedAt: T0,
  });
}

// ============================================
// Server + fakes
// ============================================

let server: http.Server;
let base = "";
const saved = {
  rates: localPricing.rates,
  profileCountry: localPricing.profileCountry,
  chargeRates: chargeRuntime.rates,
  chargeProfile: chargeRuntime.profileCountry,
};

before(async () => {
  await installFakes();
  const firebase: any = await import("../../src/utils/firebase");
  firebase.collections.agencies = fakeCollection("agencies");
  firebase.collections.agents = fakeCollection("agents");
  firebase.collectionGroups.visaTypes = () => fakeCollectionGroup("visaTypes");
  firebase.subcollections.agencyVisaPrices = (id: string) => fakeCollection(`agencies/${id}/visaPrices`);
  // Token verification: the fixed table, everything else is invalid.
  firebase.auth.verifyIdToken = async (token: string) => {
    const d = TOKENS[token];
    if (!d) throw new Error("invalid token");
    return d;
  };
  // attachAuthz: no entitlements, role from the token.
  const { entitlementService }: any = await import("../../src/services/entitlement.service");
  entitlementService.getEntitlements = async () => null;
  const { claimsService }: any = await import("../../src/services/claims.service");
  claimsService.resolveRoleFromDb = async () => ({ role: ROLES.CLIENT, agencyId: null });
  claimsService.setRoleClaims = async () => undefined;

  // One in-memory rate service for BOTH the reads and the charge path, with
  // the same profile countries: so the "one rule" check compares like with like.
  const { service, store: rates } = makeService({ config: CONFIG, clock: fakeClock(NOW) });
  const at = new Date(NOW);
  for (const [currency, rate] of [["NGN", NGN_RATE], ["GHS", GHS_RATE]] as const) {
    rates.docs.set(currency, { currency, provider: { rate, asOf: at, fetchedAt: at, source: "cbn" }, override: null, lastError: null });
  }
  localPricing.rates = async () => service;
  localPricing.profileCountry = async (uid) => COUNTRIES[uid];
  chargeRuntime.rates = async () => service;
  chargeRuntime.profileCountry = async (uid) => COUNTRIES[uid];

  // The real routers, mounted as app.ts does.
  const { agencyRoutes } = await import("../../src/routes/agency.routes");
  const { agentRoutes } = await import("../../src/routes/agent.routes");
  const app = express();
  app.use(express.json());
  app.use("/agents", agentRoutes);
  app.use("/agencies", agencyRoutes);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
  localPricing.rates = saved.rates;
  localPricing.profileCountry = saved.profileCountry;
  chargeRuntime.rates = saved.chargeRates;
  chargeRuntime.profileCountry = saved.chargeProfile;
});

beforeEach(() => {
  resetStore();
  seedWorld();
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  console.log = () => {};
});

/** GET `path` with an optional raw Authorization header value. */
async function get(path: string, authorization?: string): Promise<{ status: number; body: any }> {
  const r = await fetch(`${base}${path}`, { headers: authorization ? { Authorization: authorization } : {} });
  return { status: r.status, body: await r.json() };
}

/** The local figure for `cents` US cents in `currency` at the suite rates. */
function local(cents: number, currency: "NGN" | "GHS") {
  const rate = currency === "NGN" ? NGN_RATE : GHS_RATE;
  // cents x rate = local minor units (both currencies have 2 decimals).
  return { amountMinor: cents * rate, currency, rate, asOf: new Date(NOW).toISOString(), available: true };
}

/** Every public price read touched by #286, with how to pick its prices. */
const READS: Array<{ path: string; agentFee: (b: any) => any; agencyFee?: (b: any) => any; servicePrice?: (b: any) => any }> = [
  { path: "/agents", agentFee: (b) => b.data[0].consultationFeeLocal },
  { path: "/agents/top", agentFee: (b) => b.data[0].consultationFeeLocal },
  { path: "/agents/agent-1", agentFee: (b) => b.data.consultationFeeLocal },
  { path: "/agencies/browse/agency-a/agents", agentFee: (b) => b.data[0].consultationFeeLocal },
  {
    path: "/agencies/browse",
    agentFee: () => undefined,
    agencyFee: (b) => b.data[0].consultationFeeLocal,
    servicePrice: (b) => b.data[0].services[0].priceLocal,
  },
  {
    path: "/agencies/browse/agency-a",
    agentFee: () => undefined,
    agencyFee: (b) => b.data.consultationFeeLocal,
    servicePrice: (b) => b.data.services[0].priceLocal,
  },
  {
    path: "/agencies/public/acme",
    agentFee: () => undefined,
    agencyFee: (b) => (b.data.agency ?? b.data).consultationFeeLocal,
  },
];

/** Assert every price on every read is in `currency`, for `authorization`. */
async function assertQuotedIn(currency: "NGN" | "GHS", authorization?: string): Promise<void> {
  for (const r of READS) {
    const out = await get(r.path, authorization);
    assert.equal(out.status, 200, `${r.path} ${JSON.stringify(out.body)}`);
    const agentFee = r.agentFee(out.body);
    if (agentFee !== undefined) assert.deepEqual(agentFee, local(1_000, currency), r.path);
    if (r.agencyFee) assert.deepEqual(r.agencyFee(out.body), local(10_000, currency), r.path);
    if (r.servicePrice) assert.deepEqual(r.servicePrice(out.body), local(2_500, currency), r.path);
  }
}

// ============================================
// Tests
// ============================================

describe("public agent and agency reads quote the viewer's currency", () => {
  test("a guest (no Authorization header) gets the default currency, NGN", async () => {
    await assertQuotedIn("NGN");
  });

  test("a signed-in Nigerian client gets NGN", async () => {
    await assertQuotedIn("NGN", "Bearer tok-ng");
  });

  test("a signed-in Ghanaian client gets GHS on consultationFeeLocal and priceLocal", async () => {
    await assertQuotedIn("GHS", "Bearer tok-gh");
  });

  test("an invalid token is a guest: 200 in NGN, never a 401", async () => {
    await assertQuotedIn("NGN", "Bearer not-a-real-token");
    await assertQuotedIn("NGN", "Bearer ");
  });

  test("a non-Bearer Authorization header is a guest", async () => {
    await assertQuotedIn("NGN", "Basic dG9rLWdoOng=");
    await assertQuotedIn("NGN", "tok-gh");
  });

  test("a disabled account's (otherwise valid) token is a guest, not its own currency", async () => {
    await assertQuotedIn("NGN", "Bearer tok-gh-disabled");
  });
});

describe("one rule for the quote and the charge", () => {
  test("the read's currency is what POST /consultations would charge, for every viewer", async () => {
    for (const [uid, token] of [[undefined, undefined], ["uid-ng", "tok-ng"], ["uid-gh", "tok-gh"]] as const) {
      const out = await get("/agents/agent-1", token ? `Bearer ${token}` : undefined);
      assert.equal(out.body.data.consultationFeeLocal.currency, await chargeCurrencyForPayer(uid), String(uid));
    }
  });

  test("payerCurrency: guest gets the default; signed-in gets the profile mapping; unmapped gets the default", async () => {
    const cfg = parseCurrenciesConfig(CONFIG);
    const countries = async (uid: string) => ({ a: "Ghana", b: "Atlantis" } as Record<string, string>)[uid];
    assert.equal(await payerCurrency(undefined, cfg, countries), "NGN");
    assert.equal(await payerCurrency("a", cfg, countries), "GHS");
    assert.equal(await payerCurrency("b", cfg, countries), "NGN");
    assert.equal(await payerCurrency("nobody", cfg, countries), "NGN");
  });
});
