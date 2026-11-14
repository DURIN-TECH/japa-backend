/**
 * Backfill `answerType` on the information items of EXISTING scraped visas
 * (issue #187 regroom).
 *
 * Background: from prompt version 2026-11-answer-types-v9 the extractor stores
 * an `answerType` (date | date_range | money | address | list | text) on each
 * INFORMATION item of `scrapeMeta.requiredDocumentMeta`. Visas extracted earlier
 * have none; the API and the app read a missing type as "text", so nothing is
 * broken before this script runs.
 *
 * Decision (regroom): NO re-crawl, NO model call. The type is set from ONLY the
 * deterministic rule in required-document-meta.ts (`classifyAnswerType`, the
 * item's own words), `text` last. Every item that fell back to `text` is LOGGED
 * so a human can see which items the rule could not type.
 *
 * Only information items are touched; documents never get a type. An entry that
 * already has a valid `answerType` (from a v9 crawl or an earlier run) is kept
 * as it is, so the script is IDEMPOTENT: a second run changes nothing.
 *
 * DRY RUN BY DEFAULT, with per-visa counts per type:
 *   npm run backfill:answer-types         # dry run
 *   npm run backfill:answer-types -- --apply
 *   npm run backfill:answer-types:dev     # dry run on durin-seli-dev
 */
import { collections, subcollections } from "../utils/firebase";
import {
  ANSWER_TYPES,
  classifyAnswerType,
  isAnswerType,
  type AnswerType,
  type RequiredDocumentMeta,
} from "../scrapers";
import type { VisaType } from "../types";

export type AnswerTypeOutcome = "backfill" | "already_done" | "no_information_items";

/** An item the rule could only type as the `text` fallback (logged). */
export interface FallbackItem {
  item: string;
}

export interface AnswerTypePlan {
  outcome: AnswerTypeOutcome;
  /** The full `requiredDocumentMeta` list to write (== the stored one when nothing changes). */
  meta: RequiredDocumentMeta[];
  /** Count of information items per answer type, after the backfill. */
  counts: Record<AnswerType, number>;
  /** Items set to `text` BY THIS RUN because no rule matched (not items already typed). */
  fellBack: FallbackItem[];
  /** How many entries this run changes. */
  changed: number;
}

/** Zeroed per-type counter. */
function emptyCounts(): Record<AnswerType, number> {
  return Object.fromEntries(ANSWER_TYPES.map((t) => [t, 0])) as Record<AnswerType, number>;
}

/** Pure decision for one visa (unit-tested): what to write, and the counts. */
export function planAnswerTypeBackfill(
  visa: Pick<VisaType, "requiredDocuments" | "scrapeMeta">
): AnswerTypePlan {
  const stored = visa.scrapeMeta?.requiredDocumentMeta;
  const names = Array.isArray(visa.requiredDocuments) ? visa.requiredDocuments : [];
  const counts = emptyCounts();
  const fellBack: FallbackItem[] = [];
  if (!Array.isArray(stored) || stored.length === 0) {
    return { outcome: "no_information_items", meta: [], counts, fellBack, changed: 0 };
  }
  let changed = 0;
  const meta = stored.map((entry, i) => {
    if (!entry || entry.kind !== "information") return entry;
    if (isAnswerType(entry.answerType)) {
      counts[entry.answerType]++;
      return entry; // already typed (v9 crawl or earlier run): never overwritten
    }
    // The item's own words: the stored text, else the list's item at the same
    // position when the lists line up (a legacy entry without `item`).
    const text = typeof entry.item === "string" ? entry.item : names.length === stored.length ? names[i] : "";
    const decided = classifyAnswerType(String(text ?? ""));
    counts[decided.type]++;
    if (!decided.matched) fellBack.push({ item: String(text ?? "(unknown item text)") });
    changed++;
    return { ...entry, answerType: decided.type };
  });
  const hasInformation = meta.some((m) => m?.kind === "information");
  if (!hasInformation) return { outcome: "no_information_items", meta, counts, fellBack, changed: 0 };
  return { outcome: changed > 0 ? "backfill" : "already_done", meta, counts, fellBack, changed };
}

export interface AnswerTypeBackfillResult {
  dryRun: boolean;
  visas: Record<string, { outcome: AnswerTypeOutcome; counts: Record<AnswerType, number>; changed: number }>;
  fellBack: Array<{ visa: string; item: string }>;
  written: number;
}

/** Walk every scraped visa; write (unless dry run) the ones that need it. */
export async function backfillAnswerTypes(opts: { dryRun?: boolean } = {}): Promise<AnswerTypeBackfillResult> {
  const dryRun = opts.dryRun ?? true;
  console.log(`Backfilling answer types on scraped visas (${dryRun ? "DRY RUN: nothing is written" : "APPLY"})...`);
  const result: AnswerTypeBackfillResult = { dryRun, visas: {}, fellBack: [], written: 0 };
  const countries = await collections.countries.get();
  for (const country of countries.docs) {
    const snap = await subcollections.visaTypes(country.id).where("source", "==", "scraped").get();
    for (const doc of snap.docs) {
      const plan = planAnswerTypeBackfill(doc.data() as VisaType);
      const key = `${country.id}/${doc.id}`;
      result.visas[key] = { outcome: plan.outcome, counts: plan.counts, changed: plan.changed };
      const perType = ANSWER_TYPES.map((t) => `${t} ${plan.counts[t]}`).join(", ");
      console.log(`  ${key}: ${plan.outcome} (${perType}; ${plan.changed} to change)`);
      // Every fallback is listed: nothing is silently turned into text.
      for (const f of plan.fellBack) {
        console.log(`    fell back to text: "${f.item}"`);
        result.fellBack.push({ visa: key, item: f.item });
      }
      if (plan.outcome === "backfill" && !dryRun) {
        // Dotted path: only this key of scrapeMeta changes.
        await doc.ref.update({ "scrapeMeta.requiredDocumentMeta": plan.meta });
        result.written++;
      }
    }
  }
  console.log(`\nDone${dryRun ? " (dry run)" : ""}. ${result.written} written, ${result.fellBack.length} item(s) fell back to text.`);
  return result;
}

/** Dry run unless --apply is given without --dry-run. */
export function parseBackfillArgs(argv: string[]): { dryRun: boolean } {
  return { dryRun: argv.includes("--dry-run") || !argv.includes("--apply") };
}

if (require.main === module) {
  backfillAnswerTypes(parseBackfillArgs(process.argv.slice(2)))
    .then(() => process.exit(0))
    .catch((e) => {
      console.error("Backfill answer types failed:", e);
      process.exit(1);
    });
}
