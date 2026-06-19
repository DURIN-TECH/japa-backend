/**
 * Consolidated seed script — seeds the entire backend in one run.
 *
 * This replaces the prior collection of per-domain seed scripts
 * (seed-auth-users, seed-portal, seed-questions, seed-eligibility,
 * seed-news-sources). It initializes Firebase Admin once and then
 * invokes each underlying data seeder in dependency order.
 *
 * Usage:
 *   npm run seed              # against whatever GCLOUD_PROJECT points to
 *   npm run seed:emulator     # against local Firestore + Auth emulators
 */

import * as admin from "firebase-admin";

// Firebase project ID — falls back to the default platform project when
// GCLOUD_PROJECT is not set (common when running locally against emulators).
const projectId = process.env.GCLOUD_PROJECT || "japa-platform";

// Log which emulators (if any) this run is targeting so it's obvious at a
// glance whether we're writing to local sandboxes or live infrastructure.
if (process.env.FIRESTORE_EMULATOR_HOST) {
  console.log(`Using Firestore emulator at ${process.env.FIRESTORE_EMULATOR_HOST}`);
}
if (process.env.FIREBASE_AUTH_EMULATOR_HOST) {
  console.log(`Using Auth emulator at ${process.env.FIREBASE_AUTH_EMULATOR_HOST}`);
}

// Initialize Firebase Admin exactly once — every downstream seeder
// reuses this default app instance.
if (!admin.apps.length) {
  admin.initializeApp({ projectId });
}

// Firestore tolerates undefined values in seed payloads instead of throwing,
// which keeps seed data definitions simpler (optional fields can be omitted).
admin.firestore().settings({ ignoreUndefinedProperties: true });

// Underlying data seeders — imported after admin init so they can use the
// default app safely.
import { seedPortalData } from "../data/seed-portal-data";
import { seedNigeriaIrelandEligibility } from "../data/eligibility-seed-nigeria-ireland";
import { seedNewsSources } from "../data/seed-news-sources";

/**
 * Entry point — runs each seeder sequentially so later seeders can depend
 * on data from earlier ones (e.g. portal data references auth users it
 * creates itself).
 */
async function main() {
  console.log(`\nStarting full backend seed for project: ${projectId}\n`);

  try {
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
