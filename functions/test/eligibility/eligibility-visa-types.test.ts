// ============================================
// Unit tests — eligibility reads visa types from the canonical path (issue #27)
// ============================================
//
// Run with `npm test`. Hermetic: NO network and NO emulator. The Firestore
// refs are swapped for the in-memory fake (test/helpers/fake-firestore.ts):
//  - `subcollections.visaTypes(cc)` -> `countries/{cc}/visaTypes` (installFakes);
//  - `collectionGroups.visaTypes()` -> every `*/visaTypes` in the store, with
//    `ref.parent.parent.id` added (the service reads the country from it);
//  - the service's own three collections (questions, checks, exemptions).
//
// Covers the acceptance criteria of issue #27:
//  - recommendations come from `countries/{destination}/visaTypes`, one
//    country at a time, never from a top-level `visaTypes` collection;
//  - a pending scraped visa and an agency-only visa are never recommended
//    (the existing isVisaPubliclyVisible rule), nor is any other hidden one;
//  - lookup by visaTypeId works with and without a country, and the same id
//    under two countries resolves deterministically;
//  - a hidden visa is never used to pick questions: not under its own
//    country, not under another country, not with an unusable country, and
//    not while the cross-country lookup has no index (fail closed);
//  - reserved (`__x__`) ids and a lower-case destination are handled;
//  - a visa with no EligibilityQuestions still scores (no throw);
//  - `POST /eligibility/pre-check` and `GET /eligibility/questions/:id` keep
//    their JSON shape;
//  - no source file opens a collection named visaTypes outside the allowed ones.
//
// Route- and nationality-agnostic on purpose: the fixtures use three
// destinations and three visa categories, and no code path names any of them.

import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { Timestamp } from "firebase-admin/firestore";

import { fakeCollection, installFakes, resetStore, store } from "../helpers/fake-firestore";
import type { Data } from "../helpers/fake-firestore";
import { fakeCollectionGroup } from "../helpers/fake-collection-group";
import { eligibilityService } from "../../src/services/eligibility.service";
import { eligibilityController } from "../../src/controllers/eligibility.controller";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ============================================
// Fixtures
// ============================================

/** Three destinations (nothing in src/ knows about any of them). */
const CC_A = "CA";
const CC_B = "DE";
const CC_C = "JP";
/** Applicant nationality used where one is needed. */
const NATIONALITY = "KE";
/** Fixed timestamp for seeded docs. */
const T0 = Timestamp.fromMillis(1_700_000_000_000);

/** A complete visa doc under `countries/{cc}/visaTypes/{id}`. */
function seedVisa(cc: string, id: string, over: Data): void {
  store.set(`countries/${cc}/visaTypes/${id}`, {
    // Visa docs store their own id (the collection-group lookup filters on it).
    id,
    countryCode: cc,
    name: `${cc} ${id}`,
    code: id.toUpperCase(),
    description: `description of ${cc} ${id}`,
    category: "work",
    processingTime: "3 weeks",
    processingDaysMin: 15,
    processingDaysMax: 21,
    baseCostUsd: 100,
    validityPeriod: "2 years",
    isExtendable: false,
    eligibilityCriteria: [],
    agentIds: [],
    isActive: true,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  });
}

/** A stored eligibility question (`eligibilityQuestions/{id}`). */
function seedQuestion(id: string, scope: string, over: Data = {}): void {
  store.set(`eligibilityQuestions/${id}`, {
    scope,
    question: `Question ${id}?`,
    type: "boolean",
    weight: 10,
    correctAnswers: ["true"],
    orderIndex: 1,
    isRequired: true,
    isActive: true,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  });
}

/**
 * The catalogue used by most tests.
 *
 * Country A: a visible work visa (seed-like), a visible student visa
 *   (approved scraped), and every kind of HIDDEN work visa.
 * Country B: a visible tourist visa and a visible work visa.
 */
