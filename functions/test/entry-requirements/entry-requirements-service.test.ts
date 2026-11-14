// ============================================
// Entry requirements (issue #236, P7 of #228) — the lookup service and the API
// ============================================
//
// Hermetic: fake reads for the service; the REAL router over the in-memory
// Firestore for the HTTP tests (fake Auth tokens per role). Covers:
//   - only the run an authority SERVES is used (head), and a bloc-scoped rule
//     applies to a current member only;
//   - a rule whose page changed since drafting, or was not fetched recently,
//     is stale -> unknown;
//   - the caller's own holdings are read only when asked, by their own uid;
//   - a fee is shown in its source currency and converted to USD by the
//     catalog FX rules (null when no rate);
//   - GET /entry-requirements: 401 signed out, free for any signed-in role,
//     400 naming the parameter, holds need a date, 429 over the rate limit;
//   - the admin review reads are admin only.
// Made-up codes and ids only.

import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { Timestamp } from "firebase-admin/firestore";
import { ROLES } from "@durin-tech/authz";
import { installFakes, resetStore, store } from "../helpers/fake-firestore";
import { EntryRequirementsService, feeViewOf, isRuleFresh, type LookupDeps } from "../../src/entry-requirements/entry-requirements.service";
import { LookupRateLimiter, parseHoldsParam, parseLookupQuery, LookupQueryError } from "../../src/entry-requirements/entry-requirements.controller";
import type { EntryRule, EntryRuleHead } from "../../src/types/entry-requirements";
import type { FactsForRules } from "../../src/services/ai/applicant-groups";
import { BLOC, DEST, rule, T0 } from "./fixtures";

/* eslint-disable @typescript-eslint/no-explicit-any */

const NOW = Date.parse("2026-11-14T12:00:00Z");

/** A head serving `runId`. */
const head = (authorityId: string, runId: string, urls: string[] = []): EntryRuleHead => ({ authorityId, publishedRunId: runId, publishedAt: T0, publishedRuleCount: 1, lastRunId: runId, lastRunStatus: "published", sourceUrls: urls, updatedAt: T0 });

/** Fake reads, configurable per test. */
function fakeDeps(over: { listed?: EntryRule[]; scoped?: EntryRule[]; heads?: EntryRuleHead[]; members?: Record<string, string[]>; sourceHash?: string | null; fetchedMs?: number | null; ownFacts?: (uid: string) => FactsForRules; fx?: any } = {}): LookupDeps & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    store: {
      publishedForCountry: async (cc: string) => (reads.push(`country:${cc}`), over.listed ?? []),
      publishedMembersOfScopes: async () => over.scoped ?? [],
      heads: async () => new Map((over.heads ?? []).map((h) => [h.authorityId, h])),
    } as any,
    listMembers: async (id) => (over.members?.[id] ?? []).map((cc) => ({ countryCode: cc, joinedOn: "2000-01-01" }) as any),
    readSource: async () => (over.sourceHash === null ? null : { lastContentHash: over.sourceHash ?? "hash-1", lastFetchedAtMs: over.fetchedMs === undefined ? NOW - 86_400_000 : over.fetchedMs }),
    readFx: async () => over.fx,
    readSettings: async () => undefined,
    readVisaSourcePage: async () => "https://www.gov.example.org/visas",
    readOwnFacts: async (uid) => {
      reads.push(`facts:${uid}`);
      return over.ownFacts ? over.ownFacts(uid) : { nationalities: [], residentialCountry: null, heldDocuments: null };
    },
    now: () => NOW,
  };
}

