import { FieldValue, Timestamp, type Transaction } from "firebase-admin/firestore";
import { collections, db } from "../../../utils/firebase";
import { toJson } from "../runs/scrape-run.service";
import type { ScraperSettingsKind } from "../runs/types";
import {
  LLM_PRICING_DOC_ID,
  SCRAPE_BUDGET_DOC_ID,
  isValidPricingDoc,
  scrapeCostService,
} from "../cost/scrape-cost.service";
import { DEFAULT_LLM_PRICING, monthKeyUtc } from "../cost/scrape-cost-pricing";
import type { LlmPricingDoc, PricingOrigin } from "../cost/types";
import { DEFAULT_SEVERITY, resolveConfig } from "../alerts/scrape-alert-rules";
import { SCRAPE_ALERTS_CONFIG_DOC } from "../alerts/scrape-alert.service";
import { SCRAPE_ALERT_RULES, type ScrapeAlertsConfig, type ScrapeAlertSeverity } from "../alerts/types";
import { nextWindowOpening } from "../etiquette/visa-crawl-window";
import { VISA_SOURCE_WINDOWS } from "../../visa-catalog/data/seed-visa-sources";
import type { CrawlWindow } from "../../visa-catalog/types";
import { newsEditableConfigOf, type NewsEditableConfig } from "../../news/news-source-config.shape";
import { applyNewsConfigEdit } from "../../news/news-source-config.validate";
import { SCRAPER_SETTINGS_DOC_ID, resolveScraperSettings } from "./scraper-settings.store";
import {
  assertValidAlerts,
  diffValues,
  mergeAlertsPatch,
  stripMeta,
  type ParsedSettingsPatch,
  type ParsedSourcePatch,
} from "./scraper-settings.validate";
import type { ScraperSettings, SettingsChange, SettingsHistoryDoc } from "./types";
import type { DocumentData, UpdateData } from "firebase-admin/firestore";
// Transaction.update() wants UpdateData<DocumentData>; the field maps built here are
// Record<string, unknown> (dotted paths + FieldValue sentinels), which tsc rejects.
type FsUpdate = UpdateData<DocumentData>;

// ============================================
// SCRAPER SETTINGS — admin view + edits (issue #96)
// ============================================
//
// Fronts the four config docs the scrapers read, without moving any of them
// (so the engines keep working unchanged):
//
//   appConfig/scraperSettings   switches, limits, hard stop, manual cooldown (new)
//   appConfig/scrapeBudget      monthlyUsd (#82)
//   appConfig/scrapeAlerts      alert config (#83)
//   appConfig/llmPricing        LLM price table (#82)
//
// Every edit runs in ONE transaction: read the docs it touches, compute the
// new docs + a field diff, write only the docs that changed (each stamped
// updatedAt / updatedBy) and one `scraperSettingsHistory` entry. A PATCH that
// changes nothing writes nothing. Per-source edits (status, window, failure
// reset, backoff clear) follow the same pattern on the source doc.
//
// Contract: scraper-settings.md (next to this file).

/** History list page sizes (GET /admin/scraper-settings/history). */
export const SETTINGS_HISTORY_DEFAULT_LIMIT = 25;
export const SETTINGS_HISTORY_MAX_LIMIT = 100;

/** Thrown for a history cursor that names no entry (-> 400 INVALID_CURSOR). */
export class InvalidHistoryCursorError extends Error {
  constructor() {
    super("cursor does not match a history entry");
  }
}

/** Thrown when the source of a per-source edit does not exist (-> 404). */
export class SourceNotFoundError extends Error {
  constructor(kind: ScraperSettingsKind, id: string) {
    super(`${kind} source ${id} not found`);
  }
}