function seedCatalogue(): void {
  // ---- Country A: visible ----
  seedVisa(CC_A, "a-work-seed", { category: "work", baseCostUsd: 155 });
  seedVisa(CC_A, "a-student-scraped", { category: "student", source: "scraped", reviewStatus: "approved" });
  // ---- Country A: hidden (none of these may ever be recommended) ----
  // Pending scraped visa, as the crawl writes it (inactive).
  seedVisa(CC_A, "a-work-scraped-pending", {
    category: "work",
    source: "scraped",
    reviewStatus: "pending_review",
    isActive: false,
  });
  // Pending visa wrongly stored active (the pre-#99 bug): the `isActive ==
  // true` query returns it, only the visibility rule can drop it.
  seedVisa(CC_A, "a-work-pending-active", { category: "work", source: "scraped", reviewStatus: "pending_review" });
  // Approved agency visa that is still agency-only.
  seedVisa(CC_A, "a-work-agency-only", {
    category: "work",
    source: "agency",
    reviewStatus: "approved",
    visibility: "agency",
    ownerAgencyId: "agency-1",
  });
  // Rejected, and plain inactive.
  seedVisa(CC_A, "a-work-rejected", { category: "work", source: "scraped", reviewStatus: "rejected" });
  seedVisa(CC_A, "a-work-inactive", { category: "work", isActive: false });
  // ---- Country B: visible ----
  seedVisa(CC_B, "b-tourist", { category: "tourist" });
  seedVisa(CC_B, "b-work", { category: "work", source: "agency", reviewStatus: "approved", visibility: "global" });
}

/** Ids of the recommended visa types of a pre-check result, sorted. */
const recommendedIds = (result: { recommendedVisaTypes?: { id: string }[] }) =>
  (result.recommendedVisaTypes ?? []).map((v) => v.id).sort();

/** Ids of a question list, in order. */
const questionIds = (questions: { id: string }[]) => questions.map((q) => q.id);

// ============================================
// Fakes
// ============================================

/**
 * The shared collection-group fake, plus what the service reads off a real
 * snapshot to recover the country: `doc.ref.parent.parent.id`
 * (`countries/{CC}/visaTypes/{id}` -> CC; a top-level `visaTypes/{id}` doc
 * has no parent document, so `parent.parent` is null, like Firestore).
 */
function visaTypesGroup(query: any = fakeCollectionGroup("visaTypes")): any {
  return {
    where: (field: string, op: string, value: unknown) => visaTypesGroup(query.where(field, op, value)),
    async get() {
      const snap = await query.get();
      const docs = snap.docs.map((d: any) => {
        const parts = (d.ref.path as string).split("/");
        const parentDoc = parts.length >= 4 ? { id: parts[parts.length - 3] } : null;
        return { ...d, ref: { ...d.ref, parent: { id: parts[parts.length - 2], parent: parentDoc } } };
      });
      return { ...snap, docs };
    },
  };
}

/** A collection-group query whose get() rejects with the given error. */
const failingGroup = (error: Error) => () => ({
  where: () => ({
    get: async () => {
      throw error;
    },
  }),
});

/** What Firestore throws when a query's index is missing / still building. */
const missingIndexError = () =>
  Object.assign(new Error("9 FAILED_PRECONDITION: The query requires an index"), { code: 9 });

/** Run `fn` with console.error / console.warn silenced; return what was logged. */
async function quietly<T>(fn: () => Promise<T>): Promise<{ result: T; errors: unknown[][] }> {
  const original = { error: console.error, warn: console.warn };
  const errors: unknown[][] = [];
  console.error = (...args: unknown[]) => void errors.push(args);
  console.warn = () => undefined;
  try {
    return { result: await fn(), errors };
  } finally {
    console.error = original.error;
    console.warn = original.warn;
  }
}

/** Number of collection-group queries started (to prove lookup A skips it). */
let groupQueries = 0;

/** Minimal Express res: captures status + body. */
async function call(
  handler: (req: any, res: any) => Promise<void>,
  req: { params?: Data; query?: Data; body?: Data; userId?: string }
): Promise<{ status: number; body: any }> {
  const out = { status: 0, body: undefined as any };
  const res = {
    status(code: number) {
      out.status = code;
      return res;
    },
    json(body: unknown) {
      out.body = body;
      return res;
    },
  };
  await handler({ params: {}, query: {}, body: {}, headers: {}, ...req }, res);
  return out;
}

// ============================================
// Setup
// ============================================

/** The firebase module, kept so a test can swap the group query for a failing one. */
let firebase: any;

