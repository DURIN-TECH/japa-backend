// ============================================
// EU law reader (issue #261) — unit tests, no network
// ============================================
//
// Covers the publications.europa.eu CELEX route of
// VisaCatalogFetchService.fetchAndClean() with an injected HTTP client and a
// small recorded sample (fixtures/eu-law-consolidated-sample.xhtml, cut down
// from the real consolidated Visa Code, 02009R0810-20240628).

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  HtmlTextTooLongError,
  MAX_CLEAN_TEXT_CHARS,
  VisaCatalogFetchService,
  type VisaCatalogHttpClient,
} from "../../../../src/scrapers/shared/fetch/visa-catalog-fetch.service";
import {
  EU_LAW_MAX_TEXT_CHARS,
  isAcceptableEuLawFinalUrl,
  isEuLawCelexUrl,
  stripConsolidationMarkers,
} from "../../../../src/scrapers/shared/fetch/eu-law";
import { DEFAULT_PDF_LIMITS, normalizeForQuoteMatch } from "../../../../src/scrapers/shared/fetch/pdf-text";
import { findPassage } from "../../../../src/scrapers/guidance/guidance-quote-check";
import { sameDocumentUrl } from "../../../../src/scrapers/guidance/guidance-crawl.service";

const SAMPLE = readFileSync(path.join(__dirname, "fixtures", "eu-law-consolidated-sample.xhtml"), "utf8");
const REQUESTED = "https://publications.europa.eu/resource/celex/02009R0810-20240628";
const CELLAR = "http://publications.europa.eu/resource/cellar/2356e285-9098-11ef-a130-01aa75ed71a1.0007.03/DOC_1";

interface Call {
  url: string;
  headers?: Record<string, string>;
  redirectHostCheck?: (h: string) => boolean;
}

/** Stub client: robots.txt is a 404; every other request gets `reply`. */
function stub(reply: { status?: number; body?: string; responseUrl?: string }): { http: VisaCatalogHttpClient; calls: Call[] } {
  const calls: Call[] = [];
  const http: VisaCatalogHttpClient = {
    async get(url, config) {
      calls.push({ url, headers: config?.headers, redirectHostCheck: config?.redirectHostCheck });
      if (url.endsWith("/robots.txt")) return { status: 404, data: "" };
      return {
        status: reply.status ?? 200,
        data: reply.body ?? SAMPLE,
        headers: { "content-type": "application/xhtml+xml" },
        request: { res: { responseUrl: reply.responseUrl ?? CELLAR } },
      };
    },
  };
  return { http, calls };
}

describe("EU law address", () => {
  test("only CELEX addresses on publications.europa.eu take the route", () => {
    assert.equal(isEuLawCelexUrl(REQUESTED), true);
    assert.equal(isEuLawCelexUrl("http://publications.europa.eu/resource/celex/32009R0810"), true);
    assert.equal(isEuLawCelexUrl("https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:02009R0810-20240628"), false);
    assert.equal(isEuLawCelexUrl("https://publications.europa.eu/resource/celex/"), false);
    assert.equal(isEuLawCelexUrl("https://publications.europa.eu/other"), false);
    assert.equal(isEuLawCelexUrl("https://example.org/resource/celex/32009R0810"), false);
    assert.equal(isEuLawCelexUrl("not a url"), false);
  });

  test("final address must be the document on the same host", () => {
    assert.equal(isAcceptableEuLawFinalUrl(REQUESTED, CELLAR), true);
    assert.equal(isAcceptableEuLawFinalUrl(REQUESTED, "https://eur-lex.europa.eu/"), false);
    assert.equal(isAcceptableEuLawFinalUrl(REQUESTED, "https://publications.europa.eu/"), false);
    assert.equal(isAcceptableEuLawFinalUrl(REQUESTED, REQUESTED), true);
  });

  test("the long cap equals the PDF text cap", () => {
    assert.equal(EU_LAW_MAX_TEXT_CHARS, DEFAULT_PDF_LIMITS.maxTextChars);
  });
});

