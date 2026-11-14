import axios from "axios";
import * as crypto from "crypto";
import {
  BillingProvider,
  CheckoutSession,
  CreateCheckoutInput,
  NormalizedSubscriptionEvent,
  SubscriberType,
} from "@durin-tech/authz";
import type { Money } from "../../types/money";

/**
 * Paystack implementation of the provider-agnostic `BillingProvider`. The rest of
 * the billing layer only ever sees normalized events, so swapping providers later
 * means writing a sibling class — nothing else changes.
 *
 * Secret key comes from `PAYSTACK_SECRET_KEY` (a Firebase secret/env var). The
 * optional `callbackUrl` is where Paystack redirects after checkout.
 */
const PAYSTACK_BASE = "https://api.paystack.co";

// ============================================
// Classified Paystack errors (issue #181 review round 2)
// ============================================

/**
 * What the Paystack client throws for every failed call. The message is the
 * same `PAYSTACK_ERROR: <message> (HTTP <status>)` as before, so every
 * existing `startsWith("PAYSTACK_ERROR")` check still maps it to 502; the
 * fields let a caller look at what Paystack actually answered.
 *
 *  - `httpStatus`: Paystack's HTTP status, undefined when no response came
 *    back at all (a network failure, a timeout, DNS);
 *  - `providerMessage`: the `message` of Paystack's JSON error body;
 *  - `providerCode`: the `code` of that body (e.g. `transaction_not_found`),
 *    when Paystack sends one.
 */
export class PaystackApiError extends Error {
  readonly httpStatus?: number;
  readonly providerMessage?: string;
  readonly providerCode?: string;

  constructor(
    message: string,
    details: { httpStatus?: number; providerMessage?: string; providerCode?: string } = {}
  ) {
    super(message);
    this.name = "PaystackApiError";
    this.httpStatus = details.httpStatus;
    this.providerMessage = details.providerMessage;
    this.providerCode = details.providerCode;
  }
}

/** Paystack's own messages for "there is no transaction with this reference". */
const REFERENCE_NOT_FOUND_MESSAGES = /^(transaction reference not found|transaction not found)\.?$/i;

/**
 * Whether an error is Paystack's precise answer "there is no transaction
 * with this reference" (transaction/verify on a reference it never saw).
 *
 * Paystack answers that with HTTP 400 (or 404) and the body
 * `{ status: false, message: "Transaction reference not found", code:
 * "transaction_not_found" }`. Only that exact answer counts: a network
 * failure (no HTTP status), a 5xx, a 401 "Invalid key" or any other 4xx
 * message is NOT "not found", and callers must keep failing closed on them.
 *
 * This says nothing about who made the reference: a caller only treats it as
 * "never opened" for a reference it generated itself (see
 * `lookupCheckoutState` in charge-checkout.service.ts).
 */
export function isPaystackReferenceNotFound(err: unknown): boolean {
  if (!(err instanceof PaystackApiError)) return false;
  if (err.httpStatus !== 400 && err.httpStatus !== 404) return false;
  if (err.providerCode === "transaction_not_found") return true;
  return !!err.providerMessage && REFERENCE_NOT_FOUND_MESSAGES.test(err.providerMessage.trim());
}

/**
 * `CreateCheckoutInput` (shared contract from @durin-tech/authz) plus an
 * optional per-request `callbackUrl` (issue #252). When set it overrides the
 * provider default `PAYSTACK_CALLBACK_URL`, e.g. so a mobile-initiated
 * checkout returns to the app return page instead of the portal. Kept local
 * (not in the shared package) because only the Paystack provider reads it.
 */
export type PaystackCheckoutInput = CreateCheckoutInput & { callbackUrl?: string };

interface PaystackInitData {
  authorization_url: string;
  access_code: string;
  reference: string;
}

export class PaystackProvider implements BillingProvider {
  readonly name = "paystack";

  private get secretKey(): string {
    const key = process.env.PAYSTACK_SECRET_KEY;
    if (!key) throw new Error("PAYSTACK_SECRET_KEY is not configured");
    return key;
  }

  private get callbackUrl(): string | undefined {
    return process.env.PAYSTACK_CALLBACK_URL;
  }

