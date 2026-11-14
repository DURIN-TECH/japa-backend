import { FieldValue, Timestamp, Transaction } from "firebase-admin/firestore";
import { collections, db, subcollections } from "../../../utils/firebase";
import type { VisaType } from "../../../types";
import type { FxRatesDoc, PendingVisaChange, PendingVisaChangeStatus } from "../types";
import { assertVisaApprovable, isFeeFxFlagged, isFxFresh } from "../visa-catalog-fx";
import {
  ProposalInput,
  buildApprovalUpdate,
  eligibilityRemovalReason,
  findStaleReason,
  mergeProposal,
  planIngest,
  planProposalFeeReconvert,
  planProposalWrite,
} from "../visa-catalog-diff";
import { ProposalManualCostInput, planProposalManualCost } from "./visa-change-manual-cost";
// Canonical country-stats recompute. One-way import: visa.service.ts must
// never import this module or the catalog service (no circular import).
import { visaService } from "../../../services/visa.service";
import type { DocumentData, UpdateData } from "firebase-admin/firestore";
// Transaction.update() wants UpdateData<DocumentData>; the field maps built here are
// Record<string, unknown> (dotted paths + FieldValue sentinels), which tsc rejects.
type FsUpdate = UpdateData<DocumentData>;

// ============================================
// VISA CATALOG — PROPOSED EDITS TO LIVE VISAS (issue #61)
// ============================================
//
// Firestore side of `pendingVisaChanges`. The pure decisions (diff, which row
// to write, stale check, the approval payload) live in visa-catalog-diff.ts.
//
//  - proposeChange(): called by ingest for an APPROVED scraped visa whose page
//    changed. Stages / replaces the single open row in a transaction; the live
//    visa doc is never written.
//  - approveChange(): one transaction — reads the row + live doc, refuses a
//    stale or fee-flagged proposal, writes ONLY the diffed fields + scrapeMeta
//    + provenance to the visa and marks the row approved. Country stats are
//    recomputed after the commit (logged + swallowed on failure).
//  - rejectChange(): marks the row rejected with a reason; the live doc is
//    untouched and fee flags never block it.
//  - list/get for the admin queue, and reconvertOpenProposals() for flagged
//    proposed fees after an FX refresh.
//  - setManualCost() (issue #77): an admin sets the USD cost by hand on an
//    open proposal blocked by FEE_NOT_CONVERTED; the row's proposed fee then
//    passes approveChange's existing guard. See visa-change-manual-cost.ts.

/** Every valid row status (for query validation in the controller). */
export const PENDING_VISA_CHANGE_STATUSES: readonly PendingVisaChangeStatus[] = ["open", "approved", "rejected"];

/**
 * Issue #68: `resolvedBy` on a row the SYSTEM closed (not an admin uid), and
 * the reason written when the visa's source page was withdrawn. Uses the
 * existing #61 status semantics — the row becomes "rejected" (resolved, never
 * applied) with this reason — so no new status value is needed anywhere.
 */
export const SYSTEM_RESOLVER = "system";
export const SUPERSEDED_BY_WITHDRAWAL_REASON =
  "Superseded: the source page was withdrawn, so this proposed edit no longer reflects the source";

/** Default / max page size of the admin list. */
export const VISA_CHANGE_LIST_DEFAULT_LIMIT = 50;
export const VISA_CHANGE_LIST_MAX_LIMIT = 100;

/**
 * Typed error for the approve/reject/get paths. `code` + `httpStatus` are
 * what the controller sends:
 *  - NOT_FOUND (404): no such row (or an id Firestore can't address), or
 *    its visa doc is gone
 *  - ALREADY_RESOLVED (409): the row is not `open`
 *  - REVISION_MISMATCH (409): the admin reviewed an older revision of the row
 *  - STALE_PROPOSAL (409): the live doc changed since the proposal
 *  - ELIGIBILITY_REMOVED (409): approving would empty the eligibility list
 */
