// ============================================
// Guest "pay again" links (issue #391)
// ============================================
//
// WHY THIS EXISTS
// A guest books on an agency's public page (`/a/<slug>`) without signing in
// (`bookedVia: "public_page"`). When the agent side moves the booking after
// its quote lock, #354 retires the old checkout; a payment that still lands
// on it is refunded in full (`paid_for_rescheduled_slot`) and the booking
// stays `pending_payment`. A signed-in client can open a fresh checkout from
// the app (`POST /consultations/:id/checkout`), but a guest cannot: that
// route needs a signed-in client. So the guest is emailed a one-time,
// expiring link that opens a checkout on THAT booking only, priced now.
//
// THE RULES (orchestrator decisions 2026-11-17, issue #391)
//  - TOKEN: 32 random bytes from `crypto.randomBytes`, base64url (43 chars).
//    Only its SHA-256 is stored (the doc id of `consultationPayLinks`). The
//    raw token lives ONLY in the email: never in Firestore, never in a log
//    line, never in an in-app notification, never in an API response.
//  - EXPIRY: the earlier of 72 hours after minting and the booking's slot
//    start (`slotStartsAt`). A slot that already started gets no link.
//  - ONE LIVE LINK PER BOOKING: minting a new link marks every older unused
//    one `supersededAt` in the SAME Firestore transaction.
//  - SWEEP HAND-OFF (#411): that transaction also sets the booking's
//    `payLinkExpiresAt` to the new link's `expiresAt`, so the abandoned-
//    booking sweep does not cancel the booking while the link still works.
//  - USED UP only by a successful payment: `settlePayment` confirming the
//    booking sets `usedAt` in its own transaction (see `readLivePayLinks` /
//    `markPayLinksUsed`). Opening a checkout does NOT use it, so a guest who
//    abandons Paystack can try again until the link expires.
//  - WHEN IT IS SENT: as soon as the late payment is RECORDED, even when the
//    refund itself is held for an admin (Paystack's fee unknown). Later, when
//    a held refund starts (admin retry or a re-settle), a new link is minted
//    only if the booking has no live one any more.
//  - NEVER IN A URL THE SERVER SEES (decision 2026-11-21): the email links
//    to `/a/<slug>/pay#t=<token>` (a fragment), and the API takes the token
//    in a POST body (`/consultations/public/pay-links/lookup` and
//    `/checkout`), so it is in no Cloud Run or hosting request log. The
//    request logger (app.ts) logs only method + path, never a body.
//  - DEAD LINKS: unknown, expired, used, superseded, or a booking that is no
//    longer `pending_payment` all answer ONE identical 410
//    `PAY_LINK_INVALID`. The answer never says which, and nothing is written.
//  - NO ACCESS TO ANYTHING ELSE: the token is not a Firebase token, sets no
//    cookie and no claim. It can read one booking's payer-safe summary and
//    open a checkout on it, nothing more.
//
// LOOKUP IS CONSTANT-TIME: the doc is fetched by the hash (a key lookup, no
// comparison of secrets), and the stored `tokenHash` is then compared with
// `crypto.timingSafeEqual` as defence in depth.

import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { Timestamp } from "firebase-admin/firestore";
import type { Transaction as FirestoreTransaction } from "firebase-admin/firestore";
import { collections } from "../utils/firebase";
import type { Agency, Consultation, ConsultationPayLink, ConsultationPaymentException } from "../types";
import { chargeRuntime, hasChargeSnapshot } from "./charge-checkout.service";
import { slotStartsAt, DEFAULT_BOOKING_TIMEZONE, isKnownTimeZone } from "../consultations/slot-time";
import { EMAIL_BRANDING } from "./email/branding";
import { emailService } from "./email/email.service";
// Issue #413 (C): the shared "your consultation moved" refund copy.
import { rescheduledRefundMessage } from "../consultations/refund-copy";

// ============================================
// 1. Constants
// ============================================

/** How many random bytes a token carries (>= 32 by decision: 256 bits). */
export const PAY_LINK_TOKEN_BYTES = 32;

