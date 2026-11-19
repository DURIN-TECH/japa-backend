// Unit tests for issue #129 — "documents you must provide" extraction + diff.
//
// Pure: no Firestore, no network. Covers the validator (kept-with-quote,
// uncited dropped + audit, duplicate collapse, no-documents valid, malformed
// rejected) and the diff (reorder-not-a-diff, case-insensitive set, removed).

import { test, describe } from "node:test";
import assert from "node:assert/strict";

// (types used only via inference)
import {
  ExtractionValidationError,
  validateExtractedVisa,
} from "../../../src/scrapers/visa-catalog/visa-catalog-extract.service";
import { diffVisa, buildApprovalUpdate } from "../../../src/scrapers/visa-catalog/visa-catalog-diff";
import { Timestamp } from "firebase-admin/firestore";

describe("validateExtractedVisa — requiredDocuments (#129)", () => {
  const base = {
    name: "Skilled Worker visa",
    code: "SW",
    description: "Work in the UK.",
    category: "work",
    processingTime: "3 weeks",
    processingDaysMin: 21,
    processingDaysMax: 56,
    feeComponents: [],
    validityPeriod: "5 years",
    isExtendable: true,
    eligibilityCriteria: ["Job offer"],
    confidence: 0.9,
  };

  test("keeps an item that has a verbatim quote on the page", () => {
    const raw = {
      ...base,
      requiredDocuments: ["Passport"],
      citations: { "requiredDocuments.0": "Bring your passport" },
    };
    const v = validateExtractedVisa(raw, { pageText: "You must bring your passport to the appointment." });
    assert.deepEqual(v.requiredDocuments, ["Passport"]);
    assert.equal(v.citations["requiredDocuments.0"], "Bring your passport");
  });

  test("drops an uncited item and records it in requiredDocumentsDropped", () => {
    const raw = {
      ...base,
      requiredDocuments: ["Passport", "Photo"],
      citations: { "requiredDocuments.0": "Bring your passport" },
    };
    const v = validateExtractedVisa(raw, { pageText: "You must bring your passport to the appointment." });
    assert.deepEqual(v.requiredDocuments, ["Passport"]);
    assert.deepEqual(v.requiredDocumentsDropped, ["Photo"]);
    assert.equal(v.citations["requiredDocuments.1"], undefined);
  });

  test("collapses duplicates case-insensitively", () => {
    const raw = {
      ...base,
      requiredDocuments: ["Passport", "passport", "  PASSPORT  "],
      citations: {
        "requiredDocuments.0": "Bring your passport",
        "requiredDocuments.1": "Bring your passport",
        "requiredDocuments.2": "Bring your passport",
      },
    };
    const v = validateExtractedVisa(raw, { pageText: "Bring your passport to the appointment." });
    assert.deepEqual(v.requiredDocuments, ["Passport"]);
    assert.equal(v.requiredDocumentsDropped, undefined);
  });

  test("a page with no documents section is valid with an empty list", () => {
    const rawOmitted = { ...base, citations: {} };
    const v1 = validateExtractedVisa(rawOmitted, { pageText: "Some page." });
    assert.deepEqual(v1.requiredDocuments, []);

    const rawEmpty = { ...base, requiredDocuments: [], citations: {} };
    const v2 = validateExtractedVisa(rawEmpty, { pageText: "Some page." });
    assert.deepEqual(v2.requiredDocuments, []);
  });

  test("malformed requiredDocuments is rejected", () => {
    for (const bad of ["foo", [1], [""], ["  "], [null]] as unknown[]) {
      const raw = { ...base, requiredDocuments: bad, citations: {} };
      assert.throws(() => validateExtractedVisa(raw, { pageText: "Some page." }), ExtractionValidationError);
    }
  });
});

describe("diffVisa — requiredDocuments (#129)", () => {
  const liveFee = { components: [] as any[] };

  test("a pure reorder is not a diff", () => {
    const r = diffVisa({
      live: { requiredDocuments: ["A", "B"], scrapeMeta: { fee: liveFee } as any },
      proposedFields: { requiredDocuments: ["B", "A"] },
      proposedFee: { components: [] } as any,
    });
    assert.equal(r.diff.some((d) => d.field === "requiredDocuments"), false);
  });

  test("compares case-insensitively", () => {
    const r = diffVisa({
      live: { requiredDocuments: ["Passport"], scrapeMeta: { fee: liveFee } as any },
      proposedFields: { requiredDocuments: ["passport"] },
      proposedFee: { components: [] } as any,
    });
    assert.equal(r.diff.some((d) => d.field === "requiredDocuments"), false);
  });

  test("reports disappeared documents in removed", () => {
    const r = diffVisa({
      live: { requiredDocuments: ["Passport", "Photo"], scrapeMeta: { fee: liveFee } as any },
      proposedFields: { requiredDocuments: ["Passport"] },
      proposedFee: { components: [] } as any,
    });
    const d = r.diff.find((x) => x.field === "requiredDocuments") as any;
    assert.ok(d);
    assert.deepEqual(d.added, []);
    assert.deepEqual(d.removed, ["Photo"]);
  });
});

describe("buildApprovalUpdate — requiredDocuments (#129)", () => {
  test("writes the remaining list on approve", () => {
    const change = {
      diff: [{ field: "requiredDocuments", kind: "changed", added: [], removed: ["Photo"] } as any],
      proposed: { requiredDocuments: ["Passport"] },
      proposedScrapeMeta: { citations: {} } as any,
      proposedSourceUrl: "https://example.com",
    };
    const { update, appliedFields } = buildApprovalUpdate(change as any, "admin-1", Timestamp.now());
    assert.deepEqual(update.requiredDocuments, ["Passport"]);
    assert.ok(appliedFields.includes("requiredDocuments"));
  });

  test("deletes the field when the proposed list is empty", () => {
    const change = {
      diff: [{ field: "requiredDocuments", kind: "changed", added: [], removed: ["Passport"] } as any],
      proposed: {},
      proposedScrapeMeta: { citations: {} } as any,
      proposedSourceUrl: "https://example.com",
    };
    const { update } = buildApprovalUpdate(change as any, "admin-1", Timestamp.now());
    // FieldValue.delete() sentinel
    assert.ok(update.requiredDocuments !== undefined);
    assert.equal(typeof update.requiredDocuments, "object");
  });
});
