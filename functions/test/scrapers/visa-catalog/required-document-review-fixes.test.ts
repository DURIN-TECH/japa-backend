// Unit tests for the #187 review fixes: approved visas get classified through a
// proposal (prompt-version re-extract + meta diff), meta is matched to items by
// TEXT (reorder safe), and the clause / scope rules of the need classifier.
// Pure: no Firestore, no network.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";

import type { VisaType } from "../../../src/types";
import type { ExtractedVisa, PendingVisaChange } from "../../../src/scrapers/visa-catalog/types";
import { computeFee } from "../../../src/scrapers/visa-catalog/visa-catalog-fx";
import { buildScrapeMeta, extractedToVisaFields } from "../../../src/scrapers/visa-catalog/visa-catalog-meta";
import {
  buildApprovalUpdate,
  isPendingPromptStale,
  planIngest,
  planProposalWrite,
  type ProposalInput,
} from "../../../src/scrapers/visa-catalog/visa-catalog-diff";
import { alignScrapeMetaToLive } from "../../../src/scrapers/visa-catalog/required-document-align";
import { classifyNeed, extractConditionalClause, metaFromQuoteOnly } from "../../../src/scrapers/visa-catalog/required-document-meta";
import { validateExtractedVisa } from "../../../src/scrapers/visa-catalog/visa-catalog-extract.service";
import { deriveRequirementsFromScrape } from "../../../src/services/visa-requirements-derive";

const NOW = Timestamp.now();
const URL = "https://www.gov.uk/standard-visitor";
const STAY = "where you’ll be staying during your visit";
const TB = "a certificate proving that you’ve had a tuberculosis (TB) test if you’re visiting for more than 6 months";
const TB_WHEN = "if you’re visiting for more than 6 months";

/** An extraction with two document items (override any field). */
function extraction(over: Partial<ExtractedVisa> = {}): ExtractedVisa {
  return {
    name: "Standard Visitor", code: "SV", description: "d", category: "tourist", processingTime: "3 weeks",
    processingDaysMin: 15, processingDaysMax: 21, feeComponents: [], validityPeriod: "6 months", isExtendable: true,
    eligibilityCriteria: ["x"], confidence: 0.9,
    requiredDocuments: [STAY, TB],
    requiredDocumentMeta: [
      { item: STAY, kind: "information", kindQuote: "lead", need: "required" },
      { item: TB, kind: "document", need: "conditional", appliesWhen: TB_WHEN },
    ],
    citations: { "requiredDocuments.0": STAY, "requiredDocuments.1": TB },
    ...over,
  } as ExtractedVisa;
}

/** What ingest computes for an extraction under a prompt version and page hash. */
function ingestInput(e: ExtractedVisa, hash: string, version: string): ProposalInput {
  const { baseCostUsd, feeMeta } = computeFee(e.feeComponents, undefined, NOW);
  return {
    countryCode: "GB", visaId: "gb-sv", contentHash: hash, sourceUrl: URL,
    proposedFields: extractedToVisaFields({ countryCode: "GB", visaId: "gb-sv", code: "SV", extracted: e, baseCostUsd }),
    proposedFee: feeMeta, proposedBaseCostUsd: baseCostUsd,
    scrapeMeta: buildScrapeMeta({
      sourceUrl: URL, routeName: "Standard Visitor", model: "m", contentHash: hash, extracted: e,
      extractedAt: NOW, fee: feeMeta, extractorPromptVersion: version,
    }),
  };
}

/** A live approved scraped doc built from an extraction. */
function live(e: ExtractedVisa, hash: string, version: string): VisaType {
  const input = ingestInput(e, hash, version);
  return {
    ...input.proposedFields, source: "scraped", reviewStatus: "approved", isActive: true, agentIds: [],
    sourceUrl: URL, scrapeMeta: input.scrapeMeta, createdAt: NOW, updatedAt: NOW,
  } as VisaType;
}

// What the backfill leaves on an approved visa: document + kindReview everywhere.
const BACKFILLED = extraction({
  requiredDocumentMeta: [
    { item: STAY, kind: "document", kindReview: true, need: "required" },
    { item: TB, kind: "document", kindReview: true, need: "conditional", appliesWhen: TB_WHEN },
  ],
});

