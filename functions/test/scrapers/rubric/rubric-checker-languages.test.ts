// ============================================
// The independent checks across languages (issue #220)
// ============================================
//
// A quote may be in any language; titles, questions and document names are
// English by design. These tests prove, with scripted ("recorded") model
// answers over INVENTED Spanish sentences, that:
//  - the prompts say so, and their versions moved (stored verdicts are keyed on
//    the version, so none from before is reused);
//  - the request shows the model the Spanish quote VERBATIM next to the English
//    title, and every verdict aspect is carried through for a Spanish rule;
//  - the intention-to-stay reading is still shown only the quote;
//  - the question check shows the Spanish quote and answers per aspect.
// The model is a policy written here; no live call is made.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { LlmProvider, LlmRequest, LlmResponse } from "../../../src/services/ai/llm-provider";
import { CHECKER_ASPECTS, CHECKER_POLARITY_SYSTEM_PROMPT, CHECKER_PROMPT_VERSION, CHECKER_SYSTEM_PROMPT, buildVerdictSchema } from "../../../src/scrapers/rubric/rubric-checker-prompt";
import { RubricCheckerService } from "../../../src/scrapers/rubric/rubric-checker";
import { EVIDENCE_SYSTEM_PROMPT, QUESTION_ASPECTS, QUESTION_CHECK_PROMPT_VERSION, QUESTION_SYSTEM_PROMPT, runQuestionCheck } from "../../../src/scrapers/rubric/rubric-question-check";
import { type AssessmentCriterion, type IntakeQuestion, type VisaRubric } from "../../../src/types/rubric";
import { answer, crit, criteriaWire } from "./rubric-harness";
import { MemoryLedger, ScriptedProvider, SRC_HASH, SRC_ID, seenRules, seenSentence, settingsWith } from "./checker-fakes";
import type { GuidanceSnapshotContent } from "../../../src/scrapers/guidance/types";

/* eslint-disable @typescript-eslint/no-explicit-any */

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

// ---- invented Spanish sentences and their English wording ----
const Q_DAYS = "El solicitante debe permanecer en el territorio durante treinta días consecutivos antes de presentar la solicitud.";
const Q_AGE = "El solicitante debe tener al menos 18 años de edad.";
const Q_FEE = "La tasa es de 1.000,50 unidades y debe pagarse en la oficina.";
const Q_BAR = "Se deniega la solicitud a los nacionales de Borduria y Syldavia desde el 12 de marzo de 2024.";
const Q_COND = "Si el solicitante viaja con menores, debe presentar el consentimiento de ambos progenitores.";

const PAGE: GuidanceSnapshotContent = {
  schemaVersion: 1, sourceId: SRC_ID, contentHash: SRC_HASH, docType: "html", url: "https://rules.example/es", finalUrl: "https://rules.example/es", fetchedAt: "2026-11-13T00:00:00Z",
  text: [`Art. 1. ${Q_DAYS}`, `Art. 2. ${Q_AGE}`, `Art. 3. ${Q_FEE}`, `Art. 4. ${Q_BAR}`, `Art. 5. ${Q_COND}`].join("\n"),
  pages: null,
};

const base = { sourceId: SRC_ID, url: "https://rules.example/es", contentHash: SRC_HASH, retrievedAt: "2026-11-13T00:00:00Z" };
const rule = (id: string, title: string, quote: string, extra: Partial<AssessmentCriterion> = {}): AssessmentCriterion =>
  ({ criterionId: id, title, kind: "judgement", stage: "eligibility", severity: "high", source: { ...base, quote }, probeFactors: ["a factor"], applicability: "all_applicants", confidence: 0.9, ...extra }) as AssessmentCriterion;
const rubricOf = (criteria: AssessmentCriterion[]): VisaRubric => ({ routeKey: "XA_xa-test", version: 1, criteria, intentPolarityProposal: { value: "immigrant_intent_penalised", source: { ...base, quote: Q_DAYS } } } as unknown as VisaRubric);

function rig() {
  const provider = new ScriptedProvider();
  const svc = new RubricCheckerService({ provider: () => provider, readSnapshot: async () => PAGE, loadSettings: settingsWith(), ledger: new MemoryLedger(), nowMs: () => Date.parse("2026-11-13T10:00:00Z"), sleep: async () => undefined });
  return { provider, svc };
}
const input = (rubric: VisaRubric) => ({ routeKey: rubric.routeKey, version: 1, runId: `${rubric.routeKey}__v1`, rubric, codeLeftOutIds: [] as string[] });

