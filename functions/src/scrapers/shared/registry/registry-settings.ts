import { collections } from "../../../utils/firebase";

// ============================================
// SOURCE REGISTRY — SETTINGS (issue #215)
// ============================================
//
// `appConfig/routeOnboardingSettings`: the limits and the language list of the
// route-registration API. Same pattern as `rubric-settings.ts`: one small doc
// merged field by field over code defaults; a present-but-invalid field takes
// its default and is reported; a failed READ is reported separately so callers
// FAIL CLOSED (an admin's tighter value must never turn into a looser default
// because Firestore blinked). Later parts of umbrella #211 add their own
// fields to the same doc (kill switch, daily caps); unknown fields here are
// ignored, so they never disturb this part.
//
// What lives here, and why not in the code:
//   supportedLanguages   sources may only be registered in these languages.
//                        Default ["en"]: no non-English rulebook may publish
//                        automatically before the language work (P5) ships.
//   previewsPerHour      address checks one admin may make per hour.
//   registrationsPerHour route registrations one admin may make per hour.
//   previewMaxAgeMinutes how long a confirmation may rely on its address check.
//   maxGuidancePerRoute  rule/guidance pages one registration may carry (each is fetched).

/** The `appConfig` doc id. */
export const ROUTE_ONBOARDING_SETTINGS_DOC_ID = "routeOnboardingSettings";

/** Resolved settings: every field filled in. */
export interface RegistrySettings {
  supportedLanguages: string[];
  previewsPerHour: number;
  registrationsPerHour: number;
  previewMaxAgeMinutes: number;
  maxGuidancePerRoute: number;
}

/** Defaults; the issue's numbers (20 checks, 30 registrations per admin per hour). */
export const DEFAULT_REGISTRY_SETTINGS: Readonly<RegistrySettings> = Object.freeze({
  supportedLanguages: ["en"],
  previewsPerHour: 20,
  registrationsPerHour: 30,
  previewMaxAgeMinutes: 60,
  maxGuidancePerRoute: 10,
});

/** Allowed range of each numeric setting. */
const RANGES: Record<Exclude<keyof RegistrySettings, "supportedLanguages">, [number, number]> = {
  previewsPerHour: [1, 1_000],
  registrationsPerHour: [1, 1_000],
  previewMaxAgeMinutes: [1, 24 * 60],
  maxGuidancePerRoute: [1, 50],
};

/** A language code as stored: 2-3 lowercase letters, optional region/script part. */
export const LANGUAGE_CODE_RE = /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/;

/**
 * Merge a stored doc over the defaults (pure). Invalid fields fall back to the
 * default and are listed in `problems`. An EMPTY or malformed language list
 * falls back to the default list, never to "everything".
 */
export function resolveRegistrySettings(raw: unknown): { settings: RegistrySettings; problems: string[] } {
  const doc = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const settings: RegistrySettings = { ...DEFAULT_REGISTRY_SETTINGS, supportedLanguages: [...DEFAULT_REGISTRY_SETTINGS.supportedLanguages] };
  const problems: string[] = [];
  const langs = doc.supportedLanguages;
  if (langs !== undefined) {
    if (Array.isArray(langs) && langs.length > 0 && langs.length <= 50 && langs.every((l) => typeof l === "string" && LANGUAGE_CODE_RE.test(l))) {
      settings.supportedLanguages = [...new Set(langs as string[])];
    } else {
      problems.push("supportedLanguages: must be a non-empty list of language codes, using default");
    }
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
export interface LoadedRegistrySettings {
  settings: RegistrySettings;
  // Set when the READ failed (a missing doc is normal and means defaults).
  // Callers must refuse to proceed when it is set.
  readError?: string;
}

/** Read and resolve the settings once. Never throws; a failed read sets `readError`. */
export async function loadRegistrySettings(): Promise<LoadedRegistrySettings> {
  try {
    const snap = await collections.appConfig.doc(ROUTE_ONBOARDING_SETTINGS_DOC_ID).get();
    const { settings, problems } = resolveRegistrySettings(snap.exists ? snap.data() : undefined);
    for (const p of problems) console.warn(`Registry settings (appConfig/${ROUTE_ONBOARDING_SETTINGS_DOC_ID}): ${p}`);
    return { settings };
  } catch (err) {
    const readError = `reading appConfig/${ROUTE_ONBOARDING_SETTINGS_DOC_ID} failed: ${(err as Error)?.message ?? String(err)}`;
    console.error(`Registry settings: ${readError}`);
    return { settings: resolveRegistrySettings(undefined).settings, readError };
  }
}
