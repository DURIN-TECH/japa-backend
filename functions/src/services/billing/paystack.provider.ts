import axios from "axios";
import * as crypto from "crypto";
import {
  BillingProvider,
  CheckoutSession,
  CreateCheckoutInput,
  NormalizedSubscriptionEvent,
  SubscriberType,
} from "@durin-tech/authz";

/**
 * Paystack implementation of the provider-agnostic `BillingProvider`. The rest of
 * the billing layer only ever sees normalized events, so swapping providers later
 * means writing a sibling class — nothing else changes.
 *
 * Secret key comes from `PAYSTACK_SECRET_KEY` (a Firebase secret/env var). The
 * optional `callbackUrl` is where Paystack redirects after checkout.
 */
const PAYSTACK_BASE = "https://api.paystack.co";

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
        const providerMsg =
          (axios.isAxiosError(err) &&
            (err.response?.data as { message?: string } | undefined)?.message) ||
          (err as Error)?.message ||
          "unknown error";
        throw new Error(
          `PAYSTACK_ERROR: ${providerMsg}${status ? ` (HTTP ${status})` : ""}`
        );
      }
    );
    return instance;
  }

  /**
   * Initialize a Paystack transaction. If the plan maps to a Paystack plan code
   * (passed via metadata.paystackPlanCode), Paystack auto-creates a recurring
   * subscription; otherwise it's a one-off charge for the plan amount.
   */
  async createCheckout(input: CreateCheckoutInput): Promise<CheckoutSession> {
    const planCode = input.metadata?.paystackPlanCode;
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
      ...(this.callbackUrl ? { callback_url: this.callbackUrl } : {}),
    };

    const res = await this.client().post<{ data: PaystackInitData }>(
      "/transaction/initialize",
      payload
    );
    const data = res.data.data;
    return { url: data.authorization_url, reference: data.reference, provider: this.name };
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
   * purchases server-side, which aren't subscription events).
   */
  async getTransactionMetadata(
    reference: string
  ): Promise<{ status: string; metadata: Record<string, unknown> } | null> {
    const res = await this.client().get<{ data: { status: string; metadata?: Record<string, unknown> } }>(
      `/transaction/verify/${encodeURIComponent(reference)}`
    );
    const data = res.data.data;
    if (!data) return null;
    return { status: data.status, metadata: data.metadata ?? {} };
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
  parseWebhook(
    headers: Record<string, string | undefined>,
    rawBody: string
  ): NormalizedSubscriptionEvent | null {
    const signature = headers["x-paystack-signature"];
    if (!signature) return null;
    const expected = crypto
      .createHmac("sha512", this.secretKey)
      .update(rawBody)
      .digest("hex");
    if (signature !== expected) {
      console.warn("Paystack webhook signature mismatch");
      return null;
    }

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
