import { collections } from "../../../utils/firebase";
import type { ScraperSettings, ScraperSettingsDoc } from "./types";

// ============================================
// SCRAPER SETTINGS — runtime read of appConfig/scraperSettings (issue #96)
// ============================================
//
// The ONE module the orchestrators import for their knobs. Kept small (only
// utils/firebase + types) so the visa / news orchestrators do not pull in the
// admin service (alerts, pricing, history) and no import cycle appears.
//
//   loadScraperSettings()   one Firestore read, merged over the defaults.
//                           NEVER throws: an unreadable doc means defaults,
//                           so a Firestore hiccup can't stop (or un-stop) a
//                           tick in a surprising way; it is logged.
//   resolveScraperSettings  the pure merge, field by field: a bad stored
//                           value falls back to its default (and is reported),
//                           the same lenient rule the alert engine uses.
//
// The FIELD RULES table below is shared with the admin PATCH validation
// (scraper-settings.validate.ts), so what the API accepts and what the
// runtime honours can never drift apart.

/** The `appConfig` doc id. */
export const SCRAPER_SETTINGS_DOC_ID = "scraperSettings";

/**
 * Defaults = the code constants in use before #96 (DEFAULT_MAX_SOURCES /
 * DEFAULT_MAX_EXTRACTIONS in visa-catalog-crawl.service.ts, the hard-coded 5
 * news sources), so an empty Firestore behaves exactly as before.
 */
export const DEFAULT_SCRAPER_SETTINGS: ScraperSettings = {
  visa: { enabled: true, blockManualWhenOff: false, maxExtractionsPerRun: 15, maxSourcesPerTick: 3 },
  news: { enabled: true, blockManualWhenOff: false, maxSourcesPerRun: 5 },
  manualRuns: { cooldownMinutes: 10 },
  budget: { hardStop: false },
};

/** How one leaf field is validated: a boolean, or an integer in [min, max]. */
export type FieldRule = { type: "boolean" } | { type: "integer"; min: number; max: number };

/**
 * Every settings leaf stored on appConfig/scraperSettings, by section.
 * Shared by the lenient runtime merge and the strict PATCH validation.
 */
export const SETTINGS_FIELD_RULES: {
  [S in keyof ScraperSettings]: { [K in keyof ScraperSettings[S]]: FieldRule };
} = {
  visa: {
    enabled: { type: "boolean" },
    blockManualWhenOff: { type: "boolean" },
    // At least 1: the run loop stops at the cap, so 0 would crawl nothing.
    // To stop spending, switch the scraper off or use the budget hard stop.
    maxExtractionsPerRun: { type: "integer", min: 1, max: 200 },
    maxSourcesPerTick: { type: "integer", min: 1, max: 50 },
  },
  news: {
    enabled: { type: "boolean" },
    blockManualWhenOff: { type: "boolean" },
    maxSourcesPerRun: { type: "integer", min: 1, max: 50 },
  },
  manualRuns: {
    cooldownMinutes: { type: "integer", min: 0, max: 1440 },
  },
  budget: {
    hardStop: { type: "boolean" },
  },
};

/** True when `v` satisfies `rule`. */
export function fieldValid(rule: FieldRule, v: unknown): boolean {
  if (rule.type === "boolean") return typeof v === "boolean";
  return typeof v === "number" && Number.isInteger(v) && v >= rule.min && v <= rule.max;
}

/** Human description of a rule, for 400 messages ("an integer 1..50"). */
export function describeRule(rule: FieldRule): string {
  return rule.type === "boolean" ? "a boolean" : `an integer ${rule.min}..${rule.max}`;
}

/**
 * Merge a stored doc over the defaults, field by field. A missing field takes
 * its default silently; a present but invalid one takes its default and is
 * reported in `problems` (logged by the loader). Unknown fields are ignored.
 */
export function resolveScraperSettings(raw: unknown): { settings: ScraperSettings; problems: string[] } {
  const problems: string[] = [];
  const doc = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  // Deep copy of the defaults, filled in section by section below.
  const out = JSON.parse(JSON.stringify(DEFAULT_SCRAPER_SETTINGS)) as ScraperSettings;
  for (const section of Object.keys(SETTINGS_FIELD_RULES) as (keyof ScraperSettings)[]) {
    const stored = doc[section];
    if (stored === undefined) continue;
    if (!stored || typeof stored !== "object") {
      problems.push(`${section}: not an object, using defaults`);
      continue;
    }
    const rules = SETTINGS_FIELD_RULES[section] as Record<string, FieldRule>;
    for (const [key, rule] of Object.entries(rules)) {
      const v = (stored as Record<string, unknown>)[key];
      if (v === undefined) continue;
      if (fieldValid(rule, v)) (out[section] as unknown as Record<string, unknown>)[key] = v;
      else problems.push(`${section}.${key}: invalid value ${JSON.stringify(v)}, using default`);
    }
  }
  return { settings: out, problems };
}

/**
 * Read `appConfig/scraperSettings` once and resolve it. Never throws: on a
 * read error the defaults are returned (logged). Called once at the start of
 * every scheduled tick and every manual run.
 */
export async function loadScraperSettings(): Promise<ScraperSettings> {
  try {
    const snap = await collections.appConfig.doc(SCRAPER_SETTINGS_DOC_ID).get();
    const { settings, problems } = resolveScraperSettings(snap.exists ? (snap.data() as ScraperSettingsDoc) : undefined);
    for (const p of problems) console.warn(`Scraper settings (appConfig/${SCRAPER_SETTINGS_DOC_ID}): ${p}`);
    return settings;
  } catch (err) {
    console.error(
      `Scraper settings: reading appConfig/${SCRAPER_SETTINGS_DOC_ID} failed, using defaults: ` +
        `${(err as Error)?.message ?? String(err)}`
    );
    return JSON.parse(JSON.stringify(DEFAULT_SCRAPER_SETTINGS)) as ScraperSettings;
  }
}
