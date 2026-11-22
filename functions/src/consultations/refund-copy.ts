// ============================================
// Refund copy shared by the verify 409, the refund notice and the guest's
// pay-again email (issue #413 C, #391, #411)
// ============================================
//
// Review round 1 of #391: moved out of consultation-refund.service.ts into
// this dependency-free module, so the pay-link service can use it without a
// static import cycle (charge -> pay-link -> refund -> charge).

/**
 * The client's copy for a payment refunded because the booking moved (issue
 * #354 `paid_for_rescheduled_slot`; wording issue #413 C, decision
 * 2026-11-21, plus the guest variant from the coordinator the same day).
 * Shared by the verify 409 `CONSULTATION_RESCHEDULED` message and the
 * refund notification, so the two can never drift apart. Pure.
 *
 * "we're refunding ... on its way", never "we've refunded": the refund may
 * still be pending, or held for an admin (#392 design).
 *
 *  - app client: "... Please pay again for the new time.";
 *  - guest (`bookedVia: "public_page"`): "... We've emailed you a link to
 *    pay for the new time." (#391 sends that email);
 *  - when the booking no longer awaits payment (paid through a fresh
 *    checkout, or cancelled: #354 fix round) the last sentence is left out.
 *
 * @param opts.guestBooking the booking was made by a guest on a public page
 * @param opts.bookingAwaitingPayment the booking still awaits payment (default true)
 * @param opts.bookingCancelled (issue #411) the booking was cancelled right
 *   after this refund (the sweep's settle-then-cancel): "cancelled", no "pay again"
 */
export function rescheduledRefundMessage(
  opts: { guestBooking?: boolean; bookingAwaitingPayment?: boolean; bookingCancelled?: boolean } = {}
): string {
  // Issue #411 (orchestrator, review round 1): the abandoned-booking sweep
  // refunded a late payment on a retired checkout and then CANCELLED the
  // booking in the same run. "Pay again" would be wrong: there is nothing
  // left to pay for.
  if (opts.bookingCancelled) {
    return "Your consultation was cancelled, so we're refunding your payment in full. Your refund is on its way.";
  }
  const base = "Your consultation moved, so we're refunding your payment in full. Your refund is on its way.";
  if (opts.bookingAwaitingPayment === false) return base;
  return opts.guestBooking
    ? `${base} We've emailed you a link to pay for the new time.`
    : `${base} Please pay again for the new time.`;
}

