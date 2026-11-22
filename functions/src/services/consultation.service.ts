import { createHash } from "crypto";
import { collections } from "../utils/firebase";
import { Consultation, ConsultationStatus, ConsultationType } from "../types";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { ROLES } from "@durin-tech/authz";
// Issue #151: the shared clock and Firestore transaction runner of the charge
// path (tests swap both through the consultations harness). The status change
// uses the SAME clock as the quote lock it reads, and the same runner as
// `settlePayment`, so a cancel and a payment can never interleave.
import {
  chargeRuntime,
  isQuoteExpired,
  // Issue #288: a booking is resumed, or swept, only when it was priced by
  // #180 (a well-formed charge snapshot); the sweep asks Paystack about the
  // booking's current checkout before it closes it.
  hasChargeSnapshot,
  lookupCheckoutState,
  PaystackState,
  // Issue #354: a reschedule retires the open checkout into the superseded list.
  supersededEntryOf,
} from "./charge-checkout.service";
// Issue #411: a "not found" lookup failure is recorded as such (fail closed).
import { isPaystackReferenceNotFound } from "./billing/paystack.provider";
// Issue #288: a booking the sweep finds PAID at Paystack is settled, not cancelled.
import { sendDeferredRefundNotice, settlePayment } from "./consultation-charge.service";
// Issue #397: the sweep reads settle outcomes to decide whether to cancel.
import type { DeferredRefundNotice, SettleOutcome } from "./consultation-charge.service";
// Issue #317: the refund rule, the refund write (same transaction as the
// cancel), and the fee hold.
import {
  bookingRefundFields,
  decideCancellationRefund,
  isPaidWithMoney,
  readFeeTransaction,
  readRefundContext,
  writeRefund,
  // Issue #390: Paystack's fee on the refund (who carries it, looked up first).
  findFeeTransaction,
  lookUpRefundFee,
  planRefund,
} from "./consultation-refund.service";
import { feeHoldStatusAt, rescheduledFeeHold } from "../money/fee-hold";
import type { SupersededCheckout, Transaction } from "../types";
// Issue #411: the sweep's bookkeeping on a booking.
import type {
  ConsultationSweepReview,
  SweepCheckoutKnownState,
  SweepCheckoutRecord,
  SweepUnresolvedOutcome,
} from "../types";
// Issue #317: when a slot starts, in ONE helper (re-exported below).
export { slotStartsAt, slotEndsAt } from "../consultations/slot-time";
import { slotStartsAt } from "../consultations/slot-time";

// ============================================
// STATUS TRANSITION RULES (issue #151)
// ============================================
//
// Who may move a consultation to which status, and from which status. This is
// the ONE place the rules live for `PUT /consultations/:id/status`. The edit
// route, `PUT /consultations/:id`, has its own table further down (#316) and
// shares the parties and `isPaymentInFlight` with this one.
//
// The two parties of a booking:
//  - the CLIENT: the booking's `userId`;
//  - the AGENT SIDE: the booking's `agentId` (a user uid), the owner of the
//    booking's agency, or an admin.
// Working out which party a caller is belongs to the controller (it knows
// the request's principal); this file only decides what a party may do.

/** The party of a booking a caller acts as. */
export const CONSULTATION_ACTORS = {
  /** The booking's own client (`userId`). */
  CLIENT: ROLES.CLIENT,
  /** The booking's agent, its agency's owner, or an admin. */
  AGENT_SIDE: "agent_side",
} as const;
export type ConsultationActor = (typeof CONSULTATION_ACTORS)[keyof typeof CONSULTATION_ACTORS];

/** Every status a consultation can hold (also the list a request's `status` is checked against). */
export const CONSULTATION_STATUSES: ConsultationStatus[] = [
  "pending_payment", "scheduled", "confirmed", "in_progress",
  "completed", "cancelled", "no_show",
];

/**
 * Statuses nobody may SET through the API: `pending_payment` is written only
 * by booking creation, and `scheduled` only by booking creation (free) or by
 * payment verification (`settlePayment`). Letting a caller write `scheduled`
 * is exactly how an unpaid booking used to be marked as booked.
 */
export const SYSTEM_ONLY_STATUSES: ConsultationStatus[] = ["pending_payment", "scheduled"];

/**
 * The transition table: for each party, target status -> the statuses it may
 * be reached FROM. A target missing for a party is one that party may never
 * set. Terminal statuses (`completed`, `cancelled`, `no_show`) appear in no
 * "from" list, so nothing ever leaves them; an unpaid `pending_payment`
 * booking can only be cancelled.
 */
export const STATUS_TRANSITIONS: Record<
  ConsultationActor,
  Partial<Record<ConsultationStatus, ConsultationStatus[]>>
> = {
  // A client can only cancel, and only before the consultation has started.
  [CONSULTATION_ACTORS.CLIENT]: {
    cancelled: ["pending_payment", "scheduled", "confirmed"],
  },
  [CONSULTATION_ACTORS.AGENT_SIDE]: {
    confirmed: ["scheduled"],
    in_progress: ["scheduled", "confirmed"],
    completed: ["scheduled", "confirmed", "in_progress"],
    no_show: ["scheduled", "confirmed", "in_progress"],
    cancelled: ["pending_payment", "scheduled", "confirmed"],
  },
};

/**
 * Targets that say the meeting has started (issue #317 review fix): the agent
 * side may only set them once the slot has started (see `decideStatusChange`).
 */
export const SLOT_STARTED_TARGETS: ConsultationStatus[] = ["in_progress", "completed", "no_show"];

/** Why a status change was refused: the API error code and its HTTP status. */
export interface StatusChangeRefusal {
  ok: false;
  // FEE_RELEASED (issue #317): the agent side cancelling a paid booking
  // whose fee was already released (the meeting has happened). Refunds of a
  // released fee are an admin decision (POST /consultations/:id/refund).
  // SLOT_NOT_STARTED (issue #317 review fix): the agent side marking a
  // booking in_progress / completed / no_show before its slot has started.
  code:
    | "FORBIDDEN"
    | "VALIDATION_ERROR"
    | "INVALID_STATUS_TRANSITION"
    | "PAYMENT_IN_PROGRESS"
    | "FEE_RELEASED"
    | "SLOT_NOT_STARTED"
    // Issue #382: the client's "the meeting didn't happen" report is open.
    | "NO_SHOW_REPORT_OPEN";
  httpStatus: 400 | 403 | 409;
  message: string;
}
export type StatusChangeDecision = { ok: true } | StatusChangeRefusal;

/**
 * True while a Paystack payment may still land on an unpaid booking: it is
 * `pending_payment`, a checkout was really OPENED (`transactionId` AND
 * `checkoutUrl`), and that checkout's quote lock (`quoteExpiresAt`) has not
 * passed. The lock is used rather than a Paystack lookup so the rule is the
 * same on the emulators. A booking with no lock at all (legacy naira rows)
 * counts as expired.
 *
 * Issue #321: `checkoutUrl` is required too. The charge path first claims its
 * own reference (`transactionId`) and only then asks Paystack to open the
 * checkout; when that Paystack call fails the booking keeps the reference but
 * has no `checkoutUrl`, and nobody was ever shown a page to pay on. Such a
 * booking is NOT in flight: it can be cancelled (and rescheduled, #316)
 * straight away. Should a payment still land on it after a cancel,
 * `settlePayment` records it as `booking_not_payable` in
 * `consultationPaymentExceptions`, as for any cancelled booking.
 */
export function isPaymentInFlight(
  c: Pick<Consultation, "status" | "transactionId" | "checkoutUrl" | "quoteExpiresAt">,
  at: Date
): boolean {
  return c.status === "pending_payment" && !!c.transactionId && !!c.checkoutUrl && !isQuoteExpired(c, at);
}

/**
 * Decide whether `actor` may move `booking` to `target` at time `at`.
 * Pure: reads nothing, writes nothing. Checks run in this order, and the
 * first that fails is the answer:
 *
 *  1. `target` is `pending_payment` or `scheduled`: 400 VALIDATION_ERROR, for
 *     anyone (only booking creation and payment verify write those).
 *  2. `actor` is null (the caller is not a party of the booking): 403.
 *  3. The party may never set `target` (a client setting anything but
 *     `cancelled`): 403 FORBIDDEN.
 *  4. The party may set `target`, but not from the booking's current status
 *     (wrong starting state, a terminal status, or an unpaid booking to
 *     anything but `cancelled`): 409 INVALID_STATUS_TRANSITION.
 *  5. Cancelling while a payment is in flight (see `isPaymentInFlight`):
 *     409 PAYMENT_IN_PROGRESS.
 */
export function decideStatusChange(
  actor: ConsultationActor | null,
  booking: Pick<Consultation, "status" | "transactionId" | "checkoutUrl" | "quoteExpiresAt"> &
    Partial<Pick<Consultation, "scheduledDate" | "scheduledTime" | "timezone">>,
  target: ConsultationStatus,
  at: Date
): StatusChangeDecision {
  if (SYSTEM_ONLY_STATUSES.includes(target)) {
    return {
      ok: false,
      code: "VALIDATION_ERROR",
      httpStatus: 400,
      message: `A consultation cannot be set to ${target}: that status is set when it is booked or paid`,
    };
  }
  if (!actor) {
    return { ok: false, code: "FORBIDDEN", httpStatus: 403, message: "You do not have permission to perform this action" };
  }
  const allowedFrom = STATUS_TRANSITIONS[actor][target];
  if (!allowedFrom) {
    return { ok: false, code: "FORBIDDEN", httpStatus: 403, message: "You do not have permission to perform this action" };
  }
  if (!allowedFrom.includes(booking.status)) {
    return {
      ok: false,
      code: "INVALID_STATUS_TRANSITION",
      httpStatus: 409,
      message: `A consultation that is ${booking.status} cannot be set to ${target}`,
    };
  }
  // Issue #317 review fix: a meeting cannot be under way, done, or missed
  // before it has started. Marking one early used to stop the client from
  // cancelling (and so from a refund they were owed) and started the fee's
  // release. A booking with no readable slot is not blocked here.
  if (SLOT_STARTED_TARGETS.includes(target) && booking.scheduledDate) {
    let startMs: number | null = null;
    try {
      startMs = slotStartsAt(booking as Pick<Consultation, "scheduledDate" | "scheduledTime" | "timezone">).getTime();
    } catch {
      startMs = null;
    }
    if (startMs !== null && at.getTime() < startMs) {
      return {
        ok: false,
        code: "SLOT_NOT_STARTED",
        httpStatus: 409,
        message: `A consultation cannot be set to ${target} before its time slot has started`,
      };
    }
  }
  if (target === "cancelled" && isPaymentInFlight(booking, at)) {
    return {
      ok: false,
      code: "PAYMENT_IN_PROGRESS",
      httpStatus: 409,
      message: "A payment for this booking may still be in progress. Try again once the checkout has expired.",
    };
  }
  return { ok: true };
}

// ============================================
// EDIT RULES (issue #316)
// ============================================
//
// `PUT /consultations/:id` used to need only READ access, so the client (or
// anyone who could read the booking) could move its time or rewrite its
// meeting link, and a booking could be rescheduled while its checkout was
// open. The rules below are the ONE place that says who may edit which
// field, and when.
//
// WHO: only the AGENT SIDE (the booking's agent, its agency's owner, an
// admin; see `consultationActor` in the controller). The client cancels
// through the status route and edits nothing here.
//
// WHAT, by the booking's status:
//
//   status           | schedule fields         | meeting fields | summary
//   -----------------|-------------------------|----------------|--------
//   pending_payment  | yes, unless a payment   | yes            | yes
//                    | is in flight (409       |                |
//                    | PAYMENT_IN_PROGRESS)    |                |
//   scheduled        | yes                     | yes            | yes
//   confirmed        | yes                     | yes            | yes
//   in_progress      | no (409)                | yes            | yes
//   completed        | no (409)                | no (409)       | yes
//   cancelled        | no (409)                | no (409)       | no (409)
//   no_show          | no (409)                | no (409)       | no (409)
//
// "no (409)" is 409 BOOKING_NOT_EDITABLE.

/**
 * The fields `PUT /consultations/:id` can change, by group. Anything else in
 * a request body (`status`, `userId`, `agentId`, every money field, ...) is
 * ignored and never reaches Firestore.
 */
export const EDIT_FIELD_GROUPS = {
  /** When the consultation happens. Changing one is a RESCHEDULE. */
  schedule: ["scheduledDate", "scheduledTime", "durationMinutes", "timezone"],
  /** How and about what the two meet. */
  meeting: ["meetingLink", "meetingPlatform", "type"],
  /** The agent's notes on the consultation. */
  summary: ["summary"],
} as const;
export type EditFieldGroup = keyof typeof EDIT_FIELD_GROUPS;
/** One editable field name. */
export type EditableField = (typeof EDIT_FIELD_GROUPS)[EditFieldGroup][number];

/** Every editable field, in one flat list (the old `allowedFields`). */
export const EDITABLE_FIELDS: readonly EditableField[] = [
  ...EDIT_FIELD_GROUPS.schedule,
  ...EDIT_FIELD_GROUPS.meeting,
  ...EDIT_FIELD_GROUPS.summary,
];

/**
 * The status x field table: for each status, the field groups the agent
 * side may still edit. An empty list means the booking is closed to edits.
 */
export const EDITABLE_GROUPS_BY_STATUS: Record<ConsultationStatus, readonly EditFieldGroup[]> = {
  // Unpaid: everything, but `decideEdit` also blocks a reschedule while a payment is in flight.
  pending_payment: ["schedule", "meeting", "summary"],
  scheduled: ["schedule", "meeting", "summary"],
  confirmed: ["schedule", "meeting", "summary"],
  // Already started: the time is history, the link and notes are still useful.
  in_progress: ["meeting", "summary"],
  // Done: only the notes can still be written up.
  completed: ["summary"],
  // Closed for good.
  cancelled: [],
  no_show: [],
};

/** The group an editable field belongs to. */
function groupOfField(field: EditableField): EditFieldGroup {
  const groups = Object.keys(EDIT_FIELD_GROUPS) as EditFieldGroup[];
  // Every EditableField is in exactly one group, so this always finds one.
  return groups.find((g) => (EDIT_FIELD_GROUPS[g] as readonly string[]).includes(field)) as EditFieldGroup;
}

/** True when `fields` holds at least one schedule field (the edit is a reschedule). */
export function isScheduleEdit(fields: readonly string[]): boolean {
  return fields.some((f) => (EDIT_FIELD_GROUPS.schedule as readonly string[]).includes(f));
}

/** Why an edit was refused: the API error code and its HTTP status. */
export interface EditRefusal {
  ok: false;
  // FEE_RELEASED (issue #317 review fix): rescheduling a PAID booking whose
  // fee was already released (the meeting has happened).
  code: "FORBIDDEN" | "VALIDATION_ERROR" | "BOOKING_NOT_EDITABLE" | "PAYMENT_IN_PROGRESS" | "FEE_RELEASED";
  httpStatus: 400 | 403 | 409;
  message: string;
}
export type EditDecision = { ok: true } | EditRefusal;

/**
 * Decide whether `actor` may change the fields `fieldNames` of `booking` at
 * time `at`. Pure: reads nothing, writes nothing. Checks run in this order,
 * and the first that fails is the answer:
 *
 *  1. No editable field is named: 400 VALIDATION_ERROR (the controller
 *     answers this before the booking is read; this is the second line).
 *  2. `actor` is not the agent side (the client, or not a party): 403.
 *  3. A named field's group is closed in the booking's status (see
 *     `EDITABLE_GROUPS_BY_STATUS`): 409 BOOKING_NOT_EDITABLE.
 *  4. A schedule field is named while a payment is in flight (see
 *     `isPaymentInFlight`): 409 PAYMENT_IN_PROGRESS. The client is paying
 *     for the time they were shown, so it must not move under them.
 *
 * @param fieldNames the editable fields present in the request body
 */
