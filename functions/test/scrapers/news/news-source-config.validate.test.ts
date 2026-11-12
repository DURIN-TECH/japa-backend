// ============================================
// Unit tests — news source config validation (issue #17)
// ============================================
//
// Pure module (no Firestore, no network): scrapers/news/news-source-config.validate.ts.
// Every 400 of the issue's list is asserted with the field it names, plus the
// selector merge, strategy mismatches, the SSRF-style hosts and the complete-
// object validator (what #24 / #25 call).

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  applyNewsConfigEdit,
  newsEditableConfigOf,
  parseFeedUrl,
  parseNewsConfigEdit,
  validateNewsSourceObject,
  type NewsEditableConfig,
} from "../../../src/scrapers/news/news-source-config.validate";
import { SettingsValidationError, parseSourcePatch } from "../../../src/scrapers/shared/settings/scraper-settings.validate";
import { SUPPORTED_COUNTRY_CODES } from "../../../src/types/news";

/** Assert `fn` throws a SettingsValidationError naming `field`. */
function rejects(fn: () => unknown, field: string): void {
  assert.throws(fn, (e: unknown) => e instanceof SettingsValidationError && e.field === field, `expected a 400 on ${field}`);
}

const RSS: NewsEditableConfig = {
  strategy: "rss",
  scrapeIntervalMinutes: 120,
  priority: 2,
  countryCodes: ["GB"],
  feedUrl: "https://news.example.org/feed",
  maxArticlesPerRun: 15,
};
const HTML: NewsEditableConfig = {
  strategy: "html_scrape",
  scrapeIntervalMinutes: 240,
  priority: 1,
  countryCodes: ["CA"],
  selectors: { articleList: ".list", articleLink: "a", articleTitle: "h2" },
  maxArticlesPerRun: 10,
};
const API: NewsEditableConfig = { strategy: "news_api", scrapeIntervalMinutes: 360, priority: 3, countryCodes: ["AU"], maxArticlesPerRun: 20 };

describe("SUPPORTED_COUNTRY_CODES", () => {
  test("is the single list (CA/AU/IE/GB today)", () => {
    assert.deepEqual([...SUPPORTED_COUNTRY_CODES], ["CA", "AU", "IE", "GB"]);
  });
});

describe("parseNewsConfigEdit: field rules", () => {
  test("scrapeIntervalMinutes: integer 15..10080", () => {
    for (const bad of [14, 10_081, 30.5, "60", null, NaN]) rejects(() => parseNewsConfigEdit({ scrapeIntervalMinutes: bad }), "scrapeIntervalMinutes");
    assert.equal(parseNewsConfigEdit({ scrapeIntervalMinutes: 15 }).edit.scrapeIntervalMinutes, 15);
    assert.equal(parseNewsConfigEdit({ scrapeIntervalMinutes: 10_080 }).edit.scrapeIntervalMinutes, 10_080);
  });

  test("priority: integer 1..10", () => {
    for (const bad of [0, 11, 1.5, "2"]) rejects(() => parseNewsConfigEdit({ priority: bad }), "priority");
    assert.equal(parseNewsConfigEdit({ priority: 10 }).edit.priority, 10);
  });

  test("countryCodes: non-empty, no duplicates, supported only", () => {
    rejects(() => parseNewsConfigEdit({ countryCodes: [] }), "countryCodes");
    rejects(() => parseNewsConfigEdit({ countryCodes: "GB" }), "countryCodes");
    rejects(() => parseNewsConfigEdit({ countryCodes: ["GB", "GB"] }), "countryCodes");
    rejects(() => parseNewsConfigEdit({ countryCodes: ["US"] }), "countryCodes");
    rejects(() => parseNewsConfigEdit({ countryCodes: ["gb"] }), "countryCodes");
    assert.deepEqual(parseNewsConfigEdit({ countryCodes: ["GB", "IE"] }).edit.countryCodes, ["GB", "IE"]);
  });

  test("config.maxArticlesPerRun: integer 1..100", () => {
    for (const bad of [0, 101, 2.5, "10"]) rejects(() => parseNewsConfigEdit({ config: { maxArticlesPerRun: bad } }), "config.maxArticlesPerRun");
    assert.equal(parseNewsConfigEdit({ config: { maxArticlesPerRun: 100 } }).edit.config?.maxArticlesPerRun, 100);
  });

  test("config: object, known keys only, not empty", () => {
    rejects(() => parseNewsConfigEdit({ config: "x" }), "config");
    rejects(() => parseNewsConfigEdit({ config: {} }), "config");
    rejects(() => parseNewsConfigEdit({ config: { customHeaders: {} } }), "config.customHeaders");
    rejects(() => parseNewsConfigEdit({ config: { apiConfig: {} } }), "config.apiConfig");
    rejects(() => parseNewsConfigEdit({ config: { fetchFullContent: true } }), "config.fetchFullContent");
    rejects(() => parseNewsConfigEdit({ config: { selectors: { bogus: "a" } } }), "config.selectors.bogus");
    rejects(() => parseNewsConfigEdit({ config: { selectors: {} } }), "config.selectors");
  });

  test("strategy cannot be changed", () => {
    rejects(() => parseNewsConfigEdit({ strategy: "rss" }), "strategy");
    rejects(() => parseNewsConfigEdit({ strategy: "html_scrape", priority: 1 }, RSS), "strategy");
  });

  test("selectors: non-empty, bounded, must parse as CSS", () => {
    rejects(() => parseNewsConfigEdit({ config: { selectors: { articleList: "" } } }), "config.selectors.articleList");
    rejects(() => parseNewsConfigEdit({ config: { selectors: { articleList: "   " } } }), "config.selectors.articleList");
    rejects(() => parseNewsConfigEdit({ config: { selectors: { articleList: 5 } } }), "config.selectors.articleList");
    rejects(() => parseNewsConfigEdit({ config: { selectors: { articleTitle: "a".repeat(201) } } }), "config.selectors.articleTitle");
    rejects(() => parseNewsConfigEdit({ config: { selectors: { articleList: "div[" } } }), "config.selectors.articleList");
    rejects(() => parseNewsConfigEdit({ config: { selectors: { articleLink: "<script>" } } }), "config.selectors.articleLink");
    const ok = parseNewsConfigEdit({ config: { selectors: { articleTitle: " h2.title > a ", articleDate: "time[datetime]" } } });
    assert.deepEqual(ok.edit.config?.selectors, { articleTitle: "h2.title > a", articleDate: "time[datetime]" });
  });
});

