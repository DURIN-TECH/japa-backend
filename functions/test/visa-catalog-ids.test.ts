// ============================================
// Unit tests — visa record identity + registry pins + crawl-state merge
// ============================================
//
// Run with `npm test` (node:test via tsx). No Firestore / emulator needed: the
// modules under test are importable without Firebase Admin init.
//
// Covers issue #57's acceptance criteria for id/code resolution, the GB
// override map, and the re-seed crawl-state merge.

import { test, describe, TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

import {
  VISA_ID_SLUG_MAX,
  applyVisaSourcePins,
  deriveVisaId,
  mergePageCrawlState,
  pickSourceCrawlState,
  resolveVisaCode,
} from "../src/services/visa-catalog-ids";
import {
  KR_TEMPORARY_VISIT_URL,
  VISA_SOURCE_OVERRIDES,
  findVisaSourcesMarkdown,
  parseVisaSourcesMarkdown,
} from "../src/data/seed-visa-sources";
import type { VisaSourcePage } from "../src/types/visa-catalog";

// ----- deriveVisaId: pinned + path-derived ids -----

describe("deriveVisaId", () => {
  // A pinned id is the registry's decision and is returned untouched.
  test("uses a pinned visaId verbatim", () => {
    assert.equal(
      deriveVisaId({
        countryCode: "GB",
        sourceUrl: "https://www.gov.uk/some-renamed-page",
        visaId: "gb-skilled-worker-visa",
      }),
      "gb-skilled-worker-visa"
    );
  });

  // Blank pin = no pin (never an empty doc id).
  test("ignores a blank pinned visaId", () => {
    assert.equal(
      deriveVisaId({ countryCode: "GB", sourceUrl: "https://www.gov.uk/graduate-visa", visaId: "  " }),
      "gb-graduate-visa"
    );
  });

  // Fallback: `${cc lowercased}-${slug(full path)}`.
  test("derives `${cc}-${slug(path)}` lowercased and hyphenated", () => {
    assert.equal(
      deriveVisaId({ countryCode: "GB", sourceUrl: "https://www.gov.uk/Skilled_Worker-Visa" }),
      "gb-skilled-worker-visa"
    );
  });

  // The FULL path is used, so deep paths sharing a last segment don't collide.
  test("uses the FULL path: same last segment, different ids", () => {
    const a = deriveVisaId({ countryCode: "CA", sourceUrl: "https://x.gov/work/visa" });
    const b = deriveVisaId({ countryCode: "CA", sourceUrl: "https://x.gov/study/visa" });
    assert.equal(a, "ca-work-visa");
    assert.equal(b, "ca-study-visa");
    assert.notEqual(a, b);
  });

  // Trailing slash, query and fragment don't change identity.
  test("ignores trailing slash, query string and fragment", () => {
    const base = deriveVisaId({ countryCode: "CA", sourceUrl: "https://x.gov/a/b-visa" });
    assert.equal(base, "ca-a-b-visa");
    for (const url of [
      "https://x.gov/a/b-visa/",
      "https://x.gov/a/b-visa?x=1",
      "https://x.gov/a/b-visa#top",
      "https://x.gov/a/b-visa/?x=1#top",
    ]) {
      assert.equal(deriveVisaId({ countryCode: "CA", sourceUrl: url }), base, url);
    }
  });

  // No id is invented for a site root or garbage URL.
  test("throws on an empty path", () => {
    assert.throws(
      () => deriveVisaId({ countryCode: "CA", sourceUrl: "https://x.gov/" }),
      /empty path/
    );
    assert.throws(
      () => deriveVisaId({ countryCode: "CA", sourceUrl: "https://x.gov" }),
      /empty path/
    );
  });

  test("throws on an unparseable URL", () => {
    assert.throws(
      () => deriveVisaId({ countryCode: "CA", sourceUrl: "not a url" }),
      /unparseable/
    );
  });

  // Over-length slugs are truncated with a 6-hex hash of the full path.
  test("truncates an over-length slug and appends a hash suffix", () => {
    const longPath = "/" + "segment-".repeat(20) + "end"; // slug > 80 chars
    const id = deriveVisaId({ countryCode: "DE", sourceUrl: `https://x.gov${longPath}` });
    const slugPart = id.slice("de-".length);
    assert.ok(slugPart.length <= VISA_ID_SLUG_MAX, `slug too long: ${slugPart.length}`);
    assert.match(id, /^de-[a-z0-9-]+-[0-9a-f]{6}$/);
    // Deterministic.
    assert.equal(deriveVisaId({ countryCode: "DE", sourceUrl: `https://x.gov${longPath}/` }), id);
  });

  test("two long paths sharing a prefix get different ids", () => {
    const prefix = "/" + "very-long-shared-prefix-".repeat(5);
    const a = deriveVisaId({ countryCode: "DE", sourceUrl: `https://x.gov${prefix}work-visa` });
    const b = deriveVisaId({ countryCode: "DE", sourceUrl: `https://x.gov${prefix}study-visa` });
    assert.notEqual(a, b);
  });
});

// ----- Id resolution BEFORE extraction (review finding 1) -----
//
// The crawlers resolve the id from the registry page alone, before fetching or
// calling the LLM, then hand that id to ingestExtraction, which uses it
// verbatim. These tests pin the two properties that makes safe.

describe("id resolution before extraction", () => {
  // Only registry-page inputs are needed: no ExtractedVisa exists yet.
  test("resolves from the registry page alone (no extraction output)", () => {
    const page: Pick<VisaSourcePage, "url" | "visaId"> = {
      url: "https://www.gov.uk/graduate-visa",
    };
    assert.equal(
      deriveVisaId({ countryCode: "GB", sourceUrl: page.url, visaId: page.visaId }),
      "gb-graduate-visa"
    );
  });

  // Real registry entry with no path: fails up front, so the crawl records a
  // page error instead of spending an LLM call on a page it can't store.
  test("KR root URL with only a query string throws before extraction", () => {
    assert.throws(
      () => deriveVisaId({ countryCode: "KR", sourceUrl: "https://www.visa.go.kr/?LANG_TYPE=EN" }),
      /empty path/
    );
  });

  // ingest re-runs buildVisaId with the caller's resolved id as the "pin";
  // that must return it unchanged so the two never disagree.
  test("a resolved id passed back in is returned unchanged (idempotent)", () => {
    for (const sourceUrl of [
      "https://www.gov.uk/student-visa",
      "https://x.gov/" + "deep-path-".repeat(12) + "visa", // hash-suffixed case
    ]) {
      const resolved = deriveVisaId({ countryCode: "GB", sourceUrl });
      assert.equal(deriveVisaId({ countryCode: "GB", sourceUrl, visaId: resolved }), resolved);
    }
  });
});

// ----- resolveVisaCode -----

describe("resolveVisaCode", () => {
  test("a pinned visaCode overrides the extracted code", () => {
    assert.equal(resolveVisaCode("SWV", "SKILLED_WORKER"), "SWV");
  });
  test("without a pin the extracted code is used", () => {
    assert.equal(resolveVisaCode(undefined, "SKILLED_WORKER"), "SKILLED_WORKER");
    assert.equal(resolveVisaCode("", "SKILLED_WORKER"), "SKILLED_WORKER");
  });
});

// ----- The GB override map vs. the real markdown and the seeds -----

describe("VISA_SOURCE_OVERRIDES", () => {
  // The verified-links markdown lives at the meta-repo root; the seed finds it
  // by walking up. In a standalone seli-backend checkout (e.g. PR CI) it is
  // absent, so the two markdown-backed tests SKIP with a reason instead of
  // failing. Set SELI_REQUIRE_SOURCES_MD=1 to make a missing file a hard
  // failure (e.g. when running from the meta-repo and you want the check).
  const markdownPath = findVisaSourcesMarkdown(path.resolve(__dirname, "../src/data"));
  const requireMarkdown = process.env.SELI_REQUIRE_SOURCES_MD === "1";
  const MISSING_MD = "official_visa_links_verified_v3.md not found above functions/";
  // Shared guard: returns true (after marking the test skipped) when the test
  // should not run. Fails instead when SELI_REQUIRE_SOURCES_MD=1.
  const skipWithoutMarkdown = (t: TestContext): boolean => {
    if (markdownPath) return false;
    assert.ok(!requireMarkdown, `${MISSING_MD} (SELI_REQUIRE_SOURCES_MD=1)`);
    t.skip(`${MISSING_MD}: meta-repo markdown not available (CI)`);
    return true;
  };
  const parsed = () => parseVisaSourcesMarkdown(fs.readFileSync(markdownPath as string, "utf8"));

  // The map also holds non-GB pins (KR since issue #67), so the GB-specific
  // checks below look only at the GOV.UK keys.
  const gbKeys = () =>
    Object.keys(VISA_SOURCE_OVERRIDES).filter((u) => u.startsWith("https://www.gov.uk/"));
  // Countries that are allowed to have pins at all (GB + KR). Any other
  // country's page picking up a pin means a map key collided with its URL.
  const PINNED_COUNTRIES = new Set(["GB", "KR"]);

  // Exactly the 12 ids (and 4 codes) the issue specifies.
  test("has exactly the 12 specified GB pins and 4 codes", () => {
    const expected: Record<string, [string, string?]> = {
      "/standard-visitor": ["gb-standard-visitor", "SVV"],
      "/skilled-worker-visa": ["gb-skilled-worker-visa", "SWV"],
      "/student-visa": ["gb-student-visa", "TIER4"],
      "/uk-family-visa": ["gb-uk-family-visa", "FAM"],
      "/health-care-worker-visa": ["gb-health-care-worker-visa"],
      "/child-study-visa": ["gb-child-study-visa"],
      "/graduate-visa": ["gb-graduate-visa"],
      "/global-talent": ["gb-global-talent"],
      "/high-potential-individual-visa": ["gb-high-potential-individual-visa"],
      "/youth-mobility": ["gb-youth-mobility"],
      "/india-young-professionals-scheme-visa": ["gb-india-young-professionals-scheme-visa"],
      "/british-national-overseas-bno-visa": ["gb-british-national-overseas-bno-visa"],
    };
    const keys = gbKeys();
    assert.equal(keys.length, 12);
    for (const [p, [visaId, visaCode]] of Object.entries(expected)) {
      const pin = VISA_SOURCE_OVERRIDES[`https://www.gov.uk${p}`];
      assert.ok(pin, `missing pin for ${p}`);
      assert.equal(pin.visaId, visaId);
      assert.equal(pin.visaCode, visaCode);
    }
  });

  // Each pin equals today's path-derived id, as the issue requires.
  test("each pinned id equals the path-derived id", () => {
    for (const url of gbKeys()) {
      const pin = VISA_SOURCE_OVERRIDES[url];
      assert.equal(deriveVisaId({ countryCode: "GB", sourceUrl: url }), pin.visaId, url);
    }
  });

  // Fails if a URL is edited in the markdown (or the map) so a pin would drop.
  test("covers every GB URL in the markdown, and only those", (t) => {
    if (skipWithoutMarkdown(t)) return;
    const gb = parsed().find((c) => c.countryCode === "GB");
    assert.ok(gb, "no United Kingdom section in the markdown");
    const gbUrls = gb.pages.map((p) => p.url).sort();
    assert.deepEqual(gbUrls, gbKeys().sort());
  });

  // After applying the map: every GB page pinned, and no country outside
  // PINNED_COUNTRIES touched. (KR is allowed but not required to be pinned
  // here, so this test holds both before and after the KR markdown row is
  // switched to KR_TEMPORARY_VISIT_URL — see the "South Korea pin" block.)
  test("applying the map pins all GB pages and no unpinned country's", (t) => {
    if (skipWithoutMarkdown(t)) return;
    for (const c of parsed()) {
      const { pages } = applyVisaSourcePins(c.pages, VISA_SOURCE_OVERRIDES);
      for (const p of pages) {
        if (c.countryCode === "GB") assert.ok(p.visaId, `GB page unpinned: ${p.url}`);
        else if (!PINNED_COUNTRIES.has(c.countryCode)) {
          assert.equal(p.visaId, undefined, `${c.countryCode} page pinned: ${p.url}`);
        }
      }
    }
  });

  // Scraped ids must never land on a seeded doc. The seed list isn't exported
  // (and its module needs Firebase init), so read its `id: "…"` literals.
  test("GB pinned ids are disjoint from the ids in seed-countries-visas.ts", () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, "../src/data/seed-countries-visas.ts"),
      "utf8"
    );
    const seededIds = new Set([...src.matchAll(/\bid:\s*"([^"]+)"/g)].map((m) => m[1]));
    // Sanity: the known UK seeds are picked up, so the regex is working.
    for (const id of ["uk-skilled-worker", "uk-student", "uk-visitor", "uk-family"]) {
      assert.ok(seededIds.has(id), `expected seeded id ${id}`);
    }
    for (const pin of Object.values(VISA_SOURCE_OVERRIDES)) {
      assert.ok(!seededIds.has(pin.visaId), `pinned id collides with a seed: ${pin.visaId}`);
      assert.ok(!pin.visaId.startsWith("uk-"), `pinned id in the seeded uk-* namespace: ${pin.visaId}`);
    }
  });
});

