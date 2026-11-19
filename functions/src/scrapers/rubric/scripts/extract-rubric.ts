/**
 * Extract a rubric from a route's guidance snapshots (issue #40).
 *
 * Reads the newest snapshot of each named guidance source, sends it to the
 * model chunk by chunk, validates every proposed criterion in code against
 * the stored text, and writes the result as a NEW `pending_review` version
 * under `visaRubrics/{authorityId}_{routeSlug}/rubricVersions` (for a country:
 * `{countryCode}_{visaTypeId}`). It never
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
 *   # (#233) a bloc or treaty's SHARED layer: the authority id and the shared route id
 *   GCLOUD_PROJECT=<project> node lib/scrapers/rubric/scripts/extract-rubric.js --authority=<authorityId> --slug=<sharedRouteId> --sources=<id>,<id>
 *   #   (or the whole key: --key=<authorityId>_<sharedRouteId>)
 *   # every route whose newest snapshots have no rubric version yet
 *   GCLOUD_PROJECT=<project> node lib/scrapers/rubric/scripts/extract-rubric.js --pending
 * or `npm run extract:rubric -- [flags]`.
 *
 * Flags:
 *   --country=<cc> --visa=<id>   the route (a country's own rulebook)
 *   --authority=<id> --slug=<id> (#233) any authority's rulebook: for a bloc or
 *                                treaty, the shared route id is the slug; the
 *                                shared route must exist, be active and be
 *                                issued by that authority
 *   --key=<authorityId>_<slug>   (#233) the same, as one rulebook key
 *   --sources=<id>,<id>          guidance source ids (first run, or to change them)
 *   --pending                    all stale routes instead of one
 *   --apply                      extract and write (default: plan only)
 *   --force                      write a new version even if the snapshots are unchanged
 *   --job                        (#278) RESUMABLE: draft one route as the background
 *                                job (rubric-extraction-job.ts) and drive it from
 *                                this process until it ends. Every finished model
 *                                call is saved as it completes, so if the run stops
 *                                (a crash, a save failure, Ctrl-C) running the SAME
 *                                command again resumes from the saved steps and pays
 *                                for none of them twice. Without `--job` the run is
 *                                one-shot: it keeps everything in memory, and a
 *                                failure at the end loses what it paid for. Use
 *                                `--job` for large routes. A deployed worker may
 *                                pick the job up too (leases keep it to one worker
 *                                at a time); this command then waits for it.
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
  // (#233) Any authority's rulebook, by its parts or by its whole key.
  const key = flag(args, "key");
  let authorityId = flag(args, "authority");
  let routeSlug = flag(args, "slug");
  if (key) {
    const at = key.indexOf("_");
    if (at <= 0 || authorityId || routeSlug) {
      console.error(`${TAG} --key is <authorityId>_<slug>, and is given instead of --authority / --slug.`);
      process.exitCode = 1;
      return;
    }
    authorityId = key.slice(0, at);
    routeSlug = key.slice(at + 1);
  }
  const general = authorityId !== undefined || routeSlug !== undefined;
  const sourceIds = flag(args, "sources")?.split(",").map((s) => s.trim()).filter(Boolean);

  const project = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || "";
  const emulator = process.env.FIRESTORE_EMULATOR_HOST || "";
  if (!project) {
    console.error(`${TAG} set GCLOUD_PROJECT to the target project (there is no default).`);
    process.exitCode = 1;
    return;
  }
  if (general && (countryCode || visaTypeId)) {
    console.error(`${TAG} name the rulebook by --country/--visa OR by --authority/--slug (or --key), not both.`);
    process.exitCode = 1;
    return;
  }
  if (!pending && (general ? !authorityId || !routeSlug : !countryCode || !visaTypeId)) {
    console.error(`${TAG} give a route (--country=<cc> --visa=<visaTypeId>, or --authority=<id> --slug=<id>, or --key=<authorityId>_<slug>) or --pending.`);
    process.exitCode = 1;
    return;
  }

  console.log(
    `${TAG} project ${project}${emulator ? ` (emulator ${emulator})` : ""} — ` +
      (apply ? "APPLY: the model will be called and a pending version may be written" : "DRY RUN: no model call, nothing written (pass --apply to extract)")
  );

  // (#278) Resumable mode: one route, as a background job driven from here.
  if (args.includes("--job")) {
    if (pending) {
      console.error(`${TAG} --job drafts ONE route; it cannot be combined with --pending.`);
      process.exitCode = 1;
      return;
    }
    const target = general ? { authorityId: authorityId as string, routeSlug: routeSlug as string } : { countryCode: countryCode as string, visaTypeId: visaTypeId as string };
    await runAsJob({ ...target, sourceIds, force, dryRun: !apply });
    return;
  }

  // Loaded here (not at the top) so a missing GCLOUD_PROJECT fails before
  // Firebase Admin initialises against an unintended default.
  const { rubricExtractionService } = await import("../rubric-extraction.service");
  const results = pending
    ? await rubricExtractionService.runPending({ dryRun: !apply })
    : [
      await rubricExtractionService.extractRoute({
        // (#233) Either naming pair; the service checks it (rulebookTargetOf) and refuses bad parts.
        ...(general ? { authorityId: authorityId as string, routeSlug: routeSlug as string } : { countryCode: countryCode as string, visaTypeId: visaTypeId as string }),
        sourceIds,
        force,
        dryRun: !apply,
        trigger: "manual",
      }),
    ];

  if (results.length === 0) console.log(`${TAG} nothing to do: every route's rubric is up to date with its snapshots.`);
  // Ids, counts, hash prefixes and token totals only.
  for (const r of results) console.log(JSON.stringify(r, null, 2));
  if (results.some((r) => r.status === "failed")) process.exitCode = 1;
}

/** Pause between polls while another worker holds the job's lease. */
const WAIT_MS = 15_000;

