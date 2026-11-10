// ============================================
// Unit tests — pure proposed-edit diff + planning (issue #61)
// ============================================
//
// Run with `npm test`. Pure: no Firestore, no network. Covers
// services/visa-catalog-diff.ts:
//  - diffVisa: scalar change, absent→present / present→absent, whitespace
//    only, eligibility add/remove/reorder-only, fee component
//    add/remove/change, FX-only drift = no diff, pre-#59 doc (no fee block),
//    no diff at all, never-compared fields
//  - planIngest: each doc state → branch
//  - planProposalWrite: create / replace in place (revision+1, createdAt
//    kept) / same hash / no diff; approvable + blockReason for flagged fees
//  - findStaleReason, mergeProposal, buildApprovalUpdate (only diffed fields)
//  - planProposalFeeReconvert

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { FieldValue, Timestamp } from "firebase-admin/firestore";

import type { VisaType } from "../src/types";
import type { ExtractedFeeComponent, ExtractedVisa, FxRatesDoc, PendingVisaChange } from "../src/types/visa-catalog";
import {
  FEE_MISSING_COST_MESSAGE,
  FEE_NOT_CONVERTED_MESSAGE,
  FX_SOURCE_ECB,
  computeFee,
} from "../src/services/visa-catalog-fx";
import { buildScrapeMeta, extractedToVisaFields } from "../src/services/visa-catalog-meta";
import {
  ELIGIBILITY_REMOVED_MESSAGE,
  buildApprovalUpdate,
  diffFeeComponents,
  diffVisa,
  findStaleReason,
  isApprovedTextAlreadyHandled,
  isPendingPromptStale,
  mergeProposal,
  planIngest,
  planProposalFeeReconvert,
  planProposalWrite,
  ProposalInput,
} from "../src/services/visa-catalog-diff";

// ----- Fixtures -----

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Timestamp.now();
const isoDaysAgo = (d: number) => new Date(Date.now() - d * DAY_MS).toISOString().slice(0, 10);
/** Fresh rates (GBP 0.8 per USD → £1 = $1.25). */
const fx = (gbpPerUsd = 0.8): FxRatesDoc => ({
  base: "USD",
  rates: { GBP: gbpPerUsd },
  fetchedAt: NOW,
  rateDate: isoDaysAgo(1),
  source: FX_SOURCE_ECB,
});
/** Stale rates (fetched 8 days ago). */
const staleFx = (): FxRatesDoc => ({ ...fx(), fetchedAt: Timestamp.fromMillis(Date.now() - 8 * DAY_MS), rateDate: isoDaysAgo(10) });

const FEE: ExtractedFeeComponent[] = [
  { kind: "application", label: "Application fee", amount: 800, currency: "GBP", per: "application" },
  { kind: "surcharge", label: "Immigration Health Surcharge", amount: 1000, currency: "GBP", per: "year", years: 2 },
];

/** A validated extraction (override any field). */
function extraction(over: Partial<ExtractedVisa> = {}): ExtractedVisa {
  return {
    name: "Skilled Worker visa",
    code: "SW",
    description: "Work in the UK for an approved employer.",
    category: "work",
    processingTime: "3 weeks",
    processingDaysMin: 15,
    processingDaysMax: 21,
    feeComponents: FEE,
    validityPeriod: "5 years",
    isExtendable: true,
    eligibilityCriteria: ["Job offer", "English B1"],
    applicationUrl: "https://www.gov.uk/skilled-worker-visa/apply",
    confidence: 0.9,
    citations: { name: "Skilled Worker visa" },
    ...over,
  } as ExtractedVisa;
}

/** What ingest computes for an extraction (fields + fee + scrapeMeta). */
function ingestInput(e: ExtractedVisa, hash: string, rates: FxRatesDoc | undefined = fx()): ProposalInput {
  const { baseCostUsd, feeMeta } = computeFee(e.feeComponents, rates, NOW);
  return {
    countryCode: "GB",
    visaId: "gb-skilled-worker",
    contentHash: hash,
    sourceUrl: "https://www.gov.uk/skilled-worker-visa",
    proposedFields: extractedToVisaFields({ countryCode: "GB", visaId: "gb-skilled-worker", code: "SW", extracted: e, baseCostUsd }),
    proposedFee: feeMeta,
    proposedBaseCostUsd: baseCostUsd,
    scrapeMeta: buildScrapeMeta({
      sourceUrl: "https://www.gov.uk/skilled-worker-visa",
      routeName: "Skilled Worker visa",
      model: "stub-model",
      contentHash: hash,
      extracted: e,
      extractedAt: NOW,
      fee: feeMeta,
      extractorPromptVersion: "v-test",
    }),
  };
}