// ----- South Korea pin (issue #67) -----
//
// The KR row used to be the visa.go.kr home page, whose empty path made
// deriveVisaId() throw before any fetch. These tests pin down the fix: the
// replacement HiKorea route page resolves to its own `kr-*` id.
//
// The markdown itself lives in the meta-repo, so the end-to-end check below
// parses an inline copy of the KR section exactly as it should read there
// (same table shape, same URL string as the map key).

describe("South Korea pin (issue #67)", () => {
  // The KR section as it reads in official_visa_links_verified_v3.md after
  // the fix (one row, the HiKorea short-term visit route).
  const KR_SECTION = [
    "## 23. South Korea",
    "",
    "| Visa / route | Official link | Validation | Useful information confirmed |",
    "|---|---|---:|---|",
    `| Temporary Visit (C-3) — tourism, transit, events and conferences | ${KR_TEMPORARY_VISIT_URL} | TEXT-VERIFIED | HiKorea page. |`,
  ].join("\n");

  test("the old visa.go.kr home page cannot derive an id (the bug)", () => {
    // Documents why the row had to change: "/" is an empty path.
    assert.throws(
      () => deriveVisaId({ countryCode: "KR", sourceUrl: "https://www.visa.go.kr/?LANG_TYPE=EN" }),
      /empty path/
    );
  });

  test("the KR page is pinned to kr-temporary-visit-c-3", () => {
    const pin = VISA_SOURCE_OVERRIDES[KR_TEMPORARY_VISIT_URL];
    assert.ok(pin, "no pin for the KR page");
    assert.equal(pin.visaId, "kr-temporary-visit-c-3");
    // No seeded KR equivalent, so no code override.
    assert.equal(pin.visaCode, undefined);
  });

  test("parsing the KR row + applying pins resolves the page to its kr-* id", () => {
    const [kr] = parseVisaSourcesMarkdown(KR_SECTION);
    assert.equal(kr.countryCode, "KR");
    assert.equal(kr.pages.length, 1);
    // The parser keeps the full URL, query string included, so it matches the key.
    assert.equal(kr.pages[0].url, KR_TEMPORARY_VISIT_URL);
    assert.equal(kr.pages[0].validation, "text_verified");

    const { pages, matchedUrls } = applyVisaSourcePins(kr.pages, VISA_SOURCE_OVERRIDES);
    assert.ok(matchedUrls.has(KR_TEMPORARY_VISIT_URL), "pin not matched (seed would warn)");
    // Same call the crawl makes before fetching: no throw, pinned id wins.
    const id = deriveVisaId({
      countryCode: kr.countryCode,
      sourceUrl: pages[0].url,
      visaId: pages[0].visaId,
    });
    assert.equal(id, "kr-temporary-visit-c-3");
    assert.match(id, /^kr-/);
  });

  test("without the pin, every HiKorea guide page would collapse onto one id", () => {
    // Why the pin matters even though the path is non-empty: the query
    // (CAT_SEQ/PARENT_ID) is dropped, so Study and Tourism derive the same id.
    const tourism = deriveVisaId({ countryCode: "KR", sourceUrl: KR_TEMPORARY_VISIT_URL });
    const study = deriveVisaId({
      countryCode: "KR",
      sourceUrl: "https://www.hikorea.go.kr/info/InfoDatail.pt?CAT_SEQ=526&PARENT_ID=1275&locale=en",
    });
    assert.equal(tourism, "kr-info-infodatail-pt");
    assert.equal(study, tourism);
  });
});