/** How long a link lives at most, in hours (capped at the slot start). */
export const PAY_LINK_TTL_HOURS = 72;

/** Milliseconds per hour (kept named so the expiry maths reads plainly). */
const HOUR_MS = 3_600_000;

/**
 * The exact shape of a token: 32 bytes in base64url without padding is
 * always 43 characters from [A-Za-z0-9_-]. Anything else is malformed (400)
 * and is refused BEFORE any Firestore read.
 */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** The one error code every dead link answers with. */
export const PAY_LINK_INVALID = "PAY_LINK_INVALID";

/** The one message every dead link answers with (issue #391 copy). */
export const PAY_LINK_INVALID_MESSAGE = "This payment link is no longer valid. Please contact the agency.";

// ============================================
// 2. Swappable dependencies (tests inject in-memory ones)
// ============================================

/**
 * Where this module gets its clock, its transaction runner and its random
 * bytes. The clock and the runner are the SHARED charge runtime (so the
 * unit-test harness that stubs `consultationCharging` stubs these too);
 * `randomBytes` and `sendEmail` can be replaced by a test to observe the
 * raw token (which is otherwise never visible anywhere but the email).
 */
export const payLinkRuntime: {
  /** Random bytes for a new token (production: crypto.randomBytes). */
  randomBytes: (n: number) => Buffer;
  /**
   * Sends the pay-again email (production: the branded Resend template).
   * Review round 1: answers how the send went; only "sent" counts as emailed.
   */
  sendEmail: (message: PayLinkEmail) => Promise<PayLinkEmailStatus>;
} = {
  randomBytes: (n) => randomBytes(n),
  sendEmail: (message) => sendPayLinkEmail(message),
};

// ============================================
// 3. Tokens: shape, hash, constant-time compare (pure)
// ============================================

/** True when `token` has the exact shape of one of our tokens. Pure. */
export function isWellFormedPayLinkToken(token: unknown): token is string {
  return typeof token === "string" && TOKEN_SHAPE.test(token);
}

/** The hex SHA-256 of a raw token: the doc id it is stored under. Pure. */
export function hashPayLinkToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Constant-time equality of two hex hashes (false on any length mismatch). Pure. */
function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  // timingSafeEqual throws on different lengths; a different length is
  // simply "not equal" (and both are fixed-length hashes in practice).
  return left.length === right.length && timingSafeEqual(left, right);
}

/** A fresh raw token (32 random bytes, base64url, no padding). */
function newToken(): string {
  return payLinkRuntime.randomBytes(PAY_LINK_TOKEN_BYTES).toString("base64url");
}

// ============================================
// 4. Expiry (pure)
// ============================================

/**
 * When a link minted at `now` for `booking` expires: the earlier of
 * PAY_LINK_TTL_HOURS after `now` and the booking's slot start. Null when the
 * slot cannot be read (no link: we cannot cap it safely) or has already
 * started (nothing left to pay for). Pure.
 */
export function payLinkExpiry(
  booking: Pick<Consultation, "scheduledDate" | "scheduledTime" | "timezone">,
  now: Date
): Date | null {
  let slot: Date;
  try {
    slot = slotStartsAt(booking);
  } catch {
    return null;
  }
  const ttl = now.getTime() + PAY_LINK_TTL_HOURS * HOUR_MS;
  const expires = Math.min(ttl, slot.getTime());
  return expires > now.getTime() ? new Date(expires) : null;
}

/** Review round 1: how the pay-again email went (`emailService.sendNotification`'s status). */
export type PayLinkEmailStatus = "sent" | "failed" | "skipped";

/** Review round 1: true when the booking's slot starts after `at` (false when it cannot be read). Pure. */
export function slotStillAhead(booking: Pick<Consultation, "scheduledDate" | "scheduledTime" | "timezone">, at: Date): boolean {
  try {
    return slotStartsAt(booking).getTime() > at.getTime();
  } catch {
    return false;
  }
}

/**
 * Review round 3: true when a link is live at `at` AND its email was
 * recorded as sent (`emailStatus: "sent"`). Pure. What "the guest was
 * emailed a working link" means everywhere (the guest copy, re-minting).
 */