describe("approved visas are classified through a proposal (#187)", () => {
  test("approved + unchanged page + older prompt version: re-extract, and a meta diff stages a proposal", () => {
    const liveDoc = live(BACKFILLED, "h1", "v-old");
    assert.equal(isPendingPromptStale(liveDoc, "v-new"), true);
    assert.equal(planIngest(liveDoc, "h1", "v-new"), "propose"); // same hash, never "unchanged"/"refresh"
    const plan = planProposalWrite({ live: liveDoc, input: ingestInput(extraction(), "h1", "v-new"), now: NOW });
    assert.equal(plan.action, "create"); // a proposal, never an auto-applied write
    if (plan.action !== "create") return;
    assert.deepEqual(plan.row.diff.map((d) => d.field), ["requiredDocumentMeta"]);
    const d = plan.row.diff[0] as Extract<(typeof plan.row.diff)[number], { field: "requiredDocumentMeta" }>;
    // Both items change: the staying item becomes information, and the TB
    // certificate loses its "could not classify" flag (same kind and need).
    assert.deepEqual(d.changes.map((c) => c.item), [STAY, TB]);
    assert.deepEqual(d.changes[1].before, { kind: "document", need: "conditional", appliesWhen: TB_WHEN, kindReview: true });
    assert.deepEqual(d.changes[1].after, { kind: "document", need: "conditional", appliesWhen: TB_WHEN });
    assert.deepEqual(d.changes[0], {
      item: STAY,
      before: { kind: "document", need: "required", kindReview: true },
      after: { kind: "information", answerType: "text", need: "required" },
    });
  });

  test("same prompt version + same page: nothing (unchanged, no proposal)", () => {
    const liveDoc = live(extraction(), "h1", "v-new");
    assert.equal(isPendingPromptStale(liveDoc, "v-new"), false);
    assert.equal(planIngest(liveDoc, "h1", "v-new"), "unchanged");
    assert.equal(planProposalWrite({ live: liveDoc, input: ingestInput(extraction(), "h1", "v-new"), now: NOW }).action, "none");
  });

  test("an approved visa with no documents, a withdrawn one and a seeded one are not re-extracted", () => {
    assert.equal(isPendingPromptStale({ ...live(extraction(), "h1", "v-old"), requiredDocuments: undefined } as VisaType, "v-new"), false);
    assert.equal(isPendingPromptStale({ ...live(extraction(), "h1", "v-old"), staleSince: NOW } as VisaType, "v-new"), false);
    assert.equal(isPendingPromptStale({ ...live(extraction(), "h1", "v-old"), source: undefined } as unknown as VisaType, "v-new"), false);
  });

  test("re-extraction with identical meta stages nothing but asks to stamp the new prompt version", () => {
    const same = live(extraction(), "h1", "v-old");
    const plan = planProposalWrite({ live: same, input: ingestInput(extraction(), "h1", "v-new"), now: NOW });
    assert.deepEqual(plan, { action: "none", stampVersion: "v-new" });
    // Once stamped, the visa is no longer stale and the next crawl plans nothing.
    const stamped = { ...same, scrapeMeta: { ...same.scrapeMeta!, extractorPromptVersion: "v-new" } } as VisaType;
    assert.equal(isPendingPromptStale(stamped, "v-new"), false);
    assert.deepEqual(planProposalWrite({ live: stamped, input: ingestInput(extraction(), "h1", "v-new"), now: NOW }), { action: "none" });
  });

  test("an open row for the same page from an older prompt version is replaced, not skipped", () => {
    const liveDoc = live(BACKFILLED, "h1", "v-old");
    const first = planProposalWrite({ live: liveDoc, input: ingestInput(extraction(), "h1", "v-mid"), now: NOW });
    assert.equal(first.action, "create");
    if (first.action !== "create") return;
    const open = { ...first.row, id: "c1" } as PendingVisaChange;
    assert.equal(planProposalWrite({ live: liveDoc, openRow: open, input: ingestInput(extraction(), "h1", "v-mid"), now: NOW }).action, "none");
    assert.equal(planProposalWrite({ live: liveDoc, openRow: open, input: ingestInput(extraction(), "h1", "v-new"), now: NOW }).action, "replace");
  });
});

describe("meta follows the item's text, not its position (#187)", () => {
  test("reorder + fee change approved: TB stays document/conditional, staying stays information/required", () => {
    const liveDoc = live(extraction(), "h1", "v-new");
    // The page reorders the list (TB first) AND the fee changes.
    const reordered = extraction({
      requiredDocuments: [TB, STAY],
      requiredDocumentMeta: [
        { item: TB, kind: "document", need: "conditional", appliesWhen: TB_WHEN },
        { item: STAY, kind: "information", kindQuote: "lead", need: "required" },
      ],
      citations: { "requiredDocuments.0": TB, "requiredDocuments.1": STAY },
      feeComponents: [{ kind: "application", label: "fee", amount: 135, currency: "GBP", per: "application" }],
    });
    const plan = planProposalWrite({ live: liveDoc, input: ingestInput(reordered, "h2", "v-new"), now: NOW });
    assert.equal(plan.action, "create");
    if (plan.action !== "create") return;
    assert.ok(plan.row.diff.every((d) => d.field !== "requiredDocuments")); // a reorder is not a diff
    const { update } = buildApprovalUpdate(plan.row, "admin", NOW, liveDoc.requiredDocuments);
    const after = { ...liveDoc, scrapeMeta: update.scrapeMeta } as VisaType; // live list order unchanged
    assert.deepEqual(after.requiredDocuments, [STAY, TB]);
    const docs = deriveRequirementsFromScrape(after)[0].requiredDocuments;
    assert.deepEqual(docs.map((d) => [d.name, d.kind, d.need]), [[STAY, "information", "required"], [TB, "document", "conditional"]]);
    assert.equal(docs[1].citation?.quote, TB); // the quotes were re-keyed too
  });

  test("an item with no match gets document + kindReview, never a neighbour's meta", () => {
    const meta = ingestInput(extraction(), "h1", "v").scrapeMeta;
    const aligned = alignScrapeMetaToLive(meta, ["a brand new item", STAY]);
    assert.deepEqual(aligned.requiredDocumentMeta!.map((m) => [m.item, m.kind, m.kindReview]), [
      ["a brand new item", "document", true], [STAY, "information", undefined],
    ]);
    assert.equal(aligned.citations["requiredDocuments.0"], undefined);
    assert.equal(aligned.citations["requiredDocuments.1"], STAY);
  });

  test("readers match by text: a meta list in another order is still read per item", () => {
    const v = live(extraction(), "h1", "v");
    v.scrapeMeta!.requiredDocumentMeta = [...v.scrapeMeta!.requiredDocumentMeta!].reverse();
    const docs = deriveRequirementsFromScrape(v)[0].requiredDocuments;
    assert.deepEqual(docs.map((d) => d.kind), ["information", "document"]);
  });

  test("a meta list that matches no item by text and differs in length reads document + kindReview", () => {
    const v = live(extraction(), "h1", "v");
    v.scrapeMeta!.requiredDocumentMeta = [{ item: "something else", kind: "information", need: "required" }];
    const docs = deriveRequirementsFromScrape(v)[0].requiredDocuments;
    assert.ok(docs.every((d) => d.kind === "document" && d.kindReview === true));
  });
});

