// ============================================
// Unit tests — visa source adapters (issue #58)
// ============================================
//
// Run with `npm test` (node:test via tsx). NO network: every HTTP call goes to
// a stub client injected into VisaCatalogFetchService, serving the recorded
// GOV.UK fixtures in test/fixtures/ (each records its source URL + date).
// No Firestore / emulator either: the modules under test are importable
// without Firebase Admin init.
//
// Covers: generic-html hash compatibility, the GOV.UK Content API adapter
// (URL, robots, rate limit, parts → text, section selection, formatting, cap,
// failures, withdrawn), adapter picking, scrapeMeta provenance, the withdrawn
// update rule, and registry seeding of `adapter` / section overrides.

import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import * as cheerio from "cheerio";
import { FieldValue, Timestamp } from "firebase-admin/firestore";

import {
  MAX_CLEAN_TEXT_CHARS,
  VisaCatalogFetchService,
  type VisaCatalogHttpClient,
} from "../src/services/visa-catalog-fetch.service";
import {
  GOVUK_MAX_TEXT_CHARS,
  GenericHtmlAdapter,
  GovukContentApiAdapter,
  createSourceAdapters,
  govukContentApiUrl,
  isWithdrawnNotice,
  pickSourceAdapter,
  sourceMetaFromDocument,
  type SourceDocument,
} from "../src/services/visa-source-adapters";
import {
  DEFAULT_EXCLUDE_SECTIONS,
  DEFAULT_INCLUDE_SECTIONS,
  selectSections,
  slugMatches,
} from "../src/services/visa-source-adapters/sections";
import { buildScrapeMeta, planRestoredUpdate, planWithdrawnUpdate } from "../src/services/visa-catalog-meta";
import {
  VISA_SOURCE_ADAPTERS,
  VISA_SOURCE_OVERRIDES,
  buildSeededVisaSource,
  type ParsedCountry,
} from "../src/data/seed-visa-sources";
import type { VisaSourcePage } from "../src/types/visa-catalog";

// ----- Fixtures + stub HTTP -----

/** A recorded response: `body` is a JSON object (serialised on serve) or raw text. */
interface Fixture {
  _fixture: { sourceUrl: string; recordedAt: string; notes: string };
  status: number;
  contentType: string;
  body: unknown;
}

/** Load a fixture by file name (deep-copied, so tests may mutate it). */
function loadFixture(name: string): Fixture {
  return JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8")) as Fixture;
}

/** A served response: status + text body + content type. */
interface StubResponse {
  status: number;
  body: string;
  contentType?: string;
}

/** Turn a fixture into a served response (objects become a JSON string). */
function served(f: Fixture): StubResponse {
  return {
    status: f.status,
    body: typeof f.body === "string" ? f.body : JSON.stringify(f.body),
    contentType: f.contentType,
  };
}

// robots.txt served for www.gov.uk — the real rules that touch paths (2026-11-09).
const GOVUK_ROBOTS = "User-agent: *\nDisallow: /*/print$\nDisallow: /search/all*\n";

/**
 * Stub HTTP client: serves `routes[url]` (404 HTML when absent) and records
 * every call (URL, extra headers, time) so tests can assert what was requested.
 */
function stubHttp(routes: Record<string, StubResponse>) {
  const calls: { url: string; headers?: Record<string, string>; at: number }[] = [];
  const client: VisaCatalogHttpClient = {
    async get(url, config) {
      calls.push({ url, headers: config?.headers, at: Date.now() });
      const r = routes[url] ?? { status: 404, body: "<html>not found</html>", contentType: "text/html" };
      return { status: r.status, data: r.body, headers: { "content-type": r.contentType ?? "" } };
    },
  };
  return { client, calls };
}

/** Fetch service over a stub, with no politeness delay (tests must not sleep). */
function serviceWith(routes: Record<string, StubResponse>, minIntervalMs = 0) {
  const { client, calls } = stubHttp(routes);
  return { service: new VisaCatalogFetchService({ http: client, minIntervalMs }), calls };
}

/** Routes for one GOV.UK page served from a fixture (plus robots.txt). */
function govukRoutes(pathname: string, f: StubResponse): Record<string, StubResponse> {
  return {
    "https://www.gov.uk/robots.txt": { status: 200, body: GOVUK_ROBOTS, contentType: "text/plain" },
    [`https://www.gov.uk/api/content${pathname}`]: f,
  };
}

