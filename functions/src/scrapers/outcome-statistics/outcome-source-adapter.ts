// ============================================
// OUTCOME DATA SOURCE: ADAPTER CONTRACT (issue #116)
// ============================================
//
// One adapter per destination, each knowing how that government publishes its
// decision statistics (where the release is listed, what the file looks like,
// what its columns are called). Everything AFTER the adapter (aggregation,
// storage, run records, lookup, the note) is generic and never learns what
// destination, route or nationality it is handling.
//
// To add another country: implement OutcomeDataSourceAdapter for its published
// statistics and register it in registry.ts. No change to the types, the import
// service, the lookup or the note builder.

/** Publisher's pointer to the current release, found by the adapter. */
export interface ReleaseDescriptor {
  publisher: string;
  /** The page a person opens to find the release. */
  pageUrl: string;
  /** Direct URL of the file, discovered from the page (never stored config). */
  fileUrl: string;
  fileName: string;
  /** Publisher's label for the release, when the page gives one. */
  releaseLabel: string | null;
  /** Publisher's release date as an ISO date, when the page gives one. */
  releaseDate: string | null;
}

/** A file downloaded to local disk. */
export interface DownloadedFile {
  /** Local path (the caller deletes it). */
  path: string;
  /** SHA-256 of the bytes, hex. */
  sha256: string;
  bytes: number;
}

/**
 * One decision count, already normalised by the adapter: which published
 * category and nationality, in which quarter, with which outcome. The adapter
 * has already removed double counting between overlapping published rows.
 */
export interface OutcomeObservation {
  categoryKey: string;
  /** The publisher's own category name. */
  categoryLabel: string;
  /** Nationality exactly as published. */
  nationalityName: string;
  /** Normalised ISO code from the adapter's name lookup, or null if it has none. */
  nationalityCode: string | null;
  /** quarterIndex() of the quarter the decisions were made in. */
  quarterIndex: number;
  /** granted / refused feed the rate; "other" is reported only. */
  outcome: "granted" | "refused" | "other";
  /** For outcome "other": the published label (e.g. "Withdrawn"). */
  otherLabel?: string;
  decisions: number;
}

/** What an adapter hands back after reading a downloaded release. */
export interface ReleaseReadResult {
  observations: OutcomeObservation[];
  /** The quarters (quarterIndex) present in `observations`, i.e. the window. */
  quarters: number[];
  /** Data rows read from the outcomes table. */
  rowsRead: number;
  /** Published nationality names that did not map to a code (kept anyway). */
  unmappedNames: string[];
  /** Tables / sheets the figures come from, as named in the file. */
  tableNames: string[];
  /** The publisher's caveats that must travel with the figures. */
  caveats: string[];
}

/** Thrown when the file's structure is not what the adapter expects. */
export class OutcomeSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutcomeSchemaError";
  }
}

/** The contract a destination implements. */
export interface OutcomeDataSourceAdapter {
  /** Destination country code this adapter serves (the lookup key). */
  readonly destination: string;

  /** Find the current release from the publisher's listing page. */
  discoverRelease(): Promise<ReleaseDescriptor>;

  /** Download the release file to `destPath`, hashing as it streams. */
  download(release: ReleaseDescriptor, destPath: string): Promise<{ sha256: string; bytes: number }>;

  /**
   * Validate the file's structure FIRST (throw OutcomeSchemaError on any
   * missing/renamed column, before reading data), then read it with a
   * streaming reader, keeping only the latest `windowQuarters` quarters.
   */
  read(path: string, windowQuarters: number): Promise<ReleaseReadResult>;
}
