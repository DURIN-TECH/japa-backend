/**
 * Consolidated seed script — seeds the entire backend in one run.
 *
 * This replaces the prior collection of per-domain seed scripts
 * (seed-auth-users, seed-portal, seed-questions, seed-eligibility,
 * seed-news-sources). It initializes Firebase Admin once and then
 * invokes each underlying data seeder in dependency order.
 *
 * Usage:
 *   npm run seed:emulator                       # local emulators (safe sandbox)
 *   npm run seed:dev                            # durin-seli-dev
 *   npm run seed:prod -- --confirm-prod         # japa-platform (guarded)
 *   node lib/scripts/seed-all.js --project <id> [--confirm-prod]
 *
 * Project selection precedence (highest wins):
 *   1. --project <id>  /  -p <id>   (CLI flag)
 *   2. SEED_PROJECT                 (env)
 *   3. GCLOUD_PROJECT / GOOGLE_CLOUD_PROJECT (env)
 *   4. emulator run (FIRESTORE_EMULATOR_HOST set) → "demo-seli"
 * There is NO silent production default — an unresolved project aborts.
 *
 * Against a REAL project, authenticate with a SERVICE ACCOUNT key:
 *   GOOGLE_APPLICATION_CREDENTIALS=<sa-key.json> npm run seed:dev
 * User ADC (`gcloud auth application-default login`) works for Firestore but
 * FAILS for Auth/identitytoolkit ("requires a quota project") — firebase-admin's
 * Auth client doesn't apply the ADC quota project. A service account's own
 * project is the consumer, so it just works; any SA with firebase.admin (e.g.
 * ci-deployer@<project>) is sufficient.
 */

// Projects treated as production. Seeding writes test users/agencies/etc., so
// touching one requires an explicit --confirm-prod (or ALLOW_PROD_SEED=true).
const PROD_PROJECT_IDS = ["japa-platform"];

// Minimal CLI flag parsing: --project <id> | --project=<id> | -p <id>,
// plus --confirm-prod / --yes to authorize a production target.
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

// Resolve the target project — no silent prod fallback.
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
    "   e.g. npm run seed:dev   |   node lib/scripts/seed-all.js --project durin-seli-dev\n"
  );
  process.exit(1);
}

// Guard: refuse to seed a production project unless explicitly confirmed.
const confirmProd = args.confirmProd || process.env.ALLOW_PROD_SEED === "true";
if (!onEmulator && PROD_PROJECT_IDS.includes(projectId) && !confirmProd) {
  console.error(
    `\n❌ Refusing to seed PRODUCTION project "${projectId}" — this writes test data.\n` +
    "   Re-run with --confirm-prod (or ALLOW_PROD_SEED=true) if you really mean it.\n"
  );
  process.exit(1);
}

// Log which emulators (if any) this run is targeting so it's obvious at a
// glance whether we're writing to local sandboxes or live infrastructure.
if (process.env.FIRESTORE_EMULATOR_HOST) {
  console.log(`Using Firestore emulator at ${process.env.FIRESTORE_EMULATOR_HOST}`);
}
if (process.env.FIREBASE_AUTH_EMULATOR_HOST) {
  console.log(`Using Auth emulator at ${process.env.FIREBASE_AUTH_EMULATOR_HOST}`);
}

// Point the shared Admin SDK at THIS project. utils/firebase (lazy-loaded in
// main(), NOT imported at the top of this file) reads these envs and OWNS
// initializeApp() + Firestore settings(). We deliberately don't call those here
// too — doing so caused a wrong-project app and a double-settings() crash
// ("Firestore has already been initialized").
process.env.GCLOUD_PROJECT = projectId;
process.env.GOOGLE_CLOUD_PROJECT = projectId;
if (!onEmulator && !process.env.FIREBASE_STORAGE_BUCKET) {
  process.env.FIREBASE_STORAGE_BUCKET = `${projectId}.firebasestorage.app`;
}

/**
 * Entry point — runs each seeder sequentially so later seeders can depend
 * on data from earlier ones (e.g. portal data references auth users it
 * creates itself).
 */
