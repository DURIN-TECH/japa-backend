// ============================================
// The one-rule competence script (issue #335): offline plan and scripted live run
// ============================================
//
// `scripts/redraft-competence-rule.ts` re-drafts ONE saved rule, drafts the
// competence steps that rest on it and checks it, without re-drafting the
// rulebook. These tests prove:
//  - offline (the default) sends NOTHING and plans exactly 3 requests for an
//    ordinary rule with one failed aspect: re-draft, competence steps, check;
//  - the rule's list lines are re-read from the snapshot by code (the stored
//    cut list "(a)" is reported as not verifying);
//  - inputs that disagree (another snapshot, a hash that is wrong) are refused
//    before any spend;
//  - a live run (scripted provider: no network) sends exactly the 3 planned
//    requests, keeps a block that passes `competenceProblems`, and STOPS when
//    the re-draft is refused or code refuses the block (nothing more is sent);
//  - new question ids never overwrite the version's own questions.
// The page is the real stored text (fixture copied by code); every rule title,
// question and answer below is made up.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fromFirestoreRest, outFileProblem, placeQuestions, questionsTheBlockNeeds, runCompetenceRule } from "../../../src/scrapers/rubric/scripts/redraft-competence-rule";
import { RUBRIC_INTAKE_SYSTEM_PROMPT } from "../../../src/scrapers/rubric/rubric-prompt";
import { competenceProblems } from "../../../src/scrapers/rubric/rubric-competence";
import type { GuidanceSnapshotContent } from "../../../src/scrapers/guidance/types";
import type { AssessmentCriterion, IntakeQuestion, VisaRubric } from "../../../src/types/rubric";
import { ScriptedProvider } from "./checker-fakes";
import { answer, crit, criteriaWire } from "./rubric-harness";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ---- the stored page (verbatim lines copied by code from the stored snapshot) ----
const FIXTURE = JSON.parse(readFileSync(join(__dirname, "fixtures", "visa-code-article-5-1.json"), "utf8")) as { sourceId: string; url: string; fetchedAt: string; lines: string[] };
const TEXT = FIXTURE.lines.join("\n\n");
const PAGE: GuidanceSnapshotContent = { schemaVersion: 1, sourceId: FIXTURE.sourceId, contentHash: createHash("sha256").update(TEXT).digest("hex"), docType: "html", url: FIXTURE.url, finalUrl: FIXTURE.url, fetchedAt: FIXTURE.fetchedAt, text: TEXT, pages: null };
const LEAD_IN = (FIXTURE.lines.find((l) => l.endsWith("shall be:")) as string).trim();
const ID = "crit_a96b72ed1cc11170";

/** The rule as version 1 stored it: lead-in quote, list cut to "(a)" by the pre-#335 reader. */
const STORED: AssessmentCriterion = {
  criterionId: ID,
  title: "Competent member country is decided by the destination rules",
  kind: "judgement",
  stage: "validity",
  severity: "high",
  applicability: "all_applicants",
  source: { quote: LEAD_IN, sourceId: PAGE.sourceId, url: PAGE.url, contentHash: PAGE.contentHash, retrievedAt: PAGE.fetchedAt, listItems: ["(a)"] },
  probeFactors: ["the applicant's own account of the trip"],
  requiresInterviewBeforeRefusal: false,
  confidence: 0.75,
  intakeQuestionIds: ["destinations"],
} as AssessmentCriterion;

/** A made-up free-text question version 1 already asks (its id is the one the model is likely to reuse). */
const DESTINATIONS: IntakeQuestion = { id: "destinations", label: "Which countries will you visit?", answerType: "text", required: true, criterionIds: [ID] };

/** A minimal shared version 1 holding the rule (and one other rule that must stay untouched). */
function version(over: Partial<VisaRubric> = {}): VisaRubric {
  const other = { ...STORED, criterionId: "crit_other", title: "Another rule", source: { ...STORED.source, listItems: undefined }, intakeQuestionIds: [] } as any;
  return { routeKey: "test-bloc_route-one", authorityId: "test-bloc", routeSlug: "route-one", version: 1, criteria: [STORED, other], intakeQuestions: [DESTINATIONS], ...over } as VisaRubric;
}

