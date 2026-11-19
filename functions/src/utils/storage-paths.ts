// ============================================
// Storage paths — the single definition of where uploads live, and the single
// check a client-supplied (or stored) path must pass (issue #141)
// ============================================
//
// HOW UPLOADS WORK
// Files never pass through the API. A client asks an "upload-url" endpoint for
// a short-lived signed PUT URL; the backend picks the object path and returns
// it as `storagePath`; the client PUTs the bytes and then calls a "register"
// endpoint, sending that same `storagePath` back. Later the backend signs a
// download URL for the path it stored.
//
// THE RULE THIS MODULE ENFORCES
// The path that comes back from the client is input like any other. A path is
// accepted only when it is exactly the kind of path the backend itself would
// have issued for THIS caller, THIS purpose and (where relevant) THIS
// application or agency:
//
//   purpose               issued shape
//   --------------------  ----------------------------------------------------
//   application-document  documents/{clientUid}/{applicationId}/{uuid}_{file}
//   agent-verification    verification/{agentUserUid}/{uuid}_{file}
//   compliance-document   compliance/{agencyId}/{slot}/{uuid}_{file}
//   agency-logo           agency-logos/{agencyId}/{uuid}_{file}
//   profile-photo         users/{uid}/profile/{uuid}_{file}
//   feedback-screenshot   users/{uid}/feedback/{uuid}_{file}   (issue #257)
//
// where `{uuid}` is a v4 UUID and `{file}` is the client's file name reduced
// to [A-Za-z0-9._-]. These shapes have not changed since each upload flow was
// first written, so there is no older format to accept.
//
// The same check runs again when a STORED path is about to be signed or
// deleted, so a record written before this module existed (or written by any
// future bug) cannot be turned into a download link or a delete either.
//
// Both sides use this file: services/storage.service.ts builds the issued
// path with `buildIssuedPath()`, and every register / download / delete path
// validates with `validateStoragePath()` against the same `StorageScope`, so
// the two cannot drift apart.
//
// Deliberately free of firebase imports: it is pure string logic, unit-tested
// in test/storage-paths/storage-paths.test.ts, and reused by the read-only
// audit script (scripts/audit-storage-paths.ts).

import { randomUUID } from "crypto";

// ============================================
// Backend-only prefixes
// ============================================

/**
 * Top-level prefixes that only backend jobs read and write. No client
 * endpoint may register, sign, publish or delete an object under them, for
 * ANY role (admins included: an admin who needs one of these files gets it
 * through the feature that owns it, not through a document record).
 *
 *  - `guidance-snapshots`: stored copies of official caseworker guidance,
 *    written by the guidance scraper (scrapers/guidance, issue #39).
 *  - `consultations`: call recordings; storage.rules already marks the prefix
 *    "only system can upload".
 *
 * The validator is an allow-list (only the five issued shapes above pass), so
 * a prefix missing from this list is still refused. The list exists so that
 * (a) the refusal is explicit and has its own reason code, and (b) the
 * storage service can refuse these prefixes outright even for a caller that
 * forgot to validate. Add a new backend-only prefix here when one is created.
 */
export const BACKEND_ONLY_PREFIXES: readonly string[] = ["guidance-snapshots", "consultations"];

// ============================================
// Scopes: who / what a path is expected to belong to
// ============================================

/** The compliance (KYC/KYB) document slots an agency can upload into. */
export const COMPLIANCE_DOCUMENT_SLOTS: readonly string[] = ["idDocument", "proofOfAddress", "cacDocument"];

/**
 * What a path is expected to belong to. Every id in a scope must come from
 * the SERVER's view of the request (the verified token's uid, an application
 * or agency loaded from Firestore), never from the path being checked.
 */
export type StorageScope =
  | {
      /** A document on a visa application. */
      purpose: "application-document";
      /**
       * The application's CLIENT (`application.userId`). Uploads made by an
       * agent on the client's behalf also land in the client's folder, so this
       * is the client's uid whoever the caller is.
       */
      ownerUserId: string;
      /** The application the document is registered against. */
      applicationId: string;
    }
  | {
      /** An agent's own verification (licence / ID) document. */
      purpose: "agent-verification";
      /** The agent's USER uid (not the agent document id). */
      userId: string;
    }
  | {
      /** An agency's KYC/KYB compliance document. */
      purpose: "compliance-document";
      agencyId: string;
      /**
       * Slots the path may sit in. Registration passes the one slot being
       * filled; reading a stored path passes every known slot, because the
       * register endpoint did not always tie the path to its slot.
       */
      slots: readonly string[];
    }
  | {
      /** An agency's white-label logo. */
      purpose: "agency-logo";
      agencyId: string;
    }
  | {
      /** A user's profile photo. */
      purpose: "profile-photo";
      userId: string;
    }
  | {
      /**
       * A screenshot attached to an in-app feedback note (issue #257). Private:
       * storage.rules has no match for `users/{uid}/feedback/`, so only the
       * backend (signed URLs) can touch it.
       */
      purpose: "feedback-screenshot";
      userId: string;
    };

