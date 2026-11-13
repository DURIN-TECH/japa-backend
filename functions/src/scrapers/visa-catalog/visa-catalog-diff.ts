import { FieldValue, Timestamp } from "firebase-admin/firestore";
import type { VisaType } from "../../types";
import type {
  FeeComponentDiff,
  FxRatesDoc,
  PendingVisaChange,
  VisaFeeComponentMeta,
  VisaFeeMeta,
  RequiredDocumentMetaChange,
  RequiredDocumentMetaView,
  VisaFieldDiff,
  VisaScalarDiffField,
  VisaScrapeMeta,
} from "./types";
import { alignScrapeMetaToLive } from "./required-document-align";
import {
  findMetaForItem,
  itemKey,
  metaFromQuoteOnly,
  type RequiredDocumentMeta,
} from "./required-document-meta";
import { assertVisaApprovable, planFeeReconvert } from "./visa-catalog-fx";
import { markManualCostReplaced } from "./visa-manual-cost";

// ============================================
// VISA CATALOG — PROPOSED-EDIT DIFF + PLANNING (pure, issue #61)
// ============================================
//
// Everything the "propose edits to live visas" flow DECIDES, kept free of
// Firestore I/O so it is unit-testable without an emulator (`Timestamp` and
// `FieldValue` sentinels work without Admin init). The reads/writes and the
// transactions live in visa-catalog-changes.service.ts.
//
// Flow recap:
//  - ingest: an approved scraped visa whose page changed → diffVisa() against
//    the live doc → planProposalWrite() (create / replace the one open row /
//    nothing). The live doc is never written by ingest.
//  - approve: findStaleReason() → mergeProposal() + assertVisaApprovable() →
//    buildApprovalUpdate() (only diffed fields + scrapeMeta + provenance).
//  - re-convert: planProposalFeeReconvert() for an open row whose proposed
//    fee had no usable exchange rate.

// ----- Compared fields -----

/**
 * Scalar fields the diff compares. Registry-owned identity (`id`,
 * `countryCode`, `code`) and review/lifecycle state (`isActive`,
 * `reviewStatus`, `source`, `reviewedBy/At`, `agentIds`, `staleSince`,
 * `createdAt`) are never compared and never written by a proposal.
 */
export const COMPARED_SCALAR_FIELDS: readonly VisaScalarDiffField[] = [
  "name",
  "description",
  "category",
  "processingTime",
  "processingDaysMin",
  "processingDaysMax",
  "validityPeriod",
  "isExtendable",
  "maxExtensions",
  "applicationUrl",
  "applicationInstructions",
];

// ----- Equality helpers -----

/** Trim strings so whitespace-only edits are not a diff; other values as is. */
function normalizeScalar(v: unknown): unknown {
  return typeof v === "string" ? v.trim() : v;
}

/**
 * Structural equality for stored values: primitives, arrays, plain objects
 * and Firestore Timestamps (compared by value). Used for the approve-time
 * stale check, where `current` holds the live values captured verbatim.
 */
export function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof Timestamp && b instanceof Timestamp) return a.isEqual(b);
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => valuesEqual(x, b[i]));
  }
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    return (
      ka.length === kb.length &&
      ka.every((k) => valuesEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
    );
  }
  return false;
}

/** Match key for a fee component: kind + trimmed label + currency. */
function feeKey(c: VisaFeeComponentMeta): string {
  return `${c.kind}|${c.label.trim()}|${c.currency}`;
}

/** Same component value in its own currency (amount, per, years). */
function sameFeeComponent(a: VisaFeeComponentMeta, b: VisaFeeComponentMeta): boolean {
  return a.amount === b.amount && a.per === b.per && (a.years ?? null) === (b.years ?? null);
}

/**
 * Diff two fee-component lists. Components are matched by kind + label +
 * currency (duplicates of one key are paired in source order); a matched pair
 * with a different amount / per / years is "changed", unmatched ones are
 * "added" / "removed". An empty result means the fee is unchanged — even if
 * the exchange rate (and therefore `totalUsd`) moved.
 */
