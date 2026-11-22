// ============================================
// When a consultation slot starts and ends (issue #317)
// ============================================
//
// The refund rule ("a client who cancels 24 hours or more before the slot
// gets the fee back") and the fee hold ("a fee is held until 24 hours after
// the slot ends") both need the slot as a real INSTANT. A booking stores it
// in three parts:
//  - `scheduledDate`: a Timestamp whose UTC calendar day is the day of the
//    slot. The apps send `yyyy-MM-dd` (seli-mobile pay.tsx, the portal), which
//    `new Date(...)` reads as midnight UTC of that day, so the UTC year, month
//    and day ARE the day the client picked;
//  - `scheduledTime`: the wall-clock time, stored as 24-hour `HH:mm` (#288);
//  - `timezone`: the IANA zone that wall-clock time is in ("Africa/Lagos").
// `slotStartsAt` combines them, in ONE place, so every rule reads the same
// instant. The server clock is always what it is compared with, never the
// caller's.
//
// Kept in its own module (no Firestore, no services) so both the booking
// service and the charge path (`settlePayment`, which stamps the fee hold)
// can import it without an import cycle.

import type { Consultation } from "../types";

/** Milliseconds in a minute and in an hour (named so the maths reads plainly). */
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

/** The zone a booking is read in when its stored `timezone` is missing or not a real zone. */
export const DEFAULT_BOOKING_TIMEZONE = "Africa/Lagos";

/** The slot length assumed when a booking stores no usable `durationMinutes`. */
export const DEFAULT_DURATION_MINUTES = 30;

/** Stored 24-hour `HH:mm`. */
const HH_MM = /^([01]\d|2[0-3]):([0-5]\d)$/;
/** 12-hour `h:mm AM/PM` (rows written before #288 may still hold one). */
const H_MM_AM_PM = /^(0?[1-9]|1[0-2]):([0-5]\d) ?(AM|PM)$/i;

/**
 * Hours and minutes of a stored `scheduledTime`, or null when it is neither
 * 24-hour `HH:mm` nor 12-hour `h:mm AM/PM`. Pure. (The same two forms
 * `normalizeScheduledTime` accepts; duplicated here as numbers so this module
 * needs no service import.)
 */
function parseClock(value: unknown): { hour: number; minute: number } | null {
  if (typeof value !== "string") return null;
  const h24 = HH_MM.exec(value);
  if (h24) return { hour: Number(h24[1]), minute: Number(h24[2]) };
  const h12 = H_MM_AM_PM.exec(value);
  if (!h12) return null;
  const isPm = h12[3].toUpperCase() === "PM";
  // 12 AM is hour 0, 12 PM is hour 12; every other PM hour is 12 later.
  return { hour: (Number(h12[1]) % 12) + (isPm ? 12 : 0), minute: Number(h12[2]) };
}

