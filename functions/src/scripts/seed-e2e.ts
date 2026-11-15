/**
 * E2E fixture seed (issue #361) — `npm run seed:e2e`, EMULATORS ONLY.
 *
 * For the mobile Maestro suite (seli-mobile `.maestro/`). In order:
 *
 *   0. SAFETY GUARD (scripts/e2e/emulator-guard.ts), before any Firebase
 *      module is loaded: FIRESTORE_EMULATOR_HOST, FIREBASE_AUTH_EMULATOR_HOST
 *      and FIREBASE_STORAGE_EMULATOR_HOST must all be set and point at
 *      localhost / 127.0.0.1, and the project must be `durin-seli-dev` (the
 *      default) or a `demo-*` id. Otherwise it exits 2 and writes nothing.
 *   1. The FULL existing seed (`seed-all.js --project <project>`), run as a
 *      child process with this same environment (seed-all ends with
 *      process.exit, so it cannot be imported). Skipped with `--fixture-only`.
 *   2. The fixture on top (builders: scripts/e2e/e2e-fixture-data.ts):
 *      - the APPROVED rulebook `visaRubrics/IE_short-stay-c` v1 (3 intake
 *        questions, 2 document items);
 *      - the client `seed-user-e2e-client-001`
 *        (`delivered+e2e.amaka.obi@resend.dev`, the seed's password), free
 *        plan, onboarding complete, role claim `client`;
 *      - every application that client owns is DELETED, so a re-run after a
 *        flow started one leaves the client with none again.
 *
 * Idempotent: fixed ids and timestamps; documents are `set` whole (the
 * subscription upsert is the seed's own and stamps `updatedAt`).
 *
 * Usage (emulators started with firebase.e2e.json, see docs/e2e-emulators.md):
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:19603 \
 *   FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:19605 \
 *   FIREBASE_STORAGE_EMULATOR_HOST=127.0.0.1:19606 \
 *   npm run seed:e2e [-- --fixture-only] [-- --project demo-xyz]
 */
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { checkEmulatorOnly, refusalMessage } from "./e2e/emulator-guard";

// ============================================
// CLI arguments
// ============================================

/** `--project <id>` / `--project=<id>` / `-p <id>`, and `--fixture-only`. */
export function parseE2eSeedArgs(argv: string[]): { project?: string; fixtureOnly: boolean } {
  let project: string | undefined;
  let fixtureOnly = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--project" || a === "-p") project = argv[++i];
    else if (a.startsWith("--project=")) project = a.slice("--project=".length);
    else if (a === "--fixture-only") fixtureOnly = true;
  }
  // `project` only when one was named (absent = the guard's default).
  return project === undefined ? { fixtureOnly } : { project, fixtureOnly };
}

// ============================================
// Fixture writer (runs only after the guard passed)
// ============================================

/**
 * Write the fixture. Firebase modules are imported HERE, lazily, so nothing
 * Firebase-related is loaded unless the guard has already passed.
 */
