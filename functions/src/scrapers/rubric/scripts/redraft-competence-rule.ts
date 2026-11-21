/**
 * Re-draft ONE saved rule of a published SHARED rulebook, draft the competence steps that rest on
 * it ("which member country examines the application"), and check the rule, WITHOUT re-drafting
 * the rulebook (issue #335). Nothing is written to Firestore, Storage or any project: the result is
 * a local JSON file for the person who decides what happens next.
 *
 * WHY: version 1 of a shared rulebook can lack its competence block because the drafting prompt
 * that made it predates competence steps, and because a lead-in rule's list was cut by code to its
 * first marker ("(a)"). Re-drafting the whole rulebook would cost a whole extraction. This script
 * spends on the ONE rule only, through the production code paths:
 *
 *   0. offline (always): the rule's quote is located in the saved snapshot; its list lines are read
 *      FROM THE SNAPSHOT by code (`readLeadInList`) and proved verbatim (`verifyListItems`); the
 *      aspects the check did not confirm are read from its stored letters (`--verdicts`) through
 *      the production mapping; every request a live run would send is BUILT (never sent) and
 *      listed with its role and size.
 *   1. re-draft (`RubricExtractionService.redraftRule`, the repair prompt): ONE request, only when
 *      the stored letters fail an aspect. The replacement is validated like any drafted rule.
 *   2. competence steps (`RubricExtractionService.draftCompetenceSteps`, production call 2 on the
 *      rule's own passage): ONE request. Code builds the block and keeps it only when EVERY step
 *      passes `competenceProblems` (each step rests on this rule; its words are verbatim in the
 *      quote or one list line; its question lists the route's members from membership data; its
 *      result comes from the applicant's answer, never worked out). The call returns EVERY
 *      question the model drafted for the passage, not only the block's; code keeps the ones the
 *      block reads (and the ones their conditions read), and re-uses a question the version
 *      already asks instead of adding a copy (`questionsTheBlockNeeds`, `placeQuestions`).
 *   3. the independent check of the rule (`RubricCheckerService.check`, production table): ONE
 *      request for an ordinary rule (two for a protected rule, which both models read).
 *   Every call gets the production's one retry for a transient provider failure, so the most a
 *   live run can send is twice the planned figure. (Review round 4) The SDK's own retry is turned
 *   off for this script (`maxRetries: 0`, see `CountingProvider`), so that ceiling counts every
 *   HTTP send, and the request count on file is the number of sends. A refused or unrepairable re-draft, or a block
 *   code refuses, STOPS the run: nothing after it is sent.
 *
 * OFFLINE BY DEFAULT: without `--live` no model is called (0 requests) and the planned requests
 * are printed. `--live` is the ONLY model use. The key is read from `.env.local`
 * (`ANTHROPIC_API_KEY`) by node, never printed.
 *
 * WHAT IT NEVER DOES: write to any project, publish, change a setting, the allowlist or a gate,
 * skip or weaken the check, type a legal word (every stored word comes from the snapshot or from
 * the model through the production validation), or infer anything for an applicant.
 *
 * Files (read-only inputs; both may be Firestore REST JSON or plain JSON):
 *   --page     the stored guidance snapshot the rule cites ({ text, sourceId, contentHash, url, ... });
 *              its sha256 must equal its contentHash, and the rule's `source.contentHash`
 *   --version  the published version document (`visaRubrics/{key}/rubricVersions/{n}`)
 *   --rule     the rule's criterionId
 *   --verdicts the check's six stored letters for the rule (`rubricCheckerRuns/{key}__v{n}`,
 *              `ruleVerdicts.<id>.verification`); absent = every aspect is sent as not confirmed
 *   --route    the route name shown to the model (default "the route")
 *   --out      REQUIRED with --live: where the outcome JSON is written. It must NOT exist yet and
 *              must be writable: both are tested BEFORE the first request, so a paid answer is
 *              never lost to a bad path and an earlier result is never overwritten. The file is
 *              written whatever the outcome (kept, refused by code, check not passed), with the
 *              number of requests made. (#455) When a step stops the run, the file says WHERE and WHY:
 *              `stop: { step, code, problems }` (see `RunStopRecord`), and `competenceOutcome` keeps the
 *              competence step's code word (the top-level `competence` field is the kept block, or null).
 *   (#455) `<out>.answers.json`, written next to `--out` on every live run: every answer the model
 *              sent (and every provider error, and the stop's detail), in order. Mode 0600, tested
 *              writable (and new) before the first request like `--out`, NEVER printed. It holds model
 *              text, so it stays on the machine of the person who ran the script.
 *   --replay   (#455) `--replay <answers.json>`: re-run the code steps on the answers a live run saved,
 *              with 0 requests (no key needed, no provider built). The same validation decides, so the
 *              stop of a saved answer can be diagnosed without spend. Refused together with `--live`.
 *
 * Run (from functions/):
 *   npm run redraft:competence-rule -- --page <snapshot.json> --version <v1.json> --rule <id> --verdicts <letters> [--route <name>] [--live --out <result.json>]
 *   npm run redraft:competence-rule -- --page <snapshot.json> --version <v1.json> --rule <id> --verdicts <letters> [--route <name>] --replay <result.json.answers.json> [--out <replay.json>]
 *
 * OUTPUT: ids, roles, counts, sizes, code words and verdict letters ONLY. Never a quote, a title,
 * model text, a key or an error message (an unexpected failure prints its class).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { createHash } from "node:crypto";
import { closeSync, fchmodSync, openSync, readFileSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import type { AssessmentCriterion, CompetenceBlock, IntakeQuestion, VisaRubric } from "../../../types/rubric";
import type { GuidanceSnapshotContent } from "../../guidance/types";
import type { LlmProvider, LlmRequest, LlmResponse } from "../../../services/ai/llm-provider";
import type { AiModelRole } from "../../../services/ai/ai-models";
import { SnapshotQuoteIndex } from "../rubric-quote";
import { readLeadInList, verifyListItems } from "../rubric-list-items";
import { competenceProblems } from "../rubric-competence";
import { splitRulebookKey } from "../../../authorities/authority-ids";
import { REPAIR_WINDOW_CHARS, REPAIR_WINDOW_LINES_AFTER, REPAIR_WINDOW_LINES_BEFORE, isBar } from "../rubric-repair";
import { aspectsToRepair } from "./repair-saved-rule";

// ============================================
// Inputs
// ============================================

/**
 * Turn a Firestore REST document (`{ name, fields: { x: { stringValue } } }`) into plain JSON.
 * A plain JSON object (no `fields` wrapper) is returned as it is. Timestamps stay ISO strings.
 */
