import type { Timestamp } from "firebase-admin/firestore";
// (#225) Type-only: the head also carries the automatic re-draft's claims and deferral.
import type { RedraftHeadFields } from "./onboarding-redraft";

// ============================================
// ROUTE ONBOARDING RUN — TYPES (issue #217, part P3 of umbrella #211)
// ============================================
//
// One RUN takes one registered route from its sources to a published or held
// rulebook. The run is a document that a worker advances in small saved steps
// (see onboarding-worker.ts); this file is only its shape, so the portal, the
// worker and the tests agree on it.
//
// Collections (both backend-only: no firestore.rules match):
//   routeOnboardingRuns/{routeKey}__r{n}   the run
//   routeOnboardingRoutes/{routeKey}       the per-route head (counter + active run id)
//
// Nothing here names a country, route or publisher: all of it is data.

/** Statuses of a run. The first four are ACTIVE; the rest are final. */
export const RUN_STATUSES = [
  // Reading the registered pages. No model call.
  "preparing",
  // Stopped: the estimate is stored and the admin must confirm the number.
  "awaiting_confirmation",
  // Confirmed: the drafting job is running (the model calls happen here, in the job).
  "running",
  // The draft is written; the automatic publishing safeguards decide.
  "waiting_for_publish",
  // Final.
  "published",
  "held",
  "too_thin",
  "failed",
  "cancelled",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** Statuses a run can still leave on its own (the worker or the admin moves them). */
export const ACTIVE_RUN_STATUSES: readonly RunStatus[] = ["preparing", "awaiting_confirmation", "running", "waiting_for_publish"];
/** The ones the WORKER advances (`awaiting_confirmation` waits for a person). */
export const WORKER_RUN_STATUSES: readonly RunStatus[] = ["preparing", "running", "waiting_for_publish"];

/** True for a status that is final (cancelling it is refused; a new run for the route is allowed). */
export function isTerminalRun(status: RunStatus): boolean {
  return !ACTIVE_RUN_STATUSES.includes(status);
}

/** The ordered step ids. Fixed: the portal can rely on them. */
export const STEP_IDS = ["check_setup", "read_visa_page", "read_rule_pages", "plan", "confirm", "draft", "safeguards"] as const;
export type StepId = (typeof STEP_IDS)[number];

/** Where one step stands. */
export type StepStatus = "pending" | "running" | "waiting" | "done" | "skipped" | "failed" | "cancelled";

/** One entry of the stored step list. */
export interface RunStep {
  id: StepId;
  // Plain-words name, written for the admin.
  label: string;
  status: StepStatus;
  startedAt: Timestamp | null;
  finishedAt: Timestamp | null;
  // Plain-words detail or reason ("waiting: another crawl of this country is running").
  detail: string;
}

/** Plain-words reason a run ended `held` or `too_thin`. */
export interface HoldReason {
  // Machine code: an existing reason code of the pipeline, or one of ours (`manual_mode`, `no_safeguard_report`).
  code: string;
  // One sentence, plain words.
  plain: string;
  // True while the hourly sweep of the publishing pipeline will try again by itself.
  retryScheduled: boolean;
  // Every machine code the pipeline gave (for the portal's detail view).
  codes: string[];
}

/** One page the run read, as the admin sees it before confirming. */
export interface EstimateSource {
  sourceId: string;
  title: string;
  host: string;
  role: string;
  docType: "html" | "pdf";
  characters: number;
  chunks: number;
  contentHashPrefix: string;
  // (#220) The language the page was registered in (a code). Absent on an estimate stored before #220.
  language?: string;
}

/** The state of automatic publishing for this route, in plain words. */
export interface PublishState {
  // `on`: a draft goes through the safeguards by itself. `off_manual_mode`: the draft will wait for an admin.
  // `not_on_allowlist`: the route is not on the allow-list. `unknown`: the settings could not be read.
  code: "on" | "off_manual_mode" | "not_on_allowlist" | "unknown";
  plain: string;
}

/** The estimate stored when the run reaches `awaiting_confirmation`. */
export interface RunEstimate {
  // What the admin confirms: this id, sent back on confirm.
  estimateId: string;
  createdAt: Timestamp;
  // Fingerprint of the plan (sources, sizes), so a changed plan is noticed at start.
  planHash: string;
  sources: EstimateSource[];
  sourceCount: number;
  characters: number;
  chunks: number;
  // Extraction calls: "at most 2 x chunks" (the formula of the extraction caps).
  extractionCallsAtMost: number;
  // Check and question-check calls: about 3.7 per chunk, never more than the checker cap.
  checkCallsAbout: number;
  checkCallsAtMost: number;
  // (#220) Translation calls: at most one per text part of a page that is not in the product language
  // (an unofficial courtesy, never evidence; it spends against the same request cap). Absent / 0 when none.
  translationCallsAtMost?: number;
  // Tokens from the observed per-call averages, for the extraction calls only.
  inputTokensApprox: number;
  outputTokensApprox: number;
  // The caps in force when the estimate was made.
  caps: {
    maxRequestsPerRun: number;
    maxInputCharsPerRun: number;
    maxChunksPerRun: number;
    checkerMaxRequestsPerRun: number;
    maxRunsPerDay: number;
  };
  publishState: PublishState;
  // The plain-words summary line, as the portal shows it.
  plain: string;
  // The statement the admin accepts by confirming.
  statement: string;
}

/** Counters mirrored from the drafting job (and kept in the final record). */
export interface RunCounters {
  chunksTotal: number;
  chunksDone: number;
  // Model calls the DRAFTING JOB made (the independent check's calls are not counted here).
  calls: number;
  inputTokens: number;
  outputTokens: number;
  // Null while prices are unset in code.
  costUsd: number | null;
}

/** Ids of everything the run produced or read. */
export interface RunLinks {
  // The visa record in Visa Review (`countries/{cc}/visaTypes/{visaTypeId}`), once it exists.
  visaTypeId: string | null;
  // The registered visa page that was read.
  visaSourceUrl: string | null;
  guidanceSourceIds: string[];
  // Snapshot ids (content hashes) of the rule pages the plan was made from.
  snapshotIds: string[];
  // The drafting job.
  jobId: string | null;
  // The rulebook version the job wrote.
  rulebookVersion: number | null;
  // The automatic publishing run record (`rubricPublishRuns/{routeKey}__v{n}`).
  publishRunId: string | null;
}

/** What one confirmation recorded. */
export interface Confirmation {
  by: string;
  at: Timestamp;
  estimateId: string;
  // The number the admin saw: the most extraction calls the estimate allowed.
  maxRequests: number;
  statementAccepted: true;
  addToAllowlist: boolean;
  // Set by the worker once it re-checked the plan against the confirmed number (the start follows).
  recheckedAt?: Timestamp;
}

/** `routeOnboardingRuns/{runId}`. */
export interface RouteOnboardingRun {
  runId: string;
  routeKey: string;
  // The country of a country's route. (#233 P4b) ABSENT on a run for a SHARED
  // layer (a bloc's or treaty's rulebook): that run files no country visa
  // record and drafts the rulebook under `{authorityId}_{routeSlug}`.
  countryCode?: string;
  // The visa id (a country's route) or the shared route id (a shared layer):
  // the same value as `routeSlug`, kept under this name for the portal.
  visaTypeId: string;
  // (#233 P4b) The issuing authority and route slug of the rulebook drafted
  // (for a country these equal `countryCode` and `visaTypeId`). Absent on runs
  // started before P4b (read them from `countryCode` / `visaTypeId`).
  authorityId?: string;
  routeSlug?: string;
  // (#233 P4b) "shared" on a run for a bloc's or treaty's shared layer; absent on a country's route.
  layer?: "shared";
  status: RunStatus;
  // One plain sentence about where the run stands (the portal headline).
  summary: string;
  steps: RunStep[];
  // The registered pages and the snapshots read, pinned for the plan.
  pinned: { guidanceCrawled: { sourceId: string; outcome: string; contentHashPrefix: string | null }[] };
  estimate: RunEstimate | null;
  // The confirmation currently in force (null until confirmed, and again after a stale estimate).
  confirmation: Confirmation | null;
  // Earlier confirmations that a changed plan voided (kept, never rewritten).
  voidedConfirmations: Confirmation[];
  // What happened to "add this route to the allow-list" ("not_requested" | "added" | "already_allowed" | "refused").
  allowlist: "not_requested" | "pending" | "added" | "already_allowed" | "refused";
  counters: RunCounters;
  holdReason: HoldReason | null;
  links: RunLinks;
  // The run was made from sources that did not change since the last rulebook: no model call was made.
  unchanged: boolean;
  // ---- control ----
  createdBy: string;
  cancelRequested: boolean;
  cancelRequestedBy: string | null;
  leaseOwner: string | null;
  leaseUntil: Timestamp | null;
  // Bumped to wake the worker (the worker trigger fires when it changes).
  kick: number;
  // Earliest time the sweep should wake a run that is waiting (a held lease, a host backing off, the drafting job).
  nextAttemptAt: Timestamp | null;
  // Failed tries of the action the run is on (counted across invocations, so it cannot loop forever).
  attempts: { stepKey: string; count: number };
  // Set when the run ends failed or held and the alert has not been raised yet (the sweep raises it).
  alertPending: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  finishedAt: Timestamp | null;
  // When the draft was handed to the safeguards (the wait for their report is counted from here).
  handedToSafeguardsAt: Timestamp | null;
}

/**
 * `routeOnboardingRoutes/{routeKey}`. (#225) Also the meeting point of the
 * automatic re-draft and the runs: its claims and deferral (see
 * onboarding-redraft.ts). A head may exist with `lastSeq: 0` when the trigger
 * wrote it before any run was started.
 */
export interface RouteOnboardingHead extends RedraftHeadFields {
  routeKey: string;
  // Runs created so far (the next run is `r{lastSeq + 1}`).
  lastSeq: number;
  // The run opened last. It is active when its own status says so.
  activeRunId: string | null;
  updatedAt: Timestamp;
}

/** A refusal made on purpose, with the HTTP status and a machine code (plain-words message). */
export class OnboardingError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    // Extra fields echoed in the response body (the active run id, the new estimate).
    readonly extra: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "OnboardingError";
  }
}
