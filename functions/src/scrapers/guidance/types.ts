import type { Timestamp } from "firebase-admin/firestore";

// ============================================
// GUIDANCE SOURCE REGISTRY — TYPES (issue #39)
// ============================================
//
// The registry of CASEWORKER-GUIDANCE sources: the published rules and
// guidance documents that tell an officer how to decide an application. It is
// deliberately separate from `visaSources` (which describes what a visa is)
// and is the input to every rubric (#40).
//
// Generic by design: a source is DATA. `jurisdiction` and `route` are opaque
// keys chosen by whoever seeds the registry; nothing in this module compares
// them with a known value, and no country, route, publisher or nationality is
// named anywhere in the code.
//
// Storage layout (all backend-only; see guidance-snapshot.store.ts):
//   guidanceSources/{sourceId}                         registry + crawl state
//   guidanceSources/{sourceId}/snapshots/{contentHash} snapshot METADATA
//   gs://<project bucket>/guidance-snapshots/{sourceId}/{contentHash}.json
//                                                      snapshot TEXT

// ----- Enumerations -----

/** What kind of document the source's URL serves. */
export const GUIDANCE_DOC_TYPES = ["html", "pdf"] as const;
export type GuidanceDocType = (typeof GUIDANCE_DOC_TYPES)[number];

/**
 * Crawl status of a source:
 *  - active:  crawled when due;
 *  - failing: the crawler stopped crawling it after N consecutive failures
 *             (see guidance-crawl.service.ts); only an explicit single-source
 *             crawl retries it, and a success puts it back to `active`;
 *  - paused / retired: chosen by whoever maintains the registry; the crawler
 *             never crawls these and never changes their status.
 */
export const GUIDANCE_SOURCE_STATUSES = ["active", "failing", "paused", "retired"] as const;
export type GuidanceSourceStatus = (typeof GUIDANCE_SOURCE_STATUSES)[number];

/**
 * How far a human got when checking the source by hand BEFORE it was seeded:
 *  - verified:   the whole document was retrieved and read;
 *  - partial:    only part of it could be retrieved (the note says which);
 *  - unverified: it could not be retrieved (the note and `retrievalError`
 *                say what happened). The crawler SKIPS unverified sources.
 */
export const GUIDANCE_VERIFICATION_STATUSES = ["verified", "partial", "unverified"] as const;
export type GuidanceVerificationStatus = (typeof GUIDANCE_VERIFICATION_STATUSES)[number];

// ----- Registry entry -----

/**
 * The fields a human curates for one source. This is the shape of a seed
 * entry (data/seed-guidance-sources.ts) and the part of the stored doc a
 * re-seed overwrites.
 */
export interface GuidanceSourceSeed {
  // Stable doc id: lowercase letters, digits and hyphens. Chosen by the
  // seeder; never derived from the URL (a URL may change, the id must not).
  id: string;
  // Human-readable name of the document, for the admin list.
  title: string;
  // The URL to request. Official government sources only (a seeding rule,
  // enforced by review of the seed data, not by code).
  url: string;
  // Opaque key of the issuing jurisdiction (for example an ISO country code).
  jurisdiction: string;
  // Opaque, generic route key the document applies to (for example a visa
  // category). Lowercase letters, digits and hyphens.
  route: string;
  // What the URL serves. A response of the other kind is a crawl failure
  // ("content type changed"), not something to adapt to silently.
  docType: GuidanceDocType;
  // OPTIONAL. How to find the publisher's own "published / last updated"
  // date in the document: a regular expression (source text, no flags)
  // applied to the CLEANED TEXT, whose first capture group is the date as
  // written. Searched for in the first and last 20,000 characters only, and
  // it may not start with `.*` / `.+` or nest quantifiers (the seed
  // validator refuses those). Text rather than a CSS selector because the same field must work
  // for PDFs, and because the fetch service hands back cleaned text only.
  // See guidance-published-date.ts.
  publishedDateSelector?: string;
  // How often to re-check the source, in hours.
  checkIntervalHours: number;
  // Seeded status. Optional: defaults to "active" for a new source, and an
  // existing source keeps the status it has (see the seed).
  status?: Exclude<GuidanceSourceStatus, "failing">;
  // Verification honesty (see GuidanceVerificationStatus). Required.
  verificationStatus: GuidanceVerificationStatus;
  // Free text: what was actually retrieved, and when. Required, never empty.
  verificationNote: string;
  // ISO-8601 date or date-time of the manual retrieval the note describes.
  // Required for `verified` and `partial` (something was retrieved).
  retrievedAt?: string;
  // The error of a retrieval that failed or stopped short. Required for
  // `unverified`; FORBIDDEN on `verified` (a source with a recorded failure
  // is not verified, whatever else the entry says).
  retrievalError?: string;
  // The URL the request is expected to END at after redirects. REQUIRED in
  // practice for a source whose `url` redirects: without it the crawl
  // expects the request to end at `url` itself, and any redirect (even on
  // the first fetch) fails with `redirect_changed` and ingests nothing.
  // Optional only because most sources do not redirect.
  expectedFinalUrl?: string;
}

