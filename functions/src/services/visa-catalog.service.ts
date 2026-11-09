import { collections, subcollections, serverTimestamp } from "../utils/firebase";
import { Timestamp } from "firebase-admin/firestore";
import { VisaType } from "../types";
import { ExtractedVisa, VisaScrapeMeta } from "../types/visa-catalog";
// Pure id/code rules live in a Firebase-free module so they are unit-testable.
import { deriveVisaId, resolveVisaCode } from "./visa-catalog-ids";

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

// Fields the extractor produces that map onto VisaType. `code` is the already
// resolved code (registry-pinned `visaCode` if any, else the extracted one).
function extractedToFields(
  countryCode: string,
  visaId: string,
  code: string,
  e: ExtractedVisa
): Partial<VisaType> {
  return {
    id: visaId,
    countryCode,
    name: e.name,
    code,
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

class VisaCatalogService {
  /**
   * Deterministic visa doc id for a crawled page — owned by the source
   * registry, never by the LLM output:
   *  - the page's pinned `visaId` verbatim when set, else
   *  - `${countryCode.toLowerCase()}-${slug(full url path)}` (hash-suffixed
   *    when over-long; see deriveVisaId in visa-catalog-ids.ts).
   * Throws on an unparseable URL / empty path (the crawl loop records it as a
   * page error). Replaces the old `${CC}_${slug(code||name)}` scheme, which let
   * extraction drift fork one visa into several `GB_*` docs.
   */
  buildVisaId(countryCode: string, sourceUrl: string, pinned?: { visaId?: string }): string {
    return deriveVisaId({ countryCode, sourceUrl, visaId: pinned?.visaId });
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
   *
   * Identity: the doc id comes from the registry page (`visaId` pin or URL
   * path — see buildVisaId), and a pinned `visaCode` overrides the extracted
   * code. Callers pass the page's `visaId` / `visaCode` straight through.
   */
  async ingestExtraction(params: {
    countryCode: string;
    sourceUrl: string;
    routeName: string;
    contentHash: string;
    extracted: ExtractedVisa;
    model: string;
    // Registry-owned identity (both optional).
    // `visaId`: the doc id the caller already resolved with buildVisaId()
    // before extraction (the crawlers do this so an un-derivable id fails
    // before any LLM call), or simply the page's pinned `visaId`. Either way it
    // is used VERBATIM — buildVisaId returns a given id unchanged — so ingest
    // never recomputes a different id. When absent, the id is derived from
    // `sourceUrl`.
    visaId?: string;
    // `visaCode`: the page's pinned code; overrides `extracted.code` when set.
    visaCode?: string;
  }): Promise<{ visaId: string; outcome: IngestOutcome }> {
    const { countryCode, sourceUrl, routeName, contentHash, extracted, model } = params;
    // Id from the registry (pin or URL path), never from extracted.code/name.
    const visaId = this.buildVisaId(countryCode, sourceUrl, { visaId: params.visaId });
    // Pinned code wins over the extracted one (aligns with seeded equivalents).
    const code = resolveVisaCode(params.visaCode, extracted.code);
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
    const fields = extractedToFields(countryCode, visaId, code, extracted);

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