// ---- scripted answers ----
/** The re-draft answer: the same lead-in quote, a title the check can confirm. */
const REDRAFT = criteriaWire(answer({ criteria: [crit({ ref: "c1", title: "Which member country examines the application", kind: "judgement", stage: "validity", quote: LEAD_IN, probeFactors: ["the countries the applicant will visit"], requiresInterviewBeforeRefusal: false })] }));

/** One destination question in the raw shape call 2 answers with. */
const rawQ = (id: string, label: string, answerType = "single_choice", options: { value: string; label: string }[] = []) => ({ id, label, answerType, required: true, criterionRefs: ["c1"], options, showWhenAnyOf: [], optionsFrom: "route_destinations" });

/** The call 2 answer: three steps on words of the list lines, the main destination ASKED. */
function intakeAnswer(restsOn: [string, string, string] = ["sole destination", "main destination of the visit(s) in terms of the length of stay, counted in days, or the purpose of stay", "external border the applicant intends to cross"]): string {
  return JSON.stringify({
    intakeQuestions: [
      rawQ("destinations", "Which countries on this route will you visit?", "multi_choice"),
      rawQ("main_destination", "Which country is your main destination, by the length of your stay or by the purpose of your trip?", "single_choice", [{ value: "cannot_say", label: "I can't say" }]),
      rawQ("first_entry", "Which country's external border will you cross first?"),
    ],
    evidenceItems: [],
    ruleTriggers: [],
    suspiciousPassages: [],
    competenceSteps: [
      { criterionRef: "c1", restsOn: restsOn[0], questionId: "destinations", whenAllOf: [] },
      { criterionRef: "c1", restsOn: restsOn[1], questionId: "main_destination", whenAllOf: [] },
      { criterionRef: "c1", restsOn: restsOn[2], questionId: "first_entry", whenAllOf: [] },
    ],
  });
}

/** A scripted provider: the re-draft, call 2, and the check (every aspect `yes` by default). */
function provider(intake: string = intakeAnswer()): ScriptedProvider {
  const p = new ScriptedProvider();
  p.redraftPolicy = () => REDRAFT;
  p.script = (_n, req) => (req.system === RUBRIC_INTAKE_SYSTEM_PROMPT ? { text: intake } : undefined);
  return p;
}

const quiet = { print: (l: string) => (process.env.DBG ? console.log(l) : undefined) };

