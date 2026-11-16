// ============================================
// Client payment-request projection (issue #332, follow-up of #329)
// ============================================
//
// The payment-request endpoints answer the request's CLIENT (the payer)
// with `ClientPaymentRequest`, never with the raw Firestore
// `PaymentRequest`. The stored document is what agents, owners and admins
// work with, and it carries things a paying client must not see:
//  - `fxMarginBps`: Seli's exchange-rate markup;
//  - `fxRate` / `fxRateAsOf` / `fxRateSource`: the raw (mid-market) rate the
//    markup is added to. With the amount charged it gives the markup away;
//  - `supersededCheckouts`: every replaced checkout, EACH with its own full
//    snapshot (raw rate and markup again);
//  - checkout and settlement bookkeeping (`checkoutCallbackUrl`,
//    `paidAfterQuoteExpiry`, `paidOnSupersededReference`, `paystackPaidAt`,
//    `paymentTransactionId`).
//
// `toClientPaymentRequest` is a field-by-field ALLOW-LIST, like
// `toClientTransaction` (transactions/client-transaction.ts) and
// `toClientConsultation` (consultations/client-consultation.ts). Do not
// rewrite it as `{ ...r }` or "omit these keys": a new `PaymentRequest`
// field must stay hidden from clients until it is added here deliberately.
// test/payment-requests/client-payment-request-allow-list.test.ts pins the
// key set and fails when a stored field (known or brand new) reaches a
// client.
//
// The charge is given through `clientChargeFields` (money/client-charge.ts):
// the dollar price, the amount charged, the quote lock, and the EFFECTIVE
// rate (amount charged ÷ dollar price, markup included) in place of the raw
// rate. The display fields every caller gets (`legacy`, `priceUsd`,
// `charge`, `amountDisplay`: see `requestChargeSummary`) are kept; they are
// built from the dollar price and the amount charged only.

import type { Timestamp } from "firebase-admin/firestore";
import { ROLES } from "@durin-tech/authz";
import type { PaymentRequest, PaymentRequestCategory, PaymentRequestStatus } from "../types";
import type { Money } from "../types/money";
import { CLIENT_CHARGE_FIELDS, ClientChargeFields, clientChargeFields } from "../money/client-charge";
import {
  describeRequestAmount,
  expectedRequestCharge,
  isUsdPaymentRequest,
  requestPriceUsd,
} from "../services/payment-request-charge.service";

/**
 * The exact key set of a client payment-request response. Exported so tests
 * assert against the same list. Keys that are optional on
 * `ClientPaymentRequest` appear only when the stored request has them.
 */
export const CLIENT_PAYMENT_REQUEST_FIELDS = [
  "id",
  "applicationId",
  "agentId",
  "agencyId",
  "clientId",
  "clientName",
  "clientEmail",
  "amount",
  "currency",
  "description",
  "category",
  "status",
  // The charge, as a payer may see it (money/client-charge.ts).
  ...CLIENT_CHARGE_FIELDS,
  // Display fields built from the dollar price and the amount charged.
  "legacy",
  "priceUsd",
  "charge",
  "amountDisplay",
  "paystackReference",
  "checkoutUrl",
  "paidAt",
  "cancelledAt",
  "expiresAt",
  "approvedAt",
  "rejectedAt",
  "rejectionReason",
  "createdAt",
  "updatedAt",
] as const;

/**
 * One payment request as its client may see it. Timestamps are passed
 * through as stored, so they serialize exactly as they did before #332.
 */
export interface ClientPaymentRequest extends ClientChargeFields {
  /** The request's document id. */
  id: string;
  /** The client's case this request is on. */
  applicationId: string;
  /** The requesting agent's PROFILE id (the app opens the agent and their chat with it). */
  agentId: string;
  /** The agency the request is billed under, when there is one. */
  agencyId?: string;
  /** The client's own uid, name and email, as stored on the request. */
  clientId: string;
  clientName: string;
  clientEmail: string;

  /**
   * Minor units of `currency`: US cents on a dollar request, kobo ("NGN") on
   * a legacy one. Always read together with `currency`.
   */
  amount: number;
  currency: string;
  /** What the payment is for. */
  description: string;
  category: PaymentRequestCategory;

  /** Where the request stands. */
  status: PaymentRequestStatus;

  /** True for a pre-#181 naira request (it shows its own amount and currency). */
  legacy: boolean;
  /** The dollar price; null on a legacy request. */
  priceUsd: Money | null;
  /** The local amount the client pays, once a checkout priced it; else null. */
  charge: Money | null;
  /** Ready-made text with currency codes: "USD 100.00 (NGN 150,000.00)". */
  amountDisplay: string;

