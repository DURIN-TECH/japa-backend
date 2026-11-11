/**
 * Seed the caseworker-guidance source registry (issue #39), and optionally
 * crawl it once.
 *
 * Writes the entries in data/seed-guidance-sources.ts to `guidanceSources`
 * (merge, idempotent, crawl state kept). Seeding does not fetch anything.
 *
 * SAFETY
 *  - DRY RUN BY DEFAULT: validates the entries, prints what would be written
 *    and writes nothing. Pass `--apply` to write.
 *  - The target project must be named explicitly with GCLOUD_PROJECT (or an
 *    emulator via FIRESTORE_EMULATOR_HOST); there is no default project.
 *  - `--crawl` (only with `--apply`) then runs the guidance crawl once. That
 *    DOES make network requests (robots.txt + one GET per due source) and
 *    writes snapshot text to the project's default Storage bucket. Add
 *    `--only=<id>,<id>` to crawl just those sources (due or not).
 *
 * Run (from functions/):
 *   npm run build
 *   GCLOUD_PROJECT=<project> node lib/scrapers/guidance/scripts/seed-guidance-sources.js           # dry run
 *   GCLOUD_PROJECT=<project> node lib/scrapers/guidance/scripts/seed-guidance-sources.js --apply   # write
 *   GCLOUD_PROJECT=<project> node lib/scrapers/guidance/scripts/seed-guidance-sources.js --apply --crawl --only=<id>
 * or `npm run seed:guidance-sources -- [--apply] [--crawl] [--only=...]`.
 */
import { GUIDANCE_SOURCE_SEEDS, seedGuidanceSources, validateGuidanceSourceSeeds } from "../data/seed-guidance-sources";

/** Tag every line this script prints. */
const TAG = "[seed-guidance-sources]";

/** Run the seed: dry run unless `--apply`. */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const crawl = args.includes("--crawl");
  // `--only=a,b` -> ["a", "b"]; absent -> undefined (crawl whatever is due).
  const onlyArg = args.find((a) => a.startsWith("--only="));
  const only = onlyArg ? onlyArg.slice("--only=".length).split(",").map((s) => s.trim()).filter(Boolean) : undefined;

  const project = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || "";
  const emulator = process.env.FIRESTORE_EMULATOR_HOST || "";
  if (!project) {
    console.error(`${TAG} set GCLOUD_PROJECT to the target project (there is no default).`);
    process.exitCode = 1;
    return;
  }

  // Validate before anything else, so a dry run reports bad entries too.
  const problems = validateGuidanceSourceSeeds(GUIDANCE_SOURCE_SEEDS);
  if (problems.length > 0) {
    console.error(`${TAG} invalid seed entries, nothing written:`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exitCode = 1;
    return;
  }

  console.log(
    `${TAG} project ${project}${emulator ? ` (emulator ${emulator})` : ""} — ` +
      (apply ? "APPLY: entries will be written" : "DRY RUN: nothing is written (pass --apply to write)")
  );
  for (const s of GUIDANCE_SOURCE_SEEDS) {
    console.log(`  ${s.id}  ${s.docType}  ${s.verificationStatus}  ${s.url}`);
  }
  if (!apply) {
    console.log(`${TAG} dry run: ${GUIDANCE_SOURCE_SEEDS.length} source(s) would be seeded.`);
    return;
  }

  // Loaded here (not at the top) so a missing GCLOUD_PROJECT fails before
  // Firebase Admin initialises against an unintended default.
  await import("../../../utils/firebase");
  const count = await seedGuidanceSources();
  console.log(`${TAG} seeded ${count} source(s).`);

  if (!crawl) return;
  const { guidanceCrawlService } = await import("../guidance-crawl.service");
  const summary = await guidanceCrawlService.runOrchestrator(only ? { sourceIds: only } : {});
  // Ids, hashes and error messages only: never document text.
  console.log(`${TAG} crawl summary:`);
  console.log(JSON.stringify(summary, null, 2));
}

// Only when run as a script.
if (require.main === module) {
  main().catch((err) => {
    console.error(`${TAG} failed:`, err);
    process.exitCode = 1;
  });
}
