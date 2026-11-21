// ============================================
// (#440) A `--out` file of `redraft-competence-rule`, made OFFLINE (not a test file)
// ============================================
//
// The version 2 builder (scripts/derive-version-from-one-rule.ts) reads the `--out`
// file of a LIVE one-rule run. No paid run has happened, so the tests make that file
// the way the script does: `runCompetenceRule` with `live: true` over a SCRIPTED
// provider (checker-fakes.ts: no network, no model), then the same flat shape the
// script's `main` writes. Every rule title and question below is made up; the quote
// and the list lines are the stored Visa Code text (the article 5 fixture), so the
// block passes the production `competenceProblems` check exactly as a real one must.

import { runCompetenceRule } from "../../../src/scrapers/rubric/scripts/redraft-competence-rule";
import { RUBRIC_INTAKE_SYSTEM_PROMPT } from "../../../src/scrapers/rubric/rubric-prompt";
import type { GuidanceSnapshotContent } from "../../../src/scrapers/guidance/types";
import type { VisaRubric } from "../../../src/types/rubric";
import { ScriptedProvider } from "./checker-fakes";
import { answer, crit, criteriaWire } from "./rubric-harness";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** One destination question in the raw shape the intake call answers with. */
const rawQ = (id: string, label: string, answerType = "single_choice", options: { value: string; label: string }[] = []) => ({ id, label, answerType, required: true, criterionRefs: ["c1"], options, showWhenAnyOf: [], optionsFrom: "route_destinations" });

/** The scripted intake answer: three steps resting on words of the article 5 list lines, every result ASKED. */
function intakeAnswer(): string {
  return JSON.stringify({
    intakeQuestions: [
      rawQ("destinations_440", "Which countries on this route will you visit?", "multi_choice"),
      rawQ("main_destination_440", "Which country is your main destination, by the length of your stay or by the purpose of your trip?", "single_choice", [{ value: "cannot_say", label: "I can't say" }]),
      rawQ("first_entry_440", "Which country's external border will you cross first?"),
    ],
    evidenceItems: [],
    ruleTriggers: [],
    suspiciousPassages: [],
    competenceSteps: [
      { criterionRef: "c1", restsOn: "sole destination", questionId: "destinations_440", whenAllOf: [] },
      { criterionRef: "c1", restsOn: "main destination of the visit(s) in terms of the length of stay, counted in days, or the purpose of stay", questionId: "main_destination_440", whenAllOf: [] },
      { criterionRef: "c1", restsOn: "external border the applicant intends to cross", questionId: "first_entry_440", whenAllOf: [] },
    ],
  });
}

/**
 * The `--out` file a live run would write for `ruleId` (the lead-in of article 5(1)), with every model answer
 * scripted: the re-draft keeps the quote with a new made-up title, the intake call proposes three steps, the
 * check confirms every aspect. Returns the file's JSON (the flat shape `main` writes) and the run's summary.
 */
export async function oneRuleOutFile(page: GuidanceSnapshotContent, version: VisaRubric, ruleId: string, leadIn: string): Promise<{ out: any; summary: Awaited<ReturnType<typeof runCompetenceRule>> }> {
  const p = new ScriptedProvider();
  p.redraftPolicy = () => criteriaWire(answer({ criteria: [crit({ ref: "c1", title: "Which member country examines the application", kind: "judgement", stage: "validity", quote: leadIn, probeFactors: ["the countries the applicant will visit"], requiresInterviewBeforeRefusal: false })] }));
  p.script = (_n, req) => (req.system === RUBRIC_INTAKE_SYSTEM_PROMPT ? { text: intakeAnswer() } : undefined);
  const summary = await runCompetenceRule(page, version, ruleId, { live: true, verdicts: "uyayaa", provider: p, print: () => undefined });
  // The same shape `redraft-competence-rule`'s `main` writes to `--out`.
  const { result, planned, ...outcome } = summary;
  const out = { ruleId, planned: planned.length, ...outcome, ...(result ?? { rule: null, intakeQuestions: [], competence: null, renamedQuestionIds: {} }) };
  return { out: JSON.parse(JSON.stringify(out)), summary };
}
