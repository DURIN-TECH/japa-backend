/**
 * Production bootstrap seeder — the MINIMAL, non-test dataset a fresh prod
 * project needs to be usable.
 *
 * This is deliberately DIFFERENT from `seed-all.ts` (used for dev/emulator),
 * which seeds a full fake test dataset (agencies, agents, clients, applications,
 * transactions, consultations, subscriptions, …). Running that on prod would
 * pollute it with fake users and cases. Instead, prod gets:
 *
 *   1. The 2 real platform admins (by email) — created if missing, granted the
 *      admin role idempotently.
 *   2. Non-test reference/config data the app needs to function:
 *        - countries + visa types (the visa catalog)
 *        - eligibility questions
 *        - news sources (feed definitions)
 *        - subscription plans (billing catalog)
 *        - global document templates
 *
 * It seeds NO fake agencies/agents/clients/applications/consultations/etc.
 *
 * IDEMPOTENT: every step upserts by deterministic id (or get-then-create for the
 * admins) and deletes nothing, so it's safe to re-run.
 *
 * `seed:dev` / `seed:emulator` still run `seed-all.ts` — this file changes ONLY
 * what `seed:prod` does, so dev/local seeding is unaffected.
 *
 * Usage:
 *   npm run seed:prod -- --confirm-prod            # japa-platform (guarded)
 *   node lib/scripts/seed-prod-bootstrap.js --project <id> [--confirm-prod]
 *
 * Project selection + the production guard mirror seed-all.ts exactly.
 */

// Mark this file as a module so its top-level declarations (projectId, main, …)
// are module-scoped rather than global — otherwise they collide with the
// identically-named top-level declarations in the sibling script seed-all.ts.
export {};

// The real platform admins to bootstrap. Signed-in via Google (Gmail, a trusted
// provider that auto-links to these verified-email accounts) or the portal's
// Forgot Password flow — so we create them WITHOUT a password. firstName/lastName
// are a best-effort split of the email; the admins can change them in-app.
const PROD_ADMINS = [
  { email: "calebogundiya@gmail.com", firstName: "Caleb", lastName: "Ogundiya" },
  { email: "estherakinloose@gmail.com", firstName: "Esther", lastName: "Akinloose" },
];

// Projects treated as production — seeding one is high-impact, so it requires an
// explicit --confirm-prod (or ALLOW_PROD_SEED=true). Same contract as seed-all.ts.
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

// Resolve the target project — no silent prod fallback (mirrors seed-all.ts).
const projectId =
  args.project ||
  process.env.SEED_PROJECT ||
  process.env.GCLOUD_PROJECT ||
  process.env.GOOGLE_CLOUD_PROJECT ||
  (onEmulator ? "demo-seli" : undefined);

if (!projectId) {
  console.error(
    "\n❌ No target project specified.\n" +
    "   Pass --project <id>, set SEED_PROJECT/GCLOUD_PROJECT, or run against emulators.\n"
  );
  process.exit(1);
}

// Guard: refuse to seed a production project unless explicitly confirmed.
const confirmProd = args.confirmProd || process.env.ALLOW_PROD_SEED === "true";
if (!onEmulator && PROD_PROJECT_IDS.includes(projectId) && !confirmProd) {
  console.error(
    `\n❌ Refusing to seed PRODUCTION project "${projectId}".\n` +
    "   Re-run with --confirm-prod (or ALLOW_PROD_SEED=true) if you really mean it.\n"
  );
  process.exit(1);
}

// Point the shared Admin SDK at THIS project BEFORE importing utils/firebase
// (which owns initializeApp() + Firestore settings()). Mirrors seed-all.ts.
process.env.GCLOUD_PROJECT = projectId;
process.env.GOOGLE_CLOUD_PROJECT = projectId;
if (!onEmulator && !process.env.FIREBASE_STORAGE_BUCKET) {
  process.env.FIREBASE_STORAGE_BUCKET = `${projectId}.firebasestorage.app`;
}

/**
 * Create (if missing) and grant admin to the 2 platform admins. Idempotent:
 * resolves each by email first, only creates when absent, and (re)applies the
 * admin role every run so the claim + users-doc admin field stay correct.
 */
