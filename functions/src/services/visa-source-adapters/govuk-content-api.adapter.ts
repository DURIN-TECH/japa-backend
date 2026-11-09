import type { VisaSourcePage } from "../../types/visa-catalog";
import { htmlFragmentToText, type VisaCatalogFetchService } from "../visa-catalog-fetch.service";
import { capText, effectiveSectionPatterns, formatSections, selectSections } from "./sections";
import type { SourceAdapter, SourceDocument, SourceSection } from "./types";

// ============================================
// SOURCE ADAPTER — govuk-content-api (GB)
// ============================================
//
// GOV.UK publishes every page as JSON at `https://www.gov.uk/api/content<path>`:
// public, no key, CDN-cached (max-age=300) and not disallowed by robots.txt.
// Visa pages are `schema_name: "guide"` with `details.parts[]`, each part a
// `{ slug, title, body(HTML) }`. Fetching parts separately lets us SELECT the
// parts the `VisaType` shape needs (sections.ts) instead of sending a ~57k-char
// page that the 24k generic cap would cut silently mid-guide.
// See docs/visa-scraper-uk-reference.md §3.
//
// Politeness: every request goes through the SHARED VisaCatalogFetchService —
// same axios client + honest `Seli-VisaCatalogBot` UA, same 1.5s/host rate
// limit, same robots cache (checked against the API URL). Nothing duplicated.
//
// Failure = throw (the crawl records `pages[i].lastError`, no extraction, no
// maxExtractions slot): robots-blocked, any non-2xx (incl. 404), non-JSON body,
// `schema_name` not "guide", `details.parts` missing/empty, zero selected parts.

/**
 * Cap on the selected-sections text sent to the extractor. Separate from (and
 * larger than) the generic-html MAX_CLEAN_TEXT_CHARS (24_000): the Skilled
 * Worker selection is ~36k chars (~9k tokens). If a selection exceeds it the
 * text is cut and `truncated: true` is recorded + warned — never silently.
 */
export const GOVUK_MAX_TEXT_CHARS = 40_000;

/** The only host this adapter serves. */
const GOVUK_HOST = "www.gov.uk";

/** Content API base: `${GOVUK_CONTENT_API}${pathname}`. */
const GOVUK_CONTENT_API = "https://www.gov.uk/api/content";

/** Only this schema carries `details.parts[]`. */
const GUIDE_SCHEMA = "guide";

// ----- Response shape (only the fields we read) -----

/** One guide part as published. `body` is HTML. */
interface GovukPart {
  slug?: unknown;
  title?: unknown;
  body?: unknown;
}

/** The subset of a Content API item this adapter reads. */
export interface GovukContentItem {
  content_id?: unknown; // stable UUID across URL renames
  base_path?: unknown; // canonical path, e.g. "/skilled-worker-visa"
  schema_name?: unknown; // "guide" for visa pages
  updated_at?: unknown; // ISO timestamp string, or null
  // Present on EVERY item: `{}` when live, `{ explanation, withdrawn_at }` when
  // withdrawn (observed 2026-11-09). So presence alone is NOT the signal.
  withdrawn_notice?: unknown;
  details?: { parts?: unknown };
}

/**
 * True when a `withdrawn_notice` value means "withdrawn". GOV.UK sends an
 * empty object `{}` for live content (so `Boolean(notice)` would be wrong: an
 * empty object is truthy); a withdrawn item has a non-empty notice (typically
 * `explanation` + `withdrawn_at`).
 */
export function isWithdrawnNotice(notice: unknown): boolean {
  if (!notice || typeof notice !== "object") return false;
  return Object.values(notice as Record<string, unknown>).some(
    (v) => v !== null && v !== undefined && v !== ""
  );
}

/**
 * Content API URL for a www.gov.uk page: `/api/content` + the page pathname.
 * Query string and fragment are dropped; trailing slashes removed.
 */
export function govukContentApiUrl(pageUrl: string): string {
  const pathname = new URL(pageUrl).pathname.replace(/\/+$/, "");
  return `${GOVUK_CONTENT_API}${pathname}`;
}

/** Narrow the raw `details.parts` value to well-formed parts (string slug). */
function toSections(parts: unknown): SourceSection[] {
  if (!Array.isArray(parts)) return [];
  return (parts as GovukPart[])
    .filter((p) => p && typeof p.slug === "string" && p.slug.trim())
    .map((p) => ({
      slug: (p.slug as string).trim(),
      // Fall back to the slug if a part has no title (never seen, but safe).
      title: typeof p.title === "string" && p.title.trim() ? p.title.trim() : (p.slug as string),
      // HTML body → plain text with the SAME block-newline logic as pages.
      text: typeof p.body === "string" ? htmlFragmentToText(p.body) : "",
    }));
}

