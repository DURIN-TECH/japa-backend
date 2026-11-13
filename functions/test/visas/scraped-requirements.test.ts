// ============================================
// Unit tests — scraped-visa requirements + UK seed deactivation (issue #175)
// ============================================
// Hermetic (in-memory fake Firestore, no emulator). Run just this file:
//   node --import tsx --import ./test/helpers/setup.ts --test test/visas/scraped-requirements.test.ts
import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Timestamp } from "firebase-admin/firestore";

import { installFakes, resetStore, store } from "../helpers/fake-firestore";
import { visaService } from "../../src/services/visa.service";
import { visaController } from "../../src/controllers/visa.controller";
import { deriveRequirementsFromScrape, isQuoteOptional } from "../../src/services/visa-requirements-derive";
import {
  deactivateSeededUkDuplicates,
  parseDeactivateArgs,
  planDeactivation,
} from "../../src/scripts/deactivate-seeded-uk-duplicates";

const T0 = Timestamp.fromMillis(1_700_000_000_000);
const URL = "https://www.gov.uk/standard-visitor";

// A scraped visa with 4 documents: [0] cited, [1] cited + conditional ("if"),
// [2] UNCITED (must be dropped), [3] cited with "may" (optional).
function scraped(over: Record<string, unknown> = {}): any {
  return {
    id: "gb-standard-visitor", countryCode: "GB", name: "Standard Visitor", code: "SVV",
    description: "d", category: "tourist", processingTime: "3 weeks", processingDaysMin: 15, processingDaysMax: 21,
    baseCostUsd: 180, validityPeriod: "6 months", eligibilityCriteria: ["x"], agentIds: [],
    isActive: true, source: "scraped", reviewStatus: "approved", sourceUrl: URL,
    requiredDocuments: ["Valid passport", "Letter from your employer", "Invented thing", "Bank statements"],
    scrapeMeta: {
      sourceUrl: URL,
      citations: {
        "requiredDocuments.0": "You must have a valid passport",
        "requiredDocuments.1": "a letter from your employer if you are working",
        "requiredDocuments.3": "you may also provide bank statements",
      },
    },
    createdAt: T0, updatedAt: T0, ...over,
  };
}

describe("deriveRequirementsFromScrape", () => {
  test("keeps cited items, drops uncited, attaches quote + sourceUrl, shape matches VisaRequirement", () => {
    const [req, ...rest] = deriveRequirementsFromScrape(scraped());
    assert.equal(rest.length, 0);
    assert.equal(req.visaTypeId, "gb-standard-visitor");
    assert.equal(req.isOptional, false);
    assert.deepEqual(req.requiredDocuments.map((d) => d.name), ["Valid passport", "Letter from your employer", "Bank statements"]);
    for (const d of req.requiredDocuments) {
      assert.ok(d.citation?.quote && d.citation.sourceUrl === URL);
      assert.ok(d.id && Array.isArray(d.acceptedFormats) && typeof d.maxSizeMb === "number");
    }
    // Mobile VisaRequirement fields all present.
    for (const k of ["id", "visaTypeId", "title", "description", "estimatedTime", "orderIndex", "requiredDocuments", "isOptional"]) {
      assert.ok(k in req, k);
    }
  });

  test("isRequired true by default; false when the quote says if/may/optional", () => {
    const docs = deriveRequirementsFromScrape(scraped())[0].requiredDocuments;
    assert.deepEqual(docs.map((d) => d.isRequired), [true, false, false]);
    assert.equal(isQuoteOptional("This is optional"), true);
    assert.equal(isQuoteOptional("You must show your passport"), false);
  });

  test("not scraped / no docs / no source url / all uncited -> []", () => {
    assert.deepEqual(deriveRequirementsFromScrape(scraped({ source: "agent" })), []);
    assert.deepEqual(deriveRequirementsFromScrape(scraped({ requiredDocuments: undefined })), []);
    assert.deepEqual(deriveRequirementsFromScrape(scraped({ sourceUrl: undefined, scrapeMeta: { citations: scraped().scrapeMeta.citations } })), []);
    assert.deepEqual(deriveRequirementsFromScrape(scraped({ scrapeMeta: { sourceUrl: URL, citations: {} } })), []);
  });
});