/**
 * (#278) Start (or resume) the route's drafting job and advance it from this
 * process until it reaches a final status. Safe to interrupt and run again:
 * the job id is derived from the route, its pinned sources, the prompt, the
 * model and the chunk size, so the same command finds the same job, and a
 * stopped one is re-queued with its finished steps kept (`startJob`).
 * Prints ids, counts and codes only.
 */
async function runAsJob(input: { countryCode?: string; visaTypeId?: string; authorityId?: string; routeSlug?: string; sourceIds?: string[]; force: boolean; dryRun: boolean }): Promise<void> {
  const { rubricExtractionJobService } = await import("../rubric-extraction-job");
  const started = await rubricExtractionJobService.startJob({ ...(input as { countryCode: string; visaTypeId: string }), trigger: "manual" });
  console.log(JSON.stringify({ outcome: started.outcome, jobId: started.jobId, jobStatus: started.jobStatus, reasonCode: started.reasonCode, message: started.message, estimate: started.estimate }, null, 2));
  if (!started.jobId || input.dryRun) {
    if (started.outcome === "refused") process.exitCode = 1;
    return;
  }
  const jobId = started.jobId;
  for (;;) {
    const outcome = await rubricExtractionJobService.advance(jobId);
    console.log(`${TAG} job ${jobId}: ${outcome.kind}${"stepsRun" in outcome ? ` (${outcome.stepsRun} step(s) this pass)` : ""}`);
    if (outcome.kind === "finished" || outcome.kind === "idle") break;
    // Another worker holds the lease (e.g. the deployed trigger): wait for it.
    if (outcome.kind === "lease_held" || outcome.kind === "lease_lost") await new Promise((r) => setTimeout(r, WAIT_MS));
  }
  const view = await rubricExtractionJobService.getStatus(jobId);
  console.log(JSON.stringify(view, null, 2));
  if (view && view.status !== "succeeded") process.exitCode = 1;
}

// Only when run as a script.
if (require.main === module) {
  main().catch((err) => {
    console.error(`${TAG} failed: ${(err as Error)?.message ?? String(err)}`);
    process.exitCode = 1;
  });
}