export function diffFeeComponents(
  live: VisaFeeComponentMeta[],
  proposed: VisaFeeComponentMeta[]
): FeeComponentDiff[] {
  // Bucket the live components by key, preserving order for pairing.
  const liveByKey = new Map<string, VisaFeeComponentMeta[]>();
  for (const c of live) {
    const k = feeKey(c);
    liveByKey.set(k, [...(liveByKey.get(k) ?? []), c]);
  }
  const out: FeeComponentDiff[] = [];
  for (const after of proposed) {
    const bucket = liveByKey.get(feeKey(after));
    const before = bucket?.shift();
    if (!before) out.push({ change: "added", after });
    else if (!sameFeeComponent(before, after)) out.push({ change: "changed", before, after });
  }
  // Whatever is left in the live buckets has no proposed counterpart.
  for (const bucket of liveByKey.values()) for (const before of bucket) out.push({ change: "removed", before });
  return out;
}

// ----- The diff -----

/** Result of diffing an extraction against the live visa doc. */
export interface VisaDiffResult {
  diff: VisaFieldDiff[]; // empty = no proposal
  current: Partial<VisaType>; // live values of the diffed fields
  proposed: Partial<VisaType>; // proposed values of the diffed fields
  // The fee block for proposedScrapeMeta: the NEW fee when the fee diffed,
  // else the live one carried forward (so FX drift alone never edits a visa).
  proposedFee: VisaFeeMeta;
}

/**
 * Field-level diff of an extraction against the live doc (rules in the
 * module header and issue #61):
 *  - scalars: strict equality after trimming strings; absent vs present is a
 *    change (`before` / `after` omitted on the absent side);
 *  - eligibilityCriteria: trimmed set; a pure reorder is not a diff;
 *  - requiredDocuments (#129): trimmed, case-insensitive set; same reorder rule;
 *  - fee: components compared in their own currency; unchanged components
 *    keep the live `baseCostUsd` + `scrapeMeta.fee`. A live doc without
 *    `scrapeMeta.fee` (pre-#59) counts the fee as changed.
 *
 * @param live the live visa doc
 * @param proposedFields extractedToVisaFields() output for the new extraction
 * @param proposedFee computeFee().feeMeta for the new extraction
 * @param proposedBaseCostUsd computeFee().baseCostUsd (undefined = no usable cost)
 */