export class VisaChangeError extends Error {
  constructor(
    readonly code: "NOT_FOUND" | "ALREADY_RESOLVED" | "REVISION_MISMATCH" | "STALE_PROPOSAL" | "ELIGIBILITY_REMOVED",
    message: string,
    readonly httpStatus: number
  ) {
    super(message);
    this.name = "VisaChangeError";
  }
}

/** Shorthand for the "row is not open any more" error. */
function alreadyResolved(change: PendingVisaChange): VisaChangeError {
  return new VisaChangeError("ALREADY_RESOLVED", `This change is already ${change.status}`, 409);
}

/**
 * True when `id` is a usable Firestore document id. Firestore throws (→ a
 * 500) on ids containing "/", on "." / "..", on reserved `__x__` ids and on
 * ids over 1500 bytes; such an id can never name a row, so callers answer
 * 404 instead of letting the SDK throw.
 */
export function isValidDocId(id: unknown): id is string {
  return (
    typeof id === "string" &&
    id.length > 0 &&
    !id.includes("/") &&
    id !== "." &&
    id !== ".." &&
    !/^__.*__$/.test(id) &&
    Buffer.byteLength(id, "utf8") <= 1500
  );
}

/** The 404 for a missing / unaddressable row. */
function changeNotFound(): VisaChangeError {
  return new VisaChangeError("NOT_FOUND", "Visa change not found", 404);
}

/** Read a row snapshot as a typed PendingVisaChange (id from the doc id). */
function rowFrom(snap: { id: string; data: () => unknown }): PendingVisaChange {
  return { ...(snap.data() as PendingVisaChange), id: snap.id };
}

class VisaChangeService {
  /**
   * Transaction runner. Defaults to Firestore's; unit tests swap in an
   * in-memory one (writes buffered until the callback resolves, so a throw
   * writes nothing — same all-or-nothing contract).
   */
  runTransaction: <T>(fn: (tx: Transaction) => Promise<T>) => Promise<T> = (fn) => db.runTransaction(fn);

  /**
   * Stage (or replace) the open proposal for an approved scraped visa.
   *
   * Inside one transaction: re-read the live doc (it must still plan to
   * "propose" — otherwise "skipped"/"unchanged" and nothing is written) and
   * the open row for countryCode + visaId (equality-only query, no composite
   * index). Then create revision 1, replace the open row in place (revision
   * + 1, same id + createdAt), or write nothing (same hash as the open row,
   * or no diff). Rows are never deleted here.
   *
   * @returns "proposed" when a row was written, else "unchanged" / "skipped"
   */
  async proposeChange(input: ProposalInput): Promise<"proposed" | "unchanged" | "skipped"> {
    const visaRef = subcollections.visaTypes(input.countryCode).doc(input.visaId);
    const openQuery = collections.pendingVisaChanges
      .where("countryCode", "==", input.countryCode)
      .where("visaId", "==", input.visaId)
      .where("status", "==", "open")
      .limit(1);

    return this.runTransaction(async (tx) => {
      // ---- Reads (all before any write, as Firestore requires) ----
      const visaSnap = await tx.get(visaRef);
      const openSnap = await tx.get(openQuery);
      if (!visaSnap.exists) return "skipped";
      const live = visaSnap.data() as VisaType;
      // The doc may have changed since ingest's first read (e.g. withdrawn).
      // The prompt version lets a same-hash approved visa from an older prompt
      // still plan "propose" (issue #187); without it that would read "unchanged".
      const branch = planIngest(live, input.contentHash, input.scrapeMeta.extractorPromptVersion);
      if (branch === "unchanged") return "unchanged";
      if (branch !== "propose") return "skipped";
      const openRow = openSnap.docs[0] ? rowFrom(openSnap.docs[0]) : undefined;

      // ---- Plan + write ----
      const plan = planProposalWrite({ live, openRow, input, now: Timestamp.now() });
      if (plan.action === "none") {
        // Issue #187: the re-extraction found nothing to change but the live
        // doc was read by an older prompt. Record the current version on it
        // (one dotted key, no content change, no proposal) so it is not
        // re-extracted on every crawl.
        if (plan.stampVersion) tx.update(visaRef, { "scrapeMeta.extractorPromptVersion": plan.stampVersion });
        return "unchanged";
      }
      if (plan.action === "replace") {
        // set() (not merge): the replacement row is complete, and a stale key
        // from the previous revision (e.g. an old blockReason) must not linger.
        tx.set(collections.pendingVisaChanges.doc(plan.id), plan.row);
      } else {
        tx.set(collections.pendingVisaChanges.doc(), plan.row);
      }
      return "proposed";
    });
  }

