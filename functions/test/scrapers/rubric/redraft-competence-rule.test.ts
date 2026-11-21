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
// (#455) The stop record, the answers file and the replay.
import { ReplayProvider, requestHashOf, answersFileProblem, answersFileWriter, answersPathFor, outFileOf, readAnswersFile, type CompetenceRuleRunSummary, type SavedAnswer } from "../../../src/scrapers/rubric/scripts/redraft-competence-rule";
import { readdirSync, statSync } from "node:fs";
import type { LlmRequest, LlmResponse } from "../../../src/services/ai/llm-provider";
import { DEFAULT_RUBRIC_SETTINGS } from "../../../src/scrapers/rubric/rubric-settings";
import { DEFAULT_PUBLISH_SETTINGS } from "../../../src/scrapers/rubric/rubric-publish-settings";
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

  test("(#335 fix round 2) a throw inside the check still ends in a summary (requests were spent), never escapes", async () => {
    const p = provider();
    // `RubricCheckerService.check` catches every error itself and returns `ok: false`; the
    // script's own try around it is defence in depth. Either way the run must end in a
    // summary that says the check did not pass, never escape to `main` with nothing written.
    // The throw: naming the model of the check's role (only the check uses `verification`).
    const modelFor = p.modelFor.bind(p);
    p.modelFor = (role) => {
      if (role === "verification") throw new TypeError("unexpected");
      return modelFor(role);
    };
    const s = await runCompetenceRule(PAGE, version(), ID, { live: true, verdicts: "uyayaa", provider: p, ...quiet });
    assert.equal(s.checkPasses, false);
    // "none" (the checker swallowed it: no verdict) or "failed:TypeError" (the script's catch).
    assert.match(String(s.checkLetters), /^(none|failed:TypeError)$/);
    // The re-draft and the competence call were spent and are still reported.
    assert.equal(s.redraft, "replacement");
    assert.ok(s.requests >= 2);
  });

  test("(#335 review round 4) every request goes out with the SDK retry off, so the count is the number of sends", async () => {
    const p = provider();
    const s = await runCompetenceRule(PAGE, version(), ID, { live: true, verdicts: "uyayaa", provider: p, ...quiet });
    // One `complete` = one HTTP send (the SDK sends once); only `callModel`'s own retry, which is counted, is left.
    assert.equal(p.requests.length, 3);
    assert.ok(p.requests.every((r) => r.maxRetries === 0), "every request has maxRetries 0");
    assert.equal(s.requests, p.requests.length);
  });

  test("(#335 review round 4) the printed ceiling stays 'at most twice the planned figure' and is exact", async () => {
    const lines: string[] = [];
    await runCompetenceRule(PAGE, version(), ID, { live: false, verdicts: "uyayaa", print: (l) => lines.push(l) });
    assert.ok(lines.some((l) => /planned: 3 request\(s\); at most 6 /.test(l)));
  });

  test("(#335 review round 4) a throw in the code BETWEEN the model calls still ends in a summary with the requests made", async () => {
    const p = provider();
    // `placeQuestions` reads the version's questions after the re-draft and the competence call
    // (2 paid requests). Make that read throw: the run must not escape to `main` with nothing on file.
    const v = version();
    Object.defineProperty(v, "intakeQuestions", { get: () => { throw new TypeError("unexpected"); } });
    const s = await runCompetenceRule(PAGE, v, ID, { live: true, verdicts: "uyayaa", provider: p, ...quiet });
    assert.equal(s.liveFailed, "failed:TypeError");
    assert.equal(s.requests, 2);
    assert.equal(p.requests.length, 2);
    assert.equal(s.redraft, "replacement");
    assert.equal(s.checkLetters, null);
    assert.equal(s.result, null);
  });

  test("a run with no throw reports no live failure", async () => {
    const s = await runCompetenceRule(PAGE, version(), ID, { live: true, verdicts: "uyayaa", provider: provider(), ...quiet });
    assert.equal(s.liveFailed, null);
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

// ============================================
// (#455) Why a run stopped, the model's answers kept locally, and an offline replay
// ============================================
//
// The first live run for #335 stopped with `competence failed:RunStop` and recorded no reason.
// These tests prove:
//  - every stop path of the three steps records `stop: { step, code, problems }` with the code
//    word the drafting or validation code chose (and every problem code for a code refusal);
//  - every answer received is handed to `onAnswer`, and the CLI's writer keeps them in
//    `<out>.answers.json` with mode 0600, tested new and writable before any request;
//  - the printed stop line holds code words only (no quote, no model text);
//  - `--replay` re-runs the code steps on saved answers with 0 requests and the same outcome.
// No network anywhere: the providers are scripted.

/** (#455) Is this the re-draft (repair) request? Only the repair prompt carries this block. */
const isRedraft = (req: LlmRequest): boolean => req.user.includes("REPAIR. An earlier draft");
/** (#455) Is this the competence (call 2) request? */
const isIntake = (req: LlmRequest): boolean => req.system === RUBRIC_INTAKE_SYSTEM_PROMPT;

/** (#455) A scripted provider whose answer to ONE step is replaced (the others answer as usual). */
function failingAt(which: "redraft" | "competence" | "check", what: "transient" | "hard" | "refusal" | "truncated" | { text: string }): ScriptedProvider {
  const p = provider();
  const intake = intakeAnswer();
  p.script = (_n, req) => {
    const hit = which === "redraft" ? isRedraft(req) : which === "competence" ? isIntake(req) : !isRedraft(req) && !isIntake(req);
    if (hit) return what;
    return isIntake(req) ? { text: intake } : undefined;
  };
  return p;
}

/** (#455) A provider wrapper that ends the competence answer with another stop reason (`pause_turn`). */
function stoppedAtCompetence(): ScriptedProvider {
  const p = provider();
  const complete = p.complete.bind(p);
  p.complete = async (req: LlmRequest): Promise<LlmResponse> => {
    const res = await complete(req);
    return isIntake(req) ? { ...res, stopReason: "pause_turn" } : res;
  };
  return p;
}

/** (#455) Run live and keep the answers in memory (what the CLI writes to the answers file). */
async function liveRun(p: ScriptedProvider, v: VisaRubric = version(), lines: string[] = []): Promise<{ s: CompetenceRuleRunSummary; answers: SavedAnswer[]; lines: string[] }> {
  const answers: SavedAnswer[] = [];
  const s = await runCompetenceRule(PAGE, v, ID, { live: true, verdicts: "uyayaa", provider: p, onAnswer: (e) => answers.push(e), print: (l) => lines.push(l) });
  return { s, answers, lines };
}

describe("(#455) the stop is recorded: step, code word and every problem code", () => {
  // ---- step 1, the re-draft ----
  test("re-draft: the model's own 'cannot be repaired'", async () => {
    const p = provider();
    p.redraftPolicy = () => ({ criteria: [], suspiciousPassages: [] });
    const { s } = await liveRun(p);
    assert.deepEqual(s.stop, { step: "redraft", code: "cannot_be_repaired", problems: [] });
  });

  test("re-draft: a refusal by code names its detail (the replacement no longer quotes a rule of the passage)", async () => {
    const p = provider();
    // A quote that is in no line of the excerpt: the drafting validation discards the rule, and the
    // re-draft is refused with the discard's reason as its detail.
    p.redraftPolicy = () => criteriaWire(answer({ criteria: [crit({ ref: "c1", title: "Which member country examines the application", kind: "judgement", stage: "validity", quote: "words that are not in the stored page at all", probeFactors: ["x"], requiresInterviewBeforeRefusal: false })] }));
    const { s } = await liveRun(p);
    assert.match(String(s.redraft), /^refused:/);
    assert.deepEqual(s.stop, { step: "redraft", code: String(s.redraft).slice("refused:".length), problems: [] });
    assert.equal(s.requests, 1);
  });

  for (const [what, code] of [["refusal", "provider_refused"], ["truncated", "output_truncated"], ["hard", "provider_error"], [{ text: "not json" }, "invalid_model_output"]] as const) {
    test(`re-draft: a RunStop records its reason code (${code})`, async () => {
      const { s } = await liveRun(failingAt("redraft", what as any));
      // The existing summary field is unchanged (`failed:RunStop`); the reason is now beside it.
      assert.equal(s.redraft, "failed:RunStop");
      assert.deepEqual(s.stop, { step: "redraft", code, problems: [] });
    });
  }

  // ---- step 2, the competence steps ----
  for (const [what, code] of [["refusal", "provider_refused"], ["truncated", "output_truncated"], ["hard", "provider_error"], [{ text: "{\"intakeQuestions\": [" }, "invalid_model_output"]] as const) {
    test(`competence steps: a RunStop records its reason code (${code}), 2 requests, no check`, async () => {
      const { s } = await liveRun(failingAt("competence", what as any));
      assert.equal(s.competence, "failed:RunStop");
      assert.deepEqual(s.stop, { step: "competence_steps", code, problems: [] });
      assert.equal(s.requests, 2);
      assert.equal(s.checkLetters, null);
    });
  }

  test("competence steps: another stop reason is `provider_stopped`", async () => {
    const { s } = await liveRun(stoppedAtCompetence());
    assert.deepEqual(s.stop, { step: "competence_steps", code: "provider_stopped", problems: [] });
  });

  test("competence steps: a transient failure is retried once (counted); two in a row stop with `provider_error`", async () => {
    const p = failingAt("competence", "transient");
    const { s } = await liveRun(p);
    assert.equal(s.requests, 3);
    assert.deepEqual(s.stop, { step: "competence_steps", code: "provider_error", problems: [] });
  });

  test("competence steps: a dropped block records every flag code", async () => {
    const { s } = await liveRun(provider(intakeAnswer(["sole destination", "the country of longest stay", "external border the applicant intends to cross"])));
    assert.equal(s.stop?.step, "competence_steps");
    assert.equal(s.stop?.code, "competence_dropped");
    assert.ok(s.stop?.problems.includes("competence_dropped"), String(s.stop?.problems));
  });

  test("competence steps: no step proposed", async () => {
    const none = JSON.parse(intakeAnswer());
    none.competenceSteps = [];
    const { s } = await liveRun(provider(JSON.stringify(none)));
    assert.equal(s.competence, "no_steps_proposed");
    assert.equal(s.stop?.step, "competence_steps");
    assert.equal(s.stop?.code, "no_steps_proposed");
  });

  test("competence steps: the block refused on the version records every `competenceProblems` code", async () => {
    // The version's rules are read twice: offline (to find the rule) and when the candidate is built.
    // Serving the rule only on the first read makes the candidate lack it, so the block fails on the
    // version (`competence_rule_unknown`) after the call passed: the refusal a real version can raise.
    const v = version();
    const all = v.criteria;
    let reads = 0;
    Object.defineProperty(v, "criteria", { get: () => (reads++ === 0 ? all : all.filter((c) => c.criterionId !== ID)) });
    const { s } = await liveRun(provider(), v);
    assert.equal(s.stop?.step, "competence_steps");
    assert.equal(s.stop?.code, "competence_problems");
    assert.deepEqual(s.stop?.problems, [...new Set(s.competenceProblems)]);
    assert.ok(s.stop?.problems.includes("competence_rule_unknown"));
  });

  test("a throw between the calls names the step running and the class", async () => {
    const v = version();
    Object.defineProperty(v, "intakeQuestions", { get: () => { throw new TypeError("unexpected"); } });
    const { s } = await liveRun(provider(), v);
    assert.deepEqual(s.stop, { step: "competence_steps", code: "error:TypeError", problems: [] });
  });

  // ---- step 3, the check ----
  test("check: an answer that does not confirm an aspect records every failed aspect", async () => {
    const p = provider();
    p.policy = () => ({ title_faithful: "unsure" });
    const { s } = await liveRun(p);
    assert.equal(s.checkPasses, false);
    assert.deepEqual(s.stop, { step: "check", code: "check_not_passed", problems: ["title_faithful"] });
  });

  test("check: a held check records every reason code the check gave", async () => {
    const { s } = await liveRun(failingAt("check", "hard"));
    assert.equal(s.checkPasses, false);
    // The checker catches the provider error itself and holds: its reason codes are the problems.
    assert.deepEqual(s.stop, { step: "check", code: "check_held", problems: ["checker_unavailable:provider"] });
  });

  test("a run that passes has no stop", async () => {
    const { s } = await liveRun(provider());
    assert.equal(s.checkPasses, true);
    assert.equal(s.stop, null);
  });
});

describe("(#455) the --out file keeps the competence code word and the stop", () => {
  test("a stopped run's file says where and why (the result's null block no longer hides the code word)", async () => {
    const { s } = await liveRun(failingAt("competence", "truncated"));
    const file = outFileOf(ID, s);
    // The shape derive-version-from-one-rule reads is unchanged: the block field is null, no rule.
    assert.equal(file.competence, null);
    assert.equal(file.rule, null);
    assert.equal(file.competenceOutcome, "failed:RunStop");
    assert.deepEqual(file.stop, { step: "competence_steps", code: "output_truncated", problems: [] });
    assert.equal(file.requests, 2);
  });

  test("a kept run's file still holds the block at the top level", async () => {
    const { s } = await liveRun(provider());
    const file = outFileOf(ID, s) as any;
    assert.ok(Array.isArray(file.competence.steps) && file.competence.steps.length === 3);
    assert.equal(file.stop, null);
  });
});

describe("(#455) every model answer is kept locally, never printed", () => {
  test("every answer (and its step and role) reaches onAnswer, in order, verbatim", async () => {
    const p = provider();
    const { s, answers } = await liveRun(p);
    assert.equal(s.answersReceived, 3);
    assert.deepEqual(answers.map((a) => (a.kind === "stop_detail" ? a.kind : `${a.kind}:${a.step}:${a.role}`)), ["answer:redraft:judgement", "answer:competence_steps:judgement", "answer:check:verification"]);
    const intake = answers[1];
    assert.ok(intake.kind === "answer" && intake.response.text === intakeAnswer());
  });

  test("a provider error is kept with its class, and the stop's detail is kept next to it", async () => {
    const { answers } = await liveRun(failingAt("competence", { text: "not json" }));
    assert.equal(answers.filter((a) => a.kind === "answer").length, 2);
    const detail = answers.find((a) => a.kind === "stop_detail");
    assert.ok(detail && detail.kind === "stop_detail" && detail.code === "invalid_model_output" && detail.detail.length > 0);
    const { answers: errs } = await liveRun(failingAt("competence", "hard"));
    const err = errs.find((a) => a.kind === "error");
    assert.ok(err && err.kind === "error" && err.errorClass === "LlmProviderError" && /status=400/.test(err.message));
  });

  test("the printed stop line names the step and the code word only: no quote, no model text", async () => {
    const lines: string[] = [];
    const secret = "MODEL-TEXT-THAT-MUST-NOT-PRINT";
    await liveRun(failingAt("competence", { text: `{"intakeQuestions": "${secret}"` }), version(), lines);
    const printed = lines.join("\n");
    assert.ok(lines.some((l) => l === `${ID}: stopped at competence_steps: invalid_model_output.`), printed);
    assert.ok(!printed.includes(secret));
    assert.ok(!printed.includes(LEAD_IN));
    // A refusal by code prints its problem codes (code words), still no model text.
    const dropped: string[] = [];
    await liveRun(provider(intakeAnswer(["sole destination", "the country of longest stay", "external border the applicant intends to cross"])), version(), dropped);
    assert.ok(dropped.some((l) => /^crit_a96b72ed1cc11170: stopped at competence_steps: competence_dropped \([a-z_,:]+\)\.$/.test(l)), dropped.join("\n"));
  });

  test("the CLI writer creates the answers file with mode 0600 and rewrites it on every entry", () => {
    const dir = mkdtempSync(join(tmpdir(), "one-rule-answers-"));
    const out = join(dir, "result.json");
    const path = answersPathFor(out);
    assert.equal(path, `${out}.answers.json`);
    const write = answersFileWriter(path, ID);
    const first: SavedAnswer = { kind: "answer", n: 1, step: "redraft", role: "judgement", requestHash: "h1", response: { text: "a", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: "m" } };
    write(first);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    write({ kind: "error", n: 2, step: "competence_steps", role: "judgement", requestHash: "h2", errorClass: "LlmProviderError", message: "status=400 bad request" });
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const back = readAnswersFile(JSON.parse(readFileSync(path, "utf8")));
    assert.equal(back.length, 2);
    assert.deepEqual(back[0], first);
  });

  test("the answers file must be new and writable, tested like --out (and the test leaves nothing behind)", () => {
    const dir = mkdtempSync(join(tmpdir(), "one-rule-answers-"));
    const out = join(dir, "result.json");
    assert.equal(answersFileProblem(out), null);
    assert.equal(existsSync(answersPathFor(out)), false);
    writeFileSync(answersPathFor(out), "{}");
    assert.equal(answersFileProblem(out), "answers_exists");
    assert.equal(answersFileProblem(join(dir, "no-such-folder", "result.json")), "answers_not_writable");
  });

  test("the command line refuses --live when the answers file is already there, before reading anything (exit 2)", () => {
    const dir = mkdtempSync(join(tmpdir(), "one-rule-answers-"));
    const out = join(dir, "result.json");
    writeFileSync(answersPathFor(out), "{}");
    const script = join(__dirname, "..", "..", "..", "src", "scrapers", "rubric", "scripts", "redraft-competence-rule.ts");
    const run = spawnSync(process.execPath, ["--import", "tsx", script, "--page", join(dir, "none.json"), "--version", join(dir, "none.json"), "--rule", ID, "--live", "--out", out], { encoding: "utf8", env: { ...process.env, ANTHROPIC_API_KEY: "" } });
    assert.equal(run.status, 2);
    assert.match(run.stderr, /refused before any spend \(answers_exists\)/);
    assert.equal(existsSync(out), false);
    const both = spawnSync(process.execPath, ["--import", "tsx", script, "--page", join(dir, "none.json"), "--version", join(dir, "none.json"), "--rule", ID, "--live", "--out", join(dir, "x.json"), "--replay", answersPathFor(out)], { encoding: "utf8", env: { ...process.env, ANTHROPIC_API_KEY: "" } });
    assert.equal(both.status, 2);
    assert.match(both.stderr, /live_and_replay/);
  });
});

describe("(#455) --replay: the code steps on saved answers, 0 requests, the same outcome", () => {
  /** The outcome fields a replay must reproduce (everything but the request count and the replay flag). */
  const outcomeOf = (s: CompetenceRuleRunSummary) => {
    const { requests: _r, replayed: _p, ...rest } = s;
    return JSON.parse(JSON.stringify(rest));
  };

  const cases: [string, () => ScriptedProvider][] = [
    ["a kept result", () => provider()],
    ["a truncated competence answer", () => failingAt("competence", "truncated")],
    ["an unreadable competence answer", () => failingAt("competence", { text: "not json" })],
    ["a dropped block", () => provider(intakeAnswer(["sole destination", "the country of longest stay", "external border the applicant intends to cross"]))],
    ["a transient failure retried, then a hard one", () => failingAt("competence", "transient")],
    ["a provider error on the re-draft", () => failingAt("redraft", "hard")],
    ["a check that does not pass", () => { const p = provider(); p.policy = () => ({ title_faithful: "unsure" }); return p; }],
  ];
  for (const [name, make] of cases) {
    test(`${name}: the replay gives the live run's outcome with 0 requests`, async () => {
      const live = await liveRun(make());
      const replay = new ReplayProvider(live.answers);
      const lines: string[] = [];
      const again = await runCompetenceRule(PAGE, version(), ID, { live: true, replay: true, verdicts: "uyayaa", provider: replay, print: (l) => lines.push(l) });
      assert.equal(again.requests, 0);
      assert.equal(again.replayed, true);
      assert.deepEqual(outcomeOf(again), outcomeOf(live.s));
      assert.equal(replay.left(), 0);
    });
  }

  test("a replay that runs out of answers, or whose answers are for another step, says so", async () => {
    const live = await liveRun(provider());
    const short = await runCompetenceRule(PAGE, version(), ID, { live: true, replay: true, verdicts: "uyayaa", provider: new ReplayProvider(live.answers.slice(0, 1)), ...quiet });
    assert.equal(short.stop?.code, "replay_exhausted");
    assert.equal(short.requests, 0);
    // With no failed aspect there is no re-draft: the saved re-draft answer is asked for by the competence step.
    const mismatch = await runCompetenceRule(PAGE, version(), ID, { live: true, replay: true, verdicts: "yyayaa", provider: new ReplayProvider(live.answers), ...quiet });
    assert.equal(mismatch.stop?.code, "replay_mismatch");
  });

  test("the command line replays a saved answers file with 0 requests and no key, and writes --out", async () => {
    const dir = mkdtempSync(join(tmpdir(), "one-rule-replay-"));
    const live = await liveRun(failingAt("competence", "truncated"));
    const answersPath = join(dir, "result.json.answers.json");
    writeFileSync(answersPath, JSON.stringify({ ruleId: ID, entries: live.answers }));
    writeFileSync(join(dir, "page.json"), JSON.stringify(PAGE));
    writeFileSync(join(dir, "version.json"), JSON.stringify(version()));
    const script = join(__dirname, "..", "..", "..", "src", "scrapers", "rubric", "scripts", "redraft-competence-rule.ts");
    const out = join(dir, "replay.json");
    const run = spawnSync(process.execPath, ["--import", "tsx", script, "--page", join(dir, "page.json"), "--version", join(dir, "version.json"), "--rule", ID, "--verdicts", "uyayaa", "--replay", answersPath, "--out", out], { encoding: "utf8", env: { ...process.env, ANTHROPIC_API_KEY: "" } });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /stopped at competence_steps: output_truncated\./);
    assert.match(run.stdout, /0 request\(s\) made/);
    const file = JSON.parse(readFileSync(out, "utf8"));
    assert.deepEqual(file.stop, { step: "competence_steps", code: "output_truncated", problems: [] });
    assert.equal(file.requests, 0);
    assert.equal(file.replayed, true);
    // A replay keeps no answers file of its own.
    assert.equal(existsSync(answersPathFor(out)), false);
  });
});

describe("(#455, owner decision 2026-11-21) the drafting calls use production drafting's output limit", () => {
  const drafting = DEFAULT_RUBRIC_SETTINGS.maxOutputTokensPerRequest;
  const checking = DEFAULT_PUBLISH_SETTINGS.checkerMaxOutputTokensPerRequest;

  test("the two limits differ (otherwise this test proves nothing)", () => {
    assert.notEqual(drafting, checking);
  });

  test("offline: the plan names each call's output limit, and prints it", async () => {
    const lines: string[] = [];
    const s = await runCompetenceRule(PAGE, version(), ID, { live: false, verdicts: "uyayaa", print: (l) => lines.push(l) });
    assert.deepEqual(s.planned.map((p) => `${p.step}:${p.maxOutputTokens}`), [`redraft:${drafting}`, `competence_steps:${drafting}`, `check:${checking}`]);
    assert.ok(lines.some((l) => l === `  planned request 1: redraft, role judgement, output limit ${drafting} tokens`), lines.join("\n"));
    assert.ok(lines.some((l) => /^ {2}planned request 2: competence_steps, role judgement, \d+ characters, output limit (\d+) tokens$/.test(l) && l.endsWith(`limit ${drafting} tokens`)), lines.join("\n"));
    assert.ok(lines.some((l) => l === `  planned request 3: check, role verification, output limit ${checking} tokens`), lines.join("\n"));
  });

  test("live: the re-draft and the competence call go out with the drafting limit, the check with the checker's", async () => {
    const p = provider();
    await runCompetenceRule(PAGE, version(), ID, { live: true, verdicts: "uyayaa", provider: p, ...quiet });
    assert.deepEqual(p.requests.map((r) => `${r.role}:${r.maxOutputTokens}`), [`judgement:${drafting}`, `judgement:${drafting}`, `verification:${checking}`]);
  });
});

// ============================================
// (#455 fix round 1) QA and review: no key in a replay, a failed answers write, atomic writes, request hashes
// ============================================

describe("(#455 fix round 1) a replay never reads the API key", () => {
  test("the command line replays a saved provider error with a fake key set: the key's value is never handed out", async () => {
    const dir = mkdtempSync(join(tmpdir(), "one-rule-replay-key-"));
    // A saved run whose competence call failed twice transiently, then got no further: the replay
    // re-throws those saved errors, which `describeAnthropicError` describes (and would redact the key in).
    const live = await liveRun(failingAt("competence", "transient"));
    assert.ok(live.answers.some((a) => a.kind === "error"));
    const answersPath = join(dir, "result.json.answers.json");
    writeFileSync(answersPath, JSON.stringify({ ruleId: ID, entries: live.answers }));
    writeFileSync(join(dir, "page.json"), JSON.stringify(PAGE));
    writeFileSync(join(dir, "version.json"), JSON.stringify(version()));
    // The trap (preloaded before the script): logs every time the key's VALUE is read from the
    // environment, and refuses every network call. Like QA's guard, but a read of the name after the
    // key is gone (undefined) is not a read of the key.
    const guard = join(dir, "guard.cjs");
    const log = join(dir, "guard-log.json");
    writeFileSync(guard, `
      const real = process.env; const reads = [];
      process.env = new Proxy(real, { get(t, k) { if (typeof k === "string" && /ANTHROPIC|API_KEY/.test(k) && t[k] !== undefined) reads.push(k); return t[k]; } });
      const block = (name) => function () { reads.push("NET:" + name); throw new Error("network blocked"); };
      for (const m of ["http", "https", "net", "tls"]) { const mod = require(m); for (const f of ["request", "connect", "get"]) if (mod[f]) mod[f] = block(m + "." + f); }
      globalThis.fetch = block("fetch");
      process.on("exit", () => require("fs").writeFileSync(${JSON.stringify(log)}, JSON.stringify(reads)));
    `);
    const script = join(__dirname, "..", "..", "..", "src", "scrapers", "rubric", "scripts", "redraft-competence-rule.ts");
    const fakeKey = "sk-ant-fake-key-for-the-trap-0000000000";
    const run = spawnSync(process.execPath, ["--require", guard, "--import", "tsx", script, "--page", join(dir, "page.json"), "--version", join(dir, "version.json"), "--rule", ID, "--verdicts", "uyayaa", "--replay", answersPath], { encoding: "utf8", env: { ...process.env, ANTHROPIC_API_KEY: fakeKey } });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /stopped at competence_steps: provider_error\./);
    assert.match(run.stdout, /0 request\(s\) made/);
    assert.deepEqual(JSON.parse(readFileSync(log, "utf8")), []);
    assert.ok(!run.stdout.includes(fakeKey) && !run.stderr.includes(fakeKey));
  });
});