/** A LIVE approved scraped doc built from an extraction (as ingest + approve would). */
function liveDoc(e: ExtractedVisa = extraction(), hash = "h1", rates: FxRatesDoc = fx()): VisaType {
  const input = ingestInput(e, hash, rates);
  return {
    ...input.proposedFields,
    ...(input.proposedBaseCostUsd !== undefined ? { baseCostUsd: input.proposedBaseCostUsd } : {}),
    source: "scraped",
    reviewStatus: "approved",
    isActive: true,
    agentIds: ["a1"],
    sourceUrl: input.sourceUrl,
    scrapeMeta: input.scrapeMeta,
    createdAt: NOW,
    updatedAt: NOW,
  } as VisaType;
}

/** Diff a live doc against an extraction. */
function diffOf(live: VisaType, e: ExtractedVisa, rates: FxRatesDoc | undefined = fx()) {
  const input = ingestInput(e, "h2", rates);
  return diffVisa({
    live,
    proposedFields: input.proposedFields,
    proposedFee: input.proposedFee,
    proposedBaseCostUsd: input.proposedBaseCostUsd,
  });
}

/** Build a stored row from a create/replace plan. */
function rowOf(plan: ReturnType<typeof planProposalWrite>, id = "c1"): PendingVisaChange {
  assert.notEqual(plan.action, "none");
  if (plan.action === "none") throw new Error("unreachable");
  return { ...plan.row, id: plan.action === "replace" ? plan.id : id };
}

// ----- diffVisa -----

describe("diffVisa", () => {
  test("identical extraction → no diff", () => {
    const r = diffOf(liveDoc(), extraction());
    assert.deepEqual(r.diff, []);
  });

  test("scalar change → before/after, current/proposed hold only that field", () => {
    const r = diffOf(liveDoc(), extraction({ processingDaysMax: 30 }));
    assert.deepEqual(r.diff, [{ field: "processingDaysMax", kind: "changed", before: 21, after: 30 }]);
    assert.deepEqual(r.current, { processingDaysMax: 21 });
    assert.deepEqual(r.proposed, { processingDaysMax: 30 });
  });

  test("whitespace-only string change is not a diff", () => {
    const r = diffOf(liveDoc(), extraction({ name: "  Skilled Worker visa " }));
    assert.deepEqual(r.diff, []);
  });

  test("absent → present: `before` omitted; present → absent: kind \"removed\", `after` omitted", () => {
    const added = diffOf(liveDoc(), extraction({ applicationInstructions: "Apply online" }));
    assert.deepEqual(added.diff, [{ field: "applicationInstructions", kind: "changed", after: "Apply online" }]);
    assert.equal("applicationInstructions" in added.current, false);

    const removed = diffOf(liveDoc(), extraction({ applicationUrl: undefined }));
    assert.deepEqual(removed.diff, [
      { field: "applicationUrl", kind: "removed", before: "https://www.gov.uk/skilled-worker-visa/apply" },
    ]);
    assert.equal("applicationUrl" in removed.proposed, false);
  });

  test("eligibility: add/remove lists, full proposed array applied; reorder-only is no diff", () => {
    const r = diffOf(liveDoc(), extraction({ eligibilityCriteria: ["English B1", "Salary £38,700"] }));
    assert.deepEqual(r.diff, [
      { field: "eligibilityCriteria", kind: "changed", added: ["Salary £38,700"], removed: ["Job offer"] },
    ]);
    assert.deepEqual(r.proposed.eligibilityCriteria, ["English B1", "Salary £38,700"]);
    assert.deepEqual(r.current.eligibilityCriteria, ["Job offer", "English B1"]);

    const reorder = diffOf(liveDoc(), extraction({ eligibilityCriteria: [" English B1", "Job offer "] }));
    assert.deepEqual(reorder.diff, []);
  });

  test("fee component changed → fee diff with baseCostUsd before/after", () => {
    const fee2 = [{ ...FEE[0], amount: 900 }, FEE[1]];
    const r = diffOf(liveDoc(), extraction({ feeComponents: fee2 }));
    assert.equal(r.diff.length, 1);
    const d = r.diff[0] as any;
    assert.equal(d.field, "fee");
    assert.equal(d.components.length, 1);
    assert.equal(d.components[0].change, "changed");
    assert.equal(d.components[0].before.amount, 800);
    assert.equal(d.components[0].after.amount, 900);
    assert.equal(d.baseCostUsdBefore, 3500); // (800 + 2000) / 0.8
    assert.equal(d.baseCostUsdAfter, 3625); // (900 + 2000) / 0.8
    assert.deepEqual(r.current, { baseCostUsd: 3500 });
    assert.deepEqual(r.proposed, { baseCostUsd: 3625 });
    assert.equal(r.proposedFee.components[0].amount, 900);
  });

  test("fee component added / removed", () => {
    const comps = diffFeeComponents(
      computeFee(FEE, fx(), NOW).feeMeta.components,
      computeFee(
        [FEE[0], { kind: "surcharge", label: "Priority", amount: 500, currency: "GBP", per: "application" }],
        fx(),
        NOW
      ).feeMeta.components
    );
    assert.deepEqual(
      comps.map((c) => c.change),
      ["added", "removed"]
    );
  });

  test("FX-only drift (same components, different rate) is NOT a diff; live fee carried forward", () => {
    const live = liveDoc();
    const r = diffOf(live, extraction(), fx(0.75));
    assert.deepEqual(r.diff, []);
    assert.deepEqual(r.proposedFee, live.scrapeMeta!.fee);
  });

  test("a scalar diff with FX drift keeps the live fee block (no baseCostUsd edit)", () => {
    const live = liveDoc();
    const r = diffOf(live, extraction({ name: "Skilled Worker" }), fx(0.75));
    assert.deepEqual(r.diff.map((d) => d.field), ["name"]);
    assert.deepEqual(r.proposedFee, live.scrapeMeta!.fee);
    assert.equal("baseCostUsd" in r.proposed, false);
  });

  test("pre-#59 live doc (no scrapeMeta.fee) counts the fee as changed", () => {
    const live = liveDoc();
    delete (live.scrapeMeta as any).fee;
    const r = diffOf(live, extraction());
    assert.deepEqual(r.diff.map((d) => d.field), ["fee"]);
    assert.ok((r.diff[0] as any).components.every((c: any) => c.change === "added"));
  });

  test("never-compared fields (code, isActive, reviewStatus, agentIds) do not diff", () => {
    const live = { ...liveDoc(), code: "OTHER", isActive: false, agentIds: [] } as VisaType;
    assert.deepEqual(diffOf(live, extraction()).diff, []);
  });
});

