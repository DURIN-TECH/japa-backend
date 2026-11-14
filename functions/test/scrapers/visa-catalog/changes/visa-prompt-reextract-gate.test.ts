// Unit tests for the prompt-bump re-extract gate on APPROVED visas (issue #187):
// an open or rejected proposal for the same text + prompt version stops the
// re-extraction (no LLM call, no repeat proposal), a newer prompt version
// re-extracts again, and a no-diff re-read only stamps the live prompt version.
// In-memory Firestore fake, no network, no emulator.

import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { ExtractedVisa } from "../../../../src/scrapers/visa-catalog/types";
import { Data, installFakes, resetStore, store } from "../../../helpers/fake-firestore";

const CC = "GB";
const VISA_ID = "gb-standard-visitor";
const VISA_PATH = `countries/${CC}/visaTypes/${VISA_ID}`;
const URL = "https://www.gov.uk/standard-visitor";
const STAY = "where you’ll be staying during your visit";

/* eslint-disable @typescript-eslint/no-explicit-any */
let catalog: any;
let version: string;

/** An extraction with one document item, classified as given. */
function extraction(kind: "document" | "information", review = false): ExtractedVisa {
  return {
    name: "Standard Visitor", code: "SV", description: "d", category: "tourist", processingTime: "3 weeks",
    processingDaysMin: 15, processingDaysMax: 21, validityPeriod: "6 months", isExtendable: true,
    feeComponents: [{ kind: "application", label: "fee", amount: 135, currency: "GBP", per: "application" }],
    eligibilityCriteria: ["x"], confidence: 0.9, requiredDocuments: [STAY],
    requiredDocumentMeta: [{ item: STAY, kind, ...(review ? { kindReview: true as const } : {}), need: "required" }],
    citations: { "requiredDocuments.0": STAY, processingDaysMax: "within 3 weeks" },
  } as ExtractedVisa;
}

/** Ingest an extraction for the fixture visa under hash `h1`. */
function ingest(e: ExtractedVisa) {
  return catalog.ingestExtraction({
    countryCode: CC, sourceUrl: URL, routeName: "Standard Visitor", contentHash: "h1", extracted: e,
    model: "stub", visaId: VISA_ID, fx: undefined,
    // A GB page: its adapter carries the +items-v1 stamp (issue #212).
    sourceMeta: { sourceProvider: "govuk-content-api" },
  });
}

/** The live doc: approved, classified "document + kindReview" (as the backfill leaves it), older prompt version. */
function seedLiveOld(): void {
  store.set(VISA_PATH, {
    ...extraction("document", true), id: VISA_ID, countryCode: CC, source: "scraped", reviewStatus: "approved", isActive: true,
    agentIds: [], sourceUrl: URL, baseCostUsd: 170,
    scrapeMeta: {
      sourceUrl: URL, routeName: "Standard Visitor", model: "stub", confidence: 0.9, contentHash: "h1",
      citations: { "requiredDocuments.0": STAY, processingDaysMax: "within 3 weeks" },
      requiredDocumentMeta: [{ item: STAY, kind: "document", kindReview: true, need: "required" }],
      extractorPromptVersion: "v-old",
      fee: { components: [{ kind: "application", label: "fee", amount: 135, currency: "GBP", per: "application" }], totals: [{ currency: "GBP", amount: 135 }], noPublishedFee: false },
    },
  });
  store.set(`countries/${CC}`, { code: CC, name: "United Kingdom", visaTypesCount: 1 });
}

const rows = (): [string, Data][] =>
  [...store.entries()].filter(([p]) => p.startsWith("pendingVisaChanges/")).map(([p, d]) => [p.split("/")[1], d]);

before(async () => {
  await installFakes();
  catalog = (await import("../../../../src/scrapers/visa-catalog/visa-catalog.service")).visaCatalogService;
  version = (await import("../../../../src/scrapers/visa-catalog/visa-catalog-extract.service")).EXTRACTION_PIPELINE_VERSION;
});
beforeEach(() => resetStore());

test("approved + older prompt version: re-extract; the new reading becomes an OPEN proposal; then no re-extract", async () => {
  seedLiveOld();
  assert.equal(await catalog.needsPromptReextract(CC, VISA_ID, undefined, "h1", version), true);
  assert.equal(await ingest(extraction("information")).then((r: any) => r.outcome), "proposed");
  assert.equal(rows().length, 1);
  assert.equal(rows()[0][1].extractorPromptVersion, version);
  // An open row for this text + version: the next crawl makes no extraction.
  assert.equal(await catalog.needsPromptReextract(CC, VISA_ID, undefined, "h1", version), false);
});

test("after the admin REJECTS the proposal: next crawl still no extraction and no new row", async () => {
  seedLiveOld();
  await ingest(extraction("information"));
  const [id, row] = rows()[0];
  store.set(`pendingVisaChanges/${id}`, { ...row, status: "rejected" });
  assert.equal(await catalog.needsPromptReextract(CC, VISA_ID, undefined, "h1", version), false);
  assert.equal(rows().length, 1); // nothing re-proposed
});

test("a NEWER prompt version re-extracts again, even with a rejected row from the older one", async () => {
  seedLiveOld();
  await ingest(extraction("information"));
  const [id, row] = rows()[0];
  store.set(`pendingVisaChanges/${id}`, { ...row, status: "rejected", extractorPromptVersion: "v-older-than-current" });
  assert.equal(await catalog.needsPromptReextract(CC, VISA_ID, undefined, "h1", version), true);
});

test("re-read with identical classification: no proposal, the live prompt version is stamped, then not stale", async () => {
  seedLiveOld();
  const outcome = await ingest(extraction("document", true)).then((r: any) => r.outcome);
  assert.equal(outcome, "unchanged");
  assert.equal(rows().length, 0);
  assert.equal((store.get(VISA_PATH) as any).scrapeMeta.extractorPromptVersion, version);
  assert.equal(await catalog.needsPromptReextract(CC, VISA_ID, undefined, "h1", version), false);
});
