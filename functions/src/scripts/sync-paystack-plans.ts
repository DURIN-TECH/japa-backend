/**
 * Sync the subscription catalog to Paystack Plans.
 *
 * Paystack only auto-recurs against a Plan object (`plan_code`). This script walks
 * every paid package (`priceKobo > 0`, `interval` month/year) that doesn't yet carry
 * a `paystackPlanCode`, creates the matching Paystack Plan, and writes the returned
 * code back onto the Firestore plan doc. Once a plan has a code, `billingService`
 * passes it to `createCheckout`, turning the transaction into a real subscription.
 *
 * Idempotent: packages that already have a `paystackPlanCode` are skipped, so re-runs
 * are safe and only fill in the gaps. To rotate a code, clear the field first (or use
 * the admin Plans UI to paste a new one).
 *
 * Usage:
 *   PAYSTACK_SECRET_KEY=sk_test_… npm run paystack:sync:dev
 *   node lib/scripts/sync-paystack-plans.js --project durin-seli-dev
 *
 * Project selection + auth follow the same rules as seed-all (see that file's header):
 *   --project <id> > SEED_PROJECT > GCLOUD_PROJECT/GOOGLE_CLOUD_PROJECT.
 * Real projects need a service-account key via GOOGLE_APPLICATION_CREDENTIALS, and the
 * Paystack secret must be exported as PAYSTACK_SECRET_KEY (it is otherwise only bound
 * to the deployed function, not to a local shell).
 */
import type { StoredPlan } from "../types/billing";

// Projects treated as production (guarded against accidental writes).
const PROD_PROJECT_IDS = ["japa-platform"];

// Minimal CLI flag parsing: --project <id> | --project=<id> | -p <id>, plus
// --confirm-prod / --yes to authorize a production target.
function parseArgs(argv: string[]): { project?: string; confirmProd: boolean } {
  let project: string | undefined;
  let confirmProd = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--project" || a === "-p") project = argv[++i];
    else if (a.startsWith("--project=")) project = a.slice("--project=".length);
    else if (a === "--confirm-prod" || a === "--yes") confirmProd = true;
  }
  return { project, confirmProd };
}

const args = parseArgs(process.argv.slice(2));
const onEmulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

// Resolve the target project — no silent prod fallback (matches seed-all).
const projectId =
  args.project ||
  process.env.SEED_PROJECT ||
  process.env.GCLOUD_PROJECT ||
  process.env.GOOGLE_CLOUD_PROJECT ||
  (onEmulator ? "demo-seli" : undefined);

if (!projectId) {
  console.error(
    "\n❌ No target project specified.\n" +
    "   Pass --project <id>, set SEED_PROJECT/GCLOUD_PROJECT, or run against emulators.\n" +
    "   e.g. npm run paystack:sync:dev\n"
  );
  process.exit(1);
}

// Guard: refuse to touch a production project unless explicitly confirmed.
const confirmProd = args.confirmProd || process.env.ALLOW_PROD_SEED === "true";
if (!onEmulator && PROD_PROJECT_IDS.includes(projectId) && !confirmProd) {
  console.error(
    `\n❌ Refusing to sync PRODUCTION project "${projectId}" — re-run with --confirm-prod.\n`
  );
  process.exit(1);
}

// Point the shared Admin SDK at THIS project. utils/firebase (lazy-loaded in main(),
// NOT at the top of this file) reads these envs and OWNS initializeApp().
process.env.GCLOUD_PROJECT = projectId;
process.env.GOOGLE_CLOUD_PROJECT = projectId;
if (!onEmulator && !process.env.FIREBASE_STORAGE_BUCKET) {
  process.env.FIREBASE_STORAGE_BUCKET = `${projectId}.firebasestorage.app`;
}

async function main() {
  if (!process.env.PAYSTACK_SECRET_KEY) {
    console.error(
      "\n❌ PAYSTACK_SECRET_KEY is not set. Export it before running (it's otherwise\n" +
      "   only bound to the deployed function): PAYSTACK_SECRET_KEY=sk_… npm run paystack:sync:dev\n"
    );
    process.exit(1);
  }

  console.log(`\nSyncing Paystack plans for project: ${projectId}\n`);

  // Lazy-load AFTER the project env is set (same ordering rule as seed-all).
  const { collections } = await import("../utils/firebase");
  const { paystackProvider } = await import("../services/billing/paystack.provider");

  const snap = await collections.plans.get();
  const plans = snap.docs.map((d) => d.data() as StoredPlan);

  let created = 0;
  let skipped = 0;
  for (const plan of plans) {
    // Only recurring paid packages need a Paystack Plan.
    if (!plan.priceKobo || plan.priceKobo <= 0) continue;
    if (plan.interval !== "month" && plan.interval !== "year") continue;
    if (plan.paystackPlanCode) {
      console.log(`  • ${plan.id} — already has ${plan.paystackPlanCode}, skipping`);
      skipped++;
      continue;
    }

    const code = await paystackProvider.ensurePlan({
      name: plan.name,
      amountKobo: plan.priceKobo,
      interval: plan.interval,
    });
    await collections.plans.doc(plan.id).set({ paystackPlanCode: code }, { merge: true });
    console.log(`  ✓ ${plan.id} (${plan.interval}) → ${code}`);
    created++;
  }

  console.log(`\nDone. Created ${created} plan(s), skipped ${skipped}.\n`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Paystack plan sync failed:", error);
    process.exit(1);
  });