// ----- planIngest -----

describe("planIngest (doc state → branch)", () => {
  const base = { scrapeMeta: { contentHash: "old" } as any };
  test("table", () => {
    assert.equal(planIngest(undefined, "new"), "create");
    assert.equal(planIngest({ ...base, source: "scraped", reviewStatus: "approved" }, "old"), "unchanged");
    assert.equal(planIngest({ ...base, source: "scraped", reviewStatus: "pending_review" }, "new"), "refresh");
    assert.equal(planIngest({ ...base, source: "scraped", reviewStatus: "approved" }, "new"), "propose");
    assert.equal(planIngest({ ...base, source: "scraped", reviewStatus: "rejected" }, "new"), "skip");
    assert.equal(planIngest({ ...base, source: "scraped", reviewStatus: "approved", staleSince: NOW }, "new"), "skip");
    assert.equal(planIngest({ ...base, source: "agent", reviewStatus: "approved" }, "new"), "skip");
    assert.equal(planIngest({ ...base }, "new"), "skip"); // seeded uk-* (no source)
  });
});

// ----- Prompt-version re-extract (issue #71) -----

describe("isPendingPromptStale + planIngest with a prompt version (issue #71)", () => {
  const CUR = "v-current";
  const meta = (v?: string) => ({ contentHash: "h", ...(v ? { extractorPromptVersion: v } : {}) }) as any;
  const pending = (v?: string) => ({ source: "scraped" as const, reviewStatus: "pending_review" as const, scrapeMeta: meta(v) });

  test("only a pending scraped doc with an older / missing version is stale", () => {
    assert.equal(isPendingPromptStale(pending("v-old"), CUR), true);
    assert.equal(isPendingPromptStale(pending(undefined), CUR), true); // pre-#59 doc
    assert.equal(isPendingPromptStale(pending(CUR), CUR), false);
    assert.equal(isPendingPromptStale(undefined, CUR), false); // no doc
    assert.equal(isPendingPromptStale({ ...pending("v-old"), reviewStatus: "approved" }, CUR), false);
    assert.equal(isPendingPromptStale({ ...pending("v-old"), reviewStatus: "rejected" }, CUR), false);
    assert.equal(isPendingPromptStale({ ...pending("v-old"), source: "agent" }, CUR), false);
    assert.equal(isPendingPromptStale({ scrapeMeta: meta("v-old") } as any, CUR), false); // seeded
  });

  test("same hash: stale pending doc → refresh; everything else keeps the hash rule", () => {
    assert.equal(planIngest(pending("v-old"), "h", CUR), "refresh");
    assert.equal(planIngest(pending(undefined), "h", CUR), "refresh");
    assert.equal(planIngest(pending(CUR), "h", CUR), "unchanged");
    // Approved docs stay "unchanged" on the same hash: no prompt-only proposal (#61).
    assert.equal(planIngest({ ...pending("v-old"), reviewStatus: "approved" }, "h", CUR), "unchanged");
    assert.equal(planIngest({ ...pending("v-old"), source: "agent" }, "h", CUR), "unchanged");
    // No version passed (e.g. the #61 proposal transaction) → plain hash rule.
    assert.equal(planIngest(pending("v-old"), "h"), "unchanged");
    // A real content change is unaffected by the version.
    assert.equal(planIngest(pending("v-old"), "new", CUR), "refresh");
    assert.equal(planIngest({ ...pending("v-old"), reviewStatus: "approved" }, "new", CUR), "propose");
  });
});

