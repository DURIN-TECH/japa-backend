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
 *  - The target project must be named explicitly with GCLOUD_PROJECT; there
 *    is no default project.
 *  - PROJECT GUARD (guidance-seed-run.ts): writing to a project whose id
 *    does not start with `demo-` is refused unless `--confirm-project=<id>`
 *    repeats that id. The emulators come as a pair (FIRESTORE_EMULATOR_HOST
 *    and FIREBASE_STORAGE_EMULATOR_HOST): one without the other, an emulator
 *    host with a non-demo project id, or a demo project id without the
 *    emulators are all refused before anything is touched.
 *  - An `--only=` id that is not a seed entry is an error.
 *  - `--crawl` (only with `--apply`) then runs the guidance crawl once. That
 *    DOES make network requests (robots.txt + one GET per due source) and
 *    writes snapshot text to the project's default Storage bucket. Add
 *    `--only=<id>,<id>` to crawl just those sources (due or not).
 *  - After a crawl, and on its own with `--check-quotes`, the QUOTE
 *    INTEGRITY CHECK runs (issue #111): every passage in
 *    data/guidance-quote-checks.ts must appear verbatim (whitespace
 *    normalised) in the latest stored snapshot of the entries it names. Any
 *    miss makes the script exit non-zero, and so does a check that checked
 *    nothing. `--check-quotes` alone reads the registry and the stored
 *    snapshots only: no network request, no write.
 *  - After a crawl, every source the run was for must have ended `changed`,
 *    `unchanged` or `not_due` WITH a stored snapshot; a skipped, deferred or
 *    failed source makes the script exit non-zero.
 *
 * Run (from functions/):
 *   npm run build
 *   GCLOUD_PROJECT=<project> node lib/scrapers/guidance/scripts/seed-guidance-sources.js           # dry run
 *   GCLOUD_PROJECT=<project> node lib/scrapers/guidance/scripts/seed-guidance-sources.js --apply --confirm-project=<project>
 *   GCLOUD_PROJECT=<project> node lib/scrapers/guidance/scripts/seed-guidance-sources.js --apply --crawl --only=<id> --confirm-project=<project>
 *   GCLOUD_PROJECT=<project> node lib/scrapers/guidance/scripts/seed-guidance-sources.js --check-quotes
 * (`--confirm-project` is not needed, and not accepted with another id, on a
 * `demo-*` project against the emulators.)
 * or `npm run seed:guidance-sources -- [--apply] [--crawl] [--only=...] [--check-quotes] [--confirm-project=<id>]`.
 */
import type { PdfExtraction } from "../../shared/fetch/pdf-text";
import { GUIDANCE_QUOTE_CHECKS } from "../data/guidance-quote-checks";
import { GUIDANCE_SOURCE_SEEDS, seedGuidanceSources, validateGuidanceSourceSeeds } from "../data/seed-guidance-sources";
import { failedQuoteResults, quoteCheckFailure, runQuoteChecks, validateQuoteChecks } from "../guidance-quote-check";
import { crawlTargetProblems, projectGuardProblems, unknownSourceIds } from "../guidance-seed-run";

/** Tag every line this script prints. */
const TAG = "[seed-guidance-sources]";

/**
 * Print where every seeded source stands after a run: one JSON line each,
 * with the stored crawl state and the size of its newest snapshot. Fields
 * and numbers only: never document text.
 *
 * @returns each source's `latestSnapshotId` (null when it has none, or when
 *   the registry has no such entry), for the "did the crawl do its job" check
 */
async function printRegistryState(sourceIds: readonly string[]): Promise<Map<string, string | null>> {
  const latest = new Map<string, string | null>();
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
      latest.set(id, null);
      continue;
    }
    const d = doc.data() as Record<string, unknown>;
    const hash = typeof d.latestSnapshotId === "string" && d.latestSnapshotId ? d.latestSnapshotId : null;
    latest.set(id, hash);
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
            // How the text was obtained; "ocr" / "mixed" = lower confidence.
            extractionMethod: (meta.extraction as PdfExtraction | null | undefined)?.method ?? null,
            ocrMeanConfidence: (meta.extraction as PdfExtraction | null | undefined)?.ocr?.meanConfidence ?? null,
            httpStatus: meta.httpStatus,
            fetchedAt: iso(meta.fetchedAt),
          }
          : null,
      })}`
    );
  }
  return latest;
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
    if (r.found && r.needsHumanReview) {
      // OCR-derived text: present, but not a confirmation (issue #38).
      console.error(
        `  OCR-ONLY ${r.sourceId}${hash}${where}  [${r.label}] ${r.checkId}: matched in OCR text (${r.ocrEngine}, confidence ${r.ocrConfidence}); human review required`
      );
    } else if (r.found) {
      console.log(`  FOUND    ${r.sourceId}${hash}${where}  [${r.label}] ${r.checkId}`);
    } else {
      console.error(`  MISSING  ${r.sourceId}${hash}  [${r.label}] ${r.checkId}: ${r.problem}${r.detail ? ` (${r.detail})` : ""}`);
    }
  }
  const failed = failedQuoteResults(results);
  const failure = quoteCheckFailure(results);
  if (failure) {
    // Includes the "checked nothing" case: zero pairs is a failure, not a pass.
    // The passage is OUR data (already in the repo), so printing it is fine;
    // the document's text is never printed.
    console.error(`${TAG} quote integrity check FAILED: ${failure}.${failed.length > 0 ? " Passages looked for:" : ""}`);
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

  // `--confirm-project=<id>`: the second naming of a real project (see the guard).
  const confirmArg = args.find((a) => a.startsWith("--confirm-project="));
  const confirmProject = confirmArg ? confirmArg.slice("--confirm-project=".length) : undefined;

  // ---- Project guard: decided before anything is loaded or touched ----
  const firestoreEmulator = process.env.FIRESTORE_EMULATOR_HOST || "";
  const storageEmulator = process.env.FIREBASE_STORAGE_EMULATOR_HOST || "";
  const guard = projectGuardProblems({
    gcloudProject: process.env.GCLOUD_PROJECT,
    googleCloudProject: process.env.GOOGLE_CLOUD_PROJECT,
    firestoreEmulatorHost: firestoreEmulator,
    storageEmulatorHost: storageEmulator,
    confirmProject,
    writes: apply,
  });
  if (!guard.target) {
    console.error(`${TAG} refusing to run, nothing was read or written:`);
    for (const p of guard.problems) console.error(`  - ${p}`);
    process.exitCode = 1;
    return;
  }
  const project = guard.target.projectId;

  // An `--only=` id that is not a seed entry is a typo: stop, rather than
  // crawl nothing and report a clean run.
  const seedIds = GUIDANCE_SOURCE_SEEDS.map((s) => s.id);
  const unknown = unknownSourceIds(only, seedIds);
  if (unknown.length > 0 || (only && only.length === 0)) {
    console.error(
      `${TAG} --only names ${unknown.length > 0 ? `source(s) that are not in the seed: ${unknown.join(", ")}` : "no source"}. ` +
        `Seed ids: ${seedIds.join(", ")}`
    );
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

  // The banner names BOTH stores, so it is plain where a run will land.
  const where = guard.target.emulated
    ? `EMULATORS: Firestore ${firestoreEmulator}, Storage ${storageEmulator}`
    : "REAL PROJECT: Firestore and Storage of this project (no emulator)";
  console.log(
    `${TAG} project ${project} (${where}) — ` +
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
  const targetIds = only ?? seedIds;
  const latest = await printRegistryState(targetIds);

  // A seed whose sources could not all be fetched has not done its job: say
  // so in the exit code. Every source the run was FOR must have ended
  // changed / unchanged / not_due AND have a stored snapshot; skipped
  // (unverified, paused, failing), deferred, failed, dropped after an
  // unexpected error and never-fetched all count against the run.
  const incomplete = crawlTargetProblems(summary, targetIds, latest);
  if (incomplete.length > 0) {
    console.error(`${TAG} crawl incomplete for ${incomplete.length} of ${targetIds.length} targeted source(s):`);
    for (const p of incomplete) console.error(`  - ${p}`);
    process.exitCode = 1;
  }
  if (summary.infraErrors > 0) process.exitCode = 1;
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