export function fromFirestoreRest(doc: any): any {
  /** One typed value -> plain value. */
  const value = (v: any): any => {
    if (v === null || typeof v !== "object") return v;
    if ("mapValue" in v) return Object.fromEntries(Object.entries(v.mapValue.fields ?? {}).map(([k, x]) => [k, value(x)]));
    if ("arrayValue" in v) return (v.arrayValue.values ?? []).map(value);
    if ("integerValue" in v) return Number(v.integerValue);
    if ("doubleValue" in v) return Number(v.doubleValue);
    if ("booleanValue" in v) return v.booleanValue;
    if ("nullValue" in v) return null;
    if ("stringValue" in v) return v.stringValue;
    if ("timestampValue" in v) return v.timestampValue;
    throw new Error(`unsupported Firestore value type: ${Object.keys(v).join(",")}`);
  };
  if (doc && typeof doc === "object" && doc.fields && typeof doc.fields === "object" && !Array.isArray(doc.fields)) {
    return Object.fromEntries(Object.entries(doc.fields).map(([k, x]) => [k, value(x)]));
  }
  return doc;
}

/** Everything the run needs from outside: output, and (live only) the provider. */
export interface CompetenceRuleRunOptions {
  live: boolean;
  routeName?: string;
  // The check's stored letters for the rule (six, aspect order); absent = every aspect is not confirmed.
  verdicts?: string;
  // Called with each output line (ids, roles, counts, sizes, code words, letters only).
  print: (line: string) => void;
  // Live only: the model provider (the real one from the CLI, a scripted one in tests).
  provider?: LlmProvider;
  // (#455) Live only: called with every answer (and provider error, and the stop's detail) as it
  // arrives, in order. The CLI writes them to `<out>.answers.json` (mode 0600). NEVER printed.
  onAnswer?: (entry: SavedAnswer) => void;
  // (#455) True when `provider` is a `ReplayProvider` over saved answers: nothing is sent, so the
  // run reports 0 requests and the number of answers it replayed instead.
  replay?: boolean;
}

/** (#455) The three model steps of the live half, in the order they run. */
export type LiveStep = "redraft" | "competence_steps" | "check";

/**
 * (#455) Why the live half stopped, as the drafting or validation code decided it. Code words and
 * counts only (never model text), so it is safe on the `--out` file and on the printed line.
 *  - `step`: the step that stopped (or the step running when an unexpected error was thrown);
 *  - `code`: the code word the code chose. For a `RunStop` it is the stop's `reasonCode`
 *    (`provider_refused`, `output_truncated`, `provider_stopped`, `invalid_model_output`,
 *    `provider_error`, `ai_not_configured`); for a refused re-draft the refusal detail
 *    (`cannot_be_repaired`, `not_the_same_bar:...`, `kind_changed`, ...); for a refused block
 *    `competence_dropped`, `no_steps_proposed` or `competence_problems`; for the check `check_held`
 *    or `check_not_passed`; for a throw no step caught `error:<class>`; in a replay that ran out of
 *    or did not match its answers `replay_exhausted` / `replay_mismatch` / `replay_answers_left`;
 *  - `problems`: for a code refusal, EVERY problem code (the block's flag codes, the
 *    `competenceProblems` codes, the check's reason codes or failed aspects). Empty otherwise.
 */
export interface RunStopRecord {
  step: LiveStep;
  code: string;
  problems: string[];
}

/**
 * (#455) One entry of the answers file, in the order things happened:
 *  - `answer`: a response the provider returned (its text is the model's answer, kept verbatim);
 *  - `error`: a provider call that threw (no answer): the error's class and its redacted description
 *    (`describeAnthropicError`), so a replay can throw the same error and the same retry rule applies;
 *  - `stop_detail`: the human-readable detail of the stop (a `RunStop` message: the parse problems of
 *    an unreadable answer, the provider's status), which the `--out` file does not carry.
 * Only `answer` and `error` entries are replayed.
 */
export type SavedAnswer =
  | { kind: "answer"; n: number; step: LiveStep; role: AiModelRole; response: LlmResponse }
  | { kind: "error"; n: number; step: LiveStep; role: AiModelRole; errorClass: string; message: string }
  | { kind: "stop_detail"; step: LiveStep; code: string; detail: string };

/** One request a live run would send, as planned offline. */
export interface PlannedRequest {
  step: "redraft" | "competence_steps" | "check";
  role: AiModelRole;
  // Characters of prompt (system + user) when the request can be built offline; null when it
  // depends on an earlier answer (the check reads the re-drafted rule).
  chars: number | null;
  // (#455) The output limit the request goes out with (generated tokens, thinking included): the
  // production DRAFTING limit for the re-draft and the competence steps, the checker's own for the check.
  maxOutputTokens: number;
}

/** What a run did, for tests and the summary line. */
export interface CompetenceRuleRunSummary {
  // Why the run stopped before any spend (a code word), or null.
  refusedOffline: string | null;
  listLinesStored: number;
  listLinesRead: number;
  storedListVerifies: boolean;
  aspects: string[];
  planned: PlannedRequest[];
  // Live only.
  requests: number;
  redraft: string | null;
  competence: string | null;
  competenceProblems: string[];
  checkLetters: string | null;
  checkPasses: boolean | null;
  // (#335, review round 4) Live only: the class of a throw ANYWHERE in the live half that no step
  // caught (code between or after the model calls), so the requests spent are still on file. Null when none.
  liveFailed: string | null;
  // Live only: how many questions the competence call returned that the block does not read (not added).
  questionsNotNeeded: number;
  // Live only: block questions that are the SAME as one the version already asks (re-used, not added): new id -> the version's id.
  reusedQuestionIds: Record<string, string>;
  // Live only: added questions whose wording equals a version question of ANOTHER answer type (added; for the reader to look at): new id -> the version's id.
  similarQuestionIds: Record<string, string>;
  // (#455) Live only: where and why the live half stopped (see `RunStopRecord`), or null when it ran to the end and passed.
  stop: RunStopRecord | null;
  // (#455) Live only: how many answers (and provider errors) were handed to `onAnswer` (live) or read back (replay).
  answersReceived: number;
  // (#455) True for a `--replay` run (0 requests were sent; `answersReceived` were replayed).
  replayed: boolean;
  // Live only: the result a person reviews (the replacement rule, the questions the block reads, the block).
  result: { rule: AssessmentCriterion; intakeQuestions: IntakeQuestion[]; competence: CompetenceBlock; renamedQuestionIds: Record<string, string> } | null;
}

