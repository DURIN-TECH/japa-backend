import { createHash } from "crypto";
import { Timestamp } from "firebase-admin/firestore";
import type { PlannedSource } from "../rubric/rubric-extraction.service";
import type { RubricExtractionSettings } from "../rubric/rubric-settings";
import { routeAllowed, type LoadedPublishSettings } from "../rubric/rubric-publish-settings";
import { reasonInWords } from "../rubric/rubric-gates";
import { needsTranslation } from "../language/language-lexicon";
import type { JobView } from "../rubric/rubric-extraction-job";
import type { OnboardingSettings } from "./onboarding-settings";
import {
  STEP_IDS,
  type EstimateSource,
  type HoldReason,
  type PublishState,
  type RunEstimate,
  type RunStatus,
  type RunStep,
  type StepId,
} from "./onboarding-types";

// ============================================
// ROUTE ONBOARDING — PURE RULES AND PLAIN WORDS (issue #217)
// ============================================
//
// Everything in this file is a pure function: it reads values and returns
// values, touches no database and makes no call. That is what lets the tests
// pin every sentence an admin will read and every mapping from "what the
// pipeline said" to "how the run ended".
//
// Two principles:
//   1. NO NEW NUMBERS AND NO NEW GATES. A route is "too thin", "held" or
//      "published" exactly as the existing reason codes of the extraction job
//      and the publishing pipeline say; this file only translates them.
//   2. PLAIN WORDS. Every message is written for an admin who is not a
//      developer. Machine codes travel next to them (never instead of them).

// ---------- Steps ----------

/** The label of each step, in the admin's words. */
export const STEP_LABELS: Record<StepId, string> = {
  check_setup: "Checking the registered pages and the settings",
  read_visa_page: "Reading the visa page",
  read_rule_pages: "Reading the rule pages",
  plan: "Planning the rulebook draft",
  confirm: "Waiting for your confirmation",
  draft: "Drafting the rulebook",
  safeguards: "Running the safeguards",
};

/** The step list of a new run: every step pending, in order. */
export function initialSteps(): RunStep[] {
  return STEP_IDS.map((id) => ({ id, label: STEP_LABELS[id], status: "pending" as const, startedAt: null, finishedAt: null, detail: "" }));
}

/** One headline sentence per status, for the portal (the run's `summary` starts from it). */
export const STATUS_PLAIN: Record<RunStatus, string> = {
  preparing: "Reading the registered pages. Nothing is spent yet.",
  awaiting_confirmation: "Waiting for you to confirm the estimate. Nothing has been spent yet.",
  running: "Drafting the rulebook.",
  waiting_for_publish: "The draft is written. The safeguards are deciding whether to publish it.",
  published: "The rulebook was published automatically.",
  held: "The rulebook was drafted but not published.",
  too_thin: "The pages state too little to form a rulebook.",
  failed: "The run stopped because of a problem.",
  cancelled: "The run was cancelled.",
};

// ---------- The estimate ----------

/** Observed on a real route: about 3.7 check and question-check calls per drafted part. */
export const CHECK_CALLS_PER_CHUNK = 3.7;
/** Observed on a real route: about this many tokens in and out per extraction call. */
export const AVG_INPUT_TOKENS_PER_CALL = 10_000;
export const AVG_OUTPUT_TOKENS_PER_CALL = 9_000;

/** The statement an admin accepts by confirming (the portal shows it word for word). */
export const CONFIRMATION_STATEMENT =
  "The rulebook will be read from exactly these pages and published automatically if the safeguards pass. Nobody will read the rules first.";

/** Fingerprint of a plan: which pages (by content) and how big. A changed page changes it. */
export function planHashOf(plan: readonly PlannedSource[]): string {
  const parts = [...plan]
    .sort((a, b) => a.sourceId.localeCompare(b.sourceId))
    .map((p) => `${p.sourceId}:${p.contentHashPrefix}:${p.chars}:${p.chunks}`);
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 16);
}

/** What automatic publishing will do for this route, in plain words. */
export function publishStateOf(loaded: LoadedPublishSettings, routeKey: string): PublishState {
  if (loaded.readError !== undefined) {
    return { code: "unknown", plain: "Automatic publishing settings could not be read, so it is not known whether this route will publish by itself." };
  }
  if (loaded.settings.mode !== "auto") {
    return { code: "off_manual_mode", plain: "Automatic publishing is off (manual mode): the draft will wait for you in the Rubrics tab." };
  }
  if (!routeAllowed(loaded.settings, routeKey)) {
    return { code: "not_on_allowlist", plain: "This route is not on the allow-list for automatic publishing: the draft will wait for you." };
  }
  return { code: "on", plain: "Automatic publishing is on for this route." };
}