describe("EntryRequirementsService.lookup", () => {
  test("only the run the authority serves is used", async () => {
    const served = rule("XA__run2__0001", { runId: "XA__run2", outcome: "visa_free" });
    const old = rule("XA__run1__0001", { runId: "XA__run1", outcome: "visa_required" });
    const svc = new EntryRequirementsService(fakeDeps({ listed: [old, served], heads: [head(DEST, "XA__run2")] }));
    const a = await svc.lookup({ destination: DEST, nationalities: ["XB"] });
    assert.equal(a.status, "answer");
    if (a.status === "answer") assert.deepEqual(a.rules.map((r) => r.ruleId), ["XA__run2__0001"]);
  });

  test("a bloc-scoped rule applies to a current member only", async () => {
    const blocRule = rule("b__run1__0001", { issuingAuthorityId: BLOC, runId: "b__run1", destination: { kind: "members_of", authorityId: BLOC }, destinationCodes: [], scopeAuthorityId: BLOC });
    const deps = fakeDeps({ scoped: [blocRule], heads: [head(BLOC, "b__run1", ["https://www.bloc.example.org/visit"])], members: { [BLOC]: [DEST] } });
    const inBloc = await new EntryRequirementsService(deps).lookup({ destination: DEST, nationalities: ["XB"] });
    assert.equal(inBloc.status, "answer");
    const outside = await new EntryRequirementsService(deps).lookup({ destination: "XZ", nationalities: ["XB"] });
    assert.equal(outside.status, "unknown");
    // The member's unknown answer links the bloc's registered page.
    const other = await new EntryRequirementsService(deps).lookup({ destination: DEST, nationalities: ["XY"] });
    assert.equal(other.status, "unknown");
    if (other.status === "unknown") assert.equal(other.destinationAuthorityPage, "https://www.bloc.example.org/visit");
  });

  test("an unseeded destination is unknown with the registered official page", async () => {
    const a = await new EntryRequirementsService(fakeDeps()).lookup({ destination: "XZ", nationalities: ["XB"] });
    assert.deepEqual(a, { status: "unknown", destination: "XZ", code: "no_rule", reason: "We don't have an official source for this yet. Check the official page before you travel.", destinationAuthorityPage: "https://www.gov.example.org/visas" });
  });

  test("a page that changed since drafting, or was not fetched recently, makes the rule stale", async () => {
    const r = rule("XA__run1__0001");
    for (const over of [{ sourceHash: "hash-2" }, { fetchedMs: NOW - 200 * 86_400_000 }, { fetchedMs: null }]) {
      const a = await new EntryRequirementsService(fakeDeps({ listed: [r], heads: [head(DEST, "XA__run1")], ...over })).lookup({ destination: DEST, nationalities: ["XB"] });
      assert.equal(a.status, "unknown", JSON.stringify(over));
      if (a.status === "unknown") assert.equal(a.code, "stale");
    }
    assert.equal(isRuleFresh(r, { lastContentHash: "hash-1", lastFetchedAtMs: NOW }, NOW, 90), true);
  });

  test("the caller's own holdings are read only when asked, and only theirs", async () => {
    const permit = rule("XA__run1__0001", { outcome: "visa_free", group: { members: [{ kind: "holds", document: "residence_permit", issuer: DEST, asWritten: "a valid residence permit" }], uncoded: [] } });
    const deps = fakeDeps({ listed: [permit], heads: [head(DEST, "XA__run1")], ownFacts: (uid) => ({ nationalities: ["XB"], residentialCountry: null, heldDocuments: uid === "me" ? [{ kind: "residence_permit", issuerCountryCode: DEST, validUntil: "2027-01-01" }] : [] }) });
    const svc = new EntryRequirementsService(deps);
    const without = await svc.lookup({ destination: DEST, nationalities: ["XB"] });
    assert.equal(without.status, "unknown");
    assert.ok(!deps.reads.some((r) => r.startsWith("facts:")));
    const mine = await svc.lookup({ destination: DEST, useMyHoldings: { uid: "me" } });
    assert.equal(mine.status, "answer");
    assert.deepEqual(deps.reads.filter((r) => r.startsWith("facts:")), ["facts:me"]);
  });

  test("the destination's rules are cached for a few minutes", async () => {
    const deps = fakeDeps({ listed: [rule("XA__run1__0001")], heads: [head(DEST, "XA__run1")] });
    const svc = new EntryRequirementsService(deps);
    await svc.lookup({ destination: DEST, nationalities: ["XB"] });
    await svc.lookup({ destination: DEST, nationalities: ["XC"] });
    assert.deepEqual(deps.reads.filter((r) => r.startsWith("country:")), [`country:${DEST}`]);
  });
});

