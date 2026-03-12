/**
 * Seed only Firebase Auth users and admin custom claims
 *
 * Run against emulator:
 *   npm run seed:auth:emulator
 *
 * Run against production (use with caution):
 *   npm run seed:auth
 */

import * as admin from "firebase-admin";

const projectId = process.env.GCLOUD_PROJECT || "japa-platform";

if (process.env.FIRESTORE_EMULATOR_HOST) {
  console.log(`Using Firestore emulator at ${process.env.FIRESTORE_EMULATOR_HOST}`);
}

if (process.env.FIREBASE_AUTH_EMULATOR_HOST) {
  console.log(`Using Auth emulator at ${process.env.FIREBASE_AUTH_EMULATOR_HOST}`);
}

if (!admin.apps.length) {
  admin.initializeApp({ projectId });
}

const SEED_PASSWORD = "password123";

const AUTH_USERS = [
  { uid: "seed-user-admin-001", email: "admin@japatest.com", displayName: "Olu Adeyemi", isAdmin: true },
  { uid: "seed-user-admin-002", email: "admin2@japatest.com", displayName: "Ngozi Ibe", isAdmin: true },
  { uid: "seed-user-owner-001", email: "owner@japatest.com", displayName: "Adaeze Okonkwo" },
  { uid: "seed-user-agent-001", email: "agent1@japatest.com", displayName: "Chinedu Eze" },
  { uid: "seed-user-agent-002", email: "agent2@japatest.com", displayName: "Fatima Bello" },
  { uid: "seed-user-client-001", email: "john.doe@example.com", displayName: "John Doe" },
  { uid: "seed-user-client-002", email: "jane.smith@example.com", displayName: "Jane Smith" },
  { uid: "seed-user-client-003", email: "ahmed.ali@example.com", displayName: "Ahmed Ali" },
  { uid: "seed-user-client-004", email: "lisa.wong@example.com", displayName: "Lisa Wong" },
  { uid: "seed-user-client-005", email: "tunde.bakare@example.com", displayName: "Tunde Bakare" },
  { uid: "seed-user-client-006", email: "kwame.asante@example.com", displayName: "Kwame Asante" },
  { uid: "seed-user-client-007", email: "wanjiku.mwangi@example.com", displayName: "Wanjiku Mwangi" },
  { uid: "seed-user-client-008", email: "sipho.ndlovu@example.com", displayName: "Sipho Ndlovu" },
  { uid: "seed-user-client-009", email: "priya.sharma@example.com", displayName: "Priya Sharma" },
  { uid: "seed-user-client-010", email: "miguel.santos@example.com", displayName: "Miguel Santos" },
];

async function main() {
  const auth = admin.auth();
  let created = 0;
  let claimsSet = 0;

  console.log(`\nSeeding auth users for project: ${projectId}\n`);

  for (const user of AUTH_USERS) {
    try {
      await auth.getUser(user.uid);
    } catch {
      await auth.createUser({
        uid: user.uid,
        email: user.email,
        password: SEED_PASSWORD,
        displayName: user.displayName,
        emailVerified: true,
      });
      created++;
    }

    if (user.isAdmin) {
      await auth.setCustomUserClaims(user.uid, { admin: true });
      claimsSet++;
    }
  }

  console.log(`✅ Auth users: ${AUTH_USERS.length} total (${created} new, ${AUTH_USERS.length - created} existing)`);
  console.log(`✅ Admin claims set: ${claimsSet}`);
  console.log(`\nLogin credentials (all users): ${SEED_PASSWORD}`);
  console.log("  Admin:  admin@japatest.com");
  console.log("  Admin2: admin2@japatest.com");
  console.log("  Owner:  owner@japatest.com");
  console.log("  Agent1: agent1@japatest.com");
  console.log("  Agent2: agent2@japatest.com\n");

  process.exit(0);
}

main().catch((error) => {
  console.error("Seed failed:", error);
  process.exit(1);
});
