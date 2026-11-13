import { Response } from "express";
import { Timestamp } from "firebase-admin/firestore";
import { AuthenticatedRequest } from "../../middleware/auth";
import { asSubject, can, forbidden } from "../../middleware/authz";
import { collections } from "../../utils/firebase";
import { ErrorMessages, sendError, sendSuccess } from "../../utils/response";
import type { OutcomeImportRun } from "../../types/outcome-statistics";
import { registeredDestinations } from "./registry";

// ============================================
// ADMIN: OUTCOME STATISTICS IMPORTS (issue #116)
// ============================================
//
// Mounted at /admin/outcome-statistics (outcome-statistics.routes.ts).
//   GET  /runs  list import runs (newest first)
//   POST /runs  ask for a manual import ("Run now")
//
// `verifyAuth` runs first (no token -> 401). Each handler then checks the
// shared CASL ability BEFORE any Firestore access, so a non-admin gets 403
// `FORBIDDEN` and learns nothing. The gate is the admin-only `ScrapeRun`
// subject, like the other scraper monitoring routes (guidance sources, scrape
// runs): `read` to list, `update` to trigger.
//
// These routes expose RUN RECORDS only. There is no route that returns the
// statistics themselves: the numbers reach an applicant only through the
// assessment (behind checkApplicationAccess).

/** Default and maximum page size of the run list. */
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

/** A request still queued/running newer than this blocks another manual run. */
const REQUEST_BLOCK_MS = 15 * 60 * 1000;

const iso = (v: unknown): string | null => {
  const ts = v as Timestamp | null | undefined;
  return ts && typeof ts.toDate === "function" ? ts.toDate().toISOString() : null;
};

/** Explicit field-by-field mapping, so a field added later is not exposed by accident. */
export function toRunListItem(id: string, r: Partial<OutcomeImportRun>) {
  return {
    id,
    destination: r.destination ?? "",
    trigger: r.trigger ?? "scheduled",
    result: r.result ?? "failed",
    startedAt: iso(r.startedAt),
    finishedAt: iso(r.finishedAt),
    releaseDate: r.releaseDate ?? null,
    releaseLabel: r.releaseLabel ?? null,
    fileName: r.fileName ?? null,
    fileHash: r.fileHash ?? null,
    period: r.period ?? null,
    releaseId: r.releaseId ?? null,
    counts: r.counts ?? null,
    unmappedNames: r.unmappedNames ?? [],
    error: r.error ?? null,
    note: r.note ?? null,
  };
}

class OutcomeStatisticsController {
  /** GET /admin/outcome-statistics/runs?limit=&destination= */
  async listRuns(req: AuthenticatedRequest, res: Response): Promise<void> {
    if (!can(req, "read", asSubject("ScrapeRun", {}))) {
      forbidden(res, "Only admins can view outcome statistics imports");
      return;
    }
    try {
      const rawLimit = Number(req.query.limit);
      const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, MAX_LIMIT) : DEFAULT_LIMIT;
      const destination = typeof req.query.destination === "string" ? req.query.destination : null;

      let q: FirebaseFirestore.Query = collections.outcomeStatisticsRuns;
      if (destination) q = q.where("destination", "==", destination);
      const snap = await q.orderBy("startedAt", "desc").limit(limit).get();
      sendSuccess(res, { runs: snap.docs.map((d) => toRunListItem(d.id, d.data() as Partial<OutcomeImportRun>)) });
    } catch (error) {
      console.error("Error listing outcome statistics runs:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * POST /admin/outcome-statistics/runs  body: { destination }
   * Writes a run request and returns 202 at once; the Firestore trigger
   * (processOutcomeStatisticsRunRequest, 2 GB) runs the import, because an
   * import does not fit the API function's memory. Poll GET /runs for the result.
   */
  async requestRun(req: AuthenticatedRequest, res: Response): Promise<void> {
    if (!can(req, "update", asSubject("ScrapeRun", {}))) {
      forbidden(res, "Only admins can start an outcome statistics import");
      return;
    }
    try {
      const destination = typeof req.body?.destination === "string" ? req.body.destination.trim().toUpperCase() : "";
      if (!registeredDestinations().includes(destination)) {
        sendError(res, "VALIDATION_ERROR", `destination must be one of: ${registeredDestinations().join(", ")}`, 400);
        return;
      }
      // Don't pile up requests: one queued/running request per destination.
      const open = await collections.outcomeStatisticsRunRequests
        .where("destination", "==", destination)
        .where("status", "in", ["queued", "running"])
        .get();
      const blocking = open.docs.some((d) => {
        const at = (d.data().requestedAt as Timestamp | undefined)?.toMillis() ?? 0;
        return Date.now() - at < REQUEST_BLOCK_MS;
      });
      if (blocking) {
        sendError(res, "CONFLICT", "An import for this destination is already queued or running", 409);
        return;
      }
      const ref = collections.outcomeStatisticsRunRequests.doc();
      await ref.set({
        destination,
        status: "queued",
        requestedBy: req.user?.uid ?? null,
        requestedAt: Timestamp.now(),
      });
      sendSuccess(res, { requestId: ref.id, status: "queued" }, "Import requested", 202);
    } catch (error) {
      console.error("Error requesting outcome statistics import:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }
}

export const outcomeStatisticsController = new OutcomeStatisticsController();
