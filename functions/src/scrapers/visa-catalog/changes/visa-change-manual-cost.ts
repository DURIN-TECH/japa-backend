import { FieldValue, Timestamp } from "firebase-admin/firestore";
import type { VisaType } from "../../../types";
import type { PendingVisaChange, VisaFieldDiff, VisaScrapeMeta } from "../types";
import { VisaFeeNotConvertibleError, assertVisaApprovable } from "../visa-catalog-fx";
import { mergeProposal, proposalApprovability } from "../visa-catalog-diff";
import {
  ManualCostError,
  ManualCostFields,
  buildManualCostFee,
  parseManualCostFields,
} from "../visa-manual-cost";

// ============================================
// MANUAL USD COST ON A PROPOSED EDIT TO A LIVE VISA (issue #77)
// ============================================
//
// A proposed edit (#61, `pendingVisaChanges`) whose new fee the scraper could
// not convert to USD is blocked: approve answers 409 FEE_NOT_CONVERTED. Before
// #77 it could only be rejected. This module lets an admin set the USD cost by
// hand, exactly as #70 does for a pending scraped visa:
//
//   PUT /admin/visa-changes/:id/manual-cost  (visa-change.controller.ts)
//     → visaChangeService.setManualCost (one Firestore transaction)
//     → parseProposalManualCostInput + planProposalManualCost (here, pure)
//
// Shared with #70 (visa-manual-cost.ts), not duplicated:
//  - parseManualCostFields: amountUsd / reason / rates validation;
//  - buildManualCostFee: the rates-match check, the `manualCost` audit block
//    (setBy, setAt, rates, reason, previous, supersedes) and the new fee block.
//
// The write puts the cost where the EXISTING approve path already looks, so
// approveChange is unchanged: `proposedScrapeMeta.fee` (fxSource "manual",
// totalUsd = amountUsd, no flags, manualCost) and `proposed.baseCostUsd =
// Math.round(amountUsd)` on the fee diff entry. On approve, buildApprovalUpdate
// writes that baseCostUsd and the fee block to the live visa.
//
// Overwrite rule: a later crawl with CHANGED page text replaces the open row
// (planProposalWrite), and with it the manual cost. That is recorded on the
// new row as `replacedManualCost` (visa-catalog-diff.ts), never silent. The
// SAME page text writes nothing, so the manual cost stays.
//
// Firebase-free apart from Timestamp / FieldValue sentinels: unit-testable
// without an emulator.

// ----- Input -----

/** The validated body of PUT /admin/visa-changes/:id/manual-cost. */
export interface ProposalManualCostInput extends ManualCostFields {
  // The row revision the admin reviewed (integer >= 1). REQUIRED, unlike on
  // approve: the cost is set against one specific proposed fee, and a newer
  // revision may have different components / currencies. Mismatch → 409
  // REVISION_MISMATCH.
  expectedRevision: number;
}

/**
 * Validate the raw request body. Throws ManualCostError(VALIDATION_ERROR)
 * naming the first bad field. `countryCode` / `expectedContentHash` are not
 * needed here (the row knows its visa; `expectedRevision` is the optimistic
 * check) and are ignored if sent.
 */
export function parseProposalManualCostInput(body: unknown): ProposalManualCostInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ManualCostError("VALIDATION_ERROR", "Request body must be a JSON object", 400);
  }
  const b = body as Record<string, unknown>;

  // ---- amountUsd / reason / rates: the #70 rules, shared ----
  const fields = parseManualCostFields(b);

  // ---- expectedRevision: required positive integer ----
  const rev = b.expectedRevision;
  if (typeof rev !== "number" || !Number.isInteger(rev) || rev < 1) {
    throw new ManualCostError("VALIDATION_ERROR", "expectedRevision is required: the row revision you reviewed (a positive integer)", 400);
  }
  return { ...fields, expectedRevision: rev };
}

// ----- Planning the row write -----

/** The fields setManualCost writes on the row (tx.update payload). */
export interface ProposalManualCostPatch {
  proposedScrapeMeta: VisaScrapeMeta; // with the manual fee block (wholesale)
  proposed: Partial<VisaType>; // + baseCostUsd = round(amountUsd)
  current: Partial<VisaType>; // + live baseCostUsd if a fee entry had to be added
  diff: VisaFieldDiff[]; // fee entry's baseCostUsdAfter = round(amountUsd)
  approvable: boolean; // recomputed (may stay false: e.g. ELIGIBILITY_REMOVED)
  blockReason: string | FieldValue; // FieldValue.delete() when approvable
  updatedAt: Timestamp;
}