before(async () => {
  await installFakes();
  firebase = await import("../../src/utils/firebase");
  // The service keeps its own three collection refs as (private) fields.
  const svc = eligibilityService as any;
  svc.questionsCollection = fakeCollection("eligibilityQuestions");
  svc.checksCollection = fakeCollection("eligibilityChecks");
  svc.exemptionsCollection = fakeCollection("visaExemptions");
});

beforeEach(() => {
  resetStore();
  groupQueries = 0;
  firebase.collectionGroups.visaTypes = () => {
    groupQueries++;
    return visaTypesGroup();
  };
  seedCatalogue();
});

// ============================================
// Recommendations (pre-check)
// ============================================

describe("pre-check recommendations read countries/{code}/visaTypes", () => {
  test("recommends the publicly visible visas of the destination for the purpose", async () => {
    const result = await eligibilityService.preCheck({
      nationality: NATIONALITY,
      destinationCountry: CC_A,
      travelPurpose: "work",
    });
    assert.equal(result.visaRequired, true);
    // Only the seed-like work visa: the student visa is another category and
    // the five hidden work visas are dropped.
    assert.deepEqual(recommendedIds(result), ["a-work-seed"]);
  });

  test("a pending scraped visa and an agency-only visa never appear", async () => {
    // Every purpose, so no category filter can be what hides them.
    for (const travelPurpose of ["tourism", "business", "work", "study", "family", "transit"] as const) {
      const result = await eligibilityService.preCheck({
        nationality: NATIONALITY,
        destinationCountry: CC_A,
        travelPurpose,
      });
      const got = recommendedIds(result);
      for (const hidden of [
        "a-work-scraped-pending",
        "a-work-pending-active",
        "a-work-agency-only",
        "a-work-rejected",
        "a-work-inactive",
      ]) {
        assert.equal(got.includes(hidden), false, `${hidden} recommended for ${travelPurpose}`);
      }
    }
  });

  test("hidden visas are dropped even when they are the only match", async () => {
    // Remove the one visible work visa: the hidden ones must not fill the gap.
    store.delete(`countries/${CC_A}/visaTypes/a-work-seed`);
    const result = await eligibilityService.preCheck({
      nationality: NATIONALITY,
      destinationCountry: CC_A,
      travelPurpose: "work",
    });
    assert.deepEqual(result.recommendedVisaTypes, []);
  });

  test("each destination gets its own visas, per category", async () => {
    const study = await eligibilityService.preCheck({
      nationality: NATIONALITY,
      destinationCountry: CC_A,
      travelPurpose: "study",
    });
    assert.deepEqual(recommendedIds(study), ["a-student-scraped"]);

    const tourism = await eligibilityService.preCheck({
      nationality: NATIONALITY,
      destinationCountry: CC_B,
      travelPurpose: "tourism",
    });
    assert.deepEqual(recommendedIds(tourism), ["b-tourist"]);

    // Work in B: B's work visa only, never A's.
    const work = await eligibilityService.preCheck({
      nationality: NATIONALITY,
      destinationCountry: CC_B,
      travelPurpose: "work",
    });
    assert.deepEqual(recommendedIds(work), ["b-work"]);
    // No cross-country scan: the collection group is not queried at all.
    assert.equal(groupQueries, 0);
  });

  test("the destination code is matched in any case", async () => {
    const result = await eligibilityService.preCheck({
      nationality: NATIONALITY,
      destinationCountry: CC_B.toLowerCase(),
      travelPurpose: "tourism",
    });
    assert.deepEqual(recommendedIds(result), ["b-tourist"]);
  });

  test("a top-level visaTypes collection is never read", async () => {
    // What the old code queried: a doc in the top-level collection, matching
    // its filter exactly. It must not be recommended.
    store.set("visaTypes/legacy-top-level", {
      id: "legacy-top-level",
      countryCode: CC_C,
      name: "Legacy",
      description: "old path",
      category: "work",
      processingTime: "1 week",
      baseCostUsd: 1,
      isActive: true,
    });
    const result = await eligibilityService.preCheck({
      nationality: NATIONALITY,
      destinationCountry: CC_C,
      travelPurpose: "work",
    });
    assert.deepEqual(result.recommendedVisaTypes, []);
  });

  test("an unknown or unusable destination gives no recommendations, not an error", async () => {
    for (const destinationCountry of ["ZZ", "", "a/b", "../x", "has space"]) {
      const result = await eligibilityService.preCheck({
        nationality: NATIONALITY,
        destinationCountry,
        travelPurpose: "work",
      });
      assert.equal(result.visaRequired, true);
      assert.deepEqual(result.recommendedVisaTypes, [], `destination ${JSON.stringify(destinationCountry)}`);
    }
  });

  test("at most three visas are recommended", async () => {
    for (const n of [1, 2, 3, 4, 5]) seedVisa(CC_C, `c-work-${n}`, { category: "work" });
    const result = await eligibilityService.preCheck({
      nationality: NATIONALITY,
      destinationCountry: CC_C,
      travelPurpose: "work",
    });
    assert.equal(result.recommendedVisaTypes?.length, 3);
  });

  test("the exemption lookup matches the destination in any case", async () => {
    // Visa-free row stored under the upper-case code, as the seeds write it.
    store.set("visaExemptions/free", {
      nationality: NATIONALITY,
      destinationCountry: CC_C,
      requirementType: "visa_free",
      maxStayDays: 90,
    });
    for (const destinationCountry of [CC_C, CC_C.toLowerCase()]) {
      const result = await eligibilityService.preCheck({
        nationality: NATIONALITY,
        destinationCountry,
        travelPurpose: "tourism",
      });
      assert.equal(result.visaRequired, false, destinationCountry);
      assert.equal(result.maxStayDays, 90, destinationCountry);
    }
  });

  test("a visa-required exemption still recommends from the canonical path", async () => {
    // Second way into the recommendation code: an exemption row that says a
    // visa is required (the first is "no exemption row").
    store.set("visaExemptions/x1", {
      nationality: NATIONALITY,
      destinationCountry: CC_B,
      requirementType: "visa_required",
    });
    const result = await eligibilityService.preCheck({
      nationality: NATIONALITY,
      destinationCountry: CC_B,
      travelPurpose: "work",
    });
    assert.deepEqual(recommendedIds(result), ["b-work"]);
  });
});