export function diffVisa(params: {
  live: Partial<VisaType>;
  proposedFields: Partial<VisaType>;
  proposedFee: VisaFeeMeta;
  proposedBaseCostUsd?: number;
  // Issue #187: the new extraction's per-item classification, index-aligned
  // with `proposedFields.requiredDocuments`. Absent = nothing to compare.
  proposedMeta?: RequiredDocumentMeta[];
}): VisaDiffResult {
  const { live, proposedFields } = params;
  const liveRec = live as Record<string, unknown>;
  const propRec = proposedFields as Record<string, unknown>;
  const diff: VisaFieldDiff[] = [];
  const current: Record<string, unknown> = {};
  const proposed: Record<string, unknown> = {};

  // ---- Scalars ----
  for (const field of COMPARED_SCALAR_FIELDS) {
    const before = liveRec[field];
    const after = propRec[field];
    if (before === undefined && after === undefined) continue;
    if (before !== undefined && after !== undefined && normalizeScalar(before) === normalizeScalar(after)) continue;
    // Build the entry with only the sides that exist (never `undefined`).
    // Present → absent is flagged "removed": approving deletes the field.
    const entry: { field: VisaScalarDiffField; kind: "changed" | "removed"; before?: unknown; after?: unknown } = {
      field,
      kind: after === undefined ? "removed" : "changed",
    };
    if (before !== undefined) {
      entry.before = before;
      current[field] = before;
    }
    if (after !== undefined) {
      entry.after = after;
      proposed[field] = after;
    }
    diff.push(entry);
  }

  // ---- eligibilityCriteria (trimmed set) ----
  const liveCriteria = Array.isArray(live.eligibilityCriteria) ? live.eligibilityCriteria : [];
  const propCriteria = Array.isArray(proposedFields.eligibilityCriteria) ? proposedFields.eligibilityCriteria : [];
  const liveSet = new Set(liveCriteria.map((s) => String(s).trim()));
  const propSet = new Set(propCriteria.map((s) => String(s).trim()));
  const added = [...propSet].filter((s) => !liveSet.has(s));
  const removed = [...liveSet].filter((s) => !propSet.has(s));
  if (added.length || removed.length) {
    diff.push({ field: "eligibilityCriteria", kind: "changed", added, removed });
    // Live value verbatim (stale check) and the FULL proposed array, in order.
    if (live.eligibilityCriteria !== undefined) current.eligibilityCriteria = live.eligibilityCriteria;
    proposed.eligibilityCriteria = propCriteria;
  }

  // ---- requiredDocuments (trimmed, case-insensitive set; issue #129) ----
  // Keyed by the normalised form (trim + collapse whitespace + lower-case) but
  // reported with the original text. Absent live + empty proposed = no diff, so
  // a record whose page never lists documents never gets a proposal.
  const docKey = (s: unknown) => String(s).trim().replace(/\s+/g, " ").toLowerCase();
  const liveDocs = Array.isArray(live.requiredDocuments) ? live.requiredDocuments : [];
  const propDocs = Array.isArray(proposedFields.requiredDocuments) ? proposedFields.requiredDocuments : [];
  const liveDocKeys = new Set(liveDocs.map(docKey));
  const propDocKeys = new Set(propDocs.map(docKey));
  const docsAdded = propDocs.filter((s, i) => !liveDocKeys.has(docKey(s)) && propDocs.findIndex((x) => docKey(x) === docKey(s)) === i);
  const docsRemoved = liveDocs.filter((s, i) => !propDocKeys.has(docKey(s)) && liveDocs.findIndex((x) => docKey(x) === docKey(s)) === i);
  if (docsAdded.length || docsRemoved.length) {
    diff.push({
      field: "requiredDocuments",
      kind: "changed",
      added: docsAdded.map((s) => String(s).trim()),
      removed: docsRemoved.map((s) => String(s).trim()),
    });
    // Live value verbatim (stale check). The FULL proposed list is applied;
    // when it is empty the key is left OUT of `proposed`, which approve turns
    // into a field delete (the page no longer lists any document).
    if (live.requiredDocuments !== undefined) current.requiredDocuments = live.requiredDocuments;
    if (propDocs.length > 0) proposed.requiredDocuments = propDocs;
  }

  // ---- requiredDocumentMeta (issue #187): kind / need of items that stay ----
  // Compared item by item BY TEXT (never by position): the live reading is the
  // stored meta for that item, or "document + kindReview" with need from the
  // stored quote when it has none. Items new to the list are covered by the
  // requiredDocuments diff above; only items on BOTH sides are compared here.
  const metaChanges = diffItemMeta(live, propDocs, params.proposedMeta);
  if (metaChanges.length > 0) {
    diff.push({ field: "requiredDocumentMeta", kind: "changed", changes: metaChanges });
  }

  // ---- Fee ----
  const liveFee = live.scrapeMeta?.fee;
  // Pre-#59 doc: no stored fee block → every proposed component is new, and
  // the fee counts as changed even when the page lists no component.
  const components: FeeComponentDiff[] = liveFee
    ? diffFeeComponents(liveFee.components ?? [], params.proposedFee.components)
    : params.proposedFee.components.map((after) => ({ change: "added" as const, after }));
  const feeChanged = !liveFee || components.length > 0;
  if (feeChanged) {
    const entry: Extract<VisaFieldDiff, { field: "fee" }> = { field: "fee", kind: "changed", components };
    if (typeof live.baseCostUsd === "number") {
      entry.baseCostUsdBefore = live.baseCostUsd;
      current.baseCostUsd = live.baseCostUsd;
    }
    if (params.proposedBaseCostUsd !== undefined) {
      entry.baseCostUsdAfter = params.proposedBaseCostUsd;
      proposed.baseCostUsd = params.proposedBaseCostUsd;
    }
    diff.push(entry);
  }

  return {
    diff,
    current: current as Partial<VisaType>,
    proposed: proposed as Partial<VisaType>,
    // Unchanged fee → carry the live block forward untouched (incl. its
    // totalUsd / fx provenance), so approving keeps baseCostUsd consistent.
    proposedFee: feeChanged || !liveFee ? params.proposedFee : liveFee,
  };
}


// ----- Item classification diff (issue #187) -----

/** The fields of a meta entry a reviewer compares. */
function metaView(m: RequiredDocumentMeta): RequiredDocumentMetaView {
  return {
    kind: m.kind,
    need: m.need,
    ...(m.appliesWhen ? { appliesWhen: m.appliesWhen } : {}),
    ...(m.kindReview ? { kindReview: true as const } : {}),
  };
}