/** A registry page for a GOV.UK route. */
function govukPage(pathname: string, extra: Partial<VisaSourcePage> = {}): VisaSourcePage {
  return {
    url: `https://www.gov.uk${pathname}`,
    routeName: "Test route",
    validation: "text_verified",
    ...extra,
  };
}

/** sha256 hex, independently of the service. */
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

// ----- generic-html: unchanged behaviour + identical hash -----

// A realistic page: boilerplate + a main region with > 200 chars of content.
const SAMPLE_HTML = `<!doctype html><html><head><title>Visa</title><script>var x=1</script></head>
<body><header>Site header</header><nav><a href="/">Home</a></nav>
<main><h1>Work visa</h1><p>You can apply for a work visa if you have a job offer from an approved
employer.   It lasts up to 5 years.</p><ul><li>Fee: 719 GBP</li><li>Decision within 3 weeks</li></ul>
<div>Extensions are possible.</div><p>${"More detail about eligibility. ".repeat(10)}</p></main>
<footer>Footer links</footer></body></html>`;

/**
 * The PRE-#58 htmlToCleanText, copied verbatim from the old fetch service, as
 * a golden reference: proves extracting the shared `blockText` helper did not
 * change the cleaned text (and so not the hash) by a single character.
 */
function legacyHtmlToCleanText(html: string): string {
  const BOILERPLATE = [
    "script", "style", "noscript", "svg", "iframe", "nav", "header", "footer", "aside", "form",
    "[role='navigation']", "[role='banner']", "[role='contentinfo']", ".cookie", ".cookies",
    ".breadcrumb", ".breadcrumbs", ".skip-link",
  ];
  const MAIN = ["main", "article", "[role='main']", "#content", ".content"];
  const $ = cheerio.load(html);
  $(BOILERPLATE.join(",")).remove();
  let root = $("body");
  for (const sel of MAIN) {
    const el = $(sel).first();
    if (el.length && el.text().trim().length > 200) {
      root = el as typeof root;
      break;
    }
  }
  root.find("p,h1,h2,h3,h4,h5,h6,li,br,div,section,article,tr,td,dt,dd").append("\n");
  const text = root
    .text()
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text.length > 24_000 ? text.slice(0, 24_000) : text;
}

describe("generic-html adapter", () => {
  const url = "https://immi.example.gov/work-visa";
  const routes = {
    "https://immi.example.gov/robots.txt": { status: 404, body: "" },
    [url]: { status: 200, body: SAMPLE_HTML, contentType: "text/html" },
  };

  // The deploy-safety guarantee: same HTML → same hash as fetchAndClean, so
  // stored lastContentHash values still match and non-GB pages don't re-extract.
  test("contentHash equals fetchAndClean's hash for the same HTML (and the pre-#58 text)", async () => {
    const a = serviceWith(routes);
    const viaFetch = await a.service.fetchAndClean(url, { checkRobots: true });
    const b = serviceWith(routes);
    const doc = await new GenericHtmlAdapter(b.service).fetch({
      url,
      routeName: "Work visa",
      validation: "text_verified",
    });
    assert.equal(doc.contentHash, viaFetch.contentHash);
    assert.equal(doc.text, viaFetch.cleanText);
    // Golden: identical to the old implementation, and the hash is sha256(text).
    assert.equal(doc.text, legacyHtmlToCleanText(SAMPLE_HTML));
    assert.equal(doc.contentHash, sha256(legacyHtmlToCleanText(SAMPLE_HTML)));
    // One section, generic provider, never withdrawn.
    assert.equal(doc.sections.length, 1);
    assert.equal(doc.sourceProvider, "generic-html");
    assert.equal(doc.withdrawn, false);
  });

  test("keeps the 24_000-char cap", () => {
    const big = `<html><body><main><p>${"x".repeat(30_000)}</p></main></body></html>`;
    const { service } = serviceWith({});
    assert.equal(MAX_CLEAN_TEXT_CHARS, 24_000);
    assert.equal(service.htmlToCleanText(big).length, 24_000);
    assert.equal(service.htmlToCleanText(big), legacyHtmlToCleanText(big));
  });

  test("keeps the 'Too little content' error", async () => {
    const { service } = serviceWith({ [url]: { status: 200, body: "<html><body><p>Hi</p></body></html>" } });
    await assert.rejects(
      new GenericHtmlAdapter(service).fetch({ url, routeName: "x", validation: "unverified" }),
      /Too little content/
    );
  });

  test("keeps the robots check", async () => {
    const { service, calls } = serviceWith({
      "https://immi.example.gov/robots.txt": { status: 200, body: "User-agent: *\nDisallow: /work\n" },
      [url]: { status: 200, body: SAMPLE_HTML },
    });
    await assert.rejects(
      new GenericHtmlAdapter(service).fetch({ url, routeName: "x", validation: "unverified" }),
      /Blocked by robots\.txt/
    );
    assert.ok(!calls.some((c) => c.url === url), "page must not be fetched when blocked");
  });
});