/**
 * A provider that counts the requests that go through it, and (#455) hands every answer it
 * receives (and every provider error) to `onAnswer`, tagged with the step that sent it.
 */
class CountingProvider implements LlmProvider {
  requests = 0;
  // (#455) The step the live half is running; set by `runCompetenceRule` before each step, read here
  // to tag the saved answer (the checker sends through this provider too, so it cannot pass it in).
  step: LiveStep = "redraft";
  constructor(
    private readonly inner: LlmProvider,
    // (#455) Where each answer goes (the answers file); absent = nothing kept (tests, replay).
    private readonly onAnswer: ((entry: SavedAnswer) => void) | undefined,
    // (#455) The redacting describer of a provider error (`describeAnthropicError`), passed in so this
    // class never loads the AI client module at import time.
    private readonly describe: (err: unknown) => string
  ) {}
  modelFor(role: AiModelRole): string {
    return this.inner.modelFor(role);
  }
  /**
   * (#335, review round 4) Every request goes out with `maxRetries: 0`: the SDK sends it ONCE, so
   * one `complete` is one HTTP send and this count is the number of sends. The only retry left is
   * the production `callModel`'s one retry, which comes back through here and is counted. That is
   * what makes the printed ceiling ("at most twice the planned figure") exact: without this, the
   * SDK's own retry (`MAX_RETRIES` in services/ai/llm-provider.ts) could double every count unseen,
   * and a request that timed out after the server finished it can be billed.
   */
  async complete(request: LlmRequest): Promise<LlmResponse> {
    this.requests += 1;
    const n = this.requests;
    const step = this.step;
    let response: LlmResponse;
    try {
      response = await this.inner.complete({ ...request, maxRetries: 0 });
    } catch (err) {
      // (#455) No answer, but the error is kept (class and REDACTED description) so a replay throws
      // the same error and the production retry rule makes the same decision.
      this.onAnswer?.({ kind: "error", n, step, role: request.role, errorClass: (err as Error)?.constructor?.name ?? "unknown", message: this.describe(err) });
      throw err;
    }
    // (#455) Kept BEFORE any validation reads it: whatever the code then decides, the paid answer is on file.
    this.onAnswer?.({ kind: "answer", n, step, role: request.role, response });
    return response;
  }
}

/**
 * (#455) A provider that sends NOTHING: it hands back, in order, the answers a live run saved in its
 * answers file, so `--replay` re-runs the production code steps on them with 0 requests.
 *
 * Each saved entry must be for the step and role now asking (the run is deterministic given the same
 * answers, so a mismatch means the inputs differ from the live run's). On a mismatch, or when the saved
 * answers run out, it records why in `problem` and throws; the run reports that problem as its stop
 * (`replay_mismatch` / `replay_exhausted`) instead of the provider error the drafting code turns it into.
 */
export class ReplayProvider implements LlmProvider {
  // The answers handed back so far.
  used = 0;
  // Why the replay could not follow the saved run, or null.
  problem: "replay_mismatch" | "replay_exhausted" | null = null;
  // (#455) The step asking, read from the counting provider that wraps this one.
  stepOf: () => LiveStep = () => "redraft";
  constructor(private readonly entries: readonly SavedAnswer[]) {}
  /** The model id the saved answer named (the record's `model`), else a fixed replay id. */
  modelFor(role: AiModelRole): string {
    const e = this.entries.find((x) => x.kind === "answer" && x.role === role);
    return e && e.kind === "answer" ? e.response.model : `replay-${role}`;
  }
  /** How many replayable entries were never asked for (a replay that stops early differs from the live run). */
  left(): number {
    return this.entries.filter((e) => e.kind !== "stop_detail").length - this.used;
  }
  async complete(request: LlmRequest): Promise<LlmResponse> {
    const replayable = this.entries.filter((e) => e.kind !== "stop_detail") as Exclude<SavedAnswer, { kind: "stop_detail" }>[];
    const next = replayable[this.used];
    if (!next) {
      this.problem ??= "replay_exhausted";
      throw new Error("replay_exhausted");
    }
    if (next.step !== this.stepOf() || next.role !== request.role) {
      this.problem ??= "replay_mismatch";
      throw new Error("replay_mismatch");
    }
    this.used += 1;
    if (next.kind === "answer") return { ...next.response, usage: { ...next.response.usage } };
    // A saved provider error is thrown again with the same description, so `callModel` retries (or
    // not) exactly as it did live. A missing key is re-created as its own class (it maps to its own code).
    const { LlmProviderError } = await import("../../../services/ai/llm-provider");
    if (next.errorClass === "AnthropicNotConfiguredError") {
      const { AnthropicNotConfiguredError } = await import("../../../services/ai/anthropic-client");
      throw new AnthropicNotConfiguredError();
    }
    throw new LlmProviderError("provider_error", next.message);
  }
}

/**
 * (#455) Read an answers file (`<out>.answers.json`) back into its entries, for `--replay`.
 * Accepts the file as the CLI writes it (`{ ruleId, entries }`) or a bare entries array.
 */
export function readAnswersFile(json: unknown): SavedAnswer[] {
  const entries = Array.isArray(json) ? json : (json as { entries?: unknown })?.entries;
  if (!Array.isArray(entries)) throw new Error("answers_file_unreadable");
  return entries as SavedAnswer[];
}

// ============================================
// Composition (pure)
// ============================================

