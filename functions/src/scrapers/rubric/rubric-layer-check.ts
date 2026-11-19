import type { AssessmentCriterion, LayerCheckRecord, LayerConflict, RestatesLink } from "../../types/rubric";
import { AnthropicLlmProvider, type LlmProvider, type LlmRequest } from "../../services/ai/llm-provider";
import { DATA_ONLY_RULE, wrapUntrusted } from "../../services/ai/prompt-safety";

// ============================================
// RUBRIC — THE LAYER CHECK: A COUNTRY'S OWN LAYER AGAINST ITS SHARED LAYER(S)
// (issue #233, P4b of #228)
// ============================================
//
// A route that inherits a shared route (a bloc's or a treaty's) is assessed
// against a STACK: the shared rulebook plus the country's own thin rulebook
// (rubric-stack.ts). The own layer is drafted from national pages only and
// keeps every rule they state, so it can REPEAT a shared rule ("you may stay 90
// days in any 180") or DISAGREE with one (a different amount, a different
// period). This module finds both, after the own layer drafts and before its
// automatic approval, so that:
//
//   - a repeat is LINKED (`restates`): the merged view asks and assesses it once,
//     under the shared rule, keeping the national rule's own quote and URL on the
//     record (rubric-stack.ts folds it);
//   - a disagreement is FLAGGED (`layerConflicts`): both quotes and URLs are
//     stored on the own version for the admin. Both rules stay and are both
//     assessed, so the stricter result decides. Nothing ever blocks publishing.
//
// WHY A MODEL. "Same subject", "the same requirement" and "they disagree" are
// language judgements, so they are put to the independent reader the rulebook
// checker uses (role `verification`, ai-models.ts), with this module's own
// prompt and version. Its evidence is ONLY the two verbatim quotes (never a
// title or any other AI-written text). The model never writes or changes a
// rule: its answers are CLOSED (a shared rule id it was shown, and one of four
// relation values), re-validated in code, and code alone turns them into links.
//
// FAIL SAFE, NEVER GUESS. A wrong `restates` link would hide a national rule
// behind a shared one, so:
//   - only `same_requirement` can make a link, and only when the code guards
//     also pass (same kind of rule, same applicability, same coded check, same
//     bar groups, the national rule not more severe, exactly one twin, and no
//     other answer on that rule that doubts or disputes it). A refused link is
//     recorded with its reason; the rules simply stay duplicated (harmless but
//     visible);
//   - if the check cannot run in full (over a cap, a provider failure, an
//     answer that does not validate), the result is `not_checked`, stored
//     visibly, and NOTHING is linked or flagged. A partly checked layer is never
//     reported as checked.
//
// SPEND. Hard caps per run (calls and tokens), checked BEFORE the first call
// (the number of calls is known, the tokens are estimated) and again after
// every call against what the provider reported, exactly as the question
// wording check does (rubric-question-check.ts). The run is recorded on the own
// version (`layerCheck`: model, prompt version, calls, tokens) and as a gate
// line of the publish run record. Re-running a publish run does not re-pay for
// a version already decided (the pipeline's one-record-per-version rule).
//
// Batching is deterministic: own rules in rulebook order, cut into batches of
// `ownBatchSize`; each shared layer's rules in its order, cut into chunks of
// `sharedChunkSize` (both also closed by a character budget so no block is ever
// truncated by prompt-safety). One request per (own batch, shared chunk).
//
// Logging: ids, counts and codes only; never a quote or an answer.
// Generic: nothing here names a country, bloc, treaty, route or nationality.

/**
 * Version of the prompt and schema below. Recorded on every run (`layerCheck.promptVersion`).
 * Documented beside the other rulebook prompts in scrapers/README.md.
 */
export const LAYER_CHECK_PROMPT_VERSION = "layer-check-2026-11-14.1";

/** The relations the model may answer for a pair of rules on the same subject. */
export const LAYER_RELATIONS = ["same_requirement", "adds_to", "disagrees", "unsure"] as const;
export type LayerRelation = (typeof LAYER_RELATIONS)[number];

