/**
 * One-time migration (issue #99): bring legacy `source: "agent"` visas in
 * line with the ownership + visibility model.
 *
 * Background: before #99, `POST /countries/:code/visas` (admin-only) wrote
 * visas with `source: "agent"`, `reviewStatus: "pending_review"` and
 * `isActive: true`, so an unreviewed visa showed up in every public read.
 * Those docs have no owning agency. Default agreed in grooming (change only
 * if the user decides otherwise — open decision tracked on the epic):
 * they are treated as ADMIN-CREATED, so
 *  - approved ones (already live)        → `visibility: "global"` (stay live);
 *  - pending_review / rejected ones      → `isActive: false`,
 *                                          `visibility: "agency"`, no owner
 *                                          (admin-only until reviewed).
 * Docs of any other source (seed, scraped, agency) are never touched.
 *
 * Only the fields that differ are written, so the script is IDEMPOTENT: a
 * second run plans (and writes) nothing. After a real run, the country stats
 * of every country it changed are recomputed (visaService.updateCountryStats),
 * so a deactivated visa leaves the counts at once.
 *
 * DRY RUN BY DEFAULT: without `--apply` it only reads and prints counts plus
 * the planned change per doc. `--dry-run` is accepted too (explicit no-op
 * flag); if both are given, dry run wins.
 *
 * Run (after `npm run build`):
 *   node lib/scripts/backfill-visa-ownership.js            # dry run
 *   node lib/scripts/backfill-visa-ownership.js --apply    # write
 * Emulator: set FIRESTORE_EMULATOR_HOST (and GCLOUD_PROJECT=demo-…). A real
 * project is selected the same way as the other scripts, e.g.
 * `npm run backfill:visas:dev` (GCLOUD_PROJECT=durin-seli-dev, still dry run
 * unless `-- --apply` is appended).
 */
import { collections, serverTimestamp, subcollections } from "../utils/firebase";
import { visaService } from "../services/visa.service";
import { VISA_VISIBILITY, VisaType } from "../types";

// ============================================
// Planning (pure)
// ============================================

/**
 * Fields the backfill may write on one legacy visa. Only the keys that must
 * change are present; an empty object means "already migrated".
 */
export type VisaOwnershipUpdate = Partial<Pick<VisaType, "isActive" | "visibility">>;

/** What the backfill does to one doc, by outcome (for the counts). */
export type VisaOwnershipOutcome =
  | "skipped_not_agent" // not `source: "agent"`: never touched
  | "made_global" // approved legacy visa → visibility "global"
  | "hidden" // pending / rejected legacy visa → inactive + agency-only
  | "unchanged"; // legacy visa already in its target state

/**
 * Decide the update for one visa doc (pure, no I/O; unit-tested).
 *
 * @param visa the stored visa data
 * @returns the outcome and the minimal field update (empty when unchanged)
 */
export function planVisaOwnershipBackfill(
  visa: Pick<VisaType, "source" | "reviewStatus" | "isActive" | "visibility">
): { outcome: VisaOwnershipOutcome; update: VisaOwnershipUpdate } {
  // Only legacy admin-created docs are in scope.
  if (visa.source !== "agent") return { outcome: "skipped_not_agent", update: {} };

  const update: VisaOwnershipUpdate = {};

  if (visa.reviewStatus === "approved") {
    // ---- Approved: already live, keep it public ----
    if (visa.visibility !== VISA_VISIBILITY.GLOBAL) update.visibility = VISA_VISIBILITY.GLOBAL;
    return { outcome: Object.keys(update).length ? "made_global" : "unchanged", update };
  }

  // ---- Pending / rejected (or no review status at all): hide it ----
  // A legacy "agent" doc always had a reviewStatus; a missing one is treated
  // like pending (unreviewed), never as approved.
  if (visa.isActive !== false) update.isActive = false;
  if (visa.visibility !== VISA_VISIBILITY.AGENCY) update.visibility = VISA_VISIBILITY.AGENCY;
  return { outcome: Object.keys(update).length ? "hidden" : "unchanged", update };
}

