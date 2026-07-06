/**
 * Seed default subscriptions + entitlements for all seeded entities.
 *
 * After `seedPortalData` creates the agency, agents, and clients, and
 * `seedPlans` creates the plan catalog, this script assigns each entity
 * the appropriate default (free) plan so the entitlement layer is
 * populated and feature/limit gating works correctly from the first run.
 *
 * Idempotent — uses `set({ merge: true })` so re-running is safe.
 *
 * Entities covered:
 *   - Agency (seed-agency-001)      → agency_free
 *   - Owner  (seed-user-owner-001)  → resolves via agency subscription
 *   - Agent1 (seed-user-agent-001)  → resolves via agency subscription
 *   - Agent2 (seed-user-agent-002)  → resolves via agency subscription
 *   - Clients 1-10                  → client_free
 *
 * Run:  npm run build && node lib/scripts/seed-subscriptions.js
 */
import { collections } from "../utils/firebase";
import { Timestamp } from "firebase-admin/firestore";
import { Subscription, entitlementsFromPlan, Plan, SubscriberType } from "@durin-tech/authz";

// Mirror the deterministic IDs from seed-portal-data so we target the right docs.
const SEED_IDS = {
  agency:   "seed-agency-001",
  agent1:   "seed-user-agent-001",
  agent2:   "seed-user-agent-002",
  clients: [
    "seed-user-client-001",
    "seed-user-client-002",
    "seed-user-client-003",
    "seed-user-client-004",
    "seed-user-client-005",
    "seed-user-client-006",
    "seed-user-client-007",
    "seed-user-client-008",
    "seed-user-client-009",
    "seed-user-client-010",
  ],
};

/**
 * Look up the default plan for an audience from the plans collection.
 * Throws if none is found (plans must be seeded first via seedPlans).
 */
async function getDefaultPlan(audience: SubscriberType): Promise<Plan> {
  const snap = await collections.plans
    .where("audience", "==", audience)
    .where("isDefault", "==", true)
    .limit(1)
    .get();

  if (snap.empty) {
    throw new Error(
      `No default plan found for audience "${audience}". ` +
      "Run seedPlans first (step 4 in seed-all)."
    );
  }
  return snap.docs[0].data() as Plan;
}

/**
 * Upsert a subscription + recompute the entitlements cache for one subscriber.
 */
async function upsertSubscription(
  subscriberType: SubscriberType,
  subscriberId: string,
  plan: Plan
): Promise<void> {
  const now = Timestamp.now();

  const subscription: Subscription = {
    id: subscriberId,
    subscriberType,
    subscriberId,
    planId: plan.id,
    status: "active",
    currentPeriodEnd: null,
    provider: "manual",
    providerRef: null,
    updatedAt: now.toDate().toISOString(),
  };

  await collections.subscriptions
    .doc(subscriberId)
    .set(subscription, { merge: true });

  const entitlements = entitlementsFromPlan(plan, subscriberType, subscriberId, "active");
  await collections.entitlements.doc(subscriberId).set(
    { ...entitlements, updatedAt: now },
    { merge: true }
  );
}

/**
 * Seed subscriptions and entitlements for every seeded entity.
 * Exported for use by `seed-all`; also runnable standalone.
 */
export async function seedSubscriptions(): Promise<{
  agency: number;
  agents: number;
  clients: number;
}> {
  console.log("Seeding subscriptions & entitlements for seeded entities…");

  // 1. Fetch the relevant default plans once.
  const [agencyPlan, clientPlan] = await Promise.all([
    getDefaultPlan("agency"),
    getDefaultPlan("client"),
  ]);

  // 2. Agency subscription (owner + agents all inherit this).
  await upsertSubscription("agency", SEED_IDS.agency, agencyPlan);
  console.log(`  ✓ agency   ${SEED_IDS.agency} → ${agencyPlan.id}`);

  // 3. Clients — each gets their own client subscription.
  let clientCount = 0;
  for (const clientId of SEED_IDS.clients) {
    await upsertSubscription("client", clientId, clientPlan);
    console.log(`  ✓ client   ${clientId} → ${clientPlan.id}`);
    clientCount++;
  }

  console.log("Done seeding subscriptions.");
  return { agency: 1, agents: 0, clients: clientCount };
}

// Allow `node lib/scripts/seed-subscriptions.js` to run directly.
if (require.main === module) {
  // Need to initialize Firebase first.
  import("../utils/firebase")
    .then(() => seedSubscriptions())
    .then((counts) => {
      console.log("Counts:", counts);
      process.exit(0);
    })
    .catch((error) => {
      console.error("Seed subscriptions failed:", error);
      process.exit(1);
    });
}
