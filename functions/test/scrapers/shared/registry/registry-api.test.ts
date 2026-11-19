// ============================================
// Source registry API (issue #215) — over the REAL routers
// ============================================
//
// Hermetic: in-memory Firestore, fake Auth tokens, a scripted fetcher (no
// network). Covers the authorization matrix for every endpoint, every bad
// address shape, the check-address action, the confirmed-host allow-list
// (including the exact-host subdomain rule), confirm / revoke, route
// registration (validation, hidden country, no visa record, audit entries,
// idempotency, rate limits) and the guidance PATCH.

import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";
import { resetStore, store, writes } from "../../../helpers/fake-firestore";
import { BlockedAddressError, NON_ADMIN_TOKENS, call, fetcher, wireRegistry, type Wired } from "./registry-harness";
import { HostNotAllowedError } from "../../../../src/scrapers/shared/fetch/visa-catalog-fetch.service";

/* eslint-disable @typescript-eslint/no-explicit-any */

let wired: Wired;
let nowMs = Date.parse("2026-11-10T12:00:00Z");

before(async () => {
  wired = await wireRegistry();
  for (const [mod, name] of [
    ["official-domains.service", "officialDomainsService"],
    ["route-registration.service", "routeRegistrationService"],
    ["guidance-source-edit.service", "guidanceSourceEditService"],
    ["registry-rate-limit", "registryRateLimiter"],
  ] as const) {
    ((await import(`../../../../src/scrapers/shared/registry/${mod}`)) as any)[name].clock = () => nowMs;
  }
});
after(() => wired.close());
beforeEach(() => {
  resetStore();
  fetcher.pages.clear();
  fetcher.calls.length = 0;
  nowMs = Date.parse("2026-11-10T12:00:00Z");
});

const api = (method: string, path: string, token: string | null, body?: unknown) => call(wired.baseUrl, method, path, token, body);
const admin = (method: string, path: string, body?: unknown) => api(method, path, "t-admin", body);

/** Hosts and addresses used by the fixtures (synthetic, no real site). */
const VISA_URL = "https://www.agency.example.org/visit";
const RULES_URL = "https://rules.agency.example.org/rules";
const PDF_URL = "https://www.agency.example.org/guide.pdf";

/** Serve the three fixture pages. */
function serveFixtures(): void {
  fetcher.pages.set(VISA_URL, { lang: "en", title: "Visit" });
  fetcher.pages.set(RULES_URL, { lang: "en", title: "Rules" });
  fetcher.pages.set(PDF_URL, { pdf: true });
  fetcher.pages.set("https://www.agency.example.org/", { lang: "en", title: "Agency", text: "Welcome to the agency. ".repeat(30) });
  fetcher.pages.set("https://rules.agency.example.org/", { lang: "en", title: "Rules site" });
}

/** Check, then confirm, one host (admin). */
async function confirmHost(host: string, authorityId = "SV"): Promise<void> {
  const p = await admin("POST", "/admin/official-domains/preview", { url: `https://${host}/` });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  const c = await admin("POST", "/admin/official-domains", { host, authorityId, statement: "The Example Agency" });
  assert.ok(c.status === 201 || c.status === 200, JSON.stringify(c.body));
}

/** A valid registration body, with overrides. */
const routeBody = (over: Record<string, unknown> = {}) => ({
  authorityId: "SV",
  routeName: "Visitor route",
  visaPage: { url: VISA_URL, language: "en" },
  guidance: [
    { url: RULES_URL, title: "Visitor rules", role: "primary", docType: "html", language: "en" },
    { url: PDF_URL, title: "Visitor guide", role: "route_guidance", docType: "pdf", language: "en", checkIntervalHours: 72 },
  ],
  crawlTimeZone: "Etc/UTC",
  ...over,
});

/** Confirm the hosts of the fixtures and serve their pages. */
async function readyToRegister(): Promise<void> {
  serveFixtures();
  await confirmHost("www.agency.example.org");
  await confirmHost("rules.agency.example.org");
  fetcher.calls.length = 0;
}

/** Stored docs outside the counters and previews (what a no-op must not change). */
const stateSnapshot = () =>
  JSON.stringify([...store.entries()].filter(([p]) => !p.startsWith("sourceRegistryRateLimits/") && !p.startsWith("officialDomainPreviews/")).sort(([a], [b]) => a.localeCompare(b)));
const auditDocs = () => [...store.entries()].filter(([p]) => p.startsWith("sourceRegistryAudit/")).map(([, d]) => d as any);

// ============================================
// Authorization matrix
// ============================================

describe("registry API: authorization (every endpoint)", () => {
  const ENDPOINTS: Array<[string, string, unknown]> = [
    ["POST", "/admin/official-domains/preview", { url: "https://www.agency.example.org/" }],
    ["POST", "/admin/official-domains", { host: "www.agency.example.org", authorityId: "SV", statement: "x agency" }],
    ["GET", "/admin/official-domains", undefined],
    ["POST", "/admin/official-domains/www.agency.example.org/revoke", {}],
    ["GET", "/admin/route-sources/country-lookup?code=SV", undefined],
    ["POST", "/admin/route-sources", routeBody()],
    ["PATCH", "/admin/guidance-sources/some-id", { status: "paused" }],
  ];

  for (const [method, path, body] of ENDPOINTS) {
    test(`${method} ${path.split("?")[0]}: 401 without a token, 403 for client / agent / owner, never reaches the handler`, async () => {
      serveFixtures();
      assert.equal((await api(method, path, null, body)).status, 401);
      for (const t of NON_ADMIN_TOKENS) {
        const r = await api(method, path, t, body);
        assert.equal(r.status, 403, `${t}: ${JSON.stringify(r.body)}`);
        assert.equal(r.body.error, "FORBIDDEN");
      }
      // Nothing was fetched and nothing was written for any of them.
      assert.equal(fetcher.calls.length, 0);
      assert.equal(writes.length, 0);
    });

    test(`${method} ${path.split("?")[0]}: an admin passes the gate`, async () => {
      serveFixtures();
      const r = await api(method, path, "t-admin", body);
      assert.ok(r.status !== 401 && r.status !== 403, `${r.status} ${JSON.stringify(r.body)}`);
    });
  }

  test("there is no delete route anywhere in this API", async () => {
    for (const path of ["/admin/official-domains/www.agency.example.org", "/admin/route-sources", "/admin/guidance-sources/x", "/admin/route-sources/x"]) {
      const r = await api("DELETE", path, "t-admin");
      assert.equal(r.status, 404, path);
    }
  });
});

// ============================================
// Check an address
// ============================================