/** Same classification (kind, need, clause, review flag). */
function sameView(a: RequiredDocumentMetaView, b: RequiredDocumentMetaView): boolean {
  return a.kind === b.kind && a.need === b.need && a.appliesWhen === b.appliesWhen && !!a.kindReview === !!b.kindReview;
}

/**
 * Items present in BOTH the live list and the proposed list whose
 * classification differs. Pure; [] when there is no proposed meta.
 */
function diffItemMeta(
  live: Partial<VisaType>,
  proposedDocs: string[],
  proposedMeta: RequiredDocumentMeta[] | undefined
): RequiredDocumentMetaChange[] {
  if (!Array.isArray(proposedMeta) || proposedMeta.length === 0) return [];
  const liveDocs = Array.isArray(live.requiredDocuments) ? live.requiredDocuments : [];
  const liveMeta = live.scrapeMeta?.requiredDocumentMeta;
  const out: RequiredDocumentMetaChange[] = [];
  proposedDocs.forEach((name, j) => {
    const after = proposedMeta[j];
    const i = liveDocs.findIndex((x) => itemKey(String(x)) === itemKey(name));
    if (!after || i < 0) return;
    const stored = findMetaForItem(liveMeta, i, String(liveDocs[i]), liveDocs.length);
    const before = stored ?? metaFromQuoteOnly(live.scrapeMeta?.citations?.[`requiredDocuments.${i}`], String(liveDocs[i]));
    const b = metaView(before);
    const a = metaView(after);
    if (!sameView(b, a)) out.push({ item: name, before: b, after: a });
  });
  return out;
}

// ----- Which ingest branch a doc takes -----

/** What ingest does with one extraction, by the state of the doc at its id. */
export type IngestPlan =
  | "create" // no doc: new pending_review scraped visa
  | "unchanged" // same content hash as the live doc's scrapeMeta: no write
  | "refresh" // scraped + pending_review: refresh in place (not live yet)
  | "propose" // scraped + approved + not withdrawn: stage a pendingVisaChanges row
  | "skip"; // seeded / agent / rejected scraped / withdrawn (staleSince): never touched

/**
 * Issue #71: is this doc a PENDING SCRAPED visa whose stored extraction was
 * produced by an older extractor prompt than `currentPromptVersion`?
 *
 * Such a doc must be re-extracted even when its page text is unchanged:
 * otherwise a prompt change (e.g. #59's fee components) never reaches it, and
 * a pre-#59 doc (no fee block, no `extractorPromptVersion` at all) stays
 * blocked by the approval guard forever. A missing version counts as stale.
 *
 * Which docs:
 *  - pending_review scraped docs: always (refreshed in place);
 *  - APPROVED scraped docs (issue #187), when not withdrawn and they list
 *    documents: re-extracted so they get the kind/need reading. This never
 *    writes the live doc: the result is only a pendingVisaChanges proposal,
 *    and only when the classification (or another field) actually differs,
 *    so admins are not flooded with prompt-only "edits";
 *  - seeded / agent / rejected docs are never touched by the crawl at all.
 *
 * Pure (the current version is passed in, not imported), so this module stays
 * free of the extractor's DeepSeek client and is unit-testable.
 *
 * @param existing the doc at the resolved id (undefined = no doc yet)
 * @param currentPromptVersion EXTRACTOR_PROMPT_VERSION of the running code
 */
export function isPendingPromptStale(
  existing: Pick<VisaType, "source" | "reviewStatus" | "scrapeMeta" | "staleSince" | "requiredDocuments"> | undefined,
  currentPromptVersion: string
): boolean {
  if (!existing) return false; // nothing stored → the normal "create" path
  if (existing.source !== "scraped") return false;
  if (existing.scrapeMeta?.extractorPromptVersion === currentPromptVersion) return false;
  if (existing.reviewStatus === "pending_review") return true;
  // Issue #187: an APPROVED scraped visa (not withdrawn) that lists documents is
  // re-extracted too, so it gets its kind/need reading. Its result only ever
  // becomes a proposal. A visa with no documents has nothing to classify, so it
  // is not re-extracted on every prompt bump.
  return (
    existing.reviewStatus === "approved" &&
    !existing.staleSince &&
    Array.isArray(existing.requiredDocuments) &&
    existing.requiredDocuments.length > 0
  );
}