  /**
   * Admin queue: rows with `status`, optionally one country, newest first.
   * Uses the composite indexes (status, createdAt desc) and
   * (countryCode, status, createdAt desc) in firestore.indexes.json.
   */
  async listChanges(params: {
    status: PendingVisaChangeStatus;
    countryCode?: string;
    limit: number;
  }): Promise<PendingVisaChange[]> {
    let query = collections.pendingVisaChanges.where("status", "==", params.status);
    if (params.countryCode) query = query.where("countryCode", "==", params.countryCode);
    const snap = await query.orderBy("createdAt", "desc").limit(params.limit).get();
    return snap.docs.map(rowFrom);
  }

  /** One row by id, or null. */
  async getChange(id: string): Promise<PendingVisaChange | null> {
    if (!isValidDocId(id)) return null;
    const snap = await collections.pendingVisaChanges.doc(id).get();
    return snap.exists ? rowFrom(snap) : null;
  }

  /**
   * Approve a proposal in ONE transaction (never partially applied):
   *  1. read the row + the live visa doc → 404 if either is missing (or the
   *     id is unaddressable), 409 ALREADY_RESOLVED if the row is not open,
   *     409 REVISION_MISMATCH when `expectedRevision` is given and differs
   *     from the row's revision (the crawl replaced the row after the admin
   *     looked at it);
   *  2. stale check (findStaleReason) → 409 STALE_PROPOSAL, nothing written,
   *     the row stays open;
   *  3. fee guard: assertVisaApprovable on the merged doc → throws
   *     VisaFeeNotConvertibleError (controller maps it to 409); then 409
   *     ELIGIBILITY_REMOVED if it would empty the eligibility list;
   *  4. write only the diffed fields + scrapeMeta + sourceUrl +
   *     lastVerifiedAt + reviewedBy/At + updatedAt to the visa, and mark the
   *     row approved (resolvedBy, resolvedAt, appliedFields).
   * After the commit the country stats are recomputed with
   * visaService.updateCountryStats; a failure there is logged and swallowed
   * (the approval is committed; the onVisaTypeUpdated trigger reconciles).
   *
   * @param expectedRevision optional: the revision the admin reviewed
   * @returns the updated visa doc
   */
  async approveChange(id: string, reviewerUid: string, expectedRevision?: number): Promise<VisaType> {
    if (!isValidDocId(id)) throw changeNotFound();
    const rowRef = collections.pendingVisaChanges.doc(id);

    const { countryCode, visaId, diff, sourceUrl } = await this.runTransaction(async (tx) => {
      const rowSnap = await tx.get(rowRef);
      if (!rowSnap.exists) throw changeNotFound();
      const change = rowFrom(rowSnap);
      const visaRef = subcollections.visaTypes(change.countryCode).doc(change.visaId);
      const visaSnap = await tx.get(visaRef);
      if (change.status !== "open") throw alreadyResolved(change);
      // Optimistic check: the admin approves exactly the revision they saw.
      if (expectedRevision !== undefined && expectedRevision !== change.revision) {
        throw new VisaChangeError(
          "REVISION_MISMATCH",
          `This change is now at revision ${change.revision} (you reviewed ${expectedRevision}). Reload and review it again.`,
          409
        );
      }
      if (!visaSnap.exists) throw new VisaChangeError("NOT_FOUND", "Visa type not found", 404);
      const live = visaSnap.data() as VisaType;

      // ---- Stale check: the live doc must be what the proposal was made against ----
      const stale = findStaleReason(live, change);
      if (stale) throw new VisaChangeError("STALE_PROPOSAL", stale, 409);

      // ---- Fee guard on the would-be merged doc (throws, nothing written) ----
      assertVisaApprovable(mergeProposal(live, change) as Pick<VisaType, "source" | "scrapeMeta" | "baseCostUsd">);
      // ---- Never empty a live visa's eligibility list ----
      const eligibility = eligibilityRemovalReason(live, change);
      if (eligibility) throw new VisaChangeError("ELIGIBILITY_REMOVED", eligibility, 409);

      // ---- Writes ----
      const now = Timestamp.now();
      const { update, appliedFields } = buildApprovalUpdate(change, reviewerUid, now, Array.isArray(live.requiredDocuments) ? live.requiredDocuments : []);
      tx.update(visaRef, update as FsUpdate);
      tx.update(rowRef, {
        status: "approved",
        resolvedBy: reviewerUid,
        resolvedAt: now,
        appliedFields,
        updatedAt: now,
      });
      return { countryCode: change.countryCode, visaId: change.visaId, diff: change.diff, sourceUrl: change.proposedSourceUrl ?? change.sourceUrl ?? null };
    });

    // ---- After commit: record the approved change for rule-change alerts (#123) ----
    // OUTSIDE the transaction, and its failure is logged and swallowed: it can
    // never fail or roll back the approval. Only this APPROVE path records an
    // event; a rejected or still-open proposal triggers nothing. Imported
    // lazily so the services layer is not loaded while this module is (it
    // reaches back into the scrapers barrel).
    try {
      const { ruleChangeAlertsService } = await import("../../../services/rule-change-alerts.service");
      await ruleChangeAlertsService.recordVisaChangeApproved({ changeId: id, countryCode, visaId, diff, sourceUrl, approvedBy: reviewerUid });
    } catch (error) {
      console.error(`Approval of visa change ${id} (${countryCode}/${visaId}) committed but recording its rule-change alert failed:`, error);
    }

    // ---- After commit: stats follow an edited cost / processing days ----
    try {
      await visaService.updateCountryStats(countryCode);
    } catch (error) {
      console.error(
        `Approval of visa change ${id} (${countryCode}/${visaId}) committed but the country stats recompute failed:`,
        error
      );
    }

    const updated = await subcollections.visaTypes(countryCode).doc(visaId).get();
    return { ...(updated.data() as VisaType), id: visaId };
  }

