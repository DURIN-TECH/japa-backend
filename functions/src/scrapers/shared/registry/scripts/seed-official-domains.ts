/**
 * One-off import of the built-in official hosts into `officialDomains`
 * (issue #215). See official-domains-seed.ts for the rules.
 *
 * SAFETY
 *  - DRY RUN BY DEFAULT: prints what would be created and writes nothing.
 *    `--apply` writes.
 *  - The target project must be named with GCLOUD_PROJECT (no default).
 *  - A project whose id does not start with `demo-` is refused unless
 *    `--confirm-project=<id>` repeats that id; a `demo-` project is refused
 *    unless FIRESTORE_EMULATOR_HOST is set (there is no such real project).
 *  - Idempotent; never changes a host that already has a doc.
 *
 * Run (from functions/):
 *   GCLOUD_PROJECT=<project> npm run seed:official-domains
 *   GCLOUD_PROJECT=<project> npm run seed:official-domains -- --apply --confirm-project=<project>
 */
import { projectGuardProblems } from "../official-domains-seed-guard";
import { importOfficialDomains } from "../official-domains-seed";

const TAG = "[seed-official-domains]";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const confirm = args.find((a) => a.startsWith("--confirm-project="))?.slice("--confirm-project=".length);
  const problems = projectGuardProblems({
    gcloudProject: process.env.GCLOUD_PROJECT,
    firestoreEmulatorHost: process.env.FIRESTORE_EMULATOR_HOST,
    confirmProject: confirm,
    writes: apply,
  });
  if (problems.length > 0) {
    for (const p of problems) console.error(`${TAG} refused: ${p}`);
    process.exit(1);
  }
  const result = await importOfficialDomains({ apply });
  console.log(`${TAG} ${apply ? "created" : "would create"}: ${result.created.join(", ") || "(none)"}`);
  console.log(`${TAG} already present: ${result.existing.join(", ") || "(none)"}`);
  for (const s of result.skipped) console.log(`${TAG} skipped ${s.entry}: ${s.reason}`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(`${TAG} failed:`, err);
    process.exit(1);
  }
);
