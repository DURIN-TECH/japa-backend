import { Timestamp } from "firebase-admin/firestore";
import { randomUUID } from "node:crypto";
import { AnthropicLlmProvider, type LlmProvider, type LlmRequest } from "../services/ai/llm-provider";
import { checkAuthorityId, isCountryCode, todayUtc } from "../authorities/authority-ids";
import {
  chunkSnapshot,
  guidanceSnapshotStore,
  languageSupport,
  lexiconFor,
  loadPublishSettings,
  loadRegistrySettings,
  loadRubricSettings,
  officialDomainAuthorityId,
  productLanguageCode,
  resolveSourceLanguage,
  SnapshotQuoteIndex,
  type LoadedPublishSettings,
  type LoadedRubricSettings,
} from "../scrapers";
import type { GuidanceSnapshotContent } from "../scrapers/types";
import { collections } from "../utils/firebase";
import type { Authority } from "../types/authority";
import type {
  EntryDestinationScope,
  EntryRule,
  EntryRuleMember,
  EntryRuleRefusal,
  EntryRuleRun,
  EntryRuleRunStatus,
} from "../types/entry-requirements";
import {
  buildCheckRequest,
  buildCodingRequest,
  buildDraftRequest,
  ENTRY_CHECK_PROMPT_VERSION,
  ENTRY_RULE_PROMPT_VERSION,
  EntryPromptError,
  parseCheckAnswer,
  parseCodingAnswer,
  parseDraftAnswer,
  type CheckCodeView,
  type CheckRuleView,
  type DraftAuthorityRef,
  type EntryCheckAspect,
  type EntryRequestLimits,
  type EntryVerdict,
  type ListLine,
} from "./entry-rule-prompt";
import { checkDraftedRule, dedupeDrafted, type DraftedRule, type DraftSource } from "./entry-rule-draft";
import { evaluateEntryGates, failedAspects } from "./entry-rule-gates";
import { entryRuleStore, type EntryRuleStore } from "./entry-rule.store";

// ============================================
// ENTRY RULES — THE DRAFTING RUN (issue #236, P7 of #228)
// ============================================
//
// One run drafts ONE issuing authority's entry rules from its registered
// official pages and either PUBLISHES them (every safeguard passed) or HOLDS
// them (visible to the admin, never served). It is the rulebook pipeline's
// shape, built from its blocks (scrapers public API), with entry rules' own
// prompts (entry-rule-prompt.ts):
//
//   1. settings, BEFORE any spend: the extraction kill switch and caps
//      (`appConfig/rubricExtractionSettings`) and the checker caps and publish
//      mode (`appConfig/rubricPublishSettings`). A failed read fails the run;
//      a run over the per-day limit is refused.
//   2. sources: each must be a guidance source of THIS authority, active, on a
//      host confirmed official for it, with a stored snapshot (the same
//      snapshots the rulebooks use). Languages not enabled for publishing hold
//      the run before any spend (#220).
//   3. the spend estimate: drafting calls = chunks of the pages; over a cap the
//      run fails `capped:*` before the first call (never trimmed: no rule is
//      dropped for size).
//   4. draft (model) -> code checks against the stored page (entry-rule-draft.ts)
//      -> list lines read IN FULL by code and coded (model) -> independent check
//      (model, another role) -> gates (entry-rule-gates.ts).
//   5. one store write: the rules, the run record, and (published) the head
//      switch that makes them served (entry-rule.store.ts).
//
// Every model call is counted against the caps; logging carries ids, counts
// and codes only, never source text or an answer.
//
// Generic: no country, bloc, treaty or nationality name.

/** Most list lines coded in one call. */
const CODING_BATCH = 150;
/** Most rules checked in one call. */
const CHECK_RULES_BATCH = 10;
/** Most code pairs checked in one call. */
const CHECK_CODES_BATCH = 150;
/** The chunk size cap: under the prompt-safety block limit (20,000), so a chunk is never cut. */
const MAX_CHUNK_CHARS = 18_000;
/** Lines of context shown to the check around a quote / a list. */
const CONTEXT_LINES = 3;

/** One guidance source as loaded for a run. */
export interface LoadedSource {
  sourceId: string;
  url: string;
  language: string;
  snapshot: GuidanceSnapshotContent;
}