describe("the prompts say a quote may be in any language", () => {
  test("rule check: any language, English titles by design, faithfulness across languages, doubt is unsure", () => {
    assert.match(CHECKER_SYSTEM_PROMPT, /may be written in any language/);
    assert.match(CHECKER_SYSTEM_PROMPT, /written in English by design/);
    assert.match(CHECKER_SYSTEM_PROMPT, /ACROSS the two languages/);
    assert.match(CHECKER_SYSTEM_PROMPT, /answer `unsure` for it: never `yes`/);
    assert.match(CHECKER_POLARITY_SYSTEM_PROMPT, /any language/);
  });

  test("question and document checks say the same", () => {
    for (const p of [QUESTION_SYSTEM_PROMPT, EVIDENCE_SYSTEM_PROMPT]) {
      assert.match(p, /may be written in any language/);
      assert.match(p, /English by design/);
      assert.match(p, /Judge across the two languages/);
    }
  });

  test("the versions moved: no stored verdict of an older prompt is reused", () => {
    assert.notEqual(CHECKER_PROMPT_VERSION, "2026-11-checker-v3");
    assert.notEqual(CHECKER_PROMPT_VERSION, "2026-11-checker-v4", "differs from both v4 prompts (#220 and #226)");
    assert.match(CHECKER_SYSTEM_PROMPT, /Answer `na` when the rule's `kind` is `mandatory_bar`/, "#226 wording kept");
    assert.notEqual(QUESTION_CHECK_PROMPT_VERSION, "question-check-2026-11-13.1");
  });

  // Pins (additive, like the extraction prompt's): changing a prompt without a bump fails here.
  test("the check prompts and schema match the hash pinned for their version", () => {
    const PINNED: Record<string, string> = {
      // (#234) v7: `appliesTo.groups` (the hash literal below moved with the bump).
      "2026-11-checker-v7": sha(`${CHECKER_SYSTEM_PROMPT}\n${JSON.stringify(buildVerdictSchema())}\n${CHECKER_POLARITY_SYSTEM_PROMPT}`),
    };
    // The literal below is the hash at the time of the bump; recompute and re-pin ONLY with a version bump.
    assert.equal(PINNED[CHECKER_PROMPT_VERSION], CHECKER_PINNED_HASH);
    const Q = sha(`${QUESTION_SYSTEM_PROMPT}\n${EVIDENCE_SYSTEM_PROMPT}`);
    assert.equal(Q, QUESTION_PINNED_HASH[QUESTION_CHECK_PROMPT_VERSION]);
  });
});

// Pinned at the #242 bump (v6; v5 was 894d66bb... at the #220 bump). v5 was #220's language wording merged with #226's bar-stage wording. Another change to these prompts needs its own version bump and a new pin here.
const CHECKER_PINNED_HASH = "9e49085b9ac950adf79e7ddc5d583ca718d75cd2c674e76149ee2e40f3aa9070";
const QUESTION_PINNED_HASH: Record<string, string> = { "question-check-2026-11-14.1": "9ac4afe53da9d37bc3331164ec2e4ce41d37f8e4b5e8466654e09dc82f42509b" };

describe("the rule check over a Spanish rule", () => {
  test("the model is shown the Spanish quote verbatim beside the English title, with its Spanish surroundings", async () => {
    const r = rig();
    const out = await r.svc.check(input(rubricOf([rule("c1", "Stays 30 consecutive days", Q_DAYS), rule("c2", "Aged 18 or over", Q_AGE)])));
    assert.equal(out.ok, true);
    const seen = r.provider.requests.flatMap((q) => ((q.schema as any).properties.verdicts ? seenRules(q) : []));
    const first = seen.find((x) => x.title === "Stays 30 consecutive days")!;
    assert.equal(first.quote, Q_DAYS, "the original, not a translation");
    assert.match(first.textBefore, /Art\. 1\./);
    assert.ok(r.provider.requests.every((q) => q.system !== undefined && !/UNOFFICIAL-EN/.test(q.user)));
  });

  for (const aspect of CHECKER_ASPECTS) {
    test(`aspect ${aspect}: a Spanish rule whose English wording the model doubts is carried through (left out, or held for a bar)`, async () => {
      const r = rig();
      r.provider.policy = ({ rule: seen }) => (seen.title.includes("DOUBT") ? { [aspect]: "no" } : undefined);
      const isGroup = aspect === "group_matches_codes";
      const doubted = isGroup
        ? rule("c9", "DOUBT Nationals refused", Q_BAR, { kind: "mandatory_bar", stage: "suitability", appliesTo: { nationalities: ["QM", "QN"], asWritten: ["Borduria", "Syldavia"] } })
        : aspect === "check_faithful"
          ? rule("c9", "DOUBT Stays 45 days", Q_DAYS, { kind: "objective", check: { field: "funds.balance", op: "heldForDays", value: 30, unit: "días" } as any })
          // (#240) kind and stage are tolerated on a JUDGEMENT rule, so those two aspects are doubted on an objective one.
          : aspect === "kind_right" || aspect === "stage_right"
            ? rule("c9", "DOUBT Stays 45 days", Q_DAYS, { kind: "objective", check: { field: "funds.balance", op: "heldForDays", value: 30, unit: "días" } as any })
            : rule("c9", "DOUBT Stays 45 days", Q_DAYS);
      const out = await r.svc.check(input(rubricOf([rule("c1", "Aged 18 or over", Q_AGE), doubted])));
      if (isGroup) {
        assert.equal(out.ok, false);
        if (!out.ok) assert.ok(out.reasonCodes.includes("protected_rule_failed:c9"));
      } else {
        assert.equal(out.ok, true);
        if (out.ok) assert.deepEqual(out.leftOut, [{ criterionId: "c9", reason: `checker:${aspect}`, basis: "found_wrong" }]);
      }
    });
  }

  test("a clean Spanish rulebook passes: every rule kept, nothing left out", async () => {
    const r = rig();
    const out = await r.svc.check(input(rubricOf([rule("c1", "Stays 30 consecutive days", Q_DAYS), rule("c2", "Aged 18 or over", Q_AGE), rule("c3", "Fee of 1,000.50 units", Q_FEE), rule("c5", "Documents when travelling with minors", Q_COND, { applicability: "conditional", applicabilityCondition: "Si el solicitante viaja con menores" })])));
    assert.equal(out.ok, true);
    if (out.ok) assert.deepEqual(out.leftOut, []);
  });

  test("the one-rule re-draft of a failed Spanish bar is validated in Spanish (the Spanish date is read) and can be confirmed", async () => {
    const r = rig();
    r.provider.policy = ({ rule: seen }) => (seen.title.startsWith("REPLACED") ? undefined : seen.appliesTo ? { group_matches_codes: "no" } : undefined);
    r.provider.redraftPolicy = () =>
      criteriaWire(answer({ criteria: [crit({ ref: "r", title: "REPLACED nationals refused", kind: "mandatory_bar", stage: "suitability", quote: Q_BAR, appliesTo: { nationalities: ["QM", "QN"], asWritten: ["Borduria", "Syldavia"] }, validFrom: "2024-03-12" })] }));
    const bar = rule("c9", "Nationals refused", Q_BAR, { kind: "mandatory_bar", stage: "suitability", appliesTo: { nationalities: ["QM", "QN"], asWritten: ["Borduria", "Syldavia"] } });
    const rubric = rubricOf([bar]);
    (rubric as any).sourceSnapshots = [{ sourceId: SRC_ID, contentHash: SRC_HASH, url: "https://rules.example/es", docType: "html", language: "es" }];
    const out = await r.svc.check(input(rubric));
    assert.equal(out.ok, true, JSON.stringify(out));
    if (out.ok) assert.equal(out.repairs?.length, 1, "the replacement passed the Spanish code validation and the check");

    // The same version with NO recorded language reads the quote with the product language's rules: the date is unreadable, the re-draft is refused.
    const r2 = rig();
    r2.provider.policy = r.provider.policy;
    r2.provider.redraftPolicy = r.provider.redraftPolicy;
    const out2 = await r2.svc.check(input(rubricOf([bar])));
    assert.equal(out2.ok, false);
  });

  test("the intention-to-stay reading is still shown ONLY the quote (Spanish, verbatim)", async () => {
    const r = rig();
    await r.svc.check(input(rubricOf([rule("c1", "Stays 30 consecutive days", Q_DAYS)])));
    const polarity = r.provider.requests.filter((q) => "answer" in (q.schema as any).properties);
    assert.equal(polarity.length, 2, "both models read it");
    for (const q of polarity) {
      assert.equal(seenSentence(q), Q_DAYS);
      assert.ok(!q.user.includes("Stays 30"), "no title");
      assert.ok(!q.user.includes("crit") && !q.user.includes("c1"));
    }
  });
});

describe("the question check over a Spanish rule", () => {
  const view = () => ({
    criteria: [rule("c1", "Aged 18 or over", Q_AGE)],
    intakeQuestions: [{ id: "q1", label: "Are you 18 or over?", answerType: "yes_no", required: true, criterionIds: ["c1"] }, { id: "q2", label: "Is your income high?", answerType: "yes_no", required: true, criterionIds: ["c1"] }] as IntakeQuestion[],
    evidenceItems: [],
  });
  const provider = (): LlmProvider & { requests: LlmRequest[] } => {
    const requests: LlmRequest[] = [];
    return {
      requests,
      modelFor: () => "m",
      complete: async (req) => {
        requests.push(req);
        const items = JSON.parse(/<user_uploaded_document source="rubric_items">\n([\s\S]*?)\n<\/user_uploaded_document>/.exec(req.user)![1]) as any[];
        const text = JSON.stringify({ verdicts: items.map((it) => ({ id: it.id, ...Object.fromEntries(QUESTION_ASPECTS.map((a) => [a, a === "asks_only_what_quote_requires" && it.question.includes("income") ? "no" : "yes"])) })) });
        return { text, stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: "m" } satisfies LlmResponse;
      },
    };
  };

  test("the model sees the Spanish quote with the English question; a question beyond the quote fails asks_only_what_quote_requires", async () => {
    const p = provider();
    const res = await runQuestionCheck(view(), p);
    assert.match(p.requests[0].user, /El solicitante debe tener al menos 18 años de edad\./);
    assert.match(p.requests[0].user, /Are you 18 or over\?/);
    assert.deepEqual([...res.failedQuestions], [["q2", ["asks_only_what_quote_requires"]]]);
  });
});