export function decideEdit(
  actor: ConsultationActor | null,
  booking: Pick<Consultation, "status" | "transactionId" | "checkoutUrl" | "quoteExpiresAt">,
  fieldNames: readonly EditableField[],
  at: Date
): EditDecision {
  if (fieldNames.length === 0) {
    return { ok: false, code: "VALIDATION_ERROR", httpStatus: 400, message: "No editable field was provided" };
  }
  if (actor !== CONSULTATION_ACTORS.AGENT_SIDE) {
    return { ok: false, code: "FORBIDDEN", httpStatus: 403, message: "You do not have permission to perform this action" };
  }
  // A status missing from the table (bad data) is treated as closed.
  const open = EDITABLE_GROUPS_BY_STATUS[booking.status] ?? [];
  const closed = fieldNames.filter((f) => !open.includes(groupOfField(f)));
  if (closed.length > 0) {
    return {
      ok: false,
      code: "BOOKING_NOT_EDITABLE",
      httpStatus: 409,
      message: `A consultation that is ${booking.status} cannot have ${closed.join(", ")} changed`,
    };
  }
  if (isScheduleEdit(fieldNames) && isPaymentInFlight(booking, at)) {
    return {
      ok: false,
      code: "PAYMENT_IN_PROGRESS",
      httpStatus: 409,
      message: "A payment for this booking may still be in progress. Try again once the checkout has expired.",
    };
  }
  return { ok: true };
}

// ---- Value checks for an edit (issue #316) ----

/** The consultation types a booking can hold (`ConsultationType`). */
export const CONSULTATION_TYPES: ConsultationType[] = [
  "initial", "document_review", "interview_prep", "follow_up", "general",
];
/** The meeting platforms a booking can name. */
export const MEETING_PLATFORMS: NonNullable<Consultation["meetingPlatform"]>[] = ["zoom", "google_meet", "teams"];
/** Shortest and longest consultation an edit may set, in minutes. */
export const MIN_DURATION_MINUTES = 5;
export const MAX_DURATION_MINUTES = 480;
/** Longest `summary` an edit may store, in characters. */
export const MAX_SUMMARY_LENGTH = 5000;
/** 24-hour `HH:mm`, e.g. "09:05" or "23:59". This is the STORED format. */
const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;
/**
 * 12-hour `h:mm AM/PM`, e.g. "9:30 AM", "09:30am" or "12:00 PM": hour 1-12
 * with an optional leading zero, then at most one space, then AM or PM in
 * any letter case. The portal's time picker sends these labels.
 */
const H_MM_AM_PM = /^(0?[1-9]|1[0-2]):([0-5]\d) ?(AM|PM)$/i;

/**
 * Turn a request's `scheduledTime` into the stored 24-hour `HH:mm`, or null
 * when it is neither accepted form (issue #316, criterion update):
 *
 *  - 24-hour `HH:mm` is kept as it is;
 *  - 12-hour `h:mm AM/PM` is converted: "12:00 AM" -> "00:00",
 *    "12:30 PM" -> "12:30", "1:05 PM" -> "13:05", "9:30 am" -> "09:30".
 *
 * Pure. Anything else (a non-string, "9:30", "13:00 PM", "2pm") is null.
 */
export function normalizeScheduledTime(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (HH_MM.test(value)) return value;
  const match = H_MM_AM_PM.exec(value);
  if (!match) return null;
  const isPm = match[3].toUpperCase() === "PM";
  // 12 AM is hour 0 and 12 PM is hour 12; every other PM hour is 12 later.
  const hour = (Number(match[1]) % 12) + (isPm ? 12 : 0);
  return `${String(hour).padStart(2, "0")}:${match[2]}`;
}

/** A stored date as milliseconds, or null when the field holds no Timestamp. */
function millisOf(value: unknown): number | null {
  return value && typeof (value as Timestamp).toMillis === "function" ? (value as Timestamp).toMillis() : null;
}

/**
 * True when an edit really MOVED the booking: at least one stored schedule
 * value differs between `before` and `after` (the date compared by instant,
 * the others by value). Resending the values a booking already holds is
 * therefore not a reschedule, and nobody is told it was one.
 */
export function scheduleChanged(
  before: Pick<Consultation, "scheduledDate" | "scheduledTime" | "durationMinutes" | "timezone">,
  after: Pick<Consultation, "scheduledDate" | "scheduledTime" | "durationMinutes" | "timezone">
): boolean {
  return (
    millisOf(before.scheduledDate) !== millisOf(after.scheduledDate) ||
    before.scheduledTime !== after.scheduledTime ||
    before.durationMinutes !== after.durationMinutes ||
    before.timezone !== after.timezone
  );
}

/** A checked edit: the values to store, keyed by editable field. */
export type EditUpdates = Partial<Record<EditableField, unknown>>;
export type ParsedEdit =
  | { ok: true; updates: EditUpdates; fieldNames: EditableField[] }
  | { ok: false; message: string };

/** True for an absolute `https://` URL. */
function isHttpsUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false; // not a URL at all
  }
}

/**
 * Read the editable fields out of a `PUT /consultations/:id` body and check
 * their values. Pure. Fields outside `EDITABLE_FIELDS` are dropped; a field
 * that is `undefined` counts as not sent (as before). The result is either
 * the values to store (`scheduledDate` already a Timestamp) or the message
 * for a 400 VALIDATION_ERROR:
 *
 *  - no editable field at all;
 *  - `scheduledDate` not a string that parses as a date (this used to
 *    throw inside Timestamp.fromDate and answer 500);
 *  - `scheduledTime` neither 24-hour `HH:mm` nor 12-hour `h:mm AM/PM`
 *    (either is stored as `HH:mm`, see `normalizeScheduledTime`);
 *  - `durationMinutes` not a whole number from 5 to 480;
 *  - `timezone` not a non-empty string;
 *  - `meetingPlatform` not zoom / google_meet / teams;
 *  - `type` not a ConsultationType;
 *  - `meetingLink` not an `https://` URL;
 *  - `summary` not a string, or longer than 5000 characters.
 */
export function parseEditBody(body: unknown): ParsedEdit {
  // A missing or non-object body (or an array) carries no fields.
  const source: Record<string, unknown> =
    body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const updates: EditUpdates = {};
  const fieldNames: EditableField[] = [];
  /** Shorthand for a refusal. */
  const bad = (message: string): ParsedEdit => ({ ok: false, message });

  for (const field of EDITABLE_FIELDS) {
    const value = source[field];
    if (value === undefined) continue;
    switch (field) {
    case "scheduledDate": {
      const ms = typeof value === "string" && value.trim() ? Date.parse(value) : NaN;
      if (Number.isNaN(ms)) return bad("scheduledDate must be a valid date");
      // Stored as a Firestore Timestamp, like every other booking date.
      updates.scheduledDate = Timestamp.fromMillis(ms);
      break;
    }
    case "scheduledTime": {
      // Either accepted form is stored the same way, as 24-hour HH:mm.
      const time = normalizeScheduledTime(value);
      if (time === null) return bad("scheduledTime must be a 24-hour HH:mm or a 12-hour h:mm AM/PM time");
      updates.scheduledTime = time;
      break;
    }
    case "durationMinutes":
      if (
        typeof value !== "number" || !Number.isInteger(value) ||
        value < MIN_DURATION_MINUTES || value > MAX_DURATION_MINUTES
      ) {
        return bad(`durationMinutes must be a whole number from ${MIN_DURATION_MINUTES} to ${MAX_DURATION_MINUTES}`);
      }
      updates.durationMinutes = value;
      break;
    case "timezone":
      if (typeof value !== "string" || !value.trim()) return bad("timezone must be a non-empty string");
      updates.timezone = value;
      break;
    case "meetingLink":
      if (!isHttpsUrl(value)) return bad("meetingLink must be an https:// URL");
      updates.meetingLink = value;
      break;
    case "meetingPlatform":
      if (!(MEETING_PLATFORMS as unknown[]).includes(value)) {
        return bad(`meetingPlatform must be one of: ${MEETING_PLATFORMS.join(", ")}`);
      }
      updates.meetingPlatform = value;
      break;
    case "type":
      if (!(CONSULTATION_TYPES as unknown[]).includes(value)) {
        return bad(`type must be one of: ${CONSULTATION_TYPES.join(", ")}`);
      }
      updates.type = value;
      break;
    case "summary":
      if (typeof value !== "string" || value.length > MAX_SUMMARY_LENGTH) {
        return bad(`summary must be text of at most ${MAX_SUMMARY_LENGTH} characters`);
      }
      updates.summary = value;
      break;
    }
    fieldNames.push(field);
  }

  if (fieldNames.length === 0) return bad("No editable field was provided");
  return { ok: true, updates, fieldNames };
}

// ============================================
// RETIRING THE CHECKOUT ON A RESCHEDULE (issue #354)
// ============================================

/**
 * A schedule value as a comparable primitive (issue #354 fix round): a date
 * (Firestore Timestamp, a serialized `{ _seconds, _nanoseconds }`, a Date or
 * an ISO string) as epoch milliseconds, anything else as itself. A value
 * that cannot be read stays as it is, so it compares unequal to a readable
 * one (the safe side: an unreadable stored slot counts as moved). Pure.
 */
function comparableSlotValue(value: unknown): unknown {
  if (value instanceof Timestamp) return value.toMillis();
  if (value instanceof Date) return value.getTime();
  if (value && typeof value === "object") {
    const v = value as { toMillis?: () => number; _seconds?: number; seconds?: number; _nanoseconds?: number; nanoseconds?: number };
    if (typeof v.toMillis === "function") return v.toMillis();
    const seconds = v._seconds ?? v.seconds;
    const nanos = v._nanoseconds ?? v.nanoseconds ?? 0;
    if (typeof seconds === "number") return seconds * 1000 + Math.floor(nanos / 1e6);
  }
  if (typeof value === "string") {
    const ms = Date.parse(value);
    // A date string compares by its instant; other strings (a time, a zone) as text.
    if (!Number.isNaN(ms) && /^\d{4}-\d{2}-\d{2}/.test(value)) return ms;
  }
  return value;
}

/**
 * Whether an edit actually MOVES the booking's slot (issue #354 review fix,
 * fix round 2026-11-17): some schedule field in `updates` holds a value that
 * differs from the stored one. Only then is the checkout for the old slot
 * retired. Naming `scheduledDate` / `scheduledTime` / `durationMinutes` /
 * `timezone` with the value already stored is not a move.
 *
 * `timezone` counts: the same wall-clock date and time in another zone is a
 * different instant, so the client's checkout was issued for another slot.
 * Pure.
 *
 * @param current the booking as read in the edit's transaction
 * @param updates the checked values from `parseEditBody`
 */
export function slotChanges(current: Consultation, updates: EditUpdates): boolean {
  return EDIT_FIELD_GROUPS.schedule.some((field) => {
    const next = updates[field];
    if (next === undefined) return false; // not part of this edit
    const stored = (current as unknown as Record<string, unknown>)[field];
    return comparableSlotValue(next) !== comparableSlotValue(stored);
  });
}

/**
 * The fields that retire an unpaid booking's checkouts when it is
 * rescheduled (issue #354), or null when there is nothing to retire. Pure.
 *
 * A `pending_payment` booking can only be rescheduled when no payment is in
 * flight (`decideEdit`: its quote lock has passed, or its checkout never
 * opened). Every checkout it still carries was issued for the OLD slot, so
 * none may stay open:
 *  - the CURRENT one (`transactionId`) moves to `supersededCheckouts` with
 *    its own snapshot and `retiredBy: "reschedule"`, and `transactionId` /
 *    `checkoutUrl` are cleared, so `POST /consultations/:id/checkout` opens a
 *    fresh checkout priced NOW;
 *  - every checkout ALREADY in `supersededCheckouts` (older re-prices, also
 *    for the old slot) is marked `retiredBy: "reschedule"` too. Without this
 *    a late payment on one of them would still confirm the booking for the
 *    new slot at an old price.
 * A payment that lands on any of them later is refunded by `settlePayment`
 * (reason `paid_for_rescheduled_slot`) and never confirms the booking.
 *
 * Not retired: a paid or non-pending booking (nothing open), and a LEGACY
 * row with no charge snapshot (it can never be re-priced, so retiring its
 * only checkout would leave it unpayable; such rows are swept instead).
 *
 * @param booking the booking as read in the edit's transaction
 * @param at the server clock
 * @returns the update to merge into the edit, plus the stored list for the
 *   returned copy of the booking
 */
export function retireCheckoutsForReschedule(
  booking: Consultation,
  at: Date
): { update: Record<string, unknown>; supersededCheckouts: SupersededCheckout[] } | null {
  if (booking.status !== "pending_payment" || booking.paymentStatus === "paid") return null;
  if (!hasChargeSnapshot(booking)) return null;
  const older = booking.supersededCheckouts ?? [];
  const current = booking.transactionId ?? null;
  if (!current && older.length === 0) return null;
  // Issue #354 fix round: each newly retired entry records WHO moved the
  // booking (its `agentId` now, the agent side making this edit), so a later
  // payment on it debits Paystack's fee from that agent even if the case is
  // reassigned before the payment lands. An entry an EARLIER reschedule
  // already retired keeps its own record untouched: that earlier move is what
  // retired it, so its agent is the one who caused a payment on it.
  const retiredNow = { retiredBy: "reschedule" as const, retiredByAgentId: booking.agentId };
  const retired: SupersededCheckout[] = [
    ...older.map((s) => (s.retiredBy === "reschedule" ? s : { ...s, ...retiredNow })),
    ...(current ? [{ ...supersededEntryOf(booking, current, at), ...retiredNow }] : []),
  ];
  return {
    update: {
      supersededCheckouts: retired,
      transactionId: FieldValue.delete(),
      checkoutUrl: FieldValue.delete(),
    },
    supersededCheckouts: retired,
  };
}

/** What `editConsultation` did. `refused` and `not_found` wrote nothing. */
export type EditConsultationOutcome =
  | { kind: "not_found" }
  | { kind: "refused"; refusal: EditRefusal }
  | { kind: "edited"; before: Consultation; consultation: Consultation };

/**
 * What `changeStatus` did. `refused` and `not_found` wrote nothing.
 *
 * Issue #317, on `changed`:
 *  - `refund`: the booking's refund row after this change: the one this
 *    cancel just wrote (`refundCreated: true`), one that already existed
 *    (an admin refunded first), or null (no refund: free, late client
 *    cancel, not a cancel, or legacy data with no fee Transaction).
 */
export type ChangeStatusOutcome =
  | { kind: "not_found" }
  | { kind: "refused"; refusal: StatusChangeRefusal }
  | {
      kind: "changed";
      before: Consultation;
      consultation: Consultation;
      refund: Transaction | null;
      refundCreated: boolean;
      /** Issue #390: the agent's Paystack-fee debit written with the refund (agent-caused, out of the hold). */
      feeDebit: Transaction | null;
    };

/** What `deleteUnpaidConsultation` did. Only `deleted` removed anything. */
export type DeleteConsultationOutcome =
  | { kind: "not_found" }
  | { kind: "has_payment" }
  | { kind: "deleted"; consultation: Consultation };

/**
 * True when a booking CARRIES MONEY, or may still receive some (issue #151):
 *
 *  - a Paystack checkout was opened for it (`transactionId`, kept after it is
 *    paid), whatever its status; or
 *  - it is marked paid AND was charged something: a non-zero dollar price
 *    (`priceUsdCents`), a non-zero local charge (`chargedAmountMinor`), or,
 *    on a legacy row from before #180, a non-zero naira `fee`.
 *
 * A FREE booking is also stored `paymentStatus: "paid"` (with
 * `priceUsdCents: 0` and no transaction): it carries no money, so it is NOT
 * a booking with a payment and an admin may delete it.
 *
 * A booking with a payment must never be hard-deleted: a payment that lands
 * afterwards would find no booking and `settlePayment` would return null,
 * leaving the money unrecorded.
 */
export function bookingHasPayment(
  c: Pick<Consultation, "transactionId" | "paymentStatus" | "priceUsdCents" | "chargedAmountMinor" | "fee">
): boolean {
  if (c.transactionId) return true;
  /** A stored amount that is a real, positive number. */
  const positive = (v: unknown): boolean => typeof v === "number" && v > 0;
  return (
    c.paymentStatus === "paid" &&
    (positive(c.priceUsdCents) || positive(c.chargedAmountMinor) || positive(c.fee))
  );
}