/** What a run reads and calls (Firestore and the real model by default; faked in tests). */
export interface PipelineDeps {
  provider: LlmProvider;
  store: EntryRuleStore;
  // The authority being drafted, or undefined (a country authority may have no doc).
  readAuthority(id: string): Promise<Authority | undefined>;
  // Active bloc / treaty authorities (the ids a group may name).
  listBlocs(): Promise<DraftAuthorityRef[]>;
  // Load and vet each source; a problem names the source and the reason.
  loadSources(authorityId: string, sourceIds: string[]): Promise<{ sources: LoadedSource[]; problems: string[] }>;
  extractionSettings(): Promise<LoadedRubricSettings>;
  publishSettings(): Promise<LoadedPublishSettings>;
  supportedLanguages(): Promise<{ languages: string[]; readError?: string }>;
  now(): number;
  newRunId(): string;
}

/** Firestore + real model implementation. */
export function defaultPipelineDeps(): PipelineDeps {
  return {
    provider: new AnthropicLlmProvider(),
    store: entryRuleStore,
    async readAuthority(id) {
      const snap = await collections.authorities.doc(id).get();
      return snap.exists ? (snap.data() as Authority) : undefined;
    },
    async listBlocs() {
      const snap = await collections.authorities.get();
      return snap.docs
        .map((d) => d.data() as Authority)
        .filter((a) => a.kind !== "country" && a.status === "active")
        .map((a) => ({ id: a.id, name: a.name }))
        .sort((a, b) => a.id.localeCompare(b.id));
    },
    async loadSources(authorityId, sourceIds) {
      const sources: LoadedSource[] = [];
      const problems: string[] = [];
      for (const id of sourceIds) {
        const snap = await collections.guidanceSources.doc(id).get();
        if (!snap.exists) {
          problems.push(`${id}:not_found`);
          continue;
        }
        const s = snap.data() as { jurisdiction?: string; status?: string; url?: string; lastContentHash?: string | null; finalUrl?: string | null; language?: string };
        if (s.jurisdiction !== authorityId) problems.push(`${id}:other_authority`);
        else if (s.status !== "active") problems.push(`${id}:not_active`);
        else if (!s.lastContentHash) problems.push(`${id}:no_snapshot`);
        else {
          const url = s.finalUrl || s.url || "";
          let host = "";
          try {
            host = new URL(url).hostname;
          } catch {
            problems.push(`${id}:bad_url`);
            continue;
          }
          // The page must be on a website confirmed official FOR THIS authority (#215, #232).
          const domain = await collections.officialDomains.doc(host).get();
          const d = domain.exists ? (domain.data() as { status?: string }) : undefined;
          if (!d || d.status !== "confirmed" || officialDomainAuthorityId(d) !== authorityId) {
            problems.push(`${id}:host_not_confirmed`);
            continue;
          }
          try {
            const snapshot = await guidanceSnapshotStore.read(id, s.lastContentHash);
            sources.push({ sourceId: id, url, language: resolveSourceLanguage(s.language), snapshot });
          } catch {
            problems.push(`${id}:snapshot_unreadable`);
          }
        }
      }
      return { sources, problems };
    },
    extractionSettings: () => loadRubricSettings(),
    publishSettings: () => loadPublishSettings(),
    async supportedLanguages() {
      const r = await loadRegistrySettings();
      return { languages: r.settings.supportedLanguages, ...(r.readError ? { readError: r.readError } : {}) };
    },
    now: () => Date.now(),
    newRunId: () => randomUUID().replace(/-/g, "").slice(0, 16),
  };
}

/** What a caller asks for. */
export interface RunInput {
  authorityId: string;
  sourceIds: string[];
  dryRun: boolean;
  trigger: "script" | "test";
}

/** What a run returns: its record and every rule it produced (any status). */
export interface RunResult {
  run: EntryRuleRun;
  rules: EntryRule[];
}

/** A stop that ends the run with a status and a reason code. */
class RunStop extends Error {
  constructor(readonly status: EntryRuleRunStatus, readonly reason: string) {
    super(reason);
    this.name = "RunStop";
  }
}

/** Spend counters of one run. */
interface Spend {
  drafting: number;
  coding: number;
  check: number;
  inputChars: number;
  inputTokens: number;
  outputTokens: number;
}

