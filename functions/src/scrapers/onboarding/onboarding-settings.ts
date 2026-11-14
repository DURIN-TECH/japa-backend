import { Timestamp, type Transaction } from "firebase-admin/firestore";
import { collections, db } from "../../utils/firebase";
import { appendRegistryAudit } from "../shared/registry/registry-audit";
import { ROUTE_ONBOARDING_SETTINGS_DOC_ID } from "../shared/registry/registry-settings";
import { OnboardingError } from "./onboarding-types";

// ============================================
// ROUTE ONBOARDING — SETTINGS (issue #217)
// ============================================
//
// The SAME document the source registry (#215) reads,
// `appConfig/routeOnboardingSettings`, holds this part's fields. The registry
// resolver ignores fields it does not know and this resolver ignores the
// registry's, so the two never disturb each other.
//
// Same pattern as rubric-publish-settings.ts, and the same ONE RULE: fail CLOSED.
//   - a missing doc            -> `enabled: false` (an admin switches onboarding on);
//   - an unreadable doc        -> reported as `readError`, callers refuse (503);
//   - an invalid stored field  -> its default, reported in `problems`; for the
//     kill switch only the literal `true` turns anything on.
//
// Fields:
//   enabled               kill switch for STARTING and for spending (the worker re-reads it).
//   maxRunsPerDay         runs that may be created per UTC day, all routes together.
//   maxChunksPerRun       the largest plan (text parts) a run may ask the admin to confirm.
//   publishWaitMinutes    how long the run waits for the publishing safeguards to report
//                         before it ends held "no report" (a lost trigger must not hang a run).
//   heldWatchHours        how long a run that ended held with an automatic retry pending keeps
//                         watching, so the hourly sweep can turn it into published.

/** Resolved settings: every field filled in. */
export interface OnboardingSettings {
  enabled: boolean;
  maxRunsPerDay: number;
  maxChunksPerRun: number;
  publishWaitMinutes: number;
  heldWatchHours: number;
}

/** Defaults: the issue's numbers (3 runs a day) and switched OFF. */
export const DEFAULT_ONBOARDING_SETTINGS: Readonly<OnboardingSettings> = Object.freeze({
  enabled: false,
  maxRunsPerDay: 3,
  // The extraction cap of 40 requests allows 20 chunks; the default matches it.
  maxChunksPerRun: 20,
  publishWaitMinutes: 180,
  heldWatchHours: 72,
});

/** Allowed range (inclusive integers) of each numeric field. */
const RANGES: Record<Exclude<keyof OnboardingSettings, "enabled">, readonly [number, number]> = {
  maxRunsPerDay: [1, 100],
  maxChunksPerRun: [1, 500],
  publishWaitMinutes: [5, 24 * 60],
  heldWatchHours: [1, 24 * 14],
};

/** Merge a stored doc over the defaults (pure). Invalid fields take their default and are listed. */
export function resolveOnboardingSettings(raw: unknown): { settings: OnboardingSettings; problems: string[] } {
  const doc = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const settings: OnboardingSettings = { ...DEFAULT_ONBOARDING_SETTINGS };
  const problems: string[] = [];
  if (doc.enabled !== undefined) {
    // Only a real boolean counts; anything else stays OFF.
    if (typeof doc.enabled === "boolean") settings.enabled = doc.enabled;
    else problems.push("enabled: must be true or false, using false");
  }
  for (const key of Object.keys(RANGES) as (keyof typeof RANGES)[]) {
    const v = doc[key];
    if (v === undefined) continue;
    const [min, max] = RANGES[key];
    if (typeof v === "number" && Number.isInteger(v) && v >= min && v <= max) settings[key] = v;
    else problems.push(`${key}: must be an integer ${min}..${max}, using default`);
  }
  return { settings, problems };
}

/** What a settings read produced. */
export interface LoadedOnboardingSettings {
  settings: OnboardingSettings;
  // Set when the READ failed (a missing doc is normal). Callers must refuse to proceed.
  readError?: string;
  problems: string[];
}