// ----- GOV.UK Content API adapter -----

describe("govuk-content-api adapter: request", () => {
  test("canHandle is true only for www.gov.uk", () => {
    const { service } = serviceWith({});
    const a = new GovukContentApiAdapter(service);
    assert.equal(a.canHandle("https://www.gov.uk/skilled-worker-visa"), true);
    assert.equal(a.canHandle("https://gov.uk/skilled-worker-visa"), false);
    assert.equal(a.canHandle("https://assets.publishing.service.gov.uk/x"), false);
    assert.equal(a.canHandle("https://www.canada.ca/en/immigration"), false);
    assert.equal(a.canHandle("not a url"), false);
  });

  test("API URL is /api/content + pathname (query/fragment dropped)", () => {
    assert.equal(
      govukContentApiUrl("https://www.gov.uk/skilled-worker-visa?x=1#top"),
      "https://www.gov.uk/api/content/skilled-worker-visa"
    );
    assert.equal(
      govukContentApiUrl("https://www.gov.uk/skilled-worker-visa/"),
      "https://www.gov.uk/api/content/skilled-worker-visa"
    );
  });

  test("checks robots, then GETs the API URL with Accept: application/json", async () => {
    const { service, calls } = serviceWith(
      govukRoutes("/graduate-visa", served(loadFixture("govuk-graduate-visa.json")))
    );
    await new GovukContentApiAdapter(service).fetch(govukPage("/graduate-visa?utm=1"));
    assert.deepEqual(
      calls.map((c) => c.url),
      ["https://www.gov.uk/robots.txt", "https://www.gov.uk/api/content/graduate-visa"]
    );
    assert.equal(calls[1].headers?.Accept, "application/json");
  });

  test("robots-blocked API path → error, no API request", async () => {
    const routes = govukRoutes("/graduate-visa", served(loadFixture("govuk-graduate-visa.json")));
    routes["https://www.gov.uk/robots.txt"] = {
      status: 200,
      body: "User-agent: *\nDisallow: /api/content\n",
    };
    const { service, calls } = serviceWith(routes);
    await assert.rejects(
      new GovukContentApiAdapter(service).fetch(govukPage("/graduate-visa")),
      /Blocked by robots\.txt/
    );
    assert.equal(calls.length, 1); // robots.txt only
  });

  // Politeness goes through the SHARED fetch service's per-host limiter.
  test("enforces the per-host minimum interval through the shared fetch service", async () => {
    const { service, calls } = serviceWith(
      govukRoutes("/graduate-visa", served(loadFixture("govuk-graduate-visa.json"))),
      120
    );
    await new GovukContentApiAdapter(service).fetch(govukPage("/graduate-visa"));
    assert.equal(calls.length, 2);
    // ≥ the interval (allow a few ms of timer slack).
    assert.ok(calls[1].at - calls[0].at >= 110, `gap was ${calls[1].at - calls[0].at}ms`);
  });
});

