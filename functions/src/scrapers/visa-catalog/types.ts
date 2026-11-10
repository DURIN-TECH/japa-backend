// Issue #82: per-call token usage on scrapeMeta.
import type { LlmUsage } from "../shared/cost/types";
import { Timestamp } from "firebase-admin/firestore";
import type { VisaCategory, VisaType } from "../../types/index";

// ============================================
// VISA CATALOG SCRAPING TYPES
// ============================================
//
// Types for the visa-catalog scraper (see src/scrapers/visa-catalog/docs/visa-catalog-scraping-spike.md):
// a source registry of official immigration URLs, a review queue that all
// scraped changes flow through, and the shape the LLM extractor returns.
//
// Design guarantees encoded here:
//  - New scraped visas land in `countries/{code}/visaTypes` as inactive
//    `pending_review` docs; edits to an already-approved scraped visa are only
//    ever PROPOSALS in `pendingVisaChanges` that an admin approves (issue #61).
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
// scrapers/visa-catalog/adapters/). One adapter per KIND of source, not per
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
  // Surcharges this route must pay that are published on ANOTHER page
  // (issue #69, e.g. the UK IHS for Student). Registry-owned: set from
  // VISA_SOURCE_OVERRIDES and refreshed on every re-seed. Absent = none (the
  // route page prints its own surcharges, or has none). See
  // scrapers/visa-catalog/visa-catalog-linked-surcharge.ts.
  linkedSurcharges?: LinkedSurchargeRef[];
  // ---- Supplementary pages (issue #86) ----
  // URLs of OTHER rows of the same country whose text is appended to this
  // route's text before extraction, because they publish what the route page
  // itself leaves out (KR: the HiKorea C-3 guide has no fee; the Korea Visa
  // Portal fee table does). Each URL must be a page of the same source that
  // is marked `supplementOnly`. Registry-owned (VISA_SOURCE_OVERRIDES).
  supplementaryPages?: string[];
  // True for a page that is NOT a visa route of its own (e.g. a fee table):
  // the crawl never extracts it into a visa doc, it is only fetched as a
  // supplementary page for the routes that list it. Registry-owned.
  supplementOnly?: boolean;
  // Content-hash gate: skip extraction when the cleaned page text is unchanged.
  // sha256 of the cleaned page text last crawl (with linked surcharges,
  // #69: linkedGateHash() of that hash + the linked pages' hashes).
  lastContentHash?: string;
  lastCrawledAt?: Timestamp;
  lastExtractedAt?: Timestamp;
  // Issue #96: set when the budget hard stop skipped this page's extraction
  // although its content changed (its old lastContentHash is kept, so the
  // next run within budget still sees the change). Cleared on extraction.
  extractionDeferredAt?: Timestamp;
  lastError?: string;
}

// ----- Linked surcharges (issue #69) -----
//
// Marks a route whose surcharge amount is on a linked page, not its own.
// `id` names a LINKED_SURCHARGE_SOURCES entry (country-level config, code);
// `rate` one of its rates ("standard" | "student" for GB IHS). `length` says
// how many years to charge: "assumed" = a stated registry assumption for
// variable-length routes (Student: 1 year, recorded with its `note` in
// scrapeMeta.fee), "extracted" = the whole-year length read in code from the
// extracted validityPeriod.
export type LinkedSurchargeLength =
  | { mode: "assumed"; years: number; note: string }
  | { mode: "extracted" };

export interface LinkedSurchargeRef {
  id: string; // e.g. "gb-ihs"
  rate: string; // e.g. "student"
  length: LinkedSurchargeLength;
}

// Provenance of one linked surcharge on scrapeMeta.fee.linkedSurcharges
// (written for every marker, applied or skipped). Optional fields are absent
// (never `undefined`) so the block is safe to write to Firestore.
export interface VisaLinkedSurchargeMeta {
  id: string; // config id, e.g. "gb-ihs"
  label: string; // e.g. "Immigration Health Surcharge"
  sourceUrl: string; // the linked page the rate was read from
  sourceUpdatedAt?: string; // its GOV.UK `updated_at`
  sourceContentHash: string; // hash of the linked page text used
  rate: string; // rate key used, e.g. "student"
  amount?: number; // per year, as printed on the linked page
  currency?: string;
  citation?: string; // verbatim line of the linked page stating the rate
  lengthBasis: "assumed" | "extracted"; // where `years` came from
  lengthNote?: string; // the stated assumption (assumed mode), e.g. "1 year: ..."
  years?: number; // years charged (only when applied)
  applied: boolean; // false = not added (see skippedReason)
  skippedReason?: string; // why it was not added (e.g. page already prints a surcharge)
}

