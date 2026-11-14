import { Timestamp, type Transaction } from "firebase-admin/firestore";
import { collections, db } from "../../utils/firebase";

// ============================================
// RUBRIC AUTOMATIC PUBLISHING — SETTINGS AND KILL SWITCH (issue #201)
// ============================================
//
// `appConfig/rubricPublishSettings`: whether a freshly drafted rulebook is
// published without a person, for which routes, and the numbers the automatic
// gates use. Same PATTERN as `rubric-settings.ts` (the extraction caps): one
// small doc merged field by field over code defaults; a bad stored value falls
// back to its default and is reported; a failed READ is reported separately.
//
// THE ONE RULE: this setting fails CLOSED.
//   - a missing doc            -> `manual` (nothing is published automatically);
//   - an unreadable doc        -> `manual`, flagged `readError` so the run can
//                                  record `settings_unreadable` and alert;
//   - a `mode` that is not exactly "auto" -> `manual`;
//   - a malformed `routeAllowlist` -> an EMPTY list (publishes nowhere), never
//     "absent = all routes". (A deliberate departure from "an out-of-range
//     value takes its default": the default of an allowlist is "every route",
//     which is the unsafe direction.)
//   `auto` is only ever the result of an admin writing the string "auto".
//
// Changing it needs no deploy: edit the doc in the console, or use
// `PATCH /admin/rubrics/publish-settings` (admin only), which writes an audit
// doc (`rubricPublishSettingsHistory`: who, before, after).
//
// Part B (#202) adds the checker's caps (rules per draft, requests per run, ...)
// to THIS doc and to `RANGES` / `DEFAULT_PUBLISH_SETTINGS` below.
//
// Generic: nothing here names a country, route or publisher.

/** The `appConfig` doc id. */
export const PUBLISH_SETTINGS_DOC_ID = "rubricPublishSettings";

/** The two modes. `manual` is the behaviour before #201. */
export const PUBLISH_MODES = ["manual", "auto"] as const;
export type PublishMode = (typeof PUBLISH_MODES)[number];

/** The resolved settings (every field but the allowlist filled in). */
export interface RubricPublishSettings {
  mode: PublishMode;
  // Route keys that may be published automatically. Absent = every route.
  routeAllowlist?: string[];
  // After an admin rolls a route back (part D), automatic publishing of that
  // route stays paused until an admin resumes it.
  pauseAfterRollback: boolean;
  // Most rules the leave-outs may remove, as a share of ALL rules (0..1).
  maxLeftOutShare: number;
  // The same, counting only rules from `primary` sources.
  maxPrimaryLeftOutShare: number;
  // The new version must keep at least this share of the serving version's rules.
  minKeptShareOfServing: number;
  // ---- the independent check's spend caps (part B, #202): see CHECKER_CAP_RANGES ----
  checkerMaxRulesPerDraft: number;
  checkerMaxRequestsPerRun: number;
  checkerMaxInputCharsPerRun: number;
  checkerMaxOutputTokensPerRequest: number;
  checkerMaxRunsPerDay: number;
  checkerRequestTimeoutMs: number;
  // (#223) Most failed protected rules one run will try to repair (0 = never repair: any failed bar holds at once).
  repairMaxRulesPerRun: number;
}

/**
 * The independent check's caps (part B, #202). They are SPEND caps, never a
 * rulebook-size limit: the owner's decision (2026-11-13) is that a rule is
 * never left out because the rulebook is long, so a draft over a cap is HELD
 * (`checker_capped`), not trimmed. Sized for the real draft (about 270 rules,
 * growing to about 500): 500 rules are 50 requests of 10 plus a handful for
 * the protected rules and the intention-to-stay check, with room for retries.
 *  - checkerMaxRulesPerDraft           rules the check will read in one draft
 *  - checkerMaxRequestsPerRun          model requests (retries included) per run
 *  - checkerMaxInputCharsPerRun        prompt characters sent per run
 *  - checkerMaxOutputTokensPerRequest  generated tokens per request (thinking included)
 *  - checkerMaxRunsPerDay              checker runs that reached the model, per UTC day
 *  - checkerRequestTimeoutMs           wall clock per request
 *  - repairMaxRulesPerRun              (#223) failed protected rules one run will re-draft once each.
 *                                      More failures than this is something systemic: no repair is
 *                                      attempted and the draft is held whole. Each repaired rule costs
 *                                      one re-draft request plus the check's requests, all counted
 *                                      inside `checkerMaxRequestsPerRun`.
 */
