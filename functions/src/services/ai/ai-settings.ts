import { collections } from "../../utils/firebase";

// ============================================
// AI SETTINGS — kill switch and caps for assessments (issue #42)
// ============================================
//
// `appConfig/aiSettings`: one small doc, merged field by field over the code
// defaults below. A missing doc means the defaults. A FAILED READ is reported
// separately, and the job then fails closed (settings_unavailable): an admin's
// "off" must never turn back into the default "on" because Firestore blinked.
//
// What the caps bound. The price table is empty (services/ai/ai-pricing.ts), so
// a cost in dollars cannot be checked yet. The caps are in units known before a
// call is made:
//   maxRequestsPerAssessment    model calls one assessment may make
//   maxInputCharsPerAssessment  characters of TEXT it may send (prompts, the
//                               statement, intake and extraction summaries)
//   maxAssessmentsPerDay        assessments that reached the model, per UTC day
//   maxFileBytes                size of one attached file, in real bytes
// A job that would pass a per-assessment cap is failed BEFORE the call. Switch to
// dollar caps once the prices are confirmed and recorded in ai-pricing.ts.
//
// ATTACHED FILES ARE NOT TEXT (#310). A file's base64 data used to be added to
// the character count, so one 1.5 MB scan used the whole 2,000,000 character
// budget and an ordinary application failed. Attached bytes are now bounded per
// file instead (`fileByteLimitFor` below), and the number of files by the
// request cap (one extraction call per document). The same limit is applied
// when a document is REGISTERED (services/document.service.ts), from the size
// Cloud Storage reports, so the upload limit and the review limit are one number.

/** The `appConfig` doc id. */
export const AI_SETTINGS_DOC_ID = "aiSettings";

/** The resolved settings. */
export interface AiSettings {
  enabled: boolean;
  maxRequestsPerAssessment: number;
  maxInputCharsPerAssessment: number;
  maxAssessmentsPerDay: number;
  maxFileBytes: number;
  // Bulk re-assessment (#37): provider requests the Batch API path may submit per
  // UTC day. The hard cap while the price table is empty.
  maxBatchRequestsPerDay: number;
  // Bulk re-assessment (#37): dollars of recorded batch spend per UTC day. 0 means
  // "no dollar cap". Only enforced when both roles have a confirmed price
  // (ai-pricing.ts); otherwise the request cap above is the only brake.
  maxBatchCostUsdPerDay: number;
  // ---- ask-anywhere chat (issue #45) ----
  // Kill switch for chat alone (the assessment `enabled` switch also stops it).
  chatEnabled: boolean;
  // Per-user rate limit: messages in one UTC clock hour, and in one UTC day.
  chatMessagesPerUserPerHour: number;
  chatMessagesPerUserPerDay: number;
  // Per-user spend cap. The price table is empty, so the cap is in TOKENS
  // (input + output the API reported) per UTC day, not dollars. Switch to
  // dollars once ai-pricing.ts has confirmed prices.
  chatTokensPerUserPerDay: number;
  // Global cap: chat turns that reached the model, per UTC day, all users.
  chatTurnsPerDay: number;
  // ---- agency listing screening (issue #120) ----
  // Model calls the listing language check may make per UTC day, all agencies,
  // and per agency. Counted in requests (the price table is empty). The code
  // comparison is not capped: it costs no model call.
  listingScreeningsPerDay: number;
  listingScreeningsPerAgencyPerDay: number;
}

/**
 * Defaults. Sized for one ordinary self-service application.
 *
 * `maxRequestsPerAssessment` is 30 (#310; it was 12). One review makes one
 * extraction call per document plus one judgement call per batch of rules
 * (the largest approved rulebook when this was set needs 5; no route is named
 * here on purpose, the engine's sources stay route-free). At 12, an
 * application with more than 7 documents could not be reviewed at all. 30 covers 15 documents + 5 judgement
 * calls with room for 10 more of either (so up to 25 documents on that
 * rulebook). The allowed range stays 1-50, and a stored value in that range
 * still overrides this default. Raising it raises the most ONE review can
 * spend; the daily cap (`maxAssessmentsPerDay`) and the per-user limits are
 * unchanged.
 */
export const DEFAULT_AI_SETTINGS: Readonly<AiSettings> = Object.freeze({
  enabled: true,
  maxRequestsPerAssessment: 30,
  maxInputCharsPerAssessment: 2_000_000,
  maxAssessmentsPerDay: 200,
  maxFileBytes: 10 * 1024 * 1024,
  maxBatchRequestsPerDay: 1_000,
  maxBatchCostUsdPerDay: 0,
  chatEnabled: true,
  chatMessagesPerUserPerHour: 20,
  chatMessagesPerUserPerDay: 100,
  chatTokensPerUserPerDay: 400_000,
  chatTurnsPerDay: 5_000,
  listingScreeningsPerDay: 200,
  listingScreeningsPerAgencyPerDay: 20,
});