/** Limits of one layer check (per own version). */
export interface LayerCheckLimits {
  // Own rules per request.
  ownBatchSize: number;
  // Shared rules per request.
  sharedChunkSize: number;
  // Most characters of rule data in ONE untrusted block (prompt-safety truncates at 20,000).
  blockChars: number;
  // Most model calls one run may make.
  maxCalls: number;
  // Most tokens (input plus output, as reported) one run may spend.
  maxTotalTokens: number;
  // Generated-token ceiling per call.
  maxOutputTokensPerCall: number;
  // Wall clock per call.
  timeoutMs: number;
  // Calls in flight at once.
  concurrency: number;
}

/**
 * Defaults, sized from the request shape: about 600 tokens of instructions,
 * about 120 tokens per quote shown, about 40 tokens of answer per own rule.
 *   20 own rules x 120 shared rules: 2 x 5 = 10 calls, about 45,000 input tokens.
 *   60 own rules x 300 shared rules: 6 x 12 = 72 calls: over `maxCalls`, so NOT
 *   checked (stored visibly as `capped`); the rules simply stay duplicated.
 * A national layer is meant to be thin; a cap that large drafts hit is the
 * honest outcome (raise it deliberately, with the estimate above).
 */
export const DEFAULT_LAYER_CHECK_LIMITS: Readonly<LayerCheckLimits> = Object.freeze({
  ownBatchSize: 10,
  sharedChunkSize: 25,
  blockChars: 9_000,
  maxCalls: 40,
  maxTotalTokens: 400_000,
  maxOutputTokensPerCall: 4_000,
  timeoutMs: 120_000,
  concurrency: 4,
});

/** Why a run could not finish. Each maps to a `not_checked` record (never a hold). */
export class LayerCheckError extends Error {
  constructor(
    readonly code: "capped" | "provider_error" | "provider_refused" | "provider_stopped" | "output_invalid",
    message: string
  ) {
    super(message);
    this.name = "LayerCheckError";
  }
}

// ============================================
// Inputs
// ============================================

/** One shared layer as compared: its key, its approved version and its rules as served. */
export interface SharedLayerRules {
  rulebookKey: string;
  version: number;
  criteria: AssessmentCriterion[];
}

/** What a run is given. Both rule lists are as SERVED (leave-outs applied). */
export interface LayerCheckInput {
  ownRulebookKey: string;
  ownCriteria: AssessmentCriterion[];
  shared: SharedLayerRules[];
}

/** A quote longer than this is cut (and marked) in the payload. */
const MAX_QUOTE_CHARS = 1_200;
const clip = (text: string): string => (text.length > MAX_QUOTE_CHARS ? `${text.slice(0, MAX_QUOTE_CHARS)} [shortened]` : text);

/** One rule as the model sees it: a batch-local id and its verbatim quote, nothing else. */
interface ShownRule {
  localId: string;
  criterionId: string;
  quote: string;
}

/** One request: a batch of own rules against a chunk of ONE shared layer's rules. */
interface Job {
  sharedIndex: number;
  own: ShownRule[];
  shared: ShownRule[];
}