export function isLiveEmailedLink(
  link: Pick<ConsultationPayLink, "usedAt" | "supersededAt" | "expiresAt" | "emailStatus">,
  at: Date
): boolean {
  return link.emailStatus === "sent" && isLinkLive(link, at);
}

/**
 * Review round 3: whether booking `consultationId` has a live link whose
 * email was sent (read now; single-field equality query, no index).
 * Never throws: a failed read answers false (the copy then makes no claim).
 */
export async function hasLiveEmailedPayLink(consultationId: string): Promise<boolean> {
  try {
    const snap = await collections.consultationPayLinks.where("consultationId", "==", consultationId).get();
    const at = chargeRuntime.now();
    return snap.docs.some((d) => isLiveEmailedLink(d.data() as ConsultationPayLink, at));
  } catch (error) {
    console.error(`[pay-link] ${consultationId}: could not read the pay links:`, error);
    return false;
  }
}

/** True when a link is still unused, not superseded and not expired at `at`. Pure. */
export function isLinkLive(link: Pick<ConsultationPayLink, "usedAt" | "supersededAt" | "expiresAt">, at: Date): boolean {
  if (link.usedAt || link.supersededAt) return false;
  const expires = link.expiresAt as unknown as { toMillis?: () => number } | undefined;
  if (!expires || typeof expires.toMillis !== "function") return false;
  return at.getTime() < expires.toMillis();
}

/**
 * True when a booking can be paid through a pay link: a guest booking still
 * awaiting payment, with a #180 charge snapshot to re-price. Pure.
 */
export function isPayableGuestBooking(c: Consultation | null | undefined): c is Consultation {
  return (
    !!c &&
    c.bookedVia === "public_page" &&
    c.status === "pending_payment" &&
    c.paymentStatus !== "paid" &&
    hasChargeSnapshot(c)
  );
}

// ============================================
// 5. Minting
// ============================================

/** A freshly minted link: the RAW token (for the email only) and what was stored. */
export interface MintedPayLink {
  token: string;
  link: ConsultationPayLink;
  booking: Consultation;
  agencyName: string;
}

/**
 * Mint a pay-again link for one guest booking, in ONE Firestore transaction:
 * re-read the booking and its agency, mark every older unused link of the
 * booking superseded, and create the new one (`tx.create`, so a hash
 * collision can never overwrite a link). Returns null, writing nothing, when
 * the booking is not a payable guest booking, its agency has no slug, or
 * its slot has started.
 *
 * @param consultationId the booking
 * @param exceptionId the Paystack reference of the refunded payment
 * @param opts.onlyIfNoLiveLink mint only when the booking has no live link
 *   (a held refund that starts later: the guest already has a working link)
 */