// ============================================
// Lookup by visaTypeId (questions)
// ============================================

describe("getQuestions resolves the visa type under its country", () => {
  test("with a country: the visa's category picks the questions", async () => {
    // Work visa in A -> the work defaults; tourist visa in B -> the tourist ones.
    const work = await eligibilityService.getQuestions("a-work-seed", NATIONALITY, CC_A);
    assert.ok(questionIds(work).includes("job_offer"));
    const tourist = await eligibilityService.getQuestions("b-tourist", NATIONALITY, CC_B);
    assert.ok(questionIds(tourist).includes("return_ticket"));
    assert.equal(questionIds(tourist).includes("job_offer"), false);
    // One document read each: no collection-group query.
    assert.equal(groupQueries, 0);
  });

  test("without a country: found through the documented collection-group query", async () => {
    const student = await eligibilityService.getQuestions("a-student-scraped");
    assert.ok(questionIds(student).includes("admission"));
    assert.equal(groupQueries, 1);
  });

  test("without a country: the visa's own country selects country-scoped questions", async () => {
    // Stored questions for B's country scope and for the tourist category.
    seedQuestion("q-country-b", `country:${CC_B}`, { orderIndex: 1 });
    seedQuestion("q-category-tourist", "category:tourist", { orderIndex: 2 });
    seedQuestion("q-country-a", `country:${CC_A}`, { orderIndex: 3 });
    const got = await eligibilityService.getQuestions("b-tourist");
    assert.deepEqual(questionIds(got), ["q-country-b", "q-category-tourist"]);
  });

  test("the same id under two countries: the given country decides", async () => {
    seedVisa(CC_A, "shared-id", { category: "student" });
    seedVisa(CC_B, "shared-id", { category: "work" });
    const inA = await eligibilityService.getQuestions("shared-id", undefined, CC_A);
    const inB = await eligibilityService.getQuestions("shared-id", undefined, CC_B);
    assert.ok(questionIds(inA).includes("admission"));
    assert.equal(questionIds(inA).includes("job_offer"), false);
    assert.ok(questionIds(inB).includes("job_offer"));
    assert.equal(questionIds(inB).includes("admission"), false);
  });

  test("the same id under two countries, no country given: lowest country code, every time", async () => {
    // Inserted B first, so insertion order cannot be what picks A.
    seedVisa(CC_B, "shared-id", { category: "work" });
    seedVisa(CC_A, "shared-id", { category: "student" });
    for (let run = 0; run < 3; run++) {
      const got = await eligibilityService.getQuestions("shared-id");
      assert.ok(questionIds(got).includes("admission"), "resolved to country A (student)");
      assert.equal(questionIds(got).includes("job_offer"), false);
    }
  });

  test("the same id under two countries, no country given: a hidden copy is skipped", async () => {
    // A's copy is agency-only, so B's public copy is the one used.
    seedVisa(CC_A, "shared-id", { category: "student", visibility: "agency", reviewStatus: "approved" });
    seedVisa(CC_B, "shared-id", { category: "work" });
    const got = await eligibilityService.getQuestions("shared-id");
    assert.ok(questionIds(got).includes("job_offer"));
    assert.equal(questionIds(got).includes("admission"), false);
  });

  test("a visa looked up under the wrong country is not found there", async () => {
    // b-tourist exists only under B: asking under A gives the generic set.
    const got = await eligibilityService.getQuestions("b-tourist", undefined, CC_A);
    assert.equal(questionIds(got).includes("return_ticket"), false);
    assert.ok(questionIds(got).includes("financial_proof"));
  });

  test("a top-level visaTypes doc is ignored by the collection-group lookup", async () => {
    store.set("visaTypes/legacy-top-level", { id: "legacy-top-level", category: "work", isActive: true });
    const got = await eligibilityService.getQuestions("legacy-top-level");
    // Generic set: its category was not used.
    assert.equal(questionIds(got).includes("job_offer"), false);
    assert.ok(questionIds(got).includes("financial_proof"));
  });

  test("an unknown or unusable id gives the generic questions, not an error", async () => {
    for (const id of ["no-such-visa", "a/b", "has space"]) {
      for (const country of [undefined, CC_A, "a/b"]) {
        const got = await eligibilityService.getQuestions(id, NATIONALITY, country);
        assert.ok(questionIds(got).includes("passport"), `${id} / ${country}`);
        assert.ok(questionIds(got).includes("financial_proof"), `${id} / ${country}`);
      }
    }
  });

  test("a missing index degrades to the generic questions and is logged as an error", async () => {
    // E.g. the visaTypes.id index is still building right after a deploy.
    firebase.collectionGroups.visaTypes = failingGroup(missingIndexError());
    const { result: got, errors } = await quietly(() => eligibilityService.getQuestions("a-work-seed"));
    assert.ok(questionIds(got).includes("passport"));
    assert.equal(questionIds(got).includes("job_offer"), false);
    // Not silent: one error-level log that names the index.
    assert.equal(errors.length, 1);
    assert.match(String(errors[0][0]), /visaTypes\.id COLLECTION_GROUP index/);
  });

  test("a missing index does not affect a visa found under the country sent", async () => {
    // One document read decides: the group query is never needed.
    firebase.collectionGroups.visaTypes = failingGroup(missingIndexError());
    seedQuestion("q-visa-visible", "visa:a-work-seed");
    const got = await eligibilityService.getQuestions("a-work-seed", undefined, CC_A);
    assert.deepEqual(questionIds(got), ["q-visa-visible"]);
  });

  test("any other lookup failure is logged and propagates (not swallowed)", async () => {
    firebase.collectionGroups.visaTypes = failingGroup(
      Object.assign(new Error("14 UNAVAILABLE: connection lost"), { code: 14 })
    );
    const { errors } = await quietly(async () => {
      await assert.rejects(() => eligibilityService.getQuestions("a-work-seed"), /UNAVAILABLE/);
    });
    assert.equal(errors.length, 1);
  });

  test("reserved Firestore ids (__x__) give the generic questions, not an error", async () => {
    for (const reserved of ["__name__", "__x__", "____"]) {
      // As the visa id, and as the country.
      const asId = await eligibilityService.getQuestions(reserved, NATIONALITY, CC_A);
      assert.ok(questionIds(asId).includes("financial_proof"), reserved);
      const asCountry = await eligibilityService.getQuestions("a-work-seed", NATIONALITY, reserved);
      assert.ok(questionIds(asCountry).includes("passport"), reserved);
      // And as the pre-check destination.
      const pre = await eligibilityService.preCheck({
        nationality: NATIONALITY,
        destinationCountry: reserved,
        travelPurpose: "work",
      });
      assert.deepEqual(pre.recommendedVisaTypes, [], reserved);
    }
    // The reserved id was never sent to the collection group as a doc id
    // (only the two usable-id / reserved-country calls reach it).
    assert.equal(groupQueries, 3);
  });
});