describe("fees: source currency with the quote, USD by the catalog FX rules", () => {
  const withFee = rule("r", { fee: { amount: 20, currency: "EUR", quote: "The fee is EUR 20." } });
  test("converted with a fresh rate", () => {
    const fx = { base: "USD", rates: { EUR: 0.8 }, fetchedAt: Timestamp.fromMillis(NOW - 3_600_000), rateDate: "2026-11-14", source: "test" };
    assert.deepEqual(feeViewOf(withFee, fx as any, NOW), { amount: 20, currency: "EUR", quote: "The fee is EUR 20.", usd: 25, fxDate: "2026-11-14" });
  });
  test("no rate: no USD figure (never a guess)", () => {
    const v = feeViewOf(withFee, undefined, NOW);
    assert.equal(v?.usd, null);
    assert.equal(v?.amount, 20);
  });
});

describe("query parsing", () => {
  test("a full query", () => {
    const input = parseLookupQuery({ destination: "xa", nationality: "XB,xc", residence: "XD", holds: "residence_permit:XE:2027-05-01", purpose: "tourism", stayDays: "30", useMyHoldings: "true" }, "uid-1");
    assert.deepEqual(input, {
      destination: "XA",
      nationalities: ["XB", "XC"],
      residentialCountry: "XD",
      heldDocuments: [{ kind: "residence_permit", issuerCountryCode: "XE", validUntil: "2027-05-01" }],
      purpose: "tourism",
      stayDays: 30,
      useMyHoldings: { uid: "uid-1" },
    });
  });
  test("refusals name the parameter", () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{}, "destination"],
      [{ destination: "XAX" }, "destination"],
      [{ destination: "XA", nationality: "X1" }, "nationality"],
      [{ destination: "XA", purpose: "holiday" }, "purpose"],
      [{ destination: "XA", stayDays: "0" }, "stayDays"],
      [{ destination: "XA", uid: "someone-else" }, "uid"],
      [{ destination: "XA", useMyHoldings: "yes" }, "useMyHoldings"],
    ];
    for (const [query, param] of cases) {
      assert.throws(() => parseLookupQuery(query, "u"), (e: unknown) => e instanceof LookupQueryError && e.param === param, JSON.stringify(query));
    }
  });
  test("a held document needs its valid-until date (an expired one must never match)", () => {
    assert.throws(() => parseHoldsParam("residence_permit:XE"), LookupQueryError);
    assert.deepEqual(parseHoldsParam("visa:test-bloc:2027-01-01"), { kind: "visa", issuerAuthorityId: "test-bloc", validUntil: "2027-01-01" });
  });
  test("the rate limiter allows a minute's budget per user", () => {
    let t = 0;
    const lim = new LookupRateLimiter(2, () => t);
    assert.equal(lim.allow("a"), true);
    assert.equal(lim.allow("a"), true);
    assert.equal(lim.allow("a"), false);
    assert.equal(lim.allow("b"), true);
    t = 61_000;
    assert.equal(lim.allow("a"), true);
  });
});

// ============================================
// Over the real router
// ============================================

const TOKENS: Record<string, any> = {
  "t-admin": { uid: "admin-uid", role: ROLES.ADMIN },
  "t-client": { uid: "client-uid", role: ROLES.CLIENT },
  "t-agent": { uid: "agent-uid", role: ROLES.AGENT, agencyId: "agency-1" },
  "t-owner": { uid: "owner-uid", role: ROLES.OWNER, agencyId: "agency-1" },
};