export async function mintPayLink(
  consultationId: string,
  exceptionId: string,
  opts: { onlyIfNoLiveLink?: boolean } = {}
): Promise<MintedPayLink | null> {
  const token = newToken();
  const tokenHash = hashPayLinkToken(token);
  const bookingRef = collections.consultations.doc(consultationId);
  const linkRef = collections.consultationPayLinks.doc(tokenHash);

  return chargeRuntime.runTransaction<MintedPayLink | null>(async (tx) => {
    // ---- Reads (all before any write) ----
    const bookingSnap = await tx.get(bookingRef);
    const booking = bookingSnap.exists ? (bookingSnap.data() as Consultation) : null;
    if (!isPayableGuestBooking(booking) || !booking.agencyId) return null;
    const agencySnap = await tx.get(collections.agencies.doc(booking.agencyId));
    const agency = agencySnap.exists ? (agencySnap.data() as Agency) : null;
    if (!agency?.slug) {
      console.error(`[pay-link] ${consultationId}: the agency has no public slug; no pay link minted`);
      return null;
    }
    // Every link of this booking (single-field equality: no composite index).
    const existing = await tx.get(collections.consultationPayLinks.where("consultationId", "==", consultationId));

    const at = chargeRuntime.now();
    const expiresAt = payLinkExpiry(booking, at);
    if (!expiresAt) {
      console.warn(`[pay-link] ${consultationId}: the slot has started (or cannot be read); no pay link minted`);
      return null;
    }
    const older = existing.docs.map((d) => ({ ref: d.ref, data: d.data() as ConsultationPayLink }));
    // Review round 3: only a live link whose email was SENT counts. A live
    // link whose last email failed (or was skipped) is replaced: a fresh one
    // is minted (superseding it below) and emailed.
    if (opts.onlyIfNoLiveLink && older.some((l) => isLiveEmailedLink(l.data, at))) return null;

    // ---- Writes ----
    const now = Timestamp.fromDate(at);
    // A newer link kills every older unused one (at most one live link).
    for (const l of older) {
      if (!l.data.usedAt && !l.data.supersededAt) tx.update(l.ref, { supersededAt: now });
    }
    const link: ConsultationPayLink = {
      id: tokenHash,
      tokenHash,
      consultationId,
      agencyId: booking.agencyId,
      agencySlug: agency.slug,
      exceptionId,
      createdAt: now,
      expiresAt: Timestamp.fromDate(expiresAt),
      usedAt: null,
      supersededAt: null,
    };
    tx.create(linkRef, link);
    // Issue #411 hand-off (decision 2026-11-21): the booking carries the live
    // link's expiry, in this same commit, so the abandoned-booking sweep keeps
    // a guest's booking open until the link the guest was emailed has expired
    // (never past the slot start). A replaced link moves it to the new
    // expiry. When the link is USED the field is left as it is: the booking
    // is paid then, and the sweep skips paid bookings.
    tx.update(bookingRef, { payLinkExpiresAt: link.expiresAt });
    return { token, link, booking: { ...booking, payLinkExpiresAt: link.expiresAt }, agencyName: agency.name };
  });
}

// ============================================
// 6. The email (raw token here and nowhere else)
// ============================================

/** What the pay-again email needs. */
export interface PayLinkEmail {
  to: string;
  agencyId: string;
  /** The full portal URL, with the raw token. */
  url: string;
  /** The link's expiry, already worded in the booking's timezone. */
  expiresText: string;
}

/**
 * The portal page a link opens: `<APP_URL>/a/<slug>/pay#t=<token>` (APP_URL
 * per project). Orchestrator decision 2026-11-21: the token rides in the URL
 * FRAGMENT, which browsers never send to a server, so it cannot land in the
 * portal's hosting logs; the page reads it and POSTs it in a request body
 * (never in a path or query string, so not in Cloud Run request logs either).
 */
export function payLinkUrl(slug: string, token: string): string {
  const base = EMAIL_BRANDING.appUrl.replace(/\/+$/, "");
  return `${base}/a/${encodeURIComponent(slug)}/pay#t=${token}`;
}

/**
 * The expiry in words, in the booking's own timezone, naming that timezone,
 * e.g. "Tuesday, 24 November 2026 at 10:00 (Africa/Lagos)". Pure.
 */
export function describeExpiry(expiresAt: Date, timezone: string | undefined): string {
  const zone = isKnownTimeZone(timezone) ? timezone : DEFAULT_BOOKING_TIMEZONE;
  const text = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(expiresAt);
  return `${text} (${zone})`;
}

/**
 * The pay-again email's body (issue #391 copy, orchestrator wording: the
 * refund is "on its way", so it also reads right while it is held for an
 * admin). The link itself is the button and the text-part line below it
 * (`renderNotificationText` prints `<label>: <url>`). Pure.
 */
export function payLinkEmailBody(expiresText: string): string {
  // Issue #413 (C) integration: the "your consultation moved" sentence comes
  // from the ONE shared copy function, so the email, the in-app notice and
  // the verify 409 message can never drift apart. Asked WITHOUT its last
  // "pay again" sentence (`bookingAwaitingPayment: false` returns the bare
  // refund sentence): this email says how to pay in its own words, with the
  // link, below.
  return (
    `${rescheduledRefundMessage({ bookingAwaitingPayment: false })}\n` +
    "Pay for the new time with the link below. " +
    `The link works for this booking only and expires on ${expiresText}.`
  );
}