// ============================================
// RESUME A PENDING BOOKING (issue #288)
// ============================================
//
// The mobile pay screen calls `POST /consultations` every time the client
// taps Pay. Without a check, a client who leaves and comes back piled up one
// `pending_payment` booking per visit for the same agent and time. The client
// flow of `POST /consultations` now FINDS the unpaid booking of that slot and
// resumes it; it only creates one when there is none.

/**
 * The slot a client books: who, with which agent, and when. Two bookings are
 * "the same slot" when all four agree.
 */
export interface BookingSlot {
  /** The client (the booking's `userId`). */
  userId: string;
  /** The agent's USER uid (the booking's `agentId`), not the agent doc id. */
  agentId: string;
  /** The day, compared as an instant (milliseconds). */
  scheduledDate: Timestamp;
  /** The time of day, already normalised to 24-hour `HH:mm`. */
  scheduledTime: string;
}

/**
 * True when `c` is an unpaid booking of exactly this slot that can still be
 * paid: `pending_payment`, not paid, priced by #180 (a legacy naira row is
 * never re-priced, so it can not be resumed either), same client, same agent,
 * same day (same instant) and same time. Pure.
 *
 * The STORED time is normalised before it is compared: rows written before
 * this issue may hold "10:00 AM" where the request now says "10:00".
 */
export function isResumableForSlot(c: Consultation, slot: BookingSlot): boolean {
  return (
    c.status === "pending_payment" &&
    c.paymentStatus !== "paid" &&
    hasChargeSnapshot(c) &&
    c.userId === slot.userId &&
    c.agentId === slot.agentId &&
    millisOf(c.scheduledDate) === slot.scheduledDate.toMillis() &&
    (normalizeScheduledTime(c.scheduledTime) ?? c.scheduledTime) === slot.scheduledTime
  );
}

/**
 * The booking to resume for a slot, out of `candidates`: the NEWEST by
 * `createdAt` of those that match (`isResumableForSlot`), or null when none
 * does. Pure. Older duplicates (made before this issue) are left alone: the
 * cleanup sweep below cancels them once they are a day past their quote lock.
 */
export function pickResumableBooking(candidates: Consultation[], slot: BookingSlot): Consultation | null {
  const matches = candidates.filter((c) => isResumableForSlot(c, slot));
  if (matches.length === 0) return null;
  // Newest first; a row with no `createdAt` (bad data) sorts last.
  matches.sort((a, b) => (millisOf(b.createdAt) ?? 0) - (millisOf(a.createdAt) ?? 0));
  return matches[0];
}

/**
 * The id of the lock document of one client + agent pair
 * (`consultationBookingLocks`, see `createOrResumePendingBooking`): a SHA-256
 * of the two uids, so the id is always a usable Firestore document id
 * whatever characters a uid holds, and the same pair always gets the same
 * document. Pure.
 */
export function bookingLockId(userId: string, agentId: string): string {
  // The newline cannot occur inside a uid, so ("ab","c") and ("a","bc") differ.
  return createHash("sha256").update(`${userId}\n${agentId}`).digest("hex");
}

/** What `createOrResumePendingBooking` did: wrote a new booking, or found the slot's unpaid one. */
export type CreateOrResumeOutcome =
  | { kind: "created"; consultation: Consultation }
  | { kind: "existing"; consultation: Consultation };

// ============================================
// CLEANUP OF ABANDONED BOOKINGS (issue #288)
// ============================================
//
// Nothing used to close a `pending_payment` booking its client walked away
// from. An hourly job (`sweepAbandonedConsultations` in index.ts) now cancels
// those whose quote lock ended more than a day ago, after asking Paystack
// whether the booking's checkout was paid after all.

/** How long after its quote lock ended an unpaid booking is cancelled, in hours. */
export const ABANDONED_BOOKING_GRACE_HOURS = 24;
/** The most bookings one sweep run looks at. */
export const ABANDONED_SWEEP_BATCH_SIZE = 200;
/** `cancelledBy` of a booking the sweep closed (no user did it). */
export const SYSTEM_CANCEL_ACTOR = "system";
/** `cancellationReason` of a booking the sweep closed: a sentence the client can read. */
export const SYSTEM_CANCELLATION_REASON = "Cancelled by Seli: this booking wasn't paid in time. Please book again.";

/** Milliseconds in an hour (kept named so the cutoff maths reads plainly). */
const HOUR_MS = 60 * 60 * 1000;

/**
 * The latest `quoteExpiresAt` a booking may have and still be swept at time
 * `at`: bookings whose lock ended BEFORE this instant are abandoned. Pure.
 */
export function abandonedCutoff(at: Date): Date {
  return new Date(at.getTime() - ABANDONED_BOOKING_GRACE_HOURS * HOUR_MS);
}

/**
 * True when `c` is an unpaid booking the sweep may close at time `at`:
 * `pending_payment`, not paid, and its payment grace started more than
 * ABANDONED_BOOKING_GRACE_HOURS ago. Pure.
 *
 * The grace starts at the LATER of (issue #405):
 *  - `quoteExpiresAt`: the end of the booking's quote lock (as before);
 *  - `paymentGraceStartsAt`: the last time the agent side moved the booking
 *    while it was unpaid (`gracePeriodRestartForReschedule`). A move after
 *    the lock restarts the 24 hours, so the client always gets a full day
 *    to pay for the new time.
 *
 * A LEGACY row (before #180: no `quoteExpiresAt`) is never abandoned in this
 * sense: the one-off `cancel:legacy-consultations` script covers those.
 */
export function isAbandonedBooking(
  c: Pick<Consultation, "status" | "paymentStatus" | "quoteExpiresAt" | "paymentGraceStartsAt"> &
    Partial<Pick<Consultation, "bookedVia" | "payLinkExpiresAt" | "scheduledDate" | "scheduledTime" | "timezone">>,
  at: Date
): boolean {
  const expiresAt = millisOf(c.quoteExpiresAt);
  if (expiresAt === null) return false; // legacy row
  // Issue #405: a reschedule after the lock pushes the start of the grace.
  const rescheduledAt = millisOf(c.paymentGraceStartsAt);
  const graceStart = rescheduledAt !== null ? Math.max(expiresAt, rescheduledAt) : expiresAt;
  return (
    c.status === "pending_payment" &&
    c.paymentStatus !== "paid" &&
    graceStart < abandonedCutoff(at).getTime() &&
    // Issue #411 (from #391): a guest's live pay link keeps the booking open.
    !guestPayLinkStillLive(c, at)
  );
}

/**
 * True when a GUEST booking (`bookedVia: "public_page"`) still has a live
 * one-time pay link at `at` (issue #411, orchestrator decision 2026-11-21,
 * from #391). Pure.
 *
 * #391 emails a guest whose booking the agent side moved after its lock a
 * pay link that lasts up to 72 hours, capped at the slot start, and stores
 * its expiry on the booking as `payLinkExpiresAt`. While it is live the
 * sweep must not cancel the booking, so for a guest booking the payment
 * grace runs until the LATER of the normal grace and the link's expiry,
 * and never past the slot start:
 *   the link counts until min(payLinkExpiresAt, slot start).
 * The normal 24-hour grace is never shortened by this (it is the "later of").
 *
 * A slot that cannot be read (bad stored data) leaves the link's own expiry
 * as the limit: a longer grace is the safe side (nothing is cancelled early).
 * Bookings not made on the public page ignore the field.
 */
export function guestPayLinkStillLive(
  c: Partial<Pick<Consultation, "bookedVia" | "payLinkExpiresAt" | "scheduledDate" | "scheduledTime" | "timezone">>,
  at: Date
): boolean {
  if (c.bookedVia !== "public_page") return false;
  const linkExpiresAt = millisOf(c.payLinkExpiresAt);
  if (linkExpiresAt === null) return false;
  let limit = linkExpiresAt;
  try {
    // Never past the slot start (#391 already caps the link there; this
    // keeps the sweep right even if a stored expiry is later).
    limit = Math.min(linkExpiresAt, slotStartsAt(c as Pick<Consultation, "scheduledDate" | "scheduledTime" | "timezone">).getTime());
  } catch {
    // Unreadable slot: keep the link's own expiry (see above).
  }
  return at.getTime() < limit;
}

/**
 * The field that restarts an unpaid booking's 24-hour payment grace when the
 * agent side moves it (issue #405), or null when it does not apply. Pure.
 *
 * Applies to a `pending_payment`, unpaid booking whose slot REALLY changes
 * (the caller checks `slotChanges`, as for `retireCheckoutsForReschedule`),
 * whether or not it had a checkout to retire: a booking moved after its
 * quote lock could otherwise be swept before the client could pay for the
 * new time. Within the lock it is harmless (the later of the two wins).
 * No money moves here: it only moves the sweep's clock.
 *
 * @param booking the booking as read in the edit's transaction
 * @param at the server clock of the edit
 */
export function gracePeriodRestartForReschedule(
  booking: Pick<Consultation, "status" | "paymentStatus">,
  at: Date
): { paymentGraceStartsAt: Timestamp } | null {
  if (booking.status !== "pending_payment" || booking.paymentStatus === "paid") return null;
  return { paymentGraceStartsAt: Timestamp.fromDate(at) };
}

/**
 * What the sweep does with one booking:
 *  - `skip`:   not abandoned (paid or cancelled meanwhile, legacy, too recent);
 *  - `settle`: Paystack says its checkout was PAID: confirm it, never cancel;
 *  - `leave`:  a payment may still land on it (or Paystack was not asked): try again next run;
 *  - `cancel`: nobody paid and nobody can any more: close it.
 */
export type AbandonedBookingDecision = "skip" | "settle" | "leave" | "cancel";

/**
 * Decide what the sweep does with one booking. Pure: reads nothing, writes
 * nothing, so tests (and the emulators) can run it at any clock time.
 *
 * @param paystack what Paystack reports about the booking's CURRENT checkout
 *   (`lookupCheckoutState`), or null when it was not asked. A booking with no
 *   `transactionId` has no checkout to ask about and is cancelled; a booking
 *   WITH one that was not looked up is left alone (fail closed).
 * @param at the time of the decision (the charge path's clock)
 */
export function decideAbandonedBooking(
  c: Pick<Consultation, "status" | "paymentStatus" | "quoteExpiresAt" | "paymentGraceStartsAt" | "transactionId"> &
    Partial<Pick<Consultation, "bookedVia" | "payLinkExpiresAt" | "scheduledDate" | "scheduledTime" | "timezone">>,
  paystack: PaystackState | null,
  at: Date
): AbandonedBookingDecision {
  if (!isAbandonedBooking(c, at)) return "skip";
  // No checkout was ever claimed: there is nothing anyone could have paid.
  if (!c.transactionId) return "cancel";
  if (paystack === "paid") return "settle";
  if (paystack === "final_unpaid") return "cancel";
  // `in_progress` (a bank transfer may still complete), or not looked up.
  return "leave";
}

// ---- Every checkout of a booking, not just the live one (issue #397) ----
//
// `decideAbandonedBooking` above only knows about the LIVE checkout
// (`transactionId`). A booking can also carry older checkouts in
// `supersededCheckouts`: ones replaced by an ordinary re-price, and ones
// RETIRED when the agent side rescheduled the booking after its quote lock
// (#354, `retiredBy: "reschedule"`, which also clears `transactionId`). A
// bank transfer still running on any of them can land later, so the sweep
// now asks Paystack about EVERY checkout and decides on all the answers at
// once (`decideAbandonedCheckouts`). `decideAbandonedBooking` is kept as it
// was for its callers and tests (it is the live-checkout-only case).

/**
 * What the sweep learned about ONE checkout reference of a booking:
 * Paystack's classified state (`lookupCheckoutState`, which already turns
 * "not found" on one of OUR references into `final_unpaid`), or
 * `lookup_failed` when asking Paystack threw (network, 5xx, 401, or "not
 * found" for a reference Paystack itself generated). Fail closed: a failed
 * lookup never lets the booking be cancelled.
 */
export type SweepCheckoutState =
  | PaystackState
  | "lookup_failed"
  // Issue #411: PAID, and already recorded as an exception and refunded by
  // `settlePayment` on an earlier run (`paid_handled` on the booking). Not
  // looked up again; like a handled settle (#397) it never blocks the cancel.
  | "handled";

/**
 * Every checkout reference a booking carries, live first (`transactionId`),
 * then each `supersededCheckouts` entry in stored order, with duplicates
 * dropped. Pure. These are exactly the references the sweep looks up (one
 * Paystack call each) and that `cancelAbandonedBooking` checks again before
 * it writes.
 */
export function sweepCheckoutReferences(
  c: Pick<Consultation, "transactionId" | "supersededCheckouts">
): string[] {
  const refs = [
    ...(c.transactionId ? [c.transactionId] : []),
    ...(c.supersededCheckouts ?? []).map((s) => s.reference).filter((r): r is string => !!r),
  ];
  return [...new Set(refs)];
}

/**
 * What the sweep does with one booking once every checkout was looked up:
 *  - `skip`:   not abandoned (paid, cancelled, legacy, too recent, or its
 *              payment grace restarted by a recent reschedule, #405);
 *  - `error`:  at least one lookup failed: nothing written (fail closed);
 *  - `leave`:  a payment may still land on at least one checkout (Paystack
 *              `in_progress`), or a checkout was not looked up: nothing
 *              written, a later run tries again;
 *  - `settle`: every checkout is known and none is in flight, and these
 *              `references` are PAID: each goes through `settlePayment`,
 *              whose outcomes decide the rest (`decideAfterSweepSettles`);
 *  - `cancel`: every checkout is final and unpaid (or there is none).
 */
export type AbandonedCheckoutsDecision =
  | { kind: "skip" }
  | { kind: "error" }
  | { kind: "leave" }
  | { kind: "settle"; references: string[] }
  | { kind: "cancel" };

/**
 * Decide what the sweep does with one booking from the state of EVERY one
 * of its checkouts (issue #397). Pure: reads nothing, writes nothing.
 *
 * Order of the rules (the first that applies is the answer):
 *  1. not abandoned (`isAbandonedBooking`): `skip`. The sweep checks this
 *     BEFORE any lookup, so such a booking costs no Paystack call;
 *  2. no checkout at all: `cancel` (nobody could have paid);
 *  3. any lookup failed: `error` (never cancel without Paystack's answer);
 *  4. any checkout `in_progress`, or one that was not looked up: `leave`.
 *     This wins over a `paid` one on purpose: the sweep writes only on a
 *     complete, settled picture. A paid checkout is still settled by the
 *     payer's verify, or by a later run once the other one is final;
 *  5. any checkout `paid`: `settle` those references (live first);
 *  6. otherwise (all `final_unpaid`, or `handled`: paid and already
 *     recorded and refunded on an earlier run, issue #411): `cancel`.
 *
 * @param states reference -> what the sweep learned about it. A reference
 *   of the booking that is missing here counts as not looked up (rule 4).
 * @param at the time of the decision (the charge path's clock)
 */
export function decideAbandonedCheckouts(
  c: Pick<
    Consultation,
    "status" | "paymentStatus" | "quoteExpiresAt" | "paymentGraceStartsAt" | "transactionId" | "supersededCheckouts"
  > &
    Partial<Pick<Consultation, "bookedVia" | "payLinkExpiresAt" | "scheduledDate" | "scheduledTime" | "timezone">>,
  states: ReadonlyMap<string, SweepCheckoutState>,
  at: Date
): AbandonedCheckoutsDecision {
  // (1) Not abandoned: nothing to decide (and nothing was asked).
  if (!isAbandonedBooking(c, at)) return { kind: "skip" };
  const references = sweepCheckoutReferences(c);
  // (2) No checkout was ever claimed, live or older: nothing could be paid.
  if (references.length === 0) return { kind: "cancel" };
  const seen = references.map((reference) => ({ reference, state: states.get(reference) }));
  // (3) Fail closed on any lookup error.
  if (seen.some((s) => s.state === "lookup_failed")) return { kind: "error" };
  // (4) A payment may still land somewhere (or we do not know): wait.
  if (seen.some((s) => s.state === undefined || s.state === "in_progress")) return { kind: "leave" };
  // (5) Paid somewhere: hand every paid reference to settlePayment.
  const paid = seen.filter((s) => s.state === "paid").map((s) => s.reference);
  if (paid.length > 0) return { kind: "settle", references: paid };
  // (6) Every checkout is final and unpaid.
  return { kind: "cancel" };
}