// ----- applyVisaSourcePins -----

describe("applyVisaSourcePins", () => {
  test("reports which override URLs matched (unmatched ones get warned on)", () => {
    const pages: VisaSourcePage[] = [
      { url: "https://a.gov/x", routeName: "X", validation: "text_verified" },
    ];
    const { pages: out, matchedUrls } = applyVisaSourcePins(pages, {
      "https://a.gov/x": { visaId: "aa-x" },
      "https://a.gov/gone": { visaId: "aa-gone" },
    });
    assert.equal(out[0].visaId, "aa-x");
    assert.equal("visaCode" in out[0], false); // no code pin -> field absent
    assert.deepEqual([...matchedUrls], ["https://a.gov/x"]);
    assert.equal(pages[0].visaId, undefined); // input not mutated
  });
});

// ----- mergePageCrawlState / pickSourceCrawlState (re-seed) -----

describe("mergePageCrawlState", () => {
  // Stand-in for a Firestore Timestamp; the merge copies values opaquely.
  const ts = { seconds: 1, nanoseconds: 0 } as unknown as VisaSourcePage["lastCrawledAt"];

  test("keeps crawl state by URL, drops removed pages, adds new pages bare", () => {
    const existing: VisaSourcePage[] = [
      {
        url: "https://a.gov/kept",
        routeName: "Old label",
        validation: "unverified",
        lastContentHash: "abc",
        lastCrawledAt: ts,
        lastExtractedAt: ts,
        lastError: "timeout",
      },
      { url: "https://a.gov/removed", routeName: "R", validation: "text_verified", lastContentHash: "zzz" },
    ];
    const fresh: VisaSourcePage[] = [
      { url: "https://a.gov/kept", routeName: "New label", validation: "text_verified", visaId: "aa-kept" },
      { url: "https://a.gov/new", routeName: "N", validation: "text_verified" },
    ];
    const merged = mergePageCrawlState(fresh, existing);

    assert.equal(merged.length, 2); // removed page is gone
    // Seed-owned fields come from the fresh page (incl. the new pin)…
    assert.equal(merged[0].routeName, "New label");
    assert.equal(merged[0].validation, "text_verified");
    assert.equal(merged[0].visaId, "aa-kept");
    // …crawler-owned fields from the stored page with the same URL.
    assert.equal(merged[0].lastContentHash, "abc");
    assert.equal(merged[0].lastCrawledAt, ts);
    assert.equal(merged[0].lastExtractedAt, ts);
    assert.equal(merged[0].lastError, "timeout");
    // New page: no crawl state.
    assert.deepEqual(merged[1], fresh[1]);
  });

  test("no existing doc -> pages unchanged", () => {
    const fresh: VisaSourcePage[] = [{ url: "https://a.gov/x", routeName: "X", validation: "text_verified" }];
    assert.deepEqual(mergePageCrawlState(fresh, undefined), fresh);
  });

  test("merging is idempotent (re-seed twice = same pages)", () => {
    const fresh: VisaSourcePage[] = [{ url: "https://a.gov/x", routeName: "X", validation: "text_verified" }];
    const stored = [{ ...fresh[0], lastContentHash: "h", lastCrawledAt: ts }];
    const once = mergePageCrawlState(fresh, stored);
    const twice = mergePageCrawlState(fresh, once);
    assert.deepEqual(twice, once);
  });
});