describe("offline (the default): nothing is sent, the plan is printed", () => {
  test("an ordinary rule with one failed aspect plans exactly 3 requests: re-draft, competence steps, check", async () => {
    const lines: string[] = [];
    const s = await runCompetenceRule(PAGE, version(), ID, { live: false, verdicts: "uyayaa", print: (l) => lines.push(l) });
    assert.equal(s.refusedOffline, null);
    assert.deepEqual(s.planned.map((p) => `${p.step}:${p.role}`), ["redraft:judgement", "competence_steps:judgement", "check:verification"]);
    assert.deepEqual(s.aspects, ["title_faithful"]);
    assert.equal(s.requests, 0);
    // The stored cut list does not verify; the list read now from the snapshot has the three cases.
    assert.equal(s.listLinesStored, 1);
    assert.equal(s.storedListVerifies, false);
    assert.equal(s.listLinesRead, 3);
    // The output names no quote or title.
    assert.ok(!lines.join("\n").includes(LEAD_IN));
    assert.ok(lines.some((l) => l.includes("planned: 3 request(s); at most 6")));
  });

  test("no failed aspect: no re-draft is planned (2 requests)", async () => {
    const s = await runCompetenceRule(PAGE, version(), ID, { live: false, verdicts: "yyayaa", print: () => undefined });
    assert.deepEqual(s.planned.map((p) => p.step), ["competence_steps", "check"]);
  });

  test("inputs that disagree are refused before any spend", async () => {
    assert.equal((await runCompetenceRule({ ...PAGE, contentHash: "0".repeat(64) }, version(), ID, { live: false, ...quiet })).refusedOffline, "snapshot_hash_mismatch");
    assert.equal((await runCompetenceRule(PAGE, version(), "crit_missing", { live: false, ...quiet })).refusedOffline, "rule_not_in_version");
    const elsewhere = version({ criteria: [{ ...STORED, source: { ...STORED.source, contentHash: "f".repeat(64) } }] as any });
    assert.equal((await runCompetenceRule(PAGE, elsewhere, ID, { live: false, ...quiet })).refusedOffline, "rule_cites_another_snapshot");
    // (#335 fix round 1) Shared or a country's own is read from the rulebook KEY (a group id or a country code),
    // the way the structural validator reads it. `authorityId` is on every rulebook, so it cannot tell:
    // a country's rulebook that carries one is still refused, and so is a key that cannot be read.
    assert.equal((await runCompetenceRule(PAGE, version({ routeKey: "QM_route-one", authorityId: "QM" } as any), ID, { live: false, ...quiet })).refusedOffline, "not_a_shared_rulebook");
    assert.equal((await runCompetenceRule(PAGE, version({ routeKey: undefined } as any), ID, { live: false, ...quiet })).refusedOffline, "not_a_shared_rulebook");
    // The shared rulebook is accepted whatever its `authorityId` field holds.
    assert.equal((await runCompetenceRule(PAGE, version({ authorityId: undefined } as any), ID, { live: false, ...quiet })).refusedOffline, null);
    assert.equal((await runCompetenceRule(PAGE, version({ competence: { steps: [] } } as any), ID, { live: false, ...quiet })).refusedOffline, "version_already_has_a_competence_block");
  });

  test("a Firestore REST document reads as plain JSON", () => {
    const doc = { name: "x", fields: { a: { stringValue: "s" }, n: { integerValue: "3" }, l: { arrayValue: { values: [{ booleanValue: true }, { nullValue: null }] } }, m: { mapValue: { fields: { k: { doubleValue: 0.5 } } } } } };
    assert.deepEqual(fromFirestoreRest(doc), { a: "s", n: 3, l: [true, null], m: { k: 0.5 } });
  });
});

describe("live (scripted provider, no network)", () => {
  test("sends exactly the 3 planned requests; the block rests on the list lines and passes", async () => {
    const p = provider();
    const s = await runCompetenceRule(PAGE, version(), ID, { live: true, verdicts: "uyayaa", provider: p, ...quiet });
    assert.equal(s.requests, 3);
    assert.equal(p.requests.length, 3);
    assert.deepEqual(p.requests.map((r) => r.role), ["judgement", "judgement", "verification"]);
    assert.equal(s.redraft, "replacement");
    assert.equal(s.checkPasses, true);
    assert.deepEqual(s.competenceProblems, []);
    const r = s.result as NonNullable<typeof s.result>;
    // The rule keeps its id and carries the WHOLE list, read from the snapshot by code.
    assert.equal(r.rule.criterionId, ID);
    assert.equal(r.rule.source.listItems?.length, 3);
    assert.ok(r.rule.source.listItems?.every((l, i) => l.startsWith(`(${"abc"[i]}) `)));
    // "destinations" is taken by version 1's own text question: the new one gets a fresh id, the old one is untouched.
    assert.deepEqual(r.renamedQuestionIds, { destinations: "destinations__c" });
    assert.deepEqual(r.competence.steps.map((st) => st.questionId), ["destinations__c", "main_destination", "first_entry"]);
    // Every step's question lists the route's members from membership data, with no country typed in.
    for (const q of r.intakeQuestions) {
      assert.equal(q.optionsFrom, "route_destinations");
      assert.ok(!(q.options ?? []).some((o) => /^[A-Z]{2}$/.test(o.value)));
    }
    // The composed version passes the one code check.
    const v = version();
    assert.deepEqual(competenceProblems({ criteria: v.criteria.map((c) => (c.criterionId === ID ? r.rule : c)), intakeQuestions: [...v.intakeQuestions, ...r.intakeQuestions], competence: r.competence }, { sharedRulebook: true }), []);
  });

  test("the main destination is asked of the applicant: no step reads dates or lengths", async () => {
    const s = await runCompetenceRule(PAGE, version(), ID, { live: true, verdicts: "uyayaa", provider: provider(), ...quiet });
    const r = s.result as NonNullable<typeof s.result>;
    for (const st of r.competence.steps) assert.equal(st.resultFrom, "answer");
    const main = r.intakeQuestions.find((q) => q.id === "main_destination") as IntakeQuestion;
    assert.match(main.label, /length of your stay or by the purpose/);
  });

  test("a refused re-draft stops the run: 1 request, nothing else sent", async () => {
    const p = provider();
    p.redraftPolicy = () => ({ criteria: [], suspiciousPassages: [] });
    const s = await runCompetenceRule(PAGE, version(), ID, { live: true, verdicts: "uyayaa", provider: p, ...quiet });
    assert.equal(p.requests.length, 1);
    assert.equal(s.redraft, "cannot_be_repaired");
    assert.equal(s.result, null);
  });

  test("a step whose words are in no line of the rule drops the whole block: 2 requests, no check", async () => {
    const p = provider(intakeAnswer(["sole destination", "the country of longest stay", "external border the applicant intends to cross"]));
    const s = await runCompetenceRule(PAGE, version(), ID, { live: true, verdicts: "uyayaa", provider: p, ...quiet });
    assert.equal(p.requests.length, 2);
    assert.equal(s.competence, "refused:competence_dropped");
    assert.equal(s.checkLetters, null);
    assert.equal(s.result, null);
  });

  test("the check not confirming the rule is reported, never bypassed", async () => {
    const p = provider();
    p.policy = () => ({ title_faithful: "unsure" });
    const s = await runCompetenceRule(PAGE, version(), ID, { live: true, verdicts: "uyayaa", provider: p, ...quiet });
    assert.equal(s.checkPasses, false);
    assert.equal(p.requests.length, 3);
  });
});