  /**
   * Axios client bound to Paystack with the secret key. A response interceptor
   * normalizes every non-2xx / network failure into a single classified error
   * (`PAYSTACK_ERROR: …`) that carries Paystack's own status + message. This means
   * a bad/misconfigured secret ("Invalid key"), a rejected charge, or a Paystack
   * outage surfaces as a recognizable provider error the controller can map to a
   * clean 502 — instead of a raw AxiosError bubbling up as a naked 500 whose cause
   * is invisible from the portal.
   */
  private client() {
    const instance = axios.create({
      baseURL: PAYSTACK_BASE,
      headers: { Authorization: `Bearer ${this.secretKey}` },
    });
    instance.interceptors.response.use(
      (res) => res,
      (err) => {
        // Prefer Paystack's structured error body; fall back to the axios message.
        const status = axios.isAxiosError(err) ? err.response?.status : undefined;
        const body = axios.isAxiosError(err)
          ? (err.response?.data as { message?: unknown; code?: unknown } | undefined)
          : undefined;
        const bodyMessage = typeof body?.message === "string" ? body.message : undefined;
        const providerMsg = bodyMessage || (err as Error)?.message || "unknown error";
        // Issue #181 review round 2: a classified error, not a bare Error, so
        // a caller can tell Paystack's precise "no such transaction" answer
        // apart from an outage (see `isPaystackReferenceNotFound`). The
        // message keeps the `PAYSTACK_ERROR: ...` shape every controller
        // already maps to 502.
        throw new PaystackApiError(
          `PAYSTACK_ERROR: ${providerMsg}${status ? ` (HTTP ${status})` : ""}`,
          {
            httpStatus: status,
            providerMessage: bodyMessage,
            providerCode: typeof body?.code === "string" ? body.code : undefined,
          }
        );
      }
    );
    return instance;
  }

  /**
   * Initialize a Paystack transaction. If the plan maps to a Paystack plan code
   * (passed via metadata.paystackPlanCode), Paystack auto-creates a recurring
   * subscription; otherwise it's a one-off charge for the plan amount.
   *
   * Issue #252: `input.callbackUrl`, when given, is where Paystack sends the
   * payer afterwards (same override `initializeCharge` already had); without
   * it the provider default `PAYSTACK_CALLBACK_URL` applies, unchanged.
   */
  async createCheckout(input: PaystackCheckoutInput): Promise<CheckoutSession> {
    const planCode = input.metadata?.paystackPlanCode;
    // Per-request override first, then the deploy-time default (may be unset).
    const callback = input.callbackUrl ?? this.callbackUrl;
    const payload: Record<string, unknown> = {
      email: input.email,
      amount: input.amountKobo,
      currency: "NGN",
      metadata: {
        subscriberType: input.subscriberType,
        subscriberId: input.subscriberId,
        planId: input.planId,
        ...input.metadata,
      },
      ...(planCode ? { plan: planCode } : {}),
      ...(callback ? { callback_url: callback } : {}),
    };

    const res = await this.client().post<{ data: PaystackInitData }>(
      "/transaction/initialize",
      payload
    );
    const data = res.data.data;
    return { url: data.authorization_url, reference: data.reference, provider: this.name };
  }

  /**
   * Initialize a ONE-OFF Paystack transaction that is NOT a subscription.
   *
   * Unlike `createCheckout`, the metadata here is caller-defined (e.g. a guest
   * consultation booking carries `{ purpose:"consultation", consultationId }`),
   * so it deliberately does NOT flow through the subscription-shaped
   * `subscriberType/subscriberId/planId` contract — those transactions are
   * confirmed via `getTransactionMetadata` (reference lookup), not the
   * subscription webhook. `callbackUrl` overrides the provider default so the
   * payer can be returned to a purpose-specific confirmation page.
   *
   * Issue #180: the charge is a `Money` (integer minor units + an EXPLICIT
   * currency), passed to Paystack as-is: `amount = amountMinor`, `currency =
   * currency`. Nothing here converts or assumes naira; callers pass the
   * `chargedAmountMinor` / `chargedCurrency` they stored on the booking.
   */
  async initializeCharge(input: {
    email: string;
    /** The exact amount to charge, in minor units of its own currency. */
    amount: Money;
    metadata?: Record<string, unknown>;
    callbackUrl?: string;
    /**
     * Issue #180 review fix: OUR reference for this checkout. Paystack
     * accepts a caller-supplied `reference` on transaction/initialize, so the
     * consultation charge path generates it, stores it on the booking inside
     * the Firestore transaction that decides the checkout, and only then
     * opens it here. Omitted: Paystack generates one (other callers).
     */
    reference?: string;
  }): Promise<{ authorizationUrl: string; reference: string }> {
    // Never hand Paystack a malformed or zero amount: a charge path that got
    // here with one is a bug upstream, and failing loudly beats charging 0.
    if (!Number.isSafeInteger(input.amount.amountMinor) || input.amount.amountMinor <= 0) {
      throw new Error("PAYSTACK_ERROR: refusing to initialize a charge with a non-positive amount");
    }
    const callback = input.callbackUrl ?? this.callbackUrl;
    const payload: Record<string, unknown> = {
      email: input.email,
      amount: input.amount.amountMinor,
      currency: input.amount.currency,
      metadata: input.metadata ?? {},
      ...(callback ? { callback_url: callback } : {}),
      ...(input.reference ? { reference: input.reference } : {}),
    };

    const res = await this.client().post<{ data: PaystackInitData }>(
      "/transaction/initialize",
      payload
    );
    const data = res.data.data;
    return { authorizationUrl: data.authorization_url, reference: data.reference };
  }