describe("POST /admin/official-domains/preview", () => {
  const BAD: Array<[string, unknown, string]> = [
    ["plain http", "http://www.agency.example.org/", "NOT_HTTPS"],
    ["no scheme", "www.agency.example.org/page", "NOT_HTTPS"],
    ["other scheme", "ftp://www.agency.example.org/", "NOT_HTTPS"],
    ["javascript", "javascript:alert(1)", "NOT_HTTPS"],
    ["backslash scheme", "https:\\\\www.agency.example.org/", "NOT_HTTPS"],
    ["user name", "https://user@www.agency.example.org/", "HAS_CREDENTIALS"],
    ["user and password", "https://user:pw@www.agency.example.org/", "HAS_CREDENTIALS"],
    ["host trick with @", "https://www.agency.example.org@evil.example.net/", "HAS_CREDENTIALS"],
    ["non-default port", "https://www.agency.example.org:8443/", "HAS_PORT"],
    ["explicit default port", "https://www.agency.example.org:443/", "HAS_PORT"],
    ["fragment", "https://www.agency.example.org/page#top", "HAS_FRAGMENT"],
    ["ipv4 literal", "https://93.184.216.34/", "IP_LITERAL"],
    ["loopback literal", "https://127.0.0.1/", "IP_LITERAL"],
    ["metadata literal", "https://169.254.169.254/latest", "IP_LITERAL"],
    ["decimal ip", "https://2130706433/", "IP_LITERAL"],
    ["hex ip", "https://0x7f.0.0.1/", "IP_LITERAL"],
    ["ipv6 literal", "https://[::1]/", "IP_LITERAL"],
    ["single label host", "https://intranet/", "INVALID_HOST"],
    ["trailing dot", "https://www.agency.example.org./", "INVALID_HOST"],
    ["empty", "", "INVALID_URL"],
    ["spaces only", "   ", "INVALID_URL"],
    ["not text", 42, "INVALID_URL"],
    ["too long", `https://www.agency.example.org/${"a".repeat(2100)}`, "URL_TOO_LONG"],
  ];
  for (const [name, url, code] of BAD) {
    test(`refuses ${name} with ${code}, no request made`, async () => {
      const r = await admin("POST", "/admin/official-domains/preview", { url });
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.equal(r.body.error, code);
      assert.ok(typeof r.body.message === "string" && r.body.message.length > 5);
      assert.equal(fetcher.calls.length, 0);
    });
  }

  test("rejects unknown keys and a missing url", async () => {
    assert.equal((await admin("POST", "/admin/official-domains/preview", { url: VISA_URL, extra: 1 })).status, 400);
    assert.equal((await admin("POST", "/admin/official-domains/preview", {})).status, 400);
    assert.equal(fetcher.calls.length, 0);
  });

  test("an address the guard refuses (internal) answers 422 with the guard's own text", async () => {
    fetcher.pages.set("https://internal.example.org/", new BlockedAddressError("internal.example.org"));
    const r = await admin("POST", "/admin/official-domains/preview", { url: "https://internal.example.org/" });
    assert.equal(r.status, 422);
    assert.equal(r.body.error, "ADDRESS_NOT_ALLOWED");
    assert.equal(r.body.message, "Refusing to fetch from internal.example.org: address not allowed");
    // The preview never records evidence for a refused address.
    assert.equal([...store.keys()].filter((p) => p.startsWith("officialDomainPreviews/")).length, 0);
  });

  test("reports what was read; the host need not be confirmed; a redirect to another host is followed and flagged", async () => {
    fetcher.pages.set("https://www.agency.example.org/", {
      finalUrl: "https://portal.agency.example.net/home",
      lang: "es",
      title: "Inicio",
      text: `Texto oficial. ${"x".repeat(400)}`,
    });
    const r = await admin("POST", "/admin/official-domains/preview", { url: "https://www.agency.example.org/" });
    assert.equal(r.status, 200);
    const d = r.body.data;
    assert.equal(d.host, "www.agency.example.org");
    assert.equal(d.finalHost, "portal.agency.example.net");
    assert.equal(d.redirected, true);
    assert.equal(d.redirectedToOtherHost, true);
    assert.equal(d.httpStatus, 200);
    assert.equal(d.docType, "html");
    assert.equal(d.language, "es");
    assert.equal(d.title, "Inicio");
    assert.equal(d.characterCount, `Texto oficial. ${"x".repeat(400)}`.length);
    assert.equal(d.openingText.length, 300);
    assert.equal(d.hostStatus, "not_confirmed");
    // The check was made WITHOUT a host policy (the single explicit action).
    assert.equal(fetcher.calls[0].allowedHost, false);
  });

  test("a PDF is reported as pdf with no language or title", async () => {
    fetcher.pages.set(PDF_URL, { pdf: true });
    const r = await admin("POST", "/admin/official-domains/preview", { url: PDF_URL });
    assert.equal(r.body.data.docType, "pdf");
    assert.equal(r.body.data.language, null);
    assert.equal(r.body.data.title, null);
  });

  test("oversize, timeout and robots refusals come back as a plain 502", async () => {
    for (const msg of ["Response too large for https://x.example.org/: 9 bytes exceeds the 5-byte cap", "timeout of 15000ms exceeded", "Blocked by robots.txt: https://x.example.org/"]) {
      fetcher.pages.set("https://x.example.org/", new Error(msg));
      const r = await admin("POST", "/admin/official-domains/preview", { url: "https://x.example.org/" });
      assert.equal(r.status, 502);
      assert.equal(r.body.error, "FETCH_FAILED");
      assert.match(r.body.message, /could not be read/);
    }
  });

  test("rate limit: the 21st check in an hour is 429; refused shapes do not count; the next hour starts fresh", async () => {
    fetcher.pages.set("https://www.agency.example.org/", {});
    for (let i = 0; i < 5; i++) await admin("POST", "/admin/official-domains/preview", { url: "http://bad.example.org/" });
    for (let i = 0; i < 20; i++) {
      const ok = await admin("POST", "/admin/official-domains/preview", { url: "https://www.agency.example.org/" });
      assert.equal(ok.status, 200, `call ${i + 1}`);
    }
    const over = await admin("POST", "/admin/official-domains/preview", { url: "https://www.agency.example.org/" });
    assert.equal(over.status, 429);
    assert.equal(over.body.error, "RATE_LIMITED");
    assert.match(over.body.message, /try again later/);
    assert.ok(over.body.retryAfterSeconds > 0);
    assert.equal(fetcher.calls.length, 20);
    nowMs += 3_600_000;
    assert.equal((await admin("POST", "/admin/official-domains/preview", { url: "https://www.agency.example.org/" })).status, 200);
  });

  test("the limit is a setting (appConfig/routeOnboardingSettings), per admin", async () => {
    store.set("appConfig/routeOnboardingSettings", { previewsPerHour: 2 });
    fetcher.pages.set("https://www.agency.example.org/", {});
    const u = { url: "https://www.agency.example.org/" };
    assert.equal((await admin("POST", "/admin/official-domains/preview", u)).status, 200);
    assert.equal((await admin("POST", "/admin/official-domains/preview", u)).status, 200);
    assert.equal((await admin("POST", "/admin/official-domains/preview", u)).status, 429);
  });
});

// ============================================
// Confirm / list / revoke
// ============================================

