import { Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import { asSubject, can, forbidden } from "../middleware/authz";
import { sendError, sendSuccess, ErrorMessages } from "../utils/response";
import {
  InvalidCursorError,
  SCRAPE_RUN_LIST_DEFAULT_LIMIT,
  SCRAPE_RUN_LIST_MAX_LIMIT,
  scrapeRunService,
  type ListRunsQuery,
} from "../services/scrape-run.service";
import {
  SCRAPE_RUN_KINDS,
  SCRAPE_RUN_STATUSES,
  type ScrapeRunKind,
  type ScrapeRunStatus,
} from "../types/scrape-run";

// ============================================
// ADMIN — SCRAPE RUNS + SOURCE HEALTH (issue #81)
// ============================================
//
// Mounted at /admin/scrape-runs and /admin/scrape-sources
// (routes/scrape-run.routes.ts). Every route runs `verifyAuth` first (no
// token → 401), then checks the shared CASL ability for `read` on the
// `ScrapeRun` subject (@durin-tech/authz 0.1.5, admin-only) → 403 otherwise,
// BEFORE any validation or Firestore read so nothing leaks to non-admins.
//
// All dates in responses are ISO-8601 strings (not Firestore Timestamp
// objects), so the portal can pass them straight to its date helpers.

/** Run ids are Firestore auto ids: letters/digits, 1–128 chars. */
const RUN_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Parse a `from` / `to` bound: an ISO-8601 date/time ("2026-11-01",
 * "2026-11-01T02:00:00Z") or epoch milliseconds. undefined = invalid.
 */
function parseDateParam(raw: string): number | undefined {
  if (/^\d{10,16}$/.test(raw)) return Number(raw);
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? undefined : ms;
}

class ScrapeRunController {
  /** CASL gate shared by every handler: 403 and false when not allowed. */
  private allowed(req: AuthenticatedRequest, res: Response, id?: string): boolean {
    if (can(req, "read", asSubject("ScrapeRun", id ? { id } : {}))) return true;
    forbidden(res, "Only admins can view scraper runs");
    return false;
  }

  /**
   * Reject a repeated query param (?kind=visa&kind=news arrives as an array)
   * with 400 instead of silently picking one. Returns false when it sent 400.
   */
  private singleValued(req: AuthenticatedRequest, res: Response, keys: string[]): boolean {
    for (const key of keys) {
      const v = req.query[key];
      if (v !== undefined && typeof v !== "string") {
        sendError(res, "VALIDATION_ERROR", `${key} must be given once, as a single value`, 400);
        return false;
      }
    }
    return true;
  }

  /**
   * GET /admin/scrape-runs?kind=&status=&from=&to=&limit=&cursor=
   * Newest first (startedAt desc). All filters optional:
   *  - kind: visa | news; status: running | succeeded | partial | failed;
   *  - from / to: ISO date-time or epoch ms, inclusive bounds on startedAt
   *    (from > to → 400);
   *  - limit: default 25, capped at 100; cursor: the previous page's
   *    nextCursor (unknown id → 400 INVALID_CURSOR).
   * → { items: RunListItem[], nextCursor: string | null }. List items omit
   * the bulky pages / sources / errors arrays (see GET /:id).
   */
  async list(req: AuthenticatedRequest, res: Response): Promise<void> {
    if (!this.allowed(req, res)) return;
    if (!this.singleValued(req, res, ["kind", "status", "from", "to", "limit", "cursor"])) return;
    const q: ListRunsQuery = { limit: SCRAPE_RUN_LIST_DEFAULT_LIMIT };

    // ---- Validate ----
    const { kind, status, from, to, limit, cursor } = req.query as Record<string, string | undefined>;
    if (kind !== undefined) {
      if (!SCRAPE_RUN_KINDS.includes(kind as ScrapeRunKind)) {
        sendError(res, "VALIDATION_ERROR", `kind must be one of: ${SCRAPE_RUN_KINDS.join(", ")}`, 400);
        return;
      }
      q.kind = kind as ScrapeRunKind;
    }
    if (status !== undefined) {
      if (!SCRAPE_RUN_STATUSES.includes(status as ScrapeRunStatus)) {
        sendError(res, "VALIDATION_ERROR", `status must be one of: ${SCRAPE_RUN_STATUSES.join(", ")}`, 400);
        return;
      }
      q.status = status as ScrapeRunStatus;
    }
    for (const [key, raw] of [["from", from], ["to", to]] as const) {
      if (raw === undefined) continue;
      const ms = parseDateParam(raw);
      if (ms === undefined) {
        sendError(res, "VALIDATION_ERROR", `${key} must be an ISO date/time or epoch milliseconds`, 400);
        return;
      }
      if (key === "from") q.fromMs = ms;
      else q.toMs = ms;
    }
    if (q.fromMs !== undefined && q.toMs !== undefined && q.fromMs > q.toMs) {
      sendError(res, "VALIDATION_ERROR", "from must not be after to", 400);
      return;
    }
    if (limit !== undefined) {
      const n = Number(limit);
      if (!Number.isInteger(n) || n < 1) {
        sendError(res, "VALIDATION_ERROR", "limit must be a positive integer", 400);
        return;
      }
      q.limit = Math.min(n, SCRAPE_RUN_LIST_MAX_LIMIT);
    }
    if (cursor !== undefined) {
      if (!RUN_ID_RE.test(cursor)) {
        sendError(res, "INVALID_CURSOR", "cursor is not valid", 400);
        return;
      }
      q.cursor = cursor;
    }

    try {
      sendSuccess(res, await scrapeRunService.listRuns(q));
    } catch (error) {
      if (error instanceof InvalidCursorError) {
        sendError(res, "INVALID_CURSOR", error.message, 400);
        return;
      }
      console.error("Error listing scrape runs:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /** GET /admin/scrape-runs/:id → the full run doc (ISO dates), or 404. */
  async get(req: AuthenticatedRequest, res: Response): Promise<void> {
    const { id } = req.params;
    if (!this.allowed(req, res, id)) return;
    if (!RUN_ID_RE.test(id)) {
      sendError(res, "NOT_FOUND", "Scrape run not found", 404);
      return;
    }
    try {
      const run = await scrapeRunService.getRun(id);
      if (!run) {
        sendError(res, "NOT_FOUND", "Scrape run not found", 404);
        return;
      }
      sendSuccess(res, run);
    } catch (error) {
      console.error("Error getting scrape run:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * GET /admin/scrape-sources?kind=visa|news → ScrapeSourceHealth[] (both
   * kinds when `kind` is omitted; visa first). Invalid kind → 400.
   */
  async sources(req: AuthenticatedRequest, res: Response): Promise<void> {
    if (!this.allowed(req, res)) return;
    if (!this.singleValued(req, res, ["kind"])) return;
    const kind = req.query.kind as string | undefined;
    if (kind !== undefined && !SCRAPE_RUN_KINDS.includes(kind as ScrapeRunKind)) {
      sendError(res, "VALIDATION_ERROR", `kind must be one of: ${SCRAPE_RUN_KINDS.join(", ")}`, 400);
      return;
    }
    try {
      sendSuccess(res, await scrapeRunService.listSourceHealth(kind as ScrapeRunKind | undefined));
    } catch (error) {
      console.error("Error listing scrape sources:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }
}

export const scrapeRunController = new ScrapeRunController();