describe("need classifier scope (#187)", () => {
  test("a colon ends the clause: the lead-in does not swallow the item text", () => {
    assert.equal(
      extractConditionalClause("Depending on your circumstances, you might also need to provide: your employer’s address"),
      "Depending on your circumstances, you might also need to provide"
    );
    assert.equal(extractConditionalClause("if you have an income: bring payslips"), "if you have an income");
  });

  test("a cue in the NEXT sentence of the quote does not make the item conditional", () => {
    const quote = "a valid passport. If you’re under 18 you also need a letter";
    assert.deepEqual(classifyNeed(quote, undefined, "a valid passport"), { need: "required" });
    // Without the item text the whole quote is read (the old behaviour).
    assert.equal(classifyNeed(quote).need, "conditional");
  });

  test("a lead-in before the item in the quote is not read as the item's own cue", () => {
    const quote = "You’ll need to provide: your employer’s address and telephone number";
    assert.deepEqual(classifyNeed(quote, undefined, "your employer’s address and telephone number"), { need: "required" });
  });

  test("the item's own clause still wins inside its sentence", () => {
    assert.deepEqual(classifyNeed(TB, undefined, TB), { need: "conditional", appliesWhen: TB_WHEN });
  });
});

describe("lead-in handling (#187 round 3)", () => {
  const LEAD = "Depending on your circumstances, you might also need to provide:";
  const EMPLOYER = "your employer\u2019s address and telephone number";

  test("an item whose own citation carries the lead-in is conditional even with no kind quote (backfilled / kindReview)", () => {
    const quote = `${LEAD} ${EMPLOYER}`;
    assert.deepEqual(classifyNeed(quote, undefined, EMPLOYER), {
      need: "conditional",
      appliesWhen: "Depending on your circumstances, you might also need to provide",
    });
    const m = metaFromQuoteOnly(quote, EMPLOYER);
    assert.equal(m.need, "conditional");
    assert.equal(m.kindReview, true);
  });

  const base = {
    name: "Standard Visitor", code: "SV", description: "d", category: "tourist", processingTime: "3 weeks",
    processingDaysMin: 15, processingDaysMax: 21, feeComponents: [], validityPeriod: "6 months",
    isExtendable: true, eligibilityCriteria: ["x"], confidence: 0.9,
  };
  const INFO_LEAD = "You\u2019ll need to provide the following information in your online application:";
  const PASSPORT = "a passport or travel document";
  const PAGE =
    `You must have ${PASSPORT} that is valid for the whole of your stay. ${INFO_LEAD}\n\n${STAY}\n\n` +
    `${LEAD}\n\n${EMPLOYER}`;
  const kindOf = (item: string, claimed: "document" | "information", quote: string) =>
    validateExtractedVisa(
      { ...base, requiredDocuments: [item], citations: { "requiredDocuments.0": item },
        requiredDocumentMeta: [{ kind: claimed, kindQuote: quote, need: "required" }] },
      { pageText: PAGE }
    ).requiredDocumentMeta![0];

  test("a lead-in-only kindQuote backs information only for an item listed under it", () => {
    assert.equal(kindOf(STAY, "information", INFO_LEAD).kind, "information");
    // The passport sentence comes BEFORE that lead-in, so the lead-in cannot back it.
    assert.deepEqual(kindOf(PASSPORT, "information", INFO_LEAD), { item: PASSPORT, kind: "document", kindReview: true, need: "required" });
  });

  test("a lead-in-only kindQuote does not cover an item listed under a LATER, different lead-in", () => {
    const m = kindOf(EMPLOYER, "information", INFO_LEAD);
    assert.equal(m.kindReview, true);
    assert.equal(kindOf(EMPLOYER, "information", LEAD).kind, "information"); // its own lead-in does
  });
});