/**
 * Settle outcomes after which a paid reference no longer stands in the way
 * of the cancel (issue #397): the payment is recorded as an exception and
 * refunded under #354's rules INSIDE `settlePayment` (one refund per
 * reference, one fee debit per reference). The booking itself was not
 * confirmed by it.
 */
const SWEEP_HANDLED_SETTLES: ReadonlySet<string> = new Set([
  "rescheduled_refund_recorded",
  "refund_recorded",
  "not_payable_recorded",
]);

/**
 * Issue #411: THE one test of "this settle outcome is handled" (recorded as
 * an exception and refunded by `settlePayment`, see SWEEP_HANDLED_SETTLES).
 * Used by `decideAfterSweepSettles`, by the sweep's per-reference log line
 * and by the bookkeeping (`paid_handled`), so the list is never repeated
 * inline. Pure.
 */
export function isHandledSweepSettle(outcome: SettleOutcome | null | undefined): boolean {
  return !!outcome && SWEEP_HANDLED_SETTLES.has(outcome.kind);
}

/**
 * Issue #411: true when a settle CONFIRMED the booking (`confirmed`), or
 * found it already paid by that very reference (`already_paid`). Pure.
 */
export function isConfirmingSweepSettle(outcome: SettleOutcome | null | undefined): boolean {
  return outcome?.kind === "confirmed" || outcome?.kind === "already_paid";
}

/**
 * What the sweep does with a booking after it settled each of its paid
 * checkouts (issue #397). Pure.
 *  - `settled`: at least one settle confirmed the booking (`confirmed`), or
 *    found it already paid by that very reference (`already_paid`). Never
 *    cancelled;
 *  - `review`:  a paid reference could not be applied or recorded
 *    (`mismatch`, `not_chargeable`, `unknown_reference`, or null: the
 *    booking is gone). Left exactly as it is for a human; never cancelled;
 *  - `cancel`:  every paid reference was recorded as an exception and
 *    refunded (`rescheduled_refund_recorded`, `refund_recorded`,
 *    `not_payable_recorded`), and the decision already found every OTHER
 *    checkout final and unpaid: the booking is cancelled in this run (the
 *    cancel still re-checks everything in its own transaction). A paid,
 *    refunded retired checkout therefore never keeps a booking alive.
 *
 * @param outcomes one per paid reference, in the order they were settled
 */
export function decideAfterSweepSettles(
  outcomes: ReadonlyArray<SettleOutcome | null>
): "settled" | "review" | "cancel" {
  if (outcomes.some((o) => isConfirmingSweepSettle(o))) return "settled";
  // Issue #411: the handled rule comes from ONE helper (no inline list).
  if (outcomes.some((o) => !isHandledSweepSettle(o))) return "review";
  return "cancel";
}

/**
 * The references in a booking's `supersededCheckouts`, in stored order.
 * Pure. The sweep remembers this list from the booking it looked up, and
 * the cancel compares it with the fresh booking (`sameReferenceSet`): a
 * checkout opened, re-priced or retired after the lookups changes it.
 */
function supersededReferencesOf(c: Partial<Pick<Consultation, "supersededCheckouts">>): string[] {
  return (c.supersededCheckouts ?? []).map((s) => s.reference);
}

/**
 * True when two lists of checkout references hold the same references,
 * whatever their order. Pure.
 */
function sameReferenceSet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((r) => right.has(r));
}

// ---- Stuck bookings, bounded lookups (issue #411) ----
//
// Some bookings never resolve: a bank transfer that stays "in progress" at
// Paystack, a paid checkout `settlePayment` cannot apply (wrong amount), a
// reference Paystack keeps failing on. Before #411 each of those took one of
// the ABANDONED_SWEEP_BATCH_SIZE slots, and paid for one Paystack call per
// checkout, EVERY hour, forever; 200 of them would starve every new booking.
//
// Now the sweep keeps a little bookkeeping on the booking (`sweepReview`,
// `sweepSetAside`; sweep-owned, never read by the money paths):
//  - each reference whose state is FINAL (final unpaid, or paid and settled
//    by `settlePayment`) is recorded and never looked up again;
//  - lookups run retired checkouts first (stored order), then the live one,
//    and stop at the first checkout still in progress (the booking cannot be
//    cancelled this run anyway);
//  - a run makes at most SWEEP_MAX_LOOKUPS_PER_RUN Paystack calls; the
//    bookings it did not reach are left for the next run (`leftForCap`);
//  - every run that leaves a booking unresolved counts (`unresolvedRuns`);
//    after SWEEP_SET_ASIDE_AFTER_RUNS such runs on the same checkouts and
//    grace (`sweepFingerprint`) the booking is SET ASIDE: the query skips
//    it and admins see it in `GET /consultations/sweep-review`;
//  - even while a booking is left, every PAID retired checkout found is
//    settled through `settlePayment` (the client's money is refunded now;
//    only the cancel waits).
// The sweep still never writes a money row itself.

/**
 * Unresolved runs (same checkouts, same grace) after which the sweep sets a
 * booking aside (issue #411). The sweep runs hourly, so 24 is one day of a
 * booking that never resolves: long enough for an ordinary bank transfer to
 * land, short enough that a stuck one stops costing lookups the next day.
 */
export const SWEEP_SET_ASIDE_AFTER_RUNS = 24;

/**
 * The most Paystack lookups ONE sweep run makes, over all its bookings
 * (issue #411). A full batch of ordinary bookings (one checkout each) needs
 * 200; the headroom covers re-priced and rescheduled ones. Bookings not
 * reached are left for the next run (counted in `leftForCap`).
 */
export const SWEEP_MAX_LOOKUPS_PER_RUN = 300;

/**
 * Review round 1 (orchestrator note 3): how long ONE sweep run may work
 * before it leaves the remaining bookings for the next run, in ms. The
 * scheduled function times out at 540 s (index.ts); 420 s leaves room for
 * the booking in hand (a few Paystack lookups of at most
 * PAYSTACK_LOOKUP_TIMEOUT_MS each, its settles and its cancel).
 */
export const SWEEP_TIME_BUDGET_MS = 420_000;

/**
 * The sweep's REAL clock for its time budget (review round 1). Not the
 * charge clock (`chargeRuntime.now`, which tests fix): a property bag so a
 * test can make time pass. Production never changes it.
 */
export const sweepRuntime = {
  wallClockMs: (): number => Date.now(),
};

/**
 * The order the sweep looks a booking's checkouts up in (issue #411):
 * every `supersededCheckouts` entry in stored order (oldest first), then
 * the live one (`transactionId`), duplicates dropped. Pure.
 *
 * Retired checkouts come first so that, when the lookups stop at a checkout
 * still in progress, every retired one before it was asked about: a paid
 * one there is settled (and refunded) in the same run.
 */
export function sweepLookupOrder(c: Pick<Consultation, "transactionId" | "supersededCheckouts">): string[] {
  const refs = [
    ...(c.supersededCheckouts ?? []).map((s) => s.reference).filter((r): r is string => !!r),
    ...(c.transactionId ? [c.transactionId] : []),
  ];
  return [...new Set(refs)];
}

/**
 * A short string that changes whenever what the sweep decides on changes
 * (issue #411): the status, whether it is paid, the live reference, the set
 * of superseded references, the quote lock, the grace restart and a guest's
 * pay link. Pure.
 *
 * The unresolved counter only grows while this stays the same, and a
 * set-aside booking whose fingerprint changed (re-priced, rescheduled, a new
 * pay link: written by code the sweep does not own) is released by the
 * sweep's release pass. Sorted superseded references: their order is not a
 * change.
 */
export function sweepFingerprint(
  c: Partial<
    Pick<
      Consultation,
      | "status" | "paymentStatus" | "transactionId" | "supersededCheckouts"
      | "quoteExpiresAt" | "paymentGraceStartsAt" | "payLinkExpiresAt"
    >
  >
): string {
  return JSON.stringify([
    c.status ?? null,
    c.paymentStatus ?? null,
    c.transactionId ?? null,
    [...supersededReferencesOf(c)].sort(),
    millisOf(c.quoteExpiresAt),
    millisOf(c.paymentGraceStartsAt),
    millisOf(c.payLinkExpiresAt),
  ]);
}

/** The recorded states that are FINAL: the sweep never asks Paystack about them again. */
const FINAL_RECORDED_STATES: ReadonlySet<SweepCheckoutKnownState> = new Set<SweepCheckoutKnownState>([
  "final_unpaid",
  "paid_handled",
  "paid_confirmed",
]);

/**
 * The FINAL recorded state of each reference of a booking (issue #411):
 * reference -> the decision state it stands for (`final_unpaid`, or
 * `handled` for a paid one already recorded and refunded). Pure.
 * `paid_confirmed` maps to `handled` too: such a booking is paid, so it is
 * skipped before any of this is read.
 */
export function recordedFinalStates(c: Pick<Consultation, "sweepReview">): Map<string, SweepCheckoutState> {
  const out = new Map<string, SweepCheckoutState>();
  for (const record of c.sweepReview?.checkouts ?? []) {
    if (!record.final || !FINAL_RECORDED_STATES.has(record.state)) continue;
    out.set(record.reference, record.state === "final_unpaid" ? "final_unpaid" : "handled");
  }
  return out;
}

/**
 * The recorded state of a reference after a settle (issue #411). Pure.
 */
function recordForSettle(reference: string, outcome: SettleOutcome | null, at: Timestamp): SweepCheckoutRecord {
  const state: SweepCheckoutKnownState = isConfirmingSweepSettle(outcome)
    ? "paid_confirmed"
    : isHandledSweepSettle(outcome)
      ? "paid_handled"
      : "paid_review";
  return {
    reference,
    state,
    final: FINAL_RECORDED_STATES.has(state),
    checkedAt: at,
    settleOutcome: outcome?.kind ?? "booking_gone",
  };
}

/**
 * Merge newly learned records into the stored ones, by reference (the new
 * one wins). Pure. Stored order is kept; new references are appended.
 */
export function mergeSweepRecords(
  stored: readonly SweepCheckoutRecord[] | undefined,
  fresh: readonly SweepCheckoutRecord[]
): SweepCheckoutRecord[] {
  const byRef = new Map<string, SweepCheckoutRecord>();
  for (const r of stored ?? []) byRef.set(r.reference, r);
  for (const r of fresh) byRef.set(r.reference, r);
  return [...byRef.values()];
}

/**
 * What the counter of a booking becomes after one run (issue #411). Pure.
 *
 * @param stored the booking's `sweepReview` as re-read in the write's transaction
 * @param observedFingerprint the fingerprint of the booking the run looked up
 * @param freshFingerprint the fingerprint of the booking as re-read now
 * @param unresolved why the run left it, or null when the run is not counted
 *   (the lookup cap, a booking handled in another way)
 * @returns the new count, and whether it reaches SWEEP_SET_ASIDE_AFTER_RUNS
 */
export function nextSweepCount(
  stored: ConsultationSweepReview | undefined,
  observedFingerprint: string,
  freshFingerprint: string,
  unresolved: SweepUnresolvedOutcome | null
): { unresolvedRuns: number; setAside: boolean } {
  // The count only carries over while the booking stayed the same.
  const base = stored && stored.fingerprint === observedFingerprint ? stored.unresolvedRuns : 0;
  // Changed between the lookups and this write (a re-price, a move...): the
  // run learned nothing about the NEW checkouts; start over.
  if (freshFingerprint !== observedFingerprint) return { unresolvedRuns: 0, setAside: false };
  if (unresolved === null) return { unresolvedRuns: base, setAside: false };
  const unresolvedRuns = base + 1;
  return { unresolvedRuns, setAside: unresolvedRuns >= SWEEP_SET_ASIDE_AFTER_RUNS };
}

/** What `lookUpSweepCheckouts` learned about one booking. */
interface SweepLookups {
  /** reference -> decision state (recorded finals included). */
  states: Map<string, SweepCheckoutState>;
  /** reference -> Paystack's answer, for each reference looked up THIS time. */
  lookups: Map<string, Awaited<ReturnType<typeof lookupCheckoutState>>>;
  /** What to record for each reference looked up this time. */
  records: SweepCheckoutRecord[];
  /** Why the lookups stopped early, or null when every reference was answered. */
  stoppedBy: "in_progress" | "lookup_failed" | "not_found" | "cap" | null;
  /** Paystack calls made. */
  calls: number;
  /**
   * Review round 1: at least one lookup failed because Paystack could not
   * answer (network, 5xx, timeout, auth; not "not found"). Not counted
   * toward set-aside, the same as #413's fee job.
   */
  outage: boolean;
}

/**
 * Ask Paystack about a booking's checkouts, in `sweepLookupOrder`, for the
 * sweep and the admin sweep-review actions (issue #411).
 *
 *  - a reference with a FINAL recorded state is not looked up (unless
 *    `fresh`: an admin's re-check asks about everything again);
 *  - the lookups stop at the first checkout still IN PROGRESS, at the first
 *    failed lookup (fail closed), or when `budget` runs out (`cap`);
 *  - "not found" for a reference Paystack generated itself is told apart
 *    from other failures (`not_found`), but both count as `lookup_failed`
 *    for the decision: never cancelled on it.
 *
 * Reads Paystack only; writes nothing.
 *
 * @param budget the lookups left in this run (decremented), or null for none
 */
async function lookUpSweepCheckouts(
  booking: Consultation,
  options: {
    /**
     * `deadline` (review round 2): the run's wall-clock end (`sweepRuntime`
     * ms). Past it no further lookup starts: the rest waits, as for the cap.
     */
    budget: { remaining: number; deadline?: number } | null;
    fresh: boolean;
    at: Timestamp;
    logId: string;
    /**
     * Issue #411 (decision 2026-11-21): ask about exactly these references
     * (in this order) instead of the booking's whole `sweepLookupOrder`.
     * Used by the re-check before a cancel.
     */
    references?: readonly string[];
  }
): Promise<SweepLookups> {
  const states = options.fresh ? new Map<string, SweepCheckoutState>() : recordedFinalStates(booking);
  const out: SweepLookups = { states, lookups: new Map(), records: [], stoppedBy: null, calls: 0, outage: false };
  const order = options.references ?? sweepLookupOrder(booking);
  // Review round 1 (orchestrator, #411 note 1): the LIVE checkout is always
  // asked about, even when an older one stopped the lookups (in progress,
  // or a failed lookup): a paid live checkout must always be reachable and
  // settled (a confirming settle is always safe; a later payment elsewhere
  // is refunded by settlePayment). It is the last in `sweepLookupOrder`.
  const live = booking.transactionId && order.includes(booking.transactionId) ? booking.transactionId : null;
  /** Ask Paystack about one reference; false when the run's budget is spent. */
  const ask = async (reference: string): Promise<boolean> => {
    if (options.budget && options.budget.remaining <= 0) return false;
    if (options.budget?.deadline !== undefined && sweepRuntime.wallClockMs() >= options.budget.deadline) return false;
    if (options.budget) options.budget.remaining--;
    out.calls++;
    try {
      const lookup = await lookupCheckoutState(reference);
      states.set(reference, lookup.state);
      out.lookups.set(reference, lookup);
      if (lookup.state === "final_unpaid") {
        out.records.push({ reference, state: "final_unpaid", final: true, checkedAt: options.at });
      } else if (lookup.state === "in_progress") {
        out.records.push({ reference, state: "in_progress", final: false, checkedAt: options.at });
        out.stoppedBy ??= "in_progress";
      }
      // `paid`: recorded once settlePayment has answered (recordForSettle).
    } catch (error) {
      const failure = isPaystackReferenceNotFound(error) ? "not_found" : "lookup_failed";
      console.error(
        `[consultation sweep] ${options.logId}: Paystack lookup of ${reference} failed (${failure}); not cancelled:`,
        error
      );
      states.set(reference, "lookup_failed");
      out.records.push({ reference, state: failure, final: false, checkedAt: options.at });
      out.stoppedBy ??= failure;
      // Review round 1 (#411 note 2): Paystack could not answer (network,
      // 5xx, timeout, 401). Such a run is not counted toward set-aside.
      if (failure === "lookup_failed") out.outage = true;
    }
    return true;
  };
  for (const reference of order) {
    // Final and recorded: costs nothing (criterion 2).
    if (states.has(reference)) continue;
    // A run (budget) stops at the first checkout that rules a cancel out;
    // an admin (no budget) asks about every checkout (review round 1).
    if (options.budget && out.stoppedBy !== null) break;
    if (!(await ask(reference))) {
      // The run's Paystack budget is spent: the rest waits for the next run.
      out.stoppedBy = "cap";
      break;
    }
  }
  // The live checkout, if the loop stopped before it (budget permitting).
  // (Budget spent: it waits for the next run like any other reference.)
  if (live && !states.has(live) && out.stoppedBy !== null && out.stoppedBy !== "cap") await ask(live);
  return out;
}