// ----- Weekly night crawl window (issue #63) -----
//
// When a source may be crawled: once a week, on one LOCAL weekday, between two
// LOCAL hours in the source's own IANA time zone (government sites are hit at
// their quietest). The orchestrator ticks hourly at :15 UTC; every seeded
// zone has a whole-hour UTC offset, so a tick is also at :15 local. With
// startHour 2 / endHour 5 the ticks inside the window are 02:15 (first run),
// 03:15 and 04:15 (catch-up tries). Pure helpers live in
// scrapers/shared/etiquette/visa-crawl-window.ts.
export interface CrawlWindow {
  timeZone: string; // IANA, e.g. "Europe/London"
  dayOfWeek: number; // ISO 1 (Mon) .. 7 (Sun): the LOCAL weekday the window opens
  startHour: number; // local hour, inclusive, 0-23
  // Local hour, exclusive, startHour < endHour <= 24. No overnight wrap: a
  // window always sits within one local day.
  endHour: number;
}

/**
 * One stored host backoff on a `visaSources/{cc}` doc (issue #64). The
 * Firestore form of `HostBackoffEntry` (scrapers/shared/etiquette/visa-crawl-host-state.ts).
 */
export interface VisaSourceHostBackoff {
  host: string; // lowercased host, e.g. "www.gov.uk"
  until: Timestamp; // do not request the host before this instant
  status: number; // the status that triggered it (429 | 503)
  recordedAt: Timestamp; // tick time of the run that recorded it
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

  // Scheduling. A source WITH a `crawlWindow` is crawled once a week inside
  // that local night window (issue #63) and `nextCrawlAt` is set to the
  // window's next opening after each run. `crawlIntervalHours` (168 = weekly)
  // is used ONLY by a source without a window (legacy behaviour:
  // `nextCrawlAt = now + crawlIntervalHours`, no window filter).
  crawlIntervalHours: number;
  // Registry-owned: set from VISA_SOURCE_WINDOWS in seed-visa-sources.ts and
  // refreshed on every re-seed (NOT crawl state). Absent = legacy interval.
  crawlWindow?: CrawlWindow;
  lastCrawledAt?: Timestamp;
  nextCrawlAt?: Timestamp;

  // Crawler etiquette (issue #64): hosts of this source that answered 429/503
  // and asked us (via Retry-After, or our default) not to come back before
  // `until`. Crawler-owned (kept across re-seeds). The orchestrator skips any
  // page on a listed host until then, and defers `nextCrawlAt` when EVERY page
  // host is backed off past it. Expired entries are pruned on each run. Kept
  // as an array of plain entries (not a host-keyed map: hosts contain dots,
  // which are field-path separators) so #15 can move it to per-host docs.
  hostBackoffs?: VisaSourceHostBackoff[];

  // Health / self-healing: auto-pause (status `broken`) at
  // visa.consecutiveFailureLimit consecutive failures (default 5, issue #107;
  // rules in scrapers/shared/runs/source-health.ts, same as news).
  status: CrawlStatus;
  reliabilityScore: number; // 0–100 (successfulRuns / totalRuns)
  consecutiveFailures: number;
  // Issue #107: set by the crawler when it auto-pauses the source, cleared on
  // recovery / admin reset. Crawl state: kept across re-seeds.
  autoPaused?: boolean;
  autoPausedAt?: Timestamp | null;
  autoPausedReason?: string | null; // the last error at the pause
  autoPauseCause?: "failure_limit" | null;

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
  model: string; // extractor model, e.g. "deepseek-flash" (older records: "deepseek-chat")
  confidence: number; // 0–1 from the extractor
  citations: Record<string, string>; // field name -> verbatim source quote
  // sha256 of the exact text sent to the extractor (selected + capped). For a
  // route with linked surcharges (#69): linkedGateHash() of that hash and the
  // linked pages' hashes, so a surcharge change re-stages the visa.
  contentHash: string;
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