describe("official domains: confirm, list, revoke", () => {
  test("a host is confirmed with who, when, the exact host, the statement and the evidence; one audit entry", async () => {
    serveFixtures();
    await confirmHost("www.agency.example.org");
    const doc = store.get("officialDomains/www.agency.example.org") as any;
    assert.equal(doc.host, "www.agency.example.org");
    assert.equal(doc.authorityId, "SV");
    assert.equal(doc.countryCode, undefined); // the pre-#232 field is not written any more
    assert.equal(doc.status, "confirmed");
    assert.equal(doc.confirmedBy, "admin-uid");
    assert.equal(doc.confirmedAt.toMillis(), nowMs);
    assert.equal(doc.statement, "The Example Agency");
    assert.equal(doc.addedVia, "portal");
    assert.equal(doc.evidencePreview.title, "Agency");
    assert.equal(doc.evidencePreview.finalUrl, "https://www.agency.example.org/");
    assert.ok(doc.evidencePreview.openingText.length > 0 && doc.evidencePreview.openingText.length <= 300);
    const audit = auditDocs();
    assert.equal(audit.length, 1);
    assert.equal(audit[0].action, "domain_confirmed");
    assert.equal(audit[0].actorUid, "admin-uid");
    assert.equal(audit[0].before, null);
    assert.equal(audit[0].after.host, "www.agency.example.org");
    assert.equal(audit[0].statement, "The Example Agency");
  });

  test("confirming needs the address check first, and it must be fresh", async () => {
    serveFixtures();
    const body = { host: "www.agency.example.org", authorityId: "SV", statement: "The Example Agency" };
    const r = await admin("POST", "/admin/official-domains", body);
    assert.equal(r.status, 422);
    assert.equal(r.body.error, "PREVIEW_REQUIRED");
    await admin("POST", "/admin/official-domains/preview", { url: "https://www.agency.example.org/" });
    nowMs += 61 * 60_000; // older than the 60-minute default
    assert.equal((await admin("POST", "/admin/official-domains", body)).body.error, "PREVIEW_REQUIRED");
    assert.equal(auditDocs().length, 0);
  });

  test("the evidence is the server's own record: another admin's check does not count", async () => {
    serveFixtures();
    await admin("POST", "/admin/official-domains/preview", { url: "https://www.agency.example.org/" });
    // Move the stored check to another uid.
    const k = "officialDomainPreviews/admin-uid__www.agency.example.org";
    store.set("officialDomainPreviews/other-uid__www.agency.example.org", store.get(k)!);
    store.delete(k);
    const r = await admin("POST", "/admin/official-domains", { host: "www.agency.example.org", authorityId: "SV", statement: "The Example Agency" });
    assert.equal(r.body.error, "PREVIEW_REQUIRED");
  });

  test("a check that ended on a different host cannot confirm the host that was typed", async () => {
    fetcher.pages.set("https://www.agency.example.org/", { finalUrl: "https://other.example.net/" });
    await admin("POST", "/admin/official-domains/preview", { url: "https://www.agency.example.org/" });
    const r = await admin("POST", "/admin/official-domains", { host: "www.agency.example.org", authorityId: "SV", statement: "The Example Agency" });
    assert.equal(r.status, 422);
    assert.equal(r.body.error, "PREVIEW_HOST_MISMATCH");
    assert.equal(store.has("officialDomains/www.agency.example.org"), false);
  });

  const BAD_HOSTS: Array<[string, unknown, string]> = [
    ["wildcard", "*.example.org", "WILDCARD_NOT_ALLOWED"],
    ["bare wildcard", "*", "WILDCARD_NOT_ALLOWED"],
    ["scheme", "https://www.agency.example.org", "INVALID_HOST"],
    ["path", "www.agency.example.org/page", "INVALID_HOST"],
    ["port", "www.agency.example.org:8443", "INVALID_HOST"],
    ["credentials", "user@www.agency.example.org", "INVALID_HOST"],
    ["ip", "93.184.216.34", "IP_LITERAL"],
    ["single label", "intranet", "INVALID_HOST"],
    ["trailing dot", "www.agency.example.org.", "INVALID_HOST"],
    ["underscore", "bad_host.example.org", "INVALID_HOST"],
    ["not text", 5, "INVALID_HOST"],
  ];
  for (const [name, host, code] of BAD_HOSTS) {
    test(`refuses to confirm a ${name} host (${code})`, async () => {
      const r = await admin("POST", "/admin/official-domains", { host, authorityId: "SV", statement: "The Example Agency" });
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.equal(r.body.error, code);
    });
  }

  test("refuses a bad country, a missing or empty statement, unknown keys", async () => {
    serveFixtures();
    await admin("POST", "/admin/official-domains/preview", { url: "https://www.agency.example.org/" });
    const base = { host: "www.agency.example.org", authorityId: "SV", statement: "The Example Agency" };
    assert.equal((await admin("POST", "/admin/official-domains", { ...base, authorityId: "ZZ" })).body.error, "INVALID_AUTHORITY");
    assert.equal((await admin("POST", "/admin/official-domains", { ...base, authorityId: "S" })).body.error, "INVALID_AUTHORITY");
    // The old field name is an unknown key now.
    assert.equal((await admin("POST", "/admin/official-domains", { host: base.host, countryCode: "SV", statement: base.statement })).status, 400);
    assert.equal((await admin("POST", "/admin/official-domains", { ...base, statement: "   " })).body.error, "STATEMENT_REQUIRED");
    assert.equal((await admin("POST", "/admin/official-domains", { host: base.host, authorityId: "SV" })).body.error, "STATEMENT_REQUIRED");
    assert.equal((await admin("POST", "/admin/official-domains", { ...base, status: "confirmed" })).status, 400);
    assert.equal((await admin("POST", "/admin/official-domains", { ...base, confirmedBy: "someone" })).status, 400);
    assert.equal(store.has("officialDomains/www.agency.example.org"), false);
  });

  test("confirming is idempotent: same answer, no second audit entry; another authority is a conflict", async () => {
    serveFixtures();
    await confirmHost("www.agency.example.org");
    const again = await admin("POST", "/admin/official-domains", { host: "WWW.Agency.Example.org", authorityId: "SV", statement: "A different statement" });
    assert.equal(again.status, 200);
    assert.equal(again.body.data.created, false);
    assert.equal(again.body.data.domain.statement, "The Example Agency"); // untouched
    assert.equal(auditDocs().length, 1);
    const other = await admin("POST", "/admin/official-domains", { host: "www.agency.example.org", authorityId: "KE", statement: "The Example Agency" });
    assert.equal(other.status, 409);
    assert.equal(other.body.error, "HOST_CONFIRMED_FOR_OTHER_AUTHORITY");
    assert.equal(other.body.message, "That website is already confirmed for a different authority");
    assert.equal(other.body.confirmedFor, "SV");
    // A bloc cannot take over a host confirmed for a country either.
    store.set("authorities/test-bloc", { id: "test-bloc", kind: "bloc", name: "Test Bloc", status: "active" });
    const bloc = await admin("POST", "/admin/official-domains", { host: "www.agency.example.org", authorityId: "test-bloc", statement: "Test Bloc secretariat" });
    assert.equal(bloc.status, 409);
    assert.equal(bloc.body.error, "HOST_CONFIRMED_FOR_OTHER_AUTHORITY");
    assert.equal(auditDocs().length, 1);
  });

  test("list returns every host sorted, with ISO dates", async () => {
    serveFixtures();
    await confirmHost("www.agency.example.org");
    await confirmHost("rules.agency.example.org");
    const r = await admin("GET", "/admin/official-domains");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.data.domains.map((d: any) => d.host), ["rules.agency.example.org", "www.agency.example.org"]);
    assert.equal(r.body.data.total, 2);
    assert.equal(r.body.data.domains[0].confirmedAt, new Date(nowMs).toISOString());
  });

  test("revoke sets revoked, pauses only the portal-added sources on that host, audits each, and repeats cleanly", async () => {
    await readyToRegister();
    assert.equal((await admin("POST", "/admin/route-sources", routeBody())).status, 201);
    // A seeded (not portal-added) source on the same host must be left alone.
    store.set("guidanceSources/seeded-one", { url: "https://rules.agency.example.org/seeded", status: "active", title: "Seeded" });
    const before = auditDocs().length;

    const r = await admin("POST", "/admin/official-domains/rules.agency.example.org/revoke", { reason: "Site was taken over" });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.changed, true);
    assert.equal(r.body.data.domain.status, "revoked");
    assert.deepEqual(r.body.data.pausedGuidanceSources, ["sv-visitor-rules"]);
    const g = store.get("guidanceSources/sv-visitor-rules") as any;
    assert.equal(g.status, "paused");
    assert.equal(g.pausedReason, "host_revoked");
    assert.equal((store.get("guidanceSources/sv-visitor-guide") as any).status, "active"); // other host
    assert.equal((store.get("guidanceSources/seeded-one") as any).status, "active");
    const dom = store.get("officialDomains/rules.agency.example.org") as any;
    assert.equal(dom.revokedBy, "admin-uid");
    assert.equal(dom.revokeReason, "Site was taken over");
    assert.equal(auditDocs().length, before + 2); // the revoke + the paused source

    // Revoking the visa page's host pauses the visa page and drops the host from officialHosts.
    const r2 = await admin("POST", "/admin/official-domains/www.agency.example.org/revoke", {});
    assert.equal(r2.status, 200);
    assert.deepEqual(r2.body.data.pausedVisaPages, [{ authorityId: "SV", url: VISA_URL }]);
    const vs = store.get("visaSources/SV") as any;
    assert.equal(vs.pages[0].paused, true);
    assert.equal(vs.pages[0].pausedReason, "host_revoked");
    assert.ok(!vs.officialHosts.includes("www.agency.example.org"));
    assert.equal((store.get("guidanceSources/sv-visitor-guide") as any).status, "paused");

    // Again: nothing more changes.
    const n = auditDocs().length;
    const r3 = await admin("POST", "/admin/official-domains/www.agency.example.org/revoke", {});
    assert.equal(r3.body.data.changed, false);
    assert.equal(auditDocs().length, n);
    // Unknown host: 404; bad host: 400; unknown key: 400.
    assert.equal((await admin("POST", "/admin/official-domains/nobody.example.org/revoke", {})).status, 404);
    assert.equal((await admin("POST", "/admin/official-domains/*.example.org/revoke", {})).status, 400);
    assert.equal((await admin("POST", "/admin/official-domains/www.agency.example.org/revoke", { force: true })).status, 400);
  });

  test("after a revoke, registration on that host is refused", async () => {
    await readyToRegister();
    await admin("POST", "/admin/official-domains/www.agency.example.org/revoke", {});
    const r = await admin("POST", "/admin/route-sources", routeBody());
    assert.equal(r.status, 422);
    assert.equal(r.body.error, "HOST_NOT_CONFIRMED");
    assert.deepEqual(r.body.hosts, ["www.agency.example.org"]);
  });
});