describe("placeQuestions", () => {
  test("never overwrites a version's question; renames every reference to a new one that collides", () => {
    const existing: IntakeQuestion[] = [DESTINATIONS, { ...DESTINATIONS, id: "destinations__c" }];
    const added = [{ id: "destinations", label: "x", answerType: "multi_choice", required: true, criterionIds: [ID], optionsFrom: "route_destinations" } as IntakeQuestion, { id: "main", label: "y", answerType: "single_choice", required: true, criterionIds: [ID], optionsFrom: "route_destinations", showWhen: { anyOf: [{ questionId: "destinations", op: "eq", value: "x" }] } } as IntakeQuestion];
    const r = placeQuestions(existing, added, { steps: [{ criterionId: ID, questionId: "main", when: [{ questionId: "destinations", op: "in", value: ["a"] }], resultFrom: "answer", restsOn: "w", source: STORED.source }] });
    assert.deepEqual(r.renamed, { destinations: "destinations__c2" });
    assert.deepEqual(r.intakeQuestions.slice(0, 2), existing);
    assert.equal(r.intakeQuestions[3].showWhen?.anyOf[0].questionId, "destinations__c2");
    assert.equal(r.competence.steps[0].when?.[0].questionId, "destinations__c2");
  });
});

// ============================================
// Fix round 1 (#335): only the block's questions, no copy of a version question, the result file before any spend
// ============================================