/**
 * The PAID superseded (retired or re-priced) references among what was
 * looked up, in lookup order (issue #411). Pure. These are settled even
 * when the booking itself is left: the live checkout is never among them
 * (it is looked up last, so a booking left in progress never reached it).
 */
function paidSupersededReferences(
  c: Pick<Consultation, "supersededCheckouts">,
  states: ReadonlyMap<string, SweepCheckoutState>
): string[] {
  const superseded = new Set(supersededReferencesOf(c));
  return sweepLookupOrder({ supersededCheckouts: c.supersededCheckouts }).filter(
    (reference) => superseded.has(reference) && states.get(reference) === "paid"
  );
}

/**
 * The PAID references to settle while a booking is LEFT (a checkout in
 * progress, or a failed lookup): review round 1 of #411 (orchestrator note
 * 1), the LIVE checkout first when it is paid (a confirming settle is always
 * safe, so the client's payment is applied however an older checkout
 * stands), then every paid superseded one (`paidSupersededReferences`:
 * refunded, or confirming at its own price). Pure.
 */
export function paidReferencesWhileLeft(
  c: Pick<Consultation, "transactionId" | "supersededCheckouts">,
  states: ReadonlyMap<string, SweepCheckoutState>
): string[] {
  const live = c.transactionId && states.get(c.transactionId) === "paid" ? [c.transactionId] : [];
  return [...live, ...paidSupersededReferences(c, states).filter((r) => r !== c.transactionId)];
}

/**
 * Send refund notices a sweep run (or an admin sweep cancel) deferred,
 * once (issue #411, review round 1). `bookingCancelled`: the booking was
 * cancelled right after the refunds, so a moved booking's refund says so
 * and never asks the client to pay again. Never throws.
 */
async function sendNotices(notices: readonly DeferredRefundNotice[], bookingCancelled: boolean): Promise<void> {
  for (const notice of notices) await sendDeferredRefundNotice(notice, { bookingCancelled });
}

/** The most set-aside bookings the admin list returns and the release pass reads. */
export const SWEEP_REVIEW_LIST_LIMIT = 500;

/**
 * Set-aside, still-unpaid bookings, oldest lock first (issue #411): the
 * release pass and the admin list. Same composite index as the sweep's
 * query: consultations(status, sweepSetAside, quoteExpiresAt).
 */
function setAsideBookingsQuery(): FirebaseFirestore.Query {
  return collections.consultations
    .where("status", "==", "pending_payment")
    .where("sweepSetAside", "==", true)
    .orderBy("quoteExpiresAt", "asc")
    .limit(SWEEP_REVIEW_LIST_LIMIT);
}

/**
 * The fields that take a booking OUT of set-aside (issue #411): the marker
 * off, the counter back to 0 (its fingerprint now the booking's own), no
 * `setAsideAt`. The recorded references are kept, plus `extraRecords`. Pure.
 */
function releasedSweepFields(
  fresh: Consultation,
  extraRecords: readonly SweepCheckoutRecord[] = [],
  fingerprint: string = sweepFingerprint(fresh)
): Record<string, unknown> {
  const stored = fresh.sweepReview;
  const review: ConsultationSweepReview = {
    unresolvedRuns: 0,
    fingerprint,
    checkouts: mergeSweepRecords(stored?.checkouts, extraRecords),
  };
  if (stored?.lastOutcome) review.lastOutcome = stored.lastOutcome;
  if (stored?.lastRunAt) review.lastRunAt = stored.lastRunAt;
  return { sweepSetAside: false, sweepReview: review };
}

/** A Firestore Timestamp (or anything with `toDate`) as an ISO string, or null. */
function isoOf(value: unknown): string | null {
  const ms = millisOf(value);
  return ms === null ? null : new Date(ms).toISOString();
}

/**
 * One checkout of a set-aside booking, as the admin list shows it (issue #411).
 *  - `kind`: `live` (`transactionId`), `retired` (retired by a reschedule,
 *    #354) or `superseded` (replaced by an ordinary re-price);
 *  - `state`: its last known state (`SweepCheckoutKnownState`), or
 *    `not_checked` when the sweep never got to it (its lookups stopped at an
 *    earlier checkout still in progress).
 */
export interface SweepReviewCheckout {
  reference: string;
  kind: "live" | "retired" | "superseded";
  state: SweepCheckoutKnownState | "not_checked";
  final: boolean;
  checkedAt: string | null;
  settleOutcome: string | null;
}

/** One row of `GET /consultations/sweep-review` (issue #411). Dates are ISO strings. */
export interface SweepReviewItem {
  consultationId: string;
  status: Consultation["status"];
  bookedVia: string | null;
  userId: string;
  clientName: string;
  clientEmail: string;
  agentId: string;
  agentName: string;
  agencyId: string | null;
  scheduledDate: string | null;
  scheduledTime: string | null;
  timezone: string | null;
  quoteExpiresAt: string | null;
  paymentGraceStartsAt: string | null;
  /** Consecutive unresolved sweep runs (SWEEP_SET_ASIDE_AFTER_RUNS or more once set aside). */
  unresolvedRuns: number;
  lastOutcome: SweepUnresolvedOutcome | null;
  lastRunAt: string | null;
  setAsideAt: string | null;
  /** Times the agent side moved it while unpaid (#405 grace restarts). */
  graceRestartCount: number;
  checkouts: SweepReviewCheckout[];
}

/** A set-aside booking as one admin-list row. Pure. */
export function sweepReviewItemOf(c: Consultation): SweepReviewItem {
  const recorded = new Map((c.sweepReview?.checkouts ?? []).map((r) => [r.reference, r]));
  const supersededByRef = new Map((c.supersededCheckouts ?? []).map((s) => [s.reference, s]));
  const checkouts = sweepLookupOrder(c).map((reference): SweepReviewCheckout => {
    const entry = supersededByRef.get(reference);
    const record = recorded.get(reference);
    return {
      reference,
      kind: !entry ? "live" : entry.retiredBy === "reschedule" ? "retired" : "superseded",
      state: record?.state ?? "not_checked",
      final: record?.final ?? false,
      checkedAt: isoOf(record?.checkedAt),
      settleOutcome: record?.settleOutcome ?? null,
    };
  });
  return {
    consultationId: c.id,
    status: c.status,
    bookedVia: c.bookedVia ?? null,
    userId: c.userId,
    clientName: c.clientName,
    clientEmail: c.clientEmail,
    agentId: c.agentId,
    agentName: c.agentName,
    agencyId: c.agencyId ?? null,
    scheduledDate: isoOf(c.scheduledDate),
    scheduledTime: c.scheduledTime ?? null,
    timezone: c.timezone ?? null,
    quoteExpiresAt: isoOf(c.quoteExpiresAt),
    paymentGraceStartsAt: isoOf(c.paymentGraceStartsAt),
    unresolvedRuns: c.sweepReview?.unresolvedRuns ?? 0,
    lastOutcome: c.sweepReview?.lastOutcome ?? null,
    lastRunAt: isoOf(c.sweepReview?.lastRunAt),
    setAsideAt: isoOf(c.sweepReview?.setAsideAt),
    graceRestartCount: c.graceRestartCount ?? 0,
    checkouts,
  };
}

/** What an admin's fresh check of a booking found (internal, issue #411). */
interface AdminSweepCheck {
  /**
   * `paid`: a settle confirmed the booking; `not_abandoned`: its grace runs
   * again (or it changed); `clear`: nothing in flight, nothing unapplied
   * (the sweep would cancel it); otherwise why it is still unresolved.
   */
  verdict: "paid" | "not_abandoned" | "clear" | "in_progress" | "review" | "lookup_failed" | "not_found";
  /** What to record for each reference looked up or settled. */
  records: SweepCheckoutRecord[];
  /** Review round 1: refund notices the check's settles deferred (sent by the caller, once). */
  notices: DeferredRefundNotice[];
}

/** What `adminRecheckSweepReview` did (issue #411). */
export type AdminRecheckOutcome =
  | { kind: "not_found" }
  | { kind: "not_set_aside" }
  | { kind: "settled"; consultation: Consultation | null }
  | { kind: "released"; consultation: Consultation | null }
  | {
      kind: "still_unresolved";
      reason: "in_progress" | "review" | "lookup_failed" | "not_found";
      item: SweepReviewItem | null;
    };

/** What `adminCancelSweepBooking` did (issue #411). Only `cancelled` wrote the cancel. */
export type AdminSweepCancelOutcome =
  | { kind: "not_found" }
  /** Not `pending_payment`, or paid. */
  | { kind: "not_pending" }
  /** Its payment grace still runs (#405 restart, a guest's live pay link, #411). */
  | { kind: "grace_running" }
  /** A paid checkout confirmed the booking during the check (through settlePayment). */
  | { kind: "paid" }
  /** Something still blocks the cancel. */
  | { kind: "blocked"; reason: "in_progress" | "review" | "lookup_failed" | "not_found" }
  /** It changed between the checks and the cancel (nothing written). */
  | { kind: "changed" }
  | { kind: "cancelled"; consultation: Consultation };

/** What one sweep run did, for the function's log line. */
export interface AbandonedSweepResult {
  /** Bookings the query returned (at most ABANDONED_SWEEP_BATCH_SIZE). */
  scanned: number;
  /** Closed: `status: "cancelled"`, `cancelledBy: "system"`. */
  cancelled: number;
  /** Found paid at Paystack and confirmed through `settlePayment`. */
  settled: number;
  /** Left for a later run: a payment may still land (Paystack `in_progress`). */
  leftInProgress: number;
  /** Not touched: changed between the query and the write, or paid money that could not be applied. */
  skipped: number;
  /** A Paystack or Firestore failure on one booking (logged; the run goes on). */
  errors: number;
  /**
   * Issue #411: bookings left for the next run because the run's Paystack
   * budget (SWEEP_MAX_LOOKUPS_PER_RUN) ran out. Neither errors nor counted
   * toward set-aside.
   */
  leftForCap: number;
  /** Issue #411: bookings SET ASIDE by this run (they reached SWEEP_SET_ASIDE_AFTER_RUNS). */
  setAside: number;
  /** Issue #411: set-aside bookings released because their checkouts or grace changed. */
  released: number;
  /** Issue #411: Paystack lookups made by this run (at most SWEEP_MAX_LOOKUPS_PER_RUN). */
  lookups: number;
}

export interface ConsultationFilters {
  status?: ConsultationStatus;
  applicationId?: string;
  type?: string;
  startDate?: string;
  endDate?: string;
}

export interface ConsultationStats {
  total: number;
  upcoming: number;
  completed: number;
  cancelled: number;
  noShow: number;
}

class ConsultationService {
  /**
   * Get consultations where the user is the assigned agent.
   */
  async getConsultationsForAgent(
    agentUserId: string,
    filters?: ConsultationFilters
  ): Promise<Consultation[]> {
    let query = collections.consultations
      .where("agentId", "==", agentUserId)
      .orderBy("scheduledDate", "desc") as FirebaseFirestore.Query;

    query = this.applyFilters(query, filters);
    const snapshot = await query.get();
    return snapshot.docs.map((doc) => doc.data() as Consultation);
  }

  /**
   * Get all consultations for agents in an agency.
   */
  async getConsultationsForAgency(
    agencyId: string,
    filters?: ConsultationFilters
  ): Promise<Consultation[]> {
    let query = collections.consultations
      .where("agencyId", "==", agencyId)
      .orderBy("scheduledDate", "desc") as FirebaseFirestore.Query;

    query = this.applyFilters(query, filters);
    const snapshot = await query.get();
    return snapshot.docs.map((doc) => doc.data() as Consultation);
  }

  /**
   * Get consultations where the user is the client (userId).
   * Used by mobile app clients to see their booked consultations.
   */
  async getConsultationsForClient(
    clientUserId: string,
    filters?: ConsultationFilters
  ): Promise<Consultation[]> {
    let query = collections.consultations
      .where("userId", "==", clientUserId)
      .orderBy("scheduledDate", "desc") as FirebaseFirestore.Query;

    query = this.applyFilters(query, filters);
    const snapshot = await query.get();
    return snapshot.docs.map((doc) => doc.data() as Consultation);
  }

  /**
   * Get all consultations (admin only).
   */
  async getAllConsultations(
    filters?: ConsultationFilters
  ): Promise<Consultation[]> {
    let query = collections.consultations
      .orderBy("scheduledDate", "desc");

    query = this.applyFilters(query, filters);
    const snapshot = await query.get();
    return snapshot.docs.map((doc) => doc.data() as Consultation);
  }

  /**
   * Get a single consultation by ID.
   */
  async getConsultationById(id: string): Promise<Consultation | null> {
    const doc = await collections.consultations.doc(id).get();
    if (!doc.exists) return null;
    return doc.data() as Consultation;
  }

  /**
   * Create a new consultation.
   */
  async createConsultation(
    data: Omit<Consultation, "id" | "createdAt" | "updatedAt">
  ): Promise<Consultation> {
    const now = Timestamp.now();
    const ref = collections.consultations.doc();
    const consultation: Consultation = {
      ...data,
      id: ref.id,
      createdAt: now,
      updatedAt: now,
    };

    await ref.set(consultation);
    return consultation;
  }

  /**
   * The unpaid bookings of one client with one agent (issue #288): three
   * equality filters, so Firestore answers it from its single-field indexes
   * (no composite index). The day and time are matched in memory
   * (`pickResumableBooking`), because the stored time of an older row may not
   * be normalised and a client rarely has more than a few of these.
   */
  private pendingBookingsQuery(slot: BookingSlot): FirebaseFirestore.Query {
    return collections.consultations
      .where("userId", "==", slot.userId)
      .where("agentId", "==", slot.agentId)
      .where("status", "==", "pending_payment");
  }

  /**
   * The unpaid booking to resume for a slot, or null (issue #288). A plain
   * read, used BEFORE the monthly limit and the pricing so that a resume
   * needs neither. The find-or-create decision that must not race is
   * `createOrResumePendingBooking`.
   */
  async findResumableBooking(slot: BookingSlot): Promise<Consultation | null> {
    const snapshot = await this.pendingBookingsQuery(slot).get();
    return pickResumableBooking(snapshot.docs.map((doc) => doc.data() as Consultation), slot);
  }