/**
 * Issue #68: the manual crawl script's hash gate for an APPROVED scraped doc.
 *
 * Ingest never writes an approved doc's `scrapeMeta.contentHash` (a changed
 * page becomes a #61 proposal instead; the live hash only moves when an
 * admin approves that proposal). Comparing the fetched hash with the live
 * doc's alone therefore re-extracts such a page on EVERY manual run. This
 * rule says the text was already handled when the doc takes ingest's
 * "propose" branch (scraped + approved + not withdrawn) and either:
 *  - `pageLastContentHash` (the registry page's hash, written by the
 *    scheduled orchestrator after it processed the page) equals it — the
 *    same gate the orchestrator itself uses; or
 *  - `hasProposalForHash`: a pendingVisaChanges row (any status) was already
 *    made from this text (see VisaChangeService.hasProposalForHash).
 *
 * Pending / seeded / agent / rejected / withdrawn docs → false (they keep the
 * script's existing gate: live hash + the #71 prompt-version rule).
 * Pure; the caller does the lookups (and may skip the query when the cheap
 * page-hash check already answers).
 */
export function isApprovedTextAlreadyHandled(
  existing: Pick<VisaType, "source" | "reviewStatus" | "staleSince"> | undefined,
  fetchedHash: string,
  seen: { pageLastContentHash?: string; hasProposalForHash?: boolean }
): boolean {
  // Only docs that ingest would PROPOSE for (mirrors planIngest's "propose").
  if (!existing || existing.source !== "scraped") return false;
  if (existing.reviewStatus !== "approved" || existing.staleSince) return false;
  return seen.pageLastContentHash === fetchedHash || seen.hasProposalForHash === true;
}

/**
 * Decide the ingest branch. Seeded `uk-*` docs (no `source`) and agent docs
 * are never touched by the crawl; a withdrawn scraped doc (`staleSince`)
 * gets no proposal ("source came back" is #68's job).
 *
 * `currentPromptVersion` (issue #71, optional): when given, a pending scraped
 * doc with the SAME content hash but an older `extractorPromptVersion` is
 * "refresh"ed instead of "unchanged", so a re-extraction made because of a
 * prompt bump is actually written. Callers that omit it (e.g. the #61
 * proposal transaction, which only ever handles approved docs) keep the plain
 * content-hash rule.
 */
export function planIngest(
  existing: Pick<VisaType, "source" | "reviewStatus" | "staleSince" | "scrapeMeta"> | undefined,
  contentHash: string,
  currentPromptVersion?: string
): IngestPlan {
  if (!existing) return "create";
  if (existing.scrapeMeta?.contentHash === contentHash) {
    // Same page text. A scraped doc from an older prompt is re-processed: a
    // pending one is refreshed in place (not live yet), an APPROVED one goes
    // through the normal proposal path so an admin approves the new reading
    // (issue #187: never auto-applied).
    if (currentPromptVersion !== undefined && isPendingPromptStale(existing, currentPromptVersion)) {
      return existing.reviewStatus === "approved" ? "propose" : "refresh";
    }
    return "unchanged";
  }
  if (existing.source !== "scraped") return "skip";
  if (existing.reviewStatus === "pending_review") return "refresh";
  if (existing.reviewStatus === "approved" && !existing.staleSince) return "propose";
  return "skip";
}

// ----- Merging + approvability -----

/** The visa field a diff entry writes (`fee` writes `baseCostUsd`). */
export function diffTargetField(d: VisaFieldDiff): keyof VisaType {
  // `requiredDocumentMeta` is not a visa field (it lives in scrapeMeta): every
  // caller skips it before writing a field (see isMetaDiff).
  return d.field === "fee" ? "baseCostUsd" : (d.field as keyof VisaType);
}

/** True for the #187 classification diff, which writes no visa field of its own. */
function isMetaDiff(d: VisaFieldDiff): boolean {
  return d.field === "requiredDocumentMeta";
}

/**
 * The visa as it would look after approving: live doc + every diffed field
 * (removed when absent from `proposed`) + `proposedScrapeMeta` wholesale.
 * Used for the fee guard (assertVisaApprovable) at proposal time and again
 * inside the approve transaction.
 */
export function mergeProposal(
  live: Partial<VisaType>,
  change: Pick<PendingVisaChange, "diff" | "proposed" | "proposedScrapeMeta">
): Partial<VisaType> {
  const merged: Record<string, unknown> = { ...live };
  const proposed = change.proposed as Record<string, unknown>;
  for (const d of change.diff) {
    if (isMetaDiff(d)) continue; // classification only: carried by scrapeMeta below
    const field = diffTargetField(d);
    if (proposed[field] !== undefined) merged[field] = proposed[field];
    else delete merged[field];
  }
  merged.scrapeMeta = change.proposedScrapeMeta;
  return merged as Partial<VisaType>;
}

