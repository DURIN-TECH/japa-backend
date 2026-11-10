// ============================================
// Unit tests — weekly night crawl window helpers (issue #63)
// ============================================
//
// Run with `npm test`. Pure: scrapers/shared/etiquette/visa-crawl-window.ts has no Firebase
// imports, so no emulator / network. Every instant is a fixed UTC ISO string;
// the comment beside each gives the local wall time it represents.
//
// Covers nextWindowOpening edge cases (before / exactly at / inside / after
// the window, DST both ways, spring-forward gap, fall-back overlap, non-DST
// zones, a zone whose local weekday differs from UTC), isInCrawlWindow in
// GMT and BST, and assertValidCrawlWindow rejections.

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import type { CrawlWindow } from "../../../../src/scrapers/visa-catalog/types";
import {
  assertValidCrawlWindow,
  isInCrawlWindow,
  nextWindowOpening,
} from "../../../../src/scrapers/shared/etiquette/visa-crawl-window";

/** Window builder: 02:00-05:00 local (the seeded hours) unless overridden. */
const win = (timeZone: string, dayOfWeek: number, over: Partial<CrawlWindow> = {}): CrawlWindow => ({
  timeZone,
  dayOfWeek,
  startHour: 2,
  endHour: 5,
  ...over,
});

/** nextWindowOpening as an ISO string, for readable assertions. */
const next = (w: CrawlWindow, iso: string) => nextWindowOpening(w, Date.parse(iso)).toISOString();

const GB = win("Europe/London", 1); // Monday 02:00-05:00 London

describe("nextWindowOpening — position relative to the window", () => {
  test("before the window on the right day → today's opening", () => {
    assert.equal(next(GB, "2026-11-09T01:30:00Z"), "2026-11-09T02:00:00.000Z"); // Mon 01:30 GMT
  });

  test("exactly at the opening → next week (strictly after now)", () => {
    assert.equal(next(GB, "2026-11-09T02:00:00Z"), "2026-11-16T02:00:00.000Z");
  });

  test("inside the window (the 02:15 first run) → next week", () => {
    assert.equal(next(GB, "2026-11-09T02:15:00Z"), "2026-11-16T02:00:00.000Z");
  });

  test("after the window, same day → next week", () => {
    assert.equal(next(GB, "2026-11-09T05:15:00Z"), "2026-11-16T02:00:00.000Z");
  });

  test("a different weekday → the coming Monday", () => {
    assert.equal(next(GB, "2026-11-08T15:15:00Z"), "2026-11-09T02:00:00.000Z"); // Sun afternoon
    assert.equal(next(GB, "2026-11-11T12:00:00Z"), "2026-11-16T02:00:00.000Z"); // Wed
  });

  test("accepts a Date as well as epoch millis", () => {
    assert.equal(
      nextWindowOpening(GB, new Date("2026-11-09T02:15:00Z")).toISOString(),
      "2026-11-16T02:00:00.000Z"
    );
  });
});

describe("nextWindowOpening — DST (Europe/London)", () => {
  test("into BST: Mon 2026-03-23 02:15 GMT → Mon 2026-03-30 02:00 BST (01:00Z)", () => {
    assert.equal(next(GB, "2026-03-23T02:15:00Z"), "2026-03-30T01:00:00.000Z");
  });

  test("into GMT: Mon 2026-10-19 02:15 BST (01:15Z) → Mon 2026-10-26 02:00 GMT (02:00Z)", () => {
    assert.equal(next(GB, "2026-10-19T01:15:00Z"), "2026-10-26T02:00:00.000Z");
  });

  test("the Mon 02:15 tick is in window in both BST and GMT", () => {
    assert.equal(isInCrawlWindow(GB, Date.parse("2026-06-15T01:15:00Z")), true); // 02:15 BST
    assert.equal(isInCrawlWindow(GB, Date.parse("2026-11-09T02:15:00Z")), true); // 02:15 GMT
    // ... and the same UTC hour on the other side of the change is not 02:15 local
    assert.equal(isInCrawlWindow(GB, Date.parse("2026-06-15T00:15:00Z")), false); // 01:15 BST
  });

  test("nonexistent local opening (spring-forward gap) → first valid instant after it", () => {
    // Berlin skips 02:00-03:00 on Sun 2026-03-29 (CET → CEST at 01:00Z): an
    // 02:00 opening that day resolves to the jump itself, 03:00 CEST = 01:00Z.
    const berlinSun = win("Europe/Berlin", 7);
    assert.equal(next(berlinSun, "2026-03-28T12:00:00Z"), "2026-03-29T01:00:00.000Z");
    // London skips 01:00-02:00 the same day: 01:30 → 02:00 BST = 01:00Z.
    const londonSunEarly = win("Europe/London", 7, { startHour: 1 });
    assert.equal(next(londonSunEarly, "2026-03-28T12:00:00Z"), "2026-03-29T01:00:00.000Z");
  });

  test("repeated local opening (fall-back overlap) → first occurrence", () => {
    // London's 01:00-02:00 happens twice on Sun 2026-10-25: 01:00 BST (00:00Z)
    // then 01:00 GMT (01:00Z). The first one wins.
    const londonSunEarly = win("Europe/London", 7, { startHour: 1 });
    assert.equal(next(londonSunEarly, "2026-10-24T12:00:00Z"), "2026-10-25T00:00:00.000Z");
  });
});