// ============================================
// Country lookup
// ============================================

describe("GET /admin/route-sources/country-lookup", () => {
  test("returns the English name and whether the country and registry docs exist", async () => {
    const r = await admin("GET", "/admin/route-sources/country-lookup?code=sv");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.data, { code: "SV", name: "El Salvador", countryExists: false, visaSourceExists: false });
    store.set("countries/SV", { code: "SV" });
    store.set("visaSources/SV", { id: "SV" });
    const again = await admin("GET", "/admin/route-sources/country-lookup?code=SV");
    assert.equal(again.body.data.countryExists, true);
    assert.equal(again.body.data.visaSourceExists, true);
  });

  for (const code of ["", "S", "SVX", "1A", "ZZ", "XX", "S V", "%20"]) {
    test(`400 for "${code}"`, async () => {
      const r = await admin("GET", `/admin/route-sources/country-lookup?code=${encodeURIComponent(code)}`);
      assert.equal(r.status, 400);
      assert.equal(r.body.error, "INVALID_COUNTRY_CODE");
    });
  }
  test("400 for a missing or repeated code", async () => {
    assert.equal((await admin("GET", "/admin/route-sources/country-lookup")).status, 400);
    assert.equal((await admin("GET", "/admin/route-sources/country-lookup?code=SV&code=KE")).status, 400);
  });
});

// ============================================
// Register a route
// ============================================