/** blockReason when a proposal would empty a live visa's eligibility list. */
export const ELIGIBILITY_REMOVED_MESSAGE =
  "Proposal would remove all eligibility criteria. Check the source page, then reject or wait for the next crawl.";

/**
 * Non-fee safety rule (review fix): a proposal must never wipe out ALL of a
 * live visa's eligibility criteria — an extraction that found none is far
 * more likely a bad read than a real policy change. Returns the reason when
 * the merged doc would have no criteria while the live doc has some, else
 * null. (Other omitted optional scalars may still propose a deletion; those
 * are marked `kind: "removed"` in the diff.)
 */
export function eligibilityRemovalReason(
  live: Partial<VisaType>,
  change: Pick<PendingVisaChange, "diff" | "proposed" | "proposedScrapeMeta">
): string | null {
  const liveHas = Array.isArray(live.eligibilityCriteria) && live.eligibilityCriteria.length > 0;
  if (!liveHas) return null;
  const merged = mergeProposal(live, change).eligibilityCriteria;
  return Array.isArray(merged) && merged.length > 0 ? null : ELIGIBILITY_REMOVED_MESSAGE;
}

/**
 * Whether a proposal could be approved, and why not. Runs the SAME guards as
 * approval on the merged doc: assertVisaApprovable (fxStale / fxMissing /
 * feeUnverified / noPublishedFee and baseCostUsd vs Math.round(totalUsd)),
 * then eligibilityRemovalReason.
 */
export function proposalApprovability(
  live: Partial<VisaType>,
  change: Pick<PendingVisaChange, "diff" | "proposed" | "proposedScrapeMeta">
): { approvable: boolean; blockReason?: string } {
  try {
    assertVisaApprovable(mergeProposal(live, change) as Pick<VisaType, "source" | "scrapeMeta" | "baseCostUsd">);
  } catch (err) {
    return { approvable: false, blockReason: (err as Error).message };
  }
  const eligibility = eligibilityRemovalReason(live, change);
  return eligibility ? { approvable: false, blockReason: eligibility } : { approvable: true };
}

// ----- Ingest: create / replace / nothing -----

/** Inputs for one proposal write (everything ingest computed). */
export interface ProposalInput {
  countryCode: string;
  visaId: string;
  contentHash: string;
  sourceUrl: string;
  proposedFields: Partial<VisaType>;
  proposedFee: VisaFeeMeta;
  proposedBaseCostUsd?: number;
  scrapeMeta: VisaScrapeMeta; // built for the new extraction (fee replaced by the diff's choice)
}

/** What the proposal transaction writes. */
export type ProposalWritePlan =
  | { action: "none" } // same hash as the open row, or no diff
  | { action: "create"; row: Omit<PendingVisaChange, "id"> }
  | { action: "replace"; id: string; row: Omit<PendingVisaChange, "id"> };

/**
 * Plan the pendingVisaChanges write for one extraction of an approved
 * scraped visa:
 *  - same contentHash as the open row → nothing (already proposed);
 *  - no diff → nothing (an existing open row is left as is);
 *  - an open row exists → replace it in place (same id + createdAt,
 *    revision + 1, resolution fields never set);
 *  - else create revision 1.
 * Never returns undefined values in `row`.
 */