  /**
   * Set the USD cost of an OPEN, fee-blocked proposal by hand (issue #77,
   * PUT /admin/visa-changes/:id/manual-cost). ONE transaction:
   *  1. read the row + the live visa doc → the same checks, in the same order,
   *     as approveChange: 404 NOT_FOUND (row, or unaddressable id), 409
   *     ALREADY_RESOLVED, 409 REVISION_MISMATCH (the crawl replaced the row
   *     after the admin looked), 404 (visa gone), 409 STALE_PROPOSAL (setting
   *     a cost on a proposal that can never be approved helps no one);
   *  2. planProposalManualCost (pure): 409 FEE_ALREADY_CONVERTED when the fee
   *     guard does not block it, 400 when the rates do not match the fee's
   *     currencies;
   *  3. write the patch on the ROW only (revision + 1, proposedScrapeMeta
   *     with the manual fee, proposed/diff baseCostUsd, approvable,
   *     blockReason, updatedAt).
   * The live visa is never written here. The revision IS bumped (review
   * fix): an approve sent with the revision seen before this cost was set /
   * changed answers 409 REVISION_MISMATCH. The admin then approves the new
   * revision through the normal approveChange, whose guard accepts the cost.
   *
   * The returned row is built INSIDE the transaction from the row it read
   * plus the patch it wrote, so it is exactly what was committed (no
   * second read that a concurrent crawl could slip in front of).
   *
   * @param id row id
   * @param input validated body (parseProposalManualCostInput)
   * @param setBy admin uid
   * @returns the row as committed (with the new `revision`)
   * @throws VisaChangeError / ManualCostError — nothing written
   */
  async setManualCost(id: string, input: ProposalManualCostInput, setBy: string): Promise<PendingVisaChange> {
    if (!isValidDocId(id)) throw changeNotFound();
    const rowRef = collections.pendingVisaChanges.doc(id);

    return this.runTransaction(async (tx) => {
      // ---- Reads (all before any write) ----
      const rowSnap = await tx.get(rowRef);
      if (!rowSnap.exists) throw changeNotFound();
      const change = rowFrom(rowSnap);
      const visaSnap = await tx.get(subcollections.visaTypes(change.countryCode).doc(change.visaId));

      // ---- Row state: same checks + order as approveChange ----
      if (change.status !== "open") throw alreadyResolved(change);
      if (input.expectedRevision !== change.revision) {
        throw new VisaChangeError(
          "REVISION_MISMATCH",
          `This change is now at revision ${change.revision} (you reviewed ${input.expectedRevision}). Reload and review it again.`,
          409
        );
      }
      if (!visaSnap.exists) throw new VisaChangeError("NOT_FOUND", "Visa type not found", 404);
      const live = visaSnap.data() as VisaType;
      const stale = findStaleReason(live, change);
      if (stale) throw new VisaChangeError("STALE_PROPOSAL", stale, 409);

      // ---- Decide (throws → nothing written) + write ----
      const patch = planProposalManualCost(change, live, input, setBy, Timestamp.now());
      // No blockReason in the patch = approvable: delete the stored one.
      tx.update(rowRef, { ...patch, blockReason: patch.blockReason ?? FieldValue.delete() });

      // ---- The committed row (read + patch), for the response ----
      const row: PendingVisaChange = { ...change, ...patch };
      if (patch.blockReason === undefined) delete row.blockReason;
      return row;
    });
  }

