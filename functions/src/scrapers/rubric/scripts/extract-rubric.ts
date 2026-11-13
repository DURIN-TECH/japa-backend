/**
 * Extract a rubric from a route's guidance snapshots (issue #40).
 *
 * Reads the newest snapshot of each named guidance source, sends it to the
 * model chunk by chunk, validates every proposed criterion in code against
 * the stored text, and writes the result as a NEW `pending_review` version
 * under `visaRubrics/{countryCode}_{visaTypeId}/rubricVersions`. It never
 * approves anything: review is a separate step.
 *
 * SAFETY
 *  - DRY RUN BY DEFAULT: reads the sources, prints the plan (how many chunks,
 *    how many characters), calls no model and writes nothing. Pass `--apply`
 *    to extract.
 *  - The target project must be named explicitly with GCLOUD_PROJECT (or an
 *    emulator via FIRESTORE_EMULATOR_HOST); there is no default project.
 *  - `--apply` makes model calls, which cost money, and needs
 *    ANTHROPIC_API_KEY (functions/.env.local for a local run).
 *  - Never prints document text: ids, counts and hash prefixes only.
 *
 * Run (from functions/):
 *   npm run build
 *   # one route (the sources are remembered on the route after the first run)
 *   GCLOUD_PROJECT=<project> node lib/scrapers/rubric/scripts/extract-rubric.js --country=<cc> --visa=<visaTypeId> --sources=<id>,<id>
 *   GCLOUD_PROJECT=<project> node --env-file-if-exists=.env.local lib/scrapers/rubric/scripts/extract-rubric.js --country=<cc> --visa=<visaTypeId> --apply
 *   # every route whose newest snapshots have no rubric version yet
 *   GCLOUD_PROJECT=<project> node lib/scrapers/rubric/scripts/extract-rubric.js --pending
 * or `npm run extract:rubric -- [flags]`.
 *
 * Flags:
 *   --country=<cc> --visa=<id>   the route
 *   --sources=<id>,<id>          guidance source ids (first run, or to change them)
 *   --pending                    all stale routes instead of one
 *   --apply                      extract and write (default: plan only)
 *   --force                      write a new version even if the snapshots are unchanged
 */

// Makes this file a module (it has no static import: the service is loaded
// inside main), so its `main` does not collide with other scripts' globals.
export {};

/** Tag every line this script prints. */
const TAG = "[extract-rubric]";

/** Value of a `--name=value` flag, or undefined. */
function flag(args: string[], name: string): string | undefined {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3).trim() : undefined;
}

/** Run the extraction: plan only unless `--apply`. */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const force = args.includes("--force");
  const pending = args.includes("--pending");
  const countryCode = flag(args, "country");
  const visaTypeId = flag(args, "visa");
  const sourceIds = flag(args, "sources")?.split(",").map((s) => s.trim()).filter(Boolean);

  const project = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || "";
  const emulator = process.env.FIRESTORE_EMULATOR_HOST || "";
  if (!project) {
    console.error(`${TAG} set GCLOUD_PROJECT to the target project (there is no default).`);
    process.exitCode = 1;
    return;
  }
  if (!pending && (!countryCode || !visaTypeId)) {
    console.error(`${TAG} give a route (--country=<cc> --visa=<visaTypeId>) or --pending.`);
    process.exitCode = 1;
    return;
  }

  console.log(
    `${TAG} project ${project}${emulator ? ` (emulator ${emulator})` : ""} — ` +
      (apply ? "APPLY: the model will be called and a pending version may be written" : "DRY RUN: no model call, nothing written (pass --apply to extract)")
  );

  // Loaded here (not at the top) so a missing GCLOUD_PROJECT fails before
  // Firebase Admin initialises against an unintended default.
  const { rubricExtractionService } = await import("../rubric-extraction.service");
  const results = pending
    ? await rubricExtractionService.runPending({ dryRun: !apply })
    : [await rubricExtractionService.extractRoute({ countryCode: countryCode as string, visaTypeId: visaTypeId as string, sourceIds, force, dryRun: !apply, trigger: "manual" })];

  if (results.length === 0) console.log(`${TAG} nothing to do: every route's rubric is up to date with its snapshots.`);
  // Ids, counts, hash prefixes and token totals only.
  for (const r of results) console.log(JSON.stringify(r, null, 2));
  if (results.some((r) => r.status === "failed")) process.exitCode = 1;
}

// Only when run as a script.
if (require.main === module) {
  main().catch((err) => {
    console.error(`${TAG} failed: ${(err as Error)?.message ?? String(err)}`);
    process.exitCode = 1;
  });
}
