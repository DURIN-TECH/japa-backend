import { collections } from "../../utils/firebase";

// ============================================
// RUBRIC EXTRACTION — SETTINGS AND COST GUARDS (issue #40)
// ============================================
//
// `appConfig/rubricExtractionSettings`: the kill switch and the caps for
// rubric extraction. The same PATTERN as the scraper settings
// (scrapers/shared/settings/scraper-settings.store.ts): one small doc, merged
// field by field over code defaults, a bad stored value falls back to its
// default and is reported, and a failed READ is reported separately so the
// caller can FAIL CLOSED (an admin's "off" must never turn into the default
// "on" because Firestore blinked).
//
// It is its own doc rather than a new section of `appConfig/scraperSettings`
// because that doc's shape is tied, by a mapped type, to the admin PATCH
// validation, its audit history and the settings screen; adding a section
// there would change all three. A separate doc is purely additive. An admin
// screen for it is not part of this issue: the doc is edited in the console.
//
// What the caps bound (there is no price in code, so the caps are in units
// that are known before a call is made):
//   maxChunkChars              size of one request's source text
//   maxRequestsPerRun          model calls one run may make
//   maxInputCharsPerRun        source text one run may send in total
//   maxOutputTokensPerRequest  generated tokens per call (thinking included)
//   requestTimeoutMs           wall clock per call
//   maxRunsPerDay              runs that reached the model, per UTC day
// A run that would pass a per-run cap is refused BEFORE its first call, so a
// rubric is never built from part of a document.

/** The `appConfig` doc id. */
export const RUBRIC_SETTINGS_DOC_ID = "rubricExtractionSettings";

/** The resolved settings (every field filled in). */
export interface RubricExtractionSettings {
  // Kill switch: false = no run makes a model call or writes a version.
  enabled: boolean;
  maxChunkChars: number;
  maxRequestsPerRun: number;
  maxInputCharsPerRun: number;
  maxOutputTokensPerRequest: number;
  requestTimeoutMs: number;
  maxRunsPerDay: number;
  // ---- (#216) the background job that drafts a rulebook in saved steps ----
  // Model calls of one step that may fail (a transient provider error, a
  // timeout, a crash while the call was in flight) before the job fails.
  stepAttemptsMax: number;
  // Wall clock one worker invocation may spend advancing a job. Must leave a
  // margin under the function's 540 s cut-off; a new step starts only when a
  // whole request timeout still fits inside it.
  invocationBudgetMs: number;
  // How long a worker's lease on a job lasts. A crashed worker's lease
  // expires after this and the sweep resumes the job.
  leaseMs: number;
  // A job older than this is failed `job_timed_out` rather than left running.
  jobMaxAgeMs: number;
  // The sweep leaves a job alone while it made progress this recently (a
  // worker is probably between two invocations).
  jobIdleMs: number;
}

/**
 * Defaults, sized from the one measured document the plan describes (about
 * 80 pages, about 170,000 characters):
 *  - maxChunkChars 24,000: the per-page text cap the web path already uses;
 *    about 8 requests for that document;
 *  - maxRequestsPerRun 40 / maxInputCharsPerRun 600,000: room for a route
 *    with a few such sources, and a hard stop well short of a runaway;
 *  - maxOutputTokensPerRequest 48,000: a first real run (#112) was cut off
 *    at 16,000 on a dense chunk (about 11,500 tokens per call on average,
 *    thinking included, effort "high"), which failed the whole run with
 *    `output_truncated`. This is a ceiling, not a spend target: the other
 *    caps (requests and input characters per run, runs per day) are unchanged;
 *  - requestTimeoutMs 240,000: four minutes, against an SDK default of ten;
 *  - maxRunsPerDay 20: guidance changes a few times a year.
 */
export const DEFAULT_RUBRIC_SETTINGS: Readonly<RubricExtractionSettings> = Object.freeze({
  enabled: true,
  maxChunkChars: 24_000,
  maxRequestsPerRun: 40,
  maxInputCharsPerRun: 600_000,
  maxOutputTokensPerRequest: 48_000,
  requestTimeoutMs: 240_000,
  maxRunsPerDay: 20,
  // (#216) Three tries of one step; a 450 s invocation budget (90 s under the
  // function's 540 s limit); a lease slightly longer than a whole invocation;
  // six hours for a job (a real route took 30-40 minutes, an outage is
  // allowed for); two minutes of quiet before the sweep resumes a job.
  stepAttemptsMax: 3,
  invocationBudgetMs: 450_000,
  leaseMs: 600_000,
  jobMaxAgeMs: 21_600_000,
  jobIdleMs: 120_000,
});

/** Allowed range of each numeric setting. */
const RANGES: Record<Exclude<keyof RubricExtractionSettings, "enabled">, [number, number]> = {
  maxChunkChars: [1_000, 200_000],
  maxRequestsPerRun: [1, 500],
  maxInputCharsPerRun: [1_000, 5_000_000],
  maxOutputTokensPerRequest: [1_000, 128_000],
  requestTimeoutMs: [10_000, 600_000],
  maxRunsPerDay: [1, 1_000],
  stepAttemptsMax: [1, 10],
  invocationBudgetMs: [30_000, 500_000],
  leaseMs: [60_000, 1_800_000],
  jobMaxAgeMs: [600_000, 172_800_000],
  jobIdleMs: [10_000, 3_600_000],
};

/**
 * Merge a stored doc over the defaults. A missing field takes its default
 * silently; a present but invalid one takes its default and is listed in
 * `problems`. Unknown fields are ignored.
 */
export function resolveRubricSettings(raw: unknown): { settings: RubricExtractionSettings; problems: string[] } {
  const doc = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const settings: RubricExtractionSettings = { ...DEFAULT_RUBRIC_SETTINGS };
  const problems: string[] = [];
  if (doc.enabled !== undefined) {
    if (typeof doc.enabled === "boolean") settings.enabled = doc.enabled;
    else problems.push("enabled: not a boolean, using default");
  }
  for (const [key, [min, max]] of Object.entries(RANGES) as [keyof typeof RANGES, [number, number]][]) {
    const v = doc[key];
    if (v === undefined) continue;
    if (typeof v === "number" && Number.isInteger(v) && v >= min && v <= max) settings[key] = v;
    else problems.push(`${key}: must be an integer ${min}..${max}, using default`);
  }
  return { settings, problems };
}

/** What a settings read produced. */
export interface LoadedRubricSettings {
  settings: RubricExtractionSettings;
  // Set when the Firestore READ failed (not for a missing doc, which is
  // normal and means defaults). Callers must not run when it is set.
  readError?: string;
}

/**
 * Read `appConfig/rubricExtractionSettings` once and resolve it. Never
 * throws: a failed read comes back as `readError` with the defaults, and the
 * extraction service refuses to run on it.
 */
export async function loadRubricSettings(): Promise<LoadedRubricSettings> {
  try {
    const snap = await collections.appConfig.doc(RUBRIC_SETTINGS_DOC_ID).get();
    const { settings, problems } = resolveRubricSettings(snap.exists ? snap.data() : undefined);
    for (const p of problems) console.warn(`Rubric settings (appConfig/${RUBRIC_SETTINGS_DOC_ID}): ${p}`);
    return { settings };
  } catch (err) {
    const readError = `reading appConfig/${RUBRIC_SETTINGS_DOC_ID} failed: ${(err as Error)?.message ?? String(err)}`;
    console.error(`Rubric settings: ${readError}`);
    return { settings: { ...DEFAULT_RUBRIC_SETTINGS }, readError };
  }
}
