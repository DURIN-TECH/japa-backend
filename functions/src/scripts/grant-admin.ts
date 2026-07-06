/**
 * Grant (or revoke) the admin role for a single user — the break-glass tool that
 * solves the first-admin bootstrap problem.
 *
 * The role-management HTTP endpoint (`PUT /users/:uid/role`) is admin-only, so it
 * can't create the *first* admin: nobody is an admin yet to call it. This script
 * runs out-of-band with Admin SDK credentials — which already bypass all auth — so
 * it adds no new attack surface, needs no public endpoint, and is the conventional
 * way to seed the initial admin per environment. After the first admin exists, use
 * the in-app endpoint to promote everyone else.
 *
 * Usage:
 *   npm run admin:grant -- --project durin-seli-dev someone@example.com
 *   npm run admin:grant -- --project japa-platform someone@example.com --confirm-prod
 *   npm run admin:revoke -- --project durin-seli-dev someone@example.com
 *   node lib/scripts/grant-admin.js <uid|email> --project <id> [--revoke] [--confirm-prod]
 *
 * The target may be given as a Firebase Auth UID or an email (resolved via
 * getUserByEmail). Project selection + the production guard mirror seed-all.ts
 * exactly (see below); auth against a real project needs a SERVICE ACCOUNT key,
 * not user ADC, because firebase-admin's Auth client ignores the ADC quota project.
 */

import { ROLES } from "@durin-tech/authz";

// Projects treated as production. Promoting an admin there is a legitimate action
// (you must bootstrap the first prod admin somehow), but it's high-impact, so it
// requires an explicit --confirm-prod — same contract as the seeder.
const PROD_PROJECT_IDS = ["japa-platform"];

/**
 * Minimal CLI parsing: the first non-flag argument is the target (uid|email).
 * Flags: --project <id> | --project=<id> | -p <id>, --revoke, --confirm-prod|--yes.
 */
function parseArgs(argv: string[]): {
  target?: string;
  project?: string;
  revoke: boolean;
  confirmProd: boolean;
} {
  let target: string | undefined;
  let project: string | undefined;
  let revoke = false;
  let confirmProd = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--project" || a === "-p") project = argv[++i];
    else if (a.startsWith("--project=")) project = a.slice("--project=".length);
    else if (a === "--revoke") revoke = true;
    else if (a === "--confirm-prod" || a === "--yes") confirmProd = true;
    else if (!a.startsWith("-") && !target) target = a; // first positional = target
  }
  return { target, project, revoke, confirmProd };
}

const args = parseArgs(process.argv.slice(2));
const onEmulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

if (!args.target) {
  console.error(
    "\n❌ No target user specified.\n" +
    "   Pass a UID or email, e.g.\n" +
    "   node lib/scripts/grant-admin.js someone@example.com --project durin-seli-dev\n"
  );
  process.exit(1);
}

// Resolve the target project — no silent prod fallback (identical to seed-all).
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

// Guard: promoting/demoting admin on a production project needs explicit confirmation.
const confirmProd = args.confirmProd || process.env.ALLOW_PROD_SEED === "true";
if (!onEmulator && PROD_PROJECT_IDS.includes(projectId) && !confirmProd) {
  console.error(
    `\n❌ Refusing to modify admin on PRODUCTION project "${projectId}".\n` +
    "   Re-run with --confirm-prod if you really mean it.\n"
  );
  process.exit(1);
}

if (process.env.FIRESTORE_EMULATOR_HOST) {
  console.log(`Using Firestore emulator at ${process.env.FIRESTORE_EMULATOR_HOST}`);
}
if (process.env.FIREBASE_AUTH_EMULATOR_HOST) {
  console.log(`Using Auth emulator at ${process.env.FIREBASE_AUTH_EMULATOR_HOST}`);
}

// Point the shared Admin SDK at THIS project BEFORE importing utils/firebase (which
// owns initializeApp() + Firestore settings()). Setting the env after that import
// would initialize the app against the wrong project. Mirrors seed-all.ts.
process.env.GCLOUD_PROJECT = projectId;
process.env.GOOGLE_CLOUD_PROJECT = projectId;
if (!onEmulator && !process.env.FIREBASE_STORAGE_BUCKET) {
  process.env.FIREBASE_STORAGE_BUCKET = `${projectId}.firebasestorage.app`;
}

/**
 * Entry point — resolve the target user, then grant or revoke admin via the shared
 * ClaimsService so claims stay consistent with the in-app role-management path.
 */
async function main() {
  const action = args.revoke ? "Revoking admin from" : "Granting admin to";
  console.log(`\n${action} "${args.target}" on project: ${projectId}\n`);

  // Lazy-load AFTER the project env is set (see note above), same as seed-all.
  const { auth } = await import("../utils/firebase");
  const { claimsService } = await import("../services/claims.service");

  // Resolve target → a concrete Auth user. Accept either a UID or an email.
  const target = args.target as string;
  const isEmail = target.includes("@");
  const user = isEmail
    ? await auth.getUserByEmail(target).catch(() => null)
    : await auth.getUser(target).catch(() => null);

  if (!user) {
    console.error(
      `❌ No Firebase Auth user found for ${isEmail ? "email" : "uid"} "${target}".`
    );
    process.exit(1);
  }

  if (args.revoke) {
    // Demote: drop back to whatever role the user's Firestore state implies
    // (owner/agent/client) — ClaimsService.setAdmin(false) resolves that for us.
    await claimsService.setAdmin(user.uid, false);
    const resolved = await claimsService.resolveRoleFromDb(user.uid);
    console.log(
      `✅ Admin revoked from ${user.email || user.uid}. New role: "${resolved.role}".`
    );
  } else {
    // Promote: write the admin role claim (setRoleClaims keeps legacy `admin` in sync).
    await claimsService.setRoleClaims(user.uid, ROLES.ADMIN);
    console.log(`✅ ${user.email || user.uid} is now an admin.`);
  }

  console.log(
    "   The user must sign out/in (or refresh their ID token) for the change to take effect.\n"
  );
  process.exit(0);
}

main().catch((error) => {
  console.error("\n❌ grant-admin failed:", error);
  process.exit(1);
});
