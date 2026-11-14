// ============================================
// Host policy in the fetch path and the crawls (issue #215)
// ============================================
//
// 1. The REAL guarded HTTP client against loopback stub servers: a redirect hop
//    to a host that is not allowed is refused BEFORE it is requested; the
//    requested host is refused before anything is sent; allowed redirects work.
// 2. The check-address action over the real fetch service on a stubbed client:
//    internal address, oversize, timeout, redirect to another host.
// 3. Both crawls: a portal-added source refuses a redirect to an unconfirmed
//    host (recorded as the source's error, not a crash), fails closed when the
//    allow-list cannot be read, and seeded sources are unaffected.

import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { Timestamp } from "firebase-admin/firestore";
import { fakeCollection, fakeRunTransaction, resetStore, store } from "../../../helpers/fake-firestore";
import { HostNotAllowedError, VisaCatalogFetchService, type VisaCatalogHttpClient } from "../../../../src/scrapers/shared/fetch/visa-catalog-fetch.service";
import { GuidanceCrawlService } from "../../../../src/scrapers/guidance/guidance-crawl.service";
import { GuidanceSnapshotStore, type SnapshotBucket } from "../../../../src/scrapers/guidance/guidance-snapshot.store";
import { buildSeededGuidanceSource } from "../../../../src/scrapers/guidance/data/seed-guidance-sources";
import { sourcePreviewService } from "../../../../src/scrapers/shared/registry/source-preview.service";
import { quiet, wireRegistry } from "./registry-harness";

/* eslint-disable @typescript-eslint/no-explicit-any */

let wired: any;
before(async () => {
  wired = await wireRegistry();
  const firebase: any = await import("../../../../src/utils/firebase");
  firebase.subcollections.guidanceSnapshots = (id: string) => fakeCollection(`guidanceSources/${id}/snapshots`);
});
after(() => wired.close());
beforeEach(() => resetStore());

const BODY = `<html><head><title>Page</title></head><body><main><p>${"Applicants must show they can support themselves. ".repeat(10)}</p></main></body></html>`;

// ============================================
// 1. The real client, loopback servers
// ============================================

describe("host policy over the real guarded client", () => {
  let a: http.Server;
  let b: http.Server;
  let baseA = "";
  let portB = 0;
  const hitsA: string[] = [];
  const hitsB: string[] = [];

  before(async () => {
    b = http.createServer((req, res) => {
      hitsB.push(req.url ?? "");
      res.setHeader("content-type", "text/html");
      res.end(BODY);
    });
    await new Promise<void>((r) => b.listen(0, "127.0.0.1", r));
    portB = (b.address() as AddressInfo).port;
    a = http.createServer((req, res) => {
      hitsA.push(req.url ?? "");
      const url = req.url ?? "/";
      if (url === "/to-b") {
        // Same machine, DIFFERENT host name: "localhost" instead of 127.0.0.1.
        res.statusCode = 302;
        res.setHeader("location", `http://localhost:${portB}/landing`);
        return res.end();
      }
      if (url === "/same") {
        res.statusCode = 302;
        res.setHeader("location", "/plain");
        return res.end();
      }
      if (url === "/robots.txt") {
        res.statusCode = 404;
        return res.end();
      }
      res.setHeader("content-type", "text/html");
      res.end(BODY);
    });
    await new Promise<void>((r) => a.listen(0, "127.0.0.1", r));
    baseA = `http://127.0.0.1:${(a.address() as AddressInfo).port}`;
  });
  after(async () => {
    for (const s of [a, b]) {
      s.closeAllConnections();
      await new Promise<void>((r) => s.close(() => r()));
    }
  });
  beforeEach(() => {
    hitsA.length = 0;
    hitsB.length = 0;
  });

  const service = () => new VisaCatalogFetchService({ minIntervalMs: 0, addressGuard: { allowAddress: (ip) => ip === "127.0.0.1" || ip === "::1", allowPort: () => true } });

  test("a redirect hop to a host that is not allowed is refused before it is requested", async () => {
    await assert.rejects(
      () => service().fetchAndClean(`${baseA}/to-b`, { allowedHost: (h) => h === "127.0.0.1" }),
      (err: any) => err instanceof HostNotAllowedError && err.host === "localhost" && err.stage === "redirect" && /not a confirmed official website/.test(err.message)
    );
    assert.deepEqual(hitsB, [], "the redirect target never received a request");
  });

  test("the same redirect without a policy is followed (the policy is what refuses it)", async () => {
    const page = await service().fetchAndClean(`${baseA}/to-b`);
    assert.equal(page.finalUrl, `http://localhost:${portB}/landing`);
    assert.equal(hitsB.length, 1);
  });

  test("a redirect inside the allowed host works", async () => {
    const page = await service().fetchAndClean(`${baseA}/same`, { allowedHost: (h) => h === "127.0.0.1" });
    assert.equal(page.finalUrl, `${baseA}/plain`);
    assert.equal(page.htmlLang, null);
    assert.equal(page.title, "Page");
  });

  test("a requested host that is not allowed is refused before ANY request, robots.txt included", async () => {
    await assert.rejects(() => service().fetchAndClean(`${baseA}/plain`, { checkRobots: true, allowedHost: () => false }), (err: any) => err instanceof HostNotAllowedError && err.stage === "request");
    assert.deepEqual(hitsA, []);
  });
});