describe("govuk-content-api adapter: Skilled Worker fixture", () => {
  // Expected selection for the recorded 14-part guide (§3.2).
  const EXPECTED_INCLUDED = [
    "overview",
    "your-job",
    "when-you-can-be-paid-less",
    "if-you-work-in-healthcare-or-education",
    "knowledge-of-english",
    "how-much-it-costs",
    "documents-you-must-provide",
    "apply-from-outside-the-uk",
    "extend-your-visa",
  ];
  const EXPECTED_EXCLUDED = [
    "your-partner-and-children",
    "certificate-of-sponsorship-before-4-april-2024",
    "update-your-visa-if-you-change-job-or-employer",
    "switch-to-this-visa",
    "second-job",
  ];

  /** Fetch the Skilled Worker page from a (possibly modified) fixture. */
  async function fetchSkilledWorker(
    mutate?: (f: Fixture) => void,
    pageExtra: Partial<VisaSourcePage> = {}
  ): Promise<SourceDocument> {
    const f = loadFixture("govuk-skilled-worker-visa.json");
    mutate?.(f);
    const { service } = serviceWith(govukRoutes("/skilled-worker-visa", served(f)));
    return new GovukContentApiAdapter(service).fetch(govukPage("/skilled-worker-visa", pageExtra));
  }

  /** Parts of a fixture body, for mutation. */
  const partsOf = (f: Fixture) =>
    (f.body as { details: { parts: { slug: string; body: string }[] } }).details.parts;

  test("fixture records its source URL and date", () => {
    const f = loadFixture("govuk-skilled-worker-visa.json");
    assert.equal(f._fixture.sourceUrl, "https://www.gov.uk/api/content/skilled-worker-visa");
    assert.match(f._fixture.recordedAt, /^\d{4}-\d{2}-\d{2}$/);
  });

  test("selects the eligibility/fee/apply/extend/documents parts and drops the rest, in guide order", async () => {
    const doc = await fetchSkilledWorker();
    const slugs = doc.sections.map((s) => s.slug);
    assert.deepEqual(slugs, EXPECTED_INCLUDED);
    for (const ex of EXPECTED_EXCLUDED) assert.ok(!slugs.includes(ex), `${ex} must be excluded`);
  });

  test("returns content_id, updated_at, provider and not-withdrawn (live notice is {})", async () => {
    const doc = await fetchSkilledWorker();
    assert.equal(doc.sourceProvider, "govuk-content-api");
    assert.equal(doc.sourceDocumentId, "f9015c31-61c2-4504-8eb0-242cd75aee19");
    assert.equal(doc.sourceUpdatedAt, "2026-09-14T16:24:44+01:00");
    assert.equal(doc.canonicalUrl, "https://www.gov.uk/skilled-worker-visa");
    assert.equal(doc.withdrawn, false);
  });

  test("formats `## <title>` blocks, one per selected part, blank-line separated", async () => {
    const doc = await fetchSkilledWorker();
    assert.ok(doc.text.startsWith("## Overview\n"));
    const headings = doc.text.split("\n").filter((l) => l.startsWith("## "));
    assert.equal(headings.length, doc.sections.length);
    assert.deepEqual(headings, doc.sections.map((s) => `## ${s.title}`));
    // Blocks are separated by exactly one blank line.
    assert.equal(doc.text.split("\n\n## ").length, doc.sections.length);
    // Plain text, not HTML.
    assert.ok(!/<p>|<\/li>|<h2/.test(doc.text));
  });

  test("~36k chars: under the 40k cap, not truncated; hash is over the sent text", async () => {
    const doc = await fetchSkilledWorker();
    assert.equal(GOVUK_MAX_TEXT_CHARS, 40_000);
    assert.ok(doc.text.length > 30_000 && doc.text.length < 40_000, `length ${doc.text.length}`);
    assert.equal(doc.truncated, false);
    assert.equal(doc.contentHash, sha256(doc.text));
  });

  test("a change to a NON-selected part (dependants) keeps the hash; a selected part changes it", async () => {
    const base = await fetchSkilledWorker();
    const depsChanged = await fetchSkilledWorker((f) => {
      const p = partsOf(f).find((x) => x.slug === "your-partner-and-children")!;
      p.body += "<p>New dependant rule.</p>";
    });
    assert.equal(depsChanged.contentHash, base.contentHash);
    const feesChanged = await fetchSkilledWorker((f) => {
      const p = partsOf(f).find((x) => x.slug === "how-much-it-costs")!;
      p.body += "<p>New fee.</p>";
    });
    assert.notEqual(feesChanged.contentHash, base.contentHash);
  });

  test("page-level includeSections/excludeSections replace the defaults; exclude wins", async () => {
    const doc = await fetchSkilledWorker(undefined, {
      includeSections: ["overview", "your-*", "second-job"],
      excludeSections: ["your-partner-*"],
    });
    assert.deepEqual(
      doc.sections.map((s) => s.slug),
      ["overview", "your-job", "second-job"] // second-job: default exclude replaced
    );
  });

  test("null / absent updated_at leaves sourceUpdatedAt undefined", async () => {
    const nulled = await fetchSkilledWorker((f) => {
      (f.body as Record<string, unknown>).updated_at = null;
    });
    assert.equal(nulled.sourceUpdatedAt, undefined);
    const absent = await fetchSkilledWorker((f) => {
      delete (f.body as Record<string, unknown>).updated_at;
    });
    assert.equal(absent.sourceUpdatedAt, undefined);
  });
});