  // ---- Uncited numeric fields (issue #86; optional so older docs stay valid) ----
  // True when the extraction had no cited processing time, so the visa doc
  // has NO processingDaysMin/Max (and `processingTime` may be the display
  // label PROCESSING_TIME_UNKNOWN_LABEL). Absent when the processing time is
  // known. Shown to the reviewer as "processing time not published".
  processingUnknown?: boolean;
  // The numeric fields the validator dropped because the page did not cite
  // them (ExtractedVisa.uncitedFieldsDropped). Absent when none were.
  uncitedFieldsDropped?: string[];
  // Supplementary registry pages whose text was appended to this route's
  // page before extraction (issue #86, e.g. the Korea Visa Portal fee table
  // for the HiKorea C-3 route). Absent when the route uses none.
  supplementaryPages?: VisaSupplementaryPageMeta[];
  // Issue #87: why the processing range disagrees with its cited durations
  // (copied from ExtractedVisa.processingUnverifiedReasons). Absent when it
  // agrees. Tells the reviewer to check processingDaysMin/Max by hand.
  processingUnverifiedReasons?: string[];

  // ---- LLM usage + cost (issue #82; optional so older docs stay valid) ----
  // The provider's token counts for the call that produced this extraction
  // (the prompt version is `extractorPromptVersion`, the model `model`).
  llmUsage?: LlmUsage;
  // Its cost in USD from appConfig/llmPricing; absent when the model had no price.
  llmCostUsd?: number;
  // The model the API says served the call, when it differs in name from
  // `model` (e.g. a dated Flash build behind "deepseek-flash").
  llmResponseModel?: string;
  // The price-table entry the cost used ("deepseek-flash"); absent when unpriced.
  llmPricedAs?: string;
}

// ----- Supplementary pages (issue #86) -----
//
// Provenance of one supplementary page used for an extraction (stored on
// scrapeMeta.supplementaryPages). Optional fields absent, never `undefined`.
export interface VisaSupplementaryPageMeta {
  url: string; // the registry page URL (a row of the same country)
  routeName: string; // its label in the registry markdown
  contentHash: string; // hash of its text as appended (feeds the route's hash gate)
  sourceUpdatedAt?: string; // when the source says it changed, if known
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
// scrapers/visa-catalog/visa-catalog-fx.ts. Fields absent (never `undefined`) when they
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
  // Why the fee is unverified, one entry per reason (issue #71: an array,
  // written whenever `feeUnverified` is set). Read it through
  // storedFeeUnverifiedReasons() (visa-catalog-fx.ts), which also understands
  // the legacy string form below.
  feeUnverifiedReasons?: string[];
  // LEGACY (pre-#71, read-only): the same reasons joined with "; ". Never
  // written any more; still present on docs ingested before #71 until they
  // are re-extracted / re-converted (both replace the fee block wholesale).
  /** @deprecated read via storedFeeUnverifiedReasons(); write feeUnverifiedReasons */
  feeUnverifiedReason?: string;

  // ---- Manual USD cost (issue #70; optional so older docs stay valid) ----
  // Present when an admin set the USD cost by hand on a PENDING scraped visa
  // the scraper could not convert (PUT /admin/visas/:id/manual-cost). The
  // block then also has `fxSource: FX_SOURCE_MANUAL` ("manual"),
  // `totalUsd = manualCost.amountUsd`, `fxDate` = the day it was set, and NO
  // fxMissing / fxStale / feeUnverified / noPublishedFee flags (their old
  // values are kept in `manualCost.previous`). `components` / `totals` stay
  // exactly as the source published them.
  manualCost?: VisaManualCostMeta;
  // Audit trail for an overwrite (issue #70): a later scrape with CHANGED
  // content replaced a manual cost through the normal path (conversion or
  // flags). Never silent: the replaced entry is kept here (and logged) so the
  // review UI can show "your manual cost of $X was replaced on <date>".
  // Carried forward by later refreshes / re-conversions until a newer manual
  // cost or overwrite replaces it.
  replacedManualCost?: VisaReplacedManualCostMeta;
  // Surcharges taken from a LINKED page (issue #69): source, citation, rate
  // and the (assumed or extracted) length charged. The applied ones are also
  // in `components`. Absent when the route uses none.
  linkedSurcharges?: VisaLinkedSurchargeMeta[];
}