// ============================================
// Hidden visas are never scored for a public user
// ============================================

describe("hidden visas are not used to pick questions", () => {
  /** Every hidden visa of the catalogue (all are category "work"). */
  const HIDDEN = [
    "a-work-scraped-pending",
    "a-work-pending-active",
    "a-work-agency-only",
    "a-work-rejected",
    "a-work-inactive",
  ];

  test("with a country: no category questions, no visa-specific questions", async () => {
    for (const id of HIDDEN) {
      // A question written for this exact visa must not be served.
      seedQuestion(`q-visa-${id}`, `visa:${id}`);
      const got = await eligibilityService.getQuestions(id, NATIONALITY, CC_A);
      assert.equal(questionIds(got).includes(`q-visa-${id}`), false, id);
      assert.equal(questionIds(got).includes("job_offer"), false, id);
      // The generic set instead (same as an unknown id).
      assert.ok(questionIds(got).includes("financial_proof"), id);
    }
  });

  test("without a country: same", async () => {
    for (const id of HIDDEN) {
      seedQuestion(`q-visa-${id}`, `visa:${id}`);
      const got = await eligibilityService.getQuestions(id);
      assert.equal(questionIds(got).includes(`q-visa-${id}`), false, id);
      assert.equal(questionIds(got).includes("job_offer"), false, id);
    }
  });

  test("hidden id + another country: its questions are still withheld", async () => {
    // The bypass from review: every hidden visa lives under A; ask under B
    // (a real country that does not hold it) and under a country with no docs.
    for (const id of HIDDEN) {
      seedQuestion(`q-visa-${id}`, `visa:${id}`);
      for (const country of [CC_B, CC_C, CC_B.toLowerCase()]) {
        const got = await eligibilityService.getQuestions(id, NATIONALITY, country);
        assert.equal(questionIds(got).includes(`q-visa-${id}`), false, `${id} under ${country}`);
        assert.equal(questionIds(got).includes("job_offer"), false, `${id} under ${country}`);
        assert.ok(questionIds(got).includes("financial_proof"), `${id} under ${country}`);
      }
    }
  });

  test("hidden id + an unusable country: its questions are still withheld", async () => {
    for (const id of HIDDEN) {
      seedQuestion(`q-visa-${id}`, `visa:${id}`);
      for (const country of ["a/b", "has space", "__x__"]) {
        const got = await eligibilityService.getQuestions(id, NATIONALITY, country);
        assert.equal(questionIds(got).includes(`q-visa-${id}`), false, `${id} under ${country}`);
      }
    }
  });

  test("hidden id + another country: submitCheck does not score its questions", async () => {
    seedQuestion("q-visa-hidden", "visa:a-work-agency-only", { weight: 50 });
    const check = await eligibilityService.submitCheck("uid-client", {
      visaTypeId: "a-work-agency-only",
      countryCode: CC_B,
      nationality: NATIONALITY,
      travelPurpose: "work",
      answers: [{ questionId: "q-visa-hidden", answer: true }],
    } as any);
    // Scored on the generic set (4 common + financial_proof) only.
    assert.deepEqual(
      check.breakdown.map((b) => b.questionId),
      ["passport", "passport_validity", "visa_denial", "criminal_record", "financial_proof"]
    );
    assert.equal(check.score, 0);
  });

  test("hidden id + failing group query (no country): withheld, fail closed", async () => {
    firebase.collectionGroups.visaTypes = failingGroup(missingIndexError());
    for (const id of HIDDEN) {
      seedQuestion(`q-visa-${id}`, `visa:${id}`);
      const { result: got } = await quietly(() => eligibilityService.getQuestions(id));
      assert.equal(questionIds(got).includes(`q-visa-${id}`), false, id);
      assert.equal(questionIds(got).includes("job_offer"), false, id);
      assert.ok(questionIds(got).includes("financial_proof"), id);
    }
  });

  test("hidden id + failing group query + another country: withheld, fail closed", async () => {
    firebase.collectionGroups.visaTypes = failingGroup(missingIndexError());
    for (const id of HIDDEN) {
      seedQuestion(`q-visa-${id}`, `visa:${id}`);
      const { result: got } = await quietly(() => eligibilityService.getQuestions(id, NATIONALITY, CC_B));
      assert.equal(questionIds(got).includes(`q-visa-${id}`), false, id);
    }
    // submitCheck takes the same path.
    const { result: check } = await quietly(() =>
      eligibilityService.submitCheck("uid-client", {
        visaTypeId: "a-work-agency-only",
        countryCode: CC_B,
        nationality: NATIONALITY,
        travelPurpose: "work",
        answers: [{ questionId: "q-visa-a-work-agency-only", answer: true }],
      } as any)
    );
    assert.equal(check.breakdown.some((b) => b.questionId === "q-visa-a-work-agency-only"), false);
  });

  test("while the index is missing, an id with no visa document is withheld too (the cost of failing closed)", async () => {
    firebase.collectionGroups.visaTypes = failingGroup(missingIndexError());
    seedQuestion("q-visa-unknown", "visa:not-in-catalogue");
    const { result: got } = await quietly(() => eligibilityService.getQuestions("not-in-catalogue", undefined, CC_A));
    assert.equal(questionIds(got).includes("q-visa-unknown"), false);
    assert.ok(questionIds(got).includes("financial_proof"));
  });

  test("an id that is hidden under one country and public under another", async () => {
    seedVisa(CC_A, "split-id", { category: "student", visibility: "agency", reviewStatus: "approved" });
    seedVisa(CC_B, "split-id", { category: "work" });
    seedQuestion("q-visa-split", "visa:split-id");
    // Under the hidden copy's country: withheld.
    assert.equal(
      questionIds(await eligibilityService.getQuestions("split-id", undefined, CC_A)).includes("q-visa-split"),
      false
    );
    // Under the public copy's country, and with no country: the public visa's.
    assert.ok(questionIds(await eligibilityService.getQuestions("split-id", undefined, CC_B)).includes("q-visa-split"));
    assert.ok(questionIds(await eligibilityService.getQuestions("split-id")).includes("q-visa-split"));
  });

  test("a visible visa and an unknown id still get their visa-specific questions", async () => {
    seedQuestion("q-visa-visible", "visa:a-work-seed");
    seedQuestion("q-visa-unknown", "visa:not-in-catalogue");
    assert.deepEqual(questionIds(await eligibilityService.getQuestions("a-work-seed", undefined, CC_A)), [
      "q-visa-visible",
    ]);
    // Unchanged behaviour: questions seeded for an id with no visa doc.
    assert.deepEqual(questionIds(await eligibilityService.getQuestions("not-in-catalogue", undefined, CC_A)), [
      "q-visa-unknown",
    ]);
  });
});

