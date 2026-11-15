import { collections } from "../utils/firebase";
import { Consultation, ConsultationStatus, ConsultationType } from "../types";
import { Timestamp } from "firebase-admin/firestore";
import { ROLES } from "@durin-tech/authz";
// Issue #151: the shared clock and Firestore transaction runner of the charge
// path (tests swap both through the consultations harness). The status change
// uses the SAME clock as the quote lock it reads, and the same runner as
// `settlePayment`, so a cancel and a payment can never interleave.
import { chargeRuntime, isQuoteExpired } from "./charge-checkout.service";

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

/** Why a status change was refused: the API error code and its HTTP status. */
export interface StatusChangeRefusal {
  ok: false;
  code: "FORBIDDEN" | "VALIDATION_ERROR" | "INVALID_STATUS_TRANSITION" | "PAYMENT_IN_PROGRESS";
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
  booking: Pick<Consultation, "status" | "transactionId" | "checkoutUrl" | "quoteExpiresAt">,
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
  code: "FORBIDDEN" | "VALIDATION_ERROR" | "BOOKING_NOT_EDITABLE" | "PAYMENT_IN_PROGRESS";
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

/** What `editConsultation` did. `refused` and `not_found` wrote nothing. */
export type EditConsultationOutcome =
  | { kind: "not_found" }
  | { kind: "refused"; refusal: EditRefusal }
  | { kind: "edited"; before: Consultation; consultation: Consultation };

/** What `changeStatus` did. `refused` and `not_found` wrote nothing. */
export type ChangeStatusOutcome =
  | { kind: "not_found" }
  | { kind: "refused"; refusal: StatusChangeRefusal }
  | { kind: "changed"; before: Consultation; consultation: Consultation };

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

      tx.update(ref, write);
      // The stored doc after the commit: the fresh copy plus what was written.
      return { kind: "edited", before: current, consultation: { ...current, ...write } as Consultation };
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
    return chargeRuntime.runTransaction<ChangeStatusOutcome>(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return { kind: "not_found" };
      const current = snap.data() as Consultation;
      const at = chargeRuntime.now();

      const decision = decideStatusChange(actorFor(current), current, status, at);
      if (!decision.ok) return { kind: "refused", refusal: decision };

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

      tx.update(ref, updates);
      // The stored doc after the commit: the fresh copy plus what was written.
      return { kind: "changed", before: current, consultation: { ...current, ...updates } as Consultation };
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