export const DEFAULT_CHECKER_CAPS = Object.freeze({
  checkerMaxRulesPerDraft: 1_000,
  checkerMaxRequestsPerRun: 120,
  checkerMaxInputCharsPerRun: 2_000_000,
  checkerMaxOutputTokensPerRequest: 8_000,
  checkerMaxRunsPerDay: 20,
  checkerRequestTimeoutMs: 240_000,
  repairMaxRulesPerRun: 5,
});
type CheckerCapKey = keyof typeof DEFAULT_CHECKER_CAPS;

/** Allowed range (inclusive, integers) of each checker cap. */
const CHECKER_CAP_RANGES: Record<CheckerCapKey, readonly [number, number]> = {
  checkerMaxRulesPerDraft: [1, 5_000],
  checkerMaxRequestsPerRun: [1, 1_000],
  checkerMaxInputCharsPerRun: [10_000, 20_000_000],
  checkerMaxOutputTokensPerRequest: [1_000, 64_000],
  checkerMaxRunsPerDay: [1, 1_000],
  checkerRequestTimeoutMs: [10_000, 600_000],
  repairMaxRulesPerRun: [0, 50],
};

/** Defaults, from the issue (#201). `mode` defaults to `manual`: fail closed. */
export const DEFAULT_PUBLISH_SETTINGS: Readonly<Omit<RubricPublishSettings, "routeAllowlist">> = Object.freeze({
  mode: "manual" as PublishMode,
  pauseAfterRollback: true,
  maxLeftOutShare: 0.15,
  maxPrimaryLeftOutShare: 0.2,
  minKeptShareOfServing: 0.7,
  ...DEFAULT_CHECKER_CAPS,
});

/** The share settings and their allowed range (inclusive). A share is a fraction, not a percentage. */
const SHARE_RANGES = {
  maxLeftOutShare: [0, 1],
  maxPrimaryLeftOutShare: [0, 1],
  minKeptShareOfServing: [0, 1],
} as const satisfies Record<string, readonly [number, number]>;
type ShareKey = keyof typeof SHARE_RANGES;

