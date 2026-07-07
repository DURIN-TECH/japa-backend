/**
 * Seed the subscription plans (one free default + one paid tier per audience).
 * Idempotent — upserts by plan id. Run after backfill-claims so subscribers can be
 * assigned plans and entitlements recomputed.
 *
 * Run:  npm run build && node lib/scripts/seed-plans.js
 */
import { FEATURE_KEYS, LIMIT_KEYS, UNLIMITED } from "@durin-tech/authz";
import { collections } from "../utils/firebase";
import { StoredPlan } from "../types/billing";

// Until subscription billing launches, the free default plan for every audience
// grants FULL access — all features open and no numeric caps. Derived from the
// authz catalog so it can never drift from the feature/limit vocabulary. When
// paid tiers go live, tighten these back to a curated free allowance.
const ALL_FEATURES = [...FEATURE_KEYS];
const UNLIMITED_LIMITS = Object.fromEntries(
  LIMIT_KEYS.map((key) => [key, UNLIMITED])
) as StoredPlan["limits"];

const PLANS: StoredPlan[] = [
  // ── Client (mobile) ──────────────────────────────────────────────────────
  {
    id: "client_free",
    name: "Client Free",
    audience: "client",
    priceKobo: 0,
    interval: "none",
    isDefault: true,
    // Free = full access until billing launches.
    features: ALL_FEATURES,
    limits: UNLIMITED_LIMITS,
  },
  {
    id: "client_pro",
    name: "Client Pro",
    audience: "client",
    priceKobo: 250000, // ₦2,500 / month
    interval: "month",
    billingGroup: "client_pro",
    features: [
      "applications.create",
      "documents.upload",
      "messaging",
      "consultations.book",
      "news.alerts",
      "priority_support",
    ],
    limits: {
      max_active_applications: -1,
      max_documents_per_application: -1,
      max_consultations_per_month: -1,
    },
  },
  // ── Independent agent ────────────────────────────────────────────────────
  {
    id: "agent_free",
    name: "Agent Free",
    audience: "agent",
    priceKobo: 0,
    interval: "none",
    isDefault: true,
    // Free = full access until billing launches.
    features: ALL_FEATURES,
    limits: UNLIMITED_LIMITS,
  },
  {
    id: "agent_pro",
    name: "Agent Pro",
    audience: "agent",
    priceKobo: 1000000, // ₦10,000 / month
    interval: "month",
    billingGroup: "agent_pro",
    features: [
      "applications.create",
      "applications.bulk",
      "documents.upload",
      "messaging",
      "consultations.book",
      "payments.request",
      "analytics.view",
      "priority_support",
    ],
    limits: { max_active_applications: -1, max_consultations_per_month: -1 },
  },
  // ── Agency ───────────────────────────────────────────────────────────────
  {
    id: "agency_free",
    name: "Agency Starter",
    audience: "agency",
    priceKobo: 0,
    interval: "none",
    isDefault: true,
    // Free = full access until billing launches.
    features: ALL_FEATURES,
    limits: UNLIMITED_LIMITS,
    seatPriceKobo: 500000, // ₦5,000 per agent seat
  },
  {
    id: "agency_standard",
    name: "Agency Standard",
    audience: "agency",
    priceKobo: 2500000, // ₦25,000 / month
    interval: "month",
    billingGroup: "agency_standard",
    features: [
      "applications.create",
      "documents.upload",
      "messaging",
      "consultations.book",
      "payments.request",
      "agency.invite_agents",
    ],
    limits: { max_active_applications: 100, max_agents: 5 },
    seatPriceKobo: 400000, // ₦4,000 per extra agent seat
  },
  {
    id: "agency_pro",
    name: "Agency Pro",
    audience: "agency",
    priceKobo: 5000000, // ₦50,000 / month
    interval: "month",
    billingGroup: "agency_pro",
    features: [
      "applications.create",
      "applications.bulk",
      "documents.upload",
      "messaging",
      "consultations.book",
      "payments.request",
      "analytics.view",
      "agency.invite_agents",
      "priority_support",
    ],
    limits: { max_active_applications: -1, max_agents: -1, max_consultations_per_month: -1 },
    seatPriceKobo: 300000, // ₦3,000 per extra agent seat
  },
  // ── Standard tiers (the middle of the 3 packages per audience) ────────────
  {
    id: "client_standard",
    name: "Client Standard",
    audience: "client",
    priceKobo: 100000, // ₦1,000 / month
    interval: "month",
    billingGroup: "client_standard",
    features: ["applications.create", "documents.upload", "messaging", "news.alerts"],
    limits: { max_active_applications: 3, max_documents_per_application: 25 },
  },
  {
    id: "agent_standard",
    name: "Agent Standard",
    audience: "agent",
    priceKobo: 500000, // ₦5,000 / month
    interval: "month",
    billingGroup: "agent_standard",
    features: [
      "applications.create",
      "documents.upload",
      "messaging",
      "consultations.book",
      "payments.request",
    ],
    limits: { max_active_applications: 25 },
  },
];

/**
 * Discount applied to yearly plans, expressed as the number of months charged for a
 * full year. 10% off 12 months → pay for 10.8 months. Yearly priceKobo is derived
 * from the monthly variant so the two can never drift.
 */
const YEARLY_MONTHS_CHARGED = 10.8; // 12 × (1 − 0.10)

/**
 * Derive a discounted yearly plan for every paid monthly plan that declares a
 * `billingGroup`. The yearly variant keeps the same audience/features/limits/seat
 * pricing and shares the `billingGroup` so the upgrade UI can pair them and show the
 * discount. Free/`interval: "none"` plans are skipped (nothing to bill yearly).
 */
function buildYearlyVariants(monthlyPlans: StoredPlan[]): StoredPlan[] {
  return monthlyPlans
    .filter((p) => p.interval === "month" && p.priceKobo > 0 && p.billingGroup)
    .map((p) => ({
      ...p,
      id: `${p.id}_yearly`,
      name: `${p.name} (Yearly)`,
      interval: "year" as const,
      // 10% cheaper than paying monthly for a year, rounded to whole kobo.
      priceKobo: Math.round(p.priceKobo * YEARLY_MONTHS_CHARGED),
      // A yearly variant is never the free default for its audience.
      isDefault: false,
    }));
}

/** Monthly (source) plans + their derived yearly variants — the full catalog to seed. */
const ALL_PLANS: StoredPlan[] = [...PLANS, ...buildYearlyVariants(PLANS)];

/**
 * Upsert all subscription plans. Exported so the consolidated `seed-all` can run it
 * in-process; also runnable standalone (see the guard below). Returns the count.
 */
export async function seedPlans(): Promise<number> {
  console.log(`Seeding ${ALL_PLANS.length} plans…`);
  for (const plan of ALL_PLANS) {
    await collections.plans.doc(plan.id).set(plan, { merge: true });
    console.log(`  ✓ ${plan.id} (${plan.audience}) — ${plan.features.length} features`);
  }
  console.log("Done seeding plans.");
  return ALL_PLANS.length;
}

// Allow `node lib/scripts/seed-plans.js` to still run it directly.
if (require.main === module) {
  seedPlans()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error("Seed plans failed:", error);
      process.exit(1);
    });
}
