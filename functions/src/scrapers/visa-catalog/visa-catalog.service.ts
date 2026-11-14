import { collections, db, subcollections } from "../../utils/firebase";
import { FieldValue, Timestamp, Transaction } from "firebase-admin/firestore";
import { VisaType } from "../../types";
import { ExtractedVisa, FxRatesDoc, VisaSupplementaryPageMeta } from "./types";
// Pure id/code rules live in a Firebase-free module so they are unit-testable.
import { deriveVisaId, resolveVisaCode } from "./visa-catalog-ids";
// Pure scrape-meta + withdrawn decisions (also unit-tested without Firestore).
import {
  RestoredOutcome,
  WithdrawnOutcome,
  buildScrapeMeta,
  extractedToVisaFields,
  absentFieldDeletes,
  planRestoredUpdate,
  planWithdrawnUpdate,
} from "./visa-catalog-meta";
// Pure fee arithmetic + FX conversion (issue #59) and the rate refresh.
import {
  FxFetcher,
  FxRefreshResult,
  FxStore,
  computeFee,
  fetchFrankfurterRates,
  isFeeFxFlagged,
  isFxFresh,
  planFeeReconvert,
  refreshFxRates,
} from "./visa-catalog-fx";
import { extractionVersionFor } from "./visa-catalog-extract.service";
// Canonical country-stats recompute (issue #62: the only stats function).
import { visaService } from "../../services/visa.service";
import type { ScrapeSourceMeta } from "./adapters";
// Issue #82: priced LLM usage stored on scrapeMeta.
import type { PricedUsage } from "../shared/cost/scrape-cost-pricing";
// Surcharges published on a linked page (issue #69): applied in code before computeFee.
import { applyLinkedSurcharges, type PageLinkedSurcharge } from "./visa-catalog-linked-surcharge";
// Proposed edits to approved scraped visas (issue #61): the pure branch
// decision, and the pendingVisaChanges writer.
import { isPendingPromptStale, planIngest } from "./visa-catalog-diff";
import { visaChangeService } from "./changes/visa-catalog-changes.service";
// Manual USD cost (issue #70): a refresh replaces it, recording the overwrite.
import { planManualCostOverwrite } from "./visa-manual-cost";
import type { DocumentData, UpdateData } from "firebase-admin/firestore";
// Transaction.update() wants UpdateData<DocumentData>; the field maps built here are
// Record<string, unknown> (dotted paths + FieldValue sentinels), which tsc rejects.
type FsUpdate = UpdateData<DocumentData>;

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
// no separate queue, no autopublish. Approval (elsewhere:
// visaService.updateVisaReviewStatus) flips reviewStatus=approved +
// isActive=true (plus lastVerifiedAt, and clears staleSince), making the visa
// user-visible, and recomputes the country stats with
// visaService.updateCountryStats before it returns. Ingest itself never
// changes stats: pending scraped visas are `isActive: false` and not counted.

