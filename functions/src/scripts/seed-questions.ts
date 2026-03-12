import * as admin from "firebase-admin";

const projectId = process.env.GCLOUD_PROJECT || "japa-platform";

// Check if running against emulator
if (process.env.FIRESTORE_EMULATOR_HOST) {
  console.log(`Using Firestore emulator at ${process.env.FIRESTORE_EMULATOR_HOST}`);
}

// Initialize Firebase Admin with project ID
if (!admin.apps.length) {
  admin.initializeApp({ projectId });
}

import { seedNigeriaIrelandEligibility } from "../data/eligibility-seed-nigeria-ireland";

async function main() {
  console.log(`Starting eligibility questions seed for project: ${projectId}`);

  try {
    const result = await seedNigeriaIrelandEligibility();
    console.log("Seed completed successfully!");
    console.log(`- Questions seeded: ${result.questionsSeeded}`);
    console.log(`- Exemptions seeded: ${result.exemptionsSeeded}`);
    process.exit(0);
  } catch (error) {
    console.error("Seed failed:", error);
    process.exit(1);
  }
}

main();