export function planProposalWrite(params: {
  live: Partial<VisaType>;
  openRow?: PendingVisaChange;
  input: ProposalInput;
  now: Timestamp;
}): ProposalWritePlan {
  const { live, openRow, input, now } = params;
  // Same page AND same prompt version as the open row = already proposed. A
  // newer prompt version over the same page is a new reading (issue #187).
  if (
    openRow &&
    openRow.contentHash === input.contentHash &&
    openRow.extractorPromptVersion === input.scrapeMeta.extractorPromptVersion
  ) {
    return { action: "none" };
  }

  const result = diffVisa({
    live,
    proposedFields: input.proposedFields,
    proposedFee: input.proposedFee,
    proposedBaseCostUsd: input.proposedBaseCostUsd,
    proposedMeta: input.scrapeMeta.requiredDocumentMeta,
  });
  if (result.diff.length === 0) return { action: "none" };

  // Full scrapeMeta for the approve-time wholesale replace, with the fee the
  // diff chose (new one, or the live block carried forward).
  const proposedScrapeMeta: VisaScrapeMeta = { ...input.scrapeMeta, fee: result.proposedFee };
  const change = { diff: result.diff, proposed: result.proposed, proposedScrapeMeta };
  const { approvable, blockReason } = proposalApprovability(live, change);

  const row: Omit<PendingVisaChange, "id"> = {
    countryCode: input.countryCode,
    visaId: input.visaId,
    changeType: "update",
    status: "open",
    revision: openRow ? (openRow.revision ?? 1) + 1 : 1,
    diff: result.diff,
    current: result.current,
    proposed: result.proposed,
    proposedScrapeMeta,
    proposedSourceUrl: input.sourceUrl,
    citations: proposedScrapeMeta.citations,
    confidence: proposedScrapeMeta.confidence,
    sourceUrl: input.sourceUrl,
    contentHash: input.contentHash,
    model: proposedScrapeMeta.model,
    approvable,
    createdAt: openRow?.createdAt ?? now,
    updatedAt: now,
  };
  // Optional fields only when defined — Firestore never sees `undefined`.
  if (proposedScrapeMeta.extractorPromptVersion) row.extractorPromptVersion = proposedScrapeMeta.extractorPromptVersion;
  if (live.scrapeMeta?.contentHash) row.currentContentHash = live.scrapeMeta.contentHash;
  if (blockReason) row.blockReason = blockReason;

  // ---- Issue #77: a replaced manual cost is recorded, never silent ----
  // A new extraction (changed content hash: same hash returned "none" above)
  // replaces the open row wholesale, including any manual cost an admin set
  // on its proposed fee. Keep that entry on the new row as
  // `replacedManualCost`; otherwise carry an earlier record forward.
  const replacedManual = openRow?.proposedScrapeMeta?.fee?.manualCost;
  if (replacedManual) {
    row.replacedManualCost = markManualCostReplaced(replacedManual, input.contentHash, now);
  } else if (openRow?.replacedManualCost) {
    row.replacedManualCost = openRow.replacedManualCost;
  }

  return openRow ? { action: "replace", id: openRow.id, row } : { action: "create", row };
}

// ----- Approve: stale check + the write -----

/**
 * Why approving `change` against the CURRENT live doc would be unsafe, or
 * null when it is not stale:
 *  - the live doc is no longer an approved scraped visa, or was withdrawn
 *    (`staleSince`);
 *  - any diffed field's live value no longer equals `current[field]`;
 *  - the live scrapeMeta moved since the proposal (`currentContentHash`), so
 *    the carried-forward parts of `proposedScrapeMeta` are out of date.
 *
 * Each reason is a full sentence ending in a full stop (issue #88): the portal
 * slots it between two of its own sentences in the STALE_PROPOSAL error box
 * ("…older version. <reason> Reject it, or wait…"), so a missing stop ran the
 * sentences together ("…was made Reject it…").
 */
export function findStaleReason(live: Partial<VisaType>, change: PendingVisaChange): string | null {
  if (live.source !== "scraped" || live.reviewStatus !== "approved") {
    return "The live visa is no longer an approved scraped visa.";
  }
  if (live.staleSince) return "The live visa was withdrawn at source (staleSince is set).";
  const liveRec = live as Record<string, unknown>;
  const current = (change.current ?? {}) as Record<string, unknown>;
  for (const d of change.diff) {
    if (isMetaDiff(d)) continue; // no visa field to compare (the content hash guards scrapeMeta)
    const field = diffTargetField(d);
    if (!valuesEqual(liveRec[field], current[field])) {
      return `The live value of "${field}" changed since this proposal was made.`;
    }
  }
  if ((live.scrapeMeta?.contentHash ?? undefined) !== (change.currentContentHash ?? undefined)) {
    return "The live visa's scrape provenance changed since this proposal was made.";
  }
  return null;
}

/**
 * The update() payload that applies an approved proposal to the live doc:
 * ONLY the diffed fields (absent in `proposed` → FieldValue.delete()), plus
 * `scrapeMeta` (a top-level key in update() replaces the map wholesale),
 * `sourceUrl`, `lastVerifiedAt`, `reviewedBy`, `reviewedAt`, `updatedAt`.
 * `isActive`, `reviewStatus`, `source`, `code`, `agentIds` and `createdAt`
 * are never in it. A fee diff writes `baseCostUsd` next to the new
 * `scrapeMeta.fee`, in the same write.
 *
 * @returns the payload and `appliedFields` (the visa fields written from the diff)
 */