// ============================================
// Runner
// ============================================

/** Counts printed at the end (and returned, for tests). */
export interface VisaOwnershipBackfillResult {
  dryRun: boolean;
  /** Visa docs read (all sources, all countries). */
  scanned: number;
  /** Legacy `source: "agent"` docs among them. */
  legacy: number;
  madeGlobal: number;
  hidden: number;
  unchanged: number;
  /** Docs actually written (0 on a dry run). */
  written: number;
  /** Countries whose stats were recomputed (empty on a dry run). */
  countriesRecomputed: string[];
}

/**
 * Plan (and, unless `dryRun`, apply) the backfill over every country's
 * `visaTypes` subcollection. Exported so tests and a consolidated seeder can
 * run it in-process.
 *
 * Reads with `where("source", "==", "agent")` per country: a single-field
 * equality query, served by Firestore's automatic index (no composite).
 *
 * @param opts.dryRun when true (the default), read and report only
 */
export async function backfillVisaOwnership(
  opts: { dryRun?: boolean } = {}
): Promise<VisaOwnershipBackfillResult> {
  const dryRun = opts.dryRun ?? true;
  console.log(`Backfilling visa ownership/visibility (${dryRun ? "DRY RUN — nothing is written" : "APPLY"})…`);

  const result: VisaOwnershipBackfillResult = {
    dryRun,
    scanned: 0,
    legacy: 0,
    madeGlobal: 0,
    hidden: 0,
    unchanged: 0,
    written: 0,
    countriesRecomputed: [],
  };

  // Every country (supported or not): a legacy visa can sit under either.
  const countries = await collections.countries.get();

  for (const countryDoc of countries.docs) {
    const countryCode = countryDoc.id;
    const snapshot = await subcollections
      .visaTypes(countryCode)
      .where("source", "==", "agent")
      .get();

    let countryChanged = false;

    for (const doc of snapshot.docs) {
      result.scanned++;
      const visa = doc.data() as VisaType;
      const { outcome, update } = planVisaOwnershipBackfill(visa);
      // The query already narrows to "agent"; guard anyway.
      if (outcome === "skipped_not_agent") continue;
      result.legacy++;

      if (outcome === "unchanged") {
        result.unchanged++;
        continue;
      }
      if (outcome === "made_global") result.madeGlobal++;
      else result.hidden++;

      console.log(`  ${dryRun ? "would update" : "updating"} ${countryCode}/${doc.id} "${visa.name}" → ${JSON.stringify(update)}`);

      if (!dryRun) {
        await doc.ref.update({ ...update, updatedAt: serverTimestamp() });
        result.written++;
        countryChanged = true;
      }
    }

    // ---- Recompute stats of a country we changed ----
    // (The onVisaTypeUpdated trigger would do it too, but not on an emulator
    // without functions, and not before this script exits.)
    if (countryChanged) {
      try {
        await visaService.updateCountryStats(countryCode);
        result.countriesRecomputed.push(countryCode);
      } catch (error) {
        console.error(`  ✗ stats recompute failed for ${countryCode}:`, error);
      }
    }
  }

  console.log(
    `\nDone${dryRun ? " (dry run)" : ""}. ${result.legacy} legacy "agent" visas — ` +
      `${result.madeGlobal} made global, ${result.hidden} hidden, ${result.unchanged} already migrated; ` +
      `${result.written} written.`
  );
  return result;
}

/**
 * Parse the CLI flags: dry run unless `--apply` is given without `--dry-run`.
 * Exported for tests.
 */
export function parseBackfillArgs(argv: string[]): { dryRun: boolean } {
  const apply = argv.includes("--apply");
  const explicitDryRun = argv.includes("--dry-run");
  return { dryRun: explicitDryRun || !apply };
}

// Allow `node lib/scripts/backfill-visa-ownership.js [--apply]` to run it directly.
if (require.main === module) {
  backfillVisaOwnership(parseBackfillArgs(process.argv.slice(2)))
    .then(() => process.exit(0))
    .catch((error) => {
      console.error("Visa ownership backfill failed:", error);
      process.exit(1);
    });
}