  /**
   * Reject a proposal with a reason (the controller validates it is
   * non-blank). Marks the row rejected (rejectionReason, resolvedBy,
   * resolvedAt) in a transaction; the live visa doc is never read or
   * written, and fee flags never block a rejection.
   *
   * @returns the updated row
   */
  async rejectChange(id: string, reviewerUid: string, reason: string): Promise<PendingVisaChange> {
    if (!isValidDocId(id)) throw changeNotFound();
    const rowRef = collections.pendingVisaChanges.doc(id);
    await this.runTransaction(async (tx) => {
      const rowSnap = await tx.get(rowRef);
      if (!rowSnap.exists) throw changeNotFound();
      const change = rowFrom(rowSnap);
      if (change.status !== "open") throw alreadyResolved(change);
      const now = Timestamp.now();
      tx.update(rowRef, {
        status: "rejected",
        rejectionReason: reason,
        resolvedBy: reviewerUid,
        resolvedAt: now,
        updatedAt: now,
      });
    });
    const after = await rowRef.get();
    return rowFrom(after);
  }

  /**
   * Issue #68 (review fix): close every OPEN proposal for a visa whose source
   * page was just seen withdrawn.
   *
   * Why: a row opened before the withdrawal would otherwise stay open through
   * withdraw → restore → re-approve; if the restored text is byte-identical
   * the pending doc is not refreshed, so after re-approval findStaleReason
   * passes again and an admin could apply an edit the source no longer says.
   *
   * Each row is resolved as "rejected" with SUPERSEDED_BY_WITHDRAWAL_REASON
   * and resolvedBy SYSTEM_RESOLVER (the #61 "resolved, not applied" state),
   * re-read in its own transaction so a row an admin resolved meanwhile is
   * left alone. The live visa doc is never touched. Equality-only query
   * (countryCode, visaId, status) — same as proposeChange, no composite index.
   *
   * @returns how many rows were closed
   */
  async closeOpenProposals(countryCode: string, visaId: string): Promise<number> {
    const open = await collections.pendingVisaChanges
      .where("countryCode", "==", countryCode)
      .where("visaId", "==", visaId)
      .where("status", "==", "open")
      .get();
    let closed = 0;
    for (const row of open.docs) {
      const rowRef = collections.pendingVisaChanges.doc(row.id);
      const didClose = await this.runTransaction(async (tx) => {
        const snap = await tx.get(rowRef);
        // Gone, or already resolved by an admin since the query: nothing to do.
        if (!snap.exists || rowFrom(snap).status !== "open") return false;
        const now = Timestamp.now();
        tx.update(rowRef, {
          status: "rejected",
          rejectionReason: SUPERSEDED_BY_WITHDRAWAL_REASON,
          resolvedBy: SYSTEM_RESOLVER,
          resolvedAt: now,
          updatedAt: now,
        });
        return true;
      });
      if (didClose) closed++;
    }
    return closed;
  }