export function buildApprovalUpdate(
  change: Pick<PendingVisaChange, "diff" | "proposed" | "proposedScrapeMeta" | "proposedSourceUrl">,
  reviewerUid: string,
  now: Timestamp,
  // Issue #187: the LIVE `requiredDocuments` (before this update). When given,
  // the new scrapeMeta's document quotes and classifications are re-keyed to the
  // list the visa will have AFTER the update (see required-document-align.ts).
  liveRequiredDocuments?: string[]
): { update: Record<string, unknown>; appliedFields: string[] } {
  const update: Record<string, unknown> = {};
  const appliedFields: string[] = [];
  const proposed = change.proposed as Record<string, unknown>;
  for (const d of change.diff) {
    if (isMetaDiff(d)) continue; // classification only: written through scrapeMeta below
    const field = diffTargetField(d);
    update[field] = proposed[field] !== undefined ? proposed[field] : FieldValue.delete();
    appliedFields.push(field);
  }
  // The documents list the visa has after this update: the proposed one when
  // the list is part of the diff (empty = deleted), else the live one.
  const docsInDiff = change.diff.some((d) => d.field === "requiredDocuments");
  const finalDocs = docsInDiff
    ? (Array.isArray(proposed.requiredDocuments) ? (proposed.requiredDocuments as string[]) : [])
    : liveRequiredDocuments;
  update.scrapeMeta = finalDocs
    ? alignScrapeMetaToLive(change.proposedScrapeMeta, finalDocs)
    : change.proposedScrapeMeta;
  update.sourceUrl = change.proposedSourceUrl;
  update.lastVerifiedAt = now;
  // The approver is recorded on the visa too (checkpoint-1 decision).
  update.reviewedBy = reviewerUid;
  update.reviewedAt = now;
  update.updatedAt = now;
  return { update, appliedFields };
}

// ----- Re-converting a flagged open proposal (no LLM call) -----

/**
 * For an OPEN proposal whose proposed fee is fxStale / fxMissing, re-convert
 * it from its stored components with `fx` (reusing planFeeReconvert's
 * arithmetic) and return the fields to write on the row: `proposedScrapeMeta`
 * (new fee), `proposed` (+/- baseCostUsd), `diff` (fee entry's
 * baseCostUsdAfter), `approvable` and `blockReason` (FieldValue.delete()
 * when it became approvable). Null when nothing changes.
 */
export function planProposalFeeReconvert(
  change: PendingVisaChange,
  live: Partial<VisaType>,
  fx: FxRatesDoc | undefined,
  now: Timestamp
): Record<string, unknown> | null {
  if (change.status !== "open") return null;
  // planFeeReconvert only re-converts pending scraped docs; present the
  // proposal's fee in that shape to reuse its rules and arithmetic unchanged.
  const plan = planFeeReconvert(
    { source: "scraped", reviewStatus: "pending_review", scrapeMeta: change.proposedScrapeMeta },
    fx,
    now
  );
  if (!plan) return null;

  const proposedScrapeMeta: VisaScrapeMeta = { ...change.proposedScrapeMeta, fee: plan.fee };
  const proposed: Record<string, unknown> = { ...(change.proposed as Record<string, unknown>) };
  if (plan.baseCostUsd !== undefined) proposed.baseCostUsd = plan.baseCostUsd;
  else delete proposed.baseCostUsd;
  const diff = change.diff.map((d): VisaFieldDiff => {
    if (d.field !== "fee") return d;
    // Drop the old baseCostUsdAfter; set it again only when it now converts.
    const rest = { ...d };
    delete rest.baseCostUsdAfter;
    return plan.baseCostUsd !== undefined ? { ...rest, baseCostUsdAfter: plan.baseCostUsd } : rest;
  });
  const next = { diff, proposed: proposed as Partial<VisaType>, proposedScrapeMeta };
  const { approvable, blockReason } = proposalApprovability(live, next);
  return {
    proposedScrapeMeta,
    proposed,
    diff,
    approvable,
    blockReason: blockReason ?? FieldValue.delete(),
    updatedAt: now,
  };
}
