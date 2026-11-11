import { createHash } from "crypto";
import { storage } from "../../utils/firebase";
import {
  GUIDANCE_SNAPSHOT_SCHEMA_VERSION,
  type GuidanceDocType,
  type GuidanceSnapshotContent,
  type GuidanceSnapshotPage,
} from "./types";

// ============================================
// GUIDANCE — SNAPSHOT TEXT STORE (issue #39)
// ============================================
//
// Keeps the cleaned text of each fetched guidance document, so later stages
// (rubric extraction #40, the rubric admin API #125, the golden set #35) can
// check a quoted passage against EXACTLY what was fetched. One JSON object per
// snapshot in Cloud Storage:
//
//   guidance-snapshots/{sourceId}/{contentHash}.json
//
// The key is the sha256 of the cleaned text, so the same content always maps
// to the same object. The text is in Storage rather than Firestore because a
// long PDF can exceed Firestore's 1 MiB document limit; the Firestore side
// (guidanceSources/{id}/snapshots/{hash}) holds metadata only.
//
// ---- Immutable ----
//
// An object is written with the precondition "only if it does not exist yet"
// (`ifGenerationMatch: 0`). A second write of the same key is refused by
// Storage itself (HTTP 412), which this store reports as "already there":
// nothing is overwritten, ever. There is no update or delete method here.
//
// ---- Internal only: never served to a client ----
//
// The text is a copy of someone else's publication, kept for quote
// validation, NOT for re-publishing. Three things keep it unreachable:
//  1. Storage rules: storage.rules has no `match` for `guidance-snapshots/`
//     and no catch-all, so the client SDKs are denied (rules deny by default).
//     Only the Admin SDK, which this backend runs as, can read the object.
//  2. No URL is ever made for it: objects are saved private (no `public`
//     flag, no ACL change), with no Firebase download token and no signed
//     URL; this store exposes no method that returns a URL.
//  3. No API route returns the text: the only guidance route is the admin
//     list (guidance-source.controller.ts), which returns registry fields.
//     `read()` below is for backend code only.
//
// ---- Per project ----
//
// The bucket is the Admin app's DEFAULT bucket, which utils/firebase.ts
// derives from the running project's id. No bucket name appears here, so the
// dev backend can never write into (or read from) another project's bucket.

/** Folder (object-name prefix) every snapshot lives under. */
export const GUIDANCE_SNAPSHOT_PREFIX = "guidance-snapshots";

/** A source id is a slug: lowercase letters, digits and inner hyphens. */
export const GUIDANCE_SOURCE_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** A content hash is a sha256 in lowercase hex. */
export const CONTENT_HASH_RE = /^[a-f0-9]{64}$/;

/** sha256 (hex) of a text: the same function the fetch service hashes with. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Object name of a snapshot. Both parts are validated first, so neither can
 * carry a `/` or `..` and steer the write outside the snapshot folder.
 */
export function guidanceSnapshotPath(sourceId: string, contentHash: string): string {
  if (!GUIDANCE_SOURCE_ID_RE.test(sourceId)) throw new Error(`Invalid guidance source id: ${JSON.stringify(sourceId)}`);
  if (!CONTENT_HASH_RE.test(contentHash)) throw new Error(`Invalid content hash: ${JSON.stringify(contentHash)}`);
  return `${GUIDANCE_SNAPSHOT_PREFIX}/${sourceId}/${contentHash}.json`;
}

// ----- Minimal bucket surface (so tests can inject an in-memory one) -----

/** The part of a Cloud Storage file this store uses. */
export interface SnapshotFile {
  save(
    data: string,
    options: {
      resumable: boolean;
      contentType: string;
      preconditionOpts: { ifGenerationMatch: number };
      metadata: { cacheControl: string; metadata: Record<string, string> };
    }
  ): Promise<void>;
  download(): Promise<[Buffer]>;
}

/** The part of a Cloud Storage bucket this store uses. */
export interface SnapshotBucket {
  file(name: string): SnapshotFile;
}

/** What `write()` needs to build the stored object. */
export interface SnapshotWriteInput {
  sourceId: string;
  docType: GuidanceDocType;
  url: string;
  finalUrl: string;
  fetchedAtMs: number;
  // The whole cleaned text (what was hashed).
  text: string;
  // Per-page text for a PDF (`pages[0]` is page 1); omitted for a web page.
  pages?: readonly string[];
}