/** Why a path was refused. Stable codes: logged, and printed by the audit. */
export type StoragePathIssue =
  | "NOT_A_STRING" // not a string at all (object, array, number…)
  | "EMPTY" // empty string
  | "TOO_LONG" // longer than any issued path can be
  | "HAS_SCHEME" // gs://…, https://…, or any other scheme / URL
  | "LEADING_SLASH" // starts with "/"
  | "BAD_CHARACTERS" // control characters, whitespace, backslash, or URL syntax
  | "EMPTY_SEGMENT" // "a//b" or a trailing "/"
  | "RESERVED_SEGMENT" // a "." or ".." segment
  | "BACKEND_ONLY_PREFIX" // under a prefix only backend jobs use
  | "INVALID_SCOPE" // the expected owner / application id is itself unusable
  | "WRONG_PREFIX" // a well-formed key, but not under the expected prefix
  | "NOT_AN_ISSUED_NAME"; // right folder, but not a `{uuid}_{file}` object in it

/** Result of checking a path. */
export type StoragePathCheck =
  | { ok: true; /** The validated bucket-relative key (identical to the input). */ key: string }
  | { ok: false; issue: StoragePathIssue };

/**
 * Thrown by services when a path from a REQUEST is refused. Controllers turn
 * it into a 400. The message is safe to show to the caller.
 */
export class StoragePathRejectedError extends Error {
  constructor(public readonly issue: StoragePathIssue) {
    super("storagePath must be the path returned by the upload-url endpoint for this upload");
    this.name = "StoragePathRejectedError";
  }
}

/**
 * Thrown by services when a path already STORED on a record is refused at the
 * moment it would be signed. Controllers turn it into a 409: the request was
 * fine, the record is not.
 */
export class StoredPathInvalidError extends Error {
  constructor(public readonly issue: StoragePathIssue) {
    super(
      "This file's stored location is not valid, so it cannot be opened. " +
        "Please upload the document again or contact support."
    );
    this.name = "StoredPathInvalidError";
  }
}

// ============================================
// Shapes
// ============================================

/** Longest object key we will look at (issued keys are far shorter). */
const MAX_KEY_LENGTH = 1024;

/**
 * An issued object name: a v4-style UUID, an underscore, then the sanitised
 * file name (see `sanitiseFileName`). Anything else in an upload folder was
 * not put there through an upload-url endpoint.
 */
const ISSUED_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}_[A-Za-z0-9._-]+$/;

