// ============================================
// Unit tests — crawler etiquette: host backoff on 429/503 (issue #64)
// ============================================
//
// Run with `npm test`. Pure: no Firebase, no network. The fetch service gets
// a stubbed HTTP client and a fixed clock, so Retry-After maths is exact.
//
// Covers:
//  - parseRetryAfter: delta-seconds, HTTP-date, past date, garbage, missing,
//    clamping, array-valued headers
//  - backoffDelayMs: DEFAULT_BACKOFF_MS when the header is missing/garbage
//  - HostBackoffTracker: stored vs fresh entries, merge, persistence filter
//  - VisaCatalogFetchService: 429 (seconds) / 503 (HTTP-date) / no header
//    throw HostBackoffError on pages, getRaw and robots.txt; robots 429 sends
//    no page request and is not cached; other non-2xx are unchanged
//  - both adapters let HostBackoffError propagate unchanged
//  - a 429 after a cross-host redirect names the FINAL host (and keeps the
//    requested one); without responseUrl it falls back to the requested host
//  - hostBackoffEntriesFromSource / ToSource (shared by orchestrator + script)
//  - robots.txt (review round 1): RFC 9309 groups — multi-agent group, our
//    agent second in the list, specific group beats `*`; cache TTL 24h

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_BACKOFF_MS,
  HostBackoffError,
  HostBackoffTracker,
  MAX_BACKOFF_MS,
  backoffDelayMs,
  backoffMessage,
  isBackoffStatus,
  isHostBackoffError,
  parseRetryAfter,
} from "../src/services/visa-crawl-host-state";
import {
  ROBOTS_CACHE_TTL_MS,
  VisaCatalogFetchService,
  parseRobotsDisallows,
  type VisaCatalogHttpClient,
} from "../src/services/visa-catalog-fetch.service";
import {
  hostBackoffEntriesFromSource,
  hostBackoffEntriesToSource,
} from "../src/services/visa-crawl-host-backoff-store";
import { Timestamp } from "firebase-admin/firestore";
import { GenericHtmlAdapter, GovukContentApiAdapter } from "../src/services/visa-source-adapters";
import type { VisaSourcePage } from "../src/types/visa-catalog";

// Fixed "now" for every test: Mon 2026-11-09 02:15:00 UTC.
const NOW = Date.parse("2026-11-09T02:15:00Z");
const MIN = 60 * 1000;

// ----- parseRetryAfter / backoffDelayMs -----

describe("parseRetryAfter", () => {
  test("delta-seconds -> ms", () => {
    assert.equal(parseRetryAfter("120", NOW), 120_000);
    assert.equal(parseRetryAfter(" 0 ", NOW), 0); // whitespace tolerated
    assert.equal(parseRetryAfter(30, NOW), 30_000); // numeric header value
  });

  test("HTTP-date -> ms until that instant", () => {
    assert.equal(parseRetryAfter("Mon, 09 Nov 2026 02:45:00 GMT", NOW), 30 * MIN);
  });

  test("a date in the past -> 0 (retry now; the run still stops)", () => {
    assert.equal(parseRetryAfter("Sun, 08 Nov 2026 02:15:00 GMT", NOW), 0);
  });

  test("garbage / missing -> undefined", () => {
    for (const v of [undefined, null, "", "   ", "soon", "-5", "1.5", "12abc", "1-2", {}, true]) {
      assert.equal(parseRetryAfter(v, NOW), undefined, `value ${JSON.stringify(v)}`);
    }
  });

  test("clamped to MAX_BACKOFF_MS (huge seconds, far-future date)", () => {
    assert.equal(parseRetryAfter("999999999999", NOW), MAX_BACKOFF_MS);
    assert.equal(parseRetryAfter("Fri, 01 Jan 2100 00:00:00 GMT", NOW), MAX_BACKOFF_MS);
  });

  test("array-valued header -> first value", () => {
    assert.equal(parseRetryAfter(["60", "120"], NOW), 60_000);
  });
});

describe("backoffDelayMs", () => {
  test("parsed value when usable, DEFAULT_BACKOFF_MS otherwise", () => {
    assert.equal(backoffDelayMs("90", NOW), 90_000);
    assert.equal(backoffDelayMs(undefined, NOW), DEFAULT_BACKOFF_MS);
    assert.equal(backoffDelayMs("whenever", NOW), DEFAULT_BACKOFF_MS);
  });

  test("only 429 and 503 are backoff statuses", () => {
    assert.ok(isBackoffStatus(429));
    assert.ok(isBackoffStatus(503));
    for (const s of [200, 403, 404, 500, 502, 504]) assert.equal(isBackoffStatus(s), false);
  });
});