describe("govuk-content-api adapter: cap", () => {
  test("selected text over 40k is cut, flagged truncated and warned with the URL", async () => {
    const f = loadFixture("govuk-graduate-visa.json");
    // Synthetic: blow the overview past the cap.
    const parts = (f.body as { details: { parts: { slug: string; body: string }[] } }).details.parts;
    parts[0].body = `<p>${"Long overview sentence. ".repeat(2_500)}</p>`; // ~60k chars
    const { service } = serviceWith(govukRoutes("/graduate-visa", served(f)));
    const warn = mock.method(console, "warn", () => undefined);
    try {
      const doc = await new GovukContentApiAdapter(service).fetch(govukPage("/graduate-visa"));
      assert.equal(doc.truncated, true);
      assert.equal(doc.text.length, 40_000);
      assert.equal(doc.contentHash, sha256(doc.text));
      assert.equal(warn.mock.callCount(), 1);
      assert.match(String(warn.mock.calls[0].arguments[0]), /https:\/\/www\.gov\.uk\/graduate-visa/);
    } finally {
      warn.mock.restore();
    }
  });
});

describe("govuk-content-api adapter: failures (all throw → page error, no extraction)", () => {
  /** Expect the adapter to reject for a given served response. */
  async function expectFailure(resp: StubResponse, re: RegExp, extra: Partial<VisaSourcePage> = {}) {
    const { service } = serviceWith(govukRoutes("/graduate-visa", resp));
    await assert.rejects(new GovukContentApiAdapter(service).fetch(govukPage("/graduate-visa", extra)), re);
  }

  test("schema_name is not guide (recorded organisation page)", async () => {
    await expectFailure(served(loadFixture("govuk-non-guide-organisation.json")), /not a guide.*organisation/);
  });

  test("HTTP 404 (recorded HTML error page)", async () => {
    await expectFailure(served(loadFixture("govuk-404.json")), /HTTP 404/);
  });

  // 500 rather than 503: since issue #64 a 429/503 is a host backoff
  // (HostBackoffError, covered in visa-crawl-host-state.test.ts), not a plain
  // non-2xx failure.
  test("any other non-2xx", async () => {
    await expectFailure({ status: 500, body: "boom" }, /HTTP 500/);
  });

  test("non-JSON 200 body", async () => {
    await expectFailure({ status: 200, body: "<html>oops</html>" }, /non-JSON/);
  });

  test("details.parts missing or empty", async () => {
    const f = loadFixture("govuk-graduate-visa.json");
    const body = f.body as { details: { parts?: unknown } };
    body.details.parts = [];
    await expectFailure(served(f), /no details\.parts/);
    delete body.details.parts;
    await expectFailure(served(f), /no details\.parts/);
  });

  test("zero selected sections", async () => {
    await expectFailure(served(loadFixture("govuk-graduate-visa.json")), /No GOV\.UK guide parts selected/, {
      includeSections: ["no-such-part"],
    });
  });
});

describe("govuk-content-api adapter: withdrawn", () => {
  test("withdrawn_notice populated → withdrawn, no sections/text (derived fixture)", async () => {
    const f = loadFixture("govuk-graduate-visa-withdrawn.json");
    assert.match(f._fixture.notes, /DERIVED/);
    const { service } = serviceWith(govukRoutes("/graduate-visa", served(f)));
    const doc = await new GovukContentApiAdapter(service).fetch(govukPage("/graduate-visa"));
    assert.equal(doc.withdrawn, true);
    assert.deepEqual(doc.sections, []);
    assert.equal(doc.text, "");
    assert.equal(doc.sourceDocumentId, "1a06c4ea-fdb1-4a7b-baf5-3477714c974c");
  });

  test("isWithdrawnNotice: {} / null / absent are live; a populated notice is withdrawn", () => {
    assert.equal(isWithdrawnNotice({}), false);
    assert.equal(isWithdrawnNotice(null), false);
    assert.equal(isWithdrawnNotice(undefined), false);
    assert.equal(isWithdrawnNotice({ explanation: "", withdrawn_at: null }), false);
    assert.equal(isWithdrawnNotice({ explanation: "Closed", withdrawn_at: "2026-11-01" }), true);
  });

  // Issue #68: only a non-empty `withdrawn_at` STRING means withdrawn.
  test("isWithdrawnNotice keys on a non-empty withdrawn_at string only", () => {
    assert.equal(isWithdrawnNotice({ withdrawn_at: "2026-11-01T10:00:00Z" }), true);
    // explanation alone / another populated key → live (no false withdrawal)
    assert.equal(isWithdrawnNotice({ explanation: "Closed" }), false);
    assert.equal(isWithdrawnNotice({ something_new: "x" }), false);
    // empty / whitespace / non-string withdrawn_at → live
    assert.equal(isWithdrawnNotice({ explanation: "Closed", withdrawn_at: "" }), false);
    assert.equal(isWithdrawnNotice({ explanation: "Closed", withdrawn_at: "   " }), false);
    assert.equal(isWithdrawnNotice({ withdrawn_at: 1730000000 }), false);
    assert.equal(isWithdrawnNotice({ withdrawn_at: true }), false);
    // a non-object notice is never withdrawn
    assert.equal(isWithdrawnNotice("withdrawn"), false);
  });
});

