import type { CrawlWindow } from "../../visa-catalog/types";
import type { ScraperSettingsKind } from "../runs/types";
import { assertValidCrawlWindow } from "../etiquette/visa-crawl-window";
import { isValidPricingDoc } from "../cost/scrape-cost.service";
import type { LlmPricingDoc } from "../cost/types";
import { DEFAULT_CONFIG, DEFAULT_THRESHOLDS, resolveConfig } from "../alerts/scrape-alert-rules";
import { SCRAPE_ALERT_RULES, type ScrapeAlertRule } from "../alerts/types";
import { SETTINGS_FIELD_RULES, describeRule, fieldValid, type FieldRule } from "./scraper-settings.store";
import { NEWS_EDIT_KEYS, parseNewsConfigEdit, type NewsConfigEdit } from "../../news/news-source-config.validate";
import { ADMIN_SOURCE_STATUSES, type AdminSourceStatus, type ScraperSettings, type SettingsChange } from "./types";

// ============================================
// SCRAPER SETTINGS — request validation + diff (issue #96)
// ============================================
//
// Pure (no Firestore): parses the admin PATCH bodies into typed patches and
// throws SettingsValidationError naming the FIRST bad field (dotted path),
// which the controller turns into `400 { error: "VALIDATION_ERROR", field }`.
// Strict on purpose: an unknown key is a 400 (a typo must not be silently
// dropped and reported as saved).
//
// The alert section reuses the engine's own resolveConfig (scrape-alert-rules.ts):
// the patch is merged over the stored doc and every value resolveConfig would
// fall back on is rejected, so the API never stores what the engine ignores.

/** A 400 naming the offending field. */
export class SettingsValidationError extends Error {
  constructor(
    /** Dotted path of the first bad field, e.g. "visa.maxExtractionsPerRun". */
    readonly field: string,
    message: string
  ) {
    super(message);
  }
}

/** Plain object (not null / array). */
function isObj(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

/** Throw for any key of `obj` not in `allowed` (prefix = the object's own path). */
function rejectUnknownKeys(obj: Record<string, unknown>, allowed: readonly string[], prefix: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      const path = prefix ? `${prefix}.${key}` : key;
      throw new SettingsValidationError(path, `${path} is not a known setting`);
    }
  }
}

// ============================================
// PATCH /admin/scraper-settings
// ============================================

/** Largest monthly budget accepted (a typo guard, not a policy). */
export const MAX_MONTHLY_BUDGET_USD = 100_000;

/** The alert-config keys an admin may patch (top level, email, rule entries). */
const ALERT_KEYS = ["enabled", "recipientUserIds", "extraRecipientEmails", "email", "thresholds", "rules"] as const;
const ALERT_RULE_KEYS = ["enabled", "severity"] as const;
// The email / threshold keys come from the engine's defaults. Read inside
// functions, never at module load: scrapers/index.ts sits on an import cycle
// (see its header), so no top-level use of an imported binding here.
const alertEmailKeys = (): string[] => Object.keys(DEFAULT_CONFIG.email);
const alertThresholdKeys = (): string[] => Object.keys(DEFAULT_THRESHOLDS);

/** A parsed, shape-checked settings PATCH. Absent = not changed. */
export interface ParsedSettingsPatch {
  // appConfig/scraperSettings leaves, per section (already range-checked).
  settings: { [S in keyof ScraperSettings]?: Partial<ScraperSettings[S]> };
  // appConfig/scrapeBudget.monthlyUsd: a number, null (clear), or absent.
  monthlyUsd?: number | null;
  // Raw alert-config patch (validated against the stored doc by mergeAlerts).
  alerts?: Record<string, unknown>;
  // The new price table (whole-table replacement), already validated.
  pricingTable?: LlmPricingDoc;
}

/**
 * Parse PATCH /admin/scraper-settings. Throws SettingsValidationError on the
 * first bad field. An empty object is valid (no change).
 */