// ============================================
// Scoring a visa that has no EligibilityQuestions
// ============================================

describe("a visa with no EligibilityQuestions still scores", () => {
  test("submitCheck falls back to the default questions of its category", async () => {
    // No doc in eligibilityQuestions at all.
    const check = await eligibilityService.submitCheck("uid-client", {
      visaTypeId: "b-tourist",
      countryCode: CC_B,
      nationality: NATIONALITY,
      travelPurpose: "tourism",
      answers: [
        { questionId: "passport", answer: true },
        { questionId: "passport_validity", answer: 24 },
        { questionId: "visa_denial", answer: false },
        { questionId: "criminal_record", answer: false },
        { questionId: "return_ticket", answer: true },
        { questionId: "accommodation", answer: true },
        { questionId: "travel_insurance", answer: true },
        { questionId: "ties_to_home", answer: true },
      ],
    } as any);
    // Every default question (4 common + 4 tourist) answered correctly.
    assert.equal(check.score, 100);
    assert.equal(check.eligibilityLevel, "high");
    assert.equal(check.suggestedPath, "self_service");
    assert.equal(check.breakdown.length, 8);
    assert.equal(check.visaTypeId, "b-tourist");
    assert.equal(check.countryCode, CC_B);
    // The check was stored.
    assert.equal([...store.keys()].filter((k) => k.startsWith("eligibilityChecks/")).length, 1);
  });

  test("submitCheck for an unknown visa id scores the generic set as before", async () => {
    const check = await eligibilityService.submitCheck("uid-client", {
      visaTypeId: "not-in-catalogue",
      countryCode: CC_A,
      nationality: NATIONALITY,
      travelPurpose: "work",
      answers: [{ questionId: "passport", answer: true }],
    } as any);
    // 4 common + financial_proof = 70 points; passport (15) answered.
    assert.equal(check.breakdown.length, 5);
    assert.equal(check.score, Math.round((15 / 70) * 100));
    assert.equal(check.eligibilityLevel, "low");
  });
});