/** Everything an estimate is made from. */
export interface EstimateInput {
  runId: string;
  routeKey: string;
  plan: readonly PlannedSource[];
  // Registry facts per source, for the admin's preview table.
  sourceFacts: ReadonlyMap<string, { title: string; host: string; role: string; language?: string }>;
  extraction: Pick<RubricExtractionSettings, "maxRequestsPerRun" | "maxInputCharsPerRun">;
  checkerMaxRequestsPerRun: number;
  onboarding: Pick<OnboardingSettings, "maxChunksPerRun" | "maxRunsPerDay">;
  publishState: PublishState;
  now: Timestamp;
}

/** Build the estimate (pure). The id is stable for the same plan and caps, so a re-plan of the same pages gives the same id. */
export function buildEstimate(input: EstimateInput): RunEstimate {
  const sources: EstimateSource[] = [...input.plan]
    .sort((a, b) => a.sourceId.localeCompare(b.sourceId))
    .map((p) => {
      const f = input.sourceFacts.get(p.sourceId);
      return { sourceId: p.sourceId, title: f?.title ?? p.sourceId, host: f?.host ?? "", role: f?.role ?? "secondary", docType: p.docType, characters: p.chars, chunks: p.chunks, contentHashPrefix: p.contentHashPrefix, ...(f?.language ? { language: f.language } : {}) };
    });
  const chunks = sources.reduce((n, s) => n + s.chunks, 0);
  const characters = sources.reduce((n, s) => n + s.characters, 0);
  const extractionCallsAtMost = chunks * 2;
  // (#220) One translation call at most per text part of a page in another language.
  const translationCallsAtMost = sources.filter((s) => needsTranslation(s.language)).reduce((n, s) => n + s.chunks, 0);
  // "About 3.7 per chunk, never more than the checker's cap".
  const checkCap = input.checkerMaxRequestsPerRun;
  const checkCallsAbout = Math.min(Math.ceil(chunks * CHECK_CALLS_PER_CHUNK), checkCap);
  const planHash = planHashOf(input.plan);
  const caps = {
    maxRequestsPerRun: input.extraction.maxRequestsPerRun,
    maxInputCharsPerRun: input.extraction.maxInputCharsPerRun,
    maxChunksPerRun: input.onboarding.maxChunksPerRun,
    checkerMaxRequestsPerRun: checkCap,
    maxRunsPerDay: input.onboarding.maxRunsPerDay,
  };
  const inputTokensApprox = extractionCallsAtMost * AVG_INPUT_TOKENS_PER_CALL;
  const outputTokensApprox = extractionCallsAtMost * AVG_OUTPUT_TOKENS_PER_CALL;
  const estimateId = `est_${createHash("sha256").update(`${input.runId}|${planHash}|${JSON.stringify(caps)}`).digest("hex").slice(0, 16)}`;
  const plain =
    `${sources.length} page${sources.length === 1 ? "" : "s"} read (${characters.toLocaleString("en-US")} characters). ` +
    `Drafting needs up to ${extractionCallsAtMost} model calls; the independent checks need about ${checkCallsAbout} more (at most ${checkCap}). ` +
    (translationCallsAtMost > 0 ? `Because some pages are not in English, up to ${translationCallsAtMost} more calls translate their quotes for readers (unofficial, never used as evidence). ` : "") +
    `Drafting alone is about ${inputTokensApprox.toLocaleString("en-US")} tokens in and ${outputTokensApprox.toLocaleString("en-US")} out. ` +
    input.publishState.plain;
  return {
    estimateId,
    createdAt: input.now,
    planHash,
    sources,
    sourceCount: sources.length,
    characters,
    chunks,
    extractionCallsAtMost,
    checkCallsAbout,
    checkCallsAtMost: checkCap,
    ...(translationCallsAtMost > 0 ? { translationCallsAtMost } : {}),
    inputTokensApprox,
    outputTokensApprox,
    caps,
    publishState: input.publishState,
    plain,
    statement: CONFIRMATION_STATEMENT,
  };
}

/**
 * A plan that passes a cap is refused BEFORE any call, naming the cap in plain
 * words. Returns the sentence, or null when the plan fits. The extraction caps
 * are also enforced by the drafting job's own plan (this repeats them so the
 * message names the cap); the chunk cap is this part's own.
 */
export function capRefusal(est: Pick<RunEstimate, "chunks" | "characters" | "extractionCallsAtMost">, extraction: Pick<RubricExtractionSettings, "maxRequestsPerRun" | "maxInputCharsPerRun">, onboarding: Pick<OnboardingSettings, "maxChunksPerRun">): string | null {
  if (est.chunks > onboarding.maxChunksPerRun) {
    return `The plan has ${est.chunks} text parts, more than the ${onboarding.maxChunksPerRun} a run may ask you to confirm (maxChunksPerRun). Nothing was spent.`;
  }
  if (est.extractionCallsAtMost > extraction.maxRequestsPerRun) {
    return `The plan needs up to ${est.extractionCallsAtMost} model calls, more than the ${extraction.maxRequestsPerRun} one drafting run may make (maxRequestsPerRun). Nothing was spent.`;
  }
  if (est.characters > extraction.maxInputCharsPerRun) {
    return `The pages hold ${est.characters.toLocaleString("en-US")} characters, more than the ${extraction.maxInputCharsPerRun.toLocaleString("en-US")} one drafting run may send (maxInputCharsPerRun). Nothing was spent.`;
  }
  return null;
}