  /**
   * Ensure a Paystack Plan exists for a recurring package and return its `plan_code`.
   * Paystack only auto-recurs against a Plan object, so each paid package needs one.
   * Our `interval` ("month"/"year") maps to Paystack's cadence vocabulary
   * ("monthly"/"annually"). The returned code is stored on the plan doc
   * (`paystackPlanCode`) and later passed to `createCheckout`, which turns the
   * transaction into a subscription.
   *
   * Note: this always creates a NEW plan. Idempotency is handled by the caller
   * (the sync script skips packages that already carry a `paystackPlanCode`).
   */
  async ensurePlan(input: {
    name: string;
    amountKobo: number;
    interval: "month" | "year";
  }): Promise<string> {
    const paystackInterval = input.interval === "year" ? "annually" : "monthly";
    const res = await this.client().post<{ data: { plan_code: string } }>("/plan", {
      name: input.name,
      amount: input.amountKobo,
      interval: paystackInterval,
      currency: "NGN",
    });
    return res.data.data.plan_code;
  }

  /**
   * Charge a customer's saved card (authorization) server-side, with no redirect.
   * Used for the prorated one-off seat charge: the owner already paid once (so we
   * hold an `authorization_code`), and the seat cost is small and known, so there's
   * no need to bounce them through hosted checkout again. Returns the transaction
   * status + reference (status "success" means the card was charged).
   */
  async chargeAuthorization(input: {
    authorizationCode: string;
    email: string;
    amountKobo: number;
    metadata?: Record<string, string>;
  }): Promise<{ status: string; reference: string }> {
    const res = await this.client().post<{ data: { status: string; reference: string } }>(
      "/transaction/charge_authorization",
      {
        authorization_code: input.authorizationCode,
        email: input.email,
        amount: input.amountKobo,
        currency: "NGN",
        metadata: input.metadata,
      }
    );
    return { status: res.data.data.status, reference: res.data.data.reference };
  }

  /**
   * Create a subscription directly against a customer + plan using their saved
   * authorization, optionally starting on a future date. This is how we step the
   * recurring amount up/down at the *next* renewal: after charging just the seat
   * now, we point a new subscription (at the new total's plan) to begin at the
   * current period end. Returns a combined "code:token" providerRef (both are
   * needed to later disable it — see `cancelSubscription`).
   */
  async createSubscription(input: {
    customerCode: string;
    planCode: string;
    authorizationCode: string;
    /** ISO datetime for the first charge (Paystack accepts a future `start_date`). */
    startDate?: string | null;
  }): Promise<string> {
    const res = await this.client().post<{
      data: { subscription_code: string; email_token: string };
    }>("/subscription", {
      customer: input.customerCode,
      plan: input.planCode,
      authorization: input.authorizationCode,
      ...(input.startDate ? { start_date: input.startDate } : {}),
    });
    const { subscription_code, email_token } = res.data.data;
    return `${subscription_code}:${email_token}`;
  }

  /** Verify a transaction by reference (post-redirect confirmation). */
  async verifyTransaction(reference: string): Promise<NormalizedSubscriptionEvent | null> {
    const res = await this.client().get<{ data: PaystackVerifyData }>(
      `/transaction/verify/${encodeURIComponent(reference)}`
    );
    const data = res.data.data;
    if (!data || data.status !== "success") return null;
    return this.toEvent("activated", data.metadata, data.reference, data);
  }