  /**
   * Issue #68 (manual crawl hash gate): has a proposal row — of ANY status
   * (open, approved, rejected) — already been made for this visa from this
   * exact page text (`contentHash`)?
   *
   * An approved scraped visa's own `scrapeMeta.contentHash` only moves when a
   * proposal is APPROVED, so while a proposal is open, or after it was
   * rejected, the live doc's hash stays the old one. A gate that only looks
   * at the live doc would then re-extract the page on every manual run (an
   * LLM call each time), and after a rejection it would even re-propose the
   * text the admin just turned down. A row with this hash means "this text
   * was already turned into a proposal": nothing new to extract.
   *
   * Issue #187: with `extractorPromptVersion` the row must ALSO have been made
   * by that prompt version. The prompt-bump re-extract of an approved visa asks
   * this, so an open, approved or rejected row for this text + this version
   * means "already re-read": no new LLM call and, after a rejection, no new
   * identical proposal. A newer prompt version has no such row and re-extracts.
   *
   * Equality-only query (countryCode, visaId, contentHash[, extractorPromptVersion])
   * + limit(1): served by Firestore's single-field indexes, no composite index
   * needed (same as the open-row lookup in proposeChange).
   */
  async hasProposalForHash(
    countryCode: string,
    visaId: string,
    contentHash: string,
    extractorPromptVersion?: string
  ): Promise<boolean> {
    let query = collections.pendingVisaChanges
      .where("countryCode", "==", countryCode)
      .where("visaId", "==", visaId)
      .where("contentHash", "==", contentHash);
    if (extractorPromptVersion) query = query.where("extractorPromptVersion", "==", extractorPromptVersion);
    const snap = await query.limit(1).get();
    return !snap.empty;
  }

  /**
   * Re-convert OPEN proposals whose proposed fee is fxStale / fxMissing,
   * from their stored components with the run's (fresh) rate doc — no LLM
   * call. Updates proposedScrapeMeta.fee, proposed.baseCostUsd, the fee diff
   * entry, approvable and blockReason, so a flagged proposal is not stuck
   * forever. Each row is re-read with its live visa in a transaction (it may
   * have been resolved or replaced meanwhile). Rows whose visa is gone are
   * left alone (approve would 404 anyway).
   *
   * Scans `status == "open"` (single-field equality: no composite index).
   */
  async reconvertOpenProposals(fx: FxRatesDoc | undefined): Promise<{ reconverted: number; reflagged: number }> {
    const result = { reconverted: 0, reflagged: 0 };
    if (!isFxFresh(fx, Timestamp.now())) return result;
    const open = await collections.pendingVisaChanges.where("status", "==", "open").get();
    for (const doc of open.docs) {
      const row = rowFrom(doc);
      if (!isFeeFxFlagged(row.proposedScrapeMeta?.fee)) continue;
      const outcome = await this.runTransaction(async (tx) => {
        const fresh = await tx.get(doc.ref);
        if (!fresh.exists) return null;
        const change = rowFrom(fresh);
        const visaSnap = await tx.get(subcollections.visaTypes(change.countryCode).doc(change.visaId));
        if (!visaSnap.exists) return null;
        const patch = planProposalFeeReconvert(change, visaSnap.data() as VisaType, fx, Timestamp.now());
        if (!patch) return null;
        tx.update(doc.ref, patch as FsUpdate);
        return (patch.proposed as Record<string, unknown>).baseCostUsd !== undefined ? "reconverted" : "reflagged";
      });
      if (outcome) result[outcome]++;
    }
    return result;
  }
}

export const visaChangeService = new VisaChangeService();
