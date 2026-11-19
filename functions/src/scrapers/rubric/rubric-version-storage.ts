import { Timestamp } from "firebase-admin/firestore";
import type { VisaRubric } from "../../types/rubric";

// ============================================
// RUBRIC VERSION STORAGE LAYOUT (issue #278)
// ============================================
//
// WHY THIS EXISTS. A Firestore document holds at most 1 MiB (1,048,576 bytes).
// A rulebook version used to be ONE document, criteria and all. The UK Family
// draft (#260 run `975cf966`) came to 1,988,261 bytes: all 57 model calls ran
// (~$20) and then the save was refused. Student v1 and Skilled Worker v1 only
// just fit.
//
// THE LAYOUT. A version is still ONE document at
// `visaRubrics/{routeKey}/rubricVersions/{version}`, the HEADER: status,
// review fields, counts, hashes, flags-free provenance. When the whole
// version would be large, its large arrays (`CHUNKED_FIELDS` below: criteria,
// evidence items, intake questions, the discarded and suspicious lists,
// flags, quote translations) move into PART documents beside it:
//
//   visaRubrics/{routeKey}/rubricVersions/{version}                       header
//   visaRubrics/{routeKey}/rubricVersions/{version}/rubricVersionParts/{n}  part n (0-based)
//
// The header carries `contentStorage` (see `VersionContentStorage`): how many
// parts there are, which fields they hold, and how many items of each, so a
// reader can tell a complete read from a broken one.
//
// WHAT STAYS THE SAME.
//  - A SMALL version (estimated at or under `INLINE_MAX_BYTES`) is written
//    exactly as before: one document, no `contentStorage`, no parts. So every
//    version on dev today (Standard Visitor v2, Graduate v1, Student v1,
//    Skilled Worker v1) is simply a "legacy" single document and reads the way
//    it always did. NO MIGRATION: the read side tells the two layouts apart by
//    the presence of `contentStorage` (dual read).
//  - Header and parts are written in ONE transaction (rubric.store.ts), so a
//    reader never sees a header without its parts, and the version-created
//    trigger (index.ts `onRubricVersionCreated`) fires only once both exist.
//  - Parts are immutable, like the version's content. The review (#125) and
//    the automatic publisher only ever update REVIEW fields, which live on the
//    header.
//  - Values are stored as native Firestore values (maps, arrays, strings), not
//    as a JSON string, so a reassembled version is field-for-field what the
//    single document would have held (Timestamps stay Timestamps).
//
// THIS MODULE IS PURE: it computes sizes, splits a rubric into a header and
// parts, and puts them back together. It never touches Firestore; the store
// (rubric.store.ts) does the reads and writes.

// ============================================
// Limits
// ============================================

/**
 * At or under this estimated size, a version is written as ONE document,
 * exactly as before #278. Kept well under the 1 MiB document limit on purpose:
 * an approval later ADDS fields to the version document (the question plan,
 * rule repairs, layer conflicts), and those need headroom.
 */
export const INLINE_MAX_BYTES = 600_000;

/**
 * Most bytes of content put in one part document. Leaves room under the
 * 1 MiB limit for the part's own name and small fields, and for the estimate
 * being a little off.
 */
export const PART_MAX_BYTES = 700_000;

/**
 * Most bytes a whole version (header plus every part) may take. The header,
 * every part, the head and (for a background job) the job document and run
 * record are committed in ONE transaction, and a Firestore commit request is
 * capped at 10 MiB. 8,000,000 bytes keeps a clear margin under that. A
 * version this large is also far past anything a reviewer could read: it is
 * a sign the route needs splitting, not a bigger store.
 */
export const MAX_STORED_BYTES = 8_000_000;

/**
 * PRE-FLIGHT PROJECTION. Stored bytes expected per character of source text
 * sent to the model. Measured on dev: the UK Family run sent 608,864
 * characters and produced a 1,988,261-byte version (3.27 bytes per character).
 * Rounded UP to 4 so the projection errs towards refusing. Used before any
 * model call to refuse a run whose result could not be saved even split into
 * parts (`projectStoredBytes`).
 */