/** Most route keys an allowlist may hold. */
export const MAX_ROUTE_ALLOWLIST = 200;
/** What a route key looks like (the head doc id: country code + visa type id). */
const ROUTE_KEY_RE = /^[A-Z]{2}_[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** Result of resolving a stored doc. */
export interface ResolvedPublishSettings {
  settings: RubricPublishSettings;
  problems: string[];
}

/**
 * Merge a stored doc over the defaults. A missing field takes its default
 * silently; a present but invalid one takes its default (or, for the
 * allowlist, the empty list) and is listed in `problems`. Unknown fields are
 * ignored.
 */
export function resolvePublishSettings(raw: unknown): ResolvedPublishSettings {
  const doc = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const settings: RubricPublishSettings = { ...DEFAULT_PUBLISH_SETTINGS };
  const problems: string[] = [];
  // ---- mode: only the exact string "auto" turns automatic publishing on ----
  if (doc.mode !== undefined) {
    if (doc.mode === "auto" || doc.mode === "manual") settings.mode = doc.mode;
    else problems.push("mode: must be \"manual\" or \"auto\", using manual");
  }
  // ---- allowlist ----
  if (doc.routeAllowlist !== undefined && doc.routeAllowlist !== null) {
    const list = doc.routeAllowlist;
    if (Array.isArray(list) && list.length <= MAX_ROUTE_ALLOWLIST && list.every((k) => typeof k === "string" && ROUTE_KEY_RE.test(k))) {
      settings.routeAllowlist = [...new Set(list as string[])];
    } else {
      // Fail closed: a broken allowlist publishes nowhere.
      settings.routeAllowlist = [];
      problems.push("routeAllowlist: must be a list of route keys, publishing to no route until it is fixed");
    }
  }
  // ---- pauseAfterRollback ----
  if (doc.pauseAfterRollback !== undefined) {
    if (typeof doc.pauseAfterRollback === "boolean") settings.pauseAfterRollback = doc.pauseAfterRollback;
    else problems.push("pauseAfterRollback: not a boolean, using default");
  }
  // ---- shares ----
  for (const key of Object.keys(SHARE_RANGES) as ShareKey[]) {
    const v = doc[key];
    if (v === undefined) continue;
    const [min, max] = SHARE_RANGES[key];
    if (typeof v === "number" && Number.isFinite(v) && v >= min && v <= max) settings[key] = v;
    else problems.push(`${key}: must be a number ${min}..${max}, using default`);
  }
  // ---- the independent check's caps (integers) ----
  for (const key of Object.keys(CHECKER_CAP_RANGES) as CheckerCapKey[]) {
    const v = doc[key];
    if (v === undefined) continue;
    const [min, max] = CHECKER_CAP_RANGES[key];
    if (typeof v === "number" && Number.isInteger(v) && v >= min && v <= max) settings[key] = v;
    else problems.push(`${key}: must be an integer ${min}..${max}, using default`);
  }
  return { settings, problems };
}

/** What a settings read produced. */
export interface LoadedPublishSettings {
  settings: RubricPublishSettings;
  // Set when the Firestore READ failed (not for a missing doc). The settings
  // are then the fail-closed `manual` defaults, and the run records
  // `settings_unreadable`.
  readError?: string;
  // True when the doc exists (so a plain "nobody ever configured this" is
  // distinguishable from "configured as manual").
  exists: boolean;
  problems: string[];
}

/**
 * Read `appConfig/rubricPublishSettings` once and resolve it. NEVER throws and
 * NEVER returns `auto` unless the doc says so: a failed read comes back as
 * `manual` with `readError`.
 */
export async function loadPublishSettings(): Promise<LoadedPublishSettings> {
  try {
    const snap = await collections.appConfig.doc(PUBLISH_SETTINGS_DOC_ID).get();
    const { settings, problems } = resolvePublishSettings(snap.exists ? snap.data() : undefined);
    for (const p of problems) console.warn(`Rubric publish settings (appConfig/${PUBLISH_SETTINGS_DOC_ID}): ${p}`);
    return { settings, exists: snap.exists, problems };
  } catch (err) {
    // The error class only: a storage error message can carry a path.
    const readError = `reading appConfig/${PUBLISH_SETTINGS_DOC_ID} failed (${(err as { code?: unknown } | null)?.code ?? "unknown error"})`;
    console.error(`Rubric publish settings: ${readError}`);
    return { settings: { ...DEFAULT_PUBLISH_SETTINGS }, readError, exists: false, problems: [] };
  }
}

/** Is a route allowed to publish automatically under these settings? */
export function routeAllowed(settings: Pick<RubricPublishSettings, "routeAllowlist">, routeKey: string): boolean {
  return settings.routeAllowlist === undefined || settings.routeAllowlist.includes(routeKey);
}

// ============================================
// Admin edit (PATCH /admin/rubrics/publish-settings)
// ============================================

/** A rejected patch (the controller answers 400). */
export class PublishSettingsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublishSettingsValidationError";
  }
}

/** Keys a patch may carry. Anything else is refused, not ignored. */
const PATCH_KEYS = ["mode", "routeAllowlist", "pauseAfterRollback", ...Object.keys(SHARE_RANGES), ...Object.keys(CHECKER_CAP_RANGES)];

/** A validated patch: a present key is set, a null value clears the key (the allowlist only). */
export type PublishSettingsPatch = Partial<Omit<RubricPublishSettings, "routeAllowlist">> & { routeAllowlist?: string[] | null };

/**
 * Validate a PATCH body, strictly: unknown keys, wrong types and out-of-range
 * values are refused (400) rather than stored and later "fixed" by the
 * resolver. `routeAllowlist: null` removes the allowlist (every route).
 * @throws PublishSettingsValidationError
 */