describe("POST /admin/route-sources", () => {
  test("registers the country (hidden), the visa page and the guidance sources, and creates no visa record", async () => {
    await readyToRegister();
    const r = await admin("POST", "/admin/route-sources", routeBody());
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const d = r.body.data;
    assert.equal(d.created, true);
    assert.equal(d.authorityId, "SV");
    assert.equal(d.authorityName, "El Salvador");
    assert.equal(d.authorityKind, "country");
    assert.equal(d.countryCreated, true);
    assert.equal(d.visaId, "sv-visitor-route");
    assert.deepEqual(d.guidanceSourceIds, ["sv-visitor-rules", "sv-visitor-guide"]);

    // Country: hidden, rank 999, name from the lookup.
    const c = store.get("countries/SV") as any;
    assert.equal(c.isSupported, false);
    assert.equal(c.popularityRank, 999);
    assert.equal(c.name, "El Salvador");
    assert.equal(c.visaTypesCount, 0);

    // Visa source: page pinned, provenance, adapter, official hosts, window.
    const vs = store.get("visaSources/SV") as any;
    assert.equal(vs.pages.length, 1);
    const page = vs.pages[0];
    assert.equal(page.url, VISA_URL);
    assert.equal(page.visaId, "sv-visitor-route");
    assert.equal(page.addedVia, "portal");
    assert.equal(page.addedBy, "admin-uid");
    assert.equal(page.language, "en");
    assert.ok(page.addedAt);
    assert.equal(vs.adapter, "generic-html");
    assert.equal(vs.isOfficial, true);
    assert.deepEqual([...vs.officialHosts].sort(), ["rules.agency.example.org", "www.agency.example.org"]);
    assert.equal(vs.crawlIntervalHours, 168);
    assert.equal(vs.status, "active");
    assert.deepEqual(vs.crawlWindow, { timeZone: "Etc/UTC", dayOfWeek: 1, startHour: 2, endHour: 5 });
    assert.equal(vs.addedVia, "portal");
    assert.equal(vs.authorityId, "SV");
    assert.equal(vs.countryCode, "SV");
    assert.ok(vs.nextCrawlAt, "a country source is scheduled for the visa crawl");

    // Guidance sources.
    const g = store.get("guidanceSources/sv-visitor-rules") as any;
    assert.equal(g.url, RULES_URL);
    assert.equal(g.jurisdiction, "SV");
    assert.equal(g.route, "visitor-route");
    assert.equal(g.role, "primary");
    assert.equal(g.docType, "html");
    assert.equal(g.verificationStatus, "registered");
    assert.match(g.verificationNote, /no person has read it/);
    assert.equal(g.addedVia, "portal");
    assert.equal(g.addedBy, "admin-uid");
    assert.equal(g.language, "en");
    assert.equal(g.status, "active");
    assert.equal(g.checkIntervalHours, 168);
    assert.equal((store.get("guidanceSources/sv-visitor-guide") as any).checkIntervalHours, 72);
    assert.equal((store.get("guidanceSources/sv-visitor-guide") as any).docType, "pdf");

    // Nothing applicant-visible: no visa type doc of any kind.
    assert.equal([...store.keys()].filter((p) => p.includes("/visaTypes/")).length, 0);

    // Audit: one per object (country, visa page, two guidance) plus the route.
    assert.deepEqual(auditDocs().map((a) => a.action).filter((a) => a !== "domain_confirmed").sort(), ["country_created", "route_registered", "source_added", "source_added", "visa_page_added"]);
    for (const a of auditDocs()) {
      assert.ok(a.actorUid && a.at && "before" in a && "after" in a);
    }
    // Every page was previewed through the fetcher WITH the host policy.
    assert.equal(fetcher.calls.length, 3);
    assert.ok(fetcher.calls.every((c) => c.allowedHost));
  });

  test("repeating the same body changes nothing: 200, created false, no request, same stored state", async () => {
    await readyToRegister();
    assert.equal((await admin("POST", "/admin/route-sources", routeBody())).status, 201);
    const snap = stateSnapshot();
    const callsBefore = fetcher.calls.length;
    const r = await admin("POST", "/admin/route-sources", routeBody());
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.data.created, false);
    assert.deepEqual(r.body.data.guidanceSourceIds, ["sv-visitor-rules", "sv-visitor-guide"]);
    assert.equal(stateSnapshot(), snap);
    assert.equal(fetcher.calls.length, callsBefore);
  });

  test("a second route in a registered country appends its page and keeps the window; the country is not recreated", async () => {
    await readyToRegister();
    await admin("POST", "/admin/route-sources", routeBody());
    const window = (store.get("visaSources/SV") as any).crawlWindow;
    fetcher.pages.set("https://www.agency.example.org/work", { lang: "en" });
    fetcher.pages.set("https://rules.agency.example.org/work-rules", { lang: "en" });
    const r = await admin(
      "POST",
      "/admin/route-sources",
      routeBody({
        routeName: "Work route",
        visaPage: { url: "https://www.agency.example.org/work", language: "en" },
        guidance: [{ url: "https://rules.agency.example.org/work-rules", title: "Work rules", role: "primary", docType: "html", language: "en" }],
        crawlTimeZone: "Etc/GMT+5",
      })
    );
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.data.countryCreated, false);
    const vs = store.get("visaSources/SV") as any;
    assert.equal(vs.pages.length, 2);
    assert.deepEqual(vs.crawlWindow, window);
    assert.equal(vs.pages[1].visaId, "sv-work-route");
  });

  test("a new source goes on the least loaded weekday", async () => {
    await readyToRegister();
    // Days 1..6 each have one source, Sunday none.
    for (let d = 1; d <= 6; d++) store.set(`visaSources/X${d}`, { crawlWindow: { timeZone: "Etc/UTC", dayOfWeek: d, startHour: 2, endHour: 5 } });
    await admin("POST", "/admin/route-sources", routeBody());
    assert.equal((store.get("visaSources/SV") as any).crawlWindow.dayOfWeek, 7);
  });

  test("a host that is not confirmed is refused with the list of hosts, before anything is fetched or stored", async () => {
    serveFixtures();
    await confirmHost("www.agency.example.org"); // rules.agency.example.org is NOT confirmed
    fetcher.calls.length = 0;
    const snap = stateSnapshot();
    const r = await admin("POST", "/admin/route-sources", routeBody());
    assert.equal(r.status, 422);
    assert.equal(r.body.error, "HOST_NOT_CONFIRMED");
    assert.deepEqual(r.body.hosts, ["rules.agency.example.org"]);
    assert.equal(fetcher.calls.length, 0);
    assert.equal(stateSnapshot(), snap);
  });

  test("subdomain rule: exact hosts only. A confirmed host does not cover its subdomains or its parent", async () => {
    serveFixtures();
    await confirmHost("www.agency.example.org");
    for (const url of ["https://sub.www.agency.example.org/visit", "https://agency.example.org/visit", "https://example.org/visit", "https://www.agency.example.org.evil.example.net/visit"]) {
      const r = await admin("POST", "/admin/route-sources", routeBody({ visaPage: { url, language: "en" }, guidance: [{ url: PDF_URL, title: "Guide", role: "primary", docType: "pdf", language: "en" }] }));
      assert.equal(r.status, 422, url);
      assert.equal(r.body.error, "HOST_NOT_CONFIRMED", url);
    }
    // Only the confirm-time check was made, with no host policy.
    assert.ok(fetcher.calls.every((c) => !c.allowedHost));
  });

  test("a redirect to a host that is not confirmed is refused and nothing is stored", async () => {
    await readyToRegister();
    fetcher.pages.set(RULES_URL, new HostNotAllowedError("elsewhere.example.net", "redirect"));
    const snap = stateSnapshot();
    const r = await admin("POST", "/admin/route-sources", routeBody());
    assert.equal(r.status, 422);
    assert.equal(r.body.error, "HOST_NOT_CONFIRMED");
    assert.equal(r.body.url, RULES_URL);
    assert.equal(stateSnapshot(), snap);
  });

  test("a final URL on an unconfirmed host is refused by the policy (fake applies it like the real service)", async () => {
    await readyToRegister();
    fetcher.pages.set(VISA_URL, { finalUrl: "https://elsewhere.example.net/page" });
    const r = await admin("POST", "/admin/route-sources", routeBody());
    assert.equal(r.status, 422);
    assert.equal(r.body.error, "HOST_NOT_CONFIRMED");
  });

  test("every address shape is refused at registration too (400, nothing fetched)", async () => {
    await readyToRegister();
    for (const url of ["http://www.agency.example.org/visit", "https://u:p@www.agency.example.org/visit", "https://www.agency.example.org:8443/visit", "https://www.agency.example.org/visit#x", "https://10.0.0.1/visit"]) {
      const a = await admin("POST", "/admin/route-sources", routeBody({ visaPage: { url, language: "en" } }));
      assert.equal(a.status, 400, url);
      const b = await admin("POST", "/admin/route-sources", routeBody({ guidance: [{ url, title: "Rules", role: "primary", docType: "html", language: "en" }] }));
      assert.equal(b.status, 400, url);
    }
    assert.equal(fetcher.calls.length, 0);
  });

  test("language: only the supported list; a stored setting widens it", async () => {
    await readyToRegister();
    const es = routeBody({ visaPage: { url: VISA_URL, language: "es" } });
    const r = await admin("POST", "/admin/route-sources", es);
    assert.equal(r.status, 422);
    assert.equal(r.body.error, "LANGUAGE_NOT_SUPPORTED");
    assert.deepEqual(r.body.supportedLanguages, ["en"]);
    assert.equal(fetcher.calls.length, 0);
    // A guidance page in an unsupported language too.
    const g = routeBody();
    (g.guidance as any[])[1].language = "fr";
    assert.equal((await admin("POST", "/admin/route-sources", g)).body.error, "LANGUAGE_NOT_SUPPORTED");
    store.set("appConfig/routeOnboardingSettings", { supportedLanguages: ["en", "es"] });
    assert.equal((await admin("POST", "/admin/route-sources", es)).status, 201);
  });

  test("a malformed language setting never widens the list (falls back to the default)", async () => {
    await readyToRegister();
    store.set("appConfig/routeOnboardingSettings", { supportedLanguages: "everything" });
    const r = await admin("POST", "/admin/route-sources", routeBody({ visaPage: { url: VISA_URL, language: "es" } }));
    assert.equal(r.body.error, "LANGUAGE_NOT_SUPPORTED");
  });

  test("at least one primary source; role and docType must be from the enums", async () => {
    await readyToRegister();
    const noPrimary = routeBody({ guidance: [{ url: RULES_URL, title: "Visitor rules", role: "secondary", docType: "html", language: "en" }] });
    assert.equal((await admin("POST", "/admin/route-sources", noPrimary)).body.error, "PRIMARY_REQUIRED");
    assert.equal((await admin("POST", "/admin/route-sources", routeBody({ guidance: [] }))).body.error, "PRIMARY_REQUIRED");
    const badRole = routeBody({ guidance: [{ url: RULES_URL, title: "Visitor rules", role: "main", docType: "html", language: "en" }] });
    assert.equal((await admin("POST", "/admin/route-sources", badRole)).status, 400);
    const badType = routeBody({ guidance: [{ url: RULES_URL, title: "Visitor rules", role: "primary", docType: "doc", language: "en" }] });
    assert.equal((await admin("POST", "/admin/route-sources", badType)).status, 400);
    assert.equal(fetcher.calls.length, 0);
  });

  test("strict bodies: unknown keys at every level are rejected", async () => {
    await readyToRegister();
    assert.equal((await admin("POST", "/admin/route-sources", routeBody({ isSupported: true }))).status, 400);
    assert.equal((await admin("POST", "/admin/route-sources", routeBody({ visaPage: { url: VISA_URL, language: "en", paused: true } }))).status, 400);
    const g = routeBody();
    (g.guidance as any[])[0].verificationStatus = "verified";
    assert.equal((await admin("POST", "/admin/route-sources", g)).status, 400);
    assert.equal((await admin("POST", "/admin/route-sources", [])).status, 400);
    assert.equal(fetcher.calls.length, 0);
  });

  test("visa id: lowercase [a-z0-9-], prefixed with the country code; ids come from titles, never URLs", async () => {
    await readyToRegister();
    for (const visaId of ["SV-visitor", "kk-visitor", "visitor", "sv-", "sv-Visitor", "sv-visitor_x", "sv--x"]) {
      const r = await admin("POST", "/admin/route-sources", routeBody({ visaId }));
      assert.equal(r.status, 400, visaId);
      assert.equal(r.body.error, "INVALID_VISA_ID", visaId);
    }
    const ok = await admin("POST", "/admin/route-sources", routeBody({ visaId: "sv-tourist-2" }));
    assert.equal(ok.status, 201);
    assert.equal(ok.body.data.visaId, "sv-tourist-2");
    assert.equal((store.get("guidanceSources/sv-visitor-rules") as any).route, "tourist-2");
    // A title that makes no id, and two titles that make the same id.
    const noId = routeBody({ routeName: "Other", guidance: [{ url: RULES_URL, title: "!!!", role: "primary", docType: "html", language: "en" }] });
    assert.equal((await admin("POST", "/admin/route-sources", noId)).status, 400);
    const dup = routeBody({ routeName: "Other", guidance: [
      { url: RULES_URL, title: "Rules", role: "primary", docType: "html", language: "en" },
      { url: PDF_URL, title: "RULES!", role: "secondary", docType: "pdf", language: "en" },
    ] });
    assert.equal((await admin("POST", "/admin/route-sources", dup)).body.error, "DUPLICATE_GUIDANCE_ID");
  });

  test("a visa id used by a different page, or by a visa record from another source, is a conflict (409)", async () => {
    await readyToRegister();
    // Another page of the same country already owns the id (pinned).
    store.set("visaSources/SV", { id: "SV", pages: [{ url: "https://www.agency.example.org/old", routeName: "Old", visaId: "sv-visitor-route" }] });
    const a = await admin("POST", "/admin/route-sources", routeBody());
    assert.equal(a.status, 409);
    assert.equal(a.body.error, "VISA_ID_TAKEN");
    // …or it is derived from another page's address.
    store.set("visaSources/SV", { id: "SV", pages: [{ url: "https://www.agency.example.org/visitor-route", routeName: "Old" }] });
    assert.equal((await admin("POST", "/admin/route-sources", routeBody({ visaId: "sv-visitor-route" }))).body.error, "VISA_ID_TAKEN");
    // A visa record exists from a different source.
    store.set("visaSources/SV", { id: "SV", pages: [] });
    store.set("countries/SV/visaTypes/sv-visitor-route", { scrapeMeta: { sourceUrl: "https://elsewhere.example.net/visa" } });
    assert.equal((await admin("POST", "/admin/route-sources", routeBody())).body.error, "VISA_ID_TAKEN");
    // A seeded record with no scrape provenance counts as another source.
    store.set("countries/SV/visaTypes/sv-visitor-route", { name: "Seeded" });
    assert.equal((await admin("POST", "/admin/route-sources", routeBody())).status, 409);
    // The same record from THIS page is fine.
    store.set("countries/SV/visaTypes/sv-visitor-route", { scrapeMeta: { sourceUrl: VISA_URL } });
    assert.equal((await admin("POST", "/admin/route-sources", routeBody())).status, 201);
  });

  test("a guidance id or address already used by a different source is a conflict", async () => {
    await readyToRegister();
    store.set("guidanceSources/sv-visitor-rules", { url: "https://rules.agency.example.org/other", addedVia: "portal", jurisdiction: "SV", role: "primary", docType: "html" });
    assert.equal((await admin("POST", "/admin/route-sources", routeBody())).body.error, "GUIDANCE_ID_TAKEN");
    store.delete("guidanceSources/sv-visitor-rules");
    store.set("guidanceSources/some-other-id", { url: RULES_URL });
    const r = await admin("POST", "/admin/route-sources", routeBody());
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "DUPLICATE_URL");
  });

  test("a page declared as the wrong document type is refused", async () => {
    await readyToRegister();
    fetcher.pages.set(RULES_URL, { pdf: true });
    const r = await admin("POST", "/admin/route-sources", routeBody());
    assert.equal(r.status, 422);
    assert.equal(r.body.error, "WRONG_DOCUMENT_TYPE");
    assert.equal(store.has("countries/SV"), false);
  });

  test("a page that cannot be read stops the registration and stores nothing", async () => {
    await readyToRegister();
    fetcher.pages.set(PDF_URL, new Error("timeout of 15000ms exceeded"));
    const snap = stateSnapshot();
    const r = await admin("POST", "/admin/route-sources", routeBody());
    assert.equal(r.status, 502);
    assert.equal(r.body.url, PDF_URL);
    assert.equal(stateSnapshot(), snap);
  });

  test("an advisory warning when a page's own language disagrees with the declared one", async () => {
    await readyToRegister();
    fetcher.pages.set(VISA_URL, { lang: "es-SV" });
    const r = await admin("POST", "/admin/route-sources", routeBody());
    assert.equal(r.status, 201);
    assert.equal(r.body.data.warnings.length, 1);
  });

  test("rate limit: registrations per admin per hour (a setting, default 30)", async () => {
    await readyToRegister();
    store.set("appConfig/routeOnboardingSettings", { registrationsPerHour: 2 });
    assert.equal((await admin("POST", "/admin/route-sources", routeBody())).status, 201);
    assert.equal((await admin("POST", "/admin/route-sources", routeBody())).status, 200); // a repeat still counts
    const r = await admin("POST", "/admin/route-sources", routeBody());
    assert.equal(r.status, 429);
    assert.equal(r.body.error, "RATE_LIMITED");
  });

  test("an unreadable settings doc fails closed (503), nothing fetched", async () => {
    await readyToRegister();
    const firebase: any = await import("../../../../src/utils/firebase");
    const original = firebase.collections.appConfig;
    firebase.collections.appConfig = { doc: () => ({ get: async () => { throw new Error("unavailable"); } }) };
    try {
      const r = await admin("POST", "/admin/route-sources", routeBody());
      assert.equal(r.status, 503);
      assert.equal(r.body.error, "SETTINGS_UNAVAILABLE");
      assert.equal(fetcher.calls.length, 0);
    } finally {
      firebase.collections.appConfig = original;
    }
  });

  test("too many guidance pages for one route (setting) is refused", async () => {
    await readyToRegister();
    store.set("appConfig/routeOnboardingSettings", { maxGuidancePerRoute: 1 });
    assert.equal((await admin("POST", "/admin/route-sources", routeBody())).body.error, "TOO_MANY_PAGES");
  });
});