describe("pickSourceCrawlState", () => {
  test("keeps only the scheduler/health fields present on the existing doc", () => {
    const existing = {
      createdAt: "c",
      nextCrawlAt: "n",
      lastCrawledAt: "l",
      status: "paused",
      reliabilityScore: 80,
      consecutiveFailures: 2,
      updatedAt: "u", // refreshed by the seed, not kept
      pages: [], // rebuilt by the seed, not kept
      countryName: "X", // seed-owned, not kept
    };
    assert.deepEqual(pickSourceCrawlState(existing), {
      createdAt: "c",
      nextCrawlAt: "n",
      lastCrawledAt: "l",
      status: "paused",
      reliabilityScore: 80,
      consecutiveFailures: 2,
    });
  });

  test("brand-new country -> {} so defaults apply", () => {
    assert.deepEqual(pickSourceCrawlState(undefined), {});
  });

  // Issue #64: a re-seed must not drop a host's retry-after time, or the next
  // crawl would hit a host that asked us to wait.
  test("keeps stored hostBackoffs", () => {
    const hostBackoffs = [{ host: "www.gov.uk", until: "u", status: 429, recordedAt: "r" }];
    assert.deepEqual(pickSourceCrawlState({ status: "active", hostBackoffs }), { status: "active", hostBackoffs });
  });
});
