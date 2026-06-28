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
  /** Cost per agent seat (agency plans) — the owner pays this per agent added. */
  seatPriceKobo?: number;
  /** Hidden from upgrade screens / un-purchasable when false (defaults to true). */
  isActive?: boolean;
  /** Display ordering within an audience. */
  sortOrder?: number;
  createdAt?: string;
  updatedAt?: string;
}