/** Name the cap in a refusal the drafting job's own plan gave (`run_cap_exceeded` carries numbers, not the cap's name). */
export function jobCapMessage(message: string | null): string {
  const m = message ?? "";
  const cap = /requests/.test(m) ? "maxRequestsPerRun" : /characters/.test(m) ? "maxInputCharsPerRun" : "a drafting limit";
  return `The plan passes a limit, so nothing was started: ${m} (${cap}). Nothing was spent.`;
}

// ---------- The drafting job ----------

/** How a finished or stopped drafting job maps to the run. */
export type JobOutcome =
  // Keep going: the job wrote this version.
  | { kind: "drafted"; version: number }
  | { kind: "too_thin"; plain: string; code: string }
  | { kind: "failed"; plain: string; code: string }
  | { kind: "cancelled" };

/** Plain words for the stop codes of the drafting job (existing codes; unknown ones are shown as they are). */
export const JOB_FAILURE_WORDS: Record<string, string> = {
  settings_unavailable: "The drafting settings could not be read, so the draft stopped.",
  disabled: "Rulebook drafting is switched off, so the draft stopped.",
  daily_cap_reached: "The daily limit of drafting runs is used up. Try again tomorrow, or raise the limit.",
  run_cap_exceeded: "The draft would pass a drafting limit, so it stopped before spending more.",
  sources_changed: "A page changed while the draft was being written, so no draft was kept. Start a new run to read the new text.",
  plan_changed: "The stored text no longer cuts into the same parts as when the draft started. Start a new run.",
  job_timed_out: "The draft did not finish within the time allowed for it.",
  provider_error: "The AI service kept failing, so the draft stopped.",
  output_truncated: "The AI's answer was cut off, so the draft stopped.",
  unexpected_error: "The draft stopped because of an unexpected problem.",
};

/** Map a drafting job's view to what the run does next (pure). */
export function mapJob(job: Pick<JobView, "status" | "reasonCode" | "message" | "version" | "chunksDone" | "chunks">): JobOutcome | { kind: "active" } {
  switch (job.status) {
  case "queued":
  case "running":
    return { kind: "active" };
  case "succeeded":
    return job.version !== null ? { kind: "drafted", version: job.version } : { kind: "failed", code: "version_missing", plain: "The draft finished but no version was recorded." };
  case "cancelled":
    return { kind: "cancelled" };
  case "skipped":
    // Another draft of the same sources was written first: carry on with that version.
    if (job.reasonCode === "source_unchanged" && job.version !== null) return { kind: "drafted", version: job.version };
    break;
  default:
    break;
  }
  const code = job.reasonCode ?? "unknown";
  // The extraction accepted no rule from any page: the pages state too little.
  if (code === "no_criteria_accepted") return { kind: "too_thin", code, plain: THIN_PLAIN };
  const words = JOB_FAILURE_WORDS[code] ?? `The draft stopped (${job.message ?? code}).`;
  return { kind: "failed", code, plain: `${words} ${job.chunksDone} of ${job.chunks} parts were done.` };
}

/** What an admin reads when the pages state too little. */
export const THIN_PLAIN =
  "The pages you gave state too little to form a rulebook. Add the law or the regulation page, or accept that this route has no rulebook.";

// ---------- The publishing pipeline ----------

/**
 * Hold reasons that clear by themselves: the hourly sweep of the publishing
 * pipeline retries them (a copy of `RETRYABLE_REASONS` and `MAX_SWEEP_ATTEMPTS`
 * in services/rubric-auto-publish.service.ts, kept here because that service
 * sits above the scrapers module; a test pins that the two agree).
 */
export const PIPELINE_RETRYABLE_REASONS: readonly string[] = ["checker_unavailable", "checker_capped", "checker_output_invalid", "question_plan_unusable"];
export const PIPELINE_MAX_ATTEMPTS = 3;

/** What the run saw of the pipeline for one version. */
export interface PublishObservation {
  // The version's review status, or null when it could not be read.
  versionStatus: string | null;
  // The pipeline's run record, or null when there is none.
  run: { outcome: "published" | "held" | "skipped"; reasonCodes: string[]; attempts: number } | null;
  // The publish settings as read now (null: not read this time).
  settings: LoadedPublishSettings | null;
  // Milliseconds since the draft was handed to the safeguards.
  waitedMs: number;
  waitLimitMs: number;
}

