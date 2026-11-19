import type { CurrencyCode } from "../../types/money";

// ============================================
// RATE PROVIDER INTERFACE (issue #178)
// ============================================
//
// A provider answers one question: "how many `currency` units per 1 USD, and
// as of when?". It either returns a rate or says "unavailable" with a reason;
// it never throws for an outage and never invents a number.

/** Provider ids. `manual` is not a provider: it is the admin override. */
export type ProviderId = "cbn" | "oanda";

/** A rate read from a provider. */
export interface ProviderRate {
  ok: true;
  /** Local units per 1 USD. */
  rate: number;
  /** When the provider published it. */
  asOf: Date;
}

/** The provider could not give a rate right now. */
export interface ProviderUnavailable {
  ok: false;
  reason: string;
}

export type ProviderResult = ProviderRate | ProviderUnavailable;

export interface RateProvider {
  readonly id: ProviderId;
  /** False when a required credential is absent: the provider is then never used. */
  isConfigured(): boolean;
  /** Whether this provider can price the currency at all. */
  supports(currency: CurrencyCode): boolean;
  fetchRate(currency: CurrencyCode): Promise<ProviderResult>;
}