// ============================================
// Issue #232: websites and routes belong to an authority
// ============================================

describe("authorities: official websites and routes of a bloc or treaty (#232)", () => {
  /** A made-up bloc (no real bloc is named in tests). */
  const BLOC_ID = "test-bloc";
  const BLOC_HOST = "www.bloc.example.org";
  const BLOC_VISA_URL = `https://${BLOC_HOST}/short-stay`;
  const BLOC_RULES_URL = `https://${BLOC_HOST}/rules`;

  /** Create the bloc (as P1's API would store it). */
  const putBloc = (status = "active") => store.set(`authorities/${BLOC_ID}`, { id: BLOC_ID, kind: "bloc", name: "Test Bloc", status });

  /** Serve the bloc's pages. */
  const serveBloc = () => {
    fetcher.pages.set(`https://${BLOC_HOST}/`, { lang: "en", title: "Test Bloc" });
    fetcher.pages.set(BLOC_VISA_URL, { lang: "en", title: "Short stay" });
    fetcher.pages.set(BLOC_RULES_URL, { lang: "en", title: "Rules" });
  };

  /** A registration body under the bloc. */
  const blocRoute = (over: Record<string, unknown> = {}) =>
    routeBody({
      authorityId: BLOC_ID,
      routeName: "Short stay",
      visaPage: { url: BLOC_VISA_URL, language: "en" },
      guidance: [{ url: BLOC_RULES_URL, title: "Short stay rules", role: "primary", docType: "html", language: "en" }],
      ...over,
    });

  test("a host is confirmed for a bloc: authorityId stored, statement kept, list and audit show it", async () => {
    putBloc();
    serveBloc();
    await confirmHost(BLOC_HOST, BLOC_ID);
    const doc = store.get(`officialDomains/${BLOC_HOST}`) as any;
    assert.equal(doc.authorityId, BLOC_ID);
    assert.equal(doc.statement, "The Example Agency");
    const list = await admin("GET", "/admin/official-domains");
    assert.equal(list.body.data.domains[0].authorityId, BLOC_ID);
    assert.equal(list.body.data.domains[0].statement, "The Example Agency");
    const audit = auditDocs().find((a) => a.action === "domain_confirmed");
    assert.equal(audit.after.authorityId, BLOC_ID);
    assert.equal(audit.statement, "The Example Agency");
    // Same authority again: idempotent.
    const again = await admin("POST", "/admin/official-domains", { host: BLOC_HOST, authorityId: BLOC_ID, statement: "Test Bloc" });
    assert.equal(again.status, 200);
    assert.equal(again.body.data.created, false);
    // A country cannot take the bloc's host.
    const other = await admin("POST", "/admin/official-domains", { host: BLOC_HOST, authorityId: "SV", statement: "Test Bloc" });
    assert.equal(other.status, 409);
    assert.equal(other.body.error, "HOST_CONFIRMED_FOR_OTHER_AUTHORITY");
  });

  test("an unknown, malformed or retired authority is refused and nothing is stored", async () => {
    serveBloc();
    await admin("POST", "/admin/official-domains/preview", { url: `https://${BLOC_HOST}/` });
    const body = (authorityId: unknown) => ({ host: BLOC_HOST, authorityId, statement: "Test Bloc" });
    for (const id of ["no-such-bloc", "bad_id", "ab", "", 7, undefined]) {
      const r = await admin("POST", "/admin/official-domains", body(id));
      assert.equal(r.status, 400, JSON.stringify(id));
      assert.equal(r.body.error, "INVALID_AUTHORITY", JSON.stringify(id));
    }
    putBloc("retired");
    const retired = await admin("POST", "/admin/official-domains", body(BLOC_ID));
    assert.equal(retired.status, 409);
    assert.equal(retired.body.error, "AUTHORITY_RETIRED");
    // A retired COUNTRY authority is refused too.
    store.set("authorities/SV", { id: "SV", kind: "country", name: "Country", status: "retired" });
    assert.equal((await admin("POST", "/admin/official-domains", body("SV"))).body.error, "AUTHORITY_RETIRED");
    assert.equal(store.has(`officialDomains/${BLOC_HOST}`), false);
    assert.equal(auditDocs().length, 0);
  });

  test("a route registered under a bloc creates no country, nothing visible, and is keyed by the bloc", async () => {
    putBloc();
    serveBloc();
    await confirmHost(BLOC_HOST, BLOC_ID);
    fetcher.calls.length = 0;
    const r = await admin("POST", "/admin/route-sources", blocRoute());
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const d = r.body.data;
    assert.equal(d.authorityId, BLOC_ID);
    assert.equal(d.authorityName, "Test Bloc");
    assert.equal(d.authorityKind, "bloc");
    assert.equal(d.countryCreated, false);
    assert.equal(d.visaId, "test-bloc-short-stay");
    assert.deepEqual(d.guidanceSourceIds, ["test-bloc-short-stay-rules"]);

    // Nothing under countries/: no country, no visa record.
    assert.equal([...store.keys()].filter((p) => p.startsWith("countries/")).length, 0);
    // The visa source is the bloc's, unscheduled for the (country) visa crawl.
    const vs = store.get(`visaSources/${BLOC_ID}`) as any;
    assert.equal(vs.id, BLOC_ID);
    assert.equal(vs.authorityId, BLOC_ID);
    assert.equal(vs.countryCode, undefined);
    assert.equal(vs.nextCrawlAt, undefined);
    assert.equal(vs.pages[0].visaId, "test-bloc-short-stay");
    // Guidance jurisdiction holds the authority id.
    const g = store.get("guidanceSources/test-bloc-short-stay-rules") as any;
    assert.equal(g.jurisdiction, BLOC_ID);
    assert.equal(g.route, "short-stay");
    // Audit names the bloc, never a country.
    const actions = auditDocs().map((a) => a.action);
    assert.ok(!actions.includes("country_created"));
    const reg = auditDocs().find((a) => a.action === "route_registered");
    assert.equal(reg.targetId, `${BLOC_ID}/test-bloc-short-stay`);
    assert.equal(reg.after.authorityKind, "bloc");
    // Every page was previewed with the host policy.
    assert.ok(fetcher.calls.length === 2 && fetcher.calls.every((c) => c.allowedHost));

    // Repeating the same body changes nothing and fetches nothing.
    const snap = stateSnapshot();
    const n = fetcher.calls.length;
    const again = await admin("POST", "/admin/route-sources", blocRoute());
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.data.created, false);
    assert.equal(again.body.data.authorityName, "Test Bloc");
    assert.equal(stateSnapshot(), snap);
    assert.equal(fetcher.calls.length, n);
  });

  test("registration needs hosts confirmed for THAT authority: a host confirmed for another one is refused before any request", async () => {
    putBloc();
    serveBloc();
    serveFixtures();
    // The bloc's host is confirmed for a COUNTRY, not for the bloc.
    await confirmHost(BLOC_HOST, "SV");
    fetcher.calls.length = 0;
    const r = await admin("POST", "/admin/route-sources", blocRoute());
    assert.equal(r.status, 422);
    assert.equal(r.body.error, "HOST_NOT_CONFIRMED");
    assert.deepEqual(r.body.hosts, [BLOC_HOST]);
    assert.equal(fetcher.calls.length, 0);
    // And the other way round: a country route cannot use a host confirmed for another country.
    await confirmHost("www.agency.example.org", "KE");
    await confirmHost("rules.agency.example.org", "SV");
    fetcher.calls.length = 0;
    const c = await admin("POST", "/admin/route-sources", routeBody());
    assert.equal(c.status, 422);
    assert.deepEqual(c.body.hosts, ["www.agency.example.org"]);
    assert.equal(fetcher.calls.length, 0);
  });

  test("a redirect to a host confirmed for a different authority is refused (redirect policy per authority)", async () => {
    putBloc();
    serveBloc();
    serveFixtures();
    await confirmHost(BLOC_HOST, BLOC_ID);
    await confirmHost("www.agency.example.org", "SV"); // confirmed, but for a country
    // The bloc's visa page redirects onto the country's host.
    fetcher.pages.set(BLOC_VISA_URL, { finalUrl: "https://www.agency.example.org/visit" });
    const snap = stateSnapshot();
    const r = await admin("POST", "/admin/route-sources", blocRoute());
    assert.equal(r.status, 422);
    assert.equal(r.body.error, "HOST_NOT_CONFIRMED");
    assert.equal(r.body.url, BLOC_VISA_URL);
    assert.equal(stateSnapshot(), snap);
  });

  test("registration refuses an unknown or retired bloc before any request", async () => {
    serveBloc();
    const unknown = await admin("POST", "/admin/route-sources", blocRoute());
    assert.equal(unknown.status, 400);
    assert.equal(unknown.body.error, "INVALID_AUTHORITY");
    assert.equal((await admin("POST", "/admin/route-sources", blocRoute({ authorityId: "bad_id" }))).body.error, "INVALID_AUTHORITY");
    assert.equal((await admin("POST", "/admin/route-sources", routeBody({ authorityId: "ZZ" }))).body.error, "INVALID_AUTHORITY");
    // The old field name is an unknown key.
    const old = routeBody();
    delete (old as any).authorityId;
    assert.equal((await admin("POST", "/admin/route-sources", { ...old, countryCode: "SV" })).status, 400);
    putBloc("retired");
    assert.equal((await admin("POST", "/admin/route-sources", blocRoute())).body.error, "AUTHORITY_RETIRED");
    // A visa id must carry the bloc's prefix.
    putBloc();
    assert.equal((await admin("POST", "/admin/route-sources", blocRoute({ visaId: "sv-short-stay" }))).body.error, "INVALID_VISA_ID");
    assert.equal(fetcher.calls.length, 0);
  });

  test("a guidance source cannot be switched on while its host is confirmed only for another authority", async () => {
    await readyToRegister();
    await admin("POST", "/admin/route-sources", routeBody());
    await admin("POST", "/admin/official-domains/rules.agency.example.org/revoke", {});
    // The host is re-confirmed, but for a different country.
    await confirmHost("rules.agency.example.org", "KE");
    const r = await admin("PATCH", "/admin/guidance-sources/sv-visitor-rules", { status: "active" });
    assert.equal(r.status, 422);
    assert.equal(r.body.error, "HOST_NOT_CONFIRMED");
    assert.equal((store.get("guidanceSources/sv-visitor-rules") as any).status, "paused");
  });

  test("an officialDomains doc from before #232 (countryCode only) is read as that country's authority", async () => {
    serveFixtures();
    const legacy = (host: string) => ({ host, countryCode: "SV", status: "confirmed", confirmedBy: "u", confirmedAt: Timestamp.fromMillis(nowMs), statement: "The Example Agency", addedVia: "portal" });
    store.set("officialDomains/www.agency.example.org", legacy("www.agency.example.org"));
    store.set("officialDomains/rules.agency.example.org", legacy("rules.agency.example.org"));
    // Listed with authorityId, without the old field.
    const list = await admin("GET", "/admin/official-domains");
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.data.domains.map((d: any) => [d.authorityId, d.countryCode]), [["SV", undefined], ["SV", undefined]]);
    // Confirming for the same country is idempotent; for another, a conflict.
    await admin("POST", "/admin/official-domains/preview", { url: "https://www.agency.example.org/" });
    assert.equal((await admin("POST", "/admin/official-domains", { host: "www.agency.example.org", authorityId: "SV", statement: "x agency" })).body.data.created, false);
    assert.equal((await admin("POST", "/admin/official-domains", { host: "www.agency.example.org", authorityId: "KE", statement: "x agency" })).body.error, "HOST_CONFIRMED_FOR_OTHER_AUTHORITY");
    // Registration under that country accepts the old docs' hosts.
    fetcher.calls.length = 0;
    const r = await admin("POST", "/admin/route-sources", routeBody());
    assert.equal(r.status, 201, JSON.stringify(r.body));
    // A revoke rewrites the doc in today's shape.
    await admin("POST", "/admin/official-domains/rules.agency.example.org/revoke", {});
    const revoked = store.get("officialDomains/rules.agency.example.org") as any;
    assert.equal(revoked.authorityId, "SV");
    assert.equal(revoked.countryCode, undefined);
    // A doc with neither field belongs to no authority (fails closed).
    const { officialDomainAuthorityId } = await import("../../../../src/scrapers/shared/registry/official-domains.service");
    assert.equal(officialDomainAuthorityId({ host: "x.example.org" }), "");
    assert.equal(officialDomainAuthorityId({ authorityId: "test-bloc", countryCode: "SV" }), "test-bloc");
  });
});

