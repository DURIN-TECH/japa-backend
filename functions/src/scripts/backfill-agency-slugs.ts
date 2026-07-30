/**
 * One-time migration: give every existing agency a unique public `slug`.
 *
 * Slugs power the shareable public agency page (`/a/<slug>`). Agencies created
 * before slugs existed have none, so this backfills them from each agency's
 * name using the same generator the create path uses
 * (`agencyService.generateUniqueAgencySlug`). Idempotent — agencies that already
 * have a slug are skipped, so it is safe to re-run.
 *
 * Run:  npm run build && node lib/scripts/backfill-agency-slugs.js
 * (Against the emulator: set FIRESTORE_EMULATOR_HOST. Against a real project,
 *  select it the same way as the other scripts, e.g. GCLOUD_PROJECT=durin-seli-dev.)
 */
import { collections } from "../utils/firebase";
import { agencyService } from "../services/agency.service";
import { Agency } from "../types";

/**
 * Assign a unique slug to every agency that lacks one. Exported so a consolidated
 * seeder could run it in-process; also runnable standalone (guard below).
 */
export async function backfillAgencySlugs(): Promise<void> {
  console.log("Backfilling public slugs for all agencies…");

  const snapshot = await collections.agencies.get();
  let total = 0;
  let assigned = 0;
  let skipped = 0;

  for (const doc of snapshot.docs) {
    total++;
    const agency = doc.data() as Agency;

    // Already has a slug — leave it untouched so links stay stable.
    if (agency.slug) {
      skipped++;
      continue;
    }

    try {
      // generateUniqueAgencySlug checks the collection for collisions, so slugs
      // assigned earlier in this same run are taken into account.
      const slug = await agencyService.generateUniqueAgencySlug(agency.name);
      await doc.ref.update({ slug });
      assigned++;
      console.log(`  ✓ ${agency.id} "${agency.name}" → ${slug}`);
    } catch (error) {
      console.error(`  ✗ ${agency.id} ("${agency.name}"):`, error);
    }
  }

  console.log(
    `\nDone. ${total} agencies — ${assigned} assigned, ${skipped} already had a slug.`
  );
}

// Allow `node lib/scripts/backfill-agency-slugs.js` to run it directly.
if (require.main === module) {
  backfillAgencySlugs()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error("Slug backfill failed:", error);
      process.exit(1);
    });
}
