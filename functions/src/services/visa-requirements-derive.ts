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
// Rules (orchestrator decisions on #175):
//  - an item WITHOUT a cited quote is dropped, never shown (no invented data);
//  - `isRequired` is true by default (the scraper only extracts the page's
//    required-documents list); false only when the cited quote itself marks
//    the item optional or conditional;
//  - no format / size / period / amount is invented: the platform upload
//    defaults are used for acceptedFormats / maxSizeMb (not domain data).

import { Timestamp } from "firebase-admin/firestore";
import type { RequiredDocument, VisaRequirement, VisaType } from "../types";

// Id of the single derived requirement. Stable so clients can key on it.
export const DERIVED_REQUIREMENT_ID = "scraped-required-documents";

// Words in a quote that make the document optional or conditional.
// "may" / "if" / "optional" per the decision, plus "unless" and "depending on".
const OPTIONAL_QUOTE = /\b(if|may|optional|unless|depending on)\b/i;

// Platform upload defaults (what the app accepts), not claims about the visa.
const DEFAULT_FORMATS = ["pdf", "jpg", "png"];
const DEFAULT_MAX_MB = 10;

/** True when the quote marks the document as optional or conditional. */
export function isQuoteOptional(quote: string): boolean {
  return OPTIONAL_QUOTE.test(quote);
}

/**
 * Build the derived requirements for a visa, or [] when it is not a scraped
 * visa, lists no documents, or none of its items has a quote.
 */
export function deriveRequirementsFromScrape(visa: VisaType): VisaRequirement[] {
  if (visa.source !== "scraped") return [];
  const names = Array.isArray(visa.requiredDocuments) ? visa.requiredDocuments : [];
  const citations = visa.scrapeMeta?.citations ?? {};
  const sourceUrl = visa.sourceUrl ?? visa.scrapeMeta?.sourceUrl;
  if (!sourceUrl) return []; // no official page to cite -> nothing we may show

  const docs: RequiredDocument[] = [];
  names.forEach((name, index) => {
    // The citation key uses the ORIGINAL index into the stored array, so we
    // look it up before filtering (dropping one item must not shift the rest).
    const quote = citations[`requiredDocuments.${index}`];
    if (typeof name !== "string" || !name.trim()) return;
    if (typeof quote !== "string" || !quote.trim()) return; // uncited: drop
    docs.push({
      id: `${DERIVED_REQUIREMENT_ID}-${index}`,
      name: name.trim(),
      description: quote.trim(), // the official wording behind the item
      acceptedFormats: DEFAULT_FORMATS,
      maxSizeMb: DEFAULT_MAX_MB,
      isRequired: !isQuoteOptional(quote),
      citation: { quote: quote.trim(), sourceUrl },
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