// ============================================
// Edit a guidance source
// ============================================

describe("PATCH /admin/guidance-sources/:id", () => {
  const SRC = "guidanceSources/sv-visitor-rules";

  test("sets status and role, audits each change, and a no-op writes nothing", async () => {
    await readyToRegister();
    await admin("POST", "/admin/route-sources", routeBody());
    const base = auditDocs().length;
    let r = await admin("PATCH", "/admin/guidance-sources/sv-visitor-guide", { role: "secondary" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((store.get("guidanceSources/sv-visitor-guide") as any).role, "secondary");
    assert.equal((store.get("guidanceSources/sv-visitor-guide") as any).roleEditedBy, "admin-uid");
    r = await admin("PATCH", "/admin/guidance-sources/sv-visitor-guide", { status: "paused" });
    assert.equal((store.get("guidanceSources/sv-visitor-guide") as any).status, "paused");
    r = await admin("PATCH", "/admin/guidance-sources/sv-visitor-guide", { status: "retired" });
    assert.equal((store.get("guidanceSources/sv-visitor-guide") as any).status, "retired");
    r = await admin("PATCH", "/admin/guidance-sources/sv-visitor-guide", { status: "active" });
    assert.equal(r.status, 200);
    assert.equal((store.get("guidanceSources/sv-visitor-guide") as any).status, "active");
    assert.equal(auditDocs().length, base + 4);
    const last = auditDocs().filter((a) => a.action === "source_changed").pop();
    assert.equal(last.actorUid, "admin-uid");
    assert.deepEqual(last.before, { status: "retired" });
    assert.deepEqual(last.after, { status: "active" });
    // No-op.
    const n = auditDocs().length;
    r = await admin("PATCH", "/admin/guidance-sources/sv-visitor-guide", { status: "active" });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.data.changes, {});
    assert.equal(auditDocs().length, n);
  });

  test("field whitelisting: only status and role; bad values and unknown ids are refused", async () => {
    await readyToRegister();
    await admin("POST", "/admin/route-sources", routeBody());
    const before = JSON.stringify(store.get(SRC));
    for (const body of [{ url: "https://evil.example.net/" }, { verificationStatus: "verified" }, { addedVia: "seed" }, { status: "failing" }, { status: "deleted" }, { role: "boss" }, {}, { status: "paused", jurisdiction: "XX" }]) {
      assert.equal((await admin("PATCH", "/admin/guidance-sources/sv-visitor-rules", body)).status, 400, JSON.stringify(body));
    }
    assert.equal(JSON.stringify(store.get(SRC)), before);
    assert.equal((await admin("PATCH", "/admin/guidance-sources/nope", { status: "paused" })).status, 404);
  });

  test("the route's only primary cannot be demoted", async () => {
    await readyToRegister();
    await admin("POST", "/admin/route-sources", routeBody());
    const r = await admin("PATCH", "/admin/guidance-sources/sv-visitor-rules", { role: "secondary" });
    assert.equal(r.status, 422);
    assert.equal(r.body.error, "PRIMARY_REQUIRED");
    // With a second primary it is allowed.
    assert.equal((await admin("PATCH", "/admin/guidance-sources/sv-visitor-guide", { role: "primary" })).status, 200);
    assert.equal((await admin("PATCH", "/admin/guidance-sources/sv-visitor-rules", { role: "secondary" })).status, 200);
  });

  test("a portal source cannot be switched on while its host is revoked; re-confirming allows it", async () => {
    await readyToRegister();
    await admin("POST", "/admin/route-sources", routeBody());
    await admin("POST", "/admin/official-domains/rules.agency.example.org/revoke", {});
    const r = await admin("PATCH", "/admin/guidance-sources/sv-visitor-rules", { status: "active" });
    assert.equal(r.status, 422);
    assert.equal(r.body.error, "HOST_NOT_CONFIRMED");
    assert.equal((store.get(SRC) as any).status, "paused");
    // Re-confirm the host (a fresh check), then activate: the system's reason is cleared.
    await confirmHost("rules.agency.example.org");
    const ok = await admin("PATCH", "/admin/guidance-sources/sv-visitor-rules", { status: "active" });
    assert.equal(ok.status, 200);
    assert.equal((store.get(SRC) as any).status, "active");
    assert.equal((store.get(SRC) as any).pausedReason, null);
  });
});

// ============================================
// Audit is append-only
// ============================================

describe("audit trail", () => {
  test("entries are created with tx.create and nothing in src updates or deletes the audit collection", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const dir = path.join(__dirname, "..", "..", "..", "..", "src");
    const files: string[] = [];
    const walk = (d: string) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith(".ts") && files.push(path.join(d, e.name))));
    walk(dir);
    const users = files.filter((f) => fs.readFileSync(f, "utf8").includes("sourceRegistryAudit"));
    assert.deepEqual(users.map((f) => path.basename(f)).sort(), ["firebase.ts", "registry-audit.ts"]);
    const audit = fs.readFileSync(path.join(dir, "scrapers/shared/registry/registry-audit.ts"), "utf8");
    assert.match(audit, /tx\.create\(/);
    assert.doesNotMatch(audit, /\.update\(|\.delete\(|\.set\(/);
  });

  test("a second create with the same id fails (append-only)", async () => {
    const { fakeRunTransaction } = await import("../../../helpers/fake-firestore");
    const { appendRegistryAudit } = await import("../../../../src/scrapers/shared/registry/registry-audit");
    const entry = { action: "source_changed" as const, actorUid: "u", at: Timestamp.fromMillis(1), targetType: "t", targetId: "i", before: null, after: null };
    const id = await fakeRunTransaction(async (tx: any) => appendRegistryAudit(tx, entry));
    await assert.rejects(() => fakeRunTransaction(async (tx: any) => tx.create({ path: `sourceRegistryAudit/${id}` }, {})), /ALREADY_EXISTS/);
  });
});