/** Allowed range of each numeric setting. A stored value outside it falls back to its default. */
const RANGES: Record<Exclude<keyof AiSettings, "enabled" | "chatEnabled">, [number, number]> = {
  maxRequestsPerAssessment: [1, 50],
  maxInputCharsPerAssessment: [10_000, 20_000_000],
  maxAssessmentsPerDay: [1, 10_000],
  maxFileBytes: [100_000, 50 * 1024 * 1024],
  maxBatchRequestsPerDay: [1, 100_000],
  maxBatchCostUsdPerDay: [0, 100_000],
  chatMessagesPerUserPerHour: [1, 1_000],
  chatMessagesPerUserPerDay: [1, 10_000],
  chatTokensPerUserPerDay: [10_000, 50_000_000],
  chatTurnsPerDay: [1, 1_000_000],
  listingScreeningsPerDay: [1, 10_000],
  listingScreeningsPerAgencyPerDay: [1, 1_000],
};

// ============================================
// Per-file size limit (issue #310)
// ============================================

/**
 * The most bytes of ONE image the model provider accepts, as a raw file.
 *
 * The Claude API refuses an image whose BASE64 text is over 10 MB (vision
 * guide, "The maximum size per image": "10 MB (base64-encoded) on the Claude
 * API"). Base64 is 4 characters per 3 bytes, so the raw file must stay under
 * 7.5 MB; 7 MB (9.79 million base64 characters) leaves a margin whichever way
 * the provider counts a megabyte. A 2-4 MB phone photo is well inside it.
 *
 * A PDF has no per-file limit of its own: it is bounded by the request size
 * (128 MB) and the page count (600), so `maxFileBytes` (10 MB) applies as is.
 *
 * Not a stored setting: it is a fact about the provider, not a choice. If the
 * provider changes, change it here (and in the mobile app's size check).
 */
export const MODEL_IMAGE_MAX_BYTES = 7 * 1024 * 1024;

/**
 * The size limit, in real bytes, for one file of the given kind: the ONE place
 * the upload check (document registration) and the review read it from, so the
 * two cannot drift apart.
 *
 *  - an image: the smaller of `maxFileBytes` and what the model accepts;
 *  - anything else (a PDF): `maxFileBytes`.
 */
export function fileByteLimitFor(settings: Pick<AiSettings, "maxFileBytes">, isImage: boolean): number {
  return isImage ? Math.min(settings.maxFileBytes, MODEL_IMAGE_MAX_BYTES) : settings.maxFileBytes;
}

/** True for a MIME type that names an image ("image/jpeg", "image/png", "image/heic", ...). */
export function isImageType(type: string | null | undefined): boolean {
  return typeof type === "string" && type.trim().toLowerCase().startsWith("image/");
}

/** A byte count as whole megabytes for a message ("10 MB"), at most one decimal. */
export function megabytesLabel(bytes: number): string {
  const mb = Math.round((bytes / (1024 * 1024)) * 10) / 10;
  return `${mb} MB`;
}

/** Result of a settings read. */
export type AiSettingsRead = { ok: true; settings: AiSettings } | { ok: false; reason: string };

/** Merge a stored doc over the defaults, field by field. */
export function mergeAiSettings(stored: Record<string, unknown> | undefined): AiSettings {
  const out: AiSettings = { ...DEFAULT_AI_SETTINGS };
  if (!stored) return out;
  if (typeof stored.enabled === "boolean") out.enabled = stored.enabled;
  if (typeof stored.chatEnabled === "boolean") out.chatEnabled = stored.chatEnabled;
  for (const key of Object.keys(RANGES) as Array<keyof typeof RANGES>) {
    const v = stored[key];
    const [min, max] = RANGES[key];
    if (typeof v === "number" && Number.isFinite(v) && v >= min && v <= max) out[key] = v;
  }
  return out;
}

/** Read the settings. Never throws: a failed read is a result, so the caller can fail closed. */
export async function readAiSettings(): Promise<AiSettingsRead> {
  try {
    const snap = await collections.appConfig.doc(AI_SETTINGS_DOC_ID).get();
    return { ok: true, settings: mergeAiSettings(snap.exists ? (snap.data() as Record<string, unknown>) : undefined) };
  } catch {
    return { ok: false, reason: "the AI settings could not be read" };
  }
}