/** Something that looks like `scheme:` at the start (gs:, http:, https:, file:, data:…). */
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/**
 * Characters that never appear in a path the backend issues and that have a
 * meaning somewhere between here and the bucket: ASCII control characters
 * and space (\x00-\x20), DEL (\x7f), backslash, and URL / wildcard syntax
 * (? # % * [ ]).
 */
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CHARACTERS = /[\x00-\x20\x7f\\?#%*[\]]/;

/** Reduce a client file name to the characters an issued object name may hold. */
export function sanitiseFileName(fileName: string): string {
  return fileName.replace(/[^a-zA-Z0-9.-]/g, "_");
}

/**
 * True when `id` can be used as ONE path segment: a non-empty string with no
 * separator, no forbidden character, and not "." / "..". Scope ids that fail
 * this are refused rather than interpolated into a prefix.
 */
function isSafeSegment(id: unknown): id is string {
  return (
    typeof id === "string" &&
    id.length > 0 &&
    !id.includes("/") &&
    id !== "." &&
    id !== ".." &&
    !FORBIDDEN_CHARACTERS.test(id)
  );
}

/**
 * The folder(s) a scope's uploads live in, each ending with "/". Returns null
 * when the scope's ids cannot form a safe prefix. More than one folder only
 * for compliance documents checked against several slots.
 */
function scopeFolders(scope: StorageScope): string[] | null {
  switch (scope.purpose) {
  case "application-document":
    if (!isSafeSegment(scope.ownerUserId) || !isSafeSegment(scope.applicationId)) return null;
    return [`documents/${scope.ownerUserId}/${scope.applicationId}/`];
  case "agent-verification":
    if (!isSafeSegment(scope.userId)) return null;
    return [`verification/${scope.userId}/`];
  case "compliance-document":
    if (!isSafeSegment(scope.agencyId) || scope.slots.length === 0 || !scope.slots.every(isSafeSegment)) return null;
    return scope.slots.map((slot) => `compliance/${scope.agencyId}/${slot}/`);
  case "agency-logo":
    if (!isSafeSegment(scope.agencyId)) return null;
    return [`agency-logos/${scope.agencyId}/`];
  case "profile-photo":
    if (!isSafeSegment(scope.userId)) return null;
    return [`users/${scope.userId}/profile/`];
  case "feedback-screenshot":
    if (!isSafeSegment(scope.userId)) return null;
    return [`users/${scope.userId}/feedback/`];
  default:
    return null;
  }
}

// ============================================
// Issuing
// ============================================

/**
 * Build the object path for a NEW upload in `scope` (which must name exactly
 * one folder). This is the only place issued paths are assembled, so whatever
 * it returns is by construction accepted by `validateStoragePath` for the
 * same scope.
 *
 * @throws when the scope's ids cannot form a safe prefix (a bug in the
 *   caller: ids come from the token and from Firestore document ids).
 */
export function buildIssuedPath(scope: StorageScope, fileName: string): string {
  const folders = scopeFolders(scope);
  if (!folders || folders.length !== 1) {
    throw new Error(`Cannot build a storage path for this ${scope.purpose} scope`);
  }
  return `${folders[0]}${randomUUID()}_${sanitiseFileName(fileName)}`;
}

// ============================================
// Checking
// ============================================

/**
 * Structural check only: is `raw` a normalised, bucket-relative object key
 * that a client endpoint may touch at all? It says nothing about WHOSE object
 * it is; use `validateStoragePath` for that.
 *
 * Refuses: non-strings, empty or oversized values, anything with a scheme or
 * bucket URL (gs://bucket/…, https://…), a leading slash, control characters
 * / whitespace / backslashes / URL syntax, empty segments, "." and ".."
 * segments, and every key under a backend-only prefix.
 */
export function checkStorageKey(raw: unknown): StoragePathCheck {
  if (typeof raw !== "string") return { ok: false, issue: "NOT_A_STRING" };
  if (raw.length === 0) return { ok: false, issue: "EMPTY" };
  if (raw.length > MAX_KEY_LENGTH) return { ok: false, issue: "TOO_LONG" };
  if (SCHEME.test(raw) || raw.includes("://")) return { ok: false, issue: "HAS_SCHEME" };
  if (raw.startsWith("/")) return { ok: false, issue: "LEADING_SLASH" };
  if (FORBIDDEN_CHARACTERS.test(raw)) return { ok: false, issue: "BAD_CHARACTERS" };

  const segments = raw.split("/");
  if (segments.some((s) => s.length === 0)) return { ok: false, issue: "EMPTY_SEGMENT" };
  if (segments.some((s) => s === "." || s === "..")) return { ok: false, issue: "RESERVED_SEGMENT" };
  if (BACKEND_ONLY_PREFIXES.includes(segments[0])) return { ok: false, issue: "BACKEND_ONLY_PREFIX" };

  return { ok: true, key: raw };
}

/**
 * The full check: `raw` is a well-formed key (see `checkStorageKey`) AND it
 * is an issued object directly inside the folder that `scope` owns.
 *
 * The caller is responsible for building `scope` from server-side facts and
 * for having authorised the caller for that application / agency first; this
 * function then guarantees the path cannot point anywhere else.
 */
export function validateStoragePath(raw: unknown, scope: StorageScope): StoragePathCheck {
  const structural = checkStorageKey(raw);
  if (!structural.ok) return structural;
  const key = structural.key;

  const folders = scopeFolders(scope);
  if (!folders) return { ok: false, issue: "INVALID_SCOPE" };

  const folder = folders.find((f) => key.startsWith(f));
  if (!folder) return { ok: false, issue: "WRONG_PREFIX" };

  // Exactly one more segment, and it must look like an issued object name.
  // (`ISSUED_NAME` has no "/", so a deeper path fails here too.)
  const name = key.slice(folder.length);
  if (!ISSUED_NAME.test(name)) return { ok: false, issue: "NOT_AN_ISSUED_NAME" };

  return { ok: true, key };
}

/**
 * Validate a path that arrived in a REQUEST. Returns the key, or throws
 * `StoragePathRejectedError` (→ 400, nothing stored).
 */
export function requireRequestedPath(raw: unknown, scope: StorageScope): string {
  const check = validateStoragePath(raw, scope);
  if (!check.ok) throw new StoragePathRejectedError(check.issue);
  return check.key;
}

/**
 * Validate a path read from a stored RECORD before it is signed. Returns the
 * key, or throws `StoredPathInvalidError` (→ 409, nothing signed).
 */
export function requireStoredPath(raw: unknown, scope: StorageScope): string {
  const check = validateStoragePath(raw, scope);
  if (!check.ok) throw new StoredPathInvalidError(check.issue);
  return check.key;
}

/**
 * Last line of defence inside the storage service: throw unless `raw` is a
 * well-formed key outside every backend-only prefix. Called by the methods
 * that sign, publish or delete an object, so even a caller that skipped
 * `validateStoragePath` cannot reach a backend-only object or pass a URL.
 */
export function assertClientReachableKey(raw: unknown): string {
  const check = checkStorageKey(raw);
  if (!check.ok) throw new StoredPathInvalidError(check.issue);
  return check.key;
}
