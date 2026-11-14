/**
 * One-off migration (issue #239, P10 of #228): bring DEV data in line with the
 * shared-visa model. See `shared-visa-model/migrate.ts` for what it does, step
 * by step.
 *
 * DRY RUN BY DEFAULT; `--apply` writes. A second apply changes nothing.
 * ALWAYS NAME THE PROJECT: `--project <id>` is required, and the run is refused
 * for production (`japa-platform`), for any project that is not `durin-seli-dev`
 * or an emulator project (`demo-...`), and when no project is named. The
 * machine's default project is never used (see shared-visa-model/project-guard.ts).
 *
 * Run (after `npm run build`, from `functions/`):
 *   node lib/scripts/migrate-shared-visa-model.js --project durin-seli-dev            # dry run
 *   node lib/scripts/migrate-shared-visa-model.js --project durin-seli-dev --apply    # write
 * Emulator rehearsal: set FIRESTORE_EMULATOR_HOST and use `--project demo-rehearsal`.
 *
 * Against a real project authenticate with a service account key that has
 * Firestore access (same as seed-all); Application Default Credentials of a
 * personal account also work for Firestore.
 *
 * IMPORTANT: this file imports NO Firebase module at the top. The guard runs
 * first, then the project is pinned in the environment, and only then is the
 * runner (which loads the Admin SDK) imported.
 */
import { checkMigrationProject, parseMigrationArgs } from "./shared-visa-model/project-guard";

async function main(): Promise<void> {
  const args = parseMigrationArgs(process.argv.slice(2));

  // ---- Guard FIRST: nothing below runs for a refused project ----
  const check = checkMigrationProject(args.project, process.env);
  if (!check.ok) {
    console.error(`\nRefused: ${check.message}\n`);
    process.exit(2);
  }

  // ---- Pin the project for the Admin SDK (utils/firebase reads these at import) ----
  process.env.GCLOUD_PROJECT = check.project;
  process.env.GOOGLE_CLOUD_PROJECT = check.project;
  process.env.FIREBASE_STORAGE_BUCKET = `${check.project}.firebasestorage.app`;
  console.log(`Project: ${check.project}${process.env.FIRESTORE_EMULATOR_HOST ? ` (emulator ${process.env.FIRESTORE_EMULATOR_HOST})` : ""}`);

  // ---- Load the data file (validated: a bad file stops the run before any read) ----
  const { loadSharedVisaData } = await import("../data/shared-visa-data-format");
  const data = loadSharedVisaData();

  await import("../utils/firebase");
  const { runSharedVisaMigration } = await import("./shared-visa-model/migrate");
  await runSharedVisaMigration({ dryRun: args.dryRun, data });
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error("Shared-visa migration failed:", error);
      process.exit(1);
    });
}