describe("getRequirements + endpoints", () => {
  before(() => installFakes());
  beforeEach(() => {
    resetStore();
    store.set("countries/GB", { code: "GB", name: "United Kingdom", isSupported: true, createdAt: T0, updatedAt: T0 });
    store.set("countries/GB/visaTypes/gb-standard-visitor", scraped());
  });

  async function call(handler: any, params: any) {
    const out: any = {};
    const res: any = { status(c: number) { out.status = c; return res; }, json(b: unknown) { out.body = b; return res; } };
    await handler({ params, query: {}, body: {}, headers: {} }, res);
    return out;
  }

  test("service derives when nothing is stored", async () => {
    const reqs = await visaService.getRequirements("GB", "gb-standard-visitor");
    assert.equal(reqs.length, 1);
    assert.equal(reqs[0].requiredDocuments.length, 3);
  });

  test("GET /requirements and /full return the derived list", async () => {
    const p = { code: "GB", visaId: "gb-standard-visitor" };
    const r = await call(visaController.getRequirements.bind(visaController), p);
    assert.equal(r.status, 200);
    assert.equal(r.body.data[0].requiredDocuments.length, 3);
    const f = await call(visaController.getVisaTypeWithRequirements.bind(visaController), p);
    assert.equal(f.body.data.requirements[0].requiredDocuments[0].citation.sourceUrl, URL);
  });

  test("stored requirements win over derivation", async () => {
    store.set("countries/GB/visaTypes/gb-standard-visitor/requirements/r1", {
      visaTypeId: "gb-standard-visitor", title: "Stored", description: "", estimatedTime: "1w", orderIndex: 0,
      requiredDocuments: [], isOptional: false, createdAt: T0, updatedAt: T0,
    });
    const reqs = await visaService.getRequirements("GB", "gb-standard-visitor");
    assert.deepEqual(reqs.map((r) => r.title), ["Stored"]);
  });

  test("seeded visa without requirements stays empty", async () => {
    store.set("countries/GB/visaTypes/uk-visitor", scraped({ id: "uk-visitor", source: undefined }));
    assert.deepEqual(await visaService.getRequirements("GB", "uk-visitor"), []);
  });
});

describe("deactivate-seeded-uk-duplicates", () => {
  before(() => installFakes());
  const seed = (id: string, over: Record<string, unknown> = {}) =>
    store.set(`countries/GB/visaTypes/${id}`, scraped({ id, source: undefined, reviewStatus: undefined, ...over }));
  beforeEach(() => {
    resetStore();
    store.set("countries/GB", { code: "GB", name: "United Kingdom", isSupported: true, createdAt: T0, updatedAt: T0 });
    for (const id of ["uk-visitor", "uk-student", "uk-skilled-worker", "uk-family"]) seed(id);
    // Only the visitor twin is approved + active; student twin pending; skilled worker approved but inactive.
    store.set("countries/GB/visaTypes/gb-standard-visitor", scraped());
    store.set("countries/GB/visaTypes/gb-student-visa", scraped({ id: "gb-student-visa", reviewStatus: "pending_review", isActive: false }));
    store.set("countries/GB/visaTypes/gb-skilled-worker-visa", scraped({ id: "gb-skilled-worker-visa", isActive: false }));
  });

  test("planner", () => {
    assert.equal(planDeactivation(undefined, scraped()), "missing_seed");
    assert.equal(planDeactivation({ isActive: false }, scraped()), "already_inactive");
    assert.equal(planDeactivation({ isActive: true }, undefined), "waiting");
    assert.equal(planDeactivation({ isActive: true }, scraped({ reviewStatus: "pending_review" })), "waiting");
    assert.equal(planDeactivation({ isActive: true }, scraped({ isActive: false })), "waiting");
    assert.equal(planDeactivation({ isActive: true }, scraped()), "deactivate");
  });

  test("flags: dry run by default", () => {
    assert.deepEqual(parseDeactivateArgs([]), { dryRun: true });
    assert.deepEqual(parseDeactivateArgs(["--apply"]), { dryRun: false });
    assert.deepEqual(parseDeactivateArgs(["--apply", "--dry-run"]), { dryRun: true });
  });

  test("dry run writes nothing; apply hides only the approved twin's seed; rerun is a no-op; hidden seed still loads", async () => {
    const before = JSON.stringify([...store.entries()]);
    const dry = await deactivateSeededUkDuplicates();
    assert.equal(dry.written, 0);
    assert.equal(JSON.stringify([...store.entries()]), before);

    const r = await deactivateSeededUkDuplicates({ dryRun: false });
    assert.equal(r.written, 1);
    assert.equal(r.outcomes["uk-visitor"], "deactivate");
    assert.equal(r.outcomes["uk-student"], "waiting");
    assert.equal(r.outcomes["uk-family"], "waiting"); // twin doc absent
    assert.equal((store.get("countries/GB/visaTypes/uk-visitor") as any).isActive, false);
    assert.equal((store.get("countries/GB/visaTypes/uk-student") as any).isActive, true);

    const again = await deactivateSeededUkDuplicates({ dryRun: false });
    assert.equal(again.written, 0);
    assert.equal(again.outcomes["uk-visitor"], "already_inactive");

    // Existing applications still resolve the (now inactive) visa by id.
    assert.equal((await visaService.getVisaType("GB", "uk-visitor"))?.id, "uk-visitor");
  });
});
