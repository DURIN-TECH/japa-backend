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
//   maxInputCharsPerAssessment  characters (text and attached bytes) it may send
//   maxAssessmentsPerDay        assessments that reached the model, per UTC day
//   maxFileBytes                size of one attached file
// A job that would pass a per-assessment cap is failed BEFORE the call. Switch to
// dollar caps once the prices are confirmed and recorded in ai-pricing.ts.

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
}

/** Defaults. Sized for one application with a handful of documents. */
export const DEFAULT_AI_SETTINGS: Readonly<AiSettings> = Object.freeze({
  enabled: true,
  maxRequestsPerAssessment: 12,
  maxInputCharsPerAssessment: 2_000_000,
  maxAssessmentsPerDay: 200,
  maxFileBytes: 10 * 1024 * 1024,
  maxBatchRequestsPerDay: 1_000,
  maxBatchCostUsdPerDay: 0,
});

/** Allowed range of each numeric setting. A stored value outside it falls back to its default. */
const RANGES: Record<Exclude<keyof AiSettings, "enabled">, [number, number]> = {
  maxRequestsPerAssessment: [1, 50],
  maxInputCharsPerAssessment: [10_000, 20_000_000],
  maxAssessmentsPerDay: [1, 10_000],
  maxFileBytes: [100_000, 50 * 1024 * 1024],
  maxBatchRequestsPerDay: [1, 100_000],
  maxBatchCostUsdPerDay: [0, 100_000],
};

/** Result of a settings read. */
export type AiSettingsRead = { ok: true; settings: AiSettings } | { ok: false; reason: string };

/** Merge a stored doc over the defaults, field by field. */
export function mergeAiSettings(stored: Record<string, unknown> | undefined): AiSettings {
  const out: AiSettings = { ...DEFAULT_AI_SETTINGS };
  if (!stored) return out;
  if (typeof stored.enabled === "boolean") out.enabled = stored.enabled;
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
