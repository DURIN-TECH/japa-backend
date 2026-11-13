// ============================================
// Align scrapeMeta to the LIVE requiredDocuments order (issue #187)
// ============================================
//
// `scrapeMeta.citations["requiredDocuments.<i>"]` and
// `scrapeMeta.requiredDocumentMeta[i]` are written for the ORDER of one
// extraction. A page that only reorders its list is deliberately not a diff
// (visa-catalog-diff.ts), so an approved proposal for some other field keeps
// the LIVE `requiredDocuments` order while replacing `scrapeMeta` wholesale.
// Without this step the new order's quotes and classifications would then sit
// on the wrong items (a TB certificate typed in, a text box on a passport).
//
// The rule: wherever a scrapeMeta is written next to a known live item list,
// re-key both to that list by matching each live item's normalised TEXT to the
// meta entry's own `item`. An item with no match gets `document` + `kindReview`
// (never a neighbour's meta) and no citation. Pure: no I/O.

import { itemKey, metaFromQuoteOnly, type RequiredDocumentMeta } from "./required-document-meta";
import type { VisaScrapeMeta } from "./types";

/**
 * Return `meta` with `citations["requiredDocuments.<i>"]` and
 * `requiredDocumentMeta` re-keyed to `liveDocs` (the live visa's items, in
 * their order). Returns `meta` untouched when it carries no item-keyed
 * classification to align from (a legacy shape).
 *
 * The meta list is the source order: `requiredDocumentMeta[j]` describes the
 * item whose quote is `citations["requiredDocuments.<j>"]`.
 */
export function alignScrapeMetaToLive(meta: VisaScrapeMeta, liveDocs: string[]): VisaScrapeMeta {
  const source = meta.requiredDocumentMeta;
  if (!Array.isArray(source) || source.length === 0 || source.some((m) => typeof m?.item !== "string")) {
    return meta;
  }
  const citations: Record<string, string> = { ...meta.citations };
  // Drop the source-order document quotes, then re-add them in live order.
  for (const k of Object.keys(citations)) if (k.startsWith("requiredDocuments.")) delete citations[k];
  const aligned: RequiredDocumentMeta[] = [];
  liveDocs.forEach((name, i) => {
    const j = source.findIndex((m) => itemKey(m.item as string) === itemKey(name));
    if (j >= 0) {
      aligned.push({ ...source[j], item: name });
      const quote = meta.citations?.[`requiredDocuments.${j}`];
      if (typeof quote === "string" && quote.trim()) citations[`requiredDocuments.${i}`] = quote;
    } else {
      // No classification for this live item: unclassified, not a neighbour's.
      aligned.push(metaFromQuoteOnly(undefined, name));
    }
  });
  return { ...meta, citations, requiredDocumentMeta: aligned };
}