/** The plain-data view of a drafted rule for the check (what was drafted, nothing else). */
function draftedView(r: DraftedRule): Record<string, unknown> {
  return {
    outcome: r.outcome,
    members: r.members.map((m) => ({ ...m })),
    uncoded: r.uncoded,
    ...(r.maxStayDays !== undefined ? { max_stay_days: r.maxStayDays } : {}),
    ...(r.stayPeriodDays !== undefined ? { stay_period_days: r.stayPeriodDays } : {}),
    ...(r.purposes ? { purposes: r.purposes } : {}),
    ...(r.authorisationName ? { authorisation_name: r.authorisationName } : {}),
    ...(r.notAVisa ? { not_a_visa_quote: r.notAVisa.quote } : {}),
    ...(r.fee ? { fee: { amount: r.fee.amount, currency: r.fee.currency } } : {}),
    conditions: r.conditions,
  };
}

/** Lines of a snapshot around a unit (normalised, non-empty). */
function linesAround(index: SnapshotQuoteIndex, unit: number, before: number, after: number): { before: string[]; after: string[] } {
  const b: string[] = [];
  for (let u = unit - 1; u >= 0 && b.length < before; u--) if (index.unitText(u)) b.unshift(index.unitText(u));
  const a: string[] = [];
  for (let u = unit + 1; u < index.unitCount && a.length < after; u++) if (index.unitText(u)) a.push(index.unitText(u));
  return { before: b, after: a };
}

/** The one non-empty line before / after a unit, or null. */
function neighbour(index: SnapshotQuoteIndex, unit: number, dir: -1 | 1): string | null {
  for (let u = unit + dir; u >= 0 && u < index.unitCount; u += dir) if (index.unitText(u)) return index.unitText(u);
  return null;
}

/** Cut a list into batches of `size`. */
function batches<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** The run's model-calling half, with the caps enforced on every call. */
class Caller {
  /** Prompt characters sent on each side (drafting + coding share the extraction caps; the check has its own). */
  private draftChars = 0;
  private checkChars = 0;

  constructor(private readonly provider: LlmProvider, private readonly spend: Spend, private readonly caps: { draftRequests: number; draftChars: number; checkRequests: number; checkChars: number }) {}

  /** One call; counted BEFORE it is made so a cap can never be passed. */
  async call(kind: "drafting" | "coding" | "check", request: LlmRequest): Promise<string> {
    const chars = request.system.length + request.user.length;
    const draftSide = kind !== "check";
    const used = draftSide ? this.spend.drafting + this.spend.coding : this.spend.check;
    if (used + 1 > (draftSide ? this.caps.draftRequests : this.caps.checkRequests)) throw new RunStop("held", draftSide ? "capped:requests" : "checker_capped:requests");
    const charsUsed = (draftSide ? this.draftChars : this.checkChars) + chars;
    if (charsUsed > (draftSide ? this.caps.draftChars : this.caps.checkChars)) throw new RunStop("held", draftSide ? "capped:input_chars" : "checker_capped:input_chars");
    if (draftSide) this.draftChars = charsUsed;
    else this.checkChars = charsUsed;
    this.spend[kind]++;
    this.spend.inputChars += chars;
    let res;
    try {
      res = await this.provider.complete(request);
    } catch {
      // The failure's class only: never a prompt or a provider object.
      throw new RunStop(kind === "check" ? "held" : "failed", kind === "check" ? "checker_unavailable:provider" : "provider_error");
    }
    this.spend.inputTokens += res.usage.inputTokens;
    this.spend.outputTokens += res.usage.outputTokens;
    if (res.stopReason === "max_tokens") throw new RunStop(kind === "check" ? "held" : "failed", `${kind}:output_truncated`);
    if (res.stopReason !== "end_turn") throw new RunStop(kind === "check" ? "held" : "failed", `${kind}:provider_stopped`);
    return res.text;
  }
}

