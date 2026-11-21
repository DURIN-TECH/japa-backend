// ============================================
// (#440) Fixtures for the version 2 builder (not a test file)
// ============================================
//
// A version 1 shaped like the stored Schengen short-stay version 1: one rule the
// one-rule script re-drafts (the article 5(1) lead-in with its list cut to "(a)"), two
// more cut lists that re-read and prove, one cut list the reader cannot read, twenty
// plain rules, a stated intention-to-stay reading and every approval field set. The page
// is the stored Visa Code text (fixtures copied by code) plus made-up lines; every
// title and question is made up. Shared by the unit and the emulator suites.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CHECK_REUSE_PAIR } from "../../../src/services/rubric-check-reuse-pair";
import type { AssessmentCriterion, IntakeQuestion, RubricHead, VisaRubric } from "../../../src/types/rubric";
import type { GuidanceSnapshotContent } from "../../../src/scrapers/guidance/types";
import { oneRuleOutFile } from "./one-rule-out-fixture";

/* eslint-disable @typescript-eslint/no-explicit-any */

export const KEY = CHECK_REUSE_PAIR.routeKey;

// ---- the page: articles 5, 25 and 32 of the stored text, one made-up list that cannot be read, plain lines ----
export const fixtureLines = (n: string): string[] => JSON.parse(readFileSync(join(__dirname, "fixtures", `visa-code-article-${n}.json`), "utf8")).lines;
export const ART5 = fixtureLines("5-1");
export const ART25 = fixtureLines("25");
export const ART32 = fixtureLines("32");
// A lead-in whose list the reader refuses (`line_after_item_not_recognised`): made-up wording.
export const UNREADABLE = ["Synthetic paragraph nine requires the following documents:", "(a)", "a travel document;", "(b)", "a photograph:", "Another sentence."];
export const qt = (i: number) => `Applicants must supply tok${i}a tok${i}b tok${i}c documents before decision ${i}.`;
export const PLAIN = Array.from({ length: 20 }, (_, k) => qt(k + 1));
export const POLARITY_LINE = "Applicants must show they intend to leave before the visa expires.";
export const TEXT = [...ART5, ...ART25, ...ART32, ...UNREADABLE, ...PLAIN, POLARITY_LINE].join("\n\n");
export const SOURCE_ID = "schengen-area-visa-code-test";
export const PAGE: GuidanceSnapshotContent = { schemaVersion: 1, sourceId: SOURCE_ID, contentHash: createHash("sha256").update(TEXT).digest("hex"), docType: "html", url: "https://eur-lex.example/visa-code", finalUrl: "https://eur-lex.example/visa-code", fetchedAt: "2026-11-01T00:00:00Z", text: TEXT, pages: null };
export const leadIn = (lines: string[], end: string) => (lines.find((l) => l.trim().endsWith(end)) as string).trim();
export const LEAD5 = leadIn(ART5, "shall be:");
export const LEAD25 = leadIn(ART25, "following cases:");
export const LEAD32 = leadIn(ART32, "shall be refused:");
export const ID = "crit_a96b72ed1cc11170";

export const src = (quote: string, over: Record<string, unknown> = {}) => ({ quote, sourceId: SOURCE_ID, url: PAGE.url, contentHash: PAGE.contentHash, retrievedAt: PAGE.fetchedAt, ...over });
export const rule = (id: string, title: string, quote: string, over: Partial<AssessmentCriterion> = {}, srcOver: Record<string, unknown> = {}): AssessmentCriterion =>
  ({ criterionId: id, title, kind: "judgement", stage: "eligibility", severity: "high", applicability: "all_applicants", source: src(quote, srcOver), probeFactors: ["a factor"], confidence: 0.8, ...over }) as AssessmentCriterion;

/** A made-up free-text question version 1 already asks. */
export const DESTINATIONS: IntakeQuestion = { id: "destinations", label: "Which countries will you visit?", answerType: "text", required: true, criterionIds: [ID] } as IntakeQuestion;

/** Version 1 as approved and stored, with every approval field set (none may reach version 2). */
export function version1(over: Partial<VisaRubric> = {}): VisaRubric {
  const criteria: AssessmentCriterion[] = [
    // The rule the one-rule script re-drafts: the article 5 lead-in, its list cut to "(a)".
    rule(ID, "Competent member country", LEAD5, { stage: "validity", intakeQuestionIds: ["destinations"] }, { listItems: ["(a)"] }),
    // Two more cut lists: their full lists prove against the page.
    rule("crit_list_25", "Limited territorial validity cases", LEAD25, {}, { listItems: ["(a)"] }),
    rule("crit_list_32", "Refusal grounds", LEAD32, {}, { listItems: ["(a)"] }),
    // A cut list the reader cannot read: left exactly as it is.
    rule("crit_unreadable", "Documents to provide", UNREADABLE[0], {}, { listItems: ["(a)"] }),
    // Twenty ordinary rules, unchanged.
    ...PLAIN.map((q, k) => rule(`crit_plain_${String(k + 1).padStart(2, "0")}`, `Matter ${k + 1}`, q)),
  ];
  return {
    schemaVersion: 1, routeKey: KEY, authorityId: "schengen-area", routeSlug: "schengen-area-short-stay", version: 1,
    reviewStatus: "approved", intentPolarity: "immigrant_intent_penalised", reviewedBy: "system:auto-publish", reviewedAt: "2026-11-14T19:52:03.233Z", rejectReason: null, revision: 2, supersededAt: null,
    intentPolarityProposal: { value: "immigrant_intent_penalised", source: src(POLARITY_LINE) },
    severityLevels: ["critical", "high", "medium", "low"], criteria, intakeQuestions: [DESTINATIONS], evidenceItems: [],
    excludedCriterionIds: ["crit_plain_20"], exclusionNote: "Automatic publish", questionPlan: { algorithmVersion: "x" }, ruleRepairs: [], layerCheck: { status: "not_checked" }, layerConflicts: [],
    evidenceHelpsCriterionIds: ["crit_plain_01"], outcomeStatistics: { mapping: "x" },
    sourceSnapshots: [{ sourceId: SOURCE_ID, contentHash: PAGE.contentHash, url: PAGE.url, docType: "html", language: "en" }], sourceLanguages: ["en"],
    sourceSetHash: "c".repeat(64), extractorModel: "model-x", extractorPromptVersion: "p1", extractionRunId: "run-1", discardedCount: 0, discarded: [], suspiciousPassages: [], flags: [],
    createdAt: "2026-11-14T14:46:00.000Z",
    ...over,
  } as unknown as VisaRubric;
}

/** The kept `--out` file of the one-rule script for version 1 (made offline: scripted provider). */
export async function outFor(v1: VisaRubric = version1()): Promise<any> {
  const { out, summary } = await oneRuleOutFile(PAGE, v1, ID, LEAD5);
  assert.ok(summary.result, "the scripted one-rule run keeps a result");
  return out;
}

export const HEAD = (over: Partial<RubricHead> = {}): RubricHead => ({ routeKey: KEY, authorityId: "schengen-area", routeSlug: "schengen-area-short-stay", sourceIds: [SOURCE_ID], approvedVersion: 1, latestVersion: 1, latestSourceSetHash: "c".repeat(64), createdAt: null as any, updatedAt: null as any, ...over });

