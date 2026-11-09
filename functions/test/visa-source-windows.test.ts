// ============================================
// Unit tests — seeded weekly night windows (issue #63)
// ============================================
//
// Run with `npm test`. Pure: seed-visa-sources.ts resolves Firestore lazily,
// and buildSeededVisaSource is I/O-free, so no emulator / network.
//
// Covers:
//  - VISA_SOURCE_WINDOWS covers exactly the 26 COUNTRY_CODES, every window
//    valid (real IANA zone) with startHour 2 / endHour 5 (user decision on
//    #63), every night 1-7 has >= 3 countries, GB = Europe/London Monday
//  - buildSeededVisaSource: crawlWindow written; a re-seed refreshes it from
//    code and keeps nextCrawlAt / status / health; a brand-new country's
//    nextCrawlAt is its next window opening, not `now`

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";

import {
  COUNTRY_CODES,
  VISA_SOURCE_WINDOWS,
  buildSeededVisaSource,
} from "../src/data/seed-visa-sources";
import { assertValidCrawlWindow } from "../src/services/visa-crawl-window";

/** The 26 ISO codes the registry seeds (values of COUNTRY_CODES). */
const SEEDED_CODES = Object.values(COUNTRY_CODES);

describe("VISA_SOURCE_WINDOWS", () => {
  test("covers exactly the 26 seeded countries (none missing, none extra)", () => {
    assert.equal(SEEDED_CODES.length, 26);
    assert.deepEqual(Object.keys(VISA_SOURCE_WINDOWS).sort(), [...SEEDED_CODES].sort());
    for (const cc of SEEDED_CODES) assert.ok(VISA_SOURCE_WINDOWS[cc], `${cc} has no window`);
  });

  test("every window is valid: real IANA zone, 02:00-05:00 local", () => {
    for (const [cc, w] of Object.entries(VISA_SOURCE_WINDOWS)) {
      assert.doesNotThrow(() => assertValidCrawlWindow(w), `${cc}`);
      // Intl.DateTimeFormat accepts the zone (throws RangeError otherwise).
      assert.doesNotThrow(() => new Intl.DateTimeFormat("en-US", { timeZone: w.timeZone }), `${cc}`);
      assert.equal(w.startHour, 2, `${cc} startHour`);
      assert.equal(w.endHour, 5, `${cc} endHour`);
    }
  });

  test("spread: every night 1-7 has at least 3 countries", () => {
    const perNight = new Map<number, number>();
    for (const w of Object.values(VISA_SOURCE_WINDOWS)) perNight.set(w.dayOfWeek, (perNight.get(w.dayOfWeek) ?? 0) + 1);
    for (let d = 1; d <= 7; d++) assert.ok((perNight.get(d) ?? 0) >= 3, `night ${d}: ${perNight.get(d) ?? 0}`);
  });

  test("GB = Europe/London, Monday", () => {
    assert.deepEqual(VISA_SOURCE_WINDOWS.GB, {
      timeZone: "Europe/London",
      dayOfWeek: 1,
      startHour: 2,
      endHour: 5,
    });
  });
});

describe("buildSeededVisaSource — crawlWindow + nextCrawlAt", () => {
  const country = {
    countryCode: "GB",
    countryName: "United Kingdom",
    pages: [{ url: "https://www.gov.uk/standard-visitor", routeName: "Visitor", validation: "text_verified" as const }],
  };
  // Seed time: Sunday 2026-11-08 15:00 GMT.
  const now = Timestamp.fromMillis(Date.parse("2026-11-08T15:00:00Z"));

  test("a brand-new country gets crawlWindow and nextCrawlAt = its next window opening (not now)", () => {
    const { doc } = buildSeededVisaSource({ country, existing: undefined, now });
    assert.deepEqual(doc.crawlWindow, VISA_SOURCE_WINDOWS.GB);
    // Next Mon 02:00 London after Sun 15:00 = Mon 2026-11-09 02:00 GMT.
    assert.equal((doc.nextCrawlAt as Timestamp).toDate().toISOString(), "2026-11-09T02:00:00.000Z");
    assert.notEqual((doc.nextCrawlAt as Timestamp).toMillis(), now.toMillis());
    assert.equal(doc.status, "active");
    assert.equal(doc.crawlIntervalHours, 168); // kept for window-less sources
  });

  test("a re-seed refreshes crawlWindow from code and keeps nextCrawlAt / status / health", () => {
    const storedNext = Timestamp.fromMillis(Date.parse("2026-01-05T09:00:00Z")); // old, in the past
    const existing = {
      // Stale window in the stored doc: must be replaced by the code's.
      crawlWindow: { timeZone: "UTC", dayOfWeek: 3, startHour: 3, endHour: 6 },
      nextCrawlAt: storedNext,
      lastCrawledAt: Timestamp.fromMillis(Date.parse("2025-12-29T09:00:00Z")),
      status: "paused",
      reliabilityScore: 42,
      consecutiveFailures: 2,
      createdAt: Timestamp.fromMillis(Date.parse("2025-06-01T00:00:00Z")),
      pages: [],
    };
    const { doc } = buildSeededVisaSource({ country, existing, now });
    assert.deepEqual(doc.crawlWindow, VISA_SOURCE_WINDOWS.GB); // refreshed from code
    assert.equal((doc.nextCrawlAt as Timestamp).toMillis(), storedNext.toMillis()); // preserved
    assert.equal(doc.status, "paused");
    assert.equal(doc.reliabilityScore, 42);
    assert.equal(doc.consecutiveFailures, 2);
  });

  test("a country with no window: no crawlWindow field, due now (legacy)", () => {
    const { doc } = buildSeededVisaSource({ country, existing: undefined, now, windows: {} });
    assert.equal("crawlWindow" in doc, false);
    assert.equal((doc.nextCrawlAt as Timestamp).toMillis(), now.toMillis());
  });

  test("an invalid window in the map fails the seed loudly", () => {
    assert.throws(
      () =>
        buildSeededVisaSource({
          country,
          existing: undefined,
          now,
          windows: { GB: { timeZone: "Europe/London", dayOfWeek: 1, startHour: 5, endHour: 3 } },
        }),
      /Invalid crawl window/
    );
  });
});