async function seedProdAdmins(): Promise<number> {
  const { getAuth } = await import("firebase-admin/auth");
  const { Timestamp } = await import("firebase-admin/firestore");
  const { collections } = await import("../utils/firebase");
  const { claimsService } = await import("../services/claims.service");

  const auth = getAuth();
  let created = 0;

  for (const admin of PROD_ADMINS) {
    // Resolve the user by email (idempotent); create only if absent.
    let uid: string;
    try {
      const existing = await auth.getUserByEmail(admin.email);
      uid = existing.uid;
    } catch {
      const user = await auth.createUser({
        email: admin.email,
        emailVerified: true,
        displayName: `${admin.firstName} ${admin.lastName}`,
        // No password on purpose — sign in via Google (Gmail) or Forgot Password.
      });
      uid = user.uid;
      created++;
    }

    // Ensure the profile doc exists with the admin field set (consulted by
    // resolveRoleFromDb). merge:true preserves anything already there.
    const now = Timestamp.now();
    await collections.users.doc(uid).set(
      {
        id: uid,
        email: admin.email,
        firstName: admin.firstName,
        lastName: admin.lastName,
        admin: true,
        onboardingCompleted: false,
        hasPassport: false,
        createdAt: now,
        updatedAt: now,
      },
      { merge: true }
    );

    // Apply the canonical admin role claim (+ syncs the users-doc admin field).
    await claimsService.setRoleClaims(uid, "admin", null);
    console.log(`  ✓ admin ${admin.email} (${uid})`);
  }

  console.log(
    `✅ Bootstrapped ${PROD_ADMINS.length} admins (${created} new, ${PROD_ADMINS.length - created} existing)`
  );
  return PROD_ADMINS.length;
}

/**
 * Entry point — admins first, then the non-test reference/config datasets. Each
 * underlying seeder is idempotent (deterministic ids). Seeders are imported
 * lazily, AFTER utils/firebase has initialized the Admin SDK.
 */
async function main() {
  console.log(`\nStarting PROD bootstrap seed for project: ${projectId}\n`);

  try {
    // Initialize the shared Admin SDK first (initializeApp + Firestore settings).
    await import("../utils/firebase");

    // 1. Platform admins.
    console.log("→ Bootstrapping platform admins...");
    const admins = await seedProdAdmins();

    // 2. Non-test reference/config data. Each line is independent and safe to
    //    comment out if a given catalog should NOT be pre-populated on prod.
    const { seedCountriesAndVisas } = await import("../data/seed-countries-visas");
    const { seedNigeriaIrelandEligibility } = await import("../data/eligibility-seed-nigeria-ireland");
    const { seedNewsSources } = await import("../data/seed-news-sources");
    const { seedDocumentTemplates } = await import("../data/seed-document-templates");
    const { seedPlans } = await import("./seed-plans");

    console.log("→ Seeding countries & visa types...");
    const cv = await seedCountriesAndVisas();

    console.log("→ Seeding eligibility questions...");
    const elig = await seedNigeriaIrelandEligibility();

    console.log("→ Seeding news sources...");
    const news = await seedNewsSources();

    console.log("→ Seeding subscription plans...");
    const plans = await seedPlans();

    console.log("→ Seeding document templates...");
    const templates = await seedDocumentTemplates();

    console.log("\n✅ Prod bootstrap complete!\n");
    console.log(`  - Admins:          ${admins}`);
    console.log(`  - Countries:       ${cv.countries}`);
    console.log(`  - Visa types:      ${cv.visaTypes}`);
    console.log(`  - Eligibility Qs:  ${elig.questionsSeeded}`);
    console.log(`  - News sources:    ${news}`);
    console.log(`  - Plans:           ${plans}`);
    console.log(`  - Doc templates:   ${templates}`);
    console.log("\nAdmins sign in with Google (Gmail) or the portal's Forgot Password flow.\n");

    process.exit(0);
  } catch (error) {
    console.error("\n❌ Prod bootstrap failed:", error);
    process.exit(1);
  }
}

main();
