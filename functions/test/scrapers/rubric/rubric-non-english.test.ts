// ============================================
// Non-English sources (issue #220) — validation, translations, job equivalence
// ============================================
//
// No network, no model: a scripted provider, the in-memory Firestore fake and
// snapshot bucket. The documents are INVENTED Spanish text about invented
// figures (no real rule, no real place beyond the invented ones the other
// rubric fixtures already use).
//
// Proved here:
//  1. a Spanish quote is validated in Spanish: "treinta días", "1.000,50", a
//     Spanish date are read; a wrong number, a wrong date and an unreadable
//     number are REJECTED; "Art. 12" is a kept reference;
//  2. extraction records `sourceLanguages`, stores the unofficial translations
//     apart from the quotes, labels them, never shows one to an assessment
//     model, never lets a failed or capped translation block the version;
//  3. the background job writes the same version as the one-shot run, with the
//     translation as a stored, resumable, cap-counted step that cannot fail it;
//  4. English routes are untouched: no translation call, `sourceLanguages: ["en"]`.

import { before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { resetStore, store } from "../../helpers/fake-firestore";
import { assessChunkOutput } from "../../../src/scrapers/rubric/rubric-extraction.service";
import { SnapshotQuoteIndex } from "../../../src/scrapers/rubric/rubric-quote";
import { lexiconFor } from "../../../src/scrapers/language/language-lexicon";
import { DEFAULT_SEVERITY_LEVELS, type AssessmentCriterion } from "../../../src/types/rubric";
import type { GuidanceSnapshotContent } from "../../../src/scrapers/guidance/types";
import type { LlmRequest } from "../../../src/services/ai/llm-provider";
import { QUOTE_TRANSLATION_SYSTEM_PROMPT, UNOFFICIAL_TRANSLATION_LABEL, quoteHashOf, translationView } from "../../../src/scrapers/rubric/rubric-translation";
import { buildTranslationOutputSchema, parseTranslationOutput } from "../../../src/scrapers/rubric/rubric-translation";
import { replaySteps } from "../../../src/scrapers/rubric/rubric-extraction-job";
import { stepIdOf, type RubricExtractionJob } from "../../../src/scrapers/rubric/rubric-extraction-job.store";
import { ROUTE_A } from "./fixtures/synthetic-guidance";
import { RECORDED_USAGE, answer, crit, installRubricFakes, makeHarness, makeJobHarness, quiet, recordAnswers, resetBucket, runDocs, seedSource, versionDoc, versionPaths, type Harness, type JobHarness } from "./rubric-harness";
import type { RawCriterion } from "../../../src/scrapers/rubric/rubric-prompt";

/* eslint-disable @typescript-eslint/no-explicit-any */

const KEY = `${ROUTE_A.countryCode}_${ROUTE_A.visaTypeId}`;
const SOURCE = "es-source";

// ---- An invented Spanish page ----
const L1 = "El solicitante debe permanecer en el territorio durante treinta días consecutivos antes de presentar la solicitud.";
const L2 = "La tasa es de 1.000,50 unidades y debe pagarse en la oficina.";
const L3 = "El solicitante debe tener al menos 18 años de edad.";
const L4 = "El plazo máximo de tramitación es de 3.5 días.";
const L5 = "Se deniega la solicitud a los nacionales de Borduria desde el 12 de marzo de 2024.";
const TEXT = ["Art. 1. " + L1, "Art. 2. " + L2, "Art. 3. " + L3, "Art. 4. " + L4, "Art. 5. " + L5].join("\n");

const snapshot = (text: string): GuidanceSnapshotContent => ({ schemaVersion: 1, sourceId: "es-probe", contentHash: "a".repeat(64), docType: "html", url: "https://rules.example/es", finalUrl: "https://rules.example/es", fetchedAt: "2026-11-11T01:00:00.000Z", text, pages: null });
const INDEX = new SnapshotQuoteIndex(snapshot(TEXT), lexiconFor("es"));
const BASE = { sourceId: "es-probe", url: "https://rules.example/es", contentHash: "a".repeat(64), retrievedAt: "2026-11-11T01:00:00.000Z" };
const CHUNK = { sourceId: "es-probe", chunkIndex: 0 };

const objective = (quote: string, check: RawCriterion["check"], extra: Partial<RawCriterion> = {}) => crit({ ref: "r", title: "T", kind: "objective", quote, check, ...extra });
function assess(c: RawCriterion, index = INDEX) {
  const out = assessChunkOutput(answer({ criteria: [c] }), CHUNK, index, BASE, DEFAULT_SEVERITY_LEVELS);
  return { accepted: out.criteria[0]?.criterion as AssessmentCriterion | undefined, reason: out.discards[0]?.reason, out };
}

before(installRubricFakes);

// ============================================
// 1. Validation in the quote's own language
// ============================================

describe("a Spanish quote is validated in Spanish", () => {
  test("'treinta días' is read: a threshold of 30 with the unit 'días', and an English title with '30 days'", () => {
    const r = assess(objective(L1, { field: "funds.balance", op: "heldForDays", value: 30, unit: "días" }, { title: "Stays 30 consecutive days" }));
    assert.ok(r.accepted, `rejected: ${r.reason}`);
    assert.equal(r.accepted.source.quote, L1, "the quote is stored in the original language, verbatim");
  });

  test("an English number WORD in the title is checked against the Spanish quote too", () => {
    assert.ok(assess(objective(L1, { field: "funds.balance", op: "heldForDays", value: 30, unit: "días" }, { title: "Stays thirty consecutive days" })).accepted);
  });

  test("'1.000,50' is read as 1000.5; the title may write it in English form", () => {
    const r = assess(objective(L2, { field: "fee.amount", op: "eq", value: 1000.5, unit: "unidades" }, { title: "Fee of 1,000.50 units" }));
    assert.ok(r.accepted, `rejected: ${r.reason}`);
  });

  test("a wrong number is REJECTED, in the check and in the title", () => {
    assert.equal(assess(objective(L1, { field: "funds.balance", op: "heldForDays", value: 45, unit: "días" })).reason, "number_not_in_quote");
    assert.equal(assess(objective(L2, { field: "fee.amount", op: "eq", value: 1000, unit: "unidades" })).reason, "number_not_in_quote");
    assert.equal(assess(objective(L3, { field: "applicant.age", op: "gte", value: 18, unit: null }, { title: "Aged 21 or over" })).reason, "number_not_in_quote", "a number the quote does not hold");
  });

  test("a wrong unit is REJECTED (the unit stays verbatim, next to its number)", () => {
    assert.equal(assess(objective(L1, { field: "funds.balance", op: "heldForDays", value: 30, unit: "semanas" })).reason, "unit_not_in_quote");
  });

  test("an UNREADABLE number is still REJECTED, never accepted unverified", () => {
    // '3.5' is not in a shape Spanish writes numbers in, so it supports nothing.
    const r = assess(objective(L4, { field: "funds.balance", op: "heldForDays", value: 3.5, unit: "días" }));
    assert.equal(r.accepted, undefined);
    assert.equal(r.reason, "number_not_in_quote");
    assert.equal(assess(objective(L4, { field: "funds.balance", op: "heldForDays", value: 35, unit: "días" })).reason, "number_not_in_quote");
  });

  test("a Spanish date is read; a different date is REJECTED", () => {
    const bar = (validFrom: string) => crit({ ref: "r", title: "Nationals refused", kind: "mandatory_bar", quote: L5, appliesTo: { nationalities: ["QM"], asWritten: ["Borduria"] }, validFrom });
    assert.ok(assess(bar("2024-03-12")).accepted);
    assert.equal(assess(bar("2024-03-13")).reason, "date_not_in_quote");
  });

  test("the same documents read with the product-language rules would have lost the rule (the fail-closed baseline)", () => {
    const english = new SnapshotQuoteIndex(snapshot(TEXT));
    assert.equal(assess(objective(L1, { field: "funds.balance", op: "heldForDays", value: 30, unit: "días" }), english).reason, "number_not_in_quote");
  });

  test("'Art. 12': the reference printed with the quote is KEPT (not even the informational rule_ref_removed flag)", () => {
    const r = assess(objective(L3, { field: "applicant.age", op: "gte", value: 18, unit: null }, { ruleRef: "Art. 3" }));
    assert.ok(r.accepted);
    assert.equal(r.accepted.ruleRef, "Art. 3");
    assert.equal(r.out.counters.ruleRefsRemoved, 0);
    // The article number labels the rule: it does not support a threshold of 3.
    const label = assess(objective(L3, { field: "applicant.age", op: "gte", value: 3, unit: null }));
    assert.equal(label.reason, "number_not_in_quote");
  });

  test("a rule reference the model invents is dropped, as for any language", () => {
    const r = assess(objective(L3, { field: "applicant.age", op: "gte", value: 18, unit: null }, { ruleRef: "Art. 99" }));
    assert.ok(r.accepted);
    assert.notEqual(r.accepted.ruleRef, "Art. 99");
  });
});

// ============================================
// 2. Extraction: sourceLanguages, translations
// ============================================

let h: Harness;
let jh: JobHarness;

beforeEach(() => {
  resetStore();
  resetBucket();
  h = makeHarness();
});

/** Seed the Spanish page (declared language `language`), and the scripted model for it. */
async function setUpSpanish(language: string | null = "es"): Promise<void> {
  h.state.knownVisaTypes.add(`${ROUTE_A.countryCode}/${ROUTE_A.visaTypeId}`);
  await seedSource({ id: SOURCE, url: "https://rules.example/es", text: TEXT, ...(language ? { language } : {}) });
  await recordAnswers(h.provider, SOURCE, [
    answer({
      criteria: [
        crit({ ref: "r1", title: "Stays 30 consecutive days", kind: "objective", ruleRef: "Art. 1", quote: L1, check: { field: "funds.balance", op: "heldForDays", value: 30, unit: "días" } }),
        crit({ ref: "r2", title: "Fee of 1,000.50 units", kind: "objective", ruleRef: "Art. 2", quote: L2, check: { field: "fee.amount", op: "eq", value: 1000.5, unit: "unidades" } }),
        crit({ ref: "r3", title: "Aged 18 or over", kind: "objective", ruleRef: "Art. 3", quote: L3, check: { field: "applicant.age", op: "gte", value: 18, unit: null } }),
        // dropped by validation: an unreadable number
        crit({ ref: "r4", title: "Processing takes 3.5 days", kind: "objective", quote: L4, check: { field: "funds.balance", op: "heldForDays", value: 3.5, unit: "días" } }),
      ],
      intakeQuestions: [
        { id: "age_q", label: "Are you 18 or over?", helpText: null, answerType: "yes_no", required: true, criterionRefs: ["r3"], group: null, party: null, options: [], textMaxLength: null, dateRelativeToToday: null, showWhenAnyOf: [] },
      ],
    }),
  ]);
}

/** A model that translates every passage it is given (a recognisable marker, so a leak is detectable). */
const MARK = "UNOFFICIAL-EN";
function translateAll(): void {
  h.provider.translate = (req: LlmRequest) => {
    const body = /<(passages_[0-9a-f]+)>\n(.*)\n<\/\1>/.exec(req.user)?.[2] ?? "[]";
    const items = JSON.parse(body) as { ref: string; text: string }[];
    return { text: JSON.stringify({ translations: items.map((i) => ({ ref: i.ref, text: `${MARK} ${i.text.slice(0, 24)}` })) }), usage: RECORDED_USAGE };
  };
}

const extract = (sourceIds = [SOURCE]) => quiet(() => h.service.extractRoute({ ...ROUTE_A, sourceIds, trigger: "manual" })).then((r) => r.result);

describe("extraction of a Spanish source", () => {
  test("records sourceLanguages, stores the quote verbatim, and stores a labelled unofficial translation apart", async () => {
    await setUpSpanish();
    translateAll();
    const res = await extract();
    assert.equal(res.status, "succeeded", res.error ?? "");
    const v = versionDoc(KEY, 1);
    assert.deepEqual(v.sourceLanguages, ["es"]);
    assert.equal(v.criteria.length, 3, "the unreadable-number rule was discarded, the others kept");
    assert.ok(v.discarded.some((d: any) => d.reason === "number_not_in_quote"));
    // The quote is the original, untouched.
    assert.deepEqual(v.criteria.map((c: any) => c.source.quote), [L1, L2, L3]);
    for (const c of v.criteria) {
      const t = v.quoteTranslations[c.criterionId];
      assert.ok(t, "every kept rule has a translation");
      assert.equal(t.unofficial, true);
      assert.equal(t.language, "en");
      assert.equal(t.model, h.provider.modelFor("judgement"));
      assert.match(t.promptVersion, /translate/);
      assert.ok(t.text.startsWith(MARK));
      assert.equal(t.quoteHash, quoteHashOf(c.source.quote));
      // The field the evidence lives in never holds the translation.
      assert.ok(!JSON.stringify(c.source).includes(MARK));
      // The label is defined once and exposed with the translation, and the view refuses a different quote.
      const view = translationView(v, c.criterionId, c.source.quote);
      assert.equal(view?.label, UNOFFICIAL_TRANSLATION_LABEL);
      assert.equal(translationView(v, c.criterionId, c.source.quote + " other"), null);
    }
    assert.equal(Object.keys(v.quoteTranslations).length, 3);
  });

  test("ONE translation call per excerpt, carrying only the quotes", async () => {
    await setUpSpanish();
    translateAll();
    await extract();
    assert.equal(h.provider.translationRequests.length, 1);
    const req = h.provider.translationRequests[0];
    assert.equal(req.system, QUOTE_TRANSLATION_SYSTEM_PROMPT);
    for (const q of [L1, L2, L3]) assert.ok(req.user.includes(q.slice(0, 40)));
    assert.ok(!req.user.includes("Stays 30"), "no title, question or rule wording is sent");
    assert.ok(!/UNOFFICIAL|ruleRef|heldForDays/.test(req.user));
  });

  test("the translation is NEVER in any extraction request, and every request that quotes uses the original", async () => {
    await setUpSpanish();
    translateAll();
    await extract();
    const others = h.provider.requests.filter((r) => r.system !== QUOTE_TRANSLATION_SYSTEM_PROMPT);
    assert.ok(others.length >= 2);
    for (const r of others) assert.ok(!r.user.includes(MARK) && !r.system.includes(MARK));
    const intake = others.find((r) => r.user.includes("Accepted criteria"))!;
    assert.ok(intake.user.includes(L1.slice(0, 40)), "the intake call is shown the original quote");
  });

  test("a failed translation (cut off) leaves the rules without one and never blocks the version", async () => {
    await setUpSpanish();
    h.provider.translate = () => ({ text: "{", stopReason: "max_tokens", usage: RECORDED_USAGE });
    const res = await extract();
    assert.equal(res.status, "succeeded");
    assert.equal(versionDoc(KEY, 1).quoteTranslations, undefined);
    assert.equal(versionDoc(KEY, 1).criteria.length, 3);
  });

  test("an unusable translation answer is dropped per rule; a usable part is kept", async () => {
    await setUpSpanish();
    h.provider.translate = (req) => {
      const items = JSON.parse(/<(passages_[0-9a-f]+)>\n(.*)\n<\/\1>/.exec(req.user)![2]) as { ref: string }[];
      return { text: JSON.stringify({ translations: [{ ref: items[0].ref, text: "ok one" }, { ref: items[1].ref, text: "   " }, { ref: "q99", text: "not asked" }, { ref: items[0].ref, text: "duplicate" }] }), usage: RECORDED_USAGE };
    };
    await extract();
    const v = versionDoc(KEY, 1);
    assert.deepEqual(Object.values(v.quoteTranslations).map((t: any) => t.text), ["ok one"]);
  });

  test("a translation that is not JSON, or throws, fails softly", async () => {
    await setUpSpanish();
    h.provider.translate = () => ({ text: "not json", usage: RECORDED_USAGE });
    assert.equal((await extract()).status, "succeeded");
    assert.equal(versionDoc(KEY, 1).quoteTranslations, undefined);
  });

  test("the translation counts against the request cap; with the cap used up it is skipped and the version is still written", async () => {
    await setUpSpanish();
    translateAll();
    h.settings.maxRequestsPerRun = 2; // exactly the criteria call and the intake call
    const res = await extract();
    assert.equal(res.status, "succeeded", res.error ?? "");
    assert.equal(h.provider.translationRequests.length, 0, "no call past the cap");
    assert.equal(versionDoc(KEY, 1).quoteTranslations, undefined);
    assert.equal(res.usage.requests, 2);
  });

  test("with the cap to spare, the translation call is counted in the run's usage", async () => {
    await setUpSpanish();
    translateAll();
    const res = await extract();
    assert.equal(res.usage.requests, 3, "criteria + intake + translation");
  });

  test("a source with no declared language is the product language: no translation, sourceLanguages [en]", async () => {
    await setUpSpanish(null);
    // The English reading of Spanish numbers drops what needs them, but the run still records what the source said.
    translateAll();
    const res = await extract();
    assert.equal(res.status, "succeeded", res.error ?? "");
    assert.deepEqual(versionDoc(KEY, 1).sourceLanguages, ["en"]);
    assert.equal(h.provider.translationRequests.length, 0);
    assert.equal(versionDoc(KEY, 1).quoteTranslations, undefined);
  });

  test("a language with no data file is read strictly (fewer rules, never a guess) and recorded as written", async () => {
    await setUpSpanish("zz");
    translateAll();
    const res = await extract();
    assert.equal(res.status, "succeeded", res.error ?? "");
    const v = versionDoc(KEY, 1);
    assert.deepEqual(v.sourceLanguages, ["zz"]);
    // Rules with a number in words / in the Spanish format cannot be verified under the strict reading.
    assert.ok(v.criteria.length < 3);
  });

  test("a region code is recorded as its primary language", async () => {
    await setUpSpanish("es-SV");
    translateAll();
    await extract();
    assert.deepEqual(versionDoc(KEY, 1).sourceLanguages, ["es"]);
  });
});

// ============================================
// 3. The job
// ============================================

/** A version without the fields that are run-specific by nature. */
function comparable(v: any): any {
  const { extractionRunId: _run, createdAt: _at, ...rest } = v;
  return JSON.parse(JSON.stringify(rest));
}

const jobId = (res: { jobId: string | null }) => res.jobId as string;
const jobDoc = (id: string) => store.get(`rubricExtractionJobs/${id}`) as unknown as RubricExtractionJob;

async function drain(id: string): Promise<void> {
  for (let i = 0; i < 40; i++) {
    const out = (await quiet(() => jh.jobs.advance(id))).result;
    if (out.kind === "finished" || out.kind === "idle") return;
    if (out.kind === "lease_held" || out.kind === "lease_lost") h.state.nowMs += h.settings.leaseMs + 1;
  }
  throw new Error("the job did not finish");
}

describe("the drafting job and the one-shot run write the same Spanish version", () => {
  test("equivalence, with the translation as a stored step", async () => {
    await setUpSpanish();
    translateAll();
    const shot = await extract();
    assert.equal(shot.status, "succeeded");
    const a = comparable(versionDoc(KEY, 1));
    const shotRequests = h.provider.requests.length;

    // Same everything again, through the job.
    resetStore();
    resetBucket();
    await setUpSpanish();
    translateAll();
    h.provider.requests.length = 0;
    jh = makeJobHarness(h);
    const started = (await quiet(() => jh.jobs.startJob({ ...ROUTE_A, sourceIds: [SOURCE] }))).result;
    assert.equal(started.outcome, "started");
    assert.equal(started.estimate?.translationCallsAtMost, 1);
    assert.equal(started.estimate?.maxRequests, 3);
    await drain(jobId(started));
    assert.equal(versionPaths().length, 1);
    assert.deepEqual(comparable(versionDoc(KEY, 1)), a);
    assert.equal(h.provider.requests.length, shotRequests, "the same calls");
    const job = jobDoc(jobId(started));
    assert.equal(job.status, "succeeded");
    assert.equal(job.usage.requests, 3);
    const stepIds = [...store.keys()].filter((p) => p.startsWith(`rubricExtractionJobs/${jobId(started)}/steps/`)).map((p) => p.split("/").pop());
    assert.deepEqual(stepIds.sort(), [stepIdOf(0, "criteria"), stepIdOf(0, "intake"), stepIdOf(0, "translate")]);
    assert.equal(job.chunksDone, job.chunks);
    assert.ok(job.stepsDone <= job.stepsMax);
    assert.equal(runDocs()[0].status, "succeeded");
  });

  test("a translation step is never paid for twice: a worker replacement after it replays the stored step", async () => {
    await setUpSpanish();
    translateAll();
    jh = makeJobHarness(h);
    const started = (await quiet(() => jh.jobs.startJob({ ...ROUTE_A, sourceIds: [SOURCE] }))).result;
    // Three invocations that each stop after one step.
    for (let i = 0; i < 3; i++) {
      const before = jh.calls.length;
      await quiet(() => jh.jobs.advance(jobId(started), { deadlineAt: h.state.nowMs + 1 }));
      assert.equal(jh.calls.length - before, 1, "one step per invocation");
    }
    await drain(jobId(started));
    assert.equal(jh.calls.filter((c) => c.startsWith("translate")).length, 1);
    assert.equal(h.provider.translationRequests.length, 1);
    assert.ok(versionDoc(KEY, 1).quoteTranslations);
  });

  test("a failed translation is stored as a step, counted, and the job still succeeds", async () => {
    await setUpSpanish();
    h.provider.translate = () => ({ text: "{", stopReason: "max_tokens", usage: RECORDED_USAGE });
    jh = makeJobHarness(h);
    const started = (await quiet(() => jh.jobs.startJob({ ...ROUTE_A, sourceIds: [SOURCE] }))).result;
    await drain(jobId(started));
    assert.equal(jobDoc(jobId(started)).status, "succeeded");
    assert.equal(versionDoc(KEY, 1).quoteTranslations, undefined);
    assert.equal(jobDoc(jobId(started)).usage.requests, 3, "the cut-off answer was billed and counted");
  });

  test("a provider error in the translation is a counted failed attempt, not a failed job", async () => {
    await setUpSpanish();
    jh = makeJobHarness(h);
    jh.beforeCall = (_n, req) => {
      if (req.system === QUOTE_TRANSLATION_SYSTEM_PROMPT) throw Object.assign(new Error("status=400 bad request"), { status: 400 });
    };
    const started = (await quiet(() => jh.jobs.startJob({ ...ROUTE_A, sourceIds: [SOURCE] }))).result;
    await drain(jobId(started));
    const job = jobDoc(jobId(started));
    assert.equal(job.status, "succeeded", job.message ?? "");
    assert.equal(job.failedAttempts, 1);
    assert.equal(versionDoc(KEY, 1).quoteTranslations, undefined);
  });

  test("with the request cap used up the translation step is skipped (stored, no call) and the version is written", async () => {
    await setUpSpanish();
    translateAll();
    h.settings.maxRequestsPerRun = 2;
    jh = makeJobHarness(h);
    const started = (await quiet(() => jh.jobs.startJob({ ...ROUTE_A, sourceIds: [SOURCE] }))).result;
    await drain(jobId(started));
    const job = jobDoc(jobId(started));
    assert.equal(job.status, "succeeded", job.message ?? "");
    assert.equal(h.provider.translationRequests.length, 0);
    assert.equal(versionDoc(KEY, 1).quoteTranslations, undefined);
    assert.equal(job.usage.requests, 2);
  });

  test("a worker that died inside the translation call costs one counted attempt, never the job", async () => {
    await setUpSpanish();
    translateAll();
    jh = makeJobHarness(h);
    const started = (await quiet(() => jh.jobs.startJob({ ...ROUTE_A, sourceIds: [SOURCE] }))).result;
    const id = jobId(started);
    // The predecessor left a translation call in flight.
    store.set(`rubricExtractionJobs/${id}`, { ...jobDoc(id), inFlight: { stepId: stepIdOf(0, "translate"), startedAtMs: h.state.nowMs } } as any);
    await drain(id);
    const job = jobDoc(id);
    assert.equal(job.status, "succeeded", job.message ?? "");
    assert.equal(job.failedAttempts, 1);
    assert.equal(versionDoc(KEY, 1).quoteTranslations, undefined, "the dead step is stored as failed: no translation");
    assert.equal(h.provider.translationRequests.length, 0);
  });

  test("replay: a chunk of a non-product-language source waits for its translation step; others do not", () => {
    const chunk = (sourceId: string) => ({ sourceId, contentHash: "h", docType: "html" as const, chunkIndex: 0, chunkCount: 1, text: "t" });
    const a = { criteria: [{ criterion: { criterionId: "c" } }], discards: [], suspiciousPassages: [], polarity: null, intake: null, intakeQuestions: [], evidenceItems: [], counters: { judgementChecksStripped: 0, ruleRefsRemoved: 0, ruleRefsDerived: 0 } } as any;
    const steps = new Map<string, any>([
      [stepIdOf(0, "criteria"), { result: a }],
      [stepIdOf(0, "intake"), { result: { ...a, criteria: [] } }],
    ]);
    assert.equal(replaySteps([chunk("s") as any], steps, new Set(["s"])).next?.phase, "translate");
    assert.equal(replaySteps([chunk("s") as any], steps, new Set()).next, null, "product language: no extra step (as before #220)");
    steps.set(stepIdOf(0, "translate"), { result: { translations: { c: { text: "x" } }, outcome: "done" } });
    const done = replaySteps([chunk("s") as any], steps, new Set(["s"]));
    assert.equal(done.next, null);
    assert.deepEqual(Object.keys(done.translations), ["c"]);
  });
});

// ============================================
// 4. English routes are untouched
// ============================================

describe("an English route", () => {
  test("makes no translation call and records sourceLanguages [en]", async () => {
    h.state.knownVisaTypes.add(`${ROUTE_A.countryCode}/${ROUTE_A.visaTypeId}`);
    const text = "SV 2.1 An applicant must be aged 18 or over on the date of application.";
    await seedSource({ id: "en-source", url: "https://rules.example/en", text, language: "en" });
    await recordAnswers(h.provider, "en-source", [
      answer({ criteria: [crit({ ref: "age", title: "Aged 18 or over", kind: "objective", quote: "An applicant must be aged 18 or over on the date of application.", check: { field: "applicant.age", op: "gte", value: 18, unit: null } })] }),
    ]);
    translateAll();
    const res = await extract(["en-source"]);
    assert.equal(res.status, "succeeded", res.error ?? "");
    const v = versionDoc(KEY, 1);
    assert.deepEqual(v.sourceLanguages, ["en"]);
    assert.equal(v.quoteTranslations, undefined);
    assert.equal(h.provider.translationRequests.length, 0);
    assert.equal(res.usage.requests, 2);
  });
});

// ============================================
// 5. The translation module itself
// ============================================

describe("translation request and answer", () => {
  test("the answer schema is closed and the label has no outcome wording", () => {
    const schema = buildTranslationOutputSchema() as any;
    assert.equal(schema.additionalProperties, false);
    assert.equal(UNOFFICIAL_TRANSLATION_LABEL, "Unofficial translation, generated by AI. The original text above is the official wording.");
    assert.ok(!/likel|chance|approve|refus|eligible|outcome|will be/i.test(UNOFFICIAL_TRANSLATION_LABEL));
    assert.ok(!/likel|chance of|probab/i.test(QUOTE_TRANSLATION_SYSTEM_PROMPT.replace(/no statement about the chance of any outcome/, "")));
  });

  test("an over-long translation is dropped", () => {
    const items = [{ criterionId: "c1", quote: "corta" }];
    const out = parseTranslationOutput(JSON.stringify({ translations: [{ ref: "q1", text: "x".repeat(5000) }] }), items);
    assert.equal(out.size, 0);
  });
});
