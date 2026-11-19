/**
 * Run the AUTOMATIC PUBLISH pipeline on an existing pending rulebook version
 * (issue #201): the same gates and the same approval transaction as the
 * Firestore trigger and `POST /admin/rubrics/:id/auto-publish`, from the shell.
 * This is how the pending draft already on dev is published without a new
 * extraction.
 *
 * SAFETY
 *  - The target project must be named EXPLICITLY with `--project` (there is no
 *    default: this machine's gcloud default is production).
 *  - The production project (`japa-platform`) is refused unless
 *    `--allow-production` is also passed.
 *  - `--dry-run` writes nothing and prints what it would do.
 *  - `--skip-checker` prints every result code can decide and states that the
 *    independent check has NOT run. It never publishes (publishing without the
 *    check would defeat it), so it behaves as a dry run.
 *  - It runs whatever `appConfig/rubricPublishSettings.mode` says (an explicit
 *    action) but every gate still applies, so with the independent check and the
 *    question plan not yet built (parts B and C) a real run HOLDS the draft.
 *  - Never prints source text: ids, counts, reason codes and titles only.
 *
 * Run (from functions/):
 *   npm run publish:rubric -- --project <id> --route <routeKey> --version <n> [--dry-run] [--skip-checker] [--allow-production]
 * (#233) `<routeKey>` is any rulebook key: `{countryCode}_{visaTypeId}` for a
 * country, or `{authorityId}_{sharedRouteId}` for a bloc / treaty's shared
 * layer. Every gate is the same for both.
 * (also accepts `--flag=value`).
 */

// Makes this file a module (no static import: the service is loaded inside main).
export {};

/** Tag every line this script prints. */
const TAG = "[publish-rubric]";
/** The production project id: refused without --allow-production. */
const PRODUCTION_PROJECT = "japa-platform";

/** Value of `--name value` or `--name=value`, or undefined. */
function flag(args: string[], name: string): string | undefined {
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3).trim();
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length && !args[i + 1].startsWith("--") ? args[i + 1].trim() : undefined;
}

/** Print an object's entries as `key: value` lines under a heading. */
function section(title: string, lines: string[]): void {
  console.log(`\n${title}`);
  if (lines.length === 0) console.log("  (none)");
  for (const l of lines) console.log(`  ${l}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const project = flag(args, "project") ?? "";
  const route = flag(args, "route") ?? "";
  const versionText = flag(args, "version") ?? "";
  const dryRun = args.includes("--dry-run");
  const skipChecker = args.includes("--skip-checker");

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
  const version = Number(versionText);
  if (!route || !Number.isInteger(version) || version < 1) {
    console.error(`${TAG} give --route <routeKey> and --version <n>.`);
    process.exitCode = 1;
    return;
  }

  // Set BEFORE Firebase Admin loads, so it can never initialise against an unintended default.
  process.env.GCLOUD_PROJECT = project;
  process.env.GOOGLE_CLOUD_PROJECT = project;
  const emulator = process.env.FIRESTORE_EMULATOR_HOST || "";
  console.log(
    `${TAG} project ${project}${emulator ? ` (emulator ${emulator})` : ""}, ${route} v${version} - ` +
      (dryRun || skipChecker ? "REPORT ONLY: nothing is written or published" : "APPLY: the draft is published if every gate passes, else held")
  );

  // Loaded here so the checks above fail before Firebase initialises.
  const { rubricAutoPublishService } = await import("../../../services/rubric-auto-publish.service");
  const { rubricVersionId } = await import("../../../services/rubric-review.service");
  const { checkerStatusLine } = await import("../rubric-gates");
  const report = await rubricAutoPublishService.runOnDraft(rubricVersionId(route, version), { dryRun, skipChecker, trigger: "script" });

  // ---- the report (the same fields the admin endpoint returns) ----
  console.log(`\n${TAG} outcome: ${report.outcome}${report.dryRun ? " (report only)" : ""}`);
  console.log(`${TAG} code gates passed: ${report.codeGatesPassed ? "yes" : "no"}`);
  // (#223) Say what really happened. "failed" means the check RAN and did not confirm the draft (or could
  // not finish): calling that "has NOT run" sent people looking for a missing key when the check had run.
  const checkerLine = checkerStatusLine(report.checker, skipChecker, report.questionPlan);
  if (checkerLine) console.log(`${TAG} ${checkerLine}`);
  if (report.checkerRequests) console.log(`${TAG} check requests: ${report.checkerRequests.total} (of which ${report.checkerRequests.repair} for repairs).`);
  // (#223) Protected rules (bars on a named group) the check did not confirm, with the one automatic repair.
  section(
    "Protected rules not confirmed",
    (report.protectedFailures ?? []).map((f) => `${f.criterionId}${f.ruleRef ? ` [${f.ruleRef}]` : ""} "${f.title}": failed ${f.failedAspects.join(", ") || "(trigger)"}; repair ${f.repair.status}${f.repair.detail ? ` (${f.repair.detail})` : ""}${f.repair.replacementFailedAspects && f.repair.replacementFailedAspects.length > 0 ? `; replacement still failed ${f.repair.replacementFailedAspects.join(", ")}` : ""}`)
  );
  section("Reasons", report.reasonCodes.map((c, i) => `${c}: ${report.reasons[i]}`));
  section("Gates", report.gates.map((g) => `${g.passed ? "pass" : "FAIL"}  ${g.gate}${g.detail ? ` (${g.detail})` : ""}`));
  const c = report.counts;
  section("Counts", [
    `rules ${c.rules}, kept ${c.kept}, left out ${c.leftOut}, held ${c.held}`,
    ...Object.entries(c.leftOutByReason).map(([k, n]) => `left out by ${k}: ${n}`),
    // (#240) The check's leave-outs: found wrong (a `no`) vs not confirmed (only unsure / na).
    `check leave-outs: ${c.leftOutFoundWrong ?? 0} found wrong, ${c.leftOutNotConfirmed ?? 0} not confirmed`,
    ...Object.entries(c.informationalFlags).map(([k, n]) => `informational ${k}: ${n}`),
  ]);
  section("Planned leave-outs", report.leftOut.map((l) => `${l.criterionId}  ${l.reason}`));
  if (report.auditId) console.log(`\n${TAG} published: audit entry ${report.auditId}, replaced version ${report.previousApprovedVersion ?? "none"}.`);
}

main().catch((err) => {
  // The message only: never a stack that could carry a path or a document.
  console.error(`${TAG} failed: ${(err as Error)?.message ?? err}`);
  process.exitCode = 1;
});
