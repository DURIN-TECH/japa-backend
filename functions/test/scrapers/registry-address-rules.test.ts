// ============================================
// Registry x address rules (issue #159)
// ============================================
//
// Every URL in the news, guidance and visa-catalog source registries must pass
// the write-time rules (https/http, dotted public name or public literal,
// ports 80/443, no credentials). LITERAL checks only: no DNS and no network.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseFeedUrl } from "../../src/scrapers/news/news-source-config.validate";
import { NEWS_SOURCES } from "../../src/scrapers/news/seed-news-sources";
import { GUIDANCE_SOURCE_SEEDS } from "../../src/scrapers/guidance/data/seed-guidance-sources";
import {
  VISA_SOURCE_OVERRIDES,
  parseVisaSourcesMarkdown,
  vendoredVisaSourcesMarkdownPath,
} from "../../src/scrapers/visa-catalog/data/seed-visa-sources";

/** Collect the offenders so one failure lists every bad URL. */
function refusedUrls(urls: string[]): string[] {
  return urls.filter((u) => {
    try {
      parseFeedUrl(u, "url");
      return false;
    } catch {
      return true;
    }
  });
}

describe("source registries pass the address rules", () => {
  test("news registry: every source url and feedUrl", () => {
    const urls = NEWS_SOURCES.flatMap((s) => [s.url, s.config.feedUrl].filter((u): u is string => typeof u === "string"));
    assert.ok(urls.length > 0);
    assert.deepEqual(refusedUrls(urls), []);
  });

  test("guidance registry: every source url", () => {
    const urls = GUIDANCE_SOURCE_SEEDS.map((s) => s.url);
    assert.ok(urls.length > 0);
    assert.deepEqual(refusedUrls(urls), []);
  });

  test("visa catalog registry: every page in the vendored list, and every pinned override", () => {
    const countries = parseVisaSourcesMarkdown(readFileSync(vendoredVisaSourcesMarkdownPath(), "utf8"));
    const urls = [...countries.flatMap((c) => c.pages.map((p) => p.url)), ...Object.keys(VISA_SOURCE_OVERRIDES)];
    assert.ok(urls.length > 10);
    assert.deepEqual(refusedUrls(urls), []);
  });
});