/** Result of `write()`. */
export interface SnapshotWriteResult {
  contentHash: string;
  storagePath: string;
  // UTF-8 size of the cleaned text (not of the JSON envelope).
  byteLength: number;
  // false when an object with this hash was already stored (nothing written).
  created: boolean;
}

/** True for the error Storage raises when a write precondition fails. */
function isPreconditionFailed(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 412 || code === "412";
}

/** Reads and writes snapshot text. Stateless; the bucket is resolved lazily. */
export class GuidanceSnapshotStore {
  /**
   * @param bucket a bucket to use instead of the project's default (tests).
   *   Production passes nothing, and the default bucket is looked up on first
   *   use, so importing this module never touches Storage.
   */
  constructor(private readonly bucket?: SnapshotBucket) {}

  /** The bucket in use: the injected one, else this project's default. */
  private resolveBucket(): SnapshotBucket {
    // `storage.bucket()` with no name = the Admin app's `storageBucket`,
    // derived per project in utils/firebase.ts. Never a hard-coded name.
    return this.bucket ?? (storage.bucket() as unknown as SnapshotBucket);
  }

  /**
   * Store a snapshot's text under its content hash, unless it is already
   * stored. Never overwrites: see "Immutable" at the top of the file.
   */
  async write(input: SnapshotWriteInput): Promise<SnapshotWriteResult> {
    const contentHash = sha256Hex(input.text);
    const storagePath = guidanceSnapshotPath(input.sourceId, contentHash);
    const byteLength = Buffer.byteLength(input.text, "utf8");

    // Page numbers are stored explicitly (1-based) so a consumer never has to
    // infer them from an array index.
    const pages: GuidanceSnapshotPage[] | null = input.pages
      ? input.pages.map((text, i) => ({ page: i + 1, text }))
      : null;
    const content: GuidanceSnapshotContent = {
      schemaVersion: GUIDANCE_SNAPSHOT_SCHEMA_VERSION,
      sourceId: input.sourceId,
      contentHash,
      docType: input.docType,
      url: input.url,
      finalUrl: input.finalUrl,
      fetchedAt: new Date(input.fetchedAtMs).toISOString(),
      text: input.text,
      pages,
    };

    try {
      await this.resolveBucket()
        .file(storagePath)
        .save(JSON.stringify(content), {
          // One request: the precondition below is checked atomically with it.
          resumable: false,
          contentType: "application/json; charset=utf-8",
          // Create only: generation 0 means "no live object with this name".
          preconditionOpts: { ifGenerationMatch: 0 },
          metadata: {
            // Never cached by an intermediary, should a URL ever exist.
            cacheControl: "private, no-store",
            // Custom metadata for anyone browsing the bucket. Deliberately NO
            // `firebaseStorageDownloadTokens`: no download URL can be built.
            metadata: { sourceId: input.sourceId, contentHash, docType: input.docType },
          },
        });
      return { contentHash, storagePath, byteLength, created: true };
    } catch (err) {
      // Same key = same text (the key is its hash), so an existing object is
      // already the right one. Anything else is a real failure.
      if (isPreconditionFailed(err)) return { contentHash, storagePath, byteLength, created: false };
      throw err;
    }
  }

  /**
   * Read a snapshot's stored object. BACKEND USE ONLY (quote validation): do
   * not return the result from an API route. The text is re-hashed and must
   * match the key, so a corrupted or swapped object is refused, not trusted.
   */
  async read(sourceId: string, contentHash: string): Promise<GuidanceSnapshotContent> {
    const storagePath = guidanceSnapshotPath(sourceId, contentHash);
    const [bytes] = await this.resolveBucket().file(storagePath).download();
    const content = JSON.parse(bytes.toString("utf8")) as GuidanceSnapshotContent;
    if (typeof content?.text !== "string" || sha256Hex(content.text) !== contentHash) {
      throw new Error(`Guidance snapshot ${storagePath} does not match its content hash`);
    }
    return content;
  }
}

/** Singleton over the project's default bucket. */
export const guidanceSnapshotStore = new GuidanceSnapshotStore();