/** A question's wording, for comparing two questions: whitespace collapsed, case ignored. */
const wordingOf = (q: Pick<IntakeQuestion, "label">): string => String(q.label ?? "").replace(/\s+/gu, " ").trim().toLocaleLowerCase();

/**
 * The questions the block NEEDS, out of everything the competence call returned: the questions its
 * steps read, the questions their conditions (`when`) read, and the questions those questions' own
 * show conditions read, and so on. The call is the production "questions and evidence" call on the
 * rule's passage, so it may also return questions that have nothing to do with the block (a
 * document question, a dates question); those are NOT added to the version by this script.
 * Order is kept as the call returned it.
 */
export function questionsTheBlockNeeds(added: readonly IntakeQuestion[], block: CompetenceBlock): IntakeQuestion[] {
  const byId = new Map(added.map((q) => [q.id, q]));
  const needed = new Set<string>();
  /** Take a question id and everything its show conditions read. */
  const take = (id: string): void => {
    if (needed.has(id)) return;
    needed.add(id);
    for (const c of byId.get(id)?.showWhen?.anyOf ?? []) take(c.questionId);
  };
  for (const s of block.steps) {
    take(s.questionId);
    for (const c of s.when ?? []) take(c.questionId);
  }
  return added.filter((q) => needed.has(q.id));
}

/**
 * Put the new questions next to the version's own, without ever changing one of the version's
 * questions.
 *
 *  - A new question that IS a question the version already asks (same wording, same answer type,
 *    same source of options) is not added a second time: the version's question is re-used, and
 *    every reference to the new one (show conditions, the block's steps) points at it (`reused`).
 *  - A new question whose id is already taken by a DIFFERENT question of the version gets a fresh
 *    id (`<id>__c`, `<id>__c2`, ...), renamed everywhere the same way (`renamed`).
 *  - A new question whose wording equals a version question of another answer type is still added
 *    (a free-text question cannot feed a step), and reported (`similar`) for the reader.
 * Ids are internal handles: renaming one changes no wording, option or rule.
 */
export function placeQuestions(
  existing: readonly IntakeQuestion[],
  added: readonly IntakeQuestion[],
  block: CompetenceBlock
): { intakeQuestions: IntakeQuestion[]; competence: CompetenceBlock; renamed: Record<string, string>; reused: Record<string, string>; similar: Record<string, string> } {
  const taken = new Set(existing.map((q) => q.id));
  const renamed: Record<string, string> = {};
  const reused: Record<string, string> = {};
  const similar: Record<string, string> = {};
  const kept: IntakeQuestion[] = [];
  for (const q of added) {
    const sameWording = existing.filter((e) => wordingOf(e) === wordingOf(q) && wordingOf(q) !== "");
    // The very same question: re-use the version's, add nothing.
    const same = sameWording.find((e) => e.answerType === q.answerType && (e.optionsFrom ?? null) === (q.optionsFrom ?? null));
    if (same) {
      reused[q.id] = same.id;
      continue;
    }
    kept.push(q);
    if (!taken.has(q.id)) {
      taken.add(q.id);
      if (sameWording.length > 0) similar[q.id] = sameWording[0].id;
      continue;
    }
    let n = 1;
    let id = `${q.id}__c`;
    while (taken.has(id)) id = `${q.id}__c${++n}`;
    renamed[q.id] = id;
    taken.add(id);
    if (sameWording.length > 0) similar[id] = sameWording[0].id;
  }
  // A re-used question keeps the version's id; a clashing one gets its fresh id.
  const ren = (id: string): string => reused[id] ?? renamed[id] ?? id;
  const questions = kept.map((q) => ({
    ...q,
    id: ren(q.id),
    ...(q.showWhen ? { showWhen: { anyOf: q.showWhen.anyOf.map((c) => ({ ...c, questionId: ren(c.questionId) })) } } : {}),
  }));
  const competence: CompetenceBlock = {
    steps: block.steps.map((s) => ({ ...s, questionId: ren(s.questionId), ...(s.when ? { when: s.when.map((c) => ({ ...c, questionId: ren(c.questionId) })) } : {}) })),
  };
  return { intakeQuestions: [...existing, ...questions], competence, renamed, reused, similar };
}

// ============================================
// The run
// ============================================

/**
 * Run the offline half for the rule, and (with `live`) the re-draft, the competence call and the
 * check. Pure of process state: the CLI below only parses arguments and builds the real provider.
 */
