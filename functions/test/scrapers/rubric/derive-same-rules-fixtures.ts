// ============================================
// (#461) Fixtures for the same-rules version 3 builder (not a test file)
// ============================================
//
// A chain shaped like the stored Schengen short-stay rulebook today:
//   - version 1 (the #440 fixture, plus 61 made-up questions and 35 made-up document items
//     linked to its plain rules, so the wording check batches like the real version 2:
//     4 question batches and 2 document batches);
//   - its plain check, run for real over the fake provider (its record holds every answer);
//   - version 2 built from it by the #440 builder (one re-drafted rule, two re-read lists),
//     checked with reuse from version 1 (its record holds only the answers it ASKED for,
//     plus a reuse account), then approved (every approval field set);
//   - a head with version 2 both approved and latest.
// Shared by the unit and the emulator suites. No model, no network, no project.

import assert from "node:assert/strict";
import type { EvidenceItem, IntakeQuestion, RubricHead, VisaRubric } from "../../../src/types/rubric";
import { RubricCheckerService, type RubricCheckerRun } from "../../../src/scrapers/rubric/rubric-checker";
import { deriveVersion } from "../../../src/scrapers/rubric/scripts/derive-version-from-one-rule";
import { MemoryLedger, ScriptedProvider, settingsWith } from "./checker-fakes";
import { DESTINATIONS, HEAD, KEY, PAGE, outFor, src, version1 } from "./derive-version-fixtures";

/* eslint-disable @typescript-eslint/no-explicit-any */

export { KEY, PAGE };
export const RUN = (v: number) => `${KEY}__v${v}`;

/** 61 made-up questions, each read by one of the first ten plain rules. */
const QUESTIONS: IntakeQuestion[] = Array.from({ length: 61 }, (_, k) => ({ id: `q_made_up_${k + 1}`, label: `Made-up question number ${k + 1}?`, answerType: "yes_no", required: true, criterionIds: [`crit_plain_${String((k % 10) + 1).padStart(2, "0")}`] }) as IntakeQuestion);
/** 35 made-up document items, each for one of the first ten plain rules, quoting that rule's own line. */
const qt = (i: number) => `Applicants must supply tok${i}a tok${i}b tok${i}c documents before decision ${i}.`;
const DOCUMENTS: EvidenceItem[] = Array.from({ length: 35 }, (_, k) => ({ key: `doc_made_up_${k + 1}`, title: `Made-up document ${k + 1}`, party: "applicant", criterionIds: [`crit_plain_${String((k % 10) + 1).padStart(2, "0")}`], source: src(qt((k % 10) + 1)) }) as EvidenceItem);

/** Version 1 with the made-up questions and document items. */
export const chainV1 = (): VisaRubric => version1({ intakeQuestions: [DESTINATIONS, ...QUESTIONS], evidenceItems: DOCUMENTS } as any);

/** The approval fields a published version carries (none may reach version 3). */
const APPROVED = {
  reviewStatus: "approved", intentPolarity: "immigrant_intent_penalised", reviewedBy: "system:auto-publish", reviewedAt: "2026-11-21T17:29:31.145Z", rejectReason: null, revision: 2, supersededAt: null,
  excludedCriterionIds: ["crit_plain_20"], exclusionNote: "Automatic publish", questionPlan: { algorithmVersion: "x" }, ruleRepairs: [], layerCheck: { status: "not_checked" }, layerConflicts: [],
  evidenceHelpsCriterionIds: ["crit_plain_01"], outcomeStatistics: { mapping: "x" },
};

/** The whole chain: version 1 and its record, version 2 (approved) and its reuse record, the head. */
export async function chainToV2(): Promise<{ v1: VisaRubric; v2: VisaRubric; ledger: MemoryLedger; head: RubricHead; v1Record: RubricCheckerRun; v2Record: RubricCheckerRun }> {
  const ledger = new MemoryLedger();
  const svc = (p: ScriptedProvider) => new RubricCheckerService({ provider: () => p, readSnapshot: async () => PAGE, loadSettings: settingsWith(), ledger, nowMs: () => Date.parse("2026-11-21T12:00:00Z"), sleep: async () => undefined });
  const v1 = chainV1();
  assert.equal((await svc(new ScriptedProvider()).check({ routeKey: KEY, version: 1, runId: RUN(1), rubric: v1, codeLeftOutIds: [] })).ok, true);
  const built = deriveVersion(v1, await outFor(v1), PAGE);
  assert.ok(built.ok, built.ok ? "" : built.refusal);
  const pending = { ...built.draft, version: 2, createdAt: "2026-11-21T17:00:00.000Z" } as unknown as VisaRubric;
  const p2 = new ScriptedProvider();
  assert.equal((await svc(p2).check({ routeKey: KEY, version: 2, runId: RUN(2), rubric: pending, codeLeftOutIds: [], reuseFrom: { version: 1, rubric: v1 } })).ok, true);
  assert.ok(p2.requests.length > 0, "version 2 asked about its changed rules");
  const v2 = { ...pending, ...APPROVED } as unknown as VisaRubric;
  const v2Record = ledger.docs.get(RUN(2)) as RubricCheckerRun;
  assert.ok(v2Record.reuse && v2Record.reuse.totals.rulesAsked > 0 && v2Record.reuse.totals.rulesReused > 0, "version 2 asked some rules and reused the rest");
  return { v1, v2, ledger, head: HEAD({ approvedVersion: 2, latestVersion: 2 }), v1Record: ledger.docs.get(RUN(1)) as RubricCheckerRun, v2Record };
}
