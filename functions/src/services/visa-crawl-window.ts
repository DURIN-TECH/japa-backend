import type { CrawlWindow } from "../types/visa-catalog";

// ============================================
// VISA CATALOG — WEEKLY NIGHT CRAWL WINDOW (issue #63)
// ============================================
//
// Pure helpers (NO Firebase imports) that answer two questions for a source's
// `crawlWindow` ({ timeZone, dayOfWeek, startHour, endHour }):
//
//   isInCrawlWindow(window, now)   — is `now` inside the window, in local time?
//   nextWindowOpening(window, now) — the next instant, STRICTLY after `now`,
//                                    at which the window opens (local
//                                    `dayOfWeek` at `startHour`:00).
//
// Local time is derived with `Intl.DateTimeFormat` (no date library), so DST
// is handled by the runtime's tz database:
//  - a local opening that does not exist (spring-forward gap) resolves to the
//    first valid instant after it (the moment the clocks jump);
//  - a local opening that occurs twice (fall-back overlap) resolves to the
//    FIRST occurrence.
//
// Used by visaCatalogCrawlService.runOrchestrator (filter + reschedule) and by
// seed-visa-sources.ts (first `nextCrawlAt` of a brand-new country).

/** One hour / day in milliseconds. */
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** How many local days ahead nextWindowOpening scans. 7 always contains the
 *  right weekday; 8 covers "today's opening already passed" on that weekday. */
const MAX_SCAN_DAYS = 8;

/** Intl short weekday (en-US) -> ISO weekday 1 (Mon) .. 7 (Sun). */
const ISO_WEEKDAY: Record<string, number> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

/** Wall-clock fields of an instant in one time zone. */
interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number;
  second: number;
  isoWeekday: number; // 1 (Mon) .. 7 (Sun)
}

// One formatter per zone: constructing Intl.DateTimeFormat is relatively
// expensive and the orchestrator / seed call these helpers in loops.
const formatterCache = new Map<string, Intl.DateTimeFormat>();

/**
 * Get (and cache) a formatter that prints every wall-clock field we need in
 * `timeZone`. Throws a RangeError for an unknown zone (that is how
 * assertValidCrawlWindow detects one).
 */
function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      // h23 gives 0-23 (never "24" at midnight, which hour12:false can print).
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      weekday: "short",
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

/** Wall-clock fields of the instant `ms` (epoch millis) in `timeZone`. */
function localParts(timeZone: string, ms: number): LocalParts {
  const out: Record<string, string> = {};
  for (const p of formatterFor(timeZone).formatToParts(new Date(ms))) out[p.type] = p.value;
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour),
    minute: Number(out.minute),
    second: Number(out.second),
    isoWeekday: ISO_WEEKDAY[out.weekday],
  };
}

/**
 * The zone's UTC offset at instant `ms`, in ms (local = UTC + offset). Read the
 * wall clock at `ms`, treat it as if it were UTC, and subtract the real
 * instant (sub-second part dropped, since the formatter prints whole seconds).
 */
