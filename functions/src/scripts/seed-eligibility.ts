/**
 * Script to seed eligibility questions for Nigeria → Ireland
 *
 * Run with: npx ts-node -r tsconfig-paths/register src/scripts/seed-eligibility.ts
 * Or via Firebase shell
 */

import { initializeApp, applicationDefault } from "firebase-admin/app";

// Initialize Firebase Admin
initializeApp({
  credential: applicationDefault(),
});

async function seedEligibility() {
  console.log("Starting eligibility seed...");

  // Import and run the seed function
  const { seedNigeriaIrelandEligibility } = await import("../data/eligibility-seed-nigeria-ireland");

  try {
    const result = await seedNigeriaIrelandEligibility();
    console.log(`✅ Seeded ${result.questionsSeeded} questions`);
    console.log(`✅ Seeded ${result.exemptionsSeeded} exemption(s)`);
    console.log("Done!");
  } catch (error) {
    console.error("❌ Error seeding:", error);
    process.exit(1);
  }
}

seedEligibility();
