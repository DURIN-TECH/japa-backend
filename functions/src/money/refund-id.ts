// ============================================
// The refund row id of a Paystack charge (issue #317, moved here in #354)
// ============================================
//
// Kept in its own module, with no imports from the charge or refund
// services, so that both `consultation-charge.service.ts` (which writes the
// refund of an unapplied payment inside `settlePayment`, #354) and
// `consultation-refund.service.ts` (the #317 engine) can use the SAME id
// without importing each other at load time.

import { createHash } from "crypto";

/**
 * The refund row's doc id for one charge (issue #317): `refund_` + the
 * SHA-256 of the charge's Paystack reference. Deterministic, so one Paystack
 * charge can only ever have one refund row. Hashed rather than the raw
 * reference so that (a) it is always a valid single document id whatever
 * the reference holds, and (b) the client's payment history, which shows
 * each row's `id`, never carries a Paystack reference (#329 allow-list).
 */
export function refundDocId(reference: string): string {
  return `refund_${createHash("sha256").update(reference).digest("hex")}`;
}

/**
 * Issue #354 (decision 2026-11-16): the doc id of the agent's Paystack-fee
 * debit for one charge: `feedebit_` + the SHA-256 of the charge's Paystack
 * reference. Deterministic, like `refundDocId`, so one charge can only ever
 * debit an agent ONCE, however many verifies or webhooks settle it. Hashed
 * for the same reasons (a valid doc id; no raw Paystack reference in ids).
 */
export function feeDebitDocId(reference: string): string {
  return `feedebit_${createHash("sha256").update(reference).digest("hex")}`;
}

/**
 * Issue #413 (mismatch resolution): the doc id of the ONE top-up refund a
 * charge can ever get (`refundtopup_` + the SHA-256 of its Paystack
 * reference), sent when Paystack refunded less than planned and the admin
 * put the gap on the agent. Deterministic and written with `tx.create`, so
 * a second resolve can never send a second top-up.
 */
export function mismatchTopUpDocId(reference: string): string {
  return `refundtopup_${createHash("sha256").update(reference).digest("hex")}`;
}

/**
 * Issue #413 (mismatch resolution): the doc id of the ONE agent adjustment a
 * charge can ever get (`refundadj_` + the SHA-256 of its reference).
 */
export function mismatchAdjustmentDocId(reference: string): string {
  return `refundadj_${createHash("sha256").update(reference).digest("hex")}`;
}