/** What the run does next about the pipeline. */
export type PublishVerdict =
  | { kind: "wait" }
  | { kind: "end"; status: "published" | "held" | "too_thin"; plain: string; hold: HoldReason | null };

const hold = (code: string, plain: string, retryScheduled: boolean, codes: string[] = [code]): HoldReason => ({ code, plain, retryScheduled, codes });

/** Reason codes meaning "the sources gave no usable rules" (existing gate codes). */
export function isThinCode(code: string): boolean {
  return code === "no_criteria" || code === "no_criteria_accepted" || code.startsWith("primary_source_empty");
}

/** Map what the pipeline recorded to how the run ends (pure). */
export function mapPublish(o: PublishObservation): PublishVerdict {
  // A person (or the pipeline) decided the version already.
  if (o.versionStatus === "approved") return { kind: "end", status: "published", plain: "The rulebook was published.", hold: null };
  if (o.versionStatus === "rejected") {
    return { kind: "end", status: "held", plain: "The draft was rejected, so it was not published.", hold: hold("rejected", "The draft was rejected, so it was not published.", false) };
  }
  const run = o.run;
  if (run) {
    if (run.outcome === "published") return { kind: "end", status: "published", plain: "The rulebook was published automatically.", hold: null };
    if (run.outcome === "skipped") {
      if (run.reasonCodes.includes("route_not_in_allowlist")) {
        const plain = "Automatic publishing is not on for this route: it is not on the allow-list. The draft waits for you in the Rubrics tab.";
        return { kind: "end", status: "held", plain, hold: hold("route_not_in_allowlist", plain, false, run.reasonCodes) };
      }
      const code = run.reasonCodes[0] ?? "skipped";
      const plain = `Automatic publishing did not run: ${reasonInWords(code)}. The draft waits for you in the Rubrics tab.`;
      return { kind: "end", status: "held", plain, hold: hold(code, plain, false, run.reasonCodes) };
    }
    // Held.
    const codes = run.reasonCodes;
    if (codes.some(isThinCode)) return { kind: "end", status: "too_thin", plain: THIN_PLAIN, hold: hold(codes.find(isThinCode) as string, THIN_PLAIN, false, codes) };
    const retryable = codes.length > 0 && codes.every((c) => PIPELINE_RETRYABLE_REASONS.includes(c));
    const auto = o.settings === null ? true : o.settings.readError === undefined && o.settings.settings.mode === "auto";
    if (retryable) {
      const left = run.attempts < PIPELINE_MAX_ATTEMPTS && auto;
      const plain = left
        ? `The independent check could not run yet. It will retry by itself (try ${run.attempts} of ${PIPELINE_MAX_ATTEMPTS} done).`
        : `The independent check could not finish after ${run.attempts} tries. Run the safeguards again from the Rubrics tab.`;
      return { kind: "end", status: "held", plain, hold: hold(codes[0], plain, left, codes) };
    }
    const why = codes.length > 0 ? codes.map(reasonInWords).join("; ") : "see the publishing record";
    const plain = `Held by the safeguards: ${why}.`;
    return { kind: "end", status: "held", plain, hold: hold(codes[0] ?? "held", plain, false, codes) };
  }
  // No record. In manual mode the pipeline writes nothing at all, so this is the answer.
  if (o.settings && o.settings.readError === undefined && o.settings.settings.mode !== "auto") {
    const plain = "Automatic publishing is not on for this route (manual mode). The draft waits for you in the Rubrics tab.";
    return { kind: "end", status: "held", plain, hold: hold("manual_mode", plain, false) };
  }
  if (o.waitedMs >= o.waitLimitMs) {
    const plain = "The safeguards have not reported. Open the draft in the Rubrics tab and run them from there.";
    return { kind: "end", status: "held", plain, hold: hold("no_safeguard_report", plain, false) };
  }
  return { kind: "wait" };
}

// ---------- The pages ----------

/** Plain words for a guidance crawl failure class (the registry's existing kinds). */
export function crawlFailureWords(kind: string | undefined): string {
  switch (kind) {
  case "http_error": return "the website answered with an error";
  case "content_type_changed": return "the page is no longer the kind of document that was registered";
  case "redirect_changed": return "the address now leads to a different document";
  case "resolve_failed": return "the document address could not be found on its parent page";
  case "robots_blocked": return "the website asks robots not to read this page";
  case "host_backoff": return "the website asked us to slow down";
  case "host_not_confirmed": return "the address leads to a website that is not confirmed as official";
  case "pdf_unreadable": return "the PDF could not be read";
  case "text_too_long": return "the page is longer than can be read";
  case "storage_error":
  case "firestore_error": return "our storage had a problem";
  default: return "the page could not be fetched";
  }
}
