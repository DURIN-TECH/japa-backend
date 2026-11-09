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
  // Official host patterns ("www.gov.uk", "*.service.gov.uk") — issue #74.
  // Registry-owned: set from VISA_SOURCE_OFFICIAL_HOSTS on every re-seed.
  // Gates the extractor's `applicationUrl`; absent → code fallback / none.
  officialHosts?: string[];

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

  // ---- Fee + FX provenance (issue #59; optional so older docs stay valid) ----
  // The fee exactly as the source publishes it (components in their own
  // currency), the code-computed totals, and how it was converted to USD.
  // `baseCostUsd` on the visa doc is derived from this block in code — the
  // LLM never converts currency or does arithmetic.
  fee?: VisaFeeMeta;
  // Version of the extractor prompt/schema that produced this doc (exported
  // constant EXTRACTOR_PROMPT_VERSION in visa-catalog-extract.service.ts), so
  // a reviewer can tell which rules a stored extraction followed.
  extractorPromptVersion?: string;
}

// ----- Fee components (issue #59) -----
//
// The fee rule (user-decided, written into the extractor prompt):
// `baseCostUsd` = the MAIN applicant's government application fee for the
// standard case of applying from OUTSIDE the country, PLUS mandatory
// per-applicant surcharges for the standard visa length (UK: Immigration
// Health Surcharge). Dependants, priority/premium services, shortage/reduced
// rates, in-country (extension/switching) fees and optional extras are
// excluded. The LLM returns the parts; code does all the arithmetic.

// "application" = the government application fee (at most one per visa);
// "surcharge" = a mandatory per-applicant add-on such as the UK IHS.
export type FeeComponentKind = "application" | "surcharge";

// How the published amount is charged: once per application, or per year of
// the visa (then `years` says how many years the standard visa length is).
export type FeeComponentPer = "application" | "year";

// One fee component as the extractor returns it (validated). `amount` is in
// `currency` (ISO 4217, upper-case), exactly as printed on the page.
export interface ExtractedFeeComponent {
  kind: FeeComponentKind;
  label: string; // the page's own name for the fee, e.g. "Immigration Health Surcharge"
  amount: number; // as published, in `currency`; >= 0
  // ISO 4217 code. Required for a non-zero amount; may be "" for a 0 component.
  currency: string;
  per: FeeComponentPer;
  years?: number; // integer >= 1; required when per === "year"
}

// A component as stored on scrapeMeta.fee: the extracted part plus the
// code-computed total in its own currency (amount, or amount x years).
export interface VisaFeeComponentMeta extends ExtractedFeeComponent {
  totalInCurrency: number;
}

// The stored fee block (scrapeMeta.fee). Built by computeFee() in
// services/visa-catalog-fx.ts. Fields absent (never `undefined`) when they
// don't apply, so the object is always safe to write to Firestore.
export interface VisaFeeMeta {
  components: VisaFeeComponentMeta[];
  // Source-currency totals, one entry per currency the components use.
  totals: { currency: string; amount: number }[];
  // Unrounded USD total. Absent when any currency had no usable rate.
  totalUsd?: number;
  // USD per ONE unit of each converted currency (totalUsd = sum(total x rate)).
  // Only currencies that were actually converted (USD itself is 1).
  fxRateToUsd?: Record<string, number>;
  // The rate date: the ECB reference date for frankfurter rates, the
  // conversion date for official pegs. Absent when no conversion was needed.
  fxDate?: string;
  // Where the rate(s) came from: FX_SOURCE_ECB, FX_SOURCE_PEG, or both
  // joined with " + " when components used both. Absent when no conversion
  // was needed (USD-only or zero fee).
  fxSource?: string;
  // No usable rate: a currency has a stored rate but it is older than
  // FX_MAX_AGE_DAYS (fxStale) or has no rate at all (fxMissing). Either flag
  // means `baseCostUsd` was NOT written and approval is blocked.
  fxStale?: boolean;
  fxMissing?: boolean;
  // The page states no fee (feeComponents was []). No `baseCostUsd`; an
  // existing doc's old cost is deleted on ingest. Approval is blocked.
  noPublishedFee?: boolean;
  // Part of the fee could not be verified: a per-year surcharge whose years /
  // length citation failed validation was DROPPED (the rest kept), or a
  // component is implausibly large. No `baseCostUsd`; approval is blocked.
  feeUnverified?: boolean;
  feeUnverifiedReason?: string;
}

// ----- Stored exchange rates (`appConfig/fx`) -----
//
// Backend-written only (firestore.rules has no match for appConfig, so all
// client access is denied). Refreshed once per crawl run from Frankfurter
// (ECB euro reference rates, rebased to USD by the API).
export interface FxRatesDoc {
  base: "USD";
  // Local currency units per 1 USD, e.g. { GBP: 0.747 } (as the API returns).
  rates: Record<string, number>;
  fetchedAt: Timestamp; // when WE fetched it — staleness is measured from here
  rateDate: string; // the API's `date` (ECB reference date, YYYY-MM-DD)
  source: string; // FX_SOURCE_ECB
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
  // The fee as published (issue #59). Replaces the old LLM-converted
  // `baseCostUsd`: code computes the total and converts it to USD.
  // [] = the page states no fee; a free visa = one application component of 0.
  feeComponents: ExtractedFeeComponent[];
  // Set by the validator when it dropped a per-year surcharge whose years /
  // length citation failed the checks (absent when nothing was dropped).
  feeUnverifiedReasons?: string[];
  validityPeriod: string;
  isExtendable: boolean;
  maxExtensions?: number;
  eligibilityCriteria: string[];
  applicationUrl?: string;
  applicationInstructions?: string;
  // Trust signals returned alongside the data.
  confidence: number; // 0–1
  // field -> verbatim quote from the page. Fee keys: "fee.application",
  // "fee.surcharge" (2nd surcharge "fee.surcharge.2", ...), and "fee.years"
  // (2nd per-year component "fee.years.2", ...) — see feeCitationKey().
  citations: Record<string, string>;
}
