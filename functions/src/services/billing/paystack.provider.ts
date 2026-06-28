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

  private client() {
    return axios.create({
      baseURL: PAYSTACK_BASE,
      headers: { Authorization: `Bearer ${this.secretKey}` },
    });
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

    const meta = body.data?.metadata;
    const ref = body.data?.reference ?? body.data?.subscription_code ?? null;
    switch (body.event) {
    case "charge.success":
    case "subscription.create":
      return this.toEvent("activated", meta, ref, body.data);
    case "invoice.update":
    case "invoice.payment_failed":
      return this.toEvent("past_due", meta, ref, body.data);
    case "subscription.disable":
    case "subscription.not_renew":
      return this.toEvent("canceled", meta, ref, body.data);
    default:
      return null;
    }
  }

  private toEvent(
    type: NormalizedSubscriptionEvent["type"],
    meta: PaystackMetadata | undefined,
    providerRef: string | null,
    raw: unknown
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
interface PaystackVerifyData {
  status: string;
  reference: string;
  metadata?: PaystackMetadata;
}
interface PaystackWebhookBody {
  event: string;
  data?: {
    reference?: string;
    subscription_code?: string;
    metadata?: PaystackMetadata;
  };
}

export const paystackProvider = new PaystackProvider();