export function parseSettingsPatch(body: unknown): ParsedSettingsPatch {
  if (!isObj(body)) throw new SettingsValidationError("body", "the body must be a JSON object");
  rejectUnknownKeys(body, ["visa", "news", "manualRuns", "budget", "alerts", "pricing"], "");
  const out: ParsedSettingsPatch = { settings: {} };

  // ---- visa / news / manualRuns: leaf rules shared with the runtime ----
  for (const section of ["visa", "news", "manualRuns"] as const) {
    const v = body[section];
    if (v === undefined) continue;
    if (!isObj(v)) throw new SettingsValidationError(section, `${section} must be an object`);
    const rules = SETTINGS_FIELD_RULES[section] as Record<string, FieldRule>;
    rejectUnknownKeys(v, Object.keys(rules), section);
    const parsed: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(v)) {
      if (!fieldValid(rules[key], value)) {
        throw new SettingsValidationError(`${section}.${key}`, `${section}.${key} must be ${describeRule(rules[key])}`);
      }
      parsed[key] = value;
    }
    (out.settings as Record<string, unknown>)[section] = parsed;
  }

  // ---- budget: hardStop -> scraperSettings, monthlyUsd -> scrapeBudget ----
  if (body.budget !== undefined) {
    const b = body.budget;
    if (!isObj(b)) throw new SettingsValidationError("budget", "budget must be an object");
    rejectUnknownKeys(b, ["monthlyUsd", "hardStop"], "budget");
    if (b.hardStop !== undefined) {
      if (!fieldValid(SETTINGS_FIELD_RULES.budget.hardStop, b.hardStop)) {
        throw new SettingsValidationError("budget.hardStop", "budget.hardStop must be a boolean");
      }
      out.settings.budget = { hardStop: b.hardStop as boolean };
    }
    if (b.monthlyUsd !== undefined) {
      const m = b.monthlyUsd;
      if (m !== null && !(typeof m === "number" && Number.isFinite(m) && m >= 0 && m <= MAX_MONTHLY_BUDGET_USD)) {
        throw new SettingsValidationError(
          "budget.monthlyUsd",
          `budget.monthlyUsd must be null (no budget) or a number 0..${MAX_MONTHLY_BUDGET_USD}`
        );
      }
      out.monthlyUsd = m as number | null;
    }
  }

  // ---- alerts: shape + known keys here; values via resolveConfig later ----
  if (body.alerts !== undefined) {
    const a = body.alerts;
    if (!isObj(a)) throw new SettingsValidationError("alerts", "alerts must be an object");
    rejectUnknownKeys(a, ALERT_KEYS, "alerts");
    if (a.email !== undefined) {
      if (!isObj(a.email)) throw new SettingsValidationError("alerts.email", "alerts.email must be an object");
      rejectUnknownKeys(a.email, alertEmailKeys(), "alerts.email");
    }
    if (a.thresholds !== undefined) {
      if (!isObj(a.thresholds)) throw new SettingsValidationError("alerts.thresholds", "alerts.thresholds must be an object");
      rejectUnknownKeys(a.thresholds, alertThresholdKeys(), "alerts.thresholds");
    }
    if (a.rules !== undefined) {
      if (!isObj(a.rules)) throw new SettingsValidationError("alerts.rules", "alerts.rules must be an object");
      for (const [rule, entry] of Object.entries(a.rules)) {
        const path = `alerts.rules.${rule}`;
        if (!SCRAPE_ALERT_RULES.includes(rule as ScrapeAlertRule)) {
          throw new SettingsValidationError(path, `${rule} is not a known alert rule (${SCRAPE_ALERT_RULES.join(", ")})`);
        }
        // null = drop the override (back to the rule's defaults).
        if (entry === null) continue;
        if (!isObj(entry)) throw new SettingsValidationError(path, `${path} must be an object or null`);
        rejectUnknownKeys(entry, ALERT_RULE_KEYS, path);
      }
    }
    out.alerts = a;
  }

  // ---- pricing: whole-table replacement, isValidPricingDoc + metadata ----
  if (body.pricing !== undefined) {
    const p = body.pricing;
    if (!isObj(p)) throw new SettingsValidationError("pricing", "pricing must be an object");
    rejectUnknownKeys(p, ["table"], "pricing");
    if (p.table !== undefined) {
      const t = p.table;
      // Review: shape first, so an extra key or a reserved Firestore name
      // is a 400 naming the field (never stored, never a 500).
      if (isObj(t)) assertPricingShape(t);
      if (!isObj(t) || !isValidPricingDoc(t)) {
        throw new SettingsValidationError(
          "pricing.table",
          "pricing.table is not a valid price table: every model needs finite non-negative inputPer1M / " +
            "cachedInputPer1M / outputPer1M, a sourceUrl and an effectiveFrom (see isValidPricingDoc)"
        );
      }
      if (t.currency !== undefined && t.currency !== "USD") {
        throw new SettingsValidationError("pricing.table.currency", "pricing.table.currency must be USD");
      }
      if (typeof t.verifiedAt !== "string" || t.verifiedAt.trim() === "") {
        throw new SettingsValidationError("pricing.table.verifiedAt", "pricing.table.verifiedAt must be a non-empty string");
      }
      // Drop any client-sent updatedAt: the service stamps its own.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { updatedAt: _ignored, ...rest } = t as Record<string, unknown>;
      out.pricingTable = { ...(rest as unknown as LlmPricingDoc), currency: "USD" };
    }
  }
  return out;
}