// ----- HostBackoffTracker -----

describe("HostBackoffTracker", () => {
  const entry = (host: string, untilMs: number, status = 429) => ({ host, untilMs, status, recordedAtMs: NOW });

  test("stored entries block only while in the future; expired ones are ignored", () => {
    const t = new HostBackoffTracker(NOW);
    t.load([entry("a.gov", NOW + MIN), entry("b.gov", NOW - MIN)]);
    assert.ok(t.blocking("a.gov"));
    assert.ok(t.blocking("A.GOV")); // case-insensitive
    assert.equal(t.blocking("b.gov"), undefined);
    assert.equal(t.isFresh("a.gov"), false);
  });

  test("a fresh (this-run) entry blocks for the rest of the run, even Retry-After: 0", () => {
    const t = new HostBackoffTracker(NOW);
    t.record(entry("a.gov", NOW)); // until == now
    assert.ok(t.blocking("a.gov"));
    assert.ok(t.isFresh("a.gov"));
    // ...but there is nothing to persist: it is not in the future.
    assert.deepEqual(t.entriesFor(["a.gov"]), []);
  });

  test("merge keeps the later untilMs; entriesFor filters to the given hosts", () => {
    const t = new HostBackoffTracker(NOW);
    t.load([entry("a.gov", NOW + 10 * MIN)]);
    t.record(entry("a.gov", NOW + 5 * MIN)); // earlier: stored one wins
    t.record(entry("c.gov", NOW + MIN, 503));
    assert.deepEqual(t.entriesFor(["c.gov", "a.gov", "a.gov", "zzz.gov"]), [
      entry("a.gov", NOW + 10 * MIN),
      entry("c.gov", NOW + MIN, 503),
    ]);
  });

  test("backoffMessage / HostBackoffError carry status and retry-after instant", () => {
    const err = new HostBackoffError({ host: "a.gov", status: 429, untilMs: NOW + 30 * MIN });
    assert.equal(err.message, "host backed off (429), retry after 2026-11-09T02:45:00.000Z");
    assert.equal(backoffMessage({ status: 503, untilMs: NOW }), "host backed off (503), retry after 2026-11-09T02:15:00.000Z");
    assert.ok(isHostBackoffError(err));
    assert.equal(isHostBackoffError(new Error("x")), false);
    assert.deepEqual(err.toEntry(NOW), entry("a.gov", NOW + 30 * MIN));
  });
});

// ----- Fetch service + adapters with a stubbed client -----

/** One stubbed response. */
interface StubResponse {
  status: number;
  body?: string;
  headers?: Record<string, unknown>;
  responseUrl?: string; // post-redirect URL, as axios's Node adapter reports it
}

/** Stub client serving `routes[url]` (404 when absent) and recording requested URLs. */
function stubService(routes: Record<string, StubResponse>, clock: () => number = () => NOW) {
  const calls: string[] = [];
  const http: VisaCatalogHttpClient = {
    async get(url) {
      calls.push(url);
      const r = routes[url] ?? { status: 404, body: "not found" };
      return {
        status: r.status,
        data: r.body ?? "",
        headers: r.headers ?? {},
        ...(r.responseUrl ? { request: { res: { responseUrl: r.responseUrl } } } : {}),
      };
    },
  };
  const service = new VisaCatalogFetchService({ http, minIntervalMs: 0, clock });
  return { service, calls };
}

const PAGE_URL = "https://immi.example.gov/visas/work";
const ROBOTS_URL = "https://immi.example.gov/robots.txt";
const page = (url = PAGE_URL): VisaSourcePage => ({ url, routeName: "Work visa", validation: "text_verified" });

/** Assert `p` rejects with a HostBackoffError matching host/status/untilMs. */
async function rejectsWithBackoff(p: Promise<unknown>, host: string, status: number, untilMs: number) {
  await assert.rejects(p, (err: unknown) => {
    assert.ok(isHostBackoffError(err), `expected HostBackoffError, got ${String(err)}`);
    assert.equal(err.host, host);
    assert.equal(err.status, status);
    assert.equal(err.untilMs, untilMs);
    return true;
  });
}

