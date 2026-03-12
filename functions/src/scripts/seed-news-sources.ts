/**
 * Seed news sources into Firestore
 *
 * Run against emulator:
 *   npm run seed:news:emulator
 *
 * Run against production (use with caution):
 *   npm run seed:news
 */

import * as admin from "firebase-admin";

const projectId = process.env.GCLOUD_PROJECT || "japa-platform";

if (process.env.FIRESTORE_EMULATOR_HOST) {
  console.log(
    `Using Firestore emulator at ${process.env.FIRESTORE_EMULATOR_HOST}`
  );
}

if (!admin.apps.length) {
  admin.initializeApp({ projectId });
}

import { NEWS_SOURCES } from "../data/seed-news-sources";

const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });

async function seedNewsSources() {
  console.log(`Seeding ${NEWS_SOURCES.length} news sources...`);

  const collection = db.collection("newsSources");
  const batch = db.batch();
  const now = admin.firestore.Timestamp.now();

  for (const source of NEWS_SOURCES) {
    // Use slug as deterministic ID for idempotent seeding
    const ref = collection.doc(source.slug);

    const data = {
      id: source.slug,
      name: source.name,
      slug: source.slug,
      url: source.url,
      countryCodes: source.countryCodes,
      strategy: source.strategy,
      config: source.config,
      scrapeIntervalMinutes: source.scrapeIntervalMinutes,
      nextScrapeAt: now, // Due immediately on first run
      status: source.status,
      reliabilityScore: 100,
      consecutiveFailures: 0,
      totalRuns: 0,
      successfulRuns: 0,
      isOfficial: source.isOfficial,
      priority: source.priority,
      createdAt: now,
      updatedAt: now,
    };

    batch.set(ref, data, { merge: true });
    console.log(`  + ${source.name} (${source.strategy})`);
  }

  await batch.commit();
  console.log(`Successfully seeded ${NEWS_SOURCES.length} news sources`);
}

async function main() {
  console.log(`Starting news source seed for project: ${projectId}`);

  try {
    await seedNewsSources();
    console.log("Seed complete!");
  } catch (error) {
    console.error("Seed failed:", error);
    process.exit(1);
  }
}

main();