/** Cut a rule list into chunks closed by count and by characters (deterministic). */
function chunk(rules: readonly AssessmentCriterion[], size: number, chars: number, prefix: "n" | "s"): ShownRule[][] {
  const out: ShownRule[][] = [];
  let cur: ShownRule[] = [];
  let used = 0;
  for (const c of rules) {
    const quote = clip(c.source?.quote ?? "");
    const cost = quote.length + 40;
    if (cur.length > 0 && (cur.length >= size || used + cost > chars)) {
      out.push(cur);
      cur = [];
      used = 0;
    }
    cur.push({ localId: `${prefix}${cur.length + 1}`, criterionId: c.criterionId, quote });
    used += cost;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

/** Every request a run needs, in a fixed order (shared layer, own batch, shared chunk). */
export function planLayerJobs(input: LayerCheckInput, limits: Pick<LayerCheckLimits, "ownBatchSize" | "sharedChunkSize" | "blockChars">): Job[] {
  const ownBatches = chunk(input.ownCriteria, limits.ownBatchSize, limits.blockChars, "n");
  const jobs: Job[] = [];
  input.shared.forEach((layer, sharedIndex) => {
    const sharedChunks = chunk(layer.criteria, limits.sharedChunkSize, limits.blockChars, "s");
    for (const own of ownBatches) for (const shared of sharedChunks) jobs.push({ sharedIndex, own, shared });
  });
  return jobs;
}

// ============================================
// Prompt and schema
// ============================================

/** The system prompt: what each relation means. Shares no text with the extractor's or the checker's prompts. */
export const LAYER_CHECK_SYSTEM_PROMPT =
  "You compare two sets of official rules for the same visa. The SHARED rules come from a rulebook that several countries apply together; the NATIONAL rules come from one of those countries' own pages. " +
  "Each rule is shown only as its verbatim official sentence. You never rewrite, merge or improve a rule, and you do not judge whether a rule is fair. " +
  "For each national rule, list every shared rule shown that is about the SAME SUBJECT (the same thing the applicant must have, show, be or not be), with one relation:\n" +
  "- same_requirement: both sentences require exactly the same thing of the same applicants, with the same amounts, periods, documents and conditions; meeting one always meets the other and failing one always fails the other.\n" +
  "- adds_to: same subject, and they are compatible, but the national sentence asks for more or for more detail (an amount, a document, a period) than the shared one.\n" +
  "- disagrees: same subject, but they cannot both be read the same way: different amounts, periods, limits, conditions or outcomes, or one allows what the other forbids.\n" +
  "- unsure: same subject, but the sentences do not give you enough to decide between the three above.\n" +
  "Leave out shared rules that are about a different subject. Use unsure whenever you hesitate: a wrong same_requirement hides a national rule, so it needs certainty. " +
  "The sentences may be written in any language; judge their meaning across languages. " +
  `${DATA_ONLY_RULE}`;

/** The closed answer: one entry per national id, each with the related shared ids and a relation. */
export const LAYER_CHECK_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["answers"],
  properties: {
    answers: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "matches"],
        properties: {
          id: { type: "string" },
          matches: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["shared_id", "relation"],
              properties: { shared_id: { type: "string" }, relation: { type: "string", enum: [...LAYER_RELATIONS] } },
            },
          },
        },
      },
    },
  },
};

/** The provider request for one job. Both rule lists are untrusted data. */
export function buildLayerRequest(job: Job, limits: Pick<LayerCheckLimits, "maxOutputTokensPerCall" | "timeoutMs">): LlmRequest {
  const national = job.own.map((r) => ({ id: r.localId, quote: r.quote }));
  const shared = job.shared.map((r) => ({ id: r.localId, quote: r.quote }));
  return {
    // The checker's independent reader (never the extractor's model).
    role: "verification",
    system: LAYER_CHECK_SYSTEM_PROMPT,
    user: [
      "Answer once for every national rule below (use its id exactly; an empty `matches` list when no shared rule shown is on its subject).",
      "National rules:",
      wrapUntrusted(JSON.stringify(national), "national_rules"),
      "Shared rules:",
      wrapUntrusted(JSON.stringify(shared), "shared_rules"),
    ].join("\n\n"),
    schema: LAYER_CHECK_SCHEMA,
    maxOutputTokens: limits.maxOutputTokensPerCall,
    timeoutMs: limits.timeoutMs,
    effort: "low",
    // The same system prompt is sent for every job of a run: paid for once.
    cacheSystem: true,
  };
}

// ============================================
// Parsing (closed answers, validated in code)
// ============================================

/** One validated pair answer, in real ids. */
export interface PairAnswer {
  criterionId: string;
  sharedIndex: number;
  sharedCriterionId: string;
  relation: LayerRelation;
}

/**
 * Parse and validate one answer.
 * @throws LayerCheckError("output_invalid") for anything but exactly one entry per
 *   sent national id, each match naming a shared id that was sent (at most once),
 *   with one of the four relations, and no extra key anywhere.
 */
