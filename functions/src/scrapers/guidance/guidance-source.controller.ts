import { Response } from "express";
import type { Timestamp } from "firebase-admin/firestore";
import { AuthenticatedRequest } from "../../middleware/auth";
import { asSubject, can, forbidden } from "../../middleware/authz";
import { collections, db } from "../../utils/firebase";
import { ErrorMessages, sendError, sendSuccess } from "../../utils/response";
import { sourceLeaseService } from "../shared/runs/source-lease";
import { guidanceCrawlService } from "./guidance-crawl.service";
import type { GuidanceSource } from "./types";

// ============================================
// ADMIN — GUIDANCE SOURCE REGISTRY (issue #39)
// ============================================
//
// Mounted at /admin/guidance-sources (guidance-source.routes.ts). The list is
// read-only; the one write is the admin retry, POST /:id/crawl (issue #143).
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
  // Issue #111, for a source whose address is looked up on a parent page:
  // that page, and the address it gave at the last successful fetch.
  resolveFromPageUrl: string | null;
  resolvedUrl: string | null;
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
  // Issue #143: the last time OUR Storage / Firestore failed while handling
  // this source (redacted, capped), and when. null when there is none (or the
  // source has been crawled successfully since). Not part of the failure
  // streak: `consecutiveFailures` / `status` never move for these.
  lastInfrastructureError: string | null;
  lastInfrastructureErrorAt: string | null;
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
    resolveFromPageUrl: str(data.resolveFrom?.pageUrl),
    resolvedUrl: str(data.resolvedUrl),
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
    lastInfrastructureError: str(data.lastInfrastructureError),
    lastInfrastructureErrorAt: iso(data.lastInfrastructureErrorAt),
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

  /**
   * POST /admin/guidance-sources/:id/crawl (issue #143)
   * Crawl exactly this source now, due or not, `failing` included: the admin
   * retry. It is `runOrchestrator({ sourceIds: [id] })`, so it writes a
   * `scrapeRuns` doc (kind "guidance", trigger "manual"), takes the source's
   * lease, ignores the infrastructure backoff, and on success puts the source
   * back to `active` (failure streak, auto-pause flags and the infra counter
   * cleared).
   *
   * Answers: 401 (no token, verifyAuth) / 403 (not an admin) / 404 (id not in
   * the registry) / 409 RUN_IN_PROGRESS with the lease holder / 200 with the
   * outcome of the source and the updated registry item. Nothing is read
   * before the admin gate.
   */
  async crawl(req: AuthenticatedRequest, res: Response): Promise<void> {
    // Admin gate first, same ability as the list.
    if (!can(req, "read", asSubject("ScrapeRun", {}))) {
      forbidden(res, "Only admins can crawl guidance sources");
      return;
    }
    const id = (req.params as { id?: string }).id ?? "";
    try {
      // An id that is not in the registry (including a malformed one) is a
      // 404; the crawl itself also reports a stale id as a run warning.
      const ref = collections.guidanceSources.doc(id);
      const snap = await ref.get();
      if (!snap.exists) {
        sendError(res, "NOT_FOUND", `Guidance source ${id.slice(0, 80)} is not in the registry`, 404);
        return;
      }

      // Pre-flight: someone else already crawling this source -> 409 with the
      // holder, BEFORE a run record is written for a retry that cannot run.
      // (The orchestrator takes the lease for real; if a run slips in between
      // this check and that, the source line says `lease_held` and we answer
      // 409 below as well.)
      const held = await db.runTransaction((tx) => sourceLeaseService.heldIn(tx, "guidance", id));
      if (held) {
        res.status(409).json({
          success: false,
          error: "RUN_IN_PROGRESS",
          message: "This source is being crawled by another run; try again when it finishes",
          holder: held.holder,
        });
        return;
      }

      const summary = await guidanceCrawlService.runOrchestrator({ sourceIds: [id], trigger: "manual" });
      const result = summary.results.find((r) => r.sourceId === id);
      if (result?.outcome === "lease_held") {
        res.status(409).json({
          success: false,
          error: "RUN_IN_PROGRESS",
          message: result.error ?? "This source is being crawled by another run",
        });
        return;
      }

      // The registry item AFTER the crawl, so the caller sees the un-failed
      // status / cleared counters without a second request.
      const after = await ref.get();
      sendSuccess(res, {
        outcome: result?.outcome ?? "not_crawled",
        error: result?.error ?? null,
        errorKind: result?.errorKind ?? null,
        warnings: summary.warnings,
        source: after.exists ? toGuidanceSourceListItem(id, after.data() as Partial<GuidanceSource>) : null,
      });
    } catch (error) {
      console.error("Error crawling guidance source:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }
}

export const guidanceSourceController = new GuidanceSourceController();
