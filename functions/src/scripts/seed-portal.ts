/**
 * Seed portal integration data (auth users, Firestore data)
 *
 * Run against emulator:
 *   npm run seed:portal:emulator
 *
 * Run against production (use with caution):
 *   npm run seed:portal
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

import { seedPortalData } from "../data/seed-portal-data";

async function main() {
  console.log(`Starting portal seed for project: ${projectId}`);

  try {
    const result = await seedPortalData();
    console.log("Seed completed successfully!");
    console.log(`- Auth users: ${result.authUsers}`);
    console.log(`- Users: ${result.users}`);
    console.log(`- Agencies: ${result.agencies}`);
    console.log(`- Agents: ${result.agents}`);
    console.log(`- Countries: ${result.countries}`);
    console.log(`- Visa types: ${result.visaTypes}`);
    console.log(`- Applications: ${result.applications}`);
    console.log(`- Timeline entries: ${result.timelineEntries}`);
    console.log(`- Documents: ${result.documents}`);
    console.log(`- Notes: ${result.notes}`);
    console.log(`- Reviews: ${result.reviews}`);
    console.log(`- Transactions: ${result.transactions}`);
    console.log(`- Consultations: ${result.consultations}`);
    console.log(`- Notifications: ${result.notifications}`);
    console.log(`- Payment Requests: ${result.paymentRequests}`);
    console.log(`- Conversations: ${result.conversations}`);
    console.log(`- Bank Accounts: ${result.bankAccounts}`);
    console.log("\nLogin credentials (all users): password123");
    console.log("  Admin:  admin@japatest.com");
    console.log("  Admin2: admin2@japatest.com");
    console.log("  Owner:  owner@japatest.com");
    console.log("  Agent1: agent1@japatest.com");
    console.log("  Agent2: agent2@japatest.com");
    process.exit(0);
  } catch (error) {
    console.error("Seed failed:", error);
    process.exit(1);
  }
}

main();