describe("fetchAndClean on a CELEX address", () => {
  test("sends both headers, follows the redirect, records both addresses", async () => {
    const { http, calls } = stub({});
    const svc = new VisaCatalogFetchService({ http, minIntervalMs: 0 });
    const page = await svc.fetchAndClean(REQUESTED, { checkRobots: true });
    const pageCall = calls.find((c) => c.url === REQUESTED)!;
    assert.equal(pageCall.headers?.Accept, "application/xhtml+xml");
    assert.equal(pageCall.headers?.["Accept-Language"], "eng");
    // Redirects may only stay on publications.europa.eu.
    assert.equal(pageCall.redirectHostCheck?.("publications.europa.eu"), true);
    assert.equal(pageCall.redirectHostCheck?.("eur-lex.europa.eu"), false);
    assert.equal(page.url, REQUESTED);
    assert.equal(page.finalUrl, CELLAR);
    assert.equal(page.httpStatus, 200);
    // The guidance crawl's redirect baseline is bypassed for this form only:
    assert.equal(sameDocumentUrl(REQUESTED, CELLAR), false);
  });

  test("text is complete: articles present, markers stripped", async () => {
    const svc = new VisaCatalogFetchService({ http: stub({}).http, minIntervalMs: 0 });
    const { cleanText } = await svc.fetchAndClean(REQUESTED);
    assert.match(cleanText, /sole destination of the visit\(s\)/);
    assert.match(cleanText, /Applicants shall pay a visa fee of EUR 90\./);
    assert.match(cleanText, /The visa fee shall be reviewed regularly\./);
    assert.doesNotMatch(cleanText, /[▼►◄]/);
    // Amending-act title lines are kept: only the tokens go.
    assert.match(cleanText, /REGULATION \(EU\) 2019\/1155/);
    // A true quote still passes the guidance quote check on the stored text.
    const hit = findPassage({ text: cleanText, pages: null }, "Article 16 Visa fee 1. Applicants shall pay a visa fee of EUR 90.");
    assert.equal(hit.found, true);
    assert.ok(normalizeForQuoteMatch(cleanText).includes("Visa fee 1. Applicants"));
  });

  test("a long text is not cut at the 24,000-character page cap", async () => {
    const para = "<p>" + "The applicant shall provide the documents listed. ".repeat(20) + "</p>";
    const body = `<html><body>${para.repeat(60)}</body></html>`; // ~60k chars
    const svc = new VisaCatalogFetchService({ http: stub({ body }).http, minIntervalMs: 0 });
    const { cleanText } = await svc.fetchAndClean(REQUESTED);
    assert.ok(cleanText.length > MAX_CLEAN_TEXT_CHARS * 2);
  });

  test("a text over the cap fails instead of being cut", async () => {
    const svc = new VisaCatalogFetchService({ http: stub({}).http, minIntervalMs: 0 });
    await assert.rejects(svc.fetchAndClean(REQUESTED, { maxHtmlTextChars: 200 }), (e) => e instanceof HtmlTextTooLongError);
  });

  test("an ordinary page keeps the 24,000 cap and its ordinary headers", async () => {
    const { http, calls } = stub({ body: `<html><body><p>${"word ".repeat(10_000)}</p></body></html>`, responseUrl: "https://example.org/p" });
    const svc = new VisaCatalogFetchService({ http, minIntervalMs: 0 });
    const page = await svc.fetchAndClean("https://example.org/p");
    assert.equal(page.cleanText.length, MAX_CLEAN_TEXT_CHARS);
    assert.equal(calls[0].headers, undefined);
  });

  test("a 404 is reported in plain words", async () => {
    const svc = new VisaCatalogFetchService({ http: stub({ status: 404, body: "Not Found" }).http, minIntervalMs: 0 });
    await assert.rejects(svc.fetchAndClean(REQUESTED), (e: Error) => {
      assert.match(e.message, /no English document/);
      assert.match(e.message, /CELEX number/);
      assert.match(e.message, /\(HTTP 404\)/); // keeps the crawl's http_error classification
      return true;
    });
  });

  test("a redirect away from the document is refused", async () => {
    const svc = new VisaCatalogFetchService({ http: stub({ responseUrl: "https://eur-lex.europa.eu/" }).http, minIntervalMs: 0 });
    await assert.rejects(svc.fetchAndClean(REQUESTED), /Unexpected redirect/);
  });
});

describe("stripConsolidationMarkers", () => {
  test("removes marker tokens and keeps other text", () => {
    assert.equal(stripConsolidationMarkers("Visa fee\n▼M7\n1. Applicants"), "Visa fee\n\n1. Applicants");
    assert.equal(stripConsolidationMarkers("a ►M5 inserted words ◄ b"), "a inserted words b");
    assert.equal(stripConsolidationMarkers("▼B text ▼C1 more"), "text more");
  });
  test("does not eat a word glued to a triangle", () => {
    assert.equal(stripConsolidationMarkers("►Bold claim"), "►Bold claim");
  });
});