  /**
   * Create a `pending_payment` booking, UNLESS the client already has an
   * unpaid one for the same agent, day and time (issue #288). Then that
   * booking is returned and nothing is written.
   *
   * ONE Firestore transaction (the charge path's runner):
   *  1. it first reads the pair's LOCK document
   *     (`consultationBookingLocks/{bookingLockId}`) and, when it creates a
   *     booking, writes it. Two creates of one client with one agent
   *     therefore always touch the same document, so Firestore runs them one
   *     after the other: the second is retried on fresh data and finds the
   *     first one's booking. A query alone is not relied on for this, because
   *     a query inside a transaction does not have to block a concurrent
   *     INSERT of a new row (the same reasoning as `withdrawalLocks`, #287);
   *  2. the pair's unpaid bookings are read THROUGH the transaction and the
   *     slot is matched (`pickResumableBooking`);
   *  3. only when none matches are the new booking and the lock written, in
   *     the same commit.
   * So two requests for the same slot that arrive together leave exactly one
   * booking. The lock is per PAIR, not per slot: two different slots of one
   * pair also run one after the other, which costs nothing and keeps one
   * small document per pair.
   *
   * @param data the new booking as `createConsultation` takes it; its
   *   `scheduledTime` must already be normalised (`normalizeScheduledTime`)
   */
  async createOrResumePendingBooking(
    data: Omit<Consultation, "id" | "createdAt" | "updatedAt">
  ): Promise<CreateOrResumeOutcome> {
    const slot: BookingSlot = {
      userId: data.userId,
      agentId: data.agentId,
      scheduledDate: data.scheduledDate,
      scheduledTime: data.scheduledTime,
    };
    // The id is chosen outside the transaction body: a retried body then
    // writes the same document rather than a second one.
    const ref = collections.consultations.doc();
    const lockRef = collections.consultationBookingLocks.doc(bookingLockId(slot.userId, slot.agentId));
    return chargeRuntime.runTransaction<CreateOrResumeOutcome>(async (tx) => {
      // ---- Reads (before any write, as Firestore requires) ----
      // The lock read is what makes two creates of one pair conflict.
      const lockSnap = await tx.get(lockRef);
      const snapshot = await tx.get(this.pendingBookingsQuery(slot));

      // ---- Decide ----
      const existing = pickResumableBooking(snapshot.docs.map((doc) => doc.data() as Consultation), slot);
      // Resumed: nothing is written, not even the lock.
      if (existing) return { kind: "existing", consultation: existing };

      // ---- Writes (both or neither) ----
      // Same timestamps as `createConsultation` (the wall clock).
      const now = Timestamp.now();
      const consultation: Consultation = { ...data, id: ref.id, createdAt: now, updatedAt: now };
      tx.set(ref, consultation);
      // Writing the lock is what forces a concurrent create of the same pair
      // to be retried. The fields are for a human reading the console.
      const previousCount = lockSnap.exists ? Number(lockSnap.data()?.bookingCount) || 0 : 0;
      tx.set(lockRef, {
        userId: slot.userId,
        agentId: slot.agentId,
        lastConsultationId: ref.id,
        bookingCount: previousCount + 1,
        updatedAt: now,
      });
      return { kind: "created", consultation };
    });
  }

  /**
   * Cancel unpaid bookings that were abandoned (issue #288): `pending_payment`
   * with a payment grace that ended more than ABANDONED_BOOKING_GRACE_HOURS
   * ago. Run hourly by `sweepAbandonedConsultations` (index.ts). Guest
   * bookings are the same rows and are covered too.
   *
   * 0. RELEASE PASS (issue #411): set-aside bookings whose checkouts or grace
   *    changed since they were set aside (`sweepFingerprint`: a re-price, a
   *    reschedule, a guest pay link) are released first, no Paystack call.
   *
   * Then for each booking the query returns (at most ABANDONED_SWEEP_BATCH_SIZE,
   * oldest lock first, SET-ASIDE ONES EXCLUDED, issue #411), see
   * `decideAbandonedCheckouts` (issue #397):
   *  - not abandoned: skipped before any Paystack call (grace restarted by a
   *    reschedule, #405; a guest's live pay link, #411);
   *  - its checkouts are asked about at Paystack (`lookUpSweepCheckouts`,
   *    issue #411): retired / superseded ones first in stored order, then the
   *    live one; a reference recorded FINAL on an earlier run costs no call;
   *    the lookups stop at the first checkout still in progress, at the first
   *    failure, or when the run's budget (SWEEP_MAX_LOOKUPS_PER_RUN) is spent;
   *  - a lookup failed: not cancelled (counted in `errors`);
   *  - a checkout IN PROGRESS: not cancelled (`leftInProgress`), BUT every
   *    PAID retired checkout found before it is settled now through
   *    `settlePayment` (recorded as an exception and refunded under #354's
   *    rules; issue #411). Same on a failed lookup;
   *  - the budget ran out: left for the next run (`leftForCap`, not counted
   *    toward set-aside, unless the booking has more references than a whole
   *    run may ask about: `too_many_checkouts`, counted);
   *  - BEFORE A CANCEL (decision 2026-11-21) every reference not asked about
   *    in this run (the recorded finals) is asked about once more, inside the
   *    same budget, and the decision is taken again: an "abandoned" checkout
   *    paid since is settled, never cancelled under;
   *  - PAID ones (nothing in flight): each settled through `settlePayment`
   *    (the ONLY writer of money rows here). Confirmed: settled, never
   *    cancelled. Recorded and refunded (#354): it no longer blocks the
   *    cancel. Not applicable (mismatch, ...): left for review;
   *  - all final unpaid (or handled as above), or no checkout at all:
   *    cancelled, in a transaction of its own that re-reads the booking and
   *    writes only if it is STILL abandoned, not set aside, and still
   *    carries the same live reference AND the same superseded references
   *    that were checked (a payment, a re-price or a reschedule that landed
   *    meanwhile wins).
   *
   * BOOKKEEPING (issue #411), in its own transaction per booking, sweep
   * fields only (`sweepReview`, `sweepSetAside`; never `updatedAt`, never a
   * money field): the last known state of each reference looked up, and,
   * when the run left the booking unresolved (in progress, review, a lookup
   * failure or "not found"), one more `unresolvedRuns` with `lastOutcome` and
   * `lastRunAt`. At SWEEP_SET_ASIDE_AFTER_RUNS on unchanged checkouts and
   * grace the booking is SET ASIDE (`sweepSetAside: true`): no later run
   * selects it, nor cancels it; admins list it (`GET /consultations/sweep-review`).
   *
   * A cancel writes `status`, `cancelledAt`, `cancelledBy: "system"`,
   * `cancellationReason` and `updatedAt`, and NOBODY IS NOTIFIED. A payment
   * that still lands on the cancelled booking is recorded for refund by
   * `settlePayment` (`consultationPaymentExceptions`, `booking_not_payable`).
   *
   * The clock is the charge path's (`chargeRuntime.now()`), so tests and the
   * emulators can move it instead of waiting a day. One failing booking (a
   * Paystack outage) is logged and counted; the others still run.
   *
   * Needs the composite index consultations(status, sweepSetAside,
   * quoteExpiresAt), see firestore.indexes.json (issue #411; the release
   * pass and the admin list use it too). A legacy row has no
   * `quoteExpiresAt`, and a row with no `sweepSetAside` (made before #411,
   * until `npm run backfill:sweep-lane` has run) is not selected either:
   * Firestore never matches a missing field. Both are left alone, never
   * cancelled.
   */
  async sweepAbandonedBookings(): Promise<AbandonedSweepResult> {
    const result: AbandonedSweepResult = {
      scanned: 0, cancelled: 0, settled: 0, leftInProgress: 0, skipped: 0, errors: 0,
      leftForCap: 0, setAside: 0, released: 0, lookups: 0,
    };

    // Review round 1 (orchestrator note 3) / round 2: the run's wall-clock
    // budget starts with the run (before the release pass and the query).
    // Bookings not reached in time wait for the next run (`leftForCap`).
    const deadline = sweepRuntime.wallClockMs() + SWEEP_TIME_BUDGET_MS;

    // ---- 0. Release set-aside bookings that changed (issue #411) ----
    // Before the main query, so a released booking is swept in this run.
    try {
      result.released = await this.releaseChangedSetAsideBookings();
    } catch (error) {
      // Not fatal: the main sweep does not depend on it.
      console.error("[consultation sweep] release pass failed:", error);
    }

    const cutoff = Timestamp.fromDate(abandonedCutoff(chargeRuntime.now()));
    const snapshot = await collections.consultations
      .where("status", "==", "pending_payment")
      // Issue #411: set-aside bookings no longer take a batch slot.
      .where("sweepSetAside", "==", false)
      .where("quoteExpiresAt", "<", cutoff)
      .orderBy("quoteExpiresAt", "asc")
      .limit(ABANDONED_SWEEP_BATCH_SIZE)
      .get();
    result.scanned = snapshot.size;

    // Issue #411: the Paystack budget of THIS run, shared by every booking,
    // and (review round 2) its deadline, also checked before each lookup.
    const budget = { remaining: SWEEP_MAX_LOOKUPS_PER_RUN, deadline };

    for (const [index, doc] of snapshot.docs.entries()) {
      if (sweepRuntime.wallClockMs() >= deadline) {
        const left = snapshot.size - index;
        result.leftForCap += left;
        console.warn(`[consultation sweep] time budget spent; ${left} booking(s) left for the next run`);
        break;
      }
      const booking = doc.data() as Consultation;
      // The fingerprint of the booking as the lookups saw it (issue #411).
      const observedFingerprint = sweepFingerprint(booking);
      try {
        await this.sweepOneBooking(doc.id, booking, observedFingerprint, budget, result);
      } catch (error) {
        // One booking must not stop the run (e.g. a Firestore failure in a
        // settle: nothing is cancelled without the full answer).
        console.error(`[consultation sweep] ${doc.id} failed; left as it is:`, error);
        result.errors++;
        // Issue #411: still counted, so a booking that always fails stops
        // taking a slot. Best effort: Firestore may be what failed.
        try {
          const counted = await this.recordSweepRun(doc.id, observedFingerprint, [], "error");
          if (counted.setAside) result.setAside++;
        } catch (recordError) {
          console.error(`[consultation sweep] ${doc.id}: could not record the failed run:`, recordError);
        }
      }
    }
    result.lookups = SWEEP_MAX_LOOKUPS_PER_RUN - budget.remaining;
    return result;
  }

  /**
   * One booking of a sweep run (see `sweepAbandonedBookings`). Adds to
   * `result`; throws only on an unexpected failure (counted by the caller).
   */
  private async sweepOneBooking(
    id: string,
    booking: Consultation,
    observedFingerprint: string,
    budget: { remaining: number; deadline?: number },
    result: AbandonedSweepResult
  ): Promise<void> {
    // ---- 1. Not abandoned: skipped BEFORE any Paystack call ----
    // (paid meanwhile, grace restarted, a guest's live pay link, legacy data.)
    if (!isAbandonedBooking(booking, chargeRuntime.now())) {
      result.skipped++;
      return;
    }

    // ---- 2. Ask Paystack (bounded, issue #411; every checkout, #397) ----
    const stamp = Timestamp.fromDate(chargeRuntime.now());
    const look = await lookUpSweepCheckouts(booking, { budget, fresh: false, at: stamp, logId: id });

    // ---- 3. Decide on all the answers at once (pure) ----
    let decision = decideAbandonedCheckouts(booking, look.states, chargeRuntime.now());

    // ---- 3'. Before a cancel, ask about the recorded ones again (#411) ----
    // Decision 2026-11-21: a reference recorded as final (Paystack
    // "abandoned" above all) can still be paid later. Cancelling under that
    // late payment would turn it into a refund charged to the client as if
    // the client had caused it. So when this run's answers would lead to a
    // cancel (directly, or after settling paid references), every reference
    // NOT asked about in this run is asked about once more first, inside the
    // same run budget, and the decision is taken again on all the answers.
    // Fail closed as everywhere: a failure, a checkout now in progress, or the
    // cap running out means no cancel this run; a reference paid since goes
    // through settlePayment (step 4 / 3a) like any other paid one.
    if (decision.kind === "cancel" || decision.kind === "settle") {
      const unasked = sweepLookupOrder(booking).filter((reference) => !look.lookups.has(reference));
      if (unasked.length > 0) {
        const again = await lookUpSweepCheckouts(booking, {
          budget, fresh: true, at: stamp, logId: `${id} (before cancel)`, references: unasked,
        });
        for (const [reference, state] of again.states) look.states.set(reference, state);
        for (const [reference, lookup] of again.lookups) look.lookups.set(reference, lookup);
        look.records.push(...again.records);
        look.calls += again.calls;
        // A recorded final that was NOT re-asked (the lookups stopped first)
        // must not count as answered: drop it, so the decision sees it as
        // "not looked up" and leaves the booking.
        for (const reference of unasked) {
          if (!again.states.has(reference)) look.states.delete(reference);
        }
        look.stoppedBy = again.stoppedBy;
        look.outage ||= again.outage;
        decision = decideAbandonedCheckouts(booking, look.states, chargeRuntime.now());
      }
    }

    if (decision.kind === "skip") {
      result.skipped++;
      return;
    }

    if (decision.kind === "error" || decision.kind === "leave") {
      // ---- 3a. Left, but paid retired checkouts are settled (issue #411) ----
      // The cancel waits; the client's money does not. Only settlePayment
      // writes (exception + refund, or a confirmation at that checkout's price).
      // Review round 1: a paid LIVE checkout is settled here too (it
      // confirms the booking), whatever an older checkout is doing.
      const paidWhileLeft = paidReferencesWhileLeft(booking, look.states);
      const settled = await this.settleSweepReferences(id, paidWhileLeft, look, stamp);
      const records = [...look.records, ...settled.records];
      if (settled.outcomes.some((o) => isConfirmingSweepSettle(o))) {
        // A superseded re-priced checkout confirmed the booking: it is paid.
        result.settled++;
        await this.recordSweepRun(id, observedFingerprint, records, null);
        return;
      }
      if (look.stoppedBy === "cap") {
        // The run's Paystack budget ran out: not an error, not counted.
        result.leftForCap++;
        // Except for a booking with more references than a whole run may
        // ask about: no run can ever check them all before a cancel, so it
        // is counted and reaches an admin (set aside) instead of waiting forever.
        const tooMany = sweepLookupOrder(booking).length > SWEEP_MAX_LOOKUPS_PER_RUN;
        if (tooMany) {
          const counted = await this.recordSweepRun(id, observedFingerprint, records, "too_many_checkouts");
          if (counted.setAside) result.setAside++;
        } else if (records.length > 0) {
          await this.recordSweepRun(id, observedFingerprint, records, null);
        }
        return;
      }
      let unresolved: SweepUnresolvedOutcome;
      if (decision.kind === "error") {
        result.errors++;
        unresolved = look.stoppedBy === "not_found" ? "not_found" : "lookup_failed";
      } else {
        result.leftInProgress++;
        unresolved = "in_progress";
      }
      // Review round 1 (orchestrator note 2): a run in which Paystack could
      // not answer (network, 5xx, timeout, a mis-set key) is NOT counted
      // toward set-aside, the same as #413's fee job: an outage must never
      // set every abandoned booking aside. What was learned is still recorded.
      const counted = await this.recordSweepRun(id, observedFingerprint, records, unresolved, { notCounted: look.outage });
      if (counted.setAside) result.setAside++;
      return;
    }

    let records = look.records;
    // Refund notices deferred by this run's settles (sent once, below).
    let notices: DeferredRefundNotice[] = [];
    if (decision.kind === "settle") {
      // ---- 4. Paid somewhere: settle each paid reference ----
      // ONLY through settlePayment: it re-reads the booking in its own
      // transaction and is the one place that confirms a booking or
      // records an exception with its refund and fee debit (#354:
      // one refund per reference, one debit per reference). The sweep
      // itself never writes money rows.
      // Review round 1 (orchestrator note 5): the refund notices of these
      // settles wait until the run knows whether it cancels the booking, so
      // a refund followed by the cancel never says "pay again".
      const settled = await this.settleSweepReferences(id, decision.references, look, stamp, { deferNotices: true });
      notices = settled.notices;
      records = [...records, ...settled.records];
      const after = decideAfterSweepSettles(settled.outcomes);
      if (after === "settled") {
        result.settled++;
        await sendNotices(notices, false);
        await this.recordSweepRun(id, observedFingerprint, records, null);
        return;
      }
      if (after === "review") {
        // Paid money that could not be applied: a human must look.
        result.skipped++;
        await sendNotices(notices, false);
        const counted = await this.recordSweepRun(id, observedFingerprint, records, "review");
        if (counted.setAside) result.setAside++;
        return;
      }
      // after === "cancel": every paid reference was recorded and
      // refunded; every other checkout is final unpaid. Fall through.
    }

    // ---- 5. Cancel, re-checked in its own transaction ----
    let cancelled: boolean;
    try {
      cancelled = await this.cancelAbandonedBooking(id, booking.transactionId ?? null, supersededReferencesOf(booking));
    } catch (error) {
      // The refunds happened: the client is still told (usual wording).
      await sendNotices(notices, false);
      throw error;
    }
    if (cancelled) {
      result.cancelled++;
      // The client is told about the refund with the cancelled wording.
      await sendNotices(notices, true);
      return;
    }
    // Changed meanwhile (paid, re-priced, moved): keep what was learned.
    result.skipped++;
    await sendNotices(notices, false);
    if (records.length > 0) await this.recordSweepRun(id, observedFingerprint, records, null);
  }

