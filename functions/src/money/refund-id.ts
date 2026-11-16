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