// ----- Section patterns -----

describe("section patterns", () => {
  test("glob: `*` wildcard, whole-slug, case-insensitive", () => {
    assert.equal(slugMatches("update-your-visa-if-you-change-job", "update-your-visa-*"), true);
    assert.equal(slugMatches("Overview", "overview"), true);
    assert.equal(slugMatches("overview-extra", "overview"), false);
    assert.equal(slugMatches("x.y", "x.y"), true);
    assert.equal(slugMatches("xzy", "x.y"), false); // `.` is literal
    assert.equal(slugMatches("anything", " "), false);
  });

  test("defaults: exclude wins over include", () => {
    // `switch-to-this-visa` would never match an include, so check the rule directly.
    const picked = selectSections([{ slug: "apply-switch" }, { slug: "switch-apply" }], {
      include: ["apply-*", "switch-*"],
      exclude: DEFAULT_EXCLUDE_SECTIONS,
    });
    assert.deepEqual(picked.map((s) => s.slug), ["apply-switch"]);
    assert.ok(DEFAULT_INCLUDE_SECTIONS.includes("overview"));
  });
});

// ----- Adapter picking + provenance -----

describe("pickSourceAdapter", () => {
  const adapters = createSourceAdapters(serviceWith({}).service);
  test("absent adapter → generic-html", () => {
    assert.equal(pickSourceAdapter(undefined, "https://www.gov.uk/x", adapters).id, "generic-html");
  });
  test("govuk-content-api for a www.gov.uk page", () => {
    assert.equal(
      pickSourceAdapter("govuk-content-api", "https://www.gov.uk/x", adapters).id,
      "govuk-content-api"
    );
  });
  test("govuk-content-api falls back to generic-html for a URL it can't handle", () => {
    assert.equal(
      pickSourceAdapter("govuk-content-api", "https://example.gov/x", adapters).id,
      "generic-html"
    );
  });
});

describe("scrapeMeta provenance", () => {
  const extractedAt = Timestamp.fromMillis(1_700_000_000_000);
  const base = {
    sourceUrl: "https://www.gov.uk/skilled-worker-visa",
    routeName: "Skilled Worker visa",
    model: "deepseek-chat",
    contentHash: "abc",
    extracted: { confidence: 0.9, citations: { name: "Skilled Worker visa" } },
    extractedAt,
  };

  test("without sourceMeta → the pre-#58 shape exactly (old docs stay valid)", () => {
    assert.deepEqual(Object.keys(buildScrapeMeta(base)).sort(), [
      "citations",
      "confidence",
      "contentHash",
      "extractedAt",
      "model",
      "routeName",
      "sourceUrl",
    ]);
  });

  test("govuk document → provider, document id, updated_at, sectionsUsed, truncated", () => {
    const doc: SourceDocument = {
      url: base.sourceUrl,
      canonicalUrl: base.sourceUrl,
      sourceProvider: "govuk-content-api",
      sourceDocumentId: "f9015c31-61c2-4504-8eb0-242cd75aee19",
      sourceUpdatedAt: "2026-09-14T16:24:44+01:00",
      withdrawn: false,
      sections: [
        { slug: "overview", title: "Overview", text: "a" },
        { slug: "how-much-it-costs", title: "How much it costs", text: "b" },
      ],
      text: "## Overview\na",
      contentHash: "abc",
      truncated: false,
    };
    const meta = buildScrapeMeta({ ...base, sourceMeta: sourceMetaFromDocument(doc) });
    assert.equal(meta.sourceProvider, "govuk-content-api");
    assert.equal(meta.sourceDocumentId, "f9015c31-61c2-4504-8eb0-242cd75aee19");
    assert.equal(meta.sourceUpdatedAt, "2026-09-14T16:24:44+01:00");
    assert.deepEqual(meta.sectionsUsed, ["overview", "how-much-it-costs"]);
    assert.equal(meta.truncated, false);
  });

  test("generic-html → sourceProvider only, no sectionsUsed, no undefined keys", () => {
    const meta = sourceMetaFromDocument({
      url: "u",
      canonicalUrl: "u",
      sourceProvider: "generic-html",
      withdrawn: false,
      sections: [{ slug: "page", title: "t", text: "x" }],
      text: "x",
      contentHash: "h",
    });
    assert.deepEqual(meta, { sourceProvider: "generic-html" });
  });
});