describe("nextWindowOpening — non-DST zones and weekday offsets", () => {
  test("Asia/Singapore: same UTC hour year-round (02:00 SGT = 18:00Z the day before)", () => {
    const sg = win("Asia/Singapore", 7); // Sunday
    assert.equal(next(sg, "2026-01-01T00:00:00Z"), "2026-01-03T18:00:00.000Z"); // Sun 4 Jan 02:00 SGT
    assert.equal(next(sg, "2026-07-01T00:00:00Z"), "2026-07-04T18:00:00.000Z"); // Sun 5 Jul 02:00 SGT
  });

  test("Asia/Dubai: same UTC hour year-round (02:00 GST = 22:00Z the day before)", () => {
    const ae = win("Asia/Dubai", 4); // Thursday
    assert.equal(next(ae, "2026-01-01T00:00:00Z"), "2026-01-07T22:00:00.000Z"); // Thu 8 Jan
    assert.equal(next(ae, "2026-07-01T00:00:00Z"), "2026-07-01T22:00:00.000Z"); // Thu 2 Jul
  });

  test("Pacific/Auckland: Sat 02:00 local is a Friday in UTC", () => {
    const nz = win("Pacific/Auckland", 6);
    // NZDT (+13) in November: Sat 14 Nov 02:00 = Fri 13 Nov 13:00Z.
    assert.equal(next(nz, "2026-11-09T00:00:00Z"), "2026-11-13T13:00:00.000Z");
    // NZST (+12) in July: Sat 11 Jul 02:00 = Fri 10 Jul 14:00Z.
    assert.equal(next(nz, "2026-07-06T00:00:00Z"), "2026-07-10T14:00:00.000Z");
    // The Sat 02:15 local tick (Fri 13:15Z) is in window; Fri 02:15Z is not.
    assert.equal(isInCrawlWindow(nz, Date.parse("2026-11-13T13:15:00Z")), true);
    assert.equal(isInCrawlWindow(nz, Date.parse("2026-11-13T02:15:00Z")), false);
  });
});

describe("isInCrawlWindow — boundaries", () => {
  test("start hour inclusive, end hour exclusive, other weekdays out", () => {
    assert.equal(isInCrawlWindow(GB, Date.parse("2026-11-09T01:59:59Z")), false);
    assert.equal(isInCrawlWindow(GB, Date.parse("2026-11-09T02:00:00Z")), true);
    assert.equal(isInCrawlWindow(GB, Date.parse("2026-11-09T04:15:00Z")), true); // last catch-up
    assert.equal(isInCrawlWindow(GB, Date.parse("2026-11-09T05:00:00Z")), false);
    assert.equal(isInCrawlWindow(GB, Date.parse("2026-11-10T02:15:00Z")), false); // Tuesday
  });

  test("endHour 24 covers the rest of the day", () => {
    const allDay = win("UTC", 1, { startHour: 0, endHour: 24 });
    assert.equal(isInCrawlWindow(allDay, Date.parse("2026-11-09T23:59:00Z")), true);
    assert.equal(isInCrawlWindow(allDay, Date.parse("2026-11-10T00:00:00Z")), false);
  });
});

describe("assertValidCrawlWindow — invalid windows throw", () => {
  const now = Date.parse("2026-11-09T02:15:00Z");
  const cases: [string, CrawlWindow][] = [
    ["startHour >= endHour", win("Europe/London", 1, { startHour: 5, endHour: 5 })],
    ["startHour > endHour", win("Europe/London", 1, { startHour: 6, endHour: 3 })],
    ["endHour > 24", win("Europe/London", 1, { endHour: 25 })],
    ["startHour < 0", win("Europe/London", 1, { startHour: -1 })],
    ["non-integer hour", win("Europe/London", 1, { startHour: 2.5 })],
    ["dayOfWeek 0", win("Europe/London", 0)],
    ["dayOfWeek 8", win("Europe/London", 8)],
    ["unknown zone", win("Mars/Olympus", 1)],
    ["empty zone", win("", 1)],
  ];
  for (const [name, w] of cases) {
    test(name, () => {
      assert.throws(() => assertValidCrawlWindow(w), /Invalid crawl window/);
      assert.throws(() => nextWindowOpening(w, now), /Invalid crawl window/);
      assert.throws(() => isInCrawlWindow(w, now), /Invalid crawl window/);
    });
  }

  test("a valid window passes", () => {
    assert.doesNotThrow(() => assertValidCrawlWindow(GB));
  });
});