/** True when `zone` is an IANA time zone this runtime knows. */
export function isKnownTimeZone(zone: unknown): zone is string {
  if (typeof zone !== "string" || !zone.trim()) return false;
  try {
    // Throws a RangeError for an unknown zone.
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The offset of `zone` from UTC at the instant `utcMs`, in milliseconds
 * (positive east of Greenwich: +1h for Lagos). Pure. Worked out with Intl
 * (no time-zone library): format the instant as wall-clock parts in the
 * zone, read those parts back as if they were UTC, and take the difference.
 */
function zoneOffsetMs(zone: string, utcMs: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));
  /** One numeric part of the formatted date. */
  const part = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second"));
  // Sub-second precision is dropped by the formatter, so compare whole seconds.
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/**
 * The UTC instant of a wall-clock time in `zone`. Pure. Two passes, so a
 * time near a daylight-saving change still lands on the right offset: guess
 * with the offset at the naive instant, then re-check the offset at the
 * corrected instant.
 */
function wallClockToUtc(
  year: number, month: number, day: number, hour: number, minute: number, zone: string
): number {
  const naive = Date.UTC(year, month, day, hour, minute);
  const firstOffset = zoneOffsetMs(zone, naive);
  const guess = naive - firstOffset;
  const secondOffset = zoneOffsetMs(zone, guess);
  return secondOffset === firstOffset ? guess : naive - secondOffset;
}

/**
 * When a booking's slot STARTS, as a Date (issue #317). Pure.
 *
 * `scheduledDate`'s UTC calendar day + `scheduledTime` read as wall-clock
 * time in the booking's `timezone`. Fallbacks, each logged by nobody (they
 * are data problems the booking routes already refuse on create and edit):
 *  - a `timezone` that is not a real zone: DEFAULT_BOOKING_TIMEZONE;
 *  - a `scheduledTime` in neither accepted form: midnight of that day (the
 *    EARLIEST reading, so a client cancelling such a booking is never told
 *    they have more time than they do).
 *
 * @throws when `scheduledDate` is not a Timestamp-like value (no slot at all)
 */
export function slotStartsAt(
  booking: Pick<Consultation, "scheduledDate" | "scheduledTime" | "timezone">
): Date {
  const date = booking.scheduledDate as unknown as { toDate?: () => Date } | undefined;
  if (!date || typeof date.toDate !== "function") {
    throw new Error("slotStartsAt: the booking has no scheduledDate");
  }
  const day = date.toDate();
  const clock = parseClock(booking.scheduledTime) ?? { hour: 0, minute: 0 };
  const zone = isKnownTimeZone(booking.timezone) ? booking.timezone : DEFAULT_BOOKING_TIMEZONE;
  return new Date(
    wallClockToUtc(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), clock.hour, clock.minute, zone)
  );
}

/**
 * When a booking's slot ENDS: its start plus `durationMinutes` (30 when the
 * stored value is not a positive whole number). Pure.
 */
export function slotEndsAt(
  booking: Pick<Consultation, "scheduledDate" | "scheduledTime" | "timezone" | "durationMinutes">
): Date {
  const minutes =
    typeof booking.durationMinutes === "number" && Number.isInteger(booking.durationMinutes) && booking.durationMinutes > 0
      ? booking.durationMinutes
      : DEFAULT_DURATION_MINUTES;
  return new Date(slotStartsAt(booking).getTime() + minutes * MINUTE_MS);
}

/** `hours` hours after `at`. Pure. */
export function hoursAfter(at: Date, hours: number): Date {
  return new Date(at.getTime() + hours * HOUR_MS);
}

// ============================================
// Has the slot already started? (issue #472)
// ============================================
//
// A user booked 11 AM today at 1 PM: nothing on the server refused a slot
// that had already begun. Every route that books a slot or moves one
// (`POST /consultations`, the guest `POST /agencies/public/:slug/consultations`
// and a slot-moving `PUT /consultations/:id`) asks THIS one helper, so the
// rule reads the same everywhere.
//
// "Started" means `slotStartsAt(slot) <= now`: a slot that starts exactly
// now counts as started (there is no time left to join it on time). There is
// NO minimum lead time (that is a product decision, issue #477): a slot one
// minute from now is still bookable.

/** The error code every booking route answers for a slot that has started (issue #472). */
export const SLOT_IN_PAST_CODE = "SLOT_IN_PAST";

/** The plain-words message that goes with `SLOT_IN_PAST` (the apps show it as is). */
export const SLOT_IN_PAST_MESSAGE = "That time has already passed. Please pick a later time.";

/**
 * True when the slot has already STARTED at `now` (issue #472). Pure.
 *
 * The slot is read exactly as every other rule reads it (`slotStartsAt`):
 * `scheduledDate`'s UTC calendar day plus the wall-clock `scheduledTime` in
 * the booking's own `timezone` (Africa/Lagos when none is stored).
 *
 * @param slot the booking's (or the request's) date, time and zone
 * @param now the SERVER clock. Callers pass `chargeRuntime.now()`, never a
 *   time the caller of the API sent, so a client cannot move "now".
 * @throws when `scheduledDate` is not a Timestamp-like value (as `slotStartsAt`)
 */
export function isSlotInPast(
  slot: Pick<Consultation, "scheduledDate" | "scheduledTime" | "timezone">,
  now: Date
): boolean {
  return slotStartsAt(slot).getTime() <= now.getTime();
}
