/**
 * Migration: make sure every agency has a public `slug` that is a valid DNS label.
 *
 * Slugs power two things now:
 *   • the shareable public agency page (`/a/<slug>`), and
 *   • the agency's vanity subdomain (`https://<slug>.weareseli.com`).
 *
 * The second use promoted the slug to a DNS label, so this script does TWO jobs:
 *
 *   1. ASSIGN — agencies created before slugs existed have none; give them one
 *      (unchanged behaviour).
 *   2. REPAIR — agencies whose stored slug predates the DNS rules may be too
 *      long (>63 chars), contain a trailing hyphen, start with `xn--`, or be a
 *      reserved infrastructure label (`www`, `portal`, `api`, …). Those are
 *      rewritten, and the OLD value is appended to `previousSlugs` so every link
 *      already shared under it still reaches the agency (the public page 301s to
 *      the new canonical URL).
 *
 * Both jobs go through `agencyService`, so uniqueness is checked against the
 * live collection and against slugs assigned earlier in the same run.
 *
 * Idempotent — an agency whose slug is already valid and unreserved is skipped,
 * so it is safe to re-run.
 *
 * Run:  npm run backfill:slugs           (default project)
 *       npm run backfill:slugs:dev       (durin-seli-dev)
 * (Against the emulator: set FIRESTORE_EMULATOR_HOST. Against a real project,
 *  select it the same way as the other scripts, e.g. GCLOUD_PROJECT=durin-seli-dev.)
 */
import { collections } from "../utils/firebase";
import { agencyService } from "../services/agency.service";
import { isUsableAgencySlug } from "../utils/agency-slug";
import { Agency } from "../types";

/**
 * Assign or repair the public slug of every agency. Exported so a consolidated
 * seeder could run it in-process; also runnable standalone (guard below).
 */
export async function backfillAgencySlugs(): Promise<void> {
  console.log("Backfilling public slugs for all agencies…");

  const snapshot = await collections.agencies.get();
  let total = 0;
  let assigned = 0;
  let rewritten = 0;
  let skipped = 0;

  for (const doc of snapshot.docs) {
    total++;
    const agency = doc.data() as Agency;

    // Already valid AND unreserved — leave it untouched so links stay stable.
    if (isUsableAgencySlug(agency.slug)) {
      skipped++;
      continue;
    }

    try {
      // migrateAgencySlug generates a unique, DNS-safe slug and (when there was
      // an old value) records it in `previousSlugs` in the same write.
      const change = await agencyService.migrateAgencySlug(agency);

      // Defensive: migrate returns null only when the slug was already usable,
      // which the guard above already excluded.
      if (!change) {
        skipped++;
        continue;
      }

      // `from === "(none)"` means the agency had no slug at all (job 1);
      // anything else means an invalid/reserved slug was replaced (job 2).
      if (change.from === "(none)") assigned++;
      else rewritten++;

      // One `old → new` line per changed agency, as the migration contract asks.
      console.log(`  ✓ ${agency.id} "${agency.name}": ${change.from} → ${change.to}`);
    } catch (error) {
      console.error(`  ✗ ${agency.id} ("${agency.name}"):`, error);
    }
  }

  console.log(
    `\nDone. ${total} agencies — ${assigned} newly assigned, ${rewritten} rewritten, ` +
      `${skipped} already valid.`
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
