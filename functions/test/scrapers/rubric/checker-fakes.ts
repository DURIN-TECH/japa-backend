// ============================================
// Fakes for the independent rule check (issue #202)
// ============================================
//
// Not a test file. A SCRIPTED provider that answers the check's requests by
// reading them (the handles and the rule fields are in the request), an
// in-memory ledger, and builders for rules and a one-page snapshot. There is
// no network and no model: every "model answer" comes from a policy written in
// the test. A request the policy cannot answer fails the test loudly.

import { LlmProviderError, type LlmProvider, type LlmRequest, type LlmResponse } from "../../../src/services/ai/llm-provider";
import type { AiModelRole } from "../../../src/services/ai/ai-models";
import { CHECKER_ASPECTS, type CheckerVerdict } from "../../../src/scrapers/rubric/rubric-checker-prompt";
import type { CheckerLedger, RubricCheckerRun } from "../../../src/scrapers/rubric/rubric-checker";
import type { GuidanceSnapshotContent } from "../../../src/scrapers/guidance/types";
import { DEFAULT_PUBLISH_SETTINGS, type LoadedPublishSettings, type RubricPublishSettings } from "../../../src/scrapers/rubric/rubric-publish-settings";
import type { AssessmentCriterion, VisaRubric } from "../../../src/types/rubric";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** A rule as the request shows it to the model. */
export type SeenRule = Record<string, any>;

/** What a policy may override for one rule: any aspect. */
export type RowPolicy = (ctx: { role: AiModelRole; rule: SeenRule; handle: string }) => Partial<Record<(typeof CHECKER_ASPECTS)[number], CheckerVerdict>> | void;

/** One scripted failure for the n-th call (1-based). */
export type CallScript = (n: number, req: LlmRequest) => "transient" | "hard" | "refusal" | "truncated" | { text: string } | void;

/** The request's rules (rule batches only). */
export function seenRules(req: LlmRequest): SeenRule[] {
  const m = /<(rules_data_[0-9a-f]{16})>\n(.*)\n<\/\1>/s.exec(req.user);
  if (!m) throw new Error("not a rule-check request");
  return JSON.parse(m[2]);
}

/** The sentence of a polarity request. */
export function seenSentence(req: LlmRequest): string {
  const m = /<(sentence_data_[0-9a-f]{16})>\n(.*)\n<\/\1>/s.exec(req.user);
  if (!m) throw new Error("not a polarity request");
  return m[2];
}

/** A scripted provider. Models are named per role so a test can tell them apart. */
export class ScriptedProvider implements LlmProvider {
  readonly requests: LlmRequest[] = [];
  policy: RowPolicy = () => undefined;
  polarity: (role: AiModelRole, sentence: string) => string = () => "immigrant_intent_penalised";
  script: CallScript = () => undefined;
  usage = { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 };

  modelFor(role: AiModelRole): string {
    return `model-for-${role}`;
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    this.requests.push(req);
    const n = this.requests.length;
    const scripted = this.script(n, req);
    const base = (text: string, stopReason: string | null = "end_turn"): LlmResponse => ({ text, stopReason, usage: { ...this.usage }, model: this.modelFor(req.role) });
    if (scripted === "transient") throw new LlmProviderError("provider_error", "status=529 overloaded");
    if (scripted === "hard") throw new LlmProviderError("provider_error", "status=400 bad request");
    if (scripted === "refusal") return base("", "refusal");
    if (scripted === "truncated") return base("{\"verdicts\":[", "max_tokens");
    if (scripted) return base(scripted.text);
    if ("answer" in (req.schema as any).properties) return base(JSON.stringify({ answer: this.polarity(req.role, seenSentence(req)) }));
    const rules = seenRules(req);
    return base(
      JSON.stringify({
        verdicts: rules.map((rule) => {
          const row: Record<string, string> = { id: rule.id };
          for (const a of CHECKER_ASPECTS) {
            // Default: yes where the aspect applies, na where the rule has no such field.
            row[a] = a === "check_faithful" && !rule.check ? "na" : a === "group_matches_codes" && !rule.appliesTo ? "na" : a === "condition_faithful" && rule.applicability === null ? "na" : "yes";
          }
          return { ...row, ...(this.policy({ role: req.role, rule, handle: rule.id }) ?? {}) };
        }),
      })
    );
  }
}

