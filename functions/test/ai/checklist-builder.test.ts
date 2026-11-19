// ============================================
// Unit tests — checklist builder: nothing uncited reaches an applicant
// ============================================
//
// Pins the domain rule in services/ai/checklist-builder.ts: a document is shown
// ONLY with a verbatim quote and a source URL. Pure function, no I/O. Generic
// fixtures only: no country, nationality or real visa names.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildChecklist, conditionHolds, isFaithfulWording } from "../../src/services/ai/checklist-builder";
import type { VisaRubric } from "../../src/types/rubric";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** A minimal approved rubric with the given evidence items (cast: only the fields the builder reads). */
function rubric(evidenceItems: any[], extra: Record<string, unknown> = {}): VisaRubric {
  return { version: 3, criteria: [{ criterionId: "crit_1", title: "Proof of funds", ruleRef: "R 1.1" }], intakeQuestions: [], evidenceItems, ...extra } as unknown as VisaRubric;
}

/** An evidence item with a quote and URL unless overridden. */
const item = (key: string, over: Record<string, unknown> = {}) => ({
  key,
  title: `Document ${key}`,
  party: "applicant",
  criterionIds: ["crit_1"],
  source: { quote: "You must provide this document.", url: "https://example.org/guidance" },
  ...over,
});

describe("checklist builder: an item without a citation is never shown", () => {
  test("rubric evidence with no quote, a blank quote, or no URL is dropped; a cited one stays", () => {
    const r = rubric([
      item("ok"),
      item("noquote", { source: { quote: "", url: "https://example.org/g" } }),
      item("blank", { source: { quote: "   ", url: "https://example.org/g" } }),
      item("nourl", { source: { quote: "A quote.", url: "" } }),
      item("nosource", { source: undefined }),
    ]);
    const out = buildChecklist({ rubric: r, intakeAnswers: null });
    assert.deepEqual(out.items.map((i) => i.checklistItemId), ["ev-ok"]);
    assert.ok(out.items[0].citation.quote && out.items[0].citation.url);
  });

  test("visa-record documents need a citation for their own list position, and the page URL", () => {
    const record = {
      requiredDocuments: ["Passport", "Bank statement", "Photo"],
      scrapeMeta: { sourceUrl: "https://example.org/visa", citations: { "requiredDocuments.0": "A valid passport.", "requiredDocuments.2": "  " } },
    };
    const out = buildChecklist({ rubric: null, visaRecord: record, intakeAnswers: null });
    assert.deepEqual(out.items.map((i) => i.title), ["Passport"]);
    // No page URL at all: nothing is shown, and the state says there is no list.
    const noUrl = buildChecklist({ rubric: null, visaRecord: { ...record, scrapeMeta: { citations: record.scrapeMeta.citations } }, intakeAnswers: null });
    assert.deepEqual(noUrl.items, []);
    assert.equal(noUrl.state, "no_checklist");
  });

  // #187 e2e: an information item must not say "a document you must provide".
  test("the reason follows the item's kind: information vs document", () => {
    const record = {
      requiredDocuments: ["all your names", "your current passport"],
      scrapeMeta: {
        sourceUrl: "https://www.gov.uk/uk-family-visa",
        citations: { "requiredDocuments.0": "all your names", "requiredDocuments.1": "your current passport" },
        requiredDocumentMeta: [
          { item: "all your names", kind: "information" as const, need: "required" as const },
          { item: "your current passport", kind: "document" as const, need: "required" as const },
        ],
      },
    };
    const out = buildChecklist({ rubric: null, visaRecord: record, intakeAnswers: null });
    const byTitle = Object.fromEntries(out.items.map((i) => [i.title, i.reason]));
    assert.match(byTitle["all your names"], /information you give in your online application/);
    assert.match(byTitle["your current passport"], /a document you must provide/);
  });

  test("a document named by both sources is listed once", () => {
    const out = buildChecklist({
      rubric: rubric([item("p", { title: "Passport" })]),
      visaRecord: { requiredDocuments: ["  passport "], scrapeMeta: { sourceUrl: "https://example.org/v", citations: { "requiredDocuments.0": "Passport." } } },
      intakeAnswers: null,
    });
    assert.equal(out.items.length, 1);
  });
});

describe("checklist builder: conditions and wording fail safe", () => {
  test("an unanswered question never triggers a conditional item; unknown operators never match", () => {
    assert.equal(conditionHolds({ questionId: "q1", op: "eq", value: "x" } as any, {}), false);
    assert.equal(conditionHolds({ questionId: "q1", op: "eq", value: "x" } as any, { q1: "" }), false);
    assert.equal(conditionHolds({ questionId: "q1", op: "from-the-future", value: "x" } as any, { q1: "x" }), false);
    assert.equal(conditionHolds({ questionId: "q1", op: "eq", value: "x" } as any, { q1: ["x", "y"] }), true);
  });

  test("a route that asks questions with none answered gives intake_needed and no items", () => {
    const r = rubric([item("a")], { intakeQuestions: [{ id: "q1" }] });
    const out = buildChecklist({ rubric: r, intakeAnswers: null });
    assert.equal(out.state, "intake_needed");
    assert.deepEqual(out.items, []);
  });

  test("a model wording that adds a number not in the quote/title is replaced by the template", () => {
    const r = rubric([item("a", { source: { quote: "Provide the document.", url: "https://example.org/g" } })]);
    const id = "ev-a";
    const invented = buildChecklist({ rubric: r, intakeAnswers: null, wordings: { [id]: "Provide this within 14 days." } });
    assert.match(invented.items[0].reason, /^Evidence for: Proof of funds \(R 1\.1\)\.$/);
    const fine = buildChecklist({ rubric: r, intakeAnswers: null, wordings: { [id]: "Shows your funds." } });
    assert.equal(fine.items[0].reason, "Shows your funds.");
    assert.equal(isFaithfulWording("x".repeat(401), "q", "t", "tpl"), false);
  });

  test("required is true only when the rubric item says so", () => {
    const out = buildChecklist({ rubric: rubric([item("a"), item("b", { required: true })]), intakeAnswers: null });
    assert.deepEqual(out.items.map((i) => i.required), [false, true]);
  });
});