// ----- planProposalWrite -----

describe("planProposalWrite", () => {
  test("first diff → create revision 1 with the full shape", () => {
    const live = liveDoc();
    const plan = planProposalWrite({ live, input: ingestInput(extraction({ processingDaysMax: 30 }), "h2"), now: NOW });
    assert.equal(plan.action, "create");
    const row = rowOf(plan);
    assert.equal(row.status, "open");
    assert.equal(row.changeType, "update");
    assert.equal(row.revision, 1);
    assert.equal(row.contentHash, "h2");
    assert.equal(row.currentContentHash, "h1");
    assert.equal(row.approvable, true);
    assert.equal("blockReason" in row, false);
    assert.deepEqual(row.citations, { name: "Skilled Worker visa" });
    assert.equal(row.model, "stub-model");
    assert.equal(row.extractorPromptVersion, "v-test");
    assert.equal(row.proposedSourceUrl, "https://www.gov.uk/skilled-worker-visa");
    // No undefined values anywhere at the top level.
    assert.ok(Object.values(row).every((v) => v !== undefined));
  });

  test("newer extraction replaces the open row in place: same id + createdAt, revision+1", () => {
    const live = liveDoc();
    const created = Timestamp.fromMillis(NOW.toMillis() - 1000);
    const first = { ...rowOf(planProposalWrite({ live, input: ingestInput(extraction({ processingDaysMax: 30 }), "h2"), now: created })), id: "row-1" };
    const plan = planProposalWrite({ live, openRow: first, input: ingestInput(extraction({ processingDaysMax: 40 }), "h3"), now: NOW });
    assert.equal(plan.action, "replace");
    if (plan.action !== "replace") return;
    assert.equal(plan.id, "row-1");
    assert.equal(plan.row.revision, 2);
    assert.ok(plan.row.createdAt.isEqual(created));
    assert.ok(plan.row.updatedAt.isEqual(NOW));
    assert.deepEqual(plan.row.proposed, { processingDaysMax: 40 });
    assert.equal(plan.row.contentHash, "h3");
  });

  test("same content hash as the open row → nothing", () => {
    const live = liveDoc();
    const open = rowOf(planProposalWrite({ live, input: ingestInput(extraction({ processingDaysMax: 30 }), "h2"), now: NOW }));
    assert.equal(planProposalWrite({ live, openRow: open, input: ingestInput(extraction({ processingDaysMax: 30 }), "h2"), now: NOW }).action, "none");
  });

  test("no diff → nothing (even with an open row)", () => {
    const live = liveDoc();
    const open = rowOf(planProposalWrite({ live, input: ingestInput(extraction({ processingDaysMax: 30 }), "h2"), now: NOW }));
    assert.equal(planProposalWrite({ live, input: ingestInput(extraction(), "h3"), now: NOW }).action, "none");
    assert.equal(planProposalWrite({ live, openRow: open, input: ingestInput(extraction(), "h3"), now: NOW }).action, "none");
  });

  test("changed fee with a stale rate → approvable false, FEE_NOT_CONVERTED blockReason, no proposed cost", () => {
    const fee2 = [{ ...FEE[0], amount: 900 }, FEE[1]];
    const row = rowOf(planProposalWrite({ live: liveDoc(), input: ingestInput(extraction({ feeComponents: fee2 }), "h2", staleFx()), now: NOW }));
    assert.equal(row.approvable, false);
    assert.equal(row.blockReason, FEE_NOT_CONVERTED_MESSAGE);
    assert.equal("baseCostUsd" in row.proposed, false);
    assert.equal(row.proposedScrapeMeta.fee!.fxStale, true);
  });

  test("page now states no fee → approvable false with FEE_MISSING_COST_MESSAGE", () => {
    const row = rowOf(planProposalWrite({ live: liveDoc(), input: ingestInput(extraction({ feeComponents: [] }), "h2"), now: NOW }));
    assert.equal(row.approvable, false);
    assert.equal(row.blockReason, FEE_MISSING_COST_MESSAGE);
  });

  test("eligibility emptied while live has criteria → approvable false, 'would remove all eligibility criteria'", () => {
    const row = rowOf(planProposalWrite({ live: liveDoc(), input: ingestInput(extraction({ eligibilityCriteria: [] }), "h2"), now: NOW }));
    assert.equal(row.approvable, false);
    assert.equal(row.blockReason, ELIGIBILITY_REMOVED_MESSAGE);
    assert.match(row.blockReason!, /would remove all eligibility criteria/);
    assert.deepEqual(row.diff, [{ field: "eligibilityCriteria", kind: "changed", added: [], removed: ["Job offer", "English B1"] }]);
  });

  test("unverified fee → approvable false", () => {
    const e = extraction({ feeComponents: [{ ...FEE[0], amount: 900 }], feeUnverifiedReasons: ["dropped IHS"] });
    const input = ingestInput(e, "h2");
    // computeFee only marks unverified via opts; mirror ingest's call.
    const { feeMeta } = computeFee(e.feeComponents, fx(), NOW, { unverifiedReasons: e.feeUnverifiedReasons });
    input.proposedFee = feeMeta;
    input.proposedBaseCostUsd = undefined;
    const row = rowOf(planProposalWrite({ live: liveDoc(), input, now: NOW }));
    assert.equal(row.approvable, false);
    assert.equal(row.blockReason, FEE_NOT_CONVERTED_MESSAGE);
  });
});