export function parseLayerAnswer(text: string, job: Job): PairAnswer[] {
  const bad = (why: string): never => {
    throw new LayerCheckError("output_invalid", `the layer check answer was not usable: ${why}`);
  };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return bad("not JSON");
  }
  const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  if (!isObj(raw) || Object.keys(raw).join(",") !== "answers" || !Array.isArray(raw.answers)) return bad("expected only an answers list");
  const own = new Map(job.own.map((r) => [r.localId, r.criterionId]));
  const shared = new Map(job.shared.map((r) => [r.localId, r.criterionId]));
  const list = raw.answers as unknown[];
  if (list.length !== own.size) return bad("wrong number of answers");
  const seen = new Set<string>();
  const out: PairAnswer[] = [];
  for (const a of list) {
    if (!isObj(a) || Object.keys(a).sort().join(",") !== "id,matches" || typeof a.id !== "string" || !Array.isArray(a.matches)) return bad("an answer has the wrong shape");
    const real = own.get(a.id);
    if (real === undefined) return bad("a national id that was not sent");
    if (seen.has(a.id)) return bad("a national id answered twice");
    seen.add(a.id);
    const matched = new Set<string>();
    for (const m of a.matches as unknown[]) {
      if (!isObj(m) || Object.keys(m).sort().join(",") !== "relation,shared_id" || typeof m.shared_id !== "string") return bad("a match has the wrong shape");
      const sharedReal = shared.get(m.shared_id);
      if (sharedReal === undefined) return bad("a shared id that was not sent");
      if (matched.has(m.shared_id)) return bad("a shared id named twice for one rule");
      matched.add(m.shared_id);
      if (!(LAYER_RELATIONS as readonly unknown[]).includes(m.relation)) return bad("a relation outside the four values");
      out.push({ criterionId: real, sharedIndex: job.sharedIndex, sharedCriterionId: sharedReal, relation: m.relation as LayerRelation });
    }
  }
  return out;
}

// ============================================
// From answers to links and conflicts (pure, code decides)
// ============================================

/** Severity order, most severe first (a fold must never make a rule less severe). */
const SEVERITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/**
 * Why a `same_requirement` answer may NOT become a link, or null when it may.
 * The model judged the two sentences; these guards make sure folding the own
 * rule into the shared one cannot loosen anything code decides.
 */
export function linkRefusal(own: AssessmentCriterion, shared: AssessmentCriterion): string | null {
  if (own.kind !== shared.kind) return "different_kind";
  if (own.applicability !== shared.applicability) return "different_applicability";
  if ((own.trigger === undefined) !== (shared.trigger === undefined)) return "different_trigger";
  if (JSON.stringify(own.check ?? null) !== JSON.stringify(shared.check ?? null)) return "different_check";
  if (own.kind === "mandatory_bar" && JSON.stringify(own.appliesTo ?? null) !== JSON.stringify(shared.appliesTo ?? null)) return "different_bar_groups";
  if ((SEVERITY_RANK[own.severity] ?? 9) < (SEVERITY_RANK[shared.severity] ?? 9)) return "national_rule_more_severe";
  return null;
}

/** What the answers come to. */
export interface LayerDecision {
  restates: RestatesLink[];
  refusedLinks: LayerCheckRecord["refusedLinks"];
  unsure: LayerCheckRecord["unsure"];
  conflicts: LayerConflict[];
}

/**
 * Turn validated pair answers into links, refusals, doubts and conflicts.
 * PURE and deterministic (own rules in rulebook order, shared in layer order).
 *  - `disagrees` -> a conflict (both quotes and URLs);
 *  - `unsure`    -> recorded, nothing linked;
 *  - `adds_to`   -> nothing (both rules stay and both apply);
 *  - `same_requirement` -> a link, only when it is the rule's ONLY twin, the
 *    rule has no `disagrees` / `unsure` answer anywhere, and `linkRefusal` passes.
 */