  /**
   * The client's OWN Paystack checkout: its reference (the app verifies the
   * payment with it) and its page. The client already gets both from the
   * approve / checkout answers and from Paystack's return URL.
   */
  paystackReference?: string;
  checkoutUrl?: string | null;

  /** Lifecycle dates. */
  paidAt?: Timestamp;
  cancelledAt?: Timestamp;
  expiresAt?: Timestamp;
  approvedAt?: Timestamp;
  rejectedAt?: Timestamp;
  /** The reason the client gave when rejecting. */
  rejectionReason?: string;

  createdAt: Timestamp;
  updatedAt: Timestamp;
}

/**
 * Project a stored payment request onto the client allow-list.
 *
 * Every output field is named and copied one by one. Nothing is spread from
 * the stored document, so a field that is not written below (existing or
 * added later, top-level or inside `supersededCheckouts`) cannot reach a
 * client. Optional fields are only set when present, so absent stays absent
 * in JSON. No money is converted or recomputed, except the effective rate,
 * which is a plain division of two stored amounts (see `effectiveRateOf`).
 *
 * @param r - The full stored request (the caller's own)
 * @returns The payer-safe view of that request
 */
export function toClientPaymentRequest(r: PaymentRequest): ClientPaymentRequest {
  // The fields every request has, plus the display fields. The display
  // fields are named one by one here (not spread from
  // `requestChargeSummary`), so a key added to that summary later does not
  // reach clients by itself.
  const out: ClientPaymentRequest = {
    id: r.id,
    applicationId: r.applicationId,
    agentId: r.agentId,
    clientId: r.clientId,
    clientName: r.clientName,
    clientEmail: r.clientEmail,
    amount: r.amount,
    currency: r.currency,
    description: r.description,
    category: r.category,
    status: r.status,
    legacy: !isUsdPaymentRequest(r),
    priceUsd: requestPriceUsd(r),
    charge: expectedRequestCharge(r),
    amountDisplay: describeRequestAmount(r),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };

  // The agency, when the request is billed under one.
  if (r.agencyId !== undefined) out.agencyId = r.agencyId;

  // The charge: dollar price, amount charged, EFFECTIVE rate, quote lock.
  // The raw rate, its date and source, and the margin stay behind.
  Object.assign(out, clientChargeFields(r));

  // The client's own checkout.
  if (r.paystackReference !== undefined) out.paystackReference = r.paystackReference;
  if (r.checkoutUrl !== undefined) out.checkoutUrl = r.checkoutUrl;

  // Lifecycle dates and the client's own rejection reason.
  if (r.paidAt !== undefined) out.paidAt = r.paidAt;
  if (r.cancelledAt !== undefined) out.cancelledAt = r.cancelledAt;
  if (r.expiresAt !== undefined) out.expiresAt = r.expiresAt;
  if (r.approvedAt !== undefined) out.approvedAt = r.approvedAt;
  if (r.rejectedAt !== undefined) out.rejectedAt = r.rejectedAt;
  if (r.rejectionReason !== undefined) out.rejectionReason = r.rejectionReason;

  return out;
}

/** Who is asking: the uid and the role resolved for THIS request (`req.user.uid`, `req.authz.role`). */
export interface PaymentRequestViewer {
  uid?: string;
  role?: string;
}

/**
 * Whether `viewer` gets the FULL stored request (true) or the client view
 * (false). Fails closed: the full document is only for a caller who is
 * positively on the agent side.
 *
 *  - no resolved role, or the `client` role: client view, whatever request
 *    it is;
 *  - the request's own client (`clientId`): client view, even when their
 *    role is agent, owner or admin. On their own request they are the payer;
 *  - an agent, owner or admin looking at someone else's request: the full
 *    document, as before #332.
 *
 * This decides only the SHAPE of an answer. Whether the caller may read or
 * act on the request at all is decided before, by each route.
 *
 * @param viewer - The caller's uid and resolved role
 * @param request - The request being answered
 */
export function seesFullPaymentRequest(viewer: PaymentRequestViewer, request: Pick<PaymentRequest, "clientId">): boolean {
  // The payer of this request is always answered as a payer.
  if (!viewer.uid || request.clientId === viewer.uid) return false;
  return viewer.role === ROLES.ADMIN || viewer.role === ROLES.AGENT || viewer.role === ROLES.OWNER;
}