export const STORED_BYTES_PER_INPUT_CHAR = 4;

/** Collection id of the part documents under a version document. */
export const VERSION_PARTS_COLLECTION = "rubricVersionParts";

// ============================================
// Which fields move into parts
// ============================================

/**
 * The large fields of a version that are moved into parts, in the order they
 * are packed. `array` fields are lists; `record` fields are plain objects
 * (stored in a part as `{ key, value }` items, then rebuilt in the same key
 * order). Every other field stays on the header.
 */
export const CHUNKED_FIELDS = [
  { field: "criteria", kind: "array" },
  { field: "evidenceItems", kind: "array" },
  { field: "intakeQuestions", kind: "array" },
  { field: "discarded", kind: "array" },
  { field: "suspiciousPassages", kind: "array" },
  { field: "flags", kind: "array" },
  { field: "quoteTranslations", kind: "record" },
] as const;

/** Name of one chunked field. */
export type ChunkedField = (typeof CHUNKED_FIELDS)[number]["field"];

/**
 * Stored on the HEADER of a version written in parts. Absent on a version
 * written as one document (every version before #278, and every small one
 * after it). Never part of the served rubric: the store strips it on read.
 */
export interface VersionContentStorage {
  // Only one split layout exists today; the tag leaves room for another.
  layout: "parts";
  // How many part documents (ids "0" .. String(partCount - 1)).
  partCount: number;
  // The chunked fields this version HAS (a field absent from the draft, e.g.
  // `quoteTranslations` for an all-English route, is not listed and stays absent).
  fields: ChunkedField[];
  // How many items of each listed field, across all parts: the integrity check.
  itemCounts: Partial<Record<ChunkedField, number>>;
  // Estimated stored size of header plus parts, in bytes (for operators).
  storedBytes: number;
}

/** One part document. */
export interface VersionPartDoc {
  // 0-based position; also the document id (as a string).
  index: number;
  // Runs of items, in order. A field can continue from one part into the next.
  entries: { field: ChunkedField; items: unknown[] }[];
}

/** How a version is to be written. */
export type VersionLayout =
  // One document, exactly as before #278.
  | { kind: "inline"; doc: VisaRubric; storedBytes: number }
  // A header plus its parts.
  | { kind: "parts"; header: Record<string, unknown> & { contentStorage: VersionContentStorage }; parts: VersionPartDoc[]; storedBytes: number };

/** Why a version cannot be stored. */
export class VersionTooLargeError extends Error {
  constructor(
    readonly storedBytes: number,
    message: string
  ) {
    super(message);
    this.name = "VersionTooLargeError";
  }
}

/** A stored version that cannot be put back together (a part missing or short). */
export class VersionPartsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VersionPartsError";
  }
}

// ============================================
// Size estimation (Firestore's own rules)
// ============================================
//
// From the Firestore "storage size calculations" documentation:
//   string   UTF-8 bytes + 1        boolean / null   1
//   number   8                      timestamp        8
//   array    sum of its values      map              sum of (key size + value size)
//   field / key name   UTF-8 bytes + 1
//   document           name size + sum of its fields + 32
//   document name      sum over path segments of (UTF-8 bytes + 1) + 16
// `undefined` is not stored (the Admin SDK is set to ignore it).

/** UTF-8 byte length of a string. */
function utf8(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

/**
 * Estimated stored size of one value, by Firestore's rules. Anything with a
 * `toMillis` (a Timestamp) or a Date counts 8 bytes; an unknown object is
 * counted as a map of its own enumerable fields.
 */
export function firestoreValueSize(value: unknown): number {
  if (value === undefined) return 0;
  if (value === null || typeof value === "boolean") return 1;
  if (typeof value === "number" || typeof value === "bigint") return 8;
  if (typeof value === "string") return utf8(value) + 1;
  if (value instanceof Timestamp || value instanceof Date) return 8;
  if (Array.isArray(value)) {
    let n = 0;
    for (const v of value) n += firestoreValueSize(v);
    return n;
  }
  if (typeof value === "object") {
    // Duck-typed Timestamp (e.g. from another copy of the SDK, or a test double).
    if (typeof (value as { toMillis?: unknown }).toMillis === "function") return 8;
    let n = 0;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue;
      n += utf8(k) + 1 + firestoreValueSize(v);
    }
    return n;
  }
  return 0;
}