/**
 * Send the pay-again email through the shared branded template
 * (`emailService.sendNotification`, as the reset-password email does),
 * co-branded with the booking's agency. NOT through `notifyUser`: that
 * writes the body to the in-app inbox and to `notificationDeliveries`, and
 * the raw token must be in neither. The delivery is recorded WITHOUT the
 * link. Never throws.
 */
async function sendPayLinkEmail(message: PayLinkEmail): Promise<PayLinkEmailStatus> {
  const subject = "Pay for your new consultation time";
  const body = payLinkEmailBody(message.expiresText);
  let status: "sent" | "failed" | "skipped" = "failed";
  let error: string | null = null;
  try {
    const result = await emailService.sendNotification({
      to: message.to,
      subject,
      title: "Your consultation moved",
      body,
      actionUrl: message.url,
      actionLabel: "Pay for the new time",
      brandFor: { agencyId: message.agencyId },
    });
    status = result.status === "sent" ? "sent" : result.status === "skipped" ? "skipped" : "failed";
    error = result.error ?? null;
    if (result.status !== "sent") console.error(`[pay-link] email ${result.status}: ${result.error ?? ""}`);
  } catch (err) {
    error = (err as Error).message;
    console.error("[pay-link] email delivery failed:", error);
  }
  // Audit row, as notifyUser keeps one, but with NO link in it.
  try {
    await collections.notificationDeliveries.add({
      channel: "email",
      to: message.to,
      subject,
      body: `${body} [pay link omitted]`,
      type: "consultation_pay_link",
      status,
      error,
      createdAt: Timestamp.now(),
    });
  } catch (err) {
    console.error("[pay-link] email delivery record failed:", err);
  }
  return status;
}

/** Review round 3: store how link `linkId`'s email went. Never throws (logged). */
async function recordEmailStatus(linkId: string, status: PayLinkEmailStatus): Promise<void> {
  const now = Timestamp.fromDate(chargeRuntime.now());
  try {
    await collections.consultationPayLinks.doc(linkId).update({
      emailStatus: status,
      emailStatusAt: now,
      ...(status === "sent" ? { emailedAt: now } : {}),
    });
  } catch (error) {
    console.error(`[pay-link] link ${linkId.slice(0, 12)}…: could not record its email status:`, error);
  }
}

/**
 * After a late payment on a rescheduled guest booking was recorded (issue
 * #391): mint the booking's pay-again link and email it to the guest.
 * Called by `settlePayment` (the payment was just recorded, refund started
 * or held) and by `startUnappliedRefund` (a refund starts, also on an admin
 * retry of a held one). Never throws: a failure here must never fail a
 * payment settlement or a refund.
 *
 * @param exception the exception just written
 * @param opts.bookingAwaitingPayment whether the booking still awaited
 *   payment in the transaction that wrote it (else nothing to pay for)
 * @param opts.firstRecorded true when this call RECORDED the exception (the
 *   guest is always sent a link then); false when a refund starts later or
 *   the payment is settled again (a link only when the booking has no live
 *   link whose email was SENT: review round 3, a failed send is re-minted)
 * @returns true when the pay-again email was SENT (review round 1: a
 *   failed or skipped send is false), and the caller then
 *   leaves the email channel out of its own refund notice, so the guest gets
 *   one email, the one with the link)
 */
export async function sendGuestPayAgainLink(
  exception: Pick<ConsultationPaymentException, "consultationId" | "reference" | "reason">,
  opts: { bookingAwaitingPayment: boolean; firstRecorded: boolean }
): Promise<boolean> {
  if (exception.reason !== "paid_for_rescheduled_slot" || !opts.bookingAwaitingPayment) return false;
  try {
    const minted = await mintPayLink(exception.consultationId, exception.reference, {
      onlyIfNoLiveLink: !opts.firstRecorded,
    });
    if (!minted) return false;
    const status = await payLinkRuntime.sendEmail({
      to: minted.booking.clientEmail,
      agencyId: minted.link.agencyId,
      url: payLinkUrl(minted.link.agencySlug, minted.token),
      expiresText: describeExpiry(minted.link.expiresAt.toDate(), minted.booking.timezone),
    });
    // Review round 3: record the send status ON THE LINK, so every later
    // answer (a repeat verify, the notice of an admin retry) knows whether
    // the guest was really emailed, and a failed one is re-minted.
    await recordEmailStatus(minted.link.id, status);
    // Review round 1: only a SENT email counts. A failed or skipped send
    // leaves the refund notice with its own email (the guest still hears
    // about the refund), and the notice does not claim a link was emailed.
    if (status !== "sent") {
      console.error(`[pay-link] ${exception.consultationId}: the pay-again email was not sent (${status})`);
      return false;
    }
    // The link's id is its hash: safe to log; the token never is.
    console.log(`[pay-link] ${exception.consultationId}: pay-again link ${minted.link.id.slice(0, 12)}… emailed`);
    return true;
  } catch (error) {
    console.error(`[pay-link] ${exception.consultationId}: minting or emailing the pay-again link failed:`, error);
    return false;
  }
}

