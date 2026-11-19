// ============================================
// Derive checklist requirements from a scraped visa record (issue #175)
// ============================================
//
// A scraped, admin-approved visa has no docs under
// `countries/{code}/visaTypes/{id}/requirements` (the scraper never writes that
// subcollection), so `GET .../requirements` and `/full` came back empty. Issue
// #129 already stores the official "documents you must provide" list on the
// visa itself (`requiredDocuments: string[]`) with a verbatim quote per item in
// `scrapeMeta.citations["requiredDocuments.<index>"]`.
//
// This pure function turns that into the same `VisaRequirement[]` shape the
// mobile app and the application service already read, at READ time (nothing is
// written, so a re-approved scrape is picked up immediately).
//
// Rules (orchestrator decisions on #175, extended by #187):
//  - an item WITHOUT a cited quote is dropped, never shown (no invented data);
//  - every item has a `kind` ("document" | "information") and a `need`
//    ("required" | "conditional" | "optional") read from the classification the
//    extractor stored next to the item (`scrapeMeta.requiredDocumentMeta`, index
//    aligned). A visa crawled before #187 has none: its items read as
//    `document` + `kindReview`, and `need` comes from the item's own stored quote
//    by the same rules (required-document-meta.ts: "if" / "unless" /
//    "depending on" = conditional, "optional" = optional, "may" never counts);
//  - `isRequired` stays for compatibility and is true ONLY for `required`;
//  - no format / size / period / amount is invented: the platform upload
//    defaults are used for acceptedFormats / maxSizeMb (not domain data).

import { Timestamp } from "firebase-admin/firestore";
import type { RequiredDocument, VisaRequirement, VisaType } from "../types";
import { answerTypeOf, findMetaForItem, metaFromQuoteOnly, normaliseStoredMeta } from "../scrapers";

// Id of the single derived requirement. Stable so clients can key on it.
export const DERIVED_REQUIREMENT_ID = "scraped-required-documents";

// Platform upload defaults (what the app accepts), not claims about the visa.
const DEFAULT_FORMATS = ["pdf", "jpg", "png"];
const DEFAULT_MAX_MB = 10;

/**
 * Build the derived requirements for a visa, or [] when it is not a scraped
 * visa, lists no documents, or none of its items has a quote.
 */
export function deriveRequirementsFromScrape(visa: VisaType): VisaRequirement[] {
  if (visa.source !== "scraped") return [];
  const names = Array.isArray(visa.requiredDocuments) ? visa.requiredDocuments : [];
  const citations = visa.scrapeMeta?.citations ?? {};
  const sourceUrl = visa.scrapeMeta?.sourceUrl ?? visa.sourceUrl; // scrape provenance first: top-level sourceUrl is admin-editable
  if (!sourceUrl) return []; // no official page to cite -> nothing we may show

  const docs: RequiredDocument[] = [];
  names.forEach((name, index) => {
    // The citation key uses the ORIGINAL index into the stored array, so we
    // look it up before filtering (dropping one item must not shift the rest).
    const quote = citations[`requiredDocuments.${index}`];
    if (typeof name !== "string" || !name.trim()) return;
    if (typeof quote !== "string" || !quote.trim()) return; // uncited: drop
    // Issue #187: the stored classification for THIS (original) index, or the
    // quote-only fallback when the visa has none yet.
    // Looked up by the item's OWN text, never by position alone (a reordered
    // list must not hand an item its neighbour's classification).
    const storedMeta = findMetaForItem(visa.scrapeMeta?.requiredDocumentMeta, index, name, names.length);
    const meta = storedMeta ? normaliseStoredMeta(storedMeta, quote, name) : metaFromQuoteOnly(quote, name);
    docs.push({
      id: `${DERIVED_REQUIREMENT_ID}-${index}`,
      name: name.trim(),
      description: quote.trim(), // the official wording behind the item
      acceptedFormats: DEFAULT_FORMATS,
      maxSizeMb: DEFAULT_MAX_MB,
      isRequired: meta.need === "required",
      citation: { quote: quote.trim(), sourceUrl },
      kind: meta.kind,
      ...(meta.kindReview ? { kindReview: true as const } : {}),
      ...(meta.kindQuote ? { kindQuote: meta.kindQuote } : {}),
      // Information items carry their answer type ("text" until typed); documents none.
      ...(answerTypeOf(meta) ? { answerType: answerTypeOf(meta) } : {}),
      ...(meta.kind === "information" && meta.answerTypeQuote ? { answerTypeQuote: meta.answerTypeQuote } : {}),
      need: meta.need,
      ...(meta.appliesWhen ? { appliesWhen: meta.appliesWhen } : {}),
    });
  });
  if (docs.length === 0) return [];

  const stamp = visa.lastVerifiedAt ?? visa.scrapeMeta?.extractedAt ?? Timestamp.now();
  return [
    {
      id: DERIVED_REQUIREMENT_ID,
      visaTypeId: visa.id,
      title: "Documents you must provide",
      description: `Listed on the official source: ${sourceUrl}`,
      estimatedTime: "", // the page gives no per-step time; never invented
      orderIndex: 0,
      requiredDocuments: docs,
      isOptional: false,
      createdAt: stamp,
      updatedAt: stamp,
    },
  ];
}