/** Estimated size of a document name from its slash-separated path. */
export function firestoreNameSize(docPath: string): number {
  return docPath.split("/").reduce((n, seg) => n + utf8(seg) + 1, 0) + 16;
}

/** Estimated stored size of a whole document. */
export function firestoreDocSize(docPath: string, data: Record<string, unknown>): number {
  return firestoreNameSize(docPath) + firestoreValueSize(data) + 32;
}

/**
 * PRE-FLIGHT: the stored size a run is expected to produce from the number of
 * characters it will send to the model. Deliberately pessimistic (see
 * `STORED_BYTES_PER_INPUT_CHAR`).
 */
export function projectStoredBytes(inputChars: number): number {
  return Math.ceil(Math.max(0, inputChars) * STORED_BYTES_PER_INPUT_CHAR);
}

// ============================================
// Split
// ============================================

/** Bytes a part spends on its own fields beyond the items (name, index, entry keys). Rounded up. */
const PART_OVERHEAD_BYTES = 2_048;

/**
 * Decide how to store one version and build the documents.
 *
 * @param rubric the complete version, as it would have been one document.
 * @param versionDocPath the version document's path (`visaRubrics/{key}/rubricVersions/{v}`),
 *   for the name part of the size estimate.
 * @throws VersionTooLargeError when the version cannot be stored even in parts:
 *   over `MAX_STORED_BYTES` in total, a header that would not fit on its own,
 *   or one single item larger than a part can hold. Nothing is cut or dropped
 *   to make it fit: a rule must never be lost for size.
 */
export function layoutVersion(rubric: VisaRubric, versionDocPath: string): VersionLayout {
  const asRecord = rubric as unknown as Record<string, unknown>;
  const wholeBytes = firestoreDocSize(versionDocPath, asRecord);
  // ---- small: one document, as before #278 ----
  if (wholeBytes <= INLINE_MAX_BYTES) return { kind: "inline", doc: rubric, storedBytes: wholeBytes };

  // ---- large: header + parts ----
  const header: Record<string, unknown> = { ...asRecord };
  const fields: ChunkedField[] = [];
  const itemCounts: Partial<Record<ChunkedField, number>> = {};
  // Every item to pack, in field order then item order.
  const queue: { field: ChunkedField; item: unknown; bytes: number }[] = [];
  for (const { field, kind } of CHUNKED_FIELDS) {
    const value = asRecord[field];
    delete header[field];
    if (value === undefined || value === null) continue;
    const items: unknown[] = kind === "array" ? (Array.isArray(value) ? value : []) : Object.entries(value as Record<string, unknown>).map(([key, v]) => ({ key, value: v }));
    fields.push(field);
    itemCounts[field] = items.length;
    for (const item of items) queue.push({ field, item, bytes: firestoreValueSize(item) });
  }

  // Pack greedily, keeping order. A new part starts when the next item would
  // push the current one past PART_MAX_BYTES.
  const partPath = `${versionDocPath}/${VERSION_PARTS_COLLECTION}/000`;
  const budget = PART_MAX_BYTES - firestoreNameSize(partPath) - PART_OVERHEAD_BYTES;
  const parts: VersionPartDoc[] = [];
  let current: VersionPartDoc = { index: 0, entries: [] };
  let currentBytes = 0;
  for (const { field, item, bytes } of queue) {
    if (bytes > budget) {
      throw new VersionTooLargeError(wholeBytes, `one ${field} item alone is about ${bytes} bytes, more than a part document can hold (${budget})`);
    }
    if (currentBytes + bytes > budget && currentBytes > 0) {
      parts.push(current);
      current = { index: parts.length, entries: [] };
      currentBytes = 0;
    }
    const last = current.entries[current.entries.length - 1];
    if (last && last.field === field) last.items.push(item);
    else {
      current.entries.push({ field, items: [item] });
      // The entry's own keys ("field", its value, "items").
      currentBytes += utf8("field") + 1 + utf8(field) + 1 + utf8("items") + 1;
    }
    currentBytes += bytes;
  }
  if (current.entries.length > 0 || parts.length === 0) parts.push(current);

  // ---- totals and the hard bounds ----
  const partBytes = parts.reduce((n, p) => n + firestoreDocSize(`${versionDocPath}/${VERSION_PARTS_COLLECTION}/${p.index}`, p as unknown as Record<string, unknown>), 0);
  const contentStorage: VersionContentStorage = { layout: "parts", partCount: parts.length, fields, itemCounts, storedBytes: 0 };
  const headerDoc = { ...header, contentStorage };
  const headerBytes = firestoreDocSize(versionDocPath, headerDoc) + 16;
  const storedBytes = headerBytes + partBytes;
  contentStorage.storedBytes = storedBytes;
  if (headerBytes > PART_MAX_BYTES) {
    throw new VersionTooLargeError(storedBytes, `the version's header alone is about ${headerBytes} bytes, more than one document can safely hold (${PART_MAX_BYTES})`);
  }
  if (storedBytes > MAX_STORED_BYTES) {
    throw new VersionTooLargeError(storedBytes, `the version is about ${storedBytes} bytes, more than the ${MAX_STORED_BYTES}-byte bound for one version; split the route`);
  }
  return { kind: "parts", header: headerDoc, parts, storedBytes };
}

