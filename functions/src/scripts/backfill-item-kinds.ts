/**
 * Backfill kind + need for the items of EXISTING scraped visas (issue #187).
 *
 * Background: from prompt version 2026-11-item-kinds-v8 the extractor stores
 * `scrapeMeta.requiredDocumentMeta` (kind + need per `requiredDocuments` item,
 * index-aligned). Scraped visas extracted earlier have none.
 *
 * Orchestrator decision on #187: NO re-crawl, NO model call. The script uses
 * ONLY what is already stored on the visa: the item text and its stored quote
 * (`scrapeMeta.citations["requiredDocuments.<i>"]`).
 *  - `need` is derived from the stored quote by the shared rules
 *    (required-document-meta.ts: "if" / "unless" / "depending on" =
 *    conditional with the verbatim clause, "optional" = optional, "may" never
 *    counts);
 *  - `kind` cannot be told from a quote alone, so every item stays "document"
 *    with `kindReview: true` until the next weekly crawl classifies it with the
 *    new prompt (which replaces this field wholesale).
 *
 * IDEMPOTENT: a visa that already has a meta list of the same length as its
 * documents (from this script or from a v7 crawl) is left untouched, so a v7
 * classification is never overwritten.
 *
 * DRY RUN BY DEFAULT, with per-visa counts:
 *   npm run backfill:item-kinds         # dry run
 *   npm run backfill:item-kinds -- --apply
 *   npm run backfill:item-kinds:dev     # dry run on durin-seli-dev
 */
import { collections, subcollections } from "../utils/firebase";
import { metaFromQuoteOnly, type RequiredDocumentMeta } from "../scrapers";
import type { VisaType } from "../types";

export type BackfillOutcome = "backfill" | "already_done" | "no_documents";

export interface BackfillPlan {
  outcome: BackfillOutcome;
  meta: RequiredDocumentMeta[];
  counts: { items: number; required: number; conditional: number; optional: number; kindReview: number };
}

/** Pure decision for one visa (unit-tested): what to write, and the counts. */
export function planItemKindBackfill(
  visa: Pick<VisaType, "requiredDocuments" | "scrapeMeta">
): BackfillPlan {
  const names = Array.isArray(visa.requiredDocuments) ? visa.requiredDocuments : [];
  const counts = { items: names.length, required: 0, conditional: 0, optional: 0, kindReview: 0 };
  if (names.length === 0) return { outcome: "no_documents", meta: [], counts };
  const existing = visa.scrapeMeta?.requiredDocumentMeta;
  if (Array.isArray(existing) && existing.length === names.length) {
    return { outcome: "already_done", meta: existing, counts };
  }
  const citations = visa.scrapeMeta?.citations ?? {};
  const meta = names.map((_, i) => metaFromQuoteOnly(citations[`requiredDocuments.${i}`]));
  for (const m of meta) {
    counts[m.need]++;
    if (m.kindReview) counts.kindReview++;
  }
  return { outcome: "backfill", meta, counts };
}

export interface BackfillResult {
  dryRun: boolean;
  visas: Record<string, BackfillPlan["counts"] & { outcome: BackfillOutcome }>;
  written: number;
}

export async function backfillItemKinds(opts: { dryRun?: boolean } = {}): Promise<BackfillResult> {
  const dryRun = opts.dryRun ?? true;
  console.log(`Backfilling item kinds on scraped visas (${dryRun ? "DRY RUN: nothing is written" : "APPLY"})...`);
  const result: BackfillResult = { dryRun, visas: {}, written: 0 };
  const countries = await collections.countries.get();
  for (const country of countries.docs) {
    const snap = await subcollections.visaTypes(country.id).where("source", "==", "scraped").get();
    for (const doc of snap.docs) {
      const plan = planItemKindBackfill(doc.data() as VisaType);
      const key = `${country.id}/${doc.id}`;
      result.visas[key] = { outcome: plan.outcome, ...plan.counts };
      const c = plan.counts;
      console.log(
        `  ${key}: ${plan.outcome} (items ${c.items}, required ${c.required}, conditional ${c.conditional}, ` +
          `optional ${c.optional}, kind needs review ${c.kindReview})`
      );
      if (plan.outcome === "backfill" && !dryRun) {
        // Dotted path: only this key of scrapeMeta changes.
        await doc.ref.update({ "scrapeMeta.requiredDocumentMeta": plan.meta });
        result.written++;
      }
    }
  }
  console.log(`\nDone${dryRun ? " (dry run)" : ""}. ${result.written} written.`);
  return result;
}

/** Dry run unless --apply is given without --dry-run. */
export function parseBackfillArgs(argv: string[]): { dryRun: boolean } {
  return { dryRun: argv.includes("--dry-run") || !argv.includes("--apply") };
}

if (require.main === module) {
  backfillItemKinds(parseBackfillArgs(process.argv.slice(2)))
    .then(() => process.exit(0))
    .catch((e) => {
      console.error("Backfill item kinds failed:", e);
      process.exit(1);
    });
}