// ---- Price table shape (review item 5) ----

/** Keys allowed at each level of a price table (LlmPricingDoc). */
const PRICING_TABLE_KEYS = ["currency", "models", "requestPricing", "verifiedAt", "updatedAt"];
const PRICING_MODEL_KEYS = [
  "inputPer1M",
  "cachedInputPer1M",
  "outputPer1M",
  "aliases",
  "offPeak",
  "peakWindowsUtc",
  "effectiveFrom",
  "sourceUrl",
  "note",
];
const PRICING_RATE_KEYS = ["inputPer1M", "cachedInputPer1M", "outputPer1M"];
const PRICING_WINDOW_KEYS = ["startHour", "endHour", "isoWeekdays"];
const PRICING_REQUEST_KEYS = ["perRequestUsd", "effectiveFrom", "sourceUrl", "note"];

/**
 * A model / provider name usable as a Firestore map key: 1..100 chars of
 * letters, digits and `. _ : / -`, and not a reserved `__name__` form
 * (Firestore rejects field names matching `__.*__`).
 */
const MAP_KEY_RE = /^[A-Za-z0-9._:/-]{1,100}$/;
function assertMapKey(key: string, path: string): void {
  if (!MAP_KEY_RE.test(key) || /^__.*__$/.test(key)) {
    throw new SettingsValidationError(
      path,
      `${path}: "${key}" is not a valid name (1-100 letters, digits, . _ : / -; not __reserved__)`
    );
  }
}

/**
 * Strict key check of a price table (pure). Throws SettingsValidationError
 * naming the first unknown key or bad model / provider name. Value checks
 * are isValidPricingDoc's job (called right after).
 */
export function assertPricingShape(t: Record<string, unknown>): void {
  const base = "pricing.table";
  rejectUnknownKeys(t, PRICING_TABLE_KEYS, base);
  if (isObj(t.models)) {
    for (const [name, m] of Object.entries(t.models)) {
      const mp = `${base}.models.${name}`;
      assertMapKey(name, `${base}.models`);
      if (!isObj(m)) continue; // isValidPricingDoc reports it
      rejectUnknownKeys(m, PRICING_MODEL_KEYS, mp);
      if (isObj(m.offPeak)) rejectUnknownKeys(m.offPeak, PRICING_RATE_KEYS, `${mp}.offPeak`);
      if (Array.isArray(m.peakWindowsUtc)) {
        m.peakWindowsUtc.forEach((w, i) => {
          if (isObj(w)) rejectUnknownKeys(w, PRICING_WINDOW_KEYS, `${mp}.peakWindowsUtc.${i}`);
        });
      }
    }
  }
  if (isObj(t.requestPricing)) {
    for (const [provider, r] of Object.entries(t.requestPricing)) {
      assertMapKey(provider, `${base}.requestPricing`);
      if (isObj(r)) rejectUnknownKeys(r, PRICING_REQUEST_KEYS, `${base}.requestPricing.${provider}`);
    }
  }
}