/** Draft, check, gate and store one authority's entry rules. Never throws for a run-level failure: it is recorded. */
export async function runEntryRuleDrafting(input: RunInput, deps: PipelineDeps = defaultPipelineDeps()): Promise<RunResult> {
  const startedMs = deps.now();
  const runId = `${input.authorityId}__${deps.newRunId()}`;
  const spend: Spend = { drafting: 0, coding: 0, check: 0, inputChars: 0, inputTokens: 0, outputTokens: 0 };
  const refusals: EntryRuleRefusal[] = [];
  let drafted: DraftedRule[] = [];
  let rules: EntryRule[] = [];
  let gates: EntryRuleRun["gates"] = [];
  let status: EntryRuleRunStatus = input.dryRun ? "dry_run" : "held";
  let reasons: string[] = [];
  let sourceUrls: string[] = [];
  let listLines = 0;
  let leftOut = 0;
  let kept = 0;
  const models = { drafting: null as string | null, check: null as string | null };

  try {
    // ---- 0. the authority and the destination it covers ----
    if (!checkAuthorityId(input.authorityId).ok) throw new RunStop("failed", "invalid_authority");
    const authority = await deps.readAuthority(input.authorityId);
    if (authority && authority.status !== "active") throw new RunStop("failed", "authority_retired");
    const isCountry = isCountryCode(input.authorityId);
    if (!isCountry && !authority) throw new RunStop("failed", "authority_not_found");
    const destination: EntryDestinationScope = isCountry ? { kind: "countries", countryCodes: [input.authorityId] } : { kind: "members_of", authorityId: input.authorityId };
    if (input.sourceIds.length === 0) throw new RunStop("failed", "no_sources");

    // ---- 1. settings and caps, before any spend ----
    const [extraction, publish] = await Promise.all([deps.extractionSettings(), deps.publishSettings()]);
    if (extraction.readError) throw new RunStop("failed", "settings_unreadable:extraction");
    if (!extraction.settings.enabled) throw new RunStop("failed", "kill_switch");
    const runsToday = await deps.store.runsStartedOn(todayUtc(startedMs));
    const dayCap = Math.min(extraction.settings.maxRunsPerDay, publish.settings.checkerMaxRunsPerDay);
    if (runsToday >= dayCap) throw new RunStop("failed", "daily_run_cap");
    const draftLimits: EntryRequestLimits = { maxOutputTokens: extraction.settings.maxOutputTokensPerRequest, timeoutMs: extraction.settings.requestTimeoutMs };
    const checkLimits: EntryRequestLimits = { maxOutputTokens: publish.settings.checkerMaxOutputTokensPerRequest, timeoutMs: publish.settings.checkerRequestTimeoutMs };

    // ---- 2. sources (official, this authority's, with a stored snapshot) ----
    const { sources, problems } = await deps.loadSources(input.authorityId, input.sourceIds);
    if (problems.length > 0) throw new RunStop("failed", `source_not_usable:${problems.join(",")}`);
    sourceUrls = sources.map((s) => s.url);
    const langs = await deps.supportedLanguages();
    const support = languageSupport(sources.map((s) => s.language), langs.readError ? [productLanguageCode()] : langs.languages);
    if (!support.ok) throw new RunStop("held", `language_not_supported:${support.unsupported.join(",")}`);
    const draftSources = new Map<string, DraftSource>(
      sources.map((s) => [
        s.sourceId,
        { sourceId: s.sourceId, url: s.url, contentHash: s.snapshot.contentHash, fetchedAt: s.snapshot.fetchedAt, index: new SnapshotQuoteIndex(s.snapshot, lexiconFor(s.language)) },
      ])
    );

    // ---- 3. the drafting estimate: over a cap, nothing is spent (never trimmed) ----
    const blocs = await deps.listBlocs();
    const chunkChars = Math.min(extraction.settings.maxChunkChars, MAX_CHUNK_CHARS);
    const requests = sources.flatMap((s) => chunkSnapshot(s.snapshot, chunkChars).map((c) => ({ sourceId: s.sourceId, req: buildDraftRequest(c.text, s.url, { issuingAuthorityId: input.authorityId, authorities: blocs }, draftLimits) })));
    const estChars = requests.reduce((n, r) => n + r.req.system.length + r.req.user.length, 0);
    if (requests.length > extraction.settings.maxRequestsPerRun) throw new RunStop("failed", `capped:draft_requests:${requests.length}>${extraction.settings.maxRequestsPerRun}`);
    if (estChars > extraction.settings.maxInputCharsPerRun) throw new RunStop("failed", `capped:draft_input_chars:${estChars}>${extraction.settings.maxInputCharsPerRun}`);
    const caller = new Caller(deps.provider, spend, {
      draftRequests: extraction.settings.maxRequestsPerRun,
      draftChars: extraction.settings.maxInputCharsPerRun,
      checkRequests: publish.settings.checkerMaxRequestsPerRun,
      checkChars: publish.settings.checkerMaxInputCharsPerRun,
    });
    models.drafting = deps.provider.modelFor("judgement");
    models.check = deps.provider.modelFor("verification");

    // ---- 4a. draft, then code checks against the stored page ----
    const authorityIds = new Set(blocs.map((b) => b.id));
    for (const { sourceId, req } of requests) {
      let raw;
      try {
        raw = parseDraftAnswer(await caller.call("drafting", req));
      } catch (err) {
        if (err instanceof EntryPromptError) throw new RunStop("failed", `drafting:${err.code}`);
        throw err;
      }
      const source = draftSources.get(sourceId)!;
      for (const r of raw) {
        const checked = checkDraftedRule(r, source, { authorityIds });
        if (checked.ok) drafted.push(checked.rule);
        else refusals.push({ reason: checked.reason, sourceId, quote: String(r.quote).slice(0, 300) });
      }
    }
    drafted = dedupeDrafted(drafted);

    // ---- 4b. list lines (read in full by code) -> codes (model) ----
    const lines: { ruleIndex: number; lineIndex: number; id: string; text: string }[] = [];
    drafted.forEach((r, ri) => r.list?.lines.forEach((text, li) => lines.push({ ruleIndex: ri, lineIndex: li, id: `l${lines.length + 1}`, text })));
    listLines = lines.length;
    const proposed = new Map<string, string | null>();
    for (const batch of batches(lines, CODING_BATCH)) {
      const sent: ListLine[] = batch.map((l) => ({ id: l.id, text: l.text }));
      try {
        for (const [id, code] of parseCodingAnswer(await caller.call("coding", buildCodingRequest(sent, draftLimits)), sent)) proposed.set(id, code);
      } catch (err) {
        if (err instanceof EntryPromptError) throw new RunStop("failed", `coding:${err.code}`);
        throw err;
      }
    }

    // ---- 4c. the independent check: every rule, every proposed code ----
    const ruleViews: CheckRuleView[] = drafted.map((r, i) => {
      const index = draftSources.get(r.sourceId)!.index;
      const around = linesAround(index, r.unit, CONTEXT_LINES, CONTEXT_LINES);
      return {
        id: `r${i + 1}`,
        passage: r.quote,
        linesBefore: around.before,
        linesAfter: around.after,
        drafted: draftedView(r),
        ...(r.list ? { list: { firstLine: r.list.lines[0], lastLine: r.list.lines[r.list.lines.length - 1], lineCount: r.list.lines.length, lineBefore: neighbour(index, r.list.startUnit, -1), lineAfter: neighbour(index, r.list.endUnit, 1) } } : {}),
      };
    });
    const codeViews: CheckCodeView[] = lines.filter((l) => proposed.get(l.id)).map((l) => ({ id: l.id, line: l.text, code: proposed.get(l.id) as string }));
    const ruleBatches = batches(ruleViews, CHECK_RULES_BATCH);
    const codeBatches = batches(codeViews, CHECK_CODES_BATCH);
    const checkCalls = Math.max(ruleBatches.length, codeBatches.length);
    if (checkCalls > publish.settings.checkerMaxRequestsPerRun) throw new RunStop("held", `checker_capped:requests:${checkCalls}>${publish.settings.checkerMaxRequestsPerRun}`);
    const verdicts = new Map<string, Record<EntryCheckAspect, EntryVerdict>>();
    const codeVerdicts = new Map<string, "yes" | "no" | "unsure">();
    for (let i = 0; i < checkCalls; i++) {
      const rs = ruleBatches[i] ?? [];
      const cs = codeBatches[i] ?? [];
      const req = buildCheckRequest(rs, cs, checkLimits);
      try {
        const ans = parseCheckAnswer(await caller.call("check", req), rs, cs);
        for (const [id, v] of ans.rules) verdicts.set(id, v);
        for (const [id, v] of ans.codes) codeVerdicts.set(id, v);
      } catch (err) {
        if (err instanceof EntryPromptError) throw new RunStop("held", `checker:${err.code}`);
        throw err;
      }
    }

    // ---- 4d. apply the verdicts: codes confirmed -> coded members; else uncoded (never dropped) ----
    const now = Timestamp.fromMillis(deps.now());
    const builtKept: EntryRule[] = [];
    const builtLeftOut: EntryRule[] = [];
    drafted.forEach((r, i) => {
      const members: EntryRuleMember[] = [...r.members];
      const uncoded = [...r.uncoded];
      for (const l of lines.filter((x) => x.ruleIndex === i)) {
        const code = proposed.get(l.id);
        if (code && codeVerdicts.get(l.id) === "yes") members.push({ kind: r.list!.fact, code, asWritten: l.text });
        else uncoded.push(l.text);
      }
      const failed = failedAspects(verdicts.get(`r${i + 1}`), r);
      const rule: EntryRule = {
        id: `${runId}__${String(i + 1).padStart(4, "0")}`,
        issuingAuthorityId: input.authorityId,
        destination,
        destinationCodes: destination.kind === "countries" ? destination.countryCodes : [],
        scopeAuthorityId: destination.kind === "members_of" ? destination.authorityId : null,
        outcome: r.outcome,
        group: { members, uncoded },
        ...(r.maxStayDays !== undefined ? { maxStayDays: r.maxStayDays } : {}),
        ...(r.stayPeriodDays !== undefined ? { stayPeriodDays: r.stayPeriodDays } : {}),
        ...(r.purposes ? { purposes: r.purposes } : {}),
        ...(r.authorisationName ? { authorisationName: r.authorisationName } : {}),
        ...(r.notAVisa ? { notAVisa: r.notAVisa } : {}),
        ...(r.applyUrl ? { applyUrl: r.applyUrl } : {}),
        ...(r.fee ? { fee: r.fee } : {}),
        conditions: r.conditions,
        quote: r.quote,
        url: r.url,
        ...(r.list ? { listItems: r.list.lines } : {}),
        sourceId: r.sourceId,
        contentHash: r.contentHash,
        fetchedAt: r.fetchedAt,
        publishedAt: null,
        status: failed.length === 0 ? "held" : "left_out",
        ...(failed.length > 0 ? { leftOutReason: `checker:${failed.join(",")}` } : {}),
        runId,
        promptVersion: ENTRY_RULE_PROMPT_VERSION,
        checkPromptVersion: ENTRY_CHECK_PROMPT_VERSION,
        createdAt: now,
      };
      (failed.length === 0 ? builtKept : builtLeftOut).push(rule);
    });
    kept = builtKept.length;
    leftOut = builtLeftOut.length;

    // ---- 5. the automatic safeguards ----
    const servedNow = await deps.store.servedCount(input.authorityId);
    const g = evaluateEntryGates({
      authorityId: input.authorityId,
      drafted: drafted.length + refusals.length,
      refused: refusals.length,
      kept,
      leftOut,
      servedNow,
      settings: { ...publish.settings, ...(publish.readError ? { readError: publish.readError } : {}) },
    });
    gates = g.gates;
    reasons = g.reasons;
    const publishNow = reasons.length === 0 && !input.dryRun;
    if (publishNow) for (const r of builtKept) Object.assign(r, { status: "published", publishedAt: now });
    rules = [...builtKept, ...builtLeftOut];
    status = input.dryRun ? "dry_run" : publishNow ? "published" : "held";
  } catch (err) {
    if (!(err instanceof RunStop)) {
      // Unexpected: recorded as a failure with the error's name only.
      console.error(`[entry-rules] run ${runId} stopped unexpectedly:`, err instanceof Error ? err.name : "unknown error");
      status = "failed";
      reasons = ["unexpected_error"];
    } else {
      status = input.dryRun && err.status !== "failed" ? "dry_run" : err.status;
      reasons = [err.reason];
    }
    // A stopped run serves nothing new; rules drafted so far are not stored.
    rules = [];
  }

  const run: EntryRuleRun = {
    id: runId,
    authorityId: input.authorityId,
    status,
    reasons,
    gates,
    sourceIds: input.sourceIds,
    promptVersion: ENTRY_RULE_PROMPT_VERSION,
    checkPromptVersion: ENTRY_CHECK_PROMPT_VERSION,
    models,
    requests: { drafting: spend.drafting, coding: spend.coding, check: spend.check },
    inputChars: spend.inputChars,
    inputTokens: spend.inputTokens,
    outputTokens: spend.outputTokens,
    counts: {
      drafted: drafted.length + refusals.length,
      refused: refusals.length,
      kept,
      leftOut,
      listLines,
      uncodedNames: rules.reduce((n, r) => n + r.group.uncoded.length, 0),
    },
    refusals,
    ruleIds: rules.map((r) => r.id),
    startedOn: todayUtc(startedMs),
    startedAt: Timestamp.fromMillis(startedMs),
    finishedAt: Timestamp.fromMillis(deps.now()),
    trigger: input.trigger,
  };
  // A dry run writes nothing. Anything else is recorded (a failure too: the admin sees why).
  if (!input.dryRun) await deps.store.saveRun(run, rules, { publish: status === "published", sourceUrls });
  console.log(`[entry-rules] run ${runId}: ${status}${reasons.length ? ` (${reasons.join(", ")})` : ""}; rules ${rules.length}, kept ${kept}, left out ${leftOut}, refused ${refusals.length}; requests ${spend.drafting}+${spend.coding}+${spend.check}`);
  return { run, rules };
}