describe("parseFeedUrl: SSRF-style hosts", () => {
  test("accepts a public http(s) URL", () => {
    assert.equal(parseFeedUrl("https://news.example.org/feed.xml"), "https://news.example.org/feed.xml");
    assert.equal(parseFeedUrl("http://news.example.org/feed"), "http://news.example.org/feed");
  });

  test("rejects non-URLs, other schemes, credentials", () => {
    for (const bad of ["", "not a url", "ftp://example.org/feed", "file:///etc/passwd", "javascript:alert(1)", "https://user:pw@example.org/feed", "https://user@example.org/feed", 5, null]) {
      rejects(() => parseFeedUrl(bad), "config.feedUrl");
    }
    rejects(() => parseFeedUrl("https://example.org/" + "a".repeat(2100)), "config.feedUrl");
  });

  test("rejects localhost, private / loopback / link-local IPs and metadata hosts", () => {
    const hosts = [
      "http://localhost/feed",
      "http://LOCALHOST:8080/feed",
      "http://foo.localhost/feed",
      "http://127.0.0.1/feed",
      "http://127.1/feed",
      "http://2130706433/feed", // decimal 127.0.0.1
      "http://0x7f000001/feed", // hex 127.0.0.1
      "http://0.0.0.0/feed",
      "http://10.0.0.5/feed",
      "http://172.16.0.1/feed",
      "http://172.31.255.255/feed",
      "http://192.168.1.1/feed",
      "http://169.254.169.254/latest/meta-data/",
      "http://100.64.0.1/feed",
      "http://[::1]/feed",
      "http://[fd00::1]/feed",
      "http://[fe80::1]/feed",
      "http://[::ffff:127.0.0.1]/feed",
      "http://metadata.google.internal/computeMetadata/v1/",
      "http://printer.local/feed",
      "http://db.internal/feed",
    ];
    for (const h of hosts) rejects(() => parseFeedUrl(h), "config.feedUrl");
  });

  test("allows public IPs and non-private 172.x", () => {
    assert.ok(parseFeedUrl("http://8.8.8.8/feed"));
    assert.ok(parseFeedUrl("http://172.32.0.1/feed"));
  });
});

