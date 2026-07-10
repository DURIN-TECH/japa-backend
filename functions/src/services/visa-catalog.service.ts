import { collections, subcollections, serverTimestamp } from "../utils/firebase";
import { Timestamp } from "firebase-admin/firestore";
import { VisaType } from "../types";
import { ExtractedVisa, VisaScrapeMeta } from "../types/visa-catalog";

// ============================================
// VISA CATALOG SERVICE (ingest into review queue)
// ============================================
//
// The write side of the scraper. It takes a validated `ExtractedVisa` and writes
// it into the LIVE catalog collection (`countries/{code}/visaTypes`) but as an
// UNAPPROVED, non-active record: `source: "scraped"`, `reviewStatus:
// "pending_review"`, `isActive: false`.
//
// That means scraped visas show up in the EXISTING admin visa-review page (which
// already filters by source=scraped / reviewStatus=pending_review) and are
// approved/rejected through the existing `PATCH /admin/visas/:id/review` flow —
// no separate queue, no autopublish. Approval (elsewhere) flips
// reviewStatus=approved + isActive=true, making the visa user-visible.

// The result of ingesting one extraction.
export type IngestOutcome = "created" | "updated" | "unchanged" | "skipped";

// Fields the extractor produces that map onto VisaType.
function extractedToFields(
  countryCode: string,
  visaId: string,
  e: ExtractedVisa
): Partial<VisaType> {
  return {
    id: visaId,
    countryCode,
    name: e.name,
    code: e.code,
    description: e.description,
    category: e.category,
    processingTime: e.processingTime,
    processingDaysMin: e.processingDaysMin,
    processingDaysMax: e.processingDaysMax,
    baseCostUsd: e.baseCostUsd,
    validityPeriod: e.validityPeriod,
    isExtendable: e.isExtendable,
    maxExtensions: e.maxExtensions,
    eligibilityCriteria: e.eligibilityCriteria,
    applicationUrl: e.applicationUrl,
    applicationInstructions: e.applicationInstructions,
  };
}

// Deterministic id part so re-crawling the same visa maps to the same doc.
function slug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

class VisaCatalogService {
  /** Deterministic visa doc id: `${countryCode}_${slug(code||name)}`. */
  buildVisaId(countryCode: string, extracted: ExtractedVisa): string {
    return `${countryCode}_${slug(extracted.code || extracted.name)}`;
  }

  /**
   * Write a validated extraction into the catalog as a pending-review scraped
   * visa. Returns what happened (created / updated / unchanged / skipped).
   *
   * Safety rules:
   *  - NEW visa (no doc): create it pending_review + inactive.
   *  - Existing SCRAPED + still pending_review: refresh it (safe — not live yet).
   *  - Existing doc that is already approved or agent-authored: SKIP — never
   *    clobber curated/live data. (Proposing edits to already-live visas is a
   *    deliberate future enhancement; see the spike doc.)
   *  - Same content hash as last time: unchanged, no write.
   */
  async ingestExtraction(params: {
    countryCode: string;
    sourceUrl: string;
    routeName: string;
    contentHash: string;
    extracted: ExtractedVisa;
    model: string;
  }): Promise<{ visaId: string; outcome: IngestOutcome }> {
    const { countryCode, sourceUrl, routeName, contentHash, extracted, model } = params;
    const visaId = this.buildVisaId(countryCode, extracted);
    const ref = subcollections.visaTypes(countryCode).doc(visaId);
    const now = Timestamp.now();

    const scrapeMeta: VisaScrapeMeta = {
      sourceUrl,
      routeName,
      model,
      confidence: extracted.confidence,
      citations: extracted.citations,
      contentHash,
      extractedAt: now,
    };
    const fields = extractedToFields(countryCode, visaId, extracted);

    const snap = await ref.get();
    if (!snap.exists) {
      // New scraped visa → pending review, inactive until an agent approves.
      await ref.set({
        ...fields,
        source: "scraped",
        reviewStatus: "pending_review",
        isActive: false,
        sourceUrl,
        scrapeMeta,
        agentIds: [],
        createdAt: now,
        updatedAt: now,
      });
      return { visaId, outcome: "created" };
    }

    const existing = snap.data() as VisaType;
    if (existing.scrapeMeta?.contentHash === contentHash) {
      return { visaId, outcome: "unchanged" };
    }
    // Only refresh a visa that is still an unapproved scrape; never overwrite an
    // approved or agent-authored record.
    if (existing.source === "scraped" && existing.reviewStatus === "pending_review") {
      await ref.set(
        { ...fields, sourceUrl, scrapeMeta, updatedAt: now },
        { merge: true }
      );
      return { visaId, outcome: "updated" };
    }
    return { visaId, outcome: "skipped" };
  }

  /**
   * Recompute denormalized Country stats from its current APPROVED/active visas.
   * Call after an approval flips a scraped visa live. (Pending scraped visas are
   * `isActive: false` and excluded, so ingest itself doesn't change stats.)
   */
  async recomputeCountryStats(countryCode: string): Promise<void> {
    const snap = await subcollections.visaTypes(countryCode).get();
    const visas = snap.docs.map((d) => d.data() as VisaType).filter((v) => v.isActive !== false);
    const costs = visas.map((v) => v.baseCostUsd).filter((n) => Number.isFinite(n));
    const days = visas.map((v) => v.processingDaysMin).filter((n) => Number.isFinite(n));
    await collections.countries.doc(countryCode).set(
      {
        visaTypesCount: visas.length,
        minCostUsd: costs.length ? Math.min(...costs) : 0,
        minProcessingDays: days.length ? Math.min(...days) : 0,
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );
  }
}

export const visaCatalogService = new VisaCatalogService();