  /**
   * Fetch a verified transaction's status + metadata (used to confirm one-off seat
   * purchases, payment requests and consultation fees server-side, which aren't
   * subscription events).
   *
   * Issue #180: also returns what Paystack says was actually charged — `amount`
   * (minor units) and `currency` — and when (`paidAt`, ISO, when Paystack
   * reports it), so a caller can compare the charge with what it stored and
   * refuse an underpayment or a wrong currency. Each is undefined when the
   * payload does not carry a well-formed value; callers treat undefined as a
   * mismatch, never as a match.
   */
  async getTransactionMetadata(reference: string): Promise<PaystackTransactionLookup | null> {
    const res = await this.client().get<{
      data: {
        status: string;
        metadata?: Record<string, unknown>;
        amount?: unknown;
        requested_amount?: unknown;
        currency?: unknown;
        paid_at?: unknown;
        paidAt?: unknown;
      };
    }>(`/transaction/verify/${encodeURIComponent(reference)}`);
    const data = res.data.data;
    if (!data) return null;
    return toTransactionLookup(data);
  }

  async cancelSubscription(providerRef: string): Promise<void> {
    // providerRef is "subscriptionCode:emailToken" — Paystack requires both to disable.
    const [code, token] = providerRef.split(":");
    if (!code || !token) return;
    await this.client().post("/subscription/disable", { code, token });
  }

  /**
   * Verify the `x-paystack-signature` HMAC-SHA512 of the RAW body with the secret
   * key, then map the event to our domain shape. Returns null for irrelevant or
   * unverified events (never trust an unsigned payload).
   */
  /**
   * Verify a Paystack webhook's HMAC signature.
   *
   * Public because `parseWebhook` below only understands SUBSCRIPTION events —
   * it returns null both for a forged payload and for a perfectly valid charge
   * that simply isn't a subscription, which are not the same thing. Handlers for
   * other charge purposes (payment requests) need to establish authenticity on
   * their own before trusting the body, and must not re-implement this.
   */
  verifyWebhookSignature(
    headers: Record<string, string | undefined>,
    rawBody: string
  ): boolean {
    const signature = headers["x-paystack-signature"];
    if (!signature) return false;
    const expected = crypto
      .createHmac("sha512", this.secretKey)
      .update(rawBody)
      .digest("hex");
    // Issue #181 review fix: compare in constant time. A plain `!==` stops at
    // the first differing character, so its timing leaks how much of a forged
    // signature is right. `timingSafeEqual` needs two buffers of the SAME
    // length (it throws otherwise), so a signature of the wrong length is
    // refused before the compare; its length is not a secret (always 128 hex
    // characters for SHA-512). Both sides are compared as raw bytes of the
    // hex text, so a non-hex or mixed-case header simply does not match.
    const given = Buffer.from(String(signature), "utf8");
    const wanted = Buffer.from(expected, "utf8");
    if (given.length !== wanted.length || !crypto.timingSafeEqual(given, wanted)) {
      console.warn("Paystack webhook signature mismatch");
      return false;
    }
    return true;
  }

  parseWebhook(
    headers: Record<string, string | undefined>,
    rawBody: string
  ): NormalizedSubscriptionEvent | null {
    if (!this.verifyWebhookSignature(headers, rawBody)) return null;

    let body: PaystackWebhookBody;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return null;
    }

    const data = body.data;
    const meta = data?.metadata;
    const ref = data?.reference ?? data?.subscription_code ?? null;
    // Paystack's next auto-charge date — our subscription's currentPeriodEnd (the
    // renewal date shown in the plan summary). Present on subscription/invoice events.
    const periodEnd = data?.next_payment_date ?? null;

    switch (body.event) {
    case "subscription.create":
      // First successful subscription charge — activate with the real renewal date.
      return this.toEvent("activated", meta, ref, data, periodEnd);
    case "charge.success":
      // A successful charge (may be the first one). No renewal date on this event;
      // billing.service estimates one from the plan interval if still missing.
      return this.toEvent("activated", meta, ref, data, periodEnd);
    case "invoice.create":
    case "invoice.update":
      // Recurring invoice outcome: a paid invoice is a renewal (carries the next
      // renewal date); an unpaid one means the charge failed → past due.
      return this.toEvent(
        data?.paid || data?.status === "success" ? "renewed" : "past_due",
        meta,
        ref,
        data,
        periodEnd
      );
    case "invoice.payment_failed":
      return this.toEvent("past_due", meta, ref, data, periodEnd);
    case "subscription.disable":
    case "subscription.not_renew":
      return this.toEvent("canceled", meta, ref, data, periodEnd);
    default:
      return null;
    }
  }

  private toEvent(
    type: NormalizedSubscriptionEvent["type"],
    meta: PaystackMetadata | undefined,
    providerRef: string | null,
    raw: unknown,
    currentPeriodEnd: string | null = null
  ): NormalizedSubscriptionEvent | null {
    if (!meta?.subscriberType || !meta?.subscriberId || !meta?.planId) return null;
    const status =
      type === "canceled" ? "canceled" : type === "past_due" ? "past_due" : "active";
    return {
      type,
      subscriberType: meta.subscriberType as SubscriberType,
      subscriberId: meta.subscriberId,
      planId: meta.planId,
      status,
      currentPeriodEnd,
      provider: this.name,
      providerRef,
      raw,
    };
  }
}