// ============================================
// JSON shape of the two public endpoints
// ============================================

describe("endpoint JSON shape is unchanged", () => {
  test("POST /eligibility/pre-check", async () => {
    const res = await call((req, r) => eligibilityController.preCheck(req, r), {
      body: { nationality: NATIONALITY, destinationCountry: CC_A, travelPurpose: "work" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    // `warnings` is undefined here, so JSON drops it (as before).
    assert.deepEqual(JSON.parse(JSON.stringify(res.body.data)), {
      visaRequired: true,
      requirementType: "visa_required",
      recommendedVisaTypes: [
        {
          id: "a-work-seed",
          name: `${CC_A} a-work-seed`,
          description: `description of ${CC_A} a-work-seed`,
          processingTime: "3 weeks",
          baseCostUsd: 155,
        },
      ],
      nextSteps: [
        "Review the recommended visa types below.",
        "Check your eligibility before applying.",
        "Gather required documents.",
        "Submit your application online or through an agent.",
      ],
    });
  });

  test("GET /eligibility/questions/:visaTypeId (no destinationCountry, as mobile calls it)", async () => {
    const res = await call((req, r) => eligibilityController.getQuestions(req, r), {
      params: { visaTypeId: "a-work-seed" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.ok(Array.isArray(res.body.data));
    // Still a bare array of EligibilityQuestion: 4 common + 3 work defaults.
    assert.deepEqual(questionIds(res.body.data), [
      "passport",
      "passport_validity",
      "visa_denial",
      "criminal_record",
      "job_offer",
      "work_experience",
      "qualifications",
    ]);
    for (const q of res.body.data) {
      for (const key of ["id", "scope", "question", "type", "weight", "orderIndex", "isRequired", "isActive"]) {
        assert.ok(key in q, `question ${q.id} has ${key}`);
      }
    }
  });

  test("GET /eligibility/questions/:visaTypeId?destinationCountry=…", async () => {
    const res = await call((req, r) => eligibilityController.getQuestions(req, r), {
      params: { visaTypeId: "b-tourist" },
      query: { destinationCountry: CC_B, nationality: NATIONALITY },
    });
    assert.equal(res.status, 200);
    assert.ok(questionIds(res.body.data).includes("return_ticket"));
  });
});

// ============================================
// Guard: the second path cannot come back
// ============================================

describe("no top-level visaTypes collection in the source", () => {
  /** Every .ts file under a directory. */
  function tsFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) return tsFiles(full);
      return name.endsWith(".ts") ? [full] : [];
    });
  }

  test("a collection named visaTypes is opened only in utils/firebase.ts and the seed scripts", () => {
    const srcDir = join(__dirname, "..", "..", "src");
    // The files the issue allows: the `subcollections` helper and the two
    // seed scripts, all of which build `countries/{code}/visaTypes`.
    const allowed = new Set(["utils/firebase.ts", "data/seed-countries-visas.ts", "data/seed-ireland-visa.ts"]);
    const offenders = tsFiles(srcDir)
      .map((file) => relative(srcDir, file).split(sep).join("/"))
      .filter((rel) => !allowed.has(rel))
      .filter((rel) => /collection\(\s*["'`]visaTypes["'`]\s*\)/.test(readFileSync(join(srcDir, rel), "utf8")));
    assert.deepEqual(offenders, []);
  });
});