  /**
   * Settle paid references of a booking through `settlePayment`, one by one
   * (issue #397, #411). Logs a reference that was neither applied nor
   * recorded (`isConfirmingSweepSettle` / `isHandledSweepSettle`: the one
   * handled rule). Writes nothing itself.
   *
   * @returns the outcomes (in order) and what to record for each reference
   */
  private async settleSweepReferences(
    id: string,
    references: readonly string[],
    look: SweepLookups,
    stamp: Timestamp,
    /** Review round 1: keep the refund notices for the caller (it may cancel next). */
    options: { deferNotices?: boolean } = {}
  ): Promise<{ outcomes: Array<SettleOutcome | null>; records: SweepCheckoutRecord[]; notices: DeferredRefundNotice[] }> {
    const outcomes: Array<SettleOutcome | null> = [];
    const records: SweepCheckoutRecord[] = [];
    const notices: DeferredRefundNotice[] = [];
    try {
      for (const reference of references) {
        const reported = look.lookups.get(reference)?.result;
        // A paid state always comes with Paystack's answer; never settle without it.
        if (!reported) continue;
        const outcome = await settlePayment(id, reference, reported, { deferRefundNotice: options.deferNotices === true });
        if (outcome && "deferredNotice" in outcome && outcome.deferredNotice) notices.push(outcome.deferredNotice);
        outcomes.push(outcome);
        records.push(recordForSettle(reference, outcome, stamp));
        if (!isConfirmingSweepSettle(outcome) && !isHandledSweepSettle(outcome)) {
          // Paid, but neither applied nor recorded (wrong amount, ...):
          // left for a human, never cancelled.
          console.error(
            `[consultation sweep] ${id} is paid at Paystack (${reference}) but could not be settled ` +
              `(${outcome?.kind ?? "booking gone"}); left as it is for review`
          );
        }
      }
    } catch (error) {
      // Review round 2: a later settle failed. Notices deferred by the
      // earlier ones would be lost for good (a re-settle finds the refund
      // row and creates, so defers, nothing): send them now, with the usual
      // wording (no cancel will follow this run), then let the caller count
      // the failure. Covers the sweep and the admin cancel.
      await sendNotices(notices, false);
      throw error;
    }
    return { outcomes, records, notices };
  }