export async function runCompetenceRule(snapshot: GuidanceSnapshotContent, version: VisaRubric, ruleId: string, opts: CompetenceRuleRunOptions): Promise<CompetenceRuleRunSummary> {
  const summary: CompetenceRuleRunSummary = {
    refusedOffline: null, listLinesStored: 0, listLinesRead: 0, storedListVerifies: false, aspects: [], planned: [],
    requests: 0, redraft: null, competence: null, competenceProblems: [], checkLetters: null, checkPasses: null, liveFailed: null,
    questionsNotNeeded: 0, reusedQuestionIds: {}, similarQuestionIds: {}, stop: null, answersReceived: 0, replayed: opts.replay === true, result: null,
  };
  const stop = (code: string): CompetenceRuleRunSummary => {
    summary.refusedOffline = code;
    opts.print(`${ruleId}: refused before any spend (${code}).`);
    return summary;
  };

  // ---- 0a. the inputs agree with each other (never a guess about which page a rule cites) ----
  if (createHash("sha256").update(snapshot.text).digest("hex") !== snapshot.contentHash) return stop("snapshot_hash_mismatch");
  const stored = (version.criteria ?? []).find((c) => c.criterionId === ruleId);
  if (!stored) return stop("rule_not_in_version");
  if (stored.source.contentHash !== snapshot.contentHash || stored.source.sourceId !== snapshot.sourceId) return stop("rule_cites_another_snapshot");
  // A competence block belongs on a SHARED (bloc or treaty) rulebook only. `authorityId` is on every
  // rulebook (a country's too), so it cannot tell; the rulebook KEY can: its authority part is a
  // group id for a shared rulebook and a country code for a country's own (the same reading the
  // structural validator uses, rubric-validate.ts). Refused here, before any spend.
  const keyParts = splitRulebookKey(version.routeKey);
  if (!keyParts.ok || keyParts.authorityIdKind !== "group") return stop("not_a_shared_rulebook");
  if (version.competence) return stop("version_already_has_a_competence_block");

  // ---- 0b. the quote, and its list lines read from the snapshot by code ----
  const index = new SnapshotQuoteIndex(snapshot);
  const found = index.locate(stored.source.quote);
  if (!found.ok) return stop(`quote_${found.reason}`);
  const read = readLeadInList(index, found);
  summary.listLinesStored = stored.source.listItems?.length ?? 0;
  summary.storedListVerifies = stored.source.listItems !== undefined && verifyListItems(index, found, stored.source.listItems).ok;
  if (read.kind === "unreadable") return stop(`list_not_readable:${read.reason}`);
  const listItems = read.kind === "items" && verifyListItems(index, found, read.items).ok ? read.items : undefined;
  if (read.kind === "items" && !listItems) return stop("list_items_not_in_snapshot");
  summary.listLinesRead = listItems?.length ?? 0;
  // The rule as code reads it from the snapshot today: the stored rule with its list lines re-attached (nothing else changes).
  const rule: AssessmentCriterion = { ...stored, source: { ...stored.source, quote: found.matched, ...(listItems ? { listItems } : {}) } };
  if (!listItems) delete (rule.source as any).listItems;

  // ---- 0c. what a re-draft would be told, and the requests a live run would send ----
  summary.aspects = await aspectsToRepair(rule, opts.verdicts);
  const { competenceStepsRequest } = await import("../rubric-extraction.service");
  const { DEFAULT_PUBLISH_SETTINGS } = await import("../rubric-publish-settings");
  const { DEFAULT_RUBRIC_SETTINGS } = await import("../rubric-settings");
  // (#455, owner decision 2026-11-21) The two DRAFTING calls (the re-draft and the competence steps)
  // go out with the output limit production drafting uses: `maxOutputTokensPerRequest` of the
  // extraction settings, read from the same defaults production starts from (`DEFAULT_RUBRIC_SETTINGS`;
  // this script never reads a project, so a stored override does not apply). The first #335 run sent
  // them with the CHECKER's limit (`checkerMaxOutputTokensPerRequest`), far below what a call 2 answer
  // can need (a dense call 2 was cut off at 16,000 in #112), and stopped at the competence call.
  // The wall-clock timeout is unchanged (the checker's, which equals the drafting default today).
  const limits = { maxOutputTokens: DEFAULT_RUBRIC_SETTINGS.maxOutputTokensPerRequest, timeoutMs: DEFAULT_PUBLISH_SETTINGS.checkerRequestTimeoutMs };
  // The check keeps the checker's own limit: `RubricCheckerService` reads it from its publish settings
  // (`loadSettings` below hands it `DEFAULT_PUBLISH_SETTINGS`), never from `limits`.
  const checkOutputTokens = DEFAULT_PUBLISH_SETTINGS.checkerMaxOutputTokensPerRequest;
  const routeName = opts.routeName ?? "the route";
  const window = index.passageWindow(found, REPAIR_WINDOW_LINES_BEFORE, REPAIR_WINDOW_LINES_AFTER, REPAIR_WINDOW_CHARS);
  // The re-draft request is built inside `redraftRule` from the same window; its size is the window plus the prompt.
  if (summary.aspects.length > 0) summary.planned.push({ step: "redraft", role: "judgement", chars: null, maxOutputTokens: limits.maxOutputTokens });
  // The competence request, built from the rule as it stands (a live run builds it from the replacement).
  const comp = competenceStepsRequest(rule, index, routeName, limits, []);
  if ("notFound" in comp) return stop(`quote_${comp.notFound}`);
  summary.planned.push({ step: "competence_steps", role: comp.request.role, chars: comp.request.system.length + comp.request.user.length, maxOutputTokens: comp.request.maxOutputTokens });
  // The check: one batch for an ordinary rule (verification model), one per model for a protected one.
  summary.planned.push({ step: "check", role: "verification", chars: null, maxOutputTokens: checkOutputTokens });
  const { isProtectedRule } = await import("../rubric-gates");
  if (isProtectedRule(rule)) summary.planned.push({ step: "check", role: "judgement", chars: null, maxOutputTokens: checkOutputTokens });

  opts.print(
    `${ruleId}: quote found; ${isBar(rule) ? "bar" : "ordinary"}${isProtectedRule(rule) ? " (protected)" : ""}, kind ${rule.kind}; ` +
    `stored list lines ${summary.listLinesStored} (verify against the snapshot: ${summary.storedListVerifies ? "yes" : "no"}); list lines read now ${summary.listLinesRead}; ` +
    `old letters ${opts.verdicts ?? "none"}; aspects a re-draft would be told: ${summary.aspects.length > 0 ? summary.aspects.join(",") : "none"}; window ${window.text.length} characters.`
  );
  summary.planned.forEach((p, i) => opts.print(`  planned request ${i + 1}: ${p.step}, role ${p.role}${p.chars !== null ? `, ${p.chars} characters` : ""}, output limit ${p.maxOutputTokens} tokens`));
  opts.print(`  planned: ${summary.planned.length} request(s); at most ${summary.planned.length * 2} if every one needs its one retry for a transient provider failure.`);

  if (!opts.live) {
    opts.print(`\n(offline: 0 model calls. Add --live to send the ${summary.planned.length} planned request(s).)`);
    return summary;
  }
  if (!opts.provider) throw new Error("live run without a provider");

  // ---- live half: the ONLY place a model is called ----
  // (#455) Every answer is counted and handed to `onAnswer` (the answers file) as it arrives.
  const { describeAnthropicError } = await import("../../../services/ai/anthropic-client");
  const keep = (entry: SavedAnswer): void => {
    if (entry.kind !== "stop_detail") summary.answersReceived += 1;
    opts.onAnswer?.(entry);
  };
  const provider = new CountingProvider(opts.provider, keep, describeAnthropicError);
  // (#455) A replay provider reads the running step from here, to check each saved answer is for it.
  if (opts.provider instanceof ReplayProvider) opts.provider.stepOf = () => provider.step;
  const { RubricExtractionService, RunStop } = await import("../rubric-extraction.service");
  const { RubricCheckerService, failedAspectsOf } = await import("../rubric-checker");
  const { decodeRow } = await import("../rubric-checker-prompt");
  const drafter = new RubricExtractionService({ provider });
  const usage = { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  /**
   * (#455) Record where and why the run stopped. The FIRST stop wins (a later guard never overwrites
   * the reason the step itself chose). A `RunStop`'s human-readable message goes to the answers file
   * only (`stop_detail`), never to the `--out` file or the terminal.
   */
  const stopAt = (step: LiveStep, code: string, problems: readonly string[] = [], detail?: string): void => {
    if (summary.stop) return;
    summary.stop = { step, code, problems: [...problems] };
    if (detail) opts.onAnswer?.({ kind: "stop_detail", step, code, detail });
  };
  /** (#455) The stop of a throw inside a step: a `RunStop` names its own reason code; anything else its class. */
  const stopOnThrow = (step: LiveStep, e: unknown, RunStopClass: new (...a: any[]) => { reasonCode: string; message: string }): void => {
    if (e instanceof RunStopClass) stopAt(step, e.reasonCode, [], e.message);
    else stopAt(step, `error:${(e as Error)?.constructor?.name ?? "unknown"}`);
  };
  const done = (): CompetenceRuleRunSummary => {
    // (#455) A replay sends nothing: 0 requests, and the answers it read back are `answersReceived`.
    summary.requests = opts.replay ? 0 : provider.requests;
    if (opts.provider instanceof ReplayProvider) {
      // A replay that could not follow the saved run says so, in place of the error code the drafting
      // code made of it; a replay that ends with saved answers unread did not follow it either.
      const rp = opts.provider;
      if (rp.problem) summary.stop = { step: summary.stop?.step ?? provider.step, code: rp.problem, problems: [] };
      else if (rp.left() > 0 && !summary.stop) summary.stop = { step: provider.step, code: "replay_answers_left", problems: [String(rp.left())] };
    }
    // (#455) The stop, as a printed line: step, code word and problem codes only (never model text).
    if (summary.stop) {
      opts.print(`${ruleId}: stopped at ${summary.stop.step}: ${summary.stop.code}${summary.stop.problems.length > 0 ? ` (${summary.stop.problems.join(",")})` : ""}.`);
    }
    opts.print(`\n${ruleId}: re-draft ${summary.redraft ?? "not sent"}; competence ${summary.competence ?? "not sent"}; check ${summary.checkLetters ?? "not sent"}${summary.checkPasses === null ? "" : summary.checkPasses ? " (passes)" : " (does NOT pass)"}; ${summary.liveFailed ? `; live half ${summary.liveFailed}` : ""}; ${summary.requests} request(s) made.`);
    return summary;
  };

  // (#335, review round 4) ONE guard around the WHOLE live half. Each model call has its own
  // try block, but the code between and after them (`placeQuestions`, `competenceProblems` on the
  // candidate, `decodeRow`, `failedAspectsOf`) runs after up to three paid requests. A throw there
  // must still end in `done()`, so the summary prints the requests made and the caller writes the
  // `--out` file, instead of escaping to `main`'s catch with nothing on file.
  try {
    // 1. the re-draft (only when an aspect failed): a refusal stops the run.
    let replacement = rule;
    if (summary.aspects.length > 0) {
      provider.step = "redraft";
      try {
        const outcome = await drafter.redraftRule({ rule, aspects: summary.aspects, index, routeName, limits, sent: { chars: 0 } }, usage as any, { failed: 0, cap: 3 });
        if (outcome.kind !== "replacement") {
          summary.redraft = outcome.kind === "invalid" ? `refused:${outcome.detail}` : outcome.kind;
          // (#455) The refusal detail is the code word (`not_the_same_bar:...`, `kind_changed`, ...).
          stopAt("redraft", outcome.kind === "invalid" ? outcome.detail : outcome.kind);
          return done();
        }
        replacement = outcome.criterion;
        summary.redraft = "replacement";
      } catch (e) {
        summary.redraft = `failed:${(e as Error).constructor.name}`;
        // (#455) The reason code the drafting code chose (`output_truncated`, `invalid_model_output`, ...).
        stopOnThrow("redraft", e, RunStop);
        return done();
      }
    }

    // 2. the competence steps on the replacement: a block code refuses stops the run.
    let block: CompetenceBlock;
    let added: IntakeQuestion[];
    provider.step = "competence_steps";
    try {
      const outcome = await drafter.draftCompetenceSteps({ rule: replacement, index, routeName, limits, known: [] }, usage as any, { failed: 0, cap: 3 });
      if (outcome.kind !== "steps") {
        summary.competence = outcome.kind === "invalid" ? `refused:${outcome.detail}` : "no_steps_proposed";
        // (#455) Every flag code the merge raised (why the block was dropped, or what it noted).
        stopAt("competence_steps", outcome.kind === "invalid" ? outcome.detail : "no_steps_proposed", [...new Set(outcome.flags.map((f) => f.code))]);
        return done();
      }
      block = outcome.competence;
      // `outcome.intakeQuestions` is EVERY question the call drafted for the passage. Only the ones
      // the block reads (and the ones their conditions read) are kept; the rest are counted, not added.
      added = questionsTheBlockNeeds(outcome.intakeQuestions, block);
      summary.questionsNotNeeded = outcome.intakeQuestions.length - added.length;
      summary.competence = `${block.steps.length} step(s), ${added.length} question(s) the block reads, ${summary.questionsNotNeeded} other question(s) not added`;
    } catch (e) {
      summary.competence = `failed:${(e as Error).constructor.name}`;
      // (#455) The first live run (#335) stopped here with `failed:RunStop` and no reason: now it is on file.
      stopOnThrow("competence_steps", e, RunStop);
      return done();
    }
    // A question the version already asks is re-used, never added a second time (see `placeQuestions`).
    const placed = placeQuestions(version.intakeQuestions ?? [], added, block);
    summary.reusedQuestionIds = placed.reused;
    summary.similarQuestionIds = placed.similar;
    if (Object.keys(placed.reused).length + Object.keys(placed.similar).length > 0) {
      opts.print(`  questions: ${Object.keys(placed.reused).length} re-used from the version (not added again); ${Object.keys(placed.similar).length} added with the same wording as a version question of another answer type (read them in the result file).`);
    }
    // The rule reads the block's questions (as drafting links them), so neither is removed as unjustified.
    const linked: AssessmentCriterion = { ...replacement, intakeQuestionIds: [...new Set([...(replacement.intakeQuestionIds ?? []), ...placed.competence.steps.map((s) => s.questionId)])] };
    const candidate = { criteria: (version.criteria ?? []).map((c) => (c.criterionId === ruleId ? linked : c)), intakeQuestions: placed.intakeQuestions, competence: placed.competence };
    // `sharedRulebook: true` is what step 0a established from the rulebook key (never assumed).
    summary.competenceProblems = competenceProblems(candidate, { sharedRulebook: true }).map((p) => p.code);
    if (summary.competenceProblems.length > 0) {
      summary.competence += `; refused on the version: ${[...new Set(summary.competenceProblems)].join(",")}`;
      stopAt("competence_steps", "competence_problems", [...new Set(summary.competenceProblems)]);
      return done();
    }

    // 3. the production check of the replacement (no repair of its own: cap 0).
    const records = new Map<string, any>();
    const checker = new RubricCheckerService({
      provider: () => provider,
      readSnapshot: async () => snapshot,
      loadSettings: async () => ({ settings: { ...DEFAULT_PUBLISH_SETTINGS, mode: "auto", repairMaxRulesPerRun: 0 }, exists: true, problems: [] }),
      ledger: { load: async (id) => records.get(id) ?? null, save: async (rec) => void records.set(rec.runId, rec), countRunsOnDay: async () => 0 },
    });
    const runId = `ONE-RULE_${ruleId}__v1`;
    provider.step = "check";
    // (#335, fix round 2) Wrapped like steps 1 and 2: a throw here comes AFTER up to
    // three requests were spent, so it must still end in `done()`, which prints the
    // summary and lets the caller write the `--out` file, instead of escaping to
    // `main`'s catch with nothing written. The check counts as not passing.
    // (`RubricCheckerService.check` already catches its own errors and returns
    // `ok: false`; this guard is defence in depth against a future change there.)
    let checked: Awaited<ReturnType<typeof checker.check>> | undefined;
    try {
      checked = await checker.check({ routeKey: "ONE-RULE", version: 1, runId, rubric: { routeKey: "ONE-RULE", version: 1, criteria: [linked], intentPolarityProposal: null } as any, codeLeftOutIds: [] });
    } catch (e) {
      summary.checkLetters = `failed:${(e as Error).constructor.name}`;
      summary.checkPasses = false;
      stopOnThrow("check", e, RunStop);
      return done();
    }
    const v = records.get(runId)?.ruleVerdicts?.[ruleId] as { verification?: string; judgement?: string } | undefined;
    summary.checkLetters = v ? `${v.verification ?? "none"}${isProtectedRule(linked) ? `/${v.judgement ?? "none"}` : ""}` : "none";
    const rows = isProtectedRule(linked) ? [decodeRow(v?.verification), decodeRow(v?.judgement)] : [decodeRow(v?.verification)];
    summary.checkPasses = v !== undefined && failedAspectsOf(linked, ...rows.map((r) => r ?? undefined)).length === 0;
    summary.result = { rule: linked, intakeQuestions: placed.intakeQuestions.slice((version.intakeQuestions ?? []).length), competence: placed.competence, renamedQuestionIds: placed.renamed };
    // (#455) A check that did not pass is recorded as the run's stop: held (every reason code the
    // check gave) or answered but not confirming (every aspect that failed). Nothing else changes:
    // the result is still set for the reader, and `checkPasses` still says it does not pass.
    if (checked && !checked.ok) stopAt("check", "check_held", checked.reasonCodes);
    else if (!summary.checkPasses) stopAt("check", "check_not_passed", v ? failedAspectsOf(linked, ...rows.map((r) => r ?? undefined)) : ["no_verdict"]);
    return done();
  } catch (e) {
    summary.liveFailed = `failed:${(e as Error).constructor.name}`;
    // (#455) Named after the step that was running when it threw.
    stopAt(provider.step, `error:${(e as Error)?.constructor?.name ?? "unknown"}`);
    // A run that broke cannot be kept: a check that already ran counts as not passing, and no result is set.
    if (summary.checkPasses !== null) summary.checkPasses = false;
    summary.result = null;
    return done();
  }
}

// ============================================
// CLI
// ============================================

/** Value of `--name value` or `--name=value`, or undefined. */
const arg = (name: string): string | undefined => {
  const a = process.argv.slice(2);
  const eq = a.find((x) => x.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = a.indexOf(`--${name}`);
  return i >= 0 && i + 1 < a.length && !a[i + 1].startsWith("--") ? a[i + 1] : undefined;
};

/** Print one report line (ids, roles, counts, sizes, code words and letters only; see the header). */
const printLine = (line: string): void => console.log(line);

/**
 * Why the `--out` file cannot be used, or null when it can. Tested BEFORE any request is sent:
 *  - `out_required`: a live run without `--out` would spend and keep nothing;
 *  - `out_exists`: the file is already there (an earlier result is never overwritten);
 *  - `out_not_writable`: the file cannot be created (no such folder, no permission).
 * The test creates the file (exclusively) and removes it again, so a usable path is left as it was.
 */
export function outFileProblem(out: string | undefined): "out_required" | "out_exists" | "out_not_writable" | null {
  if (!out) return "out_required";
  try {
    // "wx": create for writing, fail if it exists. Proves both "not there yet" and "can be written".
    closeSync(openSync(out, "wx"));
    unlinkSync(out);
    return null;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EEXIST" ? "out_exists" : "out_not_writable";
  }
}

/** (#455) The answers file of a `--out` file: a sibling, `<out>.answers.json`. */
export const answersPathFor = (out: string): string => `${out}.answers.json`;

/**
 * (#455) Why the answers file cannot be used, or null when it can: the same test as `--out`
 * (create exclusively, then remove), so a live run never spends with nowhere to keep the answers
 * and never overwrites the answers of an earlier run.
 */
export function answersFileProblem(out: string): "answers_exists" | "answers_not_writable" | null {
  const problem = outFileProblem(answersPathFor(out));
  if (problem === "out_exists") return "answers_exists";
  if (problem === "out_not_writable" || problem === "out_required") return "answers_not_writable";
  return null;
}

/**
 * (#455) A writer for the answers file. The file is created on the FIRST entry, exclusively ("wx")
 * and with mode 0600 (set again with `fchmod`, so a permissive umask cannot widen it); every later
 * entry rewrites the whole file (`{ ruleId, entries }`), so the answers received so far are on disk
 * even if the process is killed mid-run. It is never printed.
 *
 * @returns the `onAnswer` callback for `runCompetenceRule`
 */
export function answersFileWriter(path: string, ruleId: string): (entry: SavedAnswer) => void {
  const entries: SavedAnswer[] = [];
  let created = false;
  return (entry) => {
    entries.push(entry);
    const body = JSON.stringify({ ruleId, entries }, null, 2);
    if (!created) {
      const fd = openSync(path, "wx", 0o600);
      try {
        fchmodSync(fd, 0o600);
        writeSync(fd, body);
      } finally {
        closeSync(fd);
      }
      created = true;
      return;
    }
    // The file exists with mode 0600; "w" truncates it and keeps its mode.
    writeFileSync(path, body, { flag: "w" });
  };
}

/** The command line: read the files, build the real provider only for `--live`, write the outcome to `--out`. */
async function main(): Promise<void> {
  const pagePath = arg("page");
  const versionPath = arg("version");
  const ruleId = arg("rule");
  if (!pagePath || !versionPath || !ruleId) {
    console.error("usage: --page <stored-page.json> --version <version.json> --rule <criterionId> [--verdicts <letters>] [--route <name>] [--live --out <result.json>]");
    process.exit(2);
  }
  const live = process.argv.includes("--live");
  const out = arg("out");
  // (#455) `--replay <answers.json>`: the code steps on saved answers, 0 requests.
  const replayPath = arg("replay");
  if (live && replayPath !== undefined) {
    console.error("redraft-competence-rule: refused before any spend (live_and_replay). Use --live or --replay, not both.");
    process.exit(2);
  }
  // BEFORE anything that could spend: a live run needs a result file it can certainly write.
  if (live) {
    const problem = outFileProblem(out);
    if (problem) {
      console.error(`redraft-competence-rule: refused before any spend (${problem}). A live run needs --out <a new file in a writable folder>.`);
      process.exit(2);
    }
    // (#455) ... and the answers file next to it, tested the same way.
    const answersProblem = answersFileProblem(out as string);
    if (answersProblem) {
      console.error(`redraft-competence-rule: refused before any spend (${answersProblem}). A live run keeps the model's answers in a new file next to --out (<out>.answers.json).`);
      process.exit(2);
    }
  }
  // (#455) A replay writes `--out` only when it is given, and then only to a new, writable file.
  if (replayPath !== undefined && out !== undefined) {
    const problem = outFileProblem(out);
    if (problem) {
      console.error(`redraft-competence-rule: replay refused (${problem}). --out must be a new file in a writable folder.`);
      process.exit(2);
    }
  }
  // The service modules resolve a storage bucket when loaded, though this script never touches
  // storage or Firestore. A PLACEHOLDER project id (never a real one) lets them load.
  process.env.GCLOUD_PROJECT ??= "one-rule-offline";
  const snapshot = fromFirestoreRest(JSON.parse(readFileSync(pagePath, "utf8"))) as GuidanceSnapshotContent;
  const version = fromFirestoreRest(JSON.parse(readFileSync(versionPath, "utf8"))) as VisaRubric;
  // (#455) A replay never builds the real provider: nothing can be sent, and no key is read.
  const replay = replayPath !== undefined ? new ReplayProvider(readAnswersFile(JSON.parse(readFileSync(replayPath, "utf8")))) : undefined;
  const provider = live ? new (await import("../../../services/ai/llm-provider")).AnthropicLlmProvider() : replay;
  // (#455) Live only: every answer goes to `<out>.answers.json` (0600) as it arrives.
  const onAnswer = live && out ? answersFileWriter(answersPathFor(out), ruleId) : undefined;
  const summary = await runCompetenceRule(snapshot, version, ruleId, { live: live || replay !== undefined, replay: replay !== undefined, routeName: arg("route"), verdicts: arg("verdicts"), print: printLine, provider, onAnswer });
  if ((live || replay) && out) {
    // Written whatever the outcome, so the requests spent and the reason are on file even when
    // nothing can be kept (`result` is then null). "wx" again: never over another file.
    writeFileSync(out, JSON.stringify(outFileOf(ruleId, summary), null, 2), { flag: "wx" });
    console.log(`outcome written to the --out file (${summary.result ? "a result to review" : "no result kept"}; nothing was written to any project).`);
    if (onAnswer) console.log(`model answers kept in the answers file next to it (${summary.answersReceived} entr${summary.answersReceived === 1 ? "y" : "ies"}; mode 0600; not printed).`);
  }
}

/**
 * The `--out` file's content for a summary. The shape `derive-version-from-one-rule` reads is kept:
 * the summary's fields, with the result's fields (`rule`, `intakeQuestions`, `competence`,
 * `renamedQuestionIds`) at the top level, null/empty when nothing was kept.
 *
 * (#455) That spread put the result's `competence` (the BLOCK, null when nothing was kept) over the
 * summary's `competence` (the step's CODE WORD), so a stopped run's file said `competence: null` and
 * lost even `failed:RunStop` (the #335 run). The code word is now also written as
 * `competenceOutcome`, and the stop as `stop`, neither of which the result can overwrite.
 */
export function outFileOf(ruleId: string, summary: CompetenceRuleRunSummary): Record<string, unknown> {
  const { result, planned, ...outcome } = summary;
  return { ruleId, planned: planned.length, ...outcome, competenceOutcome: summary.competence, ...(result ?? { rule: null, intakeQuestions: [], competence: null, renamedQuestionIds: {} }) };
}

// Run only when started as a script, never when a test imports `runCompetenceRule`.
if (require.main === module) {
  main().catch((e) => {
    // The class only: never the message, which can carry a path.
    console.error(`redraft-competence-rule failed: ${(e as Error).constructor.name}`);
    process.exit(1);
  });
}