// ----- Withdrawn update rule -----

describe("planWithdrawnUpdate", () => {
  const now = Timestamp.fromMillis(1_800_000_000_000);
  const earlier = Timestamp.fromMillis(1_700_000_000_000);

  test("approved, active scraped doc → deactivated with staleSince = now", () => {
    const plan = planWithdrawnUpdate({ source: "scraped", isActive: true }, now);
    assert.equal(plan.outcome, "deactivated");
    assert.deepEqual(plan.update, { isActive: false, staleSince: now, updatedAt: now });
  });

  test("staleSince is set once (an existing value is kept)", () => {
    const plan = planWithdrawnUpdate({ source: "scraped", isActive: true, staleSince: earlier }, now);
    assert.equal(plan.update?.staleSince, earlier);
  });

  test("already inactive + stale → no write", () => {
    const plan = planWithdrawnUpdate({ source: "scraped", isActive: false, staleSince: earlier }, now);
    assert.equal(plan.outcome, "already_inactive");
    assert.equal(plan.update, undefined);
  });

  test("seeded / agent doc is never modified", () => {
    for (const source of [undefined, "agent" as const]) {
      const plan = planWithdrawnUpdate({ source, isActive: true }, now);
      assert.equal(plan.outcome, "not_scraped");
      assert.equal(plan.update, undefined);
    }
  });

  test("missing doc → nothing created", () => {
    const plan = planWithdrawnUpdate(undefined, now);
    assert.equal(plan.outcome, "missing");
    assert.equal(plan.update, undefined);
  });

  // Issue #68: approval deletes staleSince (#62), so a re-approved doc that is
  // withdrawn again starts a new episode with a FRESH staleSince.
  test("second withdrawal after re-approval (staleSince cleared) → fresh staleSince = now", () => {
    const reApproved = { source: "scraped" as const, isActive: true, reviewStatus: "approved" as const };
    const plan = planWithdrawnUpdate(reApproved, now);
    assert.equal(plan.outcome, "deactivated");
    assert.equal(plan.update?.staleSince, now);
    assert.notEqual(plan.update?.staleSince, earlier);
  });
});

// ----- Withdrawn again while a restore awaits review (issue #68 review fix) -----

describe("planWithdrawnUpdate — restored doc withdrawn again before review", () => {
  const now = Timestamp.fromMillis(1_800_000_000_000);
  const stale = Timestamp.fromMillis(1_700_000_000_000);

  test("pending_review + restoredAt → back to approved (out of the queue), still inactive, staleSince kept", () => {
    const plan = planWithdrawnUpdate(
      { source: "scraped", reviewStatus: "pending_review", isActive: false, staleSince: stale, restoredAt: stale },
      now
    );
    assert.equal(plan.outcome, "unqueued");
    const u = plan.update as Record<string, unknown>;
    assert.equal(u.reviewStatus, "approved");
    assert.ok((u.restoredAt as FieldValue).isEqual(FieldValue.delete()));
    assert.equal(u.updatedAt, now);
    // never touches isActive / staleSince
    assert.equal("isActive" in u, false);
    assert.equal("staleSince" in u, false);
  });

  test("a NEVER-approved pending doc (no restoredAt) is not promoted to approved", () => {
    const plan = planWithdrawnUpdate(
      { source: "scraped", reviewStatus: "pending_review", isActive: false, staleSince: stale },
      now
    );
    assert.equal(plan.outcome, "already_inactive");
    assert.equal(plan.update, undefined);
  });
});

// ----- Restored-guide signal (issue #68) -----

