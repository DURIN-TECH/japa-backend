import type { Timestamp } from "firebase-admin/firestore";

// ============================================
// OUTCOME STATISTICS: GENERIC TYPES (issue #116)
// ============================================
//
// "Outcome statistics" are PUBLISHED decision figures (how many applications a
// government granted, refused or otherwise closed) for one destination, one
// published visa category and one nationality, over one period. They are
// imported from the destination's own official statistics release and stored
// exactly as published, so a figure always traces back to rows of a named
// table in a named file.
//
// NOTHING in this file is specific to a destination, a visa route or a
// nationality. A destination is a country code, a category is an opaque key the
// destination's adapter chooses, a nationality is a lookup key. The one
// destination implemented today (the UK Home Office) lives in
// src/scrapers/outcome-statistics/adapters/uk-home-office/; another country is
// added by writing another adapter, without touching these types, the import
// service, the lookup or the note builder.
//
// Money / domain rules (strict): no figure is ever invented, estimated,
// borrowed from a neighbouring nationality or hard-coded. A figure that is not
// in the imported release does not exist as far as this code is concerned.

/** A calendar quarter, e.g. { year: 2026, quarter: 2 } = "2026 Q2". */
export interface PeriodQuarter {
  year: number;
  /** 1..4 */
  quarter: number;
}

/**
 * The period a statistic covers: the latest N published quarters of a release,
 * summed. `start`/`end` are ISO dates (YYYY-MM-DD, inclusive) so they sort
 * lexicographically and need no timezone handling.
 */
export interface OutcomePeriod {
  /** First day of the first quarter, e.g. "2025-07-01". */
  start: string;
  /** Last day of the last quarter, e.g. "2026-06-30". */
  end: string;
  /** The quarters summed, oldest first, as published, e.g. ["2025 Q3", ...]. */
  quarters: string[];
  /** Display label, e.g. "year ending 2026 Q2". */
  label: string;
}

/**
 * Decision counts for one (category, nationality, period).
 * `granted` and `refused` feed the grant rate; `other` is every other
 * published outcome (e.g. withdrawn, lapsed), reported but never rated.
 */
export interface OutcomeCounts {
  granted: number;
  refused: number;
  other: number;
}

/** Who published the figures and where they can be checked. */
export interface OutcomeSourceInfo {
  /** Publisher display name, e.g. "UK Home Office". Written by the adapter. */
  publisher: string;
  /** The page a person opens to find the release (the data tables page). */
  pageUrl: string;
  /** Direct URL of the imported file at retrieval time (changes per release). */
  fileUrl: string;
  /** The imported file's name. */
  fileName: string;
  /** The tables / sheets the figures were computed from, as named in the file. */
  tableNames: string[];
  /** Publisher's own label for the release, e.g. "year ending June 2026". */
  releaseLabel: string | null;
  /** Publisher's release date (ISO date), when the page states one. */
  releaseDate: string | null;
  /** Caveats the publisher attaches to these figures, shown with them. */
  caveats: string[];
}

/** Whether a stored statistic is for one nationality or for all of them. */
export type OutcomeScope = "nationality" | "all";

/**
 * One stored statistic (Firestore `outcomeStatistics/{id}`), backend-only.
 *
 * Doc id: `${destination}__${releaseId}__${categorySlug}__${nationalityKey}`
 * (see statisticDocId in services/outcome-statistics/outcome-statistics.service.ts).
 */
export interface OutcomeStatistic {
  /** Destination country code (the key adapters register under), e.g. "GB". */
  destination: string;
  /**
   * The published category the figures come from, as an opaque key chosen by
   * the destination's adapter (a rubric's route-to-category mapping stores it).
   */
  categoryKey: string;
  /** The publisher's own name for the category (not user-facing wording). */
  categoryLabel: string;
  scope: OutcomeScope;
  /**
   * Lookup key of the nationality: the normalised ISO 3166-1 alpha-2 code when
   * the published name maps to one, otherwise `name:<slug of published name>`;
   * the fixed key "ALL" for scope "all". Queried by exact match.
   */
  nationalityKey: string;
  /** Nationality exactly as published; null for scope "all". */
  nationalityName: string | null;
  /** Normalised ISO code, or null when the published name does not map. */
  nationalityCode: string | null;
  period: OutcomePeriod;
  /** Same as period.end, duplicated top-level for the composite index. */
  periodEnd: string;
  counts: OutcomeCounts;
  /** Each non-granted, non-refused published outcome, as published (label -> count). */
  otherBreakdown: Record<string, number>;
  /** granted + refused: the rate's denominator. */
  decisions: number;
  /** granted / (granted + refused); null when decisions is 0. */
  grantRate: number | null;
  /** Id of the import (release) this doc belongs to; see OutcomeReleasePointer. */
  releaseId: string;
  source: OutcomeSourceInfo;
  retrievedAt: Timestamp;
}

/**
 * `outcomeStatisticsReleases/{destination}`: which release is CURRENT for a
 * destination. A release's docs are written first and this pointer is flipped
 * last, so a failed import never changes what the lookup sees (no partial
 * replace).
 */
export interface OutcomeReleasePointer {
  destination: string;
  releaseId: string;
  /** SHA-256 of the imported file (hex). Same hash again = nothing to do. */
  fileHash: string;
  fileUrl: string;
  pageUrl: string;
  fileName: string;
  releaseDate: string | null;
  releaseLabel: string | null;
  periodEnd: string;
  period: OutcomePeriod;
  runId: string;
  docsWritten: number;
  importedAt: Timestamp;
  /** The release that was current before this one (its docs are then deleted). */
  previousReleaseId: string | null;
}

/** Outcome of one import run. */
export type OutcomeRunResult = "imported" | "skipped_unchanged" | "failed" | "running";

/** What triggered a run. */
export type OutcomeRunTrigger = "scheduled" | "manual";

/**
 * `outcomeStatisticsRuns/{runId}`: one record per import attempt, listed by
 * the admin-only GET /admin/outcome-statistics/runs.
 */
export interface OutcomeImportRun {
  destination: string;
  trigger: OutcomeRunTrigger;
  /** uid of the admin for a manual run. */
  requestedBy: string | null;
  result: OutcomeRunResult;
  startedAt: Timestamp;
  finishedAt: Timestamp | null;
  releaseDate: string | null;
  releaseLabel: string | null;
  fileName: string | null;
  fileUrl: string | null;
  fileHash: string | null;
  period: OutcomePeriod | null;
  /** releaseId written (imported runs only). */
  releaseId: string | null;
  counts: {
    /** Data rows read from the outcomes sheet. */
    rowsRead: number;
    /** statistic docs written. */
    docsWritten: number;
    /** Distinct nationalities (as published) with at least one stored statistic. */
    nationalities: number;
    /** Distinct categories stored. */
    categories: number;
    /** Old-release docs deleted after the flip. */
    oldDocsDeleted: number;
  } | null;
  /** Published nationality names with no code mapping (imported anyway). */
  unmappedNames: string[];
  /** Error message when result is "failed". */
  error: string | null;
  /** Free-text note, e.g. why a run was skipped. */
  note: string | null;
}

/**
 * `appConfig/outcomeStatistics`: product settings, all optional. A missing
 * doc or field falls back to the defaults in services/outcome-statistics/config.ts.
 */
export interface OutcomeStatisticsSettings {
  /** Fewest decisions (granted + refused) below which no rate is shown. */
  minDecisions: number;
  /** false = scheduled imports return at once (manual runs still work). */
  scheduledImportEnabled: boolean;
}
