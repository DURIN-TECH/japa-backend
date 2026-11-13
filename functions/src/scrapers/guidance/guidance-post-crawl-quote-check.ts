import {
  runQuoteChecks,
  type GuidanceQuoteCheck,
  type GuidanceQuoteCheckDeps,
  type GuidanceQuoteResult,
} from "./guidance-quote-check";

// ============================================
// GUIDANCE — QUOTE CHECK AFTER A CRAWL (issue #150)
// ============================================
//
// Once the guidance crawl runs on a schedule, nobody is running the seed
// script's `--check-quotes` by hand any more, so a publisher rewording a
// passage that a rubric cites would go unnoticed. This module turns the
// existing check (guidance-quote-check.ts) into a post-crawl REPORT.
//
// What it is NOT: it never throws for a per-source problem, never writes (it
// only READS snapshots through the injected deps; the caller decides what to
// record), and never decides whether the crawl run succeeded. The caller
// (guidance-crawl.service.ts) puts the report on the run record, the source
// doc and the shared alert service.
//
// The split that matters (issue #150, "awkward cases"):
//  - DRIFT: the snapshot was read and a declared passage is not in it
//    (`not_found`). That says something about the PUBLISHER's document.
//  - INFRASTRUCTURE: the snapshot could not be read at all (its Storage object
//    is missing or fails its hash check, or the source has no snapshot
//    though it was just fetched). That says something about OUR storage, and
//    nothing about the passages, so it must never raise a drift alert (and
//    must never RESOLVE one either: nothing was confirmed).
//
// Generic by design: the checks are data, keyed by registry id. Nothing here
// knows a publisher, jurisdiction or route.

/** One passage that was not confirmed in a source's latest snapshot. */
export interface QuoteDriftEntry {
  checkId: string;
  // Where the passage sits in the document (the check's label). The passage
  // text itself is deliberately NOT carried: ids and labels are enough to
  // find it in data/guidance-quote-checks.ts.
  label: string;
  problem: string;
  // Punctuation hint, when the words are there but not verbatim.
  detail?: string;
}

/** A source with at least one passage missing from its latest snapshot. */
export interface QuoteDriftFinding {
  sourceId: string;
  title: string;
  // The snapshot that was searched.
  contentHash: string;
  failed: QuoteDriftEntry[];
}

/** A source whose snapshot could not be read: an infrastructure problem. */
export interface QuoteInfraProblem {
  sourceId: string;
  message: string;
}

/** What one post-crawl check found. */
export interface PostCrawlQuoteReport {
  // Sources whose snapshot WAS read and every declared passage judged: the
  // only ones whose drift alert may be raised or resolved.
  checkedSourceIds: string[];
  // Subset of the above with at least one passage missing.
  drift: QuoteDriftFinding[];
  // Sources that could not be judged because their snapshot was unreadable.
  infra: QuoteInfraProblem[];
  // (passage, source) pairs judged / not confirmed (infra sources excluded).
  pairsChecked: number;
  pairsFailed: number;
}

/**
 * The ids of the sources, among `touchedSourceIds`, that have at least one
 * declared check. This is the "skip cheaply" gate: a run that touched no
 * source with checks reads nothing at all.
 */
export function sourcesWithChecks(checks: readonly GuidanceQuoteCheck[], touchedSourceIds: readonly string[]): string[] {
  const declared = new Set<string>();
  for (const check of checks) for (const id of check.sourceIds) declared.add(id);
  return [...new Set(touchedSourceIds)].filter((id) => declared.has(id));
}

/**
 * Run the declared checks over the sources a crawl touched and sort the
 * results into drift and infrastructure problems.
 *
 * @param checks     the declared passages (data)
 * @param touched    ids of the sources the run fetched successfully
 * @param titles     source id -> title, for the report (falls back to the id)
 * @param deps       where snapshots come from (read-only)
 */
export async function checkQuotesAfterCrawl(
  checks: readonly GuidanceQuoteCheck[],
  touched: readonly string[],
  titles: ReadonlyMap<string, string>,
  deps: GuidanceQuoteCheckDeps
): Promise<PostCrawlQuoteReport> {
  const ids = sourcesWithChecks(checks, touched);
  const report: PostCrawlQuoteReport = { checkedSourceIds: [], drift: [], infra: [], pairsChecked: 0, pairsFailed: 0 };
  if (ids.length === 0) return report;

  // `runQuoteChecks` never throws for a per-source problem and reads each
  // snapshot once, however many passages are looked for in it.
  const results = await runQuoteChecks(checks, deps, ids);
  const bySource = new Map<string, GuidanceQuoteResult[]>();
  for (const r of results) bySource.set(r.sourceId, [...(bySource.get(r.sourceId) ?? []), r]);

  for (const sourceId of ids) {
    const own = bySource.get(sourceId) ?? [];
    // An unreadable or absent snapshot is the same problem for every passage
    // of the source (the snapshot is loaded once): report it once, as ours.
    const unread = own.find((r) => r.problem === "snapshot_unreadable" || r.problem === "no_snapshot");
    if (unread) {
      report.infra.push({
        sourceId,
        message:
          unread.problem === "no_snapshot"
            ? "quote check: the source was fetched but has no stored snapshot to check"
            : `quote check: its stored snapshot could not be read: ${unread.detail ?? "unknown error"}`,
      });
      continue;
    }
    if (own.length === 0) continue; // cannot happen (ids come from the checks), but never invent a pass
    report.checkedSourceIds.push(sourceId);
    report.pairsChecked += own.length;
    const failed = own.filter((r) => !r.found);
    report.pairsFailed += failed.length;
    if (failed.length > 0) {
      report.drift.push({
        sourceId,
        title: titles.get(sourceId) ?? sourceId,
        contentHash: own[0].contentHash ?? "",
        failed: failed.map((r) => ({
          checkId: r.checkId,
          label: r.label,
          problem: r.problem ?? "not_found",
          ...(r.detail ? { detail: r.detail } : {}),
        })),
      });
    }
  }
  return report;
}