// ----- Approve helpers -----

describe("findStaleReason / mergeProposal / buildApprovalUpdate", () => {
  const live = liveDoc();
  const row = rowOf(
    planProposalWrite({
      live,
      input: ingestInput(extraction({ processingDaysMax: 30, applicationUrl: undefined, feeComponents: [{ ...FEE[0], amount: 900 }, FEE[1]] }), "h2"),
      now: NOW,
    })
  );

  test("not stale against the doc it was made from", () => {
    assert.equal(findStaleReason(live, row), null);
  });

  test("stale: diffed field changed, deactivated (not approved), staleSince, not scraped, scrapeMeta moved", () => {
    assert.match(findStaleReason({ ...live, processingDaysMax: 22 }, row)!, /processingDaysMax/);
    assert.match(findStaleReason({ ...live, baseCostUsd: 1 }, row)!, /baseCostUsd/);
    assert.ok(findStaleReason({ ...live, reviewStatus: "rejected" }, row));
    assert.ok(findStaleReason({ ...live, staleSince: NOW }, row));
    assert.ok(findStaleReason({ ...live, source: "agent" }, row));
    assert.ok(findStaleReason({ ...live, scrapeMeta: { ...live.scrapeMeta!, contentHash: "other" } }, row));
    // A NON-diffed field changing is not stale.
    assert.equal(findStaleReason({ ...live, name: "Renamed by hand" }, row), null);
  });

  test("buildApprovalUpdate writes only diffed fields + scrapeMeta + provenance", () => {
    const { update, appliedFields } = buildApprovalUpdate(row, "admin-1", NOW);
    assert.deepEqual(appliedFields.sort(), ["applicationUrl", "baseCostUsd", "processingDaysMax"]);
    assert.deepEqual(
      Object.keys(update).sort(),
      [
        "applicationUrl",
        "baseCostUsd",
        "lastVerifiedAt",
        "processingDaysMax",
        "reviewedAt",
        "reviewedBy",
        "scrapeMeta",
        "sourceUrl",
        "updatedAt",
      ]
    );
    assert.ok((update.applicationUrl as FieldValue).isEqual(FieldValue.delete()));
    assert.equal(update.baseCostUsd, 3625);
    assert.equal(update.reviewedBy, "admin-1");
    // baseCostUsd consistent with the fee block written alongside it.
    assert.equal(update.baseCostUsd, Math.round((update.scrapeMeta as any).fee.totalUsd));
    for (const k of ["isActive", "reviewStatus", "source", "code", "agentIds", "createdAt"]) {
      assert.equal(k in update, false, k);
    }
  });

  test("mergeProposal applies diffed fields and removes absent ones", () => {
    const merged = mergeProposal(live, row);
    assert.equal(merged.processingDaysMax, 30);
    assert.equal("applicationUrl" in merged, false);
    assert.equal(merged.baseCostUsd, 3625);
    assert.equal(merged.name, live.name);
  });
});