function offsetAt(timeZone: string, ms: number): number {
  const p = localParts(timeZone, ms);
  const wallAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return wallAsUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * The UTC instant at which the local wall clock in `timeZone` reads
 * year-month-day hour:00:00.
 *
 * The offset around that wall time is sampled one day either side (zones
 * change offset at most once in such a span). Each sampled offset gives one
 * candidate instant; a candidate is VALID if the zone's wall clock at it
 * really reads the requested time.
 *  - both valid (and different) -> the time occurs twice (fall-back):
 *    return the earlier (first occurrence);
 *  - one valid -> return it;
 *  - none valid -> the time falls in a spring-forward gap: return the
 *    transition instant, i.e. the first valid instant after the requested
 *    local time (found by binary search between the two candidates).
 */
function localWallTimeToUtc(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour: number
): number {
  // The wall time read "as if UTC"; the real instant is this minus the offset.
  const naive = Date.UTC(year, month - 1, day, hour, 0, 0);
  const offsets = [...new Set([offsetAt(timeZone, naive - DAY_MS), offsetAt(timeZone, naive + DAY_MS)])];
  const candidates = offsets.map((o) => naive - o);

  // Does the wall clock at `ms` read exactly the requested local time?
  const matches = (ms: number): boolean => {
    const p = localParts(timeZone, ms);
    return (
      p.year === year && p.month === month && p.day === day && p.hour === hour && p.minute === 0 && p.second === 0
    );
  };

  const valid = candidates.filter(matches);
  if (valid.length > 0) return Math.min(...valid);

  // ---- Spring-forward gap ----
  // Neither offset produces the requested wall time. The transition lies
  // between the two candidates: the earlier one is still on the OLD offset,
  // the later one already on the NEW offset. Binary-search (to the second)
  // for the first instant on the new offset; at that instant the wall clock
  // reads the end of the gap, the first valid local time after the request.
  let lo = Math.min(...candidates); // old offset side
  let hi = Math.max(...candidates); // new offset side
  const newOffset = offsetAt(timeZone, hi);
  while (hi - lo > 1000) {
    const mid = Math.floor((lo + hi) / 2000) * 1000; // whole second
    if (offsetAt(timeZone, mid) === newOffset) hi = mid;
    else lo = mid;
  }
  return hi;
}

/** Normalise a Date or epoch-millis input to epoch millis. */
function toMillis(now: Date | number): number {
  return typeof now === "number" ? now : now.getTime();
}

/**
 * Throw (with a clear message) unless `window` is a usable CrawlWindow:
 *  - `timeZone` is an IANA zone Intl.DateTimeFormat accepts;
 *  - `dayOfWeek` is an integer in 1..7 (ISO, Monday = 1);
 *  - `startHour` is an integer in 0..23;
 *  - `endHour` is an integer with startHour < endHour <= 24 (no overnight wrap).
 */
export function assertValidCrawlWindow(window: CrawlWindow): void {
  if (!window || typeof window !== "object") {
    throw new Error("Invalid crawl window: expected an object");
  }
  const { timeZone, dayOfWeek, startHour, endHour } = window;
  if (typeof timeZone !== "string" || timeZone.length === 0) {
    throw new Error("Invalid crawl window: timeZone must be a non-empty IANA zone name");
  }
  try {
    formatterFor(timeZone);
  } catch {
    throw new Error(`Invalid crawl window: unknown time zone "${timeZone}"`);
  }
  if (!Number.isInteger(dayOfWeek) || dayOfWeek < 1 || dayOfWeek > 7) {
    throw new Error(`Invalid crawl window: dayOfWeek must be an integer 1 (Mon) .. 7 (Sun), got ${dayOfWeek}`);
  }
  if (!Number.isInteger(startHour) || startHour < 0 || startHour > 23) {
    throw new Error(`Invalid crawl window: startHour must be an integer 0..23, got ${startHour}`);
  }
  if (!Number.isInteger(endHour) || endHour <= startHour || endHour > 24) {
    throw new Error(
      `Invalid crawl window: endHour must be an integer with startHour < endHour <= 24, got ${startHour}..${endHour}`
    );
  }
}

/**
 * Is `now` inside the window? True when, in the window's zone, the local
 * weekday is `dayOfWeek` and `startHour <= local hour < endHour`.
 * Throws on an invalid window (see assertValidCrawlWindow).
 */
export function isInCrawlWindow(window: CrawlWindow, now: Date | number): boolean {
  assertValidCrawlWindow(window);
  const p = localParts(window.timeZone, toMillis(now));
  return p.isoWeekday === window.dayOfWeek && p.hour >= window.startHour && p.hour < window.endHour;
}

/**
 * The next opening of the window STRICTLY after `now`: the first local
 * `dayOfWeek` at `startHour`:00 in `timeZone` that is later than `now`, as a
 * UTC Date. Examples (window Mon 02-05 Europe/London):
 *  - Mon 01:30 local          -> today 02:00 (today's opening)
 *  - Mon 02:00 local exactly  -> next Monday 02:00 (strictly after)
 *  - Mon 02:15 local (inside) -> next Monday 02:00
 *  - Tue                      -> next Monday 02:00
 * Because it is computed from the tick's `now` (not the run's end) and lands
 * on the local grid, a long run never makes the schedule drift.
 * Throws on an invalid window.
 */
export function nextWindowOpening(window: CrawlWindow, now: Date | number): Date {
  assertValidCrawlWindow(window);
  const nowMs = toMillis(now);
  const today = localParts(window.timeZone, nowMs);

  // Walk local calendar days from today. Date.UTC normalises day overflow
  // (e.g. Jan 32 -> Feb 1), so plain day arithmetic is safe here; the UTC
  // fields of that value are just a calendar, not an instant.
  for (let k = 0; k < MAX_SCAN_DAYS; k++) {
    const cal = new Date(Date.UTC(today.year, today.month - 1, today.day + k));
    const isoWeekday = cal.getUTCDay() === 0 ? 7 : cal.getUTCDay(); // JS Sun = 0
    if (isoWeekday !== window.dayOfWeek) continue;
    const opening = localWallTimeToUtc(
      window.timeZone,
      cal.getUTCFullYear(),
      cal.getUTCMonth() + 1,
      cal.getUTCDate(),
      window.startHour
    );
    if (opening > nowMs) return new Date(opening);
  }
  // Unreachable for a valid window: within 8 local days the weekday occurs at
  // least once with an opening after `now`.
  throw new Error(`No window opening found for ${JSON.stringify(window)} after ${new Date(nowMs).toISOString()}`);
}