describe("VisaCatalogFetchService — 429/503 backoff", () => {
  test("page 429 with Retry-After seconds -> HostBackoffError(now + seconds)", async () => {
    const { service } = stubService({
      [ROBOTS_URL]: { status: 404 },
      [PAGE_URL]: { status: 429, headers: { "retry-after": "120" } },
    });
    await rejectsWithBackoff(service.fetchAndClean(PAGE_URL, { checkRobots: true }), "immi.example.gov", 429, NOW + 120_000);
  });

  test("page 503 with an HTTP-date Retry-After -> that instant", async () => {
    const { service } = stubService({
      [PAGE_URL]: { status: 503, headers: { "Retry-After": "Mon, 09 Nov 2026 03:15:00 GMT" } },
    });
    await rejectsWithBackoff(service.fetchAndClean(PAGE_URL), "immi.example.gov", 503, Date.parse("2026-11-09T03:15:00Z"));
  });

  test("missing Retry-After -> DEFAULT_BACKOFF_MS", async () => {
    const { service } = stubService({ [PAGE_URL]: { status: 429 } });
    await rejectsWithBackoff(service.fetchAndClean(PAGE_URL), "immi.example.gov", 429, NOW + DEFAULT_BACKOFF_MS);
  });

  test("garbage Retry-After -> DEFAULT_BACKOFF_MS", async () => {
    const { service } = stubService({ [PAGE_URL]: { status: 503, headers: { "retry-after": "later please" } } });
    await rejectsWithBackoff(service.fetchAndClean(PAGE_URL), "immi.example.gov", 503, NOW + DEFAULT_BACKOFF_MS);
  });

  test("robots.txt 429 -> backoff, NO page request, robots not cached", async () => {
    const { service, calls } = stubService({
      [ROBOTS_URL]: { status: 429, headers: { "retry-after": "60" } },
      [PAGE_URL]: { status: 200, body: "<html><body>never fetched</body></html>" },
    });
    await rejectsWithBackoff(service.fetchAndClean(PAGE_URL, { checkRobots: true }), "immi.example.gov", 429, NOW + 60_000);
    assert.deepEqual(calls, [ROBOTS_URL]);
    // Not cached as "no robots": the next check asks again (and backs off again).
    await assert.rejects(service.isAllowedByRobots(PAGE_URL), HostBackoffError);
    assert.deepEqual(calls, [ROBOTS_URL, ROBOTS_URL]);
  });

  test("getRaw 503 throws (adapters back off the same way); other non-2xx still return", async () => {
    const api = "https://www.gov.uk/api/content/graduate-visa";
    const { service } = stubService({ [api]: { status: 503, headers: { "retry-after": "5" } } });
    await rejectsWithBackoff(service.getRaw(api), "www.gov.uk", 503, NOW + 5_000);
    const other = stubService({ [api]: { status: 500, body: "boom" } });
    assert.equal((await other.service.getRaw(api)).status, 500);
  });

  test("a non-backoff error status is unchanged (HTTP 500 message)", async () => {
    const { service } = stubService({ [PAGE_URL]: { status: 500 } });
    await assert.rejects(service.fetchAndClean(PAGE_URL), /HTTP 500/);
  });

  test("both adapters let HostBackoffError propagate", async () => {
    const html = stubService({ [ROBOTS_URL]: { status: 404 }, [PAGE_URL]: { status: 429, headers: { "retry-after": "10" } } });
    await rejectsWithBackoff(new GenericHtmlAdapter(html.service).fetch(page()), "immi.example.gov", 429, NOW + 10_000);

    const govuk = stubService({
      "https://www.gov.uk/robots.txt": { status: 404 },
      "https://www.gov.uk/api/content/graduate-visa": { status: 503, headers: { "retry-after": "10" } },
    });
    await rejectsWithBackoff(
      new GovukContentApiAdapter(govuk.service).fetch(page("https://www.gov.uk/graduate-visa")),
      "www.gov.uk",
      503,
      NOW + 10_000
    );
  });
});

// ----- Redirects: which host gets the backoff -----

describe("VisaCatalogFetchService — 429 after a redirect", () => {
  test("names the FINAL host, keeps the requested one", async () => {
    const { service } = stubService({
      [PAGE_URL]: { status: 429, headers: { "retry-after": "60" }, responseUrl: "https://cdn.example.net/visas/work" },
    });
    await assert.rejects(service.fetchAndClean(PAGE_URL), (err: unknown) => {
      assert.ok(isHostBackoffError(err));
      assert.equal(err.host, "cdn.example.net");
      assert.equal(err.requestedHost, "immi.example.gov");
      return true;
    });
  });

  test("no responseUrl (stub / non-Node adapter) -> the requested host", async () => {
    const { service } = stubService({ [PAGE_URL]: { status: 503 } });
    await assert.rejects(service.fetchAndClean(PAGE_URL), (err: unknown) => {
      assert.ok(isHostBackoffError(err));
      assert.equal(err.host, "immi.example.gov");
      assert.equal(err.requestedHost, "immi.example.gov");
      return true;
    });
  });
});