// ----- Re-convert a flagged proposal -----

describe("planProposalFeeReconvert", () => {
  test("stale proposed fee → converted with fresh rates, approvable", () => {
    const live = liveDoc();
    const row = rowOf(
      planProposalWrite({ live, input: ingestInput(extraction({ feeComponents: [{ ...FEE[0], amount: 900 }, FEE[1]] }), "h2", staleFx()), now: NOW })
    );
    assert.equal(row.approvable, false);
    const patch = planProposalFeeReconvert(row, live, fx(), NOW)!;
    assert.ok(patch);
    assert.equal((patch.proposed as any).baseCostUsd, 3625);
    assert.equal((patch.proposedScrapeMeta as any).fee.fxStale, undefined);
    assert.equal(patch.approvable, true);
    assert.ok((patch.blockReason as FieldValue).isEqual(FieldValue.delete()));
    assert.equal((patch.diff as any[])[0].baseCostUsdAfter, 3625);
  });

  test("not flagged / not open → null", () => {
    const live = liveDoc();
    const row = rowOf(planProposalWrite({ live, input: ingestInput(extraction({ processingDaysMax: 30 }), "h2"), now: NOW }));
    assert.equal(planProposalFeeReconvert(row, live, fx(), NOW), null);
    assert.equal(planProposalFeeReconvert({ ...row, status: "rejected" }, live, fx(), NOW), null);
  });
});

// ----- Manual script hash gate for approved docs (issue #68) -----

describe("isApprovedTextAlreadyHandled (issue #68)", () => {
  const approved = { source: "scraped" as const, reviewStatus: "approved" as const };

  test("approved scraped doc: handled when the registry page hash matches", () => {
    assert.equal(isApprovedTextAlreadyHandled(approved, "h2", { pageLastContentHash: "h2" }), true);
  });

  test("approved scraped doc: handled when a proposal row exists for this text", () => {
    assert.equal(isApprovedTextAlreadyHandled(approved, "h2", { hasProposalForHash: true }), true);
  });

  test("approved scraped doc: NOT handled for new text (page hash differs, no proposal)", () => {
    assert.equal(
      isApprovedTextAlreadyHandled(approved, "h3", { pageLastContentHash: "h2", hasProposalForHash: false }),
      false
    );
    assert.equal(isApprovedTextAlreadyHandled(approved, "h3", {}), false);
  });

  test("never for pending / rejected / withdrawn / seeded / agent / missing docs", () => {
    const seen = { pageLastContentHash: "h", hasProposalForHash: true };
    const cases: [string, Parameters<typeof isApprovedTextAlreadyHandled>[0]][] = [
      ["missing", undefined],
      ["pending", { source: "scraped", reviewStatus: "pending_review" }],
      ["rejected", { source: "scraped", reviewStatus: "rejected" }],
      ["withdrawn", { ...approved, staleSince: Timestamp.fromMillis(1) }],
      ["seeded", { source: undefined, reviewStatus: "approved" }],
      ["agent", { source: "agent", reviewStatus: "approved" }],
    ];
    for (const [label, existing] of cases) {
      assert.equal(isApprovedTextAlreadyHandled(existing, "h", seen), false, label);
    }
  });
});