/**
 * Merge an alert-config patch over the stored raw doc: objects key by key
 * (`email`, `thresholds`, each `rules.<id>`), arrays and scalars replace,
 * `rules.<id>: null` and `rules.<id>.<field>: null` drop that override.
 * Pure: returns a new object.
 */
export function mergeAlertsPatch(stored: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = JSON.parse(JSON.stringify(stripMeta(stored)));
  for (const [key, value] of Object.entries(patch)) {
    if (key === "email" || key === "thresholds") {
      out[key] = { ...(isObj(out[key]) ? (out[key] as object) : {}), ...(value as object) };
    } else if (key === "rules") {
      const rules: Record<string, unknown> = isObj(out.rules) ? { ...(out.rules as object) } : {};
      for (const [rule, entry] of Object.entries(value as Record<string, unknown>)) {
        if (entry === null) {
          delete rules[rule];
          continue;
        }
        const merged: Record<string, unknown> = { ...(isObj(rules[rule]) ? (rules[rule] as object) : {}) };
        for (const [f, fv] of Object.entries(entry as Record<string, unknown>)) {
          if (fv === null) delete merged[f];
          else merged[f] = fv;
        }
        if (Object.keys(merged).length === 0) delete rules[rule];
        else rules[rule] = merged;
      }
      out.rules = rules;
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Validate a merged alert config with the engine's resolveConfig. Any value
 * the engine would fall back on is rejected — except problems the STORED doc
 * already had (hand edits from before #96), so an old typo elsewhere does
 * not block an unrelated change. Throws SettingsValidationError (field
 * "alerts.<path>").
 */
export function assertValidAlerts(stored: Record<string, unknown>, merged: Record<string, unknown>): void {
  const before = new Set(resolveConfig(stored).problems);
  for (const problem of resolveConfig(merged).problems) {
    if (before.has(problem)) continue;
    // resolveConfig problems read "<path>: <what>" (e.g. "thresholds.errorRatePct: invalid value 300, using default").
    const path = problem.split(":")[0].trim();
    throw new SettingsValidationError(`alerts.${path}`, `alerts.${problem.replace(", using default", "").replace(", ignored", "")}`);
  }
}

/** The stored doc without our audit fields (updatedAt / updatedBy). */
export function stripMeta(doc: Record<string, unknown> | undefined): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { updatedAt: _a, updatedBy: _b, ...rest } = doc ?? {};
  return rest;
}

// ============================================
// PATCH /admin/scrape-sources/:kind/:id
// ============================================

/** Longest admin reason stored on a source. */
export const MAX_REASON_CHARS = 500;

/** A parsed per-source PATCH. Absent = not changed. */
export interface ParsedSourcePatch {
  status?: AdminSourceStatus;
  reason?: string; // trimmed; only with `status`
  crawlWindow?: CrawlWindow | null; // visa only; null = back to the registry window
  resetFailures?: boolean;
  clearHostBackoffs?: boolean; // visa only
  // Issue #17 (news only): the parsed config edit (interval, priority,
  // countries, config.*). Strategy-dependent rules run later, inside the
  // update transaction, against the stored source.
  newsEdit?: NewsConfigEdit;
}

/** Parse a per-source PATCH. Throws SettingsValidationError on the first bad field. */
export function parseSourcePatch(kind: ScraperSettingsKind, body: unknown): ParsedSourcePatch {
  if (!isObj(body)) throw new SettingsValidationError("body", "the body must be a JSON object");
  // Issue #17: news sources additionally take the config keys (and a sent
  // `strategy` gets its own "cannot be changed" 400 from the news module).
  const sourceKeys = ["status", "reason", "crawlWindow", "resetFailures", "clearHostBackoffs"];
  if (kind === "news" && "strategy" in body) throw new SettingsValidationError("strategy", "strategy cannot be changed");
  rejectUnknownKeys(body, kind === "news" ? [...sourceKeys, ...NEWS_EDIT_KEYS] : sourceKeys, "");
  if (Object.keys(body).length === 0) throw new SettingsValidationError("body", "nothing to change");
  const out: ParsedSourcePatch = {};

  // ---- status + reason ----
  if (body.status !== undefined) {
    if (!ADMIN_SOURCE_STATUSES.includes(body.status as AdminSourceStatus)) {
      throw new SettingsValidationError("status", `status must be one of: ${ADMIN_SOURCE_STATUSES.join(", ")}`);
    }
    out.status = body.status as AdminSourceStatus;
  }
  if (body.reason !== undefined) {
    if (typeof body.reason !== "string" || body.reason.trim().length > MAX_REASON_CHARS) {
      throw new SettingsValidationError("reason", `reason must be a string of at most ${MAX_REASON_CHARS} characters`);
    }
    if (out.status === undefined) throw new SettingsValidationError("reason", "reason is set together with status");
    out.reason = body.reason.trim();
  }
  if ((out.status === "paused" || out.status === "retired") && !out.reason) {
    throw new SettingsValidationError("reason", `a reason is required to set status ${out.status}`);
  }

  // ---- crawl window (visa only) ----
  if (body.crawlWindow !== undefined) {
    if (kind !== "visa") throw new SettingsValidationError("crawlWindow", "news sources have no crawl window");
    if (body.crawlWindow === null) {
      out.crawlWindow = null;
    } else {
      const w = body.crawlWindow;
      if (!isObj(w)) throw new SettingsValidationError("crawlWindow", "crawlWindow must be an object or null");
      rejectUnknownKeys(w, ["timeZone", "dayOfWeek", "startHour", "endHour"], "crawlWindow");
      const window = { timeZone: w.timeZone, dayOfWeek: w.dayOfWeek, startHour: w.startHour, endHour: w.endHour } as CrawlWindow;
      try {
        assertValidCrawlWindow(window);
      } catch (err) {
        throw new SettingsValidationError("crawlWindow", (err as Error).message);
      }
      out.crawlWindow = window;
    }
  }

  // ---- news config edit (issue #17): delegated to the pure news module ----
  if (kind === "news" && NEWS_EDIT_KEYS.some((k) => body[k] !== undefined)) {
    out.newsEdit = parseNewsConfigEdit(body).edit;
  }

  // ---- one-shot actions: true does it, false is a no-op ----
  for (const key of ["resetFailures", "clearHostBackoffs"] as const) {
    const v = body[key];
    if (v === undefined) continue;
    if (typeof v !== "boolean") throw new SettingsValidationError(key, `${key} must be a boolean`);
    if (key === "clearHostBackoffs" && v && kind !== "visa") {
      throw new SettingsValidationError(key, "news sources store no host backoffs");
    }
    if (v) out[key] = true;
  }
  return out;
}

// ============================================
// DIFF (audit history)
// ============================================

/**
 * Flatten an object into dotted leaf paths. Arrays and non-plain objects
 * (Timestamps) are leaves. Pure.
 */
export function flatten(value: unknown, prefix: string, out: Map<string, unknown> = new Map()): Map<string, unknown> {
  if (isObj(value) && Object.getPrototypeOf(value) === Object.prototype) {
    const entries = Object.entries(value);
    if (entries.length === 0 && prefix) out.set(prefix, {});
    for (const [k, v] of entries) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  } else if (prefix) {
    out.set(prefix, value === undefined ? null : value);
  }
  return out;
}

/** Comparable form of a leaf (JSON; Timestamps as millis). */
function leafKey(v: unknown): string {
  if (v && typeof (v as { toMillis?: unknown }).toMillis === "function") return `ts:${(v as { toMillis(): number }).toMillis()}`;
  return JSON.stringify(v ?? null);
}

/**
 * Field diff of two values under `prefix`: one entry per leaf path whose
 * value changed, appeared (before null) or disappeared (after null). Sorted
 * by path for a stable history entry.
 */
export function diffValues(before: unknown, after: unknown, prefix: string): SettingsChange[] {
  const a = flatten(before, prefix);
  const b = flatten(after, prefix);
  const paths = [...new Set([...a.keys(), ...b.keys()])].sort();
  const out: SettingsChange[] = [];
  for (const path of paths) {
    const x = a.has(path) ? a.get(path) : null;
    const y = b.has(path) ? b.get(path) : null;
    if (leafKey(x) !== leafKey(y)) out.push({ path, before: x ?? null, after: y ?? null });
  }
  return out;
}