/** The GET /admin/scraper-settings body (see scraper-settings.md §1). */
export interface ScraperSettingsView extends Omit<ScraperSettings, "budget"> {
  budget: {
    monthlyUsd: number | null;
    hardStop: boolean;
    month: string;
    monthToDateUsd: number;
    hardStopActive: boolean;
  };
  alerts: ScrapeAlertsConfig & { ruleDefaults: { rule: string; defaultSeverity: ScrapeAlertSeverity }[] };
  pricing: { origin: PricingOrigin; table: Record<string, unknown> };
  updatedAt: string | null;
  updatedBy: string | null;
}

/** Raw data of a doc snapshot, or {} when absent. */
function dataOf(snap: { exists: boolean; data(): unknown }): Record<string, unknown> {
  return snap.exists ? ((snap.data() as Record<string, unknown>) ?? {}) : {};
}

/** A stored budget amount, or null (absent / not a finite number >= 0). */
function budgetOf(raw: Record<string, unknown>): number | null {
  const v = raw.monthlyUsd;
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

/** The price table in force: the stored one when valid, else the default. */
function pricingOf(raw: Record<string, unknown>, exists: boolean): { origin: PricingOrigin; table: LlmPricingDoc } {
  if (exists && isValidPricingDoc(raw)) return { origin: "config", table: stripMeta(raw) as unknown as LlmPricingDoc };
  return { origin: "default", table: DEFAULT_LLM_PRICING };
}

/** ISO string of a stored Timestamp, else null. */
function isoOf(v: unknown): string | null {
  return v && typeof (v as { toMillis?: unknown }).toMillis === "function"
    ? new Date((v as { toMillis(): number }).toMillis()).toISOString()
    : null;
}

export class ScraperSettingsService {
  /** Transaction runner. Swapped for the in-memory one in tests. */
  runTransaction: <T>(fn: (tx: Transaction) => Promise<T>) => Promise<T> = (fn) => db.runTransaction(fn);

  /** Clock (ms). Swappable in tests. */
  clock: () => number = Date.now;

  /** The four config doc refs (resolved per call: tests swap collections). */
  private refs() {
    return {
      settings: collections.appConfig.doc(SCRAPER_SETTINGS_DOC_ID),
      budget: collections.appConfig.doc(SCRAPE_BUDGET_DOC_ID),
      alerts: collections.appConfig.doc(SCRAPE_ALERTS_CONFIG_DOC),
      pricing: collections.appConfig.doc(LLM_PRICING_DOC_ID),
    };
  }

  // ---------- GET ----------

  /**
   * Everything the settings page shows, defaults filled in. Reads the four
   * config docs + the current month's cost rollup. Never writes (unlike the
   * alert engine's loadConfig, which seeds its defaults).
   */
  async getView(nowMs: number = this.clock()): Promise<ScraperSettingsView> {
    const r = this.refs();
    const [settingsSnap, budgetSnap, alertsSnap, pricingSnap] = await Promise.all([
      r.settings.get(),
      r.budget.get(),
      r.alerts.get(),
      r.pricing.get(),
    ]);
    // Month-to-date spend (the rollup). A read failure shows 0 rather than
    // failing the whole page; the budget fields still come from config.
    let monthToDateUsd = 0;
    try {
      monthToDateUsd = (await scrapeCostService.monthToDate(nowMs)).costUsd;
    } catch (err) {
      console.error(`Scraper settings: month-to-date cost unreadable: ${(err as Error)?.message ?? err}`);
    }
    return this.buildView(
      {
        settings: dataOf(settingsSnap),
        budget: dataOf(budgetSnap),
        alerts: dataOf(alertsSnap),
        pricing: dataOf(pricingSnap),
        pricingExists: pricingSnap.exists,
      },
      monthToDateUsd,
      nowMs
    );
  }

  /** Assemble the view from raw docs (pure, shared by GET and PATCH). */
  private buildView(
    raw: {
      settings: Record<string, unknown>;
      budget: Record<string, unknown>;
      alerts: Record<string, unknown>;
      pricing: Record<string, unknown>;
      pricingExists: boolean;
    },
    monthToDateUsd: number,
    nowMs: number
  ): ScraperSettingsView {
    const { settings } = resolveScraperSettings(raw.settings);
    const monthlyUsd = budgetOf(raw.budget);
    const pricing = pricingOf(raw.pricing, raw.pricingExists);
    return {
      visa: settings.visa,
      news: settings.news,
      manualRuns: settings.manualRuns,
      budget: {
        monthlyUsd,
        hardStop: settings.budget.hardStop,
        month: monthKeyUtc(nowMs),
        monthToDateUsd,
        hardStopActive: settings.budget.hardStop && monthlyUsd !== null && monthToDateUsd >= monthlyUsd,
      },
      alerts: {
        ...resolveConfig(raw.alerts).config,
        ruleDefaults: SCRAPE_ALERT_RULES.map((rule) => ({ rule, defaultSeverity: DEFAULT_SEVERITY[rule] })),
      },
      pricing: { origin: pricing.origin, table: toJson(pricing.table) as Record<string, unknown> },
      updatedAt: isoOf(raw.settings.updatedAt),
      updatedBy: typeof raw.settings.updatedBy === "string" ? raw.settings.updatedBy : null,
    };
  }

  // ---------- PATCH ----------

  /**
   * Apply a parsed PATCH (parseSettingsPatch). One transaction: reads the
   * touched docs, validates the merged alert config against the engine's
   * rules (throws SettingsValidationError -> nothing written), writes only
   * the docs that changed + one history entry. Returns the new view and the
   * changes (empty = nothing was written).
   */
  async applyPatch(
    patch: ParsedSettingsPatch,
    uid: string,
    nowMs: number = this.clock()
  ): Promise<{ view: ScraperSettingsView; changes: SettingsChange[] }> {
    const r = this.refs();
    const at = Timestamp.fromMillis(nowMs);
    const result = await this.runTransaction(async (tx) => {
      // ---- Reads (all before any write, as Firestore requires) ----
      const [settingsSnap, budgetSnap, alertsSnap, pricingSnap] = await Promise.all([
        tx.get(r.settings),
        tx.get(r.budget),
        tx.get(r.alerts),
        tx.get(r.pricing),
      ]);
      const raw = {
        settings: dataOf(settingsSnap),
        budget: dataOf(budgetSnap),
        alerts: dataOf(alertsSnap),
        pricing: dataOf(pricingSnap),
        pricingExists: pricingSnap.exists,
      };
      const next = { ...raw };
      const changes: SettingsChange[] = [];

      // ---- appConfig/scraperSettings: merge the leaves section by section ----
      const sections = Object.entries(patch.settings).filter(([, v]) => v && Object.keys(v).length > 0);
      if (sections.length > 0) {
        const merged: Record<string, unknown> = JSON.parse(JSON.stringify(stripMeta(raw.settings)));
        for (const [section, leaves] of sections) {
          merged[section] = { ...(merged[section] && typeof merged[section] === "object" ? (merged[section] as object) : {}), ...leaves };
        }
        // Diff on the EFFECTIVE values (defaults filled in), so setting a
        // field to its default value is not reported as a change.
        const before = resolveScraperSettings(raw.settings).settings;
        const after = resolveScraperSettings(merged).settings;
        const c = diffValues(before, after, "");
        if (c.length > 0) {
          changes.push(...c);
          next.settings = { ...merged, updatedAt: at, updatedBy: uid };
          tx.set(r.settings, next.settings);
        }
      }

      // ---- appConfig/scrapeBudget.monthlyUsd ----
      if (patch.monthlyUsd !== undefined) {
        const before = budgetOf(raw.budget);
        if (before !== patch.monthlyUsd) {
          changes.push({ path: "budget.monthlyUsd", before, after: patch.monthlyUsd });
          next.budget = { ...stripMeta(raw.budget), monthlyUsd: patch.monthlyUsd, updatedAt: at, updatedBy: uid };
          tx.set(r.budget, next.budget);
        }
      }

      // ---- appConfig/scrapeAlerts: merge, validate with the engine rules ----
      if (patch.alerts) {
        const stored = stripMeta(raw.alerts);
        const merged = mergeAlertsPatch(stored, patch.alerts);
        assertValidAlerts(stored, merged); // throws -> transaction writes nothing
        const c = diffValues(resolveConfig(stored).config, resolveConfig(merged).config, "alerts");
        if (c.length > 0) {
          changes.push(...c);
          next.alerts = { ...merged, updatedAt: at, updatedBy: uid };
          tx.set(r.alerts, next.alerts);
        }
      }

      // ---- appConfig/llmPricing: whole-table replacement ----
      if (patch.pricingTable) {
        const before = pricingOf(raw.pricing, raw.pricingExists).table;
        const c = diffValues(toJson(before), toJson(patch.pricingTable), "pricing.table");
        if (c.length > 0 || !raw.pricingExists) {
          changes.push(...c);
          next.pricing = { ...(patch.pricingTable as unknown as Record<string, unknown>), updatedAt: at, updatedBy: uid };
          next.pricingExists = true;
          tx.set(r.pricing, next.pricing);
        }
      }

      // ---- Audit: one history entry for the whole PATCH ----
      if (changes.length > 0) this.writeHistory(tx, { at, by: uid, target: "settings", changes });
      return { next, changes };
    });

    let monthToDateUsd = 0;
    try {
      monthToDateUsd = (await scrapeCostService.monthToDate(nowMs)).costUsd;
    } catch (err) {
      console.error(`Scraper settings: month-to-date cost unreadable: ${(err as Error)?.message ?? err}`);
    }
    return { view: this.buildView(result.next, monthToDateUsd, nowMs), changes: result.changes };
  }

  /** Buffer one `scraperSettingsHistory` doc in `tx`. */
  private writeHistory(tx: Transaction, entry: Omit<SettingsHistoryDoc, "id">): void {
    const ref = collections.scraperSettingsHistory.doc();
    // Firestore rejects `undefined`; the diff already uses null for "absent".
    tx.set(ref, { id: ref.id, ...entry });
  }

  // ---------- History ----------

  /** Newest-first history page (GET /admin/scraper-settings/history). */
  async listHistory(q: { limit: number; cursor?: string }): Promise<{ items: Record<string, unknown>[]; nextCursor: string | null }> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let query: any = collections.scraperSettingsHistory.orderBy("at", "desc");
    if (q.cursor) {
      const cursorSnap = await collections.scraperSettingsHistory.doc(q.cursor).get();
      if (!cursorSnap.exists) throw new InvalidHistoryCursorError();
      query = query.startAfter(cursorSnap);
    }
    // One extra row tells whether another page exists.
    const snap = await query.limit(q.limit + 1).get();
    const docs = snap.docs.slice(0, q.limit);
    return {
      items: docs.map((d: { id: string; data(): unknown }) => ({ ...(toJson(d.data()) as Record<string, unknown>), id: d.id })),
      nextCursor: snap.docs.length > q.limit ? docs[docs.length - 1].id : null,
    };
  }

  // ---------- Per source ----------

  /**
   * Apply a parsed per-source PATCH (parseSourcePatch) in one transaction:
   * the live fields change at once and the admin's choices are recorded in
   * `adminOverrides` (kept by the seeders). Throws SourceNotFoundError.
   *
   *  - status: written to `status` + `adminOverrides.status` / `.reason`
   *    (reason dropped when not given, e.g. back to active);
   *  - crawlWindow (visa): `crawlWindow` + `adminOverrides.crawlWindow`, and
   *    `nextCrawlAt` = the new window's next opening; null removes the
   *    override and restores the registry window (VISA_SOURCE_WINDOWS);
   *  - resetFailures: consecutiveFailures 0, and a source the CRAWLER
   *    paused (`broken`, or `paused` with `autoPaused` for a missing API
   *    key, issue #107) becomes `active` again when the same edit sets no
   *    explicit status;
   *  - issue #107: any edit that ends the crawler's hold (resetFailures, or
   *    an explicit status) clears the auto-pause flags (`autoPaused`,
   *    `autoPausedAt`, `autoPausedReason`, `autoPauseCause`): from then on
   *    the status is the admin's choice;
   *  - clearHostBackoffs (visa): hostBackoffs [].
   */
  async updateSource(
    kind: ScraperSettingsKind,
    id: string,
    patch: ParsedSourcePatch,
    uid: string,
    nowMs: number = this.clock()
  ): Promise<SettingsChange[]> {
    const ref = (kind === "visa" ? collections.visaSources : collections.newsSources).doc(id);
    const at = Timestamp.fromMillis(nowMs);
    return this.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new SourceNotFoundError(kind, id);
      const before = dataOf(snap);
      const overrides = (before.adminOverrides && typeof before.adminOverrides === "object" ? before.adminOverrides : {}) as Record<
        string,
        unknown
      >;

      // `after` mirrors the fields we touch, for the diff; `update` is the write.
      const after: Record<string, unknown> = {
        status: before.status ?? null,
        consecutiveFailures: before.consecutiveFailures ?? 0,
        adminOverrides: { status: overrides.status ?? null, reason: overrides.reason ?? null, crawlWindow: overrides.crawlWindow ?? null },
        crawlWindow: before.crawlWindow ?? null,
        hostBackoffs: Array.isArray(before.hostBackoffs) ? before.hostBackoffs.length : 0,
        // Issue #107: the crawler's auto-pause flag (diffed so the history
        // entry shows a reset ending an auto-pause).
        autoPaused: before.autoPaused === true,
      };
      // ---- Issue #17: news config edit. The strategy rules run HERE, against
      // the stored source read in this transaction (the pure parser could not
      // know the strategy), and may throw SettingsValidationError -> nothing
      // is written. `after` / `beforeView` get the editable slice so the diff
      // (and the history entry) lists each changed field. ----
      let newsNext: NewsEditableConfig | undefined;
      let newsBefore: NewsEditableConfig | undefined;
      if (patch.newsEdit) {
        newsBefore = newsEditableConfigOf(before);
        newsNext = applyNewsConfigEdit(newsBefore, patch.newsEdit);
        Object.assign(after, newsMirror(newsBefore));
      }
      const beforeView = JSON.parse(JSON.stringify(after));
      if (newsNext) Object.assign(after, newsMirror(newsNext));
      const ao = after.adminOverrides as Record<string, unknown>;
      const update: Record<string, unknown> = {};

      // ---- status + reason ----
      if (patch.status !== undefined) {
        update.status = patch.status;
        update["adminOverrides.status"] = patch.status;
        update["adminOverrides.reason"] = patch.reason ? patch.reason : FieldValue.delete();
        after.status = patch.status;
        ao.status = patch.status;
        ao.reason = patch.reason ?? null;
      }

      // ---- crawl window (visa) ----
      if (patch.crawlWindow !== undefined) {
        let window: CrawlWindow | undefined;
        if (patch.crawlWindow === null) {
          update["adminOverrides.crawlWindow"] = FieldValue.delete();
          ao.crawlWindow = null;
          window = VISA_SOURCE_WINDOWS[id];
        } else {
          update["adminOverrides.crawlWindow"] = patch.crawlWindow;
          ao.crawlWindow = patch.crawlWindow;
          window = patch.crawlWindow;
        }
        update.crawlWindow = window ?? FieldValue.delete();
        after.crawlWindow = window ?? null;
        // The old nextCrawlAt belongs to the old grid: move it to the new
        // window's next opening (no window -> keep the legacy schedule).
        if (window) update.nextCrawlAt = Timestamp.fromDate(nextWindowOpening(window, nowMs));
      }

      // ---- one-shot actions ----
      if (patch.resetFailures) {
        update.consecutiveFailures = 0;
        after.consecutiveFailures = 0;
        // Crawler-held: broken (failure limit) or paused by the crawler
        // itself (missing API key). An ADMIN pause (no autoPaused flag) is
        // never lifted by a reset.
        const crawlerHeld = before.status === "broken" || (before.status === "paused" && before.autoPaused === true);
        if (patch.status === undefined && crawlerHeld) {
          update.status = "active";
          after.status = "active";
        }
      }
      // Issue #107: a reset or an explicit status ends the crawler's hold.
      if ((patch.resetFailures || patch.status !== undefined) && before.autoPaused === true) {
        update.autoPaused = false;
        update.autoPausedAt = null;
        update.autoPausedReason = null;
        update.autoPauseCause = null;
        after.autoPaused = false;
      }
      if (patch.clearHostBackoffs) {
        update.hostBackoffs = [];
        after.hostBackoffs = 0;
      }

      const changes = diffValues(beforeView, JSON.parse(JSON.stringify(after)), "");
      if (changes.length === 0) return changes; // nothing to write
      // Issue #17: write only the config leaves that actually changed, to the
      // live fields AND to adminOverrides.config (so a re-seed keeps them).
      if (newsBefore && newsNext) writeNewsConfig(update, newsBefore, newsNext);
      update["adminOverrides.updatedAt"] = at;
      update["adminOverrides.updatedBy"] = uid;
      update.updatedAt = at;
      tx.update(ref, update as FsUpdate);
      this.writeHistory(tx, { at, by: uid, target: `source:${kind}:${id}`, changes });
      return changes;
    });
  }
}