export function decideLayerLinks(input: LayerCheckInput, answers: readonly PairAnswer[]): LayerDecision {
  const sharedById = input.shared.map((l) => new Map(l.criteria.map((c) => [c.criterionId, c])));
  const decision: LayerDecision = { restates: [], refusedLinks: [], unsure: [], conflicts: [] };
  for (const own of input.ownCriteria) {
    const mine = answers
      .filter((a) => a.criterionId === own.criterionId)
      .sort((a, b) => a.sharedIndex - b.sharedIndex || (input.shared[a.sharedIndex].criteria.findIndex((c) => c.criterionId === a.sharedCriterionId) - input.shared[b.sharedIndex].criteria.findIndex((c) => c.criterionId === b.sharedCriterionId)));
    const twins = mine.filter((a) => a.relation === "same_requirement");
    const doubted = mine.some((a) => a.relation === "disagrees" || a.relation === "unsure");
    for (const a of mine) {
      const layer = input.shared[a.sharedIndex];
      const shared = sharedById[a.sharedIndex].get(a.sharedCriterionId) as AssessmentCriterion;
      const ref = { criterionId: own.criterionId, sharedRulebookKey: layer.rulebookKey, sharedCriterionId: shared.criterionId };
      if (a.relation === "unsure") decision.unsure.push(ref);
      if (a.relation === "disagrees") {
        decision.conflicts.push({
          criterionId: own.criterionId,
          title: own.title,
          quote: own.source?.quote ?? "",
          url: own.source?.url ?? "",
          sharedRulebookKey: layer.rulebookKey,
          sharedVersion: layer.version,
          sharedCriterionId: shared.criterionId,
          sharedTitle: shared.title,
          sharedQuote: shared.source?.quote ?? "",
          sharedUrl: shared.source?.url ?? "",
        });
      }
      if (a.relation !== "same_requirement") continue;
      // The guards, in order of what is most telling for the admin.
      const reason = twins.length > 1 ? "more_than_one_twin" : doubted ? "rule_also_disputed_or_doubted" : linkRefusal(own, shared);
      if (reason) {
        decision.refusedLinks.push({ ...ref, reason });
        continue;
      }
      decision.restates.push({ criterionId: own.criterionId, sharedRulebookKey: layer.rulebookKey, sharedVersion: layer.version, sharedCriterionId: shared.criterionId, sharedQuote: shared.source?.quote ?? "" });
    }
  }
  return decision;
}

// ============================================
// Running the check
// ============================================

/** What a run returns: the record and the conflicts, ready to write with the approval. */
export interface LayerCheckOutcome {
  record: LayerCheckRecord;
  conflicts: LayerConflict[];
}

/** Rough tokens of a text (characters / 3 is deliberately pessimistic for JSON). */
const estimateTokens = (chars: number): number => Math.ceil(chars / 3);

/** A record with nothing linked, for a run that could not check (or had nothing to compare). */
export function notCheckedRecord(input: Pick<LayerCheckInput, "ownCriteria" | "shared">, reason: string, spent: { calls: number; inputTokens: number; outputTokens: number; model: string | null } = { calls: 0, inputTokens: 0, outputTokens: 0, model: null }): LayerCheckRecord {
  return {
    status: "not_checked",
    reason,
    promptVersion: LAYER_CHECK_PROMPT_VERSION,
    model: spent.model,
    sharedLayers: input.shared.map((l) => ({ rulebookKey: l.rulebookKey, version: l.version })),
    ownRulesChecked: 0,
    sharedRulesChecked: 0,
    calls: spent.calls,
    inputTokens: spent.inputTokens,
    outputTokens: spent.outputTokens,
    restates: [],
    refusedLinks: [],
    unsure: [],
    conflictCount: 0,
  };
}

/**
 * Run the layer check over every own rule and every shared rule. NEVER throws:
 * anything that stops it gives a `not_checked` record with the reason and the
 * spend so far, and no link and no conflict.
 */