describe("planRestoredUpdate", () => {
  const now = Timestamp.fromMillis(1_800_000_000_000);
  const stale = Timestamp.fromMillis(1_700_000_000_000);

  test("withdrawn (inactive + staleSince) approved scraped doc → pending_review, nothing else", () => {
    const plan = planRestoredUpdate({ source: "scraped", reviewStatus: "approved", isActive: false, staleSince: stale }, now);
    assert.equal(plan.outcome, "flagged");
    // Exactly the review status + updatedAt: no isActive (never reactivated),
    // no staleSince change (approval clears it).
    assert.deepEqual(plan.update, { reviewStatus: "pending_review", restoredAt: now, updatedAt: now });
  });

  test("no write for anything that is not a withdrawn approved scraped doc", () => {
    const cases: [string, Parameters<typeof planRestoredUpdate>[0]][] = [
      ["missing", undefined],
      ["live approved", { source: "scraped", reviewStatus: "approved", isActive: true }],
      ["active but staleSince (inconsistent)", { source: "scraped", reviewStatus: "approved", isActive: true, staleSince: stale }],
      ["inactive without staleSince", { source: "scraped", reviewStatus: "approved", isActive: false }],
      ["already pending", { source: "scraped", reviewStatus: "pending_review", isActive: false, staleSince: stale }],
      ["rejected stays rejected", { source: "scraped", reviewStatus: "rejected", isActive: false, staleSince: stale }],
      ["seeded", { source: undefined, reviewStatus: "approved", isActive: false, staleSince: stale }],
      ["agent", { source: "agent", reviewStatus: "approved", isActive: false, staleSince: stale }],
    ];
    for (const [label, existing] of cases) {
      const plan = planRestoredUpdate(existing, now);
      assert.equal(plan.outcome, "none", label);
      assert.equal(plan.update, undefined, label);
    }
  });
});

// ----- Registry seeding: adapter + section overrides -----

describe("buildSeededVisaSource (re-seed)", () => {
  const now = Timestamp.fromMillis(1_800_000_000_000);
  const gb: ParsedCountry = {
    countryCode: "GB",
    countryName: "United Kingdom",
    pages: [
      { url: "https://www.gov.uk/skilled-worker-visa", routeName: "Skilled Worker visa", validation: "text_verified" },
      { url: "https://www.gov.uk/uk-family-visa", routeName: "Family visa", validation: "text_verified" },
    ],
  };

  test("re-seeding a stored GB doc sets adapter and keeps lastContentHash", () => {
    const crawledAt = Timestamp.fromMillis(1_700_000_000_000);
    const existing = {
      // A stored doc from before #58: no adapter, crawled pages.
      pages: [
        {
          url: "https://www.gov.uk/skilled-worker-visa",
          routeName: "old",
          validation: "text_verified",
          lastContentHash: "hash-123",
          lastCrawledAt: crawledAt,
        },
      ],
      status: "active",
      consecutiveFailures: 2,
    };
    const { doc } = buildSeededVisaSource({ country: gb, existing, now });
    assert.equal(VISA_SOURCE_ADAPTERS.GB, "govuk-content-api");
    assert.equal(doc.adapter, "govuk-content-api");
    const pages = doc.pages as VisaSourcePage[];
    assert.equal(pages[0].lastContentHash, "hash-123");
    assert.equal(pages[0].lastCrawledAt, crawledAt);
    assert.equal(pages[0].visaId, "gb-skilled-worker-visa");
    assert.equal(doc.consecutiveFailures, 2); // source crawl state kept
  });

  test("section overrides come from VISA_SOURCE_OVERRIDES and are refreshed", () => {
    const existing = {
      pages: [
        {
          url: "https://www.gov.uk/uk-family-visa",
          routeName: "Family visa",
          validation: "text_verified",
          includeSections: ["stale-pattern"],
        },
      ],
    };
    const { doc } = buildSeededVisaSource({ country: gb, existing, now });
    const family = (doc.pages as VisaSourcePage[]).find((p) => p.url.endsWith("uk-family-visa"))!;
    assert.deepEqual(family.includeSections, VISA_SOURCE_OVERRIDES["https://www.gov.uk/uk-family-visa"].includeSections);
    const sw = (doc.pages as VisaSourcePage[]).find((p) => p.url.endsWith("skilled-worker-visa"))!;
    assert.equal("includeSections" in sw, false); // defaults apply, no key stored
  });

  test("a country not in VISA_SOURCE_ADAPTERS gets no adapter field (generic-html default)", () => {
    const { doc } = buildSeededVisaSource({
      country: { countryCode: "CA", countryName: "Canada", pages: [] },
      existing: { adapter: "govuk-content-api" },
      now,
    });
    assert.equal("adapter" in doc, false);
  });
});
