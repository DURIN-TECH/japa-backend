import { Timestamp } from "firebase-admin/firestore";
import type { VisaCategory } from "./index";

// ============================================
// VISA CATALOG SCRAPING TYPES
// ============================================
//
// Types for the visa-catalog scraper (see docs/visa-catalog-scraping-spike.md):
// a source registry of official immigration URLs, a review queue that all
// scraped changes flow through, and the shape the LLM extractor returns.
//
// Design guarantees encoded here:
//  - The scraper only ever writes PROPOSALS to `pendingVisaChanges`; an agent
//    approves before anything reaches the live `countries/{code}/visaTypes`.
//  - Nothing auto-publishes and nothing is auto-deleted.

// ----- Source registry (`visaSources/{countryCode}`) -----

// How confident we are in a source page, carried over from the verified-links
// markdown (TEXT-VERIFIED / OFFICIAL TYPE-PAGE / PATHWAY-VERIFIED).
export type VisaSourceValidation =
  | "text_verified"
  | "official_type_page"
  | "pathway_verified"
  | "unverified";

// Which SourceAdapter fetches a source's pages (see
// services/visa-source-adapters/). One adapter per KIND of source, not per
// country:
//  - "govuk-content-api": GOV.UK's public JSON Content API (`/api/content<path>`),
//    one guide part per section (GB).
//  - "generic-html": today's HTML fetch + clean (everyone else; the default).
export type SourceAdapterId = "govuk-content-api" | "generic-html";

// Crawl lifecycle — identical semantics to the news scraper's SourceStatus.
export type CrawlStatus = "active" | "paused" | "broken" | "retired";

// A single official page to fetch + extract. One page may describe one visa or,
// for `official_type_page`, several subtypes (the extractor can emit multiple).
export interface VisaSourcePage {
  url: string;
  routeName: string; // human label from the source list, e.g. "Skilled Worker visa"
  validation: VisaSourceValidation;
  notes?: string; // "Useful information confirmed" column from the markdown
  // Pinned doc id under countries/{code}/visaTypes for visas scraped from this
  // page. The registry owns record identity: when set, it is used verbatim
  // (never derived from what the LLM extracted), so the record survives a
  // future URL rename. Set from VISA_SOURCE_OVERRIDES in seed-visa-sources.ts;
  // pages without it fall back to `${cc}-${slug(url path)}`.
  visaId?: string;
  // Pinned visa `code` written on the scraped doc. The registry owns record
  // identity: when set it overrides the extracted code (used so scraped GB
  // routes line up with their seeded `uk-*` equivalents for comparison).
  visaCode?: string;
  // Section selection overrides for structured adapters (GOV.UK guide part
  // slugs). Slug patterns, case-insensitive, `*` = any run of characters
  // (e.g. "update-your-visa-*"). When set, each REPLACES the adapter's code
  // default list (include and exclude independently); exclude wins over
  // include. Registry-owned: set from VISA_SOURCE_OVERRIDES and refreshed on
  // every re-seed. Ignored by `generic-html` (one whole-page section).
  includeSections?: string[];
  excludeSections?: string[];
  // Content-hash gate: skip extraction when the cleaned page text is unchanged.
  lastContentHash?: string; // sha256 of the cleaned page text last crawl
  lastCrawledAt?: Timestamp;
  lastExtractedAt?: Timestamp;
  lastError?: string;
}

// One registry entry per country. Holds the known official pages for that
// country plus health/scheduling fields (mirrors the news `NewsSource`).
export interface VisaSource {
  id: string; // ISO alpha-2 country code, e.g. "GB"
  countryCode: string;
  countryName: string;
  isOfficial: boolean; // are all pages on official/government domains?
  pages: VisaSourcePage[];
  // Which adapter fetches this country's pages. Absent = "generic-html".
  // Registry-owned: set from VISA_SOURCE_ADAPTERS in seed-visa-sources.ts and
  // refreshed on every re-seed. A page whose URL the adapter can't handle
  // falls back to generic-html (see pickSourceAdapter).
  adapter?: SourceAdapterId;

  // Scheduling — weekly by default (168h). Staggered via nextCrawlAt.
  crawlIntervalHours: number;
  lastCrawledAt?: Timestamp;
  nextCrawlAt?: Timestamp;

  // Health / self-healing (auto-pause at 5 consecutive failures, like news).
  status: CrawlStatus;
  reliabilityScore: number; // 0–100 (successfulRuns / totalRuns)
  consecutiveFailures: number;

  createdAt: Timestamp;
  updatedAt: Timestamp;
}

// ----- Scrape provenance (stored on the VisaType doc) -----
//
// Scraped visas are written straight into `countries/{code}/visaTypes` with
// `source: "scraped"` and `reviewStatus: "pending_review"`, so they surface in
// the EXISTING admin visa-review page for approval (no autopublish). This block
// travels on the doc as the audit trail behind those values.
export interface VisaScrapeMeta {
  sourceUrl: string;
  routeName: string; // the source-registry label the page was crawled under
  model: string; // extractor model, e.g. "deepseek-chat"
  confidence: number; // 0–1 from the extractor
  citations: Record<string, string>; // field name -> verbatim source quote
  contentHash: string; // sha256 of the exact text sent to the extractor (selected + capped)
  extractedAt: Timestamp;

  // ---- Source provenance (issue #58; all optional so older docs stay valid) ----
  // Which adapter fetched the text. Docs written before adapters have none.
  sourceProvider?: SourceAdapterId;
  // The source's own stable document id (GOV.UK `content_id` UUID — survives
  // URL renames). Absent for generic-html.
  sourceDocumentId?: string;
  // When the SOURCE last changed, ISO string as published (GOV.UK `updated_at`).
  // Absent when the source doesn't say (or for generic-html).
  sourceUpdatedAt?: string;
  // Slugs of the sections the extractor saw, in source order (GOV.UK part
  // slugs). Absent/empty for generic-html (one whole page).
  sectionsUsed?: string[];
  // True when the selected sections exceeded the adapter's cap and the text
  // was cut. Never silent: also logged with the page URL at fetch time.
  truncated?: boolean;
}

// ----- Extractor output shape -----
//
// What the LLM is constrained to return (strict JSON schema mirrors this). Dates
// are plain strings; the service converts + validates before staging. `category`
// is constrained to the existing VisaCategory enum.
export interface ExtractedVisa {
  name: string;
  code: string;
  description: string;
  category: VisaCategory;
  processingTime: string;
  processingDaysMin: number;
  processingDaysMax: number;
  baseCostUsd: number;
  validityPeriod: string;
  isExtendable: boolean;
  maxExtensions?: number;
  eligibilityCriteria: string[];
  applicationUrl?: string;
  applicationInstructions?: string;
  // Trust signals returned alongside the data.
  confidence: number; // 0–1
  citations: Record<string, string>; // field -> verbatim quote from the page
}