// ============================================
// 2. The check-address action over the real fetch service
// ============================================

describe("check-address action: the guarded fetch service's protections", () => {
  /** A fetch service whose HTTP client is scripted (no network). */
  const svc = (client: VisaCatalogHttpClient, addressGuard?: any) => new VisaCatalogFetchService({ http: client, minIntervalMs: 0, ...(addressGuard ? { addressGuard } : {}) });
  const use = async (fetchService: VisaCatalogFetchService, fn: () => Promise<void>) => {
    const original = sourcePreviewService.fetcher;
    sourcePreviewService.fetcher = fetchService;
    try {
      await quiet(fn);
    } finally {
      sourcePreviewService.fetcher = original;
    }
  };
  const html = (extra: object = {}) => ({ status: 200, data: BODY, headers: { "content-type": "text/html" }, ...extra });

  test("a name that resolves to an internal address is refused by the connect-time guard: 422, the guard's own text, no address echoed", async () => {
    // The REAL guarded client with a resolver that answers a private address: the
    // socket is never opened.
    const real = new VisaCatalogFetchService({ minIntervalMs: 0, addressGuard: { resolver: async () => [{ address: "10.1.2.3", family: 4 }] } });
    await use(real, async () => {
      await assert.rejects(
        () => sourcePreviewService.preview("https://internal.example.org/page", { purpose: "check" }),
        (err: any) => err.code === "ADDRESS_NOT_ALLOWED" && err.status === 422 && err.message === "Refusing to fetch from internal.example.org: address not allowed" && !/10\.1\.2\.3/.test(err.message)
      );
    });
  });

  test("oversize: a declared size over the cap is refused before the body is read (plain 502)", async () => {
    let destroyed = false;
    const stream = Object.assign(Readable.from(["x"]), {});
    stream.on("close", () => (destroyed = true));
    const big = svc({ get: async () => html({ data: stream, headers: { "content-type": "text/html", "content-length": String(50 * 1024 * 1024) } }) });
    await use(big, async () => {
      await assert.rejects(() => sourcePreviewService.preview("https://big.example.org/", { purpose: "check" }), (err: any) => err.code === "FETCH_FAILED" && err.status === 502 && /too large/i.test(err.message));
    });
    await new Promise((r) => setImmediate(r)); // `close` is emitted a tick after destroy()
    assert.equal(destroyed, true, "the unread body was discarded");
  });

  test("timeout: a client timeout is a plain 502", async () => {
    const slow = svc({ get: async () => { throw Object.assign(new Error("timeout of 15000ms exceeded"), { code: "ECONNABORTED" }); } });
    await use(slow, async () => {
      await assert.rejects(() => sourcePreviewService.preview("https://slow.example.org/", { purpose: "check" }), (err: any) => err.code === "FETCH_FAILED" && /timeout/.test(err.message));
    });
  });

  test("a stalled body (idle timer) is refused too", async () => {
    const never = new Readable({ read() {} });
    const stalled = new VisaCatalogFetchService({ http: { get: async () => html({ data: never }) }, minIntervalMs: 0, bodyIdleTimeoutMs: 20, bodyTimeoutMs: 50 });
    await use(stalled, async () => {
      await assert.rejects(() => sourcePreviewService.preview("https://stall.example.org/", { purpose: "check" }), (err: any) => err.code === "FETCH_FAILED");
    });
    never.destroy();
  });

  test("redirect to another host: in the single check action it is FOLLOWED and reported (the guard judged every hop); with the policy it is refused and the body never read", async () => {
    const client: VisaCatalogHttpClient = { get: async (url) => html({ request: { res: { responseUrl: url.endsWith("robots.txt") ? url : "https://other.example.net/landing" } } }) };
    await use(svc(client), async () => {
      const p = await sourcePreviewService.preview("https://start.example.org/", { purpose: "check" });
      assert.equal(p.finalHost, "other.example.net");
      assert.equal(p.redirectedToOtherHost, true);
      await assert.rejects(
        () => sourcePreviewService.preview("https://start.example.org/", { purpose: "visa_page", allowedHost: (h) => h === "start.example.org" }),
        (err: any) => err.code === "HOST_NOT_CONFIRMED" && err.status === 422 && err.extra.hosts[0] === "other.example.net"
      );
    });
  });

  test("a stub client that ignores the per-hop check is still caught by the final-URL check, before the body is read", async () => {
    let destroyed = false;
    const stream = Readable.from([BODY]);
    stream.on("close", () => (destroyed = true));
    const client: VisaCatalogHttpClient = { get: async (url) => (url.endsWith("robots.txt") ? html() : { status: 200, data: stream, headers: { "content-type": "text/html" }, request: { res: { responseUrl: "https://elsewhere.example.net/x" } } }) };
    await assert.rejects(() => svc(client).fetchAndClean("https://start.example.org/", { allowedHost: (h) => h === "start.example.org" }), (err: any) => err instanceof HostNotAllowedError);
    await new Promise((r) => setImmediate(r));
    assert.equal(destroyed, true);
  });

  test("the preview service has no direct HTTP call: it only ever uses the injected fetch service", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const dir = path.join(__dirname, "..", "..", "..", "..", "src", "scrapers", "shared", "registry");
    const files: string[] = [];
    const walk = (d: string) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith(".ts") && files.push(path.join(d, e.name))));
    walk(dir);
    assert.ok(files.length >= 10);
    for (const f of files) {
      const text = fs.readFileSync(f, "utf8");
      assert.doesNotMatch(text, /from ["']axios["']|require\(["']axios["']\)|\bfetch\(|node:https?["']|\bXMLHttpRequest\b|\bgot\(|node-fetch/, path.basename(f));
    }
  });
});