// ----- Manual USD cost (issue #70) -----
//
// Who set a hand-entered USD cost on a pending scraped visa, when, and why.
// Stored at `scrapeMeta.fee.manualCost`. Optional fields are ABSENT (never
// `undefined`) so the object is always safe to write to Firestore.
export interface VisaManualCostMeta {
  // The USD amount exactly as entered (may have cents; 0 = a confirmed free
  // visa). The visa's
  // `baseCostUsd` is Math.round(amountUsd), and `fee.totalUsd` = amountUsd,
  // so the approval guard (baseCostUsd === round(totalUsd)) accepts it.
  amountUsd: number;
  // Why the admin set it, e.g. "CBC rate 1 TWD = 0.031 USD on 2026-11-10".
  // Required (trimmed, non-empty).
  reason: string;
  // The exchange rates the admin used: USD per ONE unit of `currency`, one
  // entry per distinct non-USD currency among the fee components (empty for
  // a USD-only fee or no published fee). Recorded for audit only — not
  // re-applied to the components.
  rates: { currency: string; usdPerUnit: number }[];
  setBy: string; // admin uid
  setAt: Timestamp;
  // `scrapeMeta.contentHash` of the extraction the cost was set against.
  contentHash: string;
  // What the fee block said BEFORE this manual cost (the scraper's state),
  // so a reviewer can see what was overridden. Only keys that were set.
  previous: {
    fxMissing?: boolean;
    fxStale?: boolean;
    feeUnverified?: boolean;
    // Read with storedFeeUnverifiedReasons() (array #71 form or legacy string).
    feeUnverifiedReasons?: string[];
    noPublishedFee?: boolean;
    totalUsd?: number;
    fxSource?: string;
    baseCostUsd?: number;
  };
  // When this manual cost replaced an EARLIER manual cost on the same
  // extraction (an admin correcting themselves): that earlier entry, minus
  // its own `previous` / `supersedes` (one level only).
  supersedes?: Omit<VisaManualCostMeta, "previous" | "supersedes">;
}

