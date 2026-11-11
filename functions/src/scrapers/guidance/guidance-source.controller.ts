import { Response } from "express";
import type { Timestamp } from "firebase-admin/firestore";
import { AuthenticatedRequest } from "../../middleware/auth";
import { asSubject, can, forbidden } from "../../middleware/authz";
import { collections } from "../../utils/firebase";
import { ErrorMessages, sendError, sendSuccess } from "../../utils/response";
import type { GuidanceSource } from "./types";

// ============================================
// ADMIN — GUIDANCE SOURCE REGISTRY (issue #39)
// ============================================
//
// Mounted at /admin/guidance-sources (guidance-source.routes.ts). Read-only.
// `verifyAuth` runs first (no token -> 401); the handler then checks the
// shared CASL ability BEFORE any Firestore read, so a non-admin gets 403
// `FORBIDDEN` and learns nothing about the registry.
//
// The gate is `read ScrapeRun`: the admin-only subject the other scraper
// monitoring routes use (scrape runs, source health, costs). @durin-tech/authz
// has no subject of its own for guidance yet; when one is added, swap it in
// here. Only admins hold this ability.
//
// What is returned: registry and crawl-state FIELDS only. Snapshot text is
// never read here (this module does not import the snapshot store), and the
// Storage path of a snapshot is not returned either.
//
// All dates are ISO-8601 strings, like the other admin scraper routes.

/** One registry entry as the admin list returns it. */
export interface GuidanceSourceListItem {
  id: string;
  title: string;
  url: string;
  finalUrl: string | null;
  jurisdiction: string;
  route: string;
  docType: string;
  checkIntervalHours: number;
  status: string;
  verificationStatus: string;
  verificationNote: string;
  retrievedAt: string | null;
  retrievalError: string | null;
  lastFetchedAt: string | null;
  lastAttemptAt: string | null;
  lastContentHash: string | null;
  lastChangedAt: string | null;
  latestSnapshotId: string | null;
  publishedDate: string | null;
  publishedDateText: string | null;
  consecutiveFailures: number;
  lastError: string | null;
  lastErrorKind: string | null;
  lastErrorAt: string | null;
  backoffUntil: string | null;
}

/** Firestore Timestamp -> ISO string (null when absent or not a Timestamp). */
function iso(value: unknown): string | null {
  const ts = value as Timestamp | null | undefined;
  return ts && typeof ts.toDate === "function" ? ts.toDate().toISOString() : null;
}

/** String field or null. */
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/**
 * Map a stored doc to its list item. An explicit field-by-field copy (not a
 * spread), so a field added to the doc later is not exposed by accident.
 */
export function toGuidanceSourceListItem(id: string, data: Partial<GuidanceSource>): GuidanceSourceListItem {
  return {
    id,
    title: str(data.title) ?? id,
    url: str(data.url) ?? "",
    finalUrl: str(data.finalUrl),
    jurisdiction: str(data.jurisdiction) ?? "",
    route: str(data.route) ?? "",
    docType: str(data.docType) ?? "",
    checkIntervalHours: typeof data.checkIntervalHours === "number" ? data.checkIntervalHours : 0,
    status: str(data.status) ?? "active",
    verificationStatus: str(data.verificationStatus) ?? "unverified",
    verificationNote: str(data.verificationNote) ?? "",
    retrievedAt: iso(data.retrievedAt),
    retrievalError: str(data.retrievalError),
    lastFetchedAt: iso(data.lastFetchedAt),
    lastAttemptAt: iso(data.lastAttemptAt),
    lastContentHash: str(data.lastContentHash),
    lastChangedAt: iso(data.lastChangedAt),
    latestSnapshotId: str(data.latestSnapshotId),
    publishedDate: str(data.publishedDate),
    publishedDateText: str(data.publishedDateText),
    consecutiveFailures: typeof data.consecutiveFailures === "number" ? data.consecutiveFailures : 0,
    lastError: str(data.lastError),
    lastErrorKind: str(data.lastErrorKind),
    lastErrorAt: iso(data.lastErrorAt),
    backoffUntil: iso(data.backoffUntil),
  };
}

class GuidanceSourceController {
  /**
   * GET /admin/guidance-sources
   * Every registry entry, sorted by jurisdiction, route, then id. The
   * registry is small, so there is no pagination and no query (and so no
   * composite index).
   */
  async list(req: AuthenticatedRequest, res: Response): Promise<void> {
    // Admin gate first: nothing is read for anyone else.
    if (!can(req, "read", asSubject("ScrapeRun", {}))) {
      forbidden(res, "Only admins can view guidance sources");
      return;
    }
    try {
      const snap = await collections.guidanceSources.get();
      const sources = snap.docs
        .map((d) => toGuidanceSourceListItem(d.id, d.data() as Partial<GuidanceSource>))
        .sort(
          (a, b) =>
            a.jurisdiction.localeCompare(b.jurisdiction) || a.route.localeCompare(b.route) || a.id.localeCompare(b.id)
        );
      sendSuccess(res, { sources, total: sources.length });
    } catch (error) {
      console.error("Error listing guidance sources:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }
}

export const guidanceSourceController = new GuidanceSourceController();