// ============================================
// 3. The crawls
// ============================================

describe("guidance crawl: portal-added sources", () => {
  const T0 = Date.parse("2026-11-11T02:00:00Z");
  const at = Timestamp.fromMillis(T0);
  const URL_A = "https://rules.agency.example.org/rules";
  const objects = new Map<string, string>();
  const bucket: SnapshotBucket = {
    file: (name: string) => ({
      async save(data: string) {
        objects.set(name, data);
      },
      async exists() {
        return [objects.has(name)];
      },
      async download() {
        return [Buffer.from(objects.get(name) ?? "", "utf8")];
      },
    }),
  } as any;

  /** Routes of the stubbed client: url -> responseUrl (redirect) or undefined. */
  let routes: Record<string, string | undefined>;
  let requested: string[];
  const client: VisaCatalogHttpClient = {
    async get(url) {
      requested.push(url);
      if (url.endsWith("/robots.txt")) return { status: 200, data: "", headers: { "content-type": "text/plain" } };
      const finalUrl = routes[url];
      return { status: 200, data: BODY, headers: { "content-type": "text/html" }, ...(finalUrl ? { request: { res: { responseUrl: finalUrl } } } : {}) };
    },
  };

  const seed = (over: Record<string, unknown> = {}, portal = true) => {
    const doc = buildSeededGuidanceSource(
      { id: "aa-rules", title: "Rules", url: URL_A, jurisdiction: "AA", route: "visit", docType: "html", role: "primary", checkIntervalHours: 24, verificationStatus: portal ? "registered" : "verified", verificationNote: "n", retrievedAt: "2026-11-01T00:00:00Z" },
      undefined,
      at
    );
    store.set("guidanceSources/aa-rules", { ...doc, ...(portal ? { addedVia: "portal", addedBy: "admin-uid", addedAt: at } : {}), ...over });
  };
  const run = async (hosts: () => Promise<Set<string>>) => {
    const fetcher = new VisaCatalogFetchService({ http: client, minIntervalMs: 0, clock: () => T0 });
    const svc = new GuidanceCrawlService(fetcher, new GuidanceSnapshotStore(bucket));
    svc.runTransaction = fakeRunTransaction as any;
    svc.confirmedHosts = hosts;
    return quiet(async () => svc.runOrchestrator({ now: at, sourceIds: ["aa-rules"], trigger: "manual" }));
  };
  beforeEach(() => {
    routes = {};
    requested = [];
    objects.clear();
  });

  test("a `registered` source is crawlable and is fetched when its host is confirmed", async () => {
    seed();
    const s = await run(async () => new Set(["rules.agency.example.org"]));
    assert.equal(s.failed, 0, JSON.stringify(s.results));
    assert.equal(s.changed, 1);
    assert.equal((store.get("guidanceSources/aa-rules") as any).status, "active");
  });

  test("a redirect to an unconfirmed host is the source's recorded error (host_not_confirmed), nothing is snapshotted, no crash", async () => {
    seed();
    routes[URL_A] = "https://elsewhere.example.net/page";
    const s = await run(async () => new Set(["rules.agency.example.org"]));
    assert.equal(s.failed, 1);
    const d = store.get("guidanceSources/aa-rules") as any;
    assert.equal(d.lastErrorKind, "host_not_confirmed");
    assert.match(d.lastError, /not a confirmed official website/);
    assert.equal(d.consecutiveFailures, 1);
    assert.equal(d.lastContentHash, null);
    assert.equal(objects.size, 0);
  });

  test("a host that was revoked (no longer confirmed) is not requested at all", async () => {
    seed();
    const s = await run(async () => new Set());
    assert.equal(s.failed, 1);
    assert.deepEqual(requested.filter((u) => !u.endsWith("robots.txt")), []);
    assert.equal((store.get("guidanceSources/aa-rules") as any).lastErrorKind, "host_not_confirmed");
  });

  test("fails closed: when the allow-list cannot be read the page is not fetched and the error is recorded", async () => {
    seed();
    const s = await run(async () => {
      throw new Error("firestore unavailable");
    });
    assert.equal(s.failed, 1);
    assert.deepEqual(requested, []);
    assert.match((store.get("guidanceSources/aa-rules") as any).lastError, /unavailable/);
  });

  test("a seeded (not portal-added) source never consults the allow-list", async () => {
    seed({}, false);
    let asked = 0;
    const s = await run(async () => {
      asked++;
      return new Set();
    });
    assert.equal(asked, 0);
    assert.equal(s.failed, 0);
  });
});