// A manual cost that a later scrape replaced (see VisaFeeMeta.replacedManualCost).
export interface VisaReplacedManualCostMeta extends VisaManualCostMeta {
  replacedAt: Timestamp; // when the crawl replaced it
  replacedByContentHash: string; // content hash of the extraction that replaced it
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

// ----- Proposed edits to live visas (`pendingVisaChanges/{changeId}`, issue #61) -----
//
// When the official page behind an ALREADY-APPROVED scraped visa changes, the
// crawl does not touch the live doc: it stages a field-level proposal here and
// an admin approves it (applied in one transaction, never partially) or
// rejects it with a reason. Backend-only collection: firestore.rules has no
// match for it (default deny), all access is via the Admin SDK.
//
// Invariants:
//  - At most one `open` row per `countryCode + visaId`; a newer extraction
//    overwrites that row IN PLACE (same id + createdAt, `revision` + 1).
//  - The crawl never deletes a row, and nothing is ever auto-published.

/** Lifecycle of a proposal. There is deliberately no "auto_published". */
export type PendingVisaChangeStatus = "open" | "approved" | "rejected";

/** The scalar VisaType fields the diff compares (strings compared trimmed). */
export type VisaScalarDiffField =
  | "name"
  | "description"
  | "category"
  | "processingTime"
  | "processingDaysMin"
  | "processingDaysMax"
  | "validityPeriod"
  | "isExtendable"
  | "maxExtensions"
  | "applicationUrl"
  | "applicationInstructions";

/**
 * One fee-component change. Components are matched by `kind` + `label` +
 * `currency` and compared in their OWN currency (`amount`, `per`, `years`),
 * so an exchange-rate movement alone is never a change.
 */
export type FeeComponentDiff =
  | { change: "added"; after: VisaFeeComponentMeta }
  | { change: "removed"; before: VisaFeeComponentMeta }
  | { change: "changed"; before: VisaFeeComponentMeta; after: VisaFeeComponentMeta };

/**
 * One changed field in a proposal. `before` / `after` are OMITTED (never
 * `undefined`) when the field is absent on that side. A scalar that is
 * present live but absent from the new extraction has `kind: "removed"`
 * (only `before`): approving it DELETES the field from the live doc, so the
 * diff UI must show it as a removal, not an edit. Absent → present and
 * present → present are `kind: "changed"`.
 */
export type VisaFieldDiff =
  | { field: VisaScalarDiffField; kind: "changed" | "removed"; before?: unknown; after?: unknown }
  // Compared as a whitespace-trimmed SET: a pure reorder is not a diff. When it
  // is a diff, the full proposed array (in proposed order) is what is applied.
  | { field: "eligibilityCriteria"; kind: "changed"; added: string[]; removed: string[] }
  // The fee. Applying it writes `baseCostUsd` (+ `scrapeMeta.fee` via the
  // wholesale scrapeMeta replace) in the same transaction.
  | {
      field: "fee";
      kind: "changed";
      components: FeeComponentDiff[];
      baseCostUsdBefore?: number;
      baseCostUsdAfter?: number;
    };

/** A staged, field-level edit to a live (approved, scraped) visa. */
export interface PendingVisaChange {
  id: string; // auto id
  countryCode: string; // upper-case, e.g. "GB"
  visaId: string; // target doc under countries/{code}/visaTypes
  // "create" is not used (new visas still go straight to pending_review);
  // there is never a "delete".
  changeType: "update";
  status: PendingVisaChangeStatus;
  revision: number; // 1 on create, +1 each time a newer extraction replaces the open row
  diff: VisaFieldDiff[]; // never empty
  // Live values of the diffed fields only, at proposal time (stale check +
  // diff UI). For a fee diff this holds `baseCostUsd`.
  current: Partial<VisaType>;
  // Proposed values of the diffed fields only (incl. `baseCostUsd` when the
  // fee diff converts). A diffed field absent here is REMOVED on approve.
  proposed: Partial<VisaType>;
  proposedScrapeMeta: VisaScrapeMeta; // written wholesale on approve (replace, not deep-merge)
  proposedSourceUrl: string;
  citations: Record<string, string>; // = proposedScrapeMeta.citations, hoisted for list/diff UI
  confidence: number; // 0-1
  sourceUrl: string;
  contentHash: string; // sha256 of the text the extractor saw
  model: string;
  extractorPromptVersion?: string;
  // The live doc's `scrapeMeta.contentHash` when the proposal was (last)
  // written. Absent when the live doc had none. Part of the approve-time stale
  // check: if the live scrapeMeta moved, the copied-forward parts of
  // `proposedScrapeMeta` (e.g. an unchanged fee block) would be out of date.
  currentContentHash?: string;
  // False when the proposed fee is fxStale / fxMissing / feeUnverified /
  // noPublishedFee (or the cost does not match it): approve is refused.
  approvable: boolean;
  blockReason?: string; // FEE_NOT_CONVERTED_MESSAGE / FEE_MISSING_COST_MESSAGE when !approvable
  // ---- Manual USD cost on a proposal (issue #77) ----
  // The cost itself lives where approve already looks: the proposed fee
  // (`proposedScrapeMeta.fee.manualCost`, `fxSource: "manual"`, `totalUsd`)
  // plus `proposed.baseCostUsd` = Math.round(amountUsd). See
  // changes/visa-change-manual-cost.ts.
  //
  // Set when a re-proposal with CHANGED page text replaced this open row and
  // the row it replaced carried a manual cost: that cost (+ replacedAt /
  // replacedByContentHash), so the admin sees "your manual cost of $X was
  // replaced" instead of it vanishing. Kept at ROW level (not on the
  // proposed fee) so it is never copied onto the live visa by approve.
  // Carried forward by later replacements until a newer manual cost is
  // replaced. Absent when nothing was replaced.
  replacedManualCost?: VisaReplacedManualCostMeta;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  // Set on resolution only:
  resolvedBy?: string; // admin uid
  resolvedAt?: Timestamp;
  rejectionReason?: string;
  appliedFields?: string[]; // on approve: the visa fields actually written from the diff
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
  // Issue #86: ABSENT (never a fake 0) when the page does not back them with a
  // processing citation — then `processingUnknown` is true and both are
  // omitted together (the validator never keeps just one).
  processingDaysMin?: number;
  processingDaysMax?: number;
  // Set (true) by the validator when the processing time is unknown: no
  // processing citation, a missing value, or a 0-day upper bound. Absent when
  // processingDaysMin/Max are present.
  processingUnknown?: true;
  // Numeric fields the model returned that the validator DROPPED for lack of
  // a citation, e.g. ["processingDaysMin", "processingDaysMax",
  // "maxExtensions"] (issue #86). Absent when nothing was dropped.
  uncitedFieldsDropped?: string[];
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
  // Set by the validator (issue #87) when processingDaysMin/Max is more than
  // 20% from every duration the processing citations state; confidence is
  // then capped. Absent when the range agrees (or the check does not apply).
  processingUnverifiedReasons?: string[];
  // Trust signals returned alongside the data.
  confidence: number; // 0–1
  // field -> verbatim quote from the page. Fee keys: "fee.application",
  // "fee.surcharge" (2nd surcharge "fee.surcharge.2", ...), and "fee.years"
  // (2nd per-year component "fee.years.2", ...) — see feeCitationKey().
  citations: Record<string, string>;
}
