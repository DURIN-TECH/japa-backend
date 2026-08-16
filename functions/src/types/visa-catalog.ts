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

// Crawl lifecycle — identical semantics to the news scraper's SourceStatus.
export type CrawlStatus = "active" | "paused" | "broken" | "retired";

// A single official page to fetch + extract. One page may describe one visa or,
// for `official_type_page`, several subtypes (the extractor can emit multiple).
export interface VisaSourcePage {
  url: string;
  routeName: string; // human label from the source list, e.g. "Skilled Worker visa"
  validation: VisaSourceValidation;
  notes?: string; // "Useful information confirmed" column from the markdown
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
  contentHash: string; // sha256 of the cleaned page text this was extracted from
  extractedAt: Timestamp;
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