describe("visa crawl: portal-added pages", () => {
  const NOW = Date.parse("2026-11-10T12:00:00Z");
  const PORTAL = "https://www.agency.example.org/visit";
  const SEEDED = "https://seeded.example.net/visit";
  let crawl: any;
  let extractMod: any;
  let adapterCalls: Array<{ url: string; policy: boolean }>;
  let canonical: Record<string, string>;
  let extractions = 0;

  before(async () => {
    crawl = (await import("../../../../src/scrapers/visa-catalog/visa-catalog-crawl.service")).visaCatalogCrawlService;
    extractMod = await import("../../../../src/scrapers/visa-catalog/visa-catalog-extract.service");
  });

  const adapters = (): any => {
    const generic = {
      id: "generic-html",
      canHandle: () => true,
      fetch: async (page: { url: string }, opts?: { allowedHost?: (h: string) => boolean }) => {
        adapterCalls.push({ url: page.url, policy: Boolean(opts?.allowedHost) });
        return { url: page.url, canonicalUrl: canonical[page.url] ?? page.url, sourceProvider: "generic-html", withdrawn: false, sections: [{ slug: "page", title: "", text: "text" }], text: "text", contentHash: "h-new" };
      },
    };
    return { "generic-html": generic, "govuk-content-api": generic };
  };

  const seed = (pages: any[]) =>
    store.set("visaSources/AA", {
      id: "AA", countryCode: "AA", countryName: "Aland", status: "active", isOfficial: true, adapter: "generic-html",
      crawlWindow: { timeZone: "Etc/UTC", dayOfWeek: 1, startHour: 2, endHour: 5 },
      nextCrawlAt: Timestamp.fromMillis(NOW + 86_400_000), crawlIntervalHours: 168, consecutiveFailures: 0, reliabilityScore: 100, pages,
    });

  const run = async (confirmedHosts: () => Promise<Set<string>>) => {
    const original = extractMod.visaCatalogExtractor.extract;
    extractMod.visaCatalogExtractor.extract = async () => {
      extractions++;
      throw new Error("extractor stubbed: refuse so no record is written");
    };
    try {
      return await quiet(() => crawl.runOrchestrator({ now: NOW, sourceId: "AA", trigger: "manual", adapters: adapters(), confirmedHosts, fetchFxRates: async () => ({ rates: { USD: 1 }, rateDate: "2026-11-09" }) }));
    } finally {
      extractMod.visaCatalogExtractor.extract = original;
    }
  };
  const pageOf = (url: string) => (store.get("visaSources/AA") as any).pages.find((p: any) => p.url === url);
  beforeEach(() => {
    adapterCalls = [];
    canonical = {};
    extractions = 0;
  });

  test("a portal page is fetched WITH the host policy; a seeded page is not", async () => {
    seed([
      { url: PORTAL, routeName: "P", visaId: "aa-p", addedVia: "portal" },
      { url: SEEDED, routeName: "S", visaId: "aa-s" },
    ]);
    await run(async () => new Set(["www.agency.example.org"]));
    assert.deepEqual(adapterCalls.sort((a, b) => a.url.localeCompare(b.url)), [
      { url: SEEDED, policy: false },
      { url: PORTAL, policy: true },
    ]);
  });

  test("a canonical address on an unconfirmed host (an adapter that ignored the policy) is the page's recorded error, not a crash", async () => {
    seed([{ url: PORTAL, routeName: "P", visaId: "aa-p", addedVia: "portal" }]);
    canonical[PORTAL] = "https://elsewhere.example.net/x";
    const summary = await run(async () => new Set(["www.agency.example.org"]));
    assert.equal(summary.errors, 1);
    assert.match(pageOf(PORTAL).lastError, /not a confirmed official website/);
    assert.equal(extractions, 0, "nothing was extracted from the unconfirmed host");
  });

  test("fails closed when the allow-list cannot be read: the adapter is never called, the error is recorded", async () => {
    seed([{ url: PORTAL, routeName: "P", visaId: "aa-p", addedVia: "portal" }]);
    const summary = await run(async () => {
      throw new Error("firestore unavailable");
    });
    assert.equal(summary.errors, 1);
    assert.equal(adapterCalls.length, 0);
    assert.match(pageOf(PORTAL).lastError, /unavailable/);
  });

  test("a paused portal page is skipped without any request and keeps its state", async () => {
    seed([{ url: PORTAL, routeName: "P", visaId: "aa-p", addedVia: "portal", paused: true, pausedReason: "host_revoked", lastContentHash: "keep" }]);
    await run(async () => new Set(["www.agency.example.org"]));
    assert.equal(adapterCalls.length, 0);
    assert.equal(pageOf(PORTAL).lastContentHash, "keep");
    assert.equal(pageOf(PORTAL).paused, true);
  });
});