describe("(#455 fix round 1) a failed answers write is `answers_write_failed`, never `provider_error`", () => {
  /** An onAnswer that fails like a full disk on the n-th entry. */
  const failOn = (nth: number) => {
    let n = 0;
    return (_e: SavedAnswer): void => {
      if (++n === nth) throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
    };
  };

  test("an answer that arrived and could not be kept stops the run, and nothing more is sent", async () => {
    const p = provider();
    // Entry 1 is the re-draft's answer; entry 2 is the competence answer: it fails.
    const s = await runCompetenceRule(PAGE, version(), ID, { live: true, verdicts: "uyayaa", provider: p, onAnswer: failOn(2), ...quiet });
    assert.deepEqual(s.stop, { step: "competence_steps", code: "answers_write_failed", problems: ["write:ENOSPC", "entry:answer"] });
    assert.equal(p.requests.length, 2);
    assert.equal(s.requests, 2);
    assert.equal(s.checkLetters, null);
  });

  test("a provider error that could not be kept: the provider's error is still what the step saw, the stop names the write", async () => {
    const p = failingAt("competence", "hard");
    const s = await runCompetenceRule(PAGE, version(), ID, { live: true, verdicts: "uyayaa", provider: p, onAnswer: failOn(2), ...quiet });
    assert.deepEqual(s.stop, { step: "competence_steps", code: "answers_write_failed", problems: ["write:ENOSPC", "entry:error"] });
    assert.equal(p.requests.length, 2);
  });

  test("a failed write during the check stops sending too", async () => {
    const p = provider();
    const s = await runCompetenceRule(PAGE, version(), ID, { live: true, verdicts: "uyayaa", provider: p, onAnswer: failOn(3), ...quiet });
    assert.deepEqual(s.stop, { step: "check", code: "answers_write_failed", problems: ["write:ENOSPC", "entry:answer"] });
    assert.equal(p.requests.length, 3);
  });
});