export function parsePublishSettingsPatch(body: unknown): PublishSettingsPatch {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new PublishSettingsValidationError("the request body must be a JSON object");
  const b = body as Record<string, unknown>;
  const unknown = Object.keys(b).filter((k) => !PATCH_KEYS.includes(k));
  if (unknown.length > 0) throw new PublishSettingsValidationError(`unknown field(s): ${unknown.join(", ")}`);
  if (Object.keys(b).length === 0) throw new PublishSettingsValidationError("send at least one field to change");
  const patch: PublishSettingsPatch = {};
  if (b.mode !== undefined) {
    if (b.mode !== "manual" && b.mode !== "auto") throw new PublishSettingsValidationError("mode must be \"manual\" or \"auto\"");
    patch.mode = b.mode;
  }
  if (b.routeAllowlist !== undefined) {
    if (b.routeAllowlist === null) patch.routeAllowlist = null;
    else if (!Array.isArray(b.routeAllowlist) || b.routeAllowlist.length > MAX_ROUTE_ALLOWLIST || b.routeAllowlist.some((k) => typeof k !== "string" || !ROUTE_KEY_RE.test(k))) {
      throw new PublishSettingsValidationError(`routeAllowlist must be null or a list of at most ${MAX_ROUTE_ALLOWLIST} route keys`);
    } else patch.routeAllowlist = [...new Set(b.routeAllowlist as string[])];
  }
  if (b.pauseAfterRollback !== undefined) {
    if (typeof b.pauseAfterRollback !== "boolean") throw new PublishSettingsValidationError("pauseAfterRollback must be true or false");
    patch.pauseAfterRollback = b.pauseAfterRollback;
  }
  for (const key of Object.keys(SHARE_RANGES) as ShareKey[]) {
    const v = b[key];
    if (v === undefined) continue;
    const [min, max] = SHARE_RANGES[key];
    if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) throw new PublishSettingsValidationError(`${key} must be a number from ${min} to ${max}`);
    patch[key] = v;
  }
  for (const key of Object.keys(CHECKER_CAP_RANGES) as CheckerCapKey[]) {
    const v = b[key];
    if (v === undefined) continue;
    const [min, max] = CHECKER_CAP_RANGES[key];
    if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw new PublishSettingsValidationError(`${key} must be a whole number from ${min} to ${max}`);
    patch[key] = v;
  }
  return patch;
}

/** What GET and PATCH return. */
export interface PublishSettingsView {
  // The doc as resolved (what the pipeline will use).
  settings: RubricPublishSettings;
  // True when the doc exists in Firestore.
  exists: boolean;
  // Stored values the resolver replaced with a default (empty when clean).
  problems: string[];
}

/** Transaction runner; a property so tests can swap in an in-memory one. */
export const publishSettingsTx: { run: <T>(fn: (tx: Transaction) => Promise<T>) => Promise<T> } = {
  run: (fn) => db.runTransaction(fn),
};

/** The current settings for the admin GET. A read failure throws (the controller answers 500, never a made-up value). */
export async function readPublishSettingsView(): Promise<PublishSettingsView> {
  const snap = await collections.appConfig.doc(PUBLISH_SETTINGS_DOC_ID).get();
  const { settings, problems } = resolvePublishSettings(snap.exists ? snap.data() : undefined);
  return { settings, exists: snap.exists, problems };
}

/**
 * Apply a validated patch and write ONE audit doc (who, before, after), in one
 * transaction. The stored doc is rewritten whole (a null allowlist drops the
 * key). `before` and `after` are the RAW stored docs, so the audit shows what
 * was literally there, including a value the resolver would have replaced.
 */
export async function updatePublishSettings(patch: PublishSettingsPatch, uid: string): Promise<PublishSettingsView> {
  if (!uid) throw new Error("a settings change needs the admin's uid");
  const ref = collections.appConfig.doc(PUBLISH_SETTINGS_DOC_ID);
  const auditRef = collections.rubricPublishSettingsHistory.doc();
  await publishSettingsTx.run(async (tx) => {
    const snap = await tx.get(ref);
    const before = snap.exists ? { ...(snap.data() as Record<string, unknown>) } : null;
    const after: Record<string, unknown> = { ...(before ?? {}) };
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete after[key];
      else after[key] = value;
    }
    tx.set(ref, after);
    tx.set(auditRef, { id: auditRef.id, at: Timestamp.now(), by: uid, before, after });
  });
  return readPublishSettingsView();
}