let server: http.Server;
let baseUrl = "";

/** One GET with the console muted. */
async function get(path: string, token: string | null): Promise<{ status: number; body: any }> {
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => undefined;
  try {
    const res = await fetch(`${baseUrl}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    return { status: res.status, body: await res.json().catch(() => null) };
  } finally {
    Object.assign(console, saved);
  }
}

describe("HTTP", () => {
  before(async () => {
    await installFakes();
    const firebase: any = await import("../../src/utils/firebase");
    firebase.auth.verifyIdToken = async (token: string) => {
      const d = TOKENS[token];
      if (!d) throw new Error("invalid token");
      return d;
    };
    const { entitlementService }: any = await import("../../src/services/entitlement.service");
    entitlementService.getEntitlements = async () => null;
    const { claimsService }: any = await import("../../src/services/claims.service");
    claimsService.resolveRoleFromDb = async () => ({ role: ROLES.CLIENT, agencyId: null });
    claimsService.setRoleClaims = async () => undefined;
    const mod: any = await import("../../src/entry-requirements");
    const app = express();
    app.use("/entry-requirements", mod.entryRequirementsRoutes);
    app.use("/admin/entry-rules", mod.adminEntryRuleRoutes);
    server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => new Promise((resolve) => server.close(resolve)));
  beforeEach(async () => {
    resetStore();
    const { entryRequirementsService }: any = await import("../../src/entry-requirements");
    entryRequirementsService.clearCache();
  });

  test("signed out: 401", async () => {
    assert.equal((await get(`/entry-requirements?destination=${DEST}`, null)).status, 401);
  });

  test("free for every signed-in role (no plan gate): an unseeded pair answers unknown", async () => {
    for (const t of ["t-client", "t-agent", "t-owner", "t-admin"]) {
      const r = await get("/entry-requirements?destination=XZ&nationality=XB", t);
      assert.equal(r.status, 200, t);
      assert.equal(r.body.data.status, "unknown");
      assert.equal(r.body.data.code, "no_rule");
    }
  });

  test("a published, served rule answers with its source", async () => {
    store.set("entryRules/XA__run1__0001", rule("XA__run1__0001") as any);
    store.set(`entryRuleHeads/${DEST}`, head(DEST, "XA__run1", ["https://www.gov.example.org/entry"]) as any);
    store.set("guidanceSources/xa-entry", { lastContentHash: "hash-1", lastFetchedAt: Timestamp.now() });
    const r = await get(`/entry-requirements?destination=${DEST}&nationality=XB`, "t-client");
    assert.equal(r.status, 200);
    assert.equal(r.body.data.status, "answer");
    assert.equal(r.body.data.outcome, "visa_required");
    assert.equal(r.body.data.sources[0].url, "https://www.gov.example.org/entry");
  });

  test("a bad parameter is a 400 naming it", async () => {
    const r = await get(`/entry-requirements?destination=${DEST}&holds=visa:XB`, "t-client");
    assert.equal(r.status, 400);
    assert.match(r.body.message, /holds/);
  });

  test("admin review reads: 403 for client / agent / owner, 200 for admin", async () => {
    for (const t of ["t-client", "t-agent", "t-owner"]) {
      assert.equal((await get("/admin/entry-rules", t)).status, 403, t);
      assert.equal((await get("/admin/entry-rules/runs", t)).status, 403, t);
    }
    store.set("entryRules/XA__run1__0001", rule("XA__run1__0001", { status: "left_out", leftOutReason: "checker:outcome_right" }) as any);
    const r = await get(`/admin/entry-rules?authorityId=${DEST}`, "t-admin");
    assert.equal(r.status, 200);
    assert.equal(r.body.data.rules[0].leftOutReason, "checker:outcome_right");
    assert.equal((await get("/admin/entry-rules/runs", "t-admin")).status, 200);
  });
});