export async function runLayerCheck(input: LayerCheckInput, provider: LlmProvider, limits: LayerCheckLimits = DEFAULT_LAYER_CHECK_LIMITS): Promise<LayerCheckOutcome> {
  const sharedTotal = input.shared.reduce((n, l) => n + l.criteria.length, 0);
  // Nothing to compare: checked, with nothing found and nothing spent.
  if (input.ownCriteria.length === 0 || sharedTotal === 0) {
    return { record: { ...notCheckedRecord(input, ""), status: "checked", reason: null, ownRulesChecked: input.ownCriteria.length, sharedRulesChecked: sharedTotal }, conflicts: [] };
  }
  const jobs = planLayerJobs(input, limits);
  const requests = jobs.map((j) => buildLayerRequest(j, limits));
  // ---- caps, BEFORE the first call ----
  if (jobs.length > limits.maxCalls) return { record: notCheckedRecord(input, `capped: ${jobs.length} calls needed, the cap is ${limits.maxCalls}`), conflicts: [] };
  const estimate = requests.reduce((n, r, i) => n + estimateTokens(r.system.length + r.user.length) + jobs[i].own.length * 40, 0);
  if (estimate > limits.maxTotalTokens) return { record: notCheckedRecord(input, `capped: about ${estimate} tokens needed, the cap is ${limits.maxTotalTokens}`), conflicts: [] };

  const model = provider.modelFor("verification");
  const answers: PairAnswer[] = [];
  const usage = { inputTokens: 0, outputTokens: 0 };
  let calls = 0;
  let next = 0;
  let stop: LayerCheckError | null = null;
  // A small worker pool; answers are keyed by rule, so completion order cannot change the result.
  const worker = async (): Promise<void> => {
    while (stop === null) {
      const i = next++;
      if (i >= jobs.length) return;
      if (usage.inputTokens + usage.outputTokens > limits.maxTotalTokens) {
        stop = new LayerCheckError("capped", "the token cap was passed");
        return;
      }
      calls++;
      try {
        const res = await provider.complete(requests[i]);
        usage.inputTokens += res.usage.inputTokens;
        usage.outputTokens += res.usage.outputTokens;
        if (res.stopReason === "refusal") throw new LayerCheckError("provider_refused", "the model declined the request");
        if (res.stopReason !== "end_turn") throw new LayerCheckError("provider_stopped", `the model stopped with reason ${String(res.stopReason)}`);
        answers.push(...parseLayerAnswer(res.text, jobs[i]));
      } catch (err) {
        // The class and code only: never a prompt, an answer or a provider object.
        stop = err instanceof LayerCheckError ? err : new LayerCheckError("provider_error", "the provider call failed");
        return;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limits.concurrency, jobs.length) }, () => worker()));
  if (stop === null && usage.inputTokens + usage.outputTokens > limits.maxTotalTokens) stop = new LayerCheckError("capped", "the token cap was passed");
  const spent = { calls, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, model };
  if (stop !== null) {
    // Not checked: the spend so far is recorded, nothing is linked or flagged.
    return { record: notCheckedRecord(input, (stop as LayerCheckError).code, spent), conflicts: [] };
  }
  const decision = decideLayerLinks(input, answers);
  return {
    record: {
      status: "checked",
      reason: null,
      promptVersion: LAYER_CHECK_PROMPT_VERSION,
      model,
      sharedLayers: input.shared.map((l) => ({ rulebookKey: l.rulebookKey, version: l.version })),
      ownRulesChecked: input.ownCriteria.length,
      sharedRulesChecked: sharedTotal,
      calls,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      restates: decision.restates,
      refusedLinks: decision.refusedLinks,
      unsure: decision.unsure,
      conflictCount: decision.conflicts.length,
    },
    conflicts: decision.conflicts,
  };
}

/**
 * The checker the publish pipeline plugs in (services/rubric-auto-publish.service.ts).
 * The provider is built on first use, so importing this costs nothing.
 */
export class RubricLayerChecker {
  private lazyProvider: LlmProvider | null = null;

  constructor(private readonly deps: { provider?: LlmProvider; limits?: LayerCheckLimits } = {}) {}

  /** The provider (the real one unless a test injects a fake). */
  private get provider(): LlmProvider {
    return this.deps.provider ?? (this.lazyProvider ??= new AnthropicLlmProvider());
  }

  /**
   * Run the check (never throws; see `runLayerCheck`). `settingsCaps` are the
   * publish settings' spend caps of the independent check
   * (`checkerMaxRequestsPerRun`, `checkerRequestTimeoutMs`): the layer check
   * never makes more calls, or waits longer per call, than they allow, so it
   * stays inside the existing spend settings as well as its own hard caps.
   */
  async check(input: LayerCheckInput, settingsCaps: { maxRequests?: number; timeoutMs?: number } = {}): Promise<LayerCheckOutcome> {
    const base = this.deps.limits ?? DEFAULT_LAYER_CHECK_LIMITS;
    const limits: LayerCheckLimits = {
      ...base,
      maxCalls: Math.min(base.maxCalls, settingsCaps.maxRequests ?? base.maxCalls),
      timeoutMs: Math.min(base.timeoutMs, settingsCaps.timeoutMs ?? base.timeoutMs),
    };
    try {
      return await runLayerCheck(input, this.provider, limits);
    } catch {
      // Belt and braces: `runLayerCheck` does not throw; if anything below it does, nothing is linked.
      console.error(`Rubric layer check: ${input.ownRulebookKey} could not run (unexpected error)`);
      return { record: notCheckedRecord(input, "provider_error"), conflicts: [] };
    }
  }
}
