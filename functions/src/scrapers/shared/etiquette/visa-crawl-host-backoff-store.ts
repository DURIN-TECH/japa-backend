import { Timestamp } from "firebase-admin/firestore";
import type { VisaSourceHostBackoff } from "../../visa-catalog/types";
import type { HostBackoffEntry } from "./visa-crawl-host-state";

// ============================================
// VISA CATALOG — HOST BACKOFF STORAGE MAPPERS (issue #64)
// ============================================
//
// The ONE place that converts host backoffs between the pure helper's form
// (`HostBackoffEntry`, epoch ms — scrapers/shared/etiquette/visa-crawl-host-state.ts) and the
// Firestore form stored on `visaSources/{cc}.hostBackoffs`
// (`VisaSourceHostBackoff`, Timestamps). Shared by the scheduled orchestrator
// and the manual crawl script so both read stored entries the same way.
//
// This is also the swap point for issue #15: when host state moves to
// Firestore-backed per-host docs, only these mappers (and where they are
// loaded from / saved to) change; the tracker and crawl logic stay as they are.
//
// Importing `Timestamp` from firebase-admin/firestore does NOT require Admin
// init, so this module stays usable from the unit tests.

/** True for a Timestamp-like value (duck-typed, so a second copy of the SDK still works). */
function isTimestampLike(v: unknown): v is { toMillis(): number } {
  return Boolean(v) && typeof (v as { toMillis?: unknown }).toMillis === "function";
}

/**
 * Stored (Firestore) backoff entries -> the helper's ms form. Malformed
 * entries (no host, no `until` Timestamp) are dropped rather than throwing,
 * so one bad entry can never abort a crawl. A missing `recordedAt` falls back
 * to `until` (it is informational only; nothing schedules on it).
 */
export function hostBackoffEntriesFromSource(
  stored: readonly VisaSourceHostBackoff[] | undefined
): HostBackoffEntry[] {
  if (!Array.isArray(stored)) return [];
  return stored
    .filter((e) => e && typeof e.host === "string" && e.host !== "" && isTimestampLike(e.until))
    .map((e) => ({
      host: e.host,
      untilMs: e.until.toMillis(),
      status: e.status,
      recordedAtMs: isTimestampLike(e.recordedAt) ? e.recordedAt.toMillis() : e.until.toMillis(),
    }));
}

/** The helper's ms entries -> the Firestore form written to the source doc. */
export function hostBackoffEntriesToSource(entries: readonly HostBackoffEntry[]): VisaSourceHostBackoff[] {
  return entries.map((e) => ({
    host: e.host,
    until: Timestamp.fromMillis(e.untilMs),
    status: e.status,
    recordedAt: Timestamp.fromMillis(e.recordedAtMs),
  }));
}
