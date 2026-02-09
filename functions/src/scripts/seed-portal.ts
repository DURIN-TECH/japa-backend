/**
 * Seed portal integration data (users, agency, agents, applications, timelines, documents, notes)
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

if (!admin.apps.length) {
  admin.initializeApp({ projectId });
}

import { seedPortalData } from "../data/seed-portal-data";

async function main() {
  console.log(`Starting portal seed for project: ${projectId}`);

  try {
    const result = await seedPortalData();
    console.log("Seed completed successfully!");
    console.log(`- Users: ${result.users}`);
    console.log(`- Agencies: ${result.agencies}`);
    console.log(`- Agents: ${result.agents}`);
    console.log(`- Applications: ${result.applications}`);
    console.log(`- Timeline entries: ${result.timelineEntries}`);
    console.log(`- Documents: ${result.documents}`);
    console.log(`- Notes: ${result.notes}`);
    process.exit(0);
  } catch (error) {
    console.error("Seed failed:", error);
    process.exit(1);
  }
}

main();