async function writeFixture(): Promise<void> {
  // utils/firebase first: it owns initializeApp() (seed-all does the same).
  const { collections, subcollections, db, auth } = await import("../utils/firebase");
  const { E2E_FIXTURE, buildE2eRubricHead, buildE2eRubricVersion, buildE2eClientUserDoc } = await import("./e2e/e2e-fixture-data");
  const { SEED_PASSWORD, resendTestEmail } = await import("../data/seed-portal-data");
  const { getDefaultPlan, upsertSubscription } = await import("./seed-subscriptions");
  const { claimsService } = await import("../services/claims.service");

  // ---- 1. The visa must exist (seeded by seed-countries-visas). ----
  const visaSnap = await collections.countries.doc(E2E_FIXTURE.countryCode).collection("visaTypes").doc(E2E_FIXTURE.visaTypeId).get();
  if (!visaSnap.exists) {
    throw new Error(`visa ${E2E_FIXTURE.countryCode}/${E2E_FIXTURE.visaTypeId} is not seeded: run the full seed first (drop --fixture-only)`);
  }

  // ---- 2. The approved rulebook: head + version 1, written together. ----
  // Any other version left under the route (none in a fresh run) is removed,
  // so the head's latestVersion (1) is always true.
  const versions = await subcollections.rubricVersions(E2E_FIXTURE.routeKey).get();
  const batch = db.batch();
  for (const d of versions.docs) {
    if (d.id !== String(E2E_FIXTURE.rubricVersion)) batch.delete(d.ref);
  }
  batch.set(collections.visaRubrics.doc(E2E_FIXTURE.routeKey), buildE2eRubricHead() as unknown as Record<string, unknown>);
  batch.set(
    subcollections.rubricVersions(E2E_FIXTURE.routeKey).doc(String(E2E_FIXTURE.rubricVersion)),
    buildE2eRubricVersion() as unknown as Record<string, unknown>
  );
  await batch.commit();
  console.log(`✅ Rulebook ${E2E_FIXTURE.routeKey} v${E2E_FIXTURE.rubricVersion} (approved, 3 intake questions, 2 document items)`);

  // ---- 3. The client account. ----
  const email = resendTestEmail(E2E_FIXTURE.clientEmailLabel);
  // The profile doc is written BEFORE the Auth account, so the functions
  // emulator's onUserCreated trigger finds it and does nothing (no welcome
  // notification), exactly as it treats a seeded user.
  await collections.users.doc(E2E_FIXTURE.clientUid).set(buildE2eClientUserDoc(email));
  const displayName = `${E2E_FIXTURE.clientFirstName} ${E2E_FIXTURE.clientLastName}`;
  try {
    await auth.getUser(E2E_FIXTURE.clientUid);
    // Exists: reset it to the fixture values (a flow may have changed them).
    await auth.updateUser(E2E_FIXTURE.clientUid, { email, password: SEED_PASSWORD, displayName, emailVerified: true });
  } catch {
    await auth.createUser({ uid: E2E_FIXTURE.clientUid, email, password: SEED_PASSWORD, displayName, emailVerified: true });
  }
  // Free plan (the client audience's default plan, seeded by seed-plans).
  const freePlan = await getDefaultPlan("client");
  await upsertSubscription("client", E2E_FIXTURE.clientUid, freePlan);
  // Role claim (`client`), from the docs just written.
  await claimsService.syncClaimsFromDb(E2E_FIXTURE.clientUid);
  console.log(`✅ Client ${E2E_FIXTURE.clientUid} <${email}> on ${freePlan.id}`);

  // ---- 4. No application for this client (a re-run resets a flow's one). ----
  const apps = await collections.applications.where("userId", "==", E2E_FIXTURE.clientUid).get();
  for (const d of apps.docs) await db.recursiveDelete(d.ref);
  console.log(`✅ Applications of the client removed: ${apps.size}`);
}

// ============================================
// Entry point
// ============================================

async function main(): Promise<void> {
  const args = parseE2eSeedArgs(process.argv.slice(2));

  // 0. The guard. Nothing Firebase-related has been loaded yet.
  const guard = checkEmulatorOnly(process.env, args.project);
  if (!guard.ok) {
    console.error(refusalMessage(guard.problems));
    process.exit(2);
  }
  const project = guard.project;
  // Pin the project for this process (utils/firebase reads these).
  process.env.GCLOUD_PROJECT = project;
  process.env.GOOGLE_CLOUD_PROJECT = project;
  console.log(`\nE2E fixture seed on the emulators, project ${project}`);
  console.log(`  Firestore ${process.env.FIRESTORE_EMULATOR_HOST}, Auth ${process.env.FIREBASE_AUTH_EMULATOR_HOST}, Storage ${process.env.FIREBASE_STORAGE_EMULATOR_HOST}\n`);

  // 1. The full seed, as a child process with this (checked) environment.
  if (!args.fixtureOnly) {
    const seedAll = path.join(__dirname, "seed-all.js");
    const r = spawnSync(process.execPath, [seedAll, "--project", project], { stdio: "inherit", env: process.env });
    if (r.status !== 0) {
      console.error(`\n❌ The full seed failed (exit ${r.status ?? r.signal}); the fixture was not written.`);
      process.exit(1);
    }
  }

  // 2. The fixture.
  await writeFixture();
  console.log("\n✅ E2E fixture ready. Login: the e2e client's email above, the seed password (see seed-portal-data SEED_PASSWORD).\n");
}

// Run only as a script (the unit tests import parseE2eSeedArgs).
if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("\n❌ E2E fixture seed failed:", err);
      process.exit(1);
    });
}