describe("(#455 fix round 1) the answers file is written atomically", () => {
  const entry = (n: number): SavedAnswer => ({ kind: "answer", n, step: "redraft", role: "judgement", requestHash: `h${n}`, response: { text: `answer ${n}`, stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: "m" } });

  test("each write replaces the whole file in one rename: no temporary file is left, the mode stays 0600", () => {
    const dir = mkdtempSync(join(tmpdir(), "one-rule-atomic-"));
    const path = join(dir, "result.json.answers.json");
    const write = answersFileWriter(path, ID);
    write(entry(1));
    const firstInode = statSync(path).ino;
    write(entry(2));
    // A rename puts a NEW file in place (another inode): the old one was never truncated in place.
    assert.notEqual(statSync(path).ino, firstInode);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(dir), ["result.json.answers.json"]);
    assert.deepEqual(readAnswersFile(JSON.parse(readFileSync(path, "utf8"))).map((e) => (e as any).n), [1, 2]);
  });

  test("a write that fails leaves the previous complete file in place", () => {
    const dir = mkdtempSync(join(tmpdir(), "one-rule-atomic-"));
    const path = join(dir, "result.json.answers.json");
    const write = answersFileWriter(path, ID);
    write(entry(1));
    // Block the temporary file's name, so the next write fails before anything is renamed.
    writeFileSync(`${path}.tmp-${process.pid}`, "");
    assert.throws(() => write(entry(2)));
    assert.deepEqual(readAnswersFile(JSON.parse(readFileSync(path, "utf8"))).map((e) => (e as any).n), [1]);
  });

  test("a file that appeared after the pre-flight check is never replaced", () => {
    const dir = mkdtempSync(join(tmpdir(), "one-rule-atomic-"));
    const path = join(dir, "result.json.answers.json");
    writeFileSync(path, "earlier");
    assert.throws(() => answersFileWriter(path, ID)(entry(1)));
    assert.equal(readFileSync(path, "utf8"), "earlier");
  });
});

describe("(#455 fix round 1) a replay hands an answer only to the request it answered", () => {
  test("every saved answer carries its request's fingerprint", async () => {
    const p = provider();
    const { answers } = await liveRun(p);
    const saved = answers.filter((a) => a.kind === "answer") as Extract<SavedAnswer, { kind: "answer" }>[];
    assert.deepEqual(saved.map((a) => a.requestHash), p.requests.map((r) => requestHashOf(r)));
  });

  test("a replay with another route name (other prompts, same steps and roles) stops with `replay_mismatch`", async () => {
    const live = await liveRun(provider());
    const s = await runCompetenceRule(PAGE, version(), ID, { live: true, replay: true, routeName: "another route", verdicts: "uyayaa", provider: new ReplayProvider(live.answers), ...quiet });
    assert.equal(s.stop?.code, "replay_mismatch");
    assert.equal(s.requests, 0);
  });
});