// ----- Firestore mappers (shared by orchestrator + manual script) -----

describe("hostBackoffEntriesFromSource / ToSource", () => {
  test("round-trips, keeps recordedAt, drops malformed entries", () => {
    const entries = [{ host: "a.gov", untilMs: NOW + MIN, status: 429, recordedAtMs: NOW - MIN }];
    const stored = hostBackoffEntriesToSource(entries);
    assert.ok(stored[0].until instanceof Timestamp);
    assert.deepEqual(hostBackoffEntriesFromSource(stored), entries);
    const bad = [
      { host: "", until: Timestamp.fromMillis(NOW), status: 429, recordedAt: Timestamp.fromMillis(NOW) },
      { host: "b.gov", until: "not a timestamp", status: 429 },
      null,
    ] as any;
    assert.deepEqual(hostBackoffEntriesFromSource(bad), []);
    assert.deepEqual(hostBackoffEntriesFromSource(undefined), []);
  });

  test("a missing recordedAt falls back to until", () => {
    const stored = [{ host: "a.gov", until: Timestamp.fromMillis(NOW + MIN), status: 503 }] as any;
    assert.equal(hostBackoffEntriesFromSource(stored)[0].recordedAtMs, NOW + MIN);
  });
});

// ----- robots.txt: RFC 9309 groups + cache TTL -----

describe("parseRobotsDisallows — RFC 9309 groups", () => {
  test("a group listing several agents applies to all of them (our agent first)", () => {
    const txt = "User-agent: Seli-VisaCatalogBot\nUser-agent: OtherBot\nDisallow: /\n";
    assert.deepEqual(parseRobotsDisallows(txt), ["/"]);
  });

  test("our agent SECOND in the list still gets the group's rules", () => {
    const txt = "User-agent: OtherBot\nUser-agent: Seli-VisaCatalogBot\nDisallow: /private\n";
    assert.deepEqual(parseRobotsDisallows(txt), ["/private"]);
  });

  test("a specific group wins over `*` (the `*` rules are ignored)", () => {
    const txt = [
      "User-agent: *",
      "Disallow: /",
      "",
      "User-agent: Seli-VisaCatalogBot",
      "Disallow: /drafts",
    ].join("\n");
    assert.deepEqual(parseRobotsDisallows(txt), ["/drafts"]);
    // ...and with an empty Disallow, our group allows everything despite `*`.
    assert.deepEqual(parseRobotsDisallows("User-agent: *\nDisallow: /\nUser-agent: seli\nDisallow:\n"), []);
  });

  test("without a specific group, `*` applies; a rule line ends the agent list", () => {
    const txt = [
      "User-agent: *",
      "Disallow: /search",
      "User-agent: OtherBot", // new group: OtherBot only
      "Disallow: /",
    ].join("\n");
    assert.deepEqual(parseRobotsDisallows(txt), ["/search"]);
  });

  test("several groups naming us are merged; Sitemap/Crawl-delay don't end the agent list", () => {
    const txt = [
      "User-agent: Seli-VisaCatalogBot",
      "Crawl-delay: 5",
      "User-agent: OtherBot",
      "Disallow: /a",
      "Sitemap: https://x.gov/sitemap.xml",
      "User-agent: SELI",
      "Disallow: /b # comment",
    ].join("\r\n");
    assert.deepEqual(parseRobotsDisallows(txt), ["/a", "/b"]);
  });

  test("no applicable group / rules before any user-agent -> nothing disallowed", () => {
    assert.deepEqual(parseRobotsDisallows("Disallow: /\nUser-agent: OtherBot\nDisallow: /\n"), []);
    assert.deepEqual(parseRobotsDisallows(""), []);
  });
});

describe("VisaCatalogFetchService — robots.txt cache TTL", () => {
  test("re-reads robots.txt once the cached copy is older than ROBOTS_CACHE_TTL_MS", async () => {
    let now = NOW;
    const { service, calls } = stubService(
      { [ROBOTS_URL]: { status: 200, body: "User-agent: *\nDisallow: /blocked\n" } },
      () => now
    );
    assert.equal(await service.isAllowedByRobots(PAGE_URL), true);
    assert.equal(await service.isAllowedByRobots("https://immi.example.gov/blocked/x"), false);
    assert.equal(calls.length, 1); // cached within the TTL
    now += ROBOTS_CACHE_TTL_MS - 1;
    await service.isAllowedByRobots(PAGE_URL);
    assert.equal(calls.length, 1); // still fresh
    now += 1;
    await service.isAllowedByRobots(PAGE_URL);
    assert.equal(calls.length, 2); // expired -> re-read
  });
});