describe("applyNewsConfigEdit: strategy rules and merging", () => {
  test("selectors are merged, not replaced", () => {
    const { next } = parseNewsConfigEdit({ config: { selectors: { articleTitle: "h3" } } }, HTML);
    assert.deepEqual(next?.selectors, { articleList: ".list", articleLink: "a", articleTitle: "h3" });
    // The stored object is not mutated.
    assert.equal(HTML.selectors?.articleTitle, "h2");
  });

  test("optional selectors can be added on top of the required three", () => {
    const { next } = parseNewsConfigEdit({ config: { selectors: { articleSummary: "p.sum" } } }, HTML);
    assert.equal(next?.selectors?.articleSummary, "p.sum");
    assert.equal(next?.selectors?.articleList, ".list");
  });

  test("feedUrl only for rss; selectors only for html_scrape; news_api takes neither", () => {
    rejects(() => parseNewsConfigEdit({ config: { feedUrl: "https://a.example.org/f" } }, HTML), "config.feedUrl");
    rejects(() => parseNewsConfigEdit({ config: { feedUrl: "https://a.example.org/f" } }, API), "config.feedUrl");
    rejects(() => parseNewsConfigEdit({ config: { selectors: { articleTitle: "h2" } } }, RSS), "config.selectors");
    rejects(() => parseNewsConfigEdit({ config: { selectors: { articleTitle: "h2" } } }, API), "config.selectors");
  });

  test("news_api accepts interval, priority, countryCodes, maxArticlesPerRun", () => {
    const { next } = parseNewsConfigEdit({ scrapeIntervalMinutes: 60, priority: 4, countryCodes: ["IE"], config: { maxArticlesPerRun: 5 } }, API);
    assert.deepEqual(next, { ...API, scrapeIntervalMinutes: 60, priority: 4, countryCodes: ["IE"], maxArticlesPerRun: 5 });
  });

  test("an rss source cannot be left without a feedUrl; html needs the three required selectors", () => {
    rejects(() => applyNewsConfigEdit({ ...RSS, feedUrl: undefined }, { priority: 3 }), "config.feedUrl");
    rejects(() => applyNewsConfigEdit({ ...HTML, selectors: { articleList: ".l", articleLink: "a" } }, { priority: 3 }), "config.selectors.articleTitle");
  });

  test("untouched fields are preserved", () => {
    const { next } = parseNewsConfigEdit({ priority: 5 }, RSS);
    assert.deepEqual(next, { ...RSS, priority: 5 });
  });
});

describe("validateNewsSourceObject (complete object, for #24 / #25)", () => {
  const good = {
    name: "Example News",
    slug: "example-news",
    url: "https://news.example.org/",
    strategy: "rss",
    scrapeIntervalMinutes: 240,
    priority: 2,
    countryCodes: ["GB"],
    config: { feedUrl: "https://news.example.org/feed", maxArticlesPerRun: 10 },
  };

  test("accepts a complete rss and html source", () => {
    assert.equal(validateNewsSourceObject(good).feedUrl, "https://news.example.org/feed");
    const html = validateNewsSourceObject({
      ...good,
      strategy: "html_scrape",
      config: { selectors: { articleList: ".l", articleLink: "a", articleTitle: "h2" }, maxArticlesPerRun: 10 },
    });
    assert.equal(html.selectors?.articleTitle, "h2");
  });

  test("names the field of each problem", () => {
    rejects(() => validateNewsSourceObject(null), "body");
    rejects(() => validateNewsSourceObject({ ...good, name: "" }), "name");
    rejects(() => validateNewsSourceObject({ ...good, slug: "Bad Slug" }), "slug");
    rejects(() => validateNewsSourceObject({ ...good, url: "http://localhost/" }), "url");
    rejects(() => validateNewsSourceObject({ ...good, strategy: "carrier_pigeon" }), "strategy");
    rejects(() => validateNewsSourceObject({ ...good, scrapeIntervalMinutes: 1 }), "scrapeIntervalMinutes");
    rejects(() => validateNewsSourceObject({ ...good, priority: undefined }), "priority");
    rejects(() => validateNewsSourceObject({ ...good, countryCodes: ["FR"] }), "countryCodes");
    rejects(() => validateNewsSourceObject({ ...good, config: { maxArticlesPerRun: 10 } }), "config.feedUrl");
    rejects(() => validateNewsSourceObject({ ...good, config: { feedUrl: "http://10.0.0.1/f", maxArticlesPerRun: 10 } }), "config.feedUrl");
    rejects(() => validateNewsSourceObject({ ...good, config: { feedUrl: good.config.feedUrl } }), "config.maxArticlesPerRun");
  });
});