// ============================================
// Read: tell the layouts apart, put a split version back together
// ============================================

/** True when a stored version document is a HEADER whose content lives in parts. */
export function isPartitioned(data: unknown): data is Record<string, unknown> & { contentStorage: VersionContentStorage } {
  const cs = (data as { contentStorage?: Partial<VersionContentStorage> } | null | undefined)?.contentStorage;
  return !!cs && cs.layout === "parts" && typeof cs.partCount === "number" && Array.isArray(cs.fields);
}

/**
 * Put a split version back together. The result is the version exactly as one
 * document would have held it, WITHOUT `contentStorage`.
 *
 * @param header the version document's data (with `contentStorage`).
 * @param parts the part documents' data, by index (`parts[i]` is part i, or
 *   undefined when that document does not exist).
 * @throws VersionPartsError when a part is missing or the item counts do not
 *   add up. A reader must never get half a rulebook.
 */
export function assembleVersion(header: Record<string, unknown> & { contentStorage: VersionContentStorage }, parts: readonly (VersionPartDoc | undefined)[]): VisaRubric {
  const cs = header.contentStorage;
  const out: Record<string, unknown> = { ...header };
  delete out.contentStorage;
  // Collect the items of each field, in part order.
  const collected = new Map<ChunkedField, unknown[]>(cs.fields.map((f) => [f, []]));
  for (let i = 0; i < cs.partCount; i++) {
    const part = parts[i];
    if (!part || !Array.isArray(part.entries)) throw new VersionPartsError(`part ${i} of ${cs.partCount} is missing`);
    for (const entry of part.entries) {
      const list = collected.get(entry.field);
      if (!list) throw new VersionPartsError(`part ${i} holds a field the header does not list (${String(entry.field)})`);
      for (const item of entry.items ?? []) list.push(item);
    }
  }
  // Rebuild each field in its stored kind, and check the counts.
  for (const { field, kind } of CHUNKED_FIELDS) {
    const items = collected.get(field);
    if (!items) continue;
    const expected = cs.itemCounts[field] ?? 0;
    if (items.length !== expected) throw new VersionPartsError(`${field}: ${items.length} item(s) read, ${expected} expected`);
    if (kind === "array") out[field] = items;
    else {
      const record: Record<string, unknown> = {};
      for (const it of items as { key: string; value: unknown }[]) record[it.key] = it.value;
      out[field] = record;
    }
  }
  return out as unknown as VisaRubric;
}
