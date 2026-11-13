import type { HtmlSelectors, IngestionStrategy, SupportedCountryCode } from "../../types/news";

// ============================================
// NEWS SOURCE CONFIG — the editable slice (issue #17)
// ============================================
//
// Dependency-free (types only): read by the health rows, the edit
// transaction and the validation module. Kept apart from
// news-source-config.validate.ts so loading it never pulls in the settings
// validation / alert modules (that import chain created a load cycle with
// the run service).

/** The editable slice of a stored news source (what the edit form shows). */
export interface NewsEditableConfig {
  strategy: IngestionStrategy;
  scrapeIntervalMinutes: number;
  priority: number;
  countryCodes: SupportedCountryCode[];
  feedUrl?: string; // rss only
  selectors?: Partial<HtmlSelectors>; // html_scrape only
  maxArticlesPerRun: number;
}

/** Plain object (not null / array). */
function isObj(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

/**
 * The editable slice of a stored `newsSources` doc (pure; tolerant of old
 * docs). Used by the health row (`newsConfig`) and by the edit transaction.
 * Never includes `customHeaders` or `apiConfig`.
 */
export function newsEditableConfigOf(doc: Record<string, unknown>): NewsEditableConfig {
  const config = isObj(doc.config) ? doc.config : {};
  const out: NewsEditableConfig = {
    strategy: doc.strategy as IngestionStrategy,
    scrapeIntervalMinutes: typeof doc.scrapeIntervalMinutes === "number" ? doc.scrapeIntervalMinutes : 0,
    priority: typeof doc.priority === "number" ? doc.priority : 0,
    countryCodes: Array.isArray(doc.countryCodes) ? ([...doc.countryCodes] as SupportedCountryCode[]) : [],
    maxArticlesPerRun: typeof config.maxArticlesPerRun === "number" ? config.maxArticlesPerRun : 0,
  };
  if (typeof config.feedUrl === "string") out.feedUrl = config.feedUrl;
  if (isObj(config.selectors)) out.selectors = { ...(config.selectors as Partial<HtmlSelectors>) };
  return out;
}
