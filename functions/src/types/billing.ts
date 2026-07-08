import { Plan } from "@durin-tech/authz";

/**
 * The plan shape as stored in Firestore + managed by the admin UI. Extends the
 * shared `Plan` contract with billing/admin-only fields the package doesn't need
 * (the entitlement layer reads docs as `Plan` and ignores these extras).
 */
export interface StoredPlan extends Plan {
  /** Marketing copy for the upgrade screens. */
  description?: string;
  /** Maps this package to a Paystack plan code (enables recurring subscriptions). */
  paystackPlanCode?: string | null;
  /**
   * Cache of ad-hoc Paystack plan codes keyed by total amount (kobo), used for
   * seat-inclusive recurring totals (base + extra seats). Lets us reuse a Plan for a
   * given total instead of minting a new one on every seat change.
   * e.g. { "2900000": "PLN_..." } for a ₦29,000 recurring total.
   */
  seatPlanCodes?: Record<string, string>;
  /**
   * Groups a tier's monthly + yearly variants so the upgrade UI can pair them
   * (e.g. show a "Save X%" badge and a Monthly/Yearly toggle). Both the `agent_pro`
   * (monthly) and `agent_pro_yearly` (yearly) plans share `billingGroup: "agent_pro"`.
   * Purely a display/pairing hint — the entitlement layer ignores it.
   */
  billingGroup?: string;
  /** Cost per agent seat (agency plans) — the owner pays this per agent added. */
  seatPriceKobo?: number;
  /** Hidden from upgrade screens / un-purchasable when false (defaults to true). */
  isActive?: boolean;
  /** Display ordering within an audience. */
  sortOrder?: number;
  createdAt?: string;
  updatedAt?: string;
}