/**
 * A stored `guidanceSources/{sourceId}` doc: the curated fields plus the
 * crawl state the crawler owns.
 */
export interface GuidanceSource
  extends Omit<
    GuidanceSourceSeed,
    "id" | "status" | "retrievedAt" | "retrievalError" | "publishedDateSelector" | "expectedFinalUrl"
  > {
  status: GuidanceSourceStatus;
  // The seed's optional fields are stored as null when absent (so a re-seed
  // that drops one clears it).
  publishedDateSelector: string | null;
  expectedFinalUrl: string | null;
  retrievalError: string | null;
  // The manual retrieval instant (from the seed's `retrievedAt`), or null.
  retrievedAt: Timestamp | null;

  // ---- Crawl state (written by the crawler, kept by a re-seed) ----
  // When the source was last fetched SUCCESSFULLY (changed or not): the
  // tick time of that crawl run (the same clock as `lastAttemptAt`).
  lastFetchedAt: Timestamp | null;
  // sha256 of the cleaned text of the last successful fetch: the hash gate.
  lastContentHash: string | null;
  // The URL the last successful fetch ended at, after redirects (equal to
  // `url` when there was no redirect). Both are always kept.
  finalUrl: string | null;
  // The publisher's own date, as an ISO date (YYYY-MM-DD) when it could be
  // parsed, else null; and the text it was read from, exactly as written.
  publishedDate: string | null;
  publishedDateText: string | null;
  // Id (= content hash) of the newest snapshot, and when the hash last moved.
  latestSnapshotId: string | null;
  lastChangedAt: Timestamp | null;
  // Every attempt, successful or not.
  lastAttemptAt: Timestamp | null;
  // Failure streak and the last failure, for the admin list.
  consecutiveFailures: number;
  lastError: string | null;
  // Machine-readable class of that failure (see GuidanceFailureKind in
  // guidance-crawl.service.ts), e.g. "content_type_changed".
  lastErrorKind: string | null;
  lastErrorAt: Timestamp | null;
  // Set when the host asked us to slow down (429/503): not crawled before it.
  backoffUntil: Timestamp | null;
  // Auto-pause flags, the same fields the visa and news crawlers write (see
  // scrapers/shared/runs/source-health.ts). Set when status became `failing`.
  autoPaused?: boolean;
  autoPausedAt?: Timestamp | null;
  autoPausedReason?: string | null;
  autoPauseCause?: string | null;

  createdAt: Timestamp;
  updatedAt: Timestamp;
}

// ----- Snapshots -----

/**
 * `guidanceSources/{sourceId}/snapshots/{contentHash}`: the METADATA of one
 * immutable snapshot. The text itself is in Cloud Storage at `storagePath`.
 * A snapshot is written once and never updated or deleted by this module.
 */
export interface GuidanceSnapshotMeta {
  sourceId: string;
  // sha256 (hex) of the cleaned text. Also the doc id and the Storage key.
  contentHash: string;
  docType: GuidanceDocType;
  // The URL that was requested, and where the request ended after redirects.
  url: string;
  finalUrl: string;
  httpStatus: number;
  fetchedAt: Timestamp;
  // The publisher's own date, when the document gives one (see GuidanceSource).
  publishedDate: string | null;
  publishedDateText: string | null;
  // Pages in the document: the PDF's page count; null for a web page.
  pageCount: number | null;
  // 1-based numbers of PDF pages that had no text layer (empty for HTML).
  pagesWithoutText: number[];
  // Length of the cleaned text, in characters and in UTF-8 bytes.
  charCount: number;
  byteLength: number;
  // Size of the fetched PDF file in bytes; null for a web page.
  sourceByteLength: number | null;
  // Object name in the project's default bucket (never a URL).
  storagePath: string;
  // The hash this one replaced WHEN IT WAS FIRST SEEN (null for a source's
  // first snapshot): the record of the change. If the content later goes
  // away and comes back, this snapshot is reused as it is; the move is
  // recorded on the source (`latestSnapshotId`, `lastChangedAt`).
  previousContentHash: string | null;
  createdAt: Timestamp;
}

/** Version of the JSON object stored in Cloud Storage. */
export const GUIDANCE_SNAPSHOT_SCHEMA_VERSION = 1;

/** One page of a PDF snapshot. `page` is 1-based, as printed in a citation. */
export interface GuidanceSnapshotPage {
  page: number;
  text: string;
}

/**
 * The JSON object stored in Cloud Storage for one snapshot: the cleaned
 * source text, for INTERNAL quote validation only. It is never served to a
 * client (see guidance-snapshot.store.ts for how that is ensured).
 */
export interface GuidanceSnapshotContent {
  schemaVersion: number;
  sourceId: string;
  contentHash: string;
  docType: GuidanceDocType;
  url: string;
  finalUrl: string;
  fetchedAt: string; // ISO-8601
  // The whole cleaned text; sha256(text) === contentHash. For a PDF this is
  // the pages joined with a form feed (PDF_PAGE_SEPARATOR).
  text: string;
  // Per-page text with page numbers, for a PDF; null for a web page.
  pages: GuidanceSnapshotPage[] | null;
}