export class GovukContentApiAdapter implements SourceAdapter {
  readonly id = "govuk-content-api" as const;

  /**
   * @param fetchService the shared fetch service (client, rate limit, robots).
   * @param maxTextChars output cap (default GOVUK_MAX_TEXT_CHARS; tests may lower it).
   */
  constructor(
    private readonly fetchService: VisaCatalogFetchService,
    private readonly maxTextChars: number = GOVUK_MAX_TEXT_CHARS
  ) {}

  /** Only `www.gov.uk` pages (http/https). */
  canHandle(url: string): boolean {
    try {
      return new URL(url).host.toLowerCase() === GOVUK_HOST;
    } catch {
      return false;
    }
  }

  /** Fetch the guide JSON, select parts, format + cap + hash. Throws on failure. */
  async fetch(page: VisaSourcePage): Promise<SourceDocument> {
    if (!this.canHandle(page.url)) {
      throw new Error(`govuk-content-api cannot handle ${page.url} (host must be ${GOVUK_HOST})`);
    }
    const apiUrl = govukContentApiUrl(page.url);

    // ---- Politeness: robots for the API URL, then a rate-limited GET ----
    if (!(await this.fetchService.isAllowedByRobots(apiUrl))) {
      throw new Error(`Blocked by robots.txt: ${apiUrl}`);
    }
    const resp = await this.fetchService.getRaw(apiUrl, { Accept: "application/json" });
    if (resp.status < 200 || resp.status >= 300) {
      throw new Error(`GOV.UK Content API failed for ${apiUrl} (HTTP ${resp.status})`);
    }

    // ---- Parse + validate the payload ----
    let item: GovukContentItem;
    try {
      item = JSON.parse(resp.body) as GovukContentItem;
    } catch {
      throw new Error(`GOV.UK Content API returned a non-JSON body for ${apiUrl}`);
    }
    if (!item || typeof item !== "object") {
      throw new Error(`GOV.UK Content API returned a non-object body for ${apiUrl}`);
    }
    if (item.schema_name !== GUIDE_SCHEMA) {
      throw new Error(
        `GOV.UK page is not a guide (schema_name "${String(item.schema_name)}"): ${apiUrl}`
      );
    }

    // ---- Provenance fields (shared by withdrawn + normal documents) ----
    const canonicalUrl =
      typeof item.base_path === "string" && item.base_path
        ? `https://${GOVUK_HOST}${item.base_path}`
        : page.url;
    const base = {
      url: page.url,
      canonicalUrl,
      sourceProvider: this.id,
      sourceDocumentId: typeof item.content_id === "string" ? item.content_id : undefined,
      // null / absent `updated_at` is allowed → undefined.
      sourceUpdatedAt:
        typeof item.updated_at === "string" && item.updated_at ? item.updated_at : undefined,
    };

    // ---- Withdrawn: no sections, no text — the crawl must not extract ----
    // Checked before part validation: a withdrawn guide's parts are irrelevant.
    if (isWithdrawnNotice(item.withdrawn_notice)) {
      return {
        ...base,
        withdrawn: true,
        sections: [],
        text: "",
        contentHash: this.fetchService.hash(""),
      };
    }

    // ---- Parts → selected sections ----
    const all = toSections(item.details?.parts);
    if (all.length === 0) {
      throw new Error(`GOV.UK guide has no details.parts: ${apiUrl}`);
    }
    const selected = selectSections(all, effectiveSectionPatterns(page));
    if (selected.length === 0) {
      throw new Error(
        `No GOV.UK guide parts selected for ${page.url} (parts: ${all.map((s) => s.slug).join(", ")})`
      );
    }

    // ---- Format, cap (never silently), hash what the extractor will see ----
    const { text, truncated } = capText(formatSections(selected), this.maxTextChars);
    if (truncated) {
      console.warn(
        `[govuk-content-api] selected sections exceed ${this.maxTextChars} chars; ` +
          `text truncated for ${page.url}`
      );
    }
    return {
      ...base,
      withdrawn: false,
      sections: selected,
      text,
      contentHash: this.fetchService.hash(text),
      truncated,
    };
  }
}
