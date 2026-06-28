/**
 * Provider-agnostic billing interface. The entitlement layer never talks to a
 * payment provider directly — it consumes the normalized events emitted here, so
 * swapping Paystack for Stripe/Flutterwave later means writing one new class that
 * implements `BillingProvider`. (Concrete providers land in the billing phase.)
 */
import { SubscriberType, SubscriptionStatus } from "./types";
/** A provider event normalized into our domain shape. */
export interface NormalizedSubscriptionEvent {
    type: "activated" | "renewed" | "canceled" | "past_due" | "updated";
    subscriberType: SubscriberType;
    subscriberId: string;
    planId: string;
    status: SubscriptionStatus;
    currentPeriodEnd?: string | null;
    provider: string;
    providerRef?: string | null;
    /** Original provider payload, for auditing. */
    raw?: unknown;
}
export interface CreateCheckoutInput {
    subscriberType: SubscriberType;
    subscriberId: string;
    planId: string;
    /** Billing email for the checkout. */
    email: string;
    amountKobo: number;
    /** Extra key/values round-tripped through the provider (e.g. for the webhook). */
    metadata?: Record<string, string>;
}
export interface CheckoutSession {
    /** Hosted checkout URL to redirect/launch. */
    url: string;
    /** Provider reference to later verify the transaction. */
    reference: string;
    provider: string;
}
/** The contract every payment provider implementation must satisfy. */
export interface BillingProvider {
    readonly name: string;
    /** Begin a subscription purchase; returns a hosted checkout to send the user to. */
    createCheckout(input: CreateCheckoutInput): Promise<CheckoutSession>;
    /** Verify a transaction by reference (post-redirect confirmation). */
    verifyTransaction(reference: string): Promise<NormalizedSubscriptionEvent | null>;
    /** Cancel an active subscription at the provider. */
    cancelSubscription(providerRef: string): Promise<void>;
    /**
     * Validate + parse a provider webhook into a normalized event (or null if the
     * event is irrelevant / signature invalid).
     */
    parseWebhook(headers: Record<string, string | undefined>, rawBody: string): NormalizedSubscriptionEvent | null;
}