describe("newsEditableConfigOf", () => {
  test("returns only the editable slice (never customHeaders / apiConfig)", () => {
    const slice = newsEditableConfigOf({
      strategy: "rss",
      scrapeIntervalMinutes: 120,
      priority: 2,
      countryCodes: ["GB"],
      config: { feedUrl: "https://a.example.org/f", maxArticlesPerRun: 9, customHeaders: { a: "b" }, apiConfig: { q: 1 }, fetchFullContent: true },
    });
    assert.deepEqual(slice, {
      strategy: "rss",
      scrapeIntervalMinutes: 120,
      priority: 2,
      countryCodes: ["GB"],
      maxArticlesPerRun: 9,
      feedUrl: "https://a.example.org/f",
    });
  });
});

describe("parseSourcePatch delegation", () => {
  test("news accepts the new keys alongside the old ones", () => {
    const p = parseSourcePatch("news", { status: "paused", reason: "r", priority: 3, config: { maxArticlesPerRun: 5 } });
    assert.equal(p.status, "paused");
    assert.equal(p.newsEdit?.priority, 3);
    assert.equal(p.newsEdit?.config?.maxArticlesPerRun, 5);
  });

  test("visa still rejects the news keys (400 naming the key)", () => {
    for (const key of ["scrapeIntervalMinutes", "priority", "countryCodes", "config"]) {
      rejects(() => parseSourcePatch("visa", { [key]: 1 }), key);
    }
  });

  test("news: unknown key and strategy are 400s naming the key", () => {
    rejects(() => parseSourcePatch("news", { bogus: 1 }), "bogus");
    rejects(() => parseSourcePatch("news", { strategy: "rss" }), "strategy");
  });
});

// ============================================
// Issue #159: shared classifier, normalised href, ports, trailing dots
// ============================================

describe("parseFeedUrl: address rules shared with the fetch guard (issue #159)", () => {
  test("returns the normalised href, and it re-parses to the host that was checked", () => {
    const stored = parseFeedUrl("  HTTPS://News.Example.ORG\\feed\t.xml ");
    assert.equal(stored, "https://news.example.org/feed.xml");
    assert.equal(new URL(stored).hostname, "news.example.org");
    assert.equal(parseFeedUrl("https://news.example.org"), "https://news.example.org/");
  });

  test("every trailing dot is stripped before the checks", () => {
    for (const h of ["http://localhost../", "http://localhost.../", "http://metadata.google.internal../", "http://127.0.0.1../", "http://foo.local../"]) {
      rejects(() => parseFeedUrl(h), "config.feedUrl");
    }
    assert.ok(parseFeedUrl("https://news.example.org../feed"));
  });

  test("single-label hosts are refused", () => {
    for (const h of ["http://intranet/", "http://corp/feed", "http://wiki./", "https://db01/"]) rejects(() => parseFeedUrl(h), "config.feedUrl");
  });

  test("IPv4 / IPv6 classes from the shared classifier are refused", () => {
    const refused = [
      "http://0.0.0.0/", "http://100.64.0.1/", "http://192.0.0.1/", "http://198.18.0.1/", "http://198.19.255.255/",
      "http://192.0.2.1/", "http://224.0.0.1/", "http://255.255.255.255/", "http://169.254.169.254/",
      "http://[::]/", "http://[::1]/", "http://[fc00::1]/", "http://[fe80::1]/", "http://[ff02::1]/",
      "http://[::ffff:8.8.8.8]/", "http://[::ffff:808:808]/", "http://[::8.8.8.8]/", "http://[64:ff9b::808:808]/",
      "http://[2002:808:808::]/", "http://[2001::1]/", "http://[2001:db8::1]/",
    ];
    for (const u of refused) rejects(() => parseFeedUrl(u), "config.feedUrl");
    for (const u of ["http://100.63.255.255/f", "http://198.20.0.1/f", "http://[2606:4700:4700::1111]/f"]) assert.ok(parseFeedUrl(u), u);
  });

  test("ports other than 80/443 are refused with their own message", () => {
    for (const u of ["https://news.example.org:8443/f", "http://news.example.org:8080/f", "http://news.example.org:22/f"]) {
      assert.throws(
        () => parseFeedUrl(u),
        (e: unknown) => e instanceof SettingsValidationError && e.field === "config.feedUrl" && /default port/.test(e.message)
      );
    }
    assert.ok(parseFeedUrl("https://news.example.org:443/f"));
    assert.ok(parseFeedUrl("http://news.example.org:80/f"));
  });

  test("stays literal-only: a name is never resolved at write time", () => {
    // Would be refused at fetch time if it resolved to an internal address; accepted here.
    assert.ok(parseFeedUrl("https://does-not-resolve.example.org/feed"));
  });
});