async function main() {
  console.log(`\nStarting full backend seed for project: ${projectId}\n`);

  try {
    // Lazy-load the shared Admin SDK init FIRST — importing utils/firebase runs
    // initializeApp() (against the project env set above) + Firestore settings()
    // exactly once — then load the seeders, which reuse that default app.
    await import("../utils/firebase");
    const { seedPortalData } = await import("../data/seed-portal-data");
    const { seedNigeriaIrelandEligibility } = await import("../data/eligibility-seed-nigeria-ireland");
    const { seedNewsSources } = await import("../data/seed-news-sources");
    const { seedPlans } = await import("./seed-plans");
    const { backfillClaims } = await import("./backfill-claims");

    // 1. Portal data — creates auth users, agencies, agents, clients,
    //    countries, visa types, applications, and all related Firestore
    //    collections. This is the biggest seeder and everything else
    //    layers on top of the baseline data it creates.
    console.log("→ Seeding portal data (auth + Firestore)...");
    const portal = await seedPortalData();

    // 2. Eligibility questions — static question/exemption data for the
    //    Nigeria → Ireland flow. Independent of portal data.
    console.log("→ Seeding eligibility questions...");
    const eligibility = await seedNigeriaIrelandEligibility();

    // 3. News sources — feed definitions the scraper polls.
    console.log("→ Seeding news sources...");
    const newsCount = await seedNewsSources();

    // 4. Subscription plans — the RBAC/entitlement billing catalog. Without these
    //    the portal/mobile "Available plans" list is empty and upgrades can't start.
    console.log("→ Seeding subscription plans...");
    const plansCount = await seedPlans();

    // 5. RBAC role claims — backfill canonical role (+ agencyId) custom claims for
    //    every auth user from the portal data just seeded. Runs last so the agency/
    //    agent docs it reads already exist.
    console.log("→ Backfilling RBAC role claims...");
    await backfillClaims();

    // Summary output mirrors what the old per-domain scripts printed so
    // existing muscle memory / docs still line up.
    console.log("\n✅ Seed completed successfully!\n");
    console.log("Portal:");
    console.log(`  - Auth users:      ${portal.authUsers}`);
    console.log(`  - Users:           ${portal.users}`);
    console.log(`  - Agencies:        ${portal.agencies}`);
    console.log(`  - Agents:          ${portal.agents}`);
    console.log(`  - Countries:       ${portal.countries}`);
    console.log(`  - Visa types:      ${portal.visaTypes}`);
    console.log(`  - Applications:    ${portal.applications}`);
    console.log(`  - Timeline:        ${portal.timelineEntries}`);
    console.log(`  - Documents:       ${portal.documents}`);
    console.log(`  - Notes:           ${portal.notes}`);
    console.log(`  - Reviews:         ${portal.reviews}`);
    console.log(`  - Transactions:    ${portal.transactions}`);
    console.log(`  - Consultations:   ${portal.consultations}`);
    console.log(`  - Notifications:   ${portal.notifications}`);
    console.log(`  - Payment reqs:    ${portal.paymentRequests}`);
    console.log(`  - Conversations:   ${portal.conversations}`);
    console.log(`  - Bank accounts:   ${portal.bankAccounts}`);
    console.log("Eligibility:");
    console.log(`  - Questions:       ${eligibility.questionsSeeded}`);
    console.log(`  - Exemptions:      ${eligibility.exemptionsSeeded}`);
    console.log("News:");
    console.log(`  - Sources:         ${newsCount}`);
    console.log("Billing / RBAC:");
    console.log(`  - Plans:           ${plansCount}`);
    console.log("  - Role claims:     backfilled for all auth users");
    console.log("\nLogin credentials (all seed users): password123");
    console.log("  admin@selitest.com / admin2@selitest.com / owner@selitest.com");
    console.log("  agent1@selitest.com / agent2@selitest.com\n");

    process.exit(0);
  } catch (error) {
    console.error("\n❌ Seed failed:", error);
    process.exit(1);
  }
}

main();