/** Read and resolve the settings once. Never throws. */
export async function loadOnboardingSettings(): Promise<LoadedOnboardingSettings> {
  try {
    const snap = await collections.appConfig.doc(ROUTE_ONBOARDING_SETTINGS_DOC_ID).get();
    const { settings, problems } = resolveOnboardingSettings(snap.exists ? snap.data() : undefined);
    for (const p of problems) console.warn(`Onboarding settings (appConfig/${ROUTE_ONBOARDING_SETTINGS_DOC_ID}): ${p}`);
    return { settings, problems };
  } catch (err) {
    // The error class only: a storage error message can carry a path.
    const readError = `reading appConfig/${ROUTE_ONBOARDING_SETTINGS_DOC_ID} failed (${(err as { code?: unknown } | null)?.code ?? "unknown error"})`;
    console.error(`Onboarding settings: ${readError}`);
    return { settings: { ...DEFAULT_ONBOARDING_SETTINGS }, readError, problems: [] };
  }
}

// ---------- Admin edit ----------

/** Keys a patch may carry. Anything else (including the registry's language list) is refused. */
const PATCH_KEYS = ["enabled", ...Object.keys(RANGES)];

/** A validated patch. */
export type OnboardingSettingsPatch = Partial<OnboardingSettings>;

/** Validate a PATCH body strictly: unknown keys, wrong types and out-of-range values are 400s. */
export function parseOnboardingSettingsPatch(body: unknown): OnboardingSettingsPatch {
  const bad = (m: string) => new OnboardingError("VALIDATION_ERROR", 400, m);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw bad("The body must be a JSON object");
  const b = body as Record<string, unknown>;
  const unknown = Object.keys(b).filter((k) => !PATCH_KEYS.includes(k));
  if (unknown.length > 0) throw bad(`Unknown field(s): ${unknown.slice(0, 5).join(", ")}`);
  if (Object.keys(b).length === 0) throw bad("Send at least one field to change");
  const patch: OnboardingSettingsPatch = {};
  if (b.enabled !== undefined) {
    if (typeof b.enabled !== "boolean") throw bad("enabled must be true or false");
    patch.enabled = b.enabled;
  }
  for (const key of Object.keys(RANGES) as (keyof typeof RANGES)[]) {
    const v = b[key];
    if (v === undefined) continue;
    const [min, max] = RANGES[key];
    if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw bad(`${key} must be a whole number from ${min} to ${max}`);
    patch[key] = v;
  }
  return patch;
}

/** Transaction runner; a property so tests can swap in the in-memory one. */
export const onboardingSettingsTx: { run: <T>(fn: (tx: Transaction) => Promise<T>) => Promise<T> } = {
  run: (fn) => db.runTransaction(fn),
};

/**
 * Apply a validated patch and write ONE registry audit entry (who, before,
 * after) in the same transaction. Only the patched fields are merged: the
 * registry's own fields in the same doc are left exactly as they are.
 */
export async function updateOnboardingSettings(patch: OnboardingSettingsPatch, uid: string): Promise<LoadedOnboardingSettings> {
  if (!uid) throw new Error("a settings change needs the admin's uid");
  const ref = collections.appConfig.doc(ROUTE_ONBOARDING_SETTINGS_DOC_ID);
  await onboardingSettingsTx.run(async (tx) => {
    const snap = await tx.get(ref);
    const before = snap.exists ? { ...(snap.data() as Record<string, unknown>) } : null;
    const after = { ...(before ?? {}), ...patch } as Record<string, unknown>;
    tx.set(ref, patch as Record<string, unknown>, { merge: true });
    appendRegistryAudit(tx, {
      action: "onboarding_settings_changed",
      actorUid: uid,
      at: Timestamp.now(),
      targetType: "setting",
      targetId: ROUTE_ONBOARDING_SETTINGS_DOC_ID,
      before,
      after,
    });
  });
  return loadOnboardingSettings();
}