// The result of ingesting one extraction. "proposed" (issue #61): an
// approved scraped visa's page changed, so a pendingVisaChanges row was
// written (or the open one replaced) and the live doc was left untouched.
export type IngestOutcome = "created" | "updated" | "unchanged" | "skipped" | "proposed";

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
   * Transaction runner for the pending-refresh write (issue #70). Swappable
   * in unit tests for an in-memory one (writes buffered until the callback
   * resolves, so a throw writes nothing — same all-or-nothing contract).
   */
  runTransaction: <T>(fn: (tx: Transaction) => Promise<T>) => Promise<T> = (fn) => db.runTransaction(fn);

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
   * Issue #71: should an UNCHANGED page still be re-extracted because the doc
   * at `visaId` is a pending scraped visa from an older extractor prompt?
   *
   * Used by both crawlers' hash gates (scheduled orchestrator + manual
   * script) right where they would otherwise skip the LLM. One doc read per
   * unchanged page; the rule itself is the pure isPendingPromptStale()
   * (visa-catalog-diff.ts): seeded / agent / rejected / withdrawn docs, and a
   * missing doc, always return false. An APPROVED scraped visa that lists
   * documents qualifies too (issue #187), unless a proposal row of any status
   * (open, approved, rejected) already exists for this text from THIS prompt
   * version: then it was already re-read, so no new LLM call and no repeat of a
   * proposal an admin rejected. A newer prompt version re-extracts again.
   *
   * @param contentHash the page text hash the crawl would ingest (defaults to
   *   the live doc's hash, which is the same text for an unchanged page)
   * @returns true when the page must go to extraction despite the same hash
   */
  async needsPromptReextract(
    countryCode: string,
    visaId: string,
    // Issue #68: the doc the caller already read this page (markRestored's
    // `doc`; `doc: undefined` = no doc). When given, no second read is made.
    known?: { doc: VisaType | undefined },
    contentHash?: string,
    // The stamp the page's adapter writes (extractionVersionFor); plain prompt version for non-GB.
    version: string = extractionVersionFor(undefined)
  ): Promise<boolean> {
    let existing: VisaType | undefined;
    if (known) {
      existing = known.doc;
    } else {
      const snap = await subcollections.visaTypes(countryCode).doc(visaId).get();
      existing = snap.exists ? (snap.data() as VisaType) : undefined;
    }
    if (!isPendingPromptStale(existing, version)) return false;
    // Approved visa: already turned into a proposal by this prompt version?
    if (existing?.reviewStatus === "approved") {
      const hash = contentHash ?? existing.scrapeMeta?.contentHash;
      if (hash && (await visaChangeService.hasProposalForHash(countryCode, visaId, hash, version))) {
        return false;
      }
    }
    return true;
  }

  /**
   * Write a validated extraction into the catalog as a pending-review scraped
   * visa. Returns what happened (created / updated / unchanged / skipped).
   *
   * Safety rules:
   *  - NEW visa (no doc): create it pending_review + inactive.
   *  - Existing SCRAPED + still pending_review: refresh it (safe — not live yet).
   *  - Existing SCRAPED + approved (not withdrawn): PROPOSE — stage a
   *    field-level edit in `pendingVisaChanges` for an admin (issue #61); the
   *    live doc is byte-for-byte untouched. See visa-catalog-changes.service.ts.
   *  - Seeded (no `source`), agent-authored, rejected scraped, or withdrawn
   *    (`staleSince`) docs: SKIP — never clobber curated/live data.
   *  - Same content hash as last time: unchanged, no write.
   *  The branch is decided by the pure planIngest() (visa-catalog-diff.ts).
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
    // Surcharges published on a linked page that this route's registry page
    // is marked with (issue #69), resolved once per run by the crawl
    // (LinkedSurchargeCache.forPage). Absent / [] = none. NOTE: callers then
    // pass `contentHash` = linkedGateHash(page hash, linked), so a change to
    // the linked page re-stages the visa like a change to its own page.
    linkedSurcharges?: PageLinkedSurcharge[];
    // Supplementary pages whose text was appended to the route text before
    // extraction (issue #86; build with supplementaryPagesMeta()). Recorded on
    // scrapeMeta.supplementaryPages. Absent / [] = none. As with linked
    // surcharges, `contentHash` is then supplementaryGateHash(...).
    supplementaryPages?: VisaSupplementaryPageMeta[];
    // Issue #82: the priced token usage of the extraction's LLM call, stored
    // on scrapeMeta (llmUsage / llmCostUsd). Absent = not recorded.
    llmUsage?: PricedUsage;
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
    // Linked surcharges (#69): appended in code as normal per-year components
    // (rate from the linked page x registry/extracted years) BEFORE the fee
    // is computed, so computeFee does the arithmetic like any other surcharge.
    // With no markers this returns the extraction's components unchanged.
    const linked = applyLinkedSurcharges(extracted, params.linkedSurcharges ?? []);
    const { baseCostUsd, feeMeta } = computeFee(linked.feeComponents, params.fx, now, {
      unverifiedReasons: linked.unverifiedReasons,
      linkedSurcharges: linked.meta,
    });

    // Issue #212: the version stamp of THIS page's adapter (GB carries +items-vN).
    const stamp = extractionVersionFor(params.sourceMeta?.sourceProvider);

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
      extractorPromptVersion: stamp,
      supplementaryPages: params.supplementaryPages,
      llmUsage: params.llmUsage,
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
    // Which branch this doc takes (unchanged / refresh / propose / skip).
    // Passing the running prompt version (issue #71) makes a PENDING scraped
    // doc extracted by an older prompt "refresh" even when the page hash is
    // the same — the crawl only re-extracts it for that reason (see
    // needsPromptReextract), so the new extraction must not be dropped as
    // "unchanged". Approved docs are unaffected by the version.
    const branch = planIngest(existing, contentHash, stamp);
    if (branch === "unchanged") {
      return { visaId, outcome: "unchanged" };
    }
    // Only refresh a visa that is still an unapproved scrape; never overwrite an
    // approved or agent-authored record.
    if (branch === "refresh") {
      // update() (not set+merge): a top-level `scrapeMeta` key REPLACES the
      // whole map. set(..., {merge:true}) would deep-merge it, leaving stale
      // keys from the previous extraction behind (e.g. an old totalUsd /
      // fxSource next to a new fxStale flag, or old citations). Other
      // top-level fields not in `fields` are kept — in particular an omitted
      // `baseCostUsd` (unconverted fee) stays UNCHANGED, as intended.
      // Review fix: when the NEW extraction supports no cost for a reason other
      // than FX (no published fee, or an unverified fee), DELETE the old
      // `baseCostUsd` — it would otherwise stay next to a fee block that no
      // longer supports it. (FX-flagged fees keep the old value unchanged, as
      // specified; the approval guard blocks them by the flag — EXCEPT a
      // manual cost (issue #70), which is deleted: it belonged to the old
      // content, see planManualCostOverwrite.)
      //
      // Issue #70: done in a TRANSACTION that re-reads the doc, so an admin's
      // manual cost written between our first read and this write is seen
      // (and its replacement recorded) instead of being lost silently.
      return this.runTransaction(async (tx) => {
        const fresh = await tx.get(ref);
        if (!fresh.exists) return { visaId, outcome: "skipped" as IngestOutcome };
        const current = fresh.data() as VisaType;
        // The doc may have moved on since the first read (approved, rejected,
        // already refreshed with this hash): re-plan and only write a refresh.
        // Same prompt version as the outer plan (issue #71): a prompt-only
        // re-extract (same page hash) must still plan "refresh" here, or the
        // new extraction would be dropped as "unchanged".
        const again = planIngest(current, contentHash, stamp);
        if (again === "unchanged") return { visaId, outcome: "unchanged" as IngestOutcome };
        if (again !== "refresh") return { visaId, outcome: "skipped" as IngestOutcome };

        // ---- Manual cost (issue #70) ----
        // CHANGED page (new content hash): the new extraction replaces the
        // manual cost through the normal path (its conversion, or its flags);
        // the replaced entry is kept as `replacedManualCost` and logged —
        // never a silent overwrite. SAME page (a prompt-only re-extract,
        // #71): the manual cost survives on top of the new extraction.
        const overwrite = planManualCostOverwrite({
          existingFee: current.scrapeMeta?.fee,
          existingContentHash: current.scrapeMeta?.contentHash,
          newFee: feeMeta,
          newBaseCostUsd: baseCostUsd,
          contentHash,
          now,
        });
        if (overwrite.replaced) {
          console.warn(
            `Manual USD cost ${overwrite.replaced.amountUsd} on ${countryCode}/${visaId} (set by ` +
              `${overwrite.replaced.setBy}) replaced by a re-scrape with changed content (${contentHash}); ` +
              (baseCostUsd === undefined ? "the new fee is not converted, cost removed" : `new cost ${baseCostUsd}`)
          );
        }

        // The cost to write: a kept manual cost wins over whatever the
        // extraction converted; otherwise the existing deletion rules.
        const costUpdate: Record<string, unknown> = {};
        if (overwrite.keptManualCostUsd !== undefined) {
          costUpdate.baseCostUsd = overwrite.keptManualCostUsd;
        } else if (
          overwrite.deleteCost ||
          (baseCostUsd === undefined &&
            !isFeeFxFlagged(feeMeta) &&
            Boolean(feeMeta.noPublishedFee || feeMeta.feeUnverified))
        ) {
          costUpdate.baseCostUsd = FieldValue.delete();
        }
        tx.update(ref, {
          ...fields,
          // Issue #86: processing days / maxExtensions the new extraction
          // left out (uncited) are deleted, not left at the old value.
          ...absentFieldDeletes(fields),
          ...costUpdate,
          sourceUrl,
          scrapeMeta: { ...scrapeMeta, fee: overwrite.fee },
          updatedAt: now,
        });
        return { visaId, outcome: "updated" as IngestOutcome };
      });
    }
    // Approved scraped visa whose page changed: propose, never write the live
    // doc. The changes service re-reads the doc + the open row in a
    // transaction, diffs, and creates / replaces the single open row (or
    // returns "unchanged" when there is no diff or the open row already has
    // this content hash).
    if (branch === "propose") {
      const outcome = await visaChangeService.proposeChange({
        countryCode,
        visaId,
        contentHash,
        sourceUrl,
        proposedFields: fields,
        proposedFee: feeMeta,
        proposedBaseCostUsd: baseCostUsd,
        scrapeMeta,
      });
      return { visaId, outcome };
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
   * so visaTypesCount / min cost / min days stay right — with the ONE
   * canonical stats function, `visaService.updateCountryStats` (issue #62
   * removed the duplicate catalog-side recompute that used to live here).
   * It uses update(), so a missing country doc throws instead of silently
   * creating a stub country with no name. That failure is logged and
   * swallowed here (same pattern as visaService.updateVisaReviewStatus): the
   * deactivation is already committed and the onVisaTypeUpdated trigger
   * reconciles, so the crawl still records the page as withdrawn rather than
   * as a page error.
   *
   * No auto-reactivation: if the guide later stops being withdrawn, nothing
   * here (or in ingest) flips the doc back on — markRestored() (issue #68)
   * only puts it back in the review queue, and a human re-approves it.
   */
  async markWithdrawn(countryCode: string, visaId: string): Promise<WithdrawnOutcome> {
    const ref = subcollections.visaTypes(countryCode).doc(visaId);
    const snap = await ref.get();
    const existing = snap.exists ? (snap.data() as VisaType) : undefined;
    const plan = planWithdrawnUpdate(existing, Timestamp.now());
    if (plan.update) {
      // update() (not set) — the doc is known to exist and must stay intact.
      await ref.update(plan.update);
    }
    // Stats only move when isActive flips ("unqueued" changes review fields
    // only, the doc was already inactive).
    if (plan.outcome === "deactivated") {
      // Stats recompute must not turn a committed withdrawal into a page
      // error (which would also count against the source's reliability).
      try {
        await visaService.updateCountryStats(countryCode);
      } catch (error) {
        console.error(
          `Withdrawal of ${countryCode}/${visaId} succeeded but the country stats recompute failed:`,
          error
        );
      }
    }
    // ---- Close open #61 proposals for this visa (issue #68 review fix) ----
    // A proposal made against the pre-withdrawal text must not resurface after
    // restore + re-approval. Run on EVERY withdrawn crawl of a scraped doc
    // (not only on the first, "deactivated" one), so a failed close is simply
    // retried next crawl. Logged + swallowed like the stats recompute: the
    // withdrawal itself is committed.
    if (existing?.source === "scraped") {
      try {
        await visaChangeService.closeOpenProposals(countryCode, visaId);
      } catch (error) {
        console.error(`Withdrawal of ${countryCode}/${visaId}: closing open proposals failed:`, error);
      }
    }
    return plan.outcome;
  }

  /**
   * Restored-source path (issue #68): the page fetched fine and is NOT
   * withdrawn. If the doc at `visaId` is a scraped visa that an earlier crawl
   * deactivated as withdrawn (inactive + `staleSince`) and it was approved,
   * put it back into the admin review queue (`reviewStatus: "pending_review"`)
   * so an admin finds out the guide came back. Rules in planRestoredUpdate().
   *
   * Called by both crawlers right after the withdrawn branch and BEFORE the
   * hash gate, so the signal is recorded whether or not the content hash
   * changed. It never reactivates (`isActive` and `staleSince` are left as
   * they are) and never touches stats (`isActive` does not change, so the
   * country's counts are unaffected). One doc read per non-withdrawn page;
   * a write only on the first crawl after a restore (afterwards the doc is
   * pending_review and the rule no longer matches).
   *
   * @returns `outcome` ("flagged" when the doc was put back in the queue,
   *   else "none") and `doc`, the doc after the update (undefined = no doc)
   */
  async markRestored(
    countryCode: string,
    visaId: string
  ): Promise<{ outcome: RestoredOutcome; doc: VisaType | undefined }> {
    const ref = subcollections.visaTypes(countryCode).doc(visaId);
    const snap = await ref.get();
    const existing = snap.exists ? (snap.data() as VisaType) : undefined;
    const plan = planRestoredUpdate(existing, Timestamp.now());
    // update() (not set): only the review fields change; the doc stays intact.
    if (plan.update) await ref.update(plan.update);
    // The doc AS IT NOW IS (the update merged in) — lets the orchestrator's
    // hash gate reuse this read for the #71 prompt check instead of reading
    // the same doc again (see needsPromptReextract's `known`).
    const doc = existing && plan.update ? { ...existing, ...plan.update } : existing;
    return { outcome: plan.outcome, doc };
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
   * Issue #61: then also re-converts OPEN pendingVisaChanges rows whose
   * proposed fee is fxStale / fxMissing (same arithmetic, no LLM call; see
   * visaChangeService.reconvertOpenProposals), counted separately.
   *
   * @returns how many visa docs were re-converted (cost written) / re-flagged,
   *   and the same for open proposals.
   */
  async reconvertFlaggedFees(fx: FxRatesDoc | undefined): Promise<{
    reconverted: number;
    reflagged: number;
    proposalsReconverted: number;
    proposalsReflagged: number;
  }> {
    const result = { reconverted: 0, reflagged: 0, proposalsReconverted: 0, proposalsReflagged: 0 };
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
        // Cheap pre-filter on the query snapshot (most docs need nothing).
        if (!planFeeReconvert(doc.data() as VisaType, fx, now)) continue;
        // Issue #70: re-read + re-plan in a TRANSACTION before writing. The
        // query snapshot can be minutes old by now (the loop spans every
        // country); an admin may have set a manual cost on this doc since, and
        // a plain update from the stale snapshot would replace that
        // `scrapeMeta.fee` (and `baseCostUsd`) wholesale — a silent overwrite.
        // planFeeReconvert itself refuses any fee with a `manualCost`.
        const outcome = await this.runTransaction(async (tx) => {
          const fresh = await tx.get(doc.ref);
          if (!fresh.exists) return "none" as const;
          const plan = planFeeReconvert(fresh.data() as VisaType, fx, now);
          if (!plan) return "none" as const;
          // Field-path update: replaces scrapeMeta.fee wholesale (clearing the
          // flags) without touching scrapeMeta.contentHash or anything else.
          const update: Record<string, unknown> = { "scrapeMeta.fee": plan.fee, updatedAt: now };
          if (plan.baseCostUsd !== undefined) update.baseCostUsd = plan.baseCostUsd;
          tx.update(doc.ref, update as FsUpdate);
          return plan.baseCostUsd !== undefined ? ("reconverted" as const) : ("reflagged" as const);
        });
        if (outcome === "reconverted") result.reconverted++;
        else if (outcome === "reflagged") result.reflagged++;
      }
    }
    // Flagged open proposals (issue #61), so they are not stuck forever.
    const proposals = await visaChangeService.reconvertOpenProposals(fx);
    result.proposalsReconverted = proposals.reconverted;
    result.proposalsReflagged = proposals.reflagged;
    return result;
  }
}

export const visaCatalogService = new VisaCatalogService();
