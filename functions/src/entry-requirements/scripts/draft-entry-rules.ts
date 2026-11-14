/**
 * Draft ONE issuing authority's entry rules ("do you need a visa at all",
 * issue #236) from its registered official pages, run the independent check
 * and the automatic safeguards, and publish or hold the result.
 *
 * WHAT MUST EXIST FIRST
 *  - The authority: a two-letter country code (no doc needed), or a bloc /
 *    treaty in `authorities/{id}` (status active) with its members recorded.
 *  - Its official website confirmed for it (`officialDomains/{host}`, #215).
 *  - The pages registered as guidance sources of that authority
 *    (`guidanceSources/{id}` with `jurisdiction` = the authority id, status
 *    active) and crawled at least once (a stored snapshot).
 *  - For an automatic publish: `appConfig/rubricPublishSettings.mode` = "auto",
 *    and, when a route allowlist is set, `{authorityId}_entry-requirements` on it.
 *    Otherwise the run is HELD (stored for the admin, never served).
 *
 * SAFETY
 *  - The target project must be named with `--project` (no default: this
 *    machine's gcloud default is production); `japa-platform` (production) is
 *    refused unless `--allow-production` is also passed.
 *  - `--dry-run` makes the model calls (paid) but writes nothing.
 *  - Spend is bounded by the rulebook settings (requests, input characters,
 *    runs per day, kill switch); over a cap the run stops before spending.
 *  - Prints ids, counts and reason codes only, never page text.
 *
 * Run (from functions/):
 *   npm run draft:entry-rules -- --project <id> --authority <id> --sources <sourceId,...> [--dry-run] [--allow-production]
 * (also accepts `--flag=value`).
 */
export {};

/** Tag every line this script prints. */
const TAG = "[draft-entry-rules]";
/** The production project id: refused without --allow-production. */
const PRODUCTION_PROJECT = "japa-platform";

/** Value of `--name value` or `--name=value`, or undefined. */
function flag(args: string[], name: string): string | undefined {
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3).trim();
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length && !args[i + 1].startsWith("--") ? args[i + 1].trim() : undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const project = flag(args, "project") ?? "";
  const authorityId = flag(args, "authority") ?? "";
  const sourceIds = (flag(args, "sources") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const dryRun = args.includes("--dry-run");

  // ---- the project must be explicit, and never production by accident ----
  if (!project) {
    console.error(`${TAG} name the target project with --project <id> (there is no default).`);
    process.exitCode = 1;
    return;
  }
  const envProject = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || "";
  if (envProject && envProject !== project) {
    console.error(`${TAG} --project ${project} disagrees with GCLOUD_PROJECT ${envProject}; refusing.`);
    process.exitCode = 1;
    return;
  }
  if (project === PRODUCTION_PROJECT && !args.includes("--allow-production")) {
    console.error(`${TAG} ${PRODUCTION_PROJECT} is production: pass --allow-production to run against it.`);
    process.exitCode = 1;
    return;
  }
  if (!authorityId || sourceIds.length === 0) {
    console.error(`${TAG} give --authority <id> and --sources <sourceId,...>.`);
    process.exitCode = 1;
    return;
  }
  // Set BEFORE Firebase Admin loads, so it can never initialise against an unintended default.
  process.env.GCLOUD_PROJECT = project;
  process.env.GOOGLE_CLOUD_PROJECT = project;
  console.log(`${TAG} project ${project}, authority ${authorityId}, ${sourceIds.length} source(s) - ${dryRun ? "DRY RUN: nothing is written" : "APPLY: published if every safeguard passes, else held"}`);

  // Loaded here so the checks above fail before Firebase initialises.
  const { runEntryRuleDrafting } = await import("../entry-rule-pipeline");
  const { run } = await runEntryRuleDrafting({ authorityId, sourceIds, dryRun, trigger: "script" });

  console.log(`\n${TAG} run ${run.id}: ${run.status}`);
  for (const r of run.reasons) console.log(`  reason: ${r}`);
  for (const g of run.gates) console.log(`  ${g.passed ? "pass" : "FAIL"}  ${g.gate}${g.detail ? ` (${g.detail})` : ""}`);
  const c = run.counts;
  console.log(`  drafted ${c.drafted}, refused by code ${c.refused}, kept ${c.kept}, left out by the check ${c.leftOut}, list lines ${c.listLines}, uncoded names ${c.uncodedNames}`);
  const refusedBy: Record<string, number> = {};
  for (const r of run.refusals) refusedBy[r.reason] = (refusedBy[r.reason] ?? 0) + 1;
  for (const [reason, n] of Object.entries(refusedBy)) console.log(`  refused ${reason}: ${n}`);
  console.log(`  requests: drafting ${run.requests.drafting}, coding ${run.requests.coding}, check ${run.requests.check}; tokens in ${run.inputTokens}, out ${run.outputTokens}`);
  console.log(`  prompt ${run.promptVersion}, check ${run.checkPromptVersion}`);
  if (run.status === "failed") process.exitCode = 1;
}

main().catch((err) => {
  console.error(`${TAG} failed:`, err instanceof Error ? err.name : "unknown error");
  process.exitCode = 1;
});