/** An in-memory ledger. */
export class MemoryLedger implements CheckerLedger {
  readonly docs = new Map<string, RubricCheckerRun>();
  saves = 0;
  // Pretend this many OTHER runs already reached the model today.
  otherRunsToday = 0;
  async load(runId: string) {
    return this.docs.get(runId) ?? null;
  }
  async save(r: RubricCheckerRun) {
    this.saves += 1;
    this.docs.set(r.runId, JSON.parse(JSON.stringify(r)));
  }
  async countRunsOnDay(_day: string, except: string) {
    return this.otherRunsToday + [...this.docs.values()].filter((d) => d.runId !== except && d.reachedModel).length;
  }
}

/** Settings with overrides. */
export function settingsWith(over: Partial<RubricPublishSettings> = {}): () => Promise<LoadedPublishSettings> {
  return async () => ({ settings: { ...DEFAULT_PUBLISH_SETTINGS, mode: "auto", ...over }, exists: true, problems: [] });
}

export const SRC_ID = "synthetic-rules";
export const SRC_HASH = "a".repeat(64);

/** One rule per line of a synthetic page: line i reads "R{i}.1 The decision maker must consider matter number {i} of the application." */
export const lineOf = (i: number) => `R${i}.1 The decision maker must consider matter number ${i} of the application.`;
export const quoteOf = (i: number) => `The decision maker must consider matter number ${i} of the application.`;

/** The page the rules cite. `extra` lines are appended (to plant text in a window). */
export function pageOf(count: number, extra: string[] = [], opts: { between?: Record<number, string[]>; trailing?: Record<number, string> } = {}): GuidanceSnapshotContent {
  const lines: string[] = [];
  for (let i = 1; i <= count; i++) {
    // `trailing` text sits on the SAME line after the quote: inside the check's window.
    lines.push(opts.trailing?.[i] ? `${lineOf(i)} ${opts.trailing[i]}` : lineOf(i));
    lines.push(...(opts.between?.[i] ?? []));
  }
  lines.push(...extra);
  return { schemaVersion: 1, sourceId: SRC_ID, contentHash: SRC_HASH, docType: "html", url: "https://rules.example/page", finalUrl: "https://rules.example/page", fetchedAt: "2026-11-13T00:00:00Z", text: lines.join("\n"), pages: null };
}

/** A stored rule citing line `i` of the page. */
export function ruleOf(i: number, over: Partial<AssessmentCriterion> = {}): AssessmentCriterion {
  return {
    criterionId: `crit-${String(i).padStart(4, "0")}`,
    title: `Matter ${i}`,
    kind: "judgement",
    stage: "eligibility",
    severity: "high",
    source: { quote: quoteOf(i), sourceId: SRC_ID, url: "https://rules.example/page", contentHash: SRC_HASH, retrievedAt: "2026-11-13T00:00:00Z" },
    probeFactors: ["a factor"],
    applicability: "all_applicants",
    confidence: 0.9,
    ...over,
  };
}

/** A protected rule: a bar on two named groups. */
export function barOf(i: number, over: Partial<AssessmentCriterion> = {}): AssessmentCriterion {
  return ruleOf(i, { kind: "mandatory_bar", stage: "suitability", appliesTo: { nationalities: ["QM", "QN"], asWritten: ["Group One", "Group Two"] }, ...over });
}

/** A draft of the given rules (only the fields the check reads). */
export function rubricOf(criteria: AssessmentCriterion[], proposal: VisaRubric["intentPolarityProposal"] = null): VisaRubric {
  return { routeKey: "XA_xa-test", version: 1, criteria, intentPolarityProposal: proposal } as unknown as VisaRubric;
}