// ============================================
// 7. Resolving a token (the public routes)
// ============================================

/** A live link and its booking (never returned to a caller as is). */
export interface ResolvedPayLink {
  link: ConsultationPayLink;
  booking: Consultation;
  agency: Agency;
}

/**
 * Resolve a WELL-FORMED raw token to its live link and booking, or null when
 * the link is dead in any way (unknown, expired, used, superseded), its
 * booking is gone or no longer payable, or its agency is gone. The caller
 * answers every null with the same 410. Reads only; writes nothing.
 */
export async function resolvePayLink(token: string): Promise<ResolvedPayLink | null> {
  const tokenHash = hashPayLinkToken(token);
  const snap = await collections.consultationPayLinks.doc(tokenHash).get();
  if (!snap.exists) return null;
  const link = snap.data() as ConsultationPayLink;
  // Defence in depth: the stored hash must equal ours (constant time).
  if (typeof link.tokenHash !== "string" || !sameHash(link.tokenHash, tokenHash)) return null;
  if (!isLinkLive(link, chargeRuntime.now())) return null;
  const bookingSnap = await collections.consultations.doc(link.consultationId).get();
  const booking = bookingSnap.exists ? (bookingSnap.data() as Consultation) : null;
  // Single-booking scope: the booking named by the link, and still payable.
  if (!isPayableGuestBooking(booking) || booking.id !== link.consultationId) return null;
  // Review round 1: never once the slot has started (the booking may have
  // been moved EARLIER after the link was minted, so the link's own expiry,
  // capped at the old slot, is not enough). Unreadable slot: dead too.
  if (!slotStillAhead(booking, chargeRuntime.now())) return null;
  const agencySnap = await collections.agencies.doc(link.agencyId).get();
  if (!agencySnap.exists) return null;
  return { link, booking, agency: agencySnap.data() as Agency };
}

// ============================================
// 8. Used up by a payment (inside settlePayment's transaction)
// ============================================

/**
 * Read, through `tx`, the links of a guest booking that a confirming payment
 * uses up (the live one: unused, not superseded, not expired). Must run BEFORE settlePayment's
 * writes (Firestore: reads first). Not a guest booking: nothing is read.
 */
export async function readLivePayLinks(
  tx: FirestoreTransaction,
  booking: Pick<Consultation, "id" | "bookedVia">,
  consultationId: string
): Promise<FirebaseFirestore.DocumentReference[]> {
  if (booking.bookedVia !== "public_page") return [];
  const snap = await tx.get(collections.consultationPayLinks.where("consultationId", "==", consultationId));
  const at = chargeRuntime.now();
  // Only a LIVE link is "used": an expired or superseded one stays as it was.
  return snap.docs.filter((d) => isLinkLive(d.data() as ConsultationPayLink, at)).map((d) => d.ref);
}

/**
 * Mark those links used, through `tx`, in the same commit that confirms the
 * booking (so a link is used up exactly when its booking is paid).
 */
export function markPayLinksUsed(
  tx: FirestoreTransaction,
  refs: FirebaseFirestore.DocumentReference[],
  now: Timestamp,
  reference: string
): void {
  for (const ref of refs) tx.update(ref, { usedAt: now, usedByReference: reference });
}