describe("questionsTheBlockNeeds / placeQuestions: nothing but the block's questions is added", () => {
  const q = (id: string, over: Partial<IntakeQuestion> = {}): IntakeQuestion => ({ id, label: `Question ${id}`, answerType: "single_choice", required: true, criterionIds: [ID], optionsFrom: "route_destinations", ...over }) as IntakeQuestion;
  const step = (questionId: string, when?: { questionId: string; op: "eq"; value: string }[]) => ({ criterionId: ID, questionId, resultFrom: "answer" as const, restsOn: "w", source: STORED.source, ...(when ? { when } : {}) });

  test("keeps the questions the steps read, their conditions' questions and those questions' show conditions; drops the rest", () => {
    const returned = [q("visit"), q("gate"), q("main", { showWhen: { anyOf: [{ questionId: "gate", op: "eq", value: "yes" }] } }), q("passport-scan", { answerType: "text", optionsFrom: undefined }), q("deep")];
    const block = { steps: [step("visit"), step("main", [{ questionId: "deep", op: "eq", value: "x" }])] };
    assert.deepEqual(questionsTheBlockNeeds(returned, block).map((x) => x.id), ["visit", "gate", "main", "deep"]);
  });

  test("a question the version already asks (same wording, type and options source) is re-used, not added again", () => {
    const existing = [q("where", { label: "Which countries on this route will you visit?", answerType: "multi_choice" })];
    const added = [q("destinations", { label: "which countries on this route  will you visit?", answerType: "multi_choice" }), q("main", { showWhen: { anyOf: [{ questionId: "destinations", op: "eq", value: "x" }] } })];
    const r = placeQuestions(existing, added, { steps: [step("destinations"), step("main", [{ questionId: "destinations", op: "eq", value: "x" }])] });
    assert.deepEqual(r.reused, { destinations: "where" });
    // One question added (main), none copied; every reference points at the version's own question.
    assert.deepEqual(r.intakeQuestions.map((x) => x.id), ["where", "main"]);
    assert.equal(r.intakeQuestions[1].showWhen?.anyOf[0].questionId, "where");
    assert.deepEqual(r.competence.steps.map((s) => s.questionId), ["where", "main"]);
    assert.equal(r.competence.steps[1].when?.[0].questionId, "where");
  });

  test("the same wording with another answer type cannot feed a step: it is added, and reported as similar", () => {
    const existing = [q("destinations", { label: "Which countries will you visit?", answerType: "text", optionsFrom: undefined })];
    const added = [q("destinations", { label: "Which countries will you visit?", answerType: "multi_choice" })];
    const r = placeQuestions(existing, added, { steps: [step("destinations")] });
    assert.deepEqual(r.reused, {});
    assert.deepEqual(r.renamed, { destinations: "destinations__c" });
    assert.deepEqual(r.similar, { destinations__c: "destinations" });
    assert.deepEqual(r.intakeQuestions.map((x) => x.id), ["destinations", "destinations__c"]);
  });
});

describe("the --out file is settled before any spend", () => {
  const dir = mkdtempSync(join(tmpdir(), "one-rule-out-"));

  test("a live run without --out is refused", () => {
    assert.equal(outFileProblem(undefined), "out_required");
    assert.equal(outFileProblem(""), "out_required");
  });

  test("a file that already exists is never overwritten", () => {
    const there = join(dir, "earlier-result.json");
    writeFileSync(there, "{\"kept\":true}");
    assert.equal(outFileProblem(there), "out_exists");
    assert.equal(readFileSync(there, "utf8"), "{\"kept\":true}");
  });

  test("a path that cannot be written is refused", () => {
    assert.equal(outFileProblem(join(dir, "no-such-folder", "result.json")), "out_not_writable");
  });

  test("a new file in a writable folder is accepted, and the test leaves nothing behind", () => {
    const fresh = join(dir, "result.json");
    assert.equal(outFileProblem(fresh), null);
    assert.equal(existsSync(fresh), false);
  });

  test("the command line refuses --live without --out before reading anything (exit 2, no request possible)", () => {
    // The built-in provider is only constructed after this check, so nothing can be sent; the page and
    // version paths do not even exist. `tsx` runs the script source directly.
    const script = join(__dirname, "..", "..", "..", "src", "scrapers", "rubric", "scripts", "redraft-competence-rule.ts");
    const run = spawnSync(process.execPath, ["--import", "tsx", script, "--page", join(dir, "none.json"), "--version", join(dir, "none.json"), "--rule", ID, "--live"], { encoding: "utf8", env: { ...process.env, ANTHROPIC_API_KEY: "" } });
    assert.equal(run.status, 2);
    assert.match(run.stderr, /refused before any spend \(out_required\)/);
    const taken = spawnSync(process.execPath, ["--import", "tsx", script, "--page", join(dir, "none.json"), "--version", join(dir, "none.json"), "--rule", ID, "--live", "--out", join(dir, "earlier-result.json")], { encoding: "utf8", env: { ...process.env, ANTHROPIC_API_KEY: "" } });
    assert.equal(taken.status, 2);
    assert.match(taken.stderr, /refused before any spend \(out_exists\)/);
  });
});