/**
 * Issue #17: the editable news fields as the diff sees them. Paths in the
 * history entry read `scrapeIntervalMinutes`, `config.selectors.articleTitle`...
 */
function newsMirror(c: NewsEditableConfig): Record<string, unknown> {
  return {
    scrapeIntervalMinutes: c.scrapeIntervalMinutes,
    priority: c.priority,
    countryCodes: c.countryCodes,
    config: { feedUrl: c.feedUrl ?? null, selectors: c.selectors ?? {}, maxArticlesPerRun: c.maxArticlesPerRun },
  };
}

/**
 * Issue #17: add to the Firestore `update` the changed news config leaves.
 * Dotted paths so untouched config keys (customHeaders, apiConfig,
 * fetchFullContent, requestTimeoutMs) and unedited selectors are never
 * rewritten. Each changed leaf is also recorded under `adminOverrides.config`.
 */
function writeNewsConfig(update: Record<string, unknown>, before: NewsEditableConfig, next: NewsEditableConfig): void {
  const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
  for (const key of ["scrapeIntervalMinutes", "priority", "countryCodes"] as const) {
    if (same(before[key], next[key])) continue;
    update[key] = next[key];
    update[`adminOverrides.config.${key}`] = next[key];
  }
  if (before.maxArticlesPerRun !== next.maxArticlesPerRun) {
    update["config.maxArticlesPerRun"] = next.maxArticlesPerRun;
    update["adminOverrides.config.maxArticlesPerRun"] = next.maxArticlesPerRun;
  }
  if (before.feedUrl !== next.feedUrl && next.feedUrl !== undefined) {
    update["config.feedUrl"] = next.feedUrl;
    update["adminOverrides.config.feedUrl"] = next.feedUrl;
  }
  for (const [key, value] of Object.entries(next.selectors ?? {})) {
    if ((before.selectors as Record<string, string> | undefined)?.[key] === value) continue;
    update[`config.selectors.${key}`] = value;
    update[`adminOverrides.config.selectors.${key}`] = value;
  }
}

export const scraperSettingsService = new ScraperSettingsService();
