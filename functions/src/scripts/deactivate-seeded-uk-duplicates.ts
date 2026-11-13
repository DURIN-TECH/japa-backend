/**
 * Hide the four seeded UK visas once their scraped gov.uk equivalent is live
 * (issue #175).
 *
 * Background: the seed catalog has hand-written `uk-visitor`, `uk-student`,
 * `uk-skilled-worker` and `uk-family`. The scraper now produces the official
 * `gb-*` equivalents (ids pinned in VISA_SOURCE_OVERRIDES). Once the scraped
 * one is admin-approved and active, the seeded twin is a duplicate in the
 * public list, so it is hidden with `isActive: false`.
 *
 * "Hide" means ONLY `isActive: false` (orchestrator decision on #175): the doc
 * and its requirements stay, so existing applications on these ids still load:
 * the single-visa reads (/countries/:code/visas/:id, /full, /requirements) serve
 * an inactive seed to a caller who has an application on that exact visa
 * (agency-visa-access.ts, step 3b); the list hides it and new starts are
 * refused. Nothing is deleted.
 * Deleting the seeds and migrating references stays in issue #65.
 *
 * A seed is deactivated ONLY when its mapped scraped visa exists, is
 * `reviewStatus: "approved"` and `isActive: true`. Otherwise it is left alone
 * (reported as `waiting`). IDEMPOTENT: an already-inactive seed plans nothing.
 *
 * DRY RUN BY DEFAULT (same flags as backfill-visa-ownership):
 *   node lib/scripts/deactivate-seeded-uk-duplicates.js           # dry run
 *   node lib/scripts/deactivate-seeded-uk-duplicates.js --apply   # write
 *   npm run deactivate:uk-seeds:dev                                # dry run on dev
 */
import { subcollections, serverTimestamp } from "../utils/firebase";
import { visaService } from "../services/visa.service";
import type { VisaType } from "../types";

// seeded id -> scraped id (see VISA_SOURCE_OVERRIDES in seed-visa-sources.ts).
export const SEEDED_TO_SCRAPED: Record<string, string> = {
  "uk-visitor": "gb-standard-visitor",
  "uk-student": "gb-student-visa",
  "uk-skilled-worker": "gb-skilled-worker-visa",
  "uk-family": "gb-uk-family-visa",
};
const COUNTRY = "GB";

export type DeactivateOutcome =
  | "deactivate" // seed active + scraped twin approved and active
  | "already_inactive" // seed already hidden: nothing to do
  | "waiting" // seed active but the twin is missing / not approved / not active
  | "missing_seed"; // no such seeded doc

/** Pure decision for one seed (unit-tested). */
export function planDeactivation(
  seed: Pick<VisaType, "isActive"> | undefined,
  scraped: Pick<VisaType, "reviewStatus" | "isActive" | "source"> | undefined
): DeactivateOutcome {
  if (!seed) return "missing_seed";
  if (seed.isActive === false) return "already_inactive";
  const twinLive = !!scraped && scraped.source === "scraped" && scraped.reviewStatus === "approved" && scraped.isActive === true;
  return twinLive ? "deactivate" : "waiting";
}

export interface DeactivateResult {
  dryRun: boolean;
  outcomes: Record<string, DeactivateOutcome>;
  written: number;
}

export async function deactivateSeededUkDuplicates(opts: { dryRun?: boolean } = {}): Promise<DeactivateResult> {
  const dryRun = opts.dryRun ?? true;
  console.log(`Deactivating seeded UK duplicates (${dryRun ? "DRY RUN — nothing is written" : "APPLY"})…`);
  const result: DeactivateResult = { dryRun, outcomes: {}, written: 0 };
  const col = subcollections.visaTypes(COUNTRY);

  for (const [seedId, scrapedId] of Object.entries(SEEDED_TO_SCRAPED)) {
    const [seedSnap, scrapedSnap] = await Promise.all([col.doc(seedId).get(), col.doc(scrapedId).get()]);
    const outcome = planDeactivation(
      seedSnap.exists ? (seedSnap.data() as VisaType) : undefined,
      scrapedSnap.exists ? (scrapedSnap.data() as VisaType) : undefined
    );
    result.outcomes[seedId] = outcome;
    console.log(`  ${seedId} (twin ${scrapedId}): ${outcome}${outcome === "deactivate" && dryRun ? " — would set isActive:false" : ""}`);
    if (outcome === "deactivate" && !dryRun) {
      await seedSnap.ref.update({ isActive: false, updatedAt: serverTimestamp() });
      result.written++;
    }
  }

  // Keep the country counts right (the trigger would too, but not offline).
  if (result.written > 0) await visaService.updateCountryStats(COUNTRY);
  console.log(`\nDone${dryRun ? " (dry run)" : ""}. ${result.written} written.`);
  return result;
}

/** Dry run unless --apply is given without --dry-run. */
export function parseDeactivateArgs(argv: string[]): { dryRun: boolean } {
  return { dryRun: argv.includes("--dry-run") || !argv.includes("--apply") };
}

if (require.main === module) {
  deactivateSeededUkDuplicates(parseDeactivateArgs(process.argv.slice(2)))
    .then(() => process.exit(0))
    .catch((e) => {
      console.error("Deactivate seeded UK duplicates failed:", e);
      process.exit(1);
    });
}
