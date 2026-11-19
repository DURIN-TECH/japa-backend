import * as fs from "fs";
import * as path from "path";

import {
  VisaCatalogFetchService,
  htmlFragmentToText,
  type VisaCatalogHttpClient,
} from "../../shared/fetch/visa-catalog-fetch.service";
import { govukContentApiUrl } from "../adapters";
import { GOLDEN_DIR } from "./config";
import type { ExpectedVisa } from "./score";

// ============================================
// VISA EXTRACTION EVAL — GOLDEN SET FILES (issue #60)
// ============================================
//
// Reading the golden set from disk and serving it back to the REAL adapter:
//
//   src/scrapers/visa-catalog/eval/golden/<route>/guide.json     recorded GOV.UK Content API response,
//                                      same envelope as test/scrapers/visa-catalog/fixtures/govuk-*.json
//   src/scrapers/visa-catalog/eval/golden/<route>/expected.json  hand-verified expected values, each with
//                                      a verbatim `source` quote from guide.json
//
// Also the "fixture text" helpers used by the quote-substring unit test and by
// `eval:record`'s diff. No network, no Firebase.

// ----- Fixture envelope -----

/** Provenance block every recorded fixture carries. */
export interface FixtureMeta {
  sourceUrl: string; // the Content API URL that was fetched
  recordedAt: string; // YYYY-MM-DD the response was recorded
  recordedBy: string; // UA + Accept header used (our bot identity)
  notes?: string; // how the body was trimmed, etc.
}

/** One guide part as recorded (`body` is HTML). */
export interface GuidePart {
  slug: string;
  title: string;
  body: string;
}

/** The recorded Content API item (only the fields the adapter reads, plus identity). */
export interface GuideBody {
  content_id?: string;
  base_path?: string;
  title?: string;
  schema_name?: string;
  document_type?: string;
  locale?: string;
  updated_at?: string | null;
  public_updated_at?: string | null;
  withdrawn_notice?: unknown;
  details?: { parts?: GuidePart[] };
}

/** A recorded fixture: envelope + status + content type + JSON body. */
export interface GuideFixture {
  _fixture: FixtureMeta;
  status: number;
  contentType: string;
  body: GuideBody;
}

// ----- Paths + loading -----

/** src/scrapers/visa-catalog/eval/golden/<route>/guide.json */
export function guidePath(route: string, goldenDir: string = GOLDEN_DIR): string {
  return path.join(goldenDir, route, "guide.json");
}

/** src/scrapers/visa-catalog/eval/golden/<route>/expected.json */
export function expectedPath(route: string, goldenDir: string = GOLDEN_DIR): string {
  return path.join(goldenDir, route, "expected.json");
}

/** Load a route's recorded guide fixture (throws when missing / not JSON). */
export function loadGuide(route: string, goldenDir: string = GOLDEN_DIR): GuideFixture {
  return JSON.parse(fs.readFileSync(guidePath(route, goldenDir), "utf8")) as GuideFixture;
}

/** Load a route's expected values (throws when missing / not JSON). */
export function loadExpected(route: string, goldenDir: string = GOLDEN_DIR): ExpectedVisa {
  return JSON.parse(fs.readFileSync(expectedPath(route, goldenDir), "utf8")) as ExpectedVisa;
}

// ----- Fixture text (what a `source` quote must be a substring of) -----

/**
 * Plain text of EVERY part of a guide, formatted like the adapter formats
 * selected sections (`## <title>\n<text>`, blank line between parts), using
 * the same HTML-to-text conversion (htmlFragmentToText). A `source` quote in
 * expected.json must be a substring of this (after whitespace normalisation),
 * so every expected value is traceable to the page text.
 */
export function guidePlainText(body: GuideBody): string {
  const parts = body.details?.parts ?? [];
  return parts.map((p) => `## ${p.title.trim()}\n${htmlFragmentToText(p.body)}`).join("\n\n");
}

/**
 * Normalise text for quote matching: curly quotes/apostrophes → straight,
 * dashes → "-", non-breaking spaces → space, runs of whitespace → one space.
 * Case is KEPT (quotes are verbatim).
 */
export function normalizeQuoteText(s: string): string {
  return s
    .replace(/[\u2018\u2019\u201B\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201F\u2033]/g, "\"")
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** True when `quote` occurs in `text` (both normalised with normalizeQuoteText). */
export function quoteInText(quote: string, text: string): boolean {
  const q = normalizeQuoteText(quote);
  return q.length > 0 && normalizeQuoteText(text).includes(q);
}

// ----- Stub fetch service (serves a fixture to the REAL adapter) -----

// robots.txt served for www.gov.uk — the real rules that touch paths
// (same as test/scrapers/visa-catalog/adapters/visa-source-adapters.test.ts, recorded 2026-11-09).
const GOVUK_ROBOTS = "User-agent: *\nDisallow: /*/print$\nDisallow: /search/all*\n";

/**
 * A VisaCatalogFetchService whose HTTP client serves `fixture` for the page's
 * Content API URL (plus robots.txt) and 404s everything else — so the REAL
 * GovukContentApiAdapter runs its real robots check, parsing, section
 * selection, formatting and cap with NO network call. No politeness delay
 * (minIntervalMs 0): nothing leaves the process.
 *
 * Mirrors stubHttp() in test/scrapers/visa-catalog/adapters/visa-source-adapters.test.ts.
 */
export function fixtureFetchService(pageUrl: string, fixture: GuideFixture): VisaCatalogFetchService {
  const routes: Record<string, { status: number; body: string; contentType: string }> = {
    "https://www.gov.uk/robots.txt": { status: 200, body: GOVUK_ROBOTS, contentType: "text/plain" },
    [govukContentApiUrl(pageUrl)]: {
      status: fixture.status,
      body: JSON.stringify(fixture.body),
      contentType: fixture.contentType,
    },
  };
  const client: VisaCatalogHttpClient = {
    async get(url) {
      const r = routes[url] ?? { status: 404, body: "<html>not found</html>", contentType: "text/html" };
      return { status: r.status, data: r.body, headers: { "content-type": r.contentType } };
    },
  };
  return new VisaCatalogFetchService({ http: client, minIntervalMs: 0 });
}