/**
 * What `getTransactionMetadata` returns for one reference (issue #180 added
 * the charged amount, currency and payment time).
 */
export interface PaystackTransactionLookup {
  /** Paystack's transaction status ("success", "abandoned", "failed", ...). */
  status: string;
  /** Our own metadata, echoed back by Paystack. */
  metadata: Record<string, unknown>;
  /**
   * The amount Paystack charged, in minor units of `currency`. Includes
   * Paystack's fees when the account passes them to the customer.
   */
  amount?: number;
  /**
   * Issue #180 review: the amount the checkout ASKED for (Paystack's
   * `requested_amount`), before any fee passed to the customer. Compared in
   * preference to `amount` when present.
   */
  requestedAmount?: number;
  /** The currency Paystack charged in, upper case. */
  currency?: string;
  /** When the payment completed (ISO 8601), when Paystack reports it. */
  paidAt?: string;
}

/**
 * Turn a Paystack transaction payload (the `data` of transaction/verify, or
 * of a signature-verified `charge.success` webhook) into the lookup shape
 * the charge paths compare against. Issue #181: shared by verify and the
 * payment-request webhook, so both read amount, currency and payment time the
 * same way. Each field is undefined when the payload does not carry a
 * well-formed value; callers treat undefined as a mismatch, never as a match.
 */
export function toTransactionLookup(data: {
  status?: unknown;
  metadata?: unknown;
  amount?: unknown;
  requested_amount?: unknown;
  currency?: unknown;
  paid_at?: unknown;
  paidAt?: unknown;
}): PaystackTransactionLookup {
  const paidAtRaw = data.paid_at ?? data.paidAt;
  const metadata = data.metadata && typeof data.metadata === "object" ? (data.metadata as Record<string, unknown>) : {};
  return {
    status: typeof data.status === "string" ? data.status : "",
    metadata,
    amount: typeof data.amount === "number" && Number.isSafeInteger(data.amount) ? data.amount : undefined,
    // What WE asked for. When the account passes Paystack's fees to the
    // customer, `amount` includes those fees and `requested_amount` holds
    // the original; the charge checks compare this one when present (issue
    // #180 review). Only set when well-formed, so callers fall back to
    // `amount` otherwise.
    ...(typeof data.requested_amount === "number" && Number.isSafeInteger(data.requested_amount)
      ? { requestedAmount: data.requested_amount }
      : {}),
    currency: typeof data.currency === "string" ? data.currency.toUpperCase() : undefined,
    paidAt: typeof paidAtRaw === "string" && paidAtRaw ? paidAtRaw : undefined,
  };
}

interface PaystackMetadata {
  subscriberType?: string;
  subscriberId?: string;
  planId?: string;
}

/**
 * The subset of a Paystack charge/verify payload we read off `event.raw` in
 * billing.service — the saved-card authorization + customer identifiers needed to
 * charge again server-side and to (re)create subscriptions.
 */
export interface PaystackChargeRaw {
  authorization?: { authorization_code?: string };
  customer?: { customer_code?: string };
}

interface PaystackVerifyData extends PaystackChargeRaw {
  status: string;
  reference: string;
  metadata?: PaystackMetadata;
}
interface PaystackWebhookBody {
  event: string;
  data?: PaystackChargeRaw & {
    reference?: string;
    subscription_code?: string;
    metadata?: PaystackMetadata;
    /** ISO date of the next auto-charge — maps to our `currentPeriodEnd`. */
    next_payment_date?: string;
    /** Invoice charge outcome flags (recurring renewals). */
    paid?: boolean;
    status?: string;
  };
}

export const paystackProvider = new PaystackProvider();