/**
 * True when the proposal is blocked by the FEE guard (assertVisaApprovable on
 * the merged doc throws VisaFeeNotConvertibleError, code FEE_NOT_CONVERTED).
 * Other blocks (eligibility) do not count: a manual cost would not help them.
 */
function isFeeBlocked(live: Partial<VisaType>, change: PendingVisaChange): boolean {
  try {
    assertVisaApprovable(mergeProposal(live, change) as Pick<VisaType, "source" | "scrapeMeta" | "baseCostUsd">);
    return false;
  } catch (e) {
    if (e instanceof VisaFeeNotConvertibleError) return true;
    throw e;
  }
}

/**
 * Decide the row write for a manual cost on an OPEN proposal, or throw.
 *
 * The caller (visaChangeService.setManualCost) has already checked, in its
 * transaction: the row exists and is open (404 / 409 ALREADY_RESOLVED), the
 * revision matches (409 REVISION_MISMATCH), the visa exists (404) and the
 * proposal is not stale (409 STALE_PROPOSAL) — the same order as approve.
 *
 * Refused here with 409 FEE_ALREADY_CONVERTED (the #70 code) when the
 * proposal is not fee-blocked and carries no earlier manual cost to correct:
 * a manual value must not quietly replace a verified conversion. Then
 * buildManualCostFee checks the rates (400) and builds the block.
 *
 * The fee diff entry gets `baseCostUsdAfter`. A fee-blocked proposal almost
 * always has one; if it does not (the live fee was carried forward and is
 * itself unusable, e.g. a pre-#59 live doc), one is added with no component
 * changes and `current.baseCostUsd` = the live value, so approve's stale
 * check still covers the field it writes.
 *
 * @param change the open row (as read in the transaction)
 * @param live the live visa doc (as read in the transaction)
 * @param input validated body
 * @param setBy admin uid
 * @param now injected clock
 */
export function planProposalManualCost(
  change: PendingVisaChange,
  live: Partial<VisaType>,
  input: ProposalManualCostInput,
  setBy: string,
  now: Timestamp
): ProposalManualCostPatch {
  const oldFee = change.proposedScrapeMeta?.fee;

  // ---- Only when the fee guard blocks approval (or to correct a manual cost) ----
  if (!oldFee?.manualCost && !isFeeBlocked(live, change)) {
    throw new ManualCostError(
      "FEE_ALREADY_CONVERTED",
      "This proposal already has a USD cost converted from the published fee; a manual cost is only for fees the scraper could not convert",
      409
    );
  }

  // ---- Rates check + manual fee block (shared with #70) ----
  const plan = buildManualCostFee({
    oldFee,
    baseCostUsd: change.proposed?.baseCostUsd,
    contentHash: change.proposedScrapeMeta?.contentHash ?? change.contentHash,
    input,
    setBy,
    now,
  });

  // ---- The fee diff entry carries the new cost ----
  const current: Record<string, unknown> = { ...(change.current as Record<string, unknown>) };
  let sawFee = false;
  const diff = change.diff.map((d): VisaFieldDiff => {
    if (d.field !== "fee") return d;
    sawFee = true;
    return { ...d, baseCostUsdAfter: plan.baseCostUsd };
  });
  if (!sawFee) {
    const entry: Extract<VisaFieldDiff, { field: "fee" }> = {
      field: "fee",
      kind: "changed",
      components: [],
      baseCostUsdAfter: plan.baseCostUsd,
    };
    if (typeof live.baseCostUsd === "number") {
      entry.baseCostUsdBefore = live.baseCostUsd;
      current.baseCostUsd = live.baseCostUsd;
    }
    diff.push(entry);
  }

  const proposed = { ...(change.proposed as Record<string, unknown>), baseCostUsd: plan.baseCostUsd };
  const proposedScrapeMeta: VisaScrapeMeta = { ...change.proposedScrapeMeta, fee: plan.fee };

  // ---- Recompute the block with the SAME guards approve runs ----
  const next = { diff, proposed: proposed as Partial<VisaType>, proposedScrapeMeta };
  const { approvable, blockReason } = proposalApprovability(live, next);

  return {
    proposedScrapeMeta,
    proposed: proposed as Partial<VisaType>,
    current: current as Partial<VisaType>,
    diff,
    approvable,
    blockReason: blockReason ?? FieldValue.delete(),
    updatedAt: now,
  };
}
