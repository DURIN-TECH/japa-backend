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
 *  - After a crawl, and on its own with `--check-quotes`, the QUOTE
 *    INTEGRITY CHECK runs (issue #111): every passage in
 *    data/guidance-quote-checks.ts must appear verbatim (whitespace
 *    normalised) in the latest stored snapshot of the entries it names. Any
 *    miss makes the script exit non-zero. `--check-quotes` alone reads the
 *    registry and the stored snapshots only: no network request, no write.
 *
 * Run (from functions/):
 *   npm run build
 *   GCLOUD_PROJECT=<project> node lib/scrapers/guidance/scripts/seed-guidance-sources.js           # dry run
 *   GCLOUD_PROJECT=<project> node lib/scrapers/guidance/scripts/seed-guidance-sources.js --apply   # write
 *   GCLOUD_PROJECT=<project> node lib/scrapers/guidance/scripts/seed-guidance-sources.js --apply --crawl --only=<id>
 *   GCLOUD_PROJECT=<project> node lib/scrapers/guidance/scripts/seed-guidance-sources.js --check-quotes
 * or `npm run seed:guidance-sources -- [--apply] [--crawl] [--only=...] [--check-quotes]`.
 */
import { GUIDANCE_QUOTE_CHECKS } from "../data/guidance-quote-checks";
import { GUIDANCE_SOURCE_SEEDS, seedGuidanceSources, validateGuidanceSourceSeeds } from "../data/seed-guidance-sources";
import { failedQuoteResults, runQuoteChecks, validateQuoteChecks } from "../guidance-quote-check";

/** Tag every line this script prints. */
const TAG = "[seed-guidance-sources]";

/**
 * Print where every seeded source stands after a run: one JSON line each,
 * with the stored crawl state and the size of its newest snapshot. Fields
 * and numbers only: never document text.
 */
async function printRegistryState(sourceIds: readonly string[]): Promise<void> {
  const { collections, subcollections } = await import("../../../utils/firebase");
  /** Firestore Timestamp -> ISO string, or null. */
  const iso = (v: unknown): string | null => {
    const ts = v as { toDate?: () => Date } | null | undefined;
    return ts && typeof ts.toDate === "function" ? ts.toDate().toISOString() : null;
  };
  console.log(`${TAG} registry state:`);
  for (const id of sourceIds) {
    const doc = await collections.guidanceSources.doc(id).get();
    if (!doc.exists) {
      console.log(`  ${JSON.stringify({ id, missing: true })}`);
      continue;
    }
    const d = doc.data() as Record<string, unknown>;
    const hash = typeof d.latestSnapshotId === "string" ? d.latestSnapshotId : null;
    const all = await subcollections.guidanceSnapshots(id).get();
    const meta = hash ? (all.docs.find((s) => s.id === hash)?.data() as Record<string, unknown> | undefined) : undefined;
    console.log(
      `  ${JSON.stringify({
        id,
        status: d.status ?? null,
        verificationStatus: d.verificationStatus ?? null,
        url: d.url ?? null,
        resolvedUrl: d.resolvedUrl ?? null,
        finalUrl: d.finalUrl ?? null,
        lastFetchedAt: iso(d.lastFetchedAt),
        lastContentHash: d.lastContentHash ?? null,
        publishedDate: d.publishedDate ?? null,
        publishedDateText: d.publishedDateText ?? null,
        lastErrorKind: d.lastErrorKind ?? null,
        snapshotCount: all.size,
        latestSnapshot: meta
          ? {
              charCount: meta.charCount,
              byteLength: meta.byteLength,
              pageCount: meta.pageCount,
              pagesWithoutText: meta.pagesWithoutText,
              sourceByteLength: meta.sourceByteLength,
              httpStatus: meta.httpStatus,
              fetchedAt: iso(meta.fetchedAt),
            }
          : null,
      })}`
    );
  }
}

/**
 * Run the quote integrity check against the stored snapshots and print one
 * line per (passage, source). Returns true when every passage was found.
 *
 * @param only when given, only these sources are checked (a partial crawl)
 */
async function checkQuotes(only?: readonly string[]): Promise<boolean> {
  const { collections } = await import("../../../utils/firebase");
  const { guidanceSnapshotStore } = await import("../guidance-snapshot.store");
  const results = await runQuoteChecks(
    GUIDANCE_QUOTE_CHECKS,
    {
      // The newest snapshot is the one the registry entry points at.
      latestSnapshotId: async (sourceId) => {
        const doc = await collections.guidanceSources.doc(sourceId).get();
        const id = doc.exists ? (doc.data() as { latestSnapshotId?: unknown }).latestSnapshotId : null;
        return typeof id === "string" && id ? id : null;
      },
      readSnapshot: (sourceId, contentHash) => guidanceSnapshotStore.read(sourceId, contentHash),
    },
    only
  );
  console.log(`${TAG} quote integrity check: ${results.length} passage/source pair(s)`);
  for (const r of results) {
    const where = r.page ? ` page ${r.page}${r.endPage && r.endPage !== r.page ? `-${r.endPage}` : ""}` : "";
    const hash = r.contentHash ? ` snapshot ${r.contentHash.slice(0, 12)}` : "";
    if (r.found) {
      console.log(`  FOUND    ${r.sourceId}${hash}${where}  [${r.label}] ${r.checkId}`);
    } else {
      console.error(`  MISSING  ${r.sourceId}${hash}  [${r.label}] ${r.checkId}: ${r.problem}${r.detail ? ` (${r.detail})` : ""}`);
    }
  }
  const failed = failedQuoteResults(results);
  if (failed.length > 0) {
    // The passage is OUR data (already in the repo), so printing it is fine;
    // the document's text is never printed.
    console.error(`${TAG} quote integrity check FAILED: ${failed.length} of ${results.length} not confirmed. Passages looked for:`);
    for (const id of new Set(failed.map((f) => f.checkId))) {
      const check = GUIDANCE_QUOTE_CHECKS.find((c) => c.id === id);
      if (check) console.error(`  ${id}: ${JSON.stringify(check.passage)}`);
    }
    return false;
  }
  console.log(`${TAG} quote integrity check passed: ${results.length} of ${results.length} found verbatim.`);
  return true;
}

/** Run the seed: dry run unless `--apply`. */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const crawl = args.includes("--crawl");
  // Check stored snapshots only (also runs automatically after `--crawl`).
  const quotesOnly = args.includes("--check-quotes");
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
  // The passages are data too: a check naming an entry that is not in the
  // seed would pass by checking nothing.
  problems.push(...validateQuoteChecks(GUIDANCE_QUOTE_CHECKS, GUIDANCE_SOURCE_SEEDS.map((s) => s.id)).map((p) => `quote check ${p}`));
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
    // `--check-quotes` without `--apply`: read-only look at what is stored.
    if (quotesOnly) {
      await import("../../../utils/firebase");
      if (!(await checkQuotes(only))) process.exitCode = 1;
    }
    return;
  }

  // Loaded here (not at the top) so a missing GCLOUD_PROJECT fails before
  // Firebase Admin initialises against an unintended default.
  await import("../../../utils/firebase");
  const count = await seedGuidanceSources();
  console.log(`${TAG} seeded ${count} source(s).`);

  if (!crawl) {
    if (quotesOnly && !(await checkQuotes(only))) process.exitCode = 1;
    return;
  }
  const { guidanceCrawlService } = await import("../guidance-crawl.service");
  const summary = await guidanceCrawlService.runOrchestrator(only ? { sourceIds: only } : {});
  // Ids, hashes and error messages only: never document text.
  console.log(`${TAG} crawl summary:`);
  console.log(JSON.stringify(summary, null, 2));
  await printRegistryState(only ?? GUIDANCE_SOURCE_SEEDS.map((s) => s.id));

  // A seed whose sources could not all be fetched has not done its job: say
  // so in the exit code (the summary above says which and why).
  if (summary.failed > 0 || summary.infraErrors > 0 || summary.deferred > 0) {
    console.error(`${TAG} crawl incomplete: ${summary.failed} failed, ${summary.infraErrors} infrastructure error(s), ${summary.deferred} deferred.`);
    process.exitCode = 1;
  }
  // Quote integrity (issue #111): the stored text must contain the passages
  // a human read in the published documents. A miss fails the seed.
  if (!(await checkQuotes(only))) process.exitCode = 1;
}

// Only when run as a script.
if (require.main === module) {
  main().catch((err) => {
    console.error(`${TAG} failed:`, err);
    process.exitCode = 1;
  });
}
