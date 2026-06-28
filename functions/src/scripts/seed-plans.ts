/**
 * Seed the subscription plans (one free default + one paid tier per audience).
 * Idempotent — upserts by plan id. Run after backfill-claims so subscribers can be
 * assigned plans and entitlements recomputed.
 *
 * Run:  npm run build && node lib/scripts/seed-plans.js
 */
import { collections } from "../utils/firebase";
import { StoredPlan } from "../types/billing";

const PLANS: StoredPlan[] = [
  // ── Client (mobile) ──────────────────────────────────────────────────────
  {
    id: "client_free",
    name: "Client Free",
    audience: "client",
    priceKobo: 0,
    interval: "none",
    isDefault: true,
    features: ["applications.create", "documents.upload", "news.alerts"],
    limits: { max_active_applications: 1, max_documents_per_application: 10 },
  },
  {
    id: "client_pro",
    name: "Client Pro",
    audience: "client",
    priceKobo: 250000, // ₦2,500 / month
    interval: "month",
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
    features: ["applications.create", "documents.upload", "messaging"],
    limits: { max_active_applications: 5 },
  },
  {
    id: "agent_pro",
    name: "Agent Pro",
    audience: "agent",
    priceKobo: 1000000, // ₦10,000 / month
    interval: "month",
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
    features: [
      "applications.create",
      "documents.upload",
      "messaging",
      "consultations.book",
      "agency.invite_agents",
    ],
    limits: { max_active_applications: 25, max_agents: 1 },
    seatPriceKobo: 500000, // ₦5,000 per agent seat
  },
  {
    id: "agency_standard",
    name: "Agency Standard",
    audience: "agency",
    priceKobo: 2500000, // ₦25,000 / month
    interval: "month",
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
    features: ["applications.create", "documents.upload", "messaging", "news.alerts"],
    limits: { max_active_applications: 3, max_documents_per_application: 25 },
  },
  {
    id: "agent_standard",
    name: "Agent Standard",
    audience: "agent",
    priceKobo: 500000, // ₦5,000 / month
    interval: "month",
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
 * Upsert all subscription plans. Exported so the consolidated `seed-all` can run it
 * in-process; also runnable standalone (see the guard below). Returns the count.
 */
export async function seedPlans(): Promise<number> {
  console.log(`Seeding ${PLANS.length} plans…`);
  for (const plan of PLANS) {
    await collections.plans.doc(plan.id).set(plan, { merge: true });
    console.log(`  ✓ ${plan.id} (${plan.audience}) — ${plan.features.length} features`);
  }
  console.log("Done seeding plans.");
  return PLANS.length;
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