  /**
   * Write the sweep's bookkeeping for one booking (issue #411), in its own
   * transaction: the booking is re-read and ONLY `sweepReview` (and
   * `sweepSetAside: true` when it reaches SWEEP_SET_ASIDE_AFTER_RUNS) is
   * written. Never `updatedAt`, never a status or money field, so it can
   * never undo a payment, a re-price or a move.
   *
   *  - not pending any more (paid, cancelled) or gone: nothing written;
   *  - the records are merged by reference (newest wins);
   *  - the counter follows `nextSweepCount` (it only grows while the
   *    booking's fingerprint is the one the lookups saw).
   *
   * @param unresolved why the run left the booking, or null for a run that
   *   is not counted
   * @returns whether this write set the booking aside
   */
  private async recordSweepRun(
    id: string,
    observedFingerprint: string,
    records: readonly SweepCheckoutRecord[],
    unresolved: SweepUnresolvedOutcome | null,
    /**
     * Review round 1 (orchestrator note 2): `notCounted` records why the run
     * left the booking (`lastOutcome`, `lastRunAt`) WITHOUT adding to the
     * counter: Paystack could not answer, which must never set it aside.
     */
    opts: { notCounted?: boolean } = {}
  ): Promise<{ setAside: boolean }> {
    const ref = collections.consultations.doc(id);
    return chargeRuntime.runTransaction<{ setAside: boolean }>(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return { setAside: false };
      const fresh = snap.data() as Consultation;
      if (fresh.status !== "pending_payment" || fresh.paymentStatus === "paid") return { setAside: false };
      const freshFingerprint = sweepFingerprint(fresh);
      const stored = fresh.sweepReview;
      const count = nextSweepCount(stored, observedFingerprint, freshFingerprint, opts.notCounted ? null : unresolved);
      const stamp = Timestamp.fromDate(chargeRuntime.now());
      const counted = unresolved !== null && freshFingerprint === observedFingerprint;
      const setAsideNow = count.setAside && fresh.sweepSetAside !== true;
      // Firestore refuses `undefined` values: optional keys are added only when set.
      const review: ConsultationSweepReview = {
        unresolvedRuns: count.unresolvedRuns,
        fingerprint: freshFingerprint,
        checkouts: mergeSweepRecords(stored?.checkouts, records),
      };
      if (counted) {
        review.lastOutcome = unresolved!;
        review.lastRunAt = stamp;
      } else {
        if (stored?.lastOutcome) review.lastOutcome = stored.lastOutcome;
        if (stored?.lastRunAt) review.lastRunAt = stored.lastRunAt;
      }
      if (setAsideNow) review.setAsideAt = stamp;
      else if (stored?.setAsideAt && fresh.sweepSetAside === true) review.setAsideAt = stored.setAsideAt;
      tx.update(ref, { sweepReview: review, ...(setAsideNow ? { sweepSetAside: true } : {}) });
      if (setAsideNow) {
        console.warn(
          `[consultation sweep] ${id} set aside after ${count.unresolvedRuns} unresolved runs ` +
            `(last: ${unresolved}); listed in GET /consultations/sweep-review`
        );
      }
      return { setAside: setAsideNow };
    });
  }

  /**
   * The release pass (issue #411): set-aside bookings whose checkouts or
   * grace changed since the sweep set them aside (`sweepFingerprint` differs
   * from the stored one) go back into the sweep: `sweepSetAside: false`,
   * the counter back to 0, the recorded references kept (a final state at
   * Paystack does not change). No Paystack call.
   *
   * This covers the writes the sweep does not own (a re-price or a new
   * checkout in the charge path, a pay link from #391): a reschedule clears
   * the marker itself (`editConsultation`), and a PAID booking leaves both
   * the query and the admin list through its status.
   *
   * Reads at most SWEEP_REVIEW_LIST_LIMIT set-aside bookings, oldest lock
   * first. Each release re-checks in its own transaction.
   *
   * @returns how many bookings were released
   */
  private async releaseChangedSetAsideBookings(): Promise<number> {
    const snapshot = await setAsideBookingsQuery().get();
    let released = 0;
    for (const doc of snapshot.docs) {
      const booking = doc.data() as Consultation;
      if (sweepFingerprint(booking) === booking.sweepReview?.fingerprint) continue;
      const done = await chargeRuntime.runTransaction<boolean>(async (tx) => {
        const snap = await tx.get(doc.ref);
        if (!snap.exists) return false;
        const fresh = snap.data() as Consultation;
        if (fresh.sweepSetAside !== true || sweepFingerprint(fresh) === fresh.sweepReview?.fingerprint) return false;
        tx.update(doc.ref, releasedSweepFields(fresh));
        return true;
      });
      if (done) {
        released++;
        console.log(`[consultation sweep] ${doc.id} released from set-aside: its checkouts or grace changed`);
      }
    }
    return released;
  }

  /**
   * Close ONE abandoned booking (issue #288), in its own transaction: the
   * booking is re-read and written only if it is still `pending_payment`,
   * unpaid, past its grace, and still on the checkout reference that was
   * asked about (`observedReference`, null when it had none) and on the same
   * set of superseded references (`observedSuperseded`, issue #397). So a
   * payment settled, or a checkout re-issued, re-priced or retired, between
   * the Paystack checks and this write is never overwritten.
   *
   * Issue #411: a SET-ASIDE booking is never cancelled by the sweep (it is
   * waiting for an admin); only the admin's own cancel passes
   * `allowSetAside`, after the same checks. `cancelledBy` is "system" for the
   * sweep and the admin's uid for an admin cancel.
   *
   * @returns true when the booking was cancelled, false when it was left
   */
  private async cancelAbandonedBooking(
    id: string,
    observedReference: string | null,
    observedSuperseded: readonly string[],
    options: { cancelledBy?: string; allowSetAside?: boolean } = {}
  ): Promise<boolean> {
    const ref = collections.consultations.doc(id);
    return chargeRuntime.runTransaction<boolean>(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return false;
      const fresh = snap.data() as Consultation;
      const at = chargeRuntime.now();
      if (!isAbandonedBooking(fresh, at) || (fresh.transactionId ?? null) !== observedReference) return false;
      // Issue #397: the older checkouts must be the very ones the sweep
      // asked Paystack about. A checkout re-priced or retired after the
      // lookups (a new entry) means an unchecked payment could land: leave it.
      if (!sameReferenceSet(supersededReferencesOf(fresh), observedSuperseded)) return false;
      // Issue #411: set aside meanwhile: it waits for an admin.
      if (fresh.sweepSetAside === true && !options.allowSetAside) return false;
      const now = Timestamp.fromDate(at);
      tx.update(ref, {
        status: "cancelled",
        cancelledAt: now,
        cancelledBy: options.cancelledBy ?? SYSTEM_CANCEL_ACTOR,
        cancellationReason: SYSTEM_CANCELLATION_REASON,
        updatedAt: now,
      });
      return true;
    });
  }

  // ============================================
  // ADMIN: set-aside bookings (issue #411)
  // ============================================
  //
  // Orchestrator decision 2026-11-21: an admin can LIST the bookings the
  // sweep set aside, trigger a FRESH CHECK of one (look it up again and
  // settle a paid checkout through `settlePayment`), or CANCEL one. Both
  // actions run the sweep's own safety checks (every checkout looked up,
  // fail closed, the cancel re-checked in its own transaction) and never
  // write a money row themselves.

  /**
   * Every set-aside, still-unpaid booking, oldest lock first, for
   * `GET /consultations/sweep-review` (at most SWEEP_REVIEW_LIST_LIMIT).
   * A booking paid or cancelled since is not listed (its status left the
   * query).
   */
  async listSweepReview(): Promise<SweepReviewItem[]> {
    const snapshot = await setAsideBookingsQuery().get();
    return snapshot.docs.map((doc) => sweepReviewItemOf(doc.data() as Consultation));
  }

  /**
   * Shared core of the two admin actions: a FRESH look at every checkout
   * (recorded finals asked about again; no run budget), the decision, and
   * the settles it calls for, exactly as the sweep does them (paid
   * references through `settlePayment` only; paid retired ones also while
   * another checkout is in progress). Writes only through `settlePayment`.
   */
  private async adminSweepCheck(
    id: string,
    booking: Consultation,
    /** Review round 1: the admin CANCEL defers the refund notices until it knows whether it cancelled. */
    options: { deferNotices?: boolean } = {}
  ): Promise<AdminSweepCheck> {
    const stamp = Timestamp.fromDate(chargeRuntime.now());
    // No budget: every checkout is asked about, none skipped (review round 1).
    const look = await lookUpSweepCheckouts(booking, { budget: null, fresh: true, at: stamp, logId: `${id} (admin)` });
    const decision = decideAbandonedCheckouts(booking, look.states, chargeRuntime.now());
    let toSettle: string[] = [];
    if (decision.kind === "settle") toSettle = decision.references;
    // Review round 1: a paid LIVE checkout is settled too, whatever an older one is doing.
    else if (decision.kind === "leave" || decision.kind === "error") toSettle = paidReferencesWhileLeft(booking, look.states);
    const settled = await this.settleSweepReferences(id, toSettle, look, stamp, {
      // Only a settle that may be followed by the cancel waits.
      deferNotices: options.deferNotices === true && decision.kind === "settle",
    });
    const after = decision.kind === "settle" ? decideAfterSweepSettles(settled.outcomes) : null;
    const confirmed = settled.outcomes.some((o) => isConfirmingSweepSettle(o));
    let verdict: AdminSweepCheck["verdict"];
    if (confirmed) verdict = "paid";
    else if (decision.kind === "skip") verdict = "not_abandoned";
    else if (decision.kind === "error") verdict = look.stoppedBy === "not_found" ? "not_found" : "lookup_failed";
    else if (decision.kind === "leave") verdict = "in_progress";
    else if (after === "review") verdict = "review";
    else verdict = "clear"; // cancel, or settle -> cancel: nothing in flight, nothing unapplied
    return { verdict, records: [...look.records, ...settled.records], notices: settled.notices };
  }

  /**
   * POST /consultations/:id/sweep-review/check (admin): look a set-aside
   * booking up again (issue #411).
   *
   *  - `not_found` / `not_set_aside` (not set aside, or not pending any more);
   *  - `settled`: a paid checkout confirmed the booking (through settlePayment);
   *  - `released`: nothing is in flight or unapplied any more (or its grace
   *    restarted): the marker is removed and the next sweep run handles it
   *    as usual (cancels it if it is still abandoned). The admin may also
   *    cancel it now;
   *  - `still_unresolved` with the `reason`: it stays set aside.
   * The recorded checkout states are updated in every case; the run counter
   * is not (an admin check is not a sweep run).
   */
  async adminRecheckSweepReview(id: string): Promise<AdminRecheckOutcome> {
    const ref = collections.consultations.doc(id);
    const snap = await ref.get();
    if (!snap.exists) return { kind: "not_found" };
    const booking = snap.data() as Consultation;
    if (booking.sweepSetAside !== true || booking.status !== "pending_payment" || booking.paymentStatus === "paid") {
      return { kind: "not_set_aside" };
    }
    const observedFingerprint = sweepFingerprint(booking);
    const check = await this.adminSweepCheck(id, booking);
    if (check.verdict === "paid") {
      return { kind: "settled", consultation: await this.getConsultationById(id) };
    }
    if (check.verdict === "clear" || check.verdict === "not_abandoned") {
      // Release, in a transaction that re-reads the booking and keeps the records.
      await chargeRuntime.runTransaction<void>(async (tx) => {
        const fresh = await tx.get(ref);
        if (!fresh.exists) return;
        const current = fresh.data() as Consultation;
        // Paid or cancelled meanwhile (a verify racing this check): leave it.
        if (current.sweepSetAside !== true || current.status !== "pending_payment" || current.paymentStatus === "paid") {
          return;
        }
        const merged = releasedSweepFields(current, check.records, sweepFingerprint(current));
        tx.update(ref, merged);
      });
      const after = await this.getConsultationById(id);
      // A verify that confirmed the booking during the check: say so.
      if (after?.paymentStatus === "paid") return { kind: "settled", consultation: after };
      return { kind: "released", consultation: after };
    }
    await this.recordSweepRun(id, observedFingerprint, check.records, null);
    const fresh = await this.getConsultationById(id);
    return {
      kind: "still_unresolved",
      reason: check.verdict,
      item: fresh ? sweepReviewItemOf(fresh) : null,
    };
  }

  /**
   * POST /consultations/:id/sweep-review/cancel (admin): cancel an abandoned
   * booking the sweep left, with the sweep's own safety checks (issue #411):
   *
   *  1. it must be `pending_payment`, unpaid, and past its grace
   *     (`isAbandonedBooking`: a restarted grace or a guest's live pay link
   *     still protect it);
   *  2. EVERY checkout is looked up again (fail closed on any failure);
   *  3. a paid checkout is settled through `settlePayment`: one that
   *     confirms the booking stops the cancel; a retired one recorded and
   *     refunded does not block it; one that cannot be applied does;
   *  4. a checkout still in progress blocks it;
   *  5. the cancel re-reads the booking in its own transaction
   *     (`cancelAbandonedBooking`, same references, still abandoned). A
   *     verify that lands first wins; one that lands after is recorded and
   *     refunded by `settlePayment` (`booking_not_payable`), as for the sweep.
   * `cancelledBy` is the admin's uid; the reason is the sweep's sentence.
   * Nobody is notified (as for the sweep). No money row is written here.
   */
  async adminCancelSweepBooking(id: string, adminUid: string): Promise<AdminSweepCancelOutcome> {
    const snap = await collections.consultations.doc(id).get();
    if (!snap.exists) return { kind: "not_found" };
    const booking = snap.data() as Consultation;
    if (booking.status !== "pending_payment" || booking.paymentStatus === "paid") return { kind: "not_pending" };
    if (!isAbandonedBooking(booking, chargeRuntime.now())) return { kind: "grace_running" };
    const observedFingerprint = sweepFingerprint(booking);
    const check = await this.adminSweepCheck(id, booking, { deferNotices: true });
    // Review round 1: refund notices deferred by the check are sent once,
    // with the cancelled wording only when this call did cancel.
    if (check.verdict !== "clear") await sendNotices(check.notices, false);
    if (check.verdict === "paid") return { kind: "paid" };
    if (check.verdict === "not_abandoned") return { kind: "grace_running" };
    if (check.verdict !== "clear") {
      await this.recordSweepRun(id, observedFingerprint, check.records, null);
      return { kind: "blocked", reason: check.verdict };
    }
    let cancelled: boolean;
    try {
      cancelled = await this.cancelAbandonedBooking(
        id,
        booking.transactionId ?? null,
        supersededReferencesOf(booking),
        { cancelledBy: adminUid, allowSetAside: true }
      );
    } catch (error) {
      await sendNotices(check.notices, false);
      throw error;
    }
    await sendNotices(check.notices, cancelled);
    if (!cancelled) {
      // Changed between the checks and the write (a payment, a re-price, a move).
      await this.recordSweepRun(id, observedFingerprint, check.records, null);
      return { kind: "changed" };
    }
    return { kind: "cancelled", consultation: (await this.getConsultationById(id))! };
  }

  /**
   * Edit a consultation's schedule, meeting details or summary, if the rules
   * allow it (issue #316). Replaces the old unchecked `updateConsultation`.
   *
   * ONE Firestore transaction, like `changeStatus`: the booking is re-read,
   * the caller's party is worked out from that fresh copy (`actorFor`), the
   * status x field table is applied (`decideEdit`), and only then are the
   * fields written. A payment confirmed by `settlePayment` (same transaction
   * runner) can therefore not slip in between the check and the write.
   *
   * Only the editable fields in `updates` and `updatedAt` are written: `id`,
   * `createdAt`, the parties, the status and every money field are never
   * touched. A refused edit (or an unknown id) writes NOTHING.
   *
   * @param actorFor which party of the booking the caller is, or null when
   *   they are neither (answered 403 by the decision)
   * @param updates checked values from `parseEditBody`
   */
  async editConsultation(
    id: string,
    actorFor: (booking: Consultation) => ConsultationActor | null,
    updates: EditUpdates
  ): Promise<EditConsultationOutcome> {
    const ref = collections.consultations.doc(id);
    // Second line of defence: whatever the caller passed, only editable
    // fields with a value can be written.
    const fieldNames = EDITABLE_FIELDS.filter((f) => updates[f] !== undefined);
    return chargeRuntime.runTransaction<EditConsultationOutcome>(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return { kind: "not_found" };
      const current = snap.data() as Consultation;
      // The same clock as the quote lock the decision reads.
      const at = chargeRuntime.now();

      const decision = decideEdit(actorFor(current), current, fieldNames, at);
      if (!decision.ok) return { kind: "refused", refusal: decision };

      const write: Record<string, unknown> = { updatedAt: Timestamp.fromDate(at) };
      for (const field of fieldNames) write[field] = updates[field];

      // Issue #317: a reschedule of a PAID booking moves its fee hold too,
      // but only ever LATER (`rescheduledFeeHold`): moving a booking earlier,
      // or into the past, never releases its fee sooner. Read before any write.
      const after = { ...current, ...write } as Consultation;
      const fee =
        isScheduleEdit(fieldNames) && isPaidWithMoney(current) ? await readFeeTransaction(tx, current) : null;
      // Review fix (round 1): once the fee is released (at the server clock)
      // the meeting has happened and the agent may have withdrawn it. A
      // reschedule must not put it back on hold (and so open a cancel with a
      // refund "from the hold"): refused, nothing written, like a cancel.
      if (fee && feeHoldStatusAt(fee, at) === "released") {
        return {
          kind: "refused",
          refusal: {
            ok: false,
            code: "FEE_RELEASED",
            httpStatus: 409,
            message:
              "This consultation's fee has been released because the meeting has happened, so it can no longer be rescheduled.",
          },
        };
      }
      if (fee?.feeHold) {
        try {
          const moved = rescheduledFeeHold(fee.feeHold, after, at);
          if (moved) {
            tx.update(collections.transactions.doc(fee.id), {
              "feeHold.slotStartAt": moved.slotStartAt,
              "feeHold.releaseAt": moved.releaseAt,
              updatedAt: write.updatedAt,
            });
          }
        } catch (error) {
          // An unreadable new slot keeps the old hold (it never releases sooner).
          console.error(`[consultation] ${id}: reschedule kept the fee hold (slot unreadable):`, error);
        }
      }

      // Issue #354: a reschedule of an unpaid booking retires its open
      // checkout(s) in THIS transaction, so no checkout for the old slot
      // stays open. (decideEdit already refused it while a payment may be in
      // flight: 409 PAYMENT_IN_PROGRESS.)
      // Review fix (fix round): only a REAL move retires the checkout. Naming
      // a schedule field with the value it already has is not a reschedule
      // (the client's checkout is still for the same slot), so it must not
      // turn their later payment into a refund and a fee debit on the agent.
      const retire = slotChanges(current, updates) ? retireCheckoutsForReschedule(current, at) : null;
      if (retire) {
        Object.assign(write, retire.update);
        console.warn(
          `[consultation] ${id} rescheduled while unpaid: checkout ${current.transactionId ?? "(none)"} ` +
            `and ${(current.supersededCheckouts ?? []).length} older one(s) retired; a payment on them is refunded`
        );
      }

      // Issue #405: a real move of an unpaid booking restarts its 24-hour
      // payment grace from now, so the abandoned-booking sweep cannot cancel
      // it before the client has had a full day to pay for the new time.
      const graceRestart = slotChanges(current, updates) ? gracePeriodRestartForReschedule(current, at) : null;
      if (graceRestart) {
        Object.assign(write, graceRestart);
        // Issue #411: count every grace restart (no cap: decision
        // 2026-11-21; admins see the count on the sweep-review list). The
        // value is computed from the booking read in THIS transaction, so it
        // is exact and the returned copy needs no FieldValue sentinel.
        write.graceRestartCount = (current.graceRestartCount ?? 0) + 1;
        // Issue #411: a moved booking has new checkouts and a new grace, so
        // it is no longer set aside (and a row made before #411 gets the
        // field the sweep's query needs).
        write.sweepSetAside = false;
      }

      tx.update(ref, write);
      // The stored doc after the commit: the fresh copy plus what was written
      // (the cleared checkout fields left out, as Firestore stores them).
      const stored = { ...current, ...write } as Record<string, unknown>;
      if (retire) {
        delete stored.transactionId;
        delete stored.checkoutUrl;
        stored.supersededCheckouts = retire.supersededCheckouts;
      }
      return { kind: "edited", before: current, consultation: stored as unknown as Consultation };
    });
  }

  /**
   * Change a consultation's status, if the rules allow it (issue #151).
   *
   * ONE Firestore transaction: the booking is re-read, the caller's party is
   * worked out from that fresh copy (`actorFor`), the transition table is
   * applied (`decideStatusChange`), and only then is the status written. So
   * the decision is always made on the state that is being overwritten: a
   * payment confirmed by `settlePayment` (same transaction runner) can not
   * slip in between the check and the write.
   *
   * A refused change (or an unknown id) writes NOTHING.
   *
   * @param actorFor which party of the booking the caller is, or null when
   *   they are neither (answered 403 by the decision)
   * @param extra `cancelledBy` / `cancellationReason` are stored on a cancel,
   *   `summary` on a completion (as before)
   */
  async changeStatus(
    id: string,
    actorFor: (booking: Consultation) => ConsultationActor | null,
    status: ConsultationStatus,
    extra?: { cancelledBy?: string; cancellationReason?: string; summary?: string }
  ): Promise<ChangeStatusOutcome> {
    const ref = collections.consultations.doc(id);

    // ---- Issue #390: Paystack's fee, asked for BEFORE the transaction ----
    // A cancel of a paid booking may refund it, and the refund depends on
    // Paystack's fee for the charge. When the fee Transaction has none stored
    // (an older row, or #395 "unknown"), Paystack is asked now, never inside
    // the transaction. A failed lookup just means "unknown": the cancel still
    // goes through and the refund is held for an admin.
    let feeLookup: Awaited<ReturnType<typeof lookUpRefundFee>>["lookup"] = null;
    let lookedUpFeeId: string | null = null;
    if (status === "cancelled") {
      const pre = await ref.get();
      const booking = pre.exists ? (pre.data() as Consultation) : null;
      if (booking && isPaidWithMoney(booking)) {
        const fee = await findFeeTransaction(booking);
        feeLookup = (await lookUpRefundFee(fee)).lookup;
        lookedUpFeeId = fee?.id ?? null;
      }
    }

    return chargeRuntime.runTransaction<ChangeStatusOutcome>(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return { kind: "not_found" };
      const current = snap.data() as Consultation;
      const at = chargeRuntime.now();

      const actor = actorFor(current);
      const decision = decideStatusChange(actor, current, status, at);
      if (!decision.ok) return { kind: "refused", refusal: decision };

      // ---- Issue #382: an open no-show report blocks every cancel ----
      // Only the admin's decision on the report moves money; read here, in
      // the same transaction, so a report and a cancel never both commit.
      if (status === "cancelled") {
        const reportSnap = await tx.get(collections.noShowReports.doc(id));
        if (reportSnap.exists && (reportSnap.data() as { status?: string }).status === "open") {
          return {
            kind: "refused",
            refusal: {
              ok: false,
              code: "NO_SHOW_REPORT_OPEN",
              httpStatus: 409,
              message: "The client reported this consultation didn't happen. Seli is looking into it, so it can't be cancelled now.",
            },
          };
        }
      }

      const now = Timestamp.fromDate(at);
      const updates: Record<string, unknown> = { status, updatedAt: now };
      if (status === "cancelled") {
        updates.cancelledAt = now;
        if (extra?.cancelledBy) updates.cancelledBy = extra.cancelledBy;
        if (extra?.cancellationReason) updates.cancellationReason = extra.cancellationReason;
      }
      if (status === "completed" && extra?.summary) {
        updates.summary = extra.summary;
      }

      // ---- Issue #317: money on a cancel of a PAID booking ----
      // All reads happen here, before any write. The refund row, the fee's
      // hold, the agent's withdrawal lock and the booking are written in THIS
      // transaction, so they commit together or not at all.
      let refund: Transaction | null = null;
      let refundCreated = false;
      let feeDebit: Transaction | null = null;
      let writeRefundRow: (() => void) | null = null;
      if (status === "cancelled" && isPaidWithMoney(current)) {
        const ctx = await readRefundContext(tx, current, at);
        if (!ctx.fee) {
          // Legacy data: paid, but no settled Paystack fee Transaction to
          // refund against. The cancel goes through; a human looks at it.
          console.error(
            `[consultation] ${id} is paid but has no settled Paystack consultation_fee Transaction: ` +
              "cancelled without a refund row"
          );
        } else if (ctx.existingRefund) {
          // Already refunded (an admin refunded first): nothing new.
          refund = ctx.existingRefund;
        } else {
          // Once the fee is released the meeting has happened: the agent
          // side can no longer cancel it (only an admin refund can give it back).
          if (actor === CONSULTATION_ACTORS.AGENT_SIDE && ctx.feeHold === "released") {
            return {
              kind: "refused",
              refusal: {
                ok: false,
                code: "FEE_RELEASED",
                httpStatus: 409,
                message:
                  "This consultation's fee has been released because the meeting has happened, so it can no longer be cancelled.",
              },
            };
          }
          const money = decideCancellationRefund(
            actor === CONSULTATION_ACTORS.AGENT_SIDE ? "agent_side" : "client",
            current,
            at,
            // Review fix: the client's 24 h are measured from the paid slot too.
            ctx.fee
          );
          if (money.kind === "full") {
            // Issue #390: who carries Paystack's fee (the reason says) and
            // how much moves, from the fee stored on the row or the lookup
            // made before this transaction. Unknown: a HELD row, no money.
            const planned = planRefund(ctx, {
              reason: money.reason,
              lookup: lookedUpFeeId === ctx.fee.id ? feeLookup : null,
              at,
            });
            writeRefundRow = () => {
              const written = writeRefund(tx, ctx, {
                booking: current,
                reason: money.reason,
                initiatedBy: extra?.cancelledBy ?? "unknown",
                at,
                planned,
              });
              refund = written.row;
              feeDebit = written.debit;
              Object.assign(updates, bookingRefundFields(written.row));
              refundCreated = true;
            };
          }
          // late_client_cancel: no row; the agent keeps the fee (it stays
          // held until slot end + 24 h, then releases as usual).
        }
      }

      // ---- Issue #317: the meeting is closed, so its fee may release ----
      // Completed / no_show (the client did not show: the agent keeps the
      // fee) stamp `meetingClosedAt` on a held fee; it releases once the
      // slot has started (see feeHoldStatusAt).
      let closeFee: Transaction | null = null;
      if ((status === "completed" || status === "no_show") && isPaidWithMoney(current)) {
        const fee = await readFeeTransaction(tx, current);
        if (fee?.feeHold && fee.feeHold.state === "held" && feeHoldStatusAt(fee, at) === "held" && !fee.feeHold.meetingClosedAt) {
          closeFee = fee;
        }
      }

      // ---- Writes ----
      if (writeRefundRow) writeRefundRow();
      if (closeFee) {
        tx.update(collections.transactions.doc(closeFee.id), { "feeHold.meetingClosedAt": now, updatedAt: now });
      }
      tx.update(ref, updates);
      // The stored doc after the commit: the fresh copy plus what was written.
      return {
        kind: "changed",
        before: current,
        consultation: { ...current, ...updates } as Consultation,
        refund,
        refundCreated,
        feeDebit,
      };
    });
  }

  /**
   * Hard-delete a consultation, unless it has (or may still receive) a
   * payment (issue #151, see `bookingHasPayment`). The check and the delete
   * are one Firestore transaction, so a checkout opened or a payment
   * confirmed in between is seen. WHO may delete (admins only) is the
   * controller's check.
   */
  async deleteUnpaidConsultation(id: string): Promise<DeleteConsultationOutcome> {
    const ref = collections.consultations.doc(id);
    return chargeRuntime.runTransaction<DeleteConsultationOutcome>(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return { kind: "not_found" };
      const current = snap.data() as Consultation;
      if (bookingHasPayment(current)) return { kind: "has_payment" };
      tx.delete(ref);
      return { kind: "deleted", consultation: current };
    });
  }

  /**
   * Compute aggregate stats from a list of consultations.
   */
  computeStats(consultations: Consultation[]): ConsultationStats {
    const now = Timestamp.now();
    let upcoming = 0;
    let completed = 0;
    let cancelled = 0;
    let noShow = 0;

    for (const c of consultations) {
      switch (c.status) {
      case "completed":
        completed++;
        break;
      case "cancelled":
        cancelled++;
        break;
      case "no_show":
        noShow++;
        break;
      case "scheduled":
      case "confirmed":
        if (c.scheduledDate.toMillis() >= now.toMillis()) {
          upcoming++;
        }
        break;
      }
    }

    return {
      total: consultations.length,
      upcoming,
      completed,
      cancelled,
      noShow,
    };
  }

  // ============================================
  // HELPERS
  // ============================================

  private applyFilters(
    query: FirebaseFirestore.Query,
    filters?: ConsultationFilters
  ): FirebaseFirestore.Query {
    if (!filters) return query;

    if (filters.status) {
      query = query.where("status", "==", filters.status);
    }
    if (filters.applicationId) {
      query = query.where("applicationId", "==", filters.applicationId);
    }
    if (filters.type) {
      query = query.where("type", "==", filters.type);
    }
    if (filters.startDate) {
      query = query.where(
        "scheduledDate",
        ">=",
        Timestamp.fromDate(new Date(filters.startDate))
      );
    }
    if (filters.endDate) {
      query = query.where(
        "scheduledDate",
        "<=",
        Timestamp.fromDate(new Date(filters.endDate))
      );
    }

    return query;
  }
}

export const consultationService = new ConsultationService();
