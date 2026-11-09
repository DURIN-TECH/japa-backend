import { collections, subcollections, serverTimestamp } from "../utils/firebase";
import { Timestamp } from "firebase-admin/firestore";
import { VisaType } from "../types";
import { ExtractedVisa, FxRatesDoc } from "../types/visa-catalog";
// Pure id/code rules live in a Firebase-free module so they are unit-testable.
import { deriveVisaId, resolveVisaCode } from "./visa-catalog-ids";
// Pure scrape-meta + withdrawn decisions (also unit-tested without Firestore).
import {
  WithdrawnOutcome,
  buildScrapeMeta,
  extractedToVisaFields,
  finiteMin,
  planWithdrawnUpdate,
} from "./visa-catalog-meta";
// Pure fee arithmetic + FX conversion (issue #59) and the rate refresh.
import {
  FxFetcher,
  FxRefreshResult,
  FxStore,
  computeFee,
  fetchFrankfurterRates,
  isFxFresh,
  planFeeReconvert,
  refreshFxRates,
} from "./visa-catalog-fx";
import { EXTRACTOR_PROMPT_VERSION } from "./visa-catalog-extract.service";
import type { ScrapeSourceMeta } from "./visa-source-adapters";

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

// Doc id of the rate document under `appConfig`.
const FX_DOC_ID = "fx";

// Firestore-backed store for the single `appConfig/fx` rate document
// (backend-only: firestore.rules has no appConfig match, so clients are denied).
export const firestoreFxStore: FxStore = {
  async get() {
    const snap = await collections.appConfig.doc(FX_DOC_ID).get();
    return snap.exists ? (snap.data() as FxRatesDoc) : undefined;
  },
  async set(doc: FxRatesDoc) {
    await collections.appConfig.doc(FX_DOC_ID).set(doc);
  },
};
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
    // Adapter provenance for scrapeMeta (sourceProvider, sourceDocumentId,
    // sourceUpdatedAt, sectionsUsed, truncated) — build it with
    // sourceMetaFromDocument(). Optional: callers without it write the old shape.
    sourceMeta?: ScrapeSourceMeta;
    // The `appConfig/fx` doc for this run (from refreshFx()). Required so a
    // caller can't forget it; `undefined` = no stored rate at all (fees in a
    // non-USD, non-pegged currency are then flagged fxMissing).
    fx: FxRatesDoc | undefined;
  }): Promise<{ visaId: string; outcome: IngestOutcome }> {
    const { countryCode, sourceUrl, routeName, contentHash, extracted, model } = params;
    // Id from the registry (pin or URL path), never from extracted.code/name.
    const visaId = this.buildVisaId(countryCode, sourceUrl, { visaId: params.visaId });
    // Pinned code wins over the extracted one (aligns with seeded equivalents).
    const code = resolveVisaCode(params.visaCode, extracted.code);
    const ref = subcollections.visaTypes(countryCode).doc(visaId);
    const now = Timestamp.now();

    // ---- Fee: code-computed total + USD conversion (issue #59) ----
    // `baseCostUsd` is undefined when a currency had no usable rate (or no fee
    // was stated): it is then NOT written (absent on a new doc, unchanged on
    // an existing pending doc) and approval is blocked by the review guard.
    // NOTE: the content-hash gate below runs on the PAGE text, so a rate
    // change alone never re-stages a visa; flagged fees are instead
    // re-converted from their stored components by reconvertFlaggedFees().
    const { baseCostUsd, feeMeta } = computeFee(extracted.feeComponents, params.fx, now);

    // Provenance + audit trail (adapter fields merged in when given).
    const scrapeMeta = buildScrapeMeta({
      sourceUrl,
      routeName,
      model,
      contentHash,
      extracted,
      extractedAt: now,
      sourceMeta: params.sourceMeta,
      fee: feeMeta,
      extractorPromptVersion: EXTRACTOR_PROMPT_VERSION,
    });
    const fields = extractedToVisaFields({ countryCode, visaId, code, extracted, baseCostUsd });

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
      // update() (not set+merge): a top-level `scrapeMeta` key REPLACES the
      // whole map. set(..., {merge:true}) would deep-merge it, leaving stale
      // keys from the previous extraction behind (e.g. an old totalUsd /
      // fxSource next to a new fxStale flag, or old citations). Other
      // top-level fields not in `fields` are kept — in particular an omitted
      // `baseCostUsd` (unconverted fee) stays UNCHANGED, as intended.
      await ref.update({ ...fields, sourceUrl, scrapeMeta, updatedAt: now });
      return { visaId, outcome: "updated" };
    }
    return { visaId, outcome: "skipped" };
  }

  /**
   * Withdrawn-source path: the source (GOV.UK `withdrawn_notice`) says the
   * page is withdrawn, so the scraped visa at `visaId` comes off the app.
   *
   * Only a doc with `source === "scraped"` is modified, regardless of its
   * reviewStatus: `isActive: false` + `staleSince` (set once, never
   * overwritten). Seeded/agent docs are never touched; a missing doc is not
   * created; nothing is deleted. Rules live in planWithdrawnUpdate().
   *
   * After an `isActive` flip the country's denormalized stats are recomputed
   * so visaTypesCount / min cost / min days stay right.
   *
   * No auto-reactivation: if the guide later stops being withdrawn, nothing
   * here (or in ingest) flips the doc back on — a human re-approves it.
   */
  async markWithdrawn(countryCode: string, visaId: string): Promise<WithdrawnOutcome> {
    const ref = subcollections.visaTypes(countryCode).doc(visaId);
    const snap = await ref.get();
    const plan = planWithdrawnUpdate(
      snap.exists ? (snap.data() as VisaType) : undefined,
      Timestamp.now()
    );
    if (plan.update) {
      // update() (not set) — the doc is known to exist and must stay intact.
      await ref.update(plan.update);
      await this.recomputeCountryStats(countryCode);
    }
    return plan.outcome;
  }

  // ============================================
  // FX (issue #59)
  // ============================================

  /**
   * Refresh `appConfig/fx` from Frankfurter (ECB reference rates). Call ONCE
   * per crawl run, before extraction. On failure the previous doc is kept and
   * returned (see refreshFxRates) — never throws, so the run continues.
   *
   * @param fetchRates injectable fetcher (defaults to Frankfurter via fetch).
   */
  async refreshFx(fetchRates: FxFetcher = () => fetchFrankfurterRates()): Promise<FxRefreshResult> {
    return refreshFxRates({ fetchRates, store: firestoreFxStore, now: Timestamp.now() });
  }

  /**
   * Re-convert PENDING SCRAPED visas whose `scrapeMeta.fee` is flagged
   * fxStale / fxMissing, from their stored fee components, with the given
   * rate doc. No LLM call, and the content hash is untouched. A fresh rate
   * writes `baseCostUsd`, replaces `scrapeMeta.fee` (new fx fields, flags
   * cleared). Approved / seeded / agent docs are never touched (planFeeReconvert).
   *
   * Only runs when `fx` is fresh — a stale doc can't clear anything. Scans
   * each registry country's `reviewStatus == "pending_review"` docs (a
   * single-field equality: no composite / collection-group index needed).
   *
   * @returns how many docs were re-converted (cost written) / re-flagged.
   */
  async reconvertFlaggedFees(fx: FxRatesDoc | undefined): Promise<{ reconverted: number; reflagged: number }> {
    const result = { reconverted: 0, reflagged: 0 };
    const now = Timestamp.now();
    if (!isFxFresh(fx, now)) return result;

    const sources = await collections.visaSources.get();
    for (const src of sources.docs) {
      const countryCode = (src.data().countryCode as string) || src.id;
      const pending = await subcollections
        .visaTypes(countryCode)
        .where("reviewStatus", "==", "pending_review")
        .get();
      for (const doc of pending.docs) {
        const plan = planFeeReconvert(doc.data() as VisaType, fx, now);
        if (!plan) continue;
        // Field-path update: replaces scrapeMeta.fee wholesale (clearing the
        // flags) without touching scrapeMeta.contentHash or anything else.
        const update: Record<string, unknown> = { "scrapeMeta.fee": plan.fee, updatedAt: now };
        if (plan.baseCostUsd !== undefined) update.baseCostUsd = plan.baseCostUsd;
        await doc.ref.update(update);
        if (plan.baseCostUsd !== undefined) result.reconverted++;
        else result.reflagged++;
      }
    }
    return result;
  }

  /**
   * Recompute denormalized Country stats from its current APPROVED/active visas.
   * Call after an approval flips a scraped visa live. (Pending scraped visas are
   * `isActive: false` and excluded, so ingest itself doesn't change stats.)
   */
  async recomputeCountryStats(countryCode: string): Promise<void> {
    const snap = await subcollections.visaTypes(countryCode).get();
    const visas = snap.docs.map((d) => d.data() as VisaType).filter((v) => v.isActive !== false);
    // Finite-only mins: a doc without baseCostUsd can't make the stat NaN.
    await collections.countries.doc(countryCode).set(
      {
        visaTypesCount: visas.length,
        minCostUsd: finiteMin(visas.map((v) => v.baseCostUsd)),
        minProcessingDays: finiteMin(visas.map((v) => v.processingDaysMin)),
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );
  }
}

export const visaCatalogService = new VisaCatalogService();
