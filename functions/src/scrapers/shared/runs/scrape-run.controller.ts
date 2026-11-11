import { Response } from "express";
import { AuthenticatedRequest } from "../../../middleware/auth";
import { asSubject, can, forbidden } from "../../../middleware/authz";
import { sendError, sendSuccess, ErrorMessages } from "../../../utils/response";
import {
  InvalidCursorError,
  RUN_STATS_DEFAULT_DAYS,
  RUN_STATS_MAX_DAYS,
  SCRAPE_RUN_LIST_DEFAULT_LIMIT,
  SCRAPE_RUN_LIST_MAX_LIMIT,
  scrapeRunService,
  type ListRunsQuery,
} from "./scrape-run.service";
import {
  SCRAPE_RUN_KINDS,
  SCRAPER_SETTINGS_KINDS,
  type ScraperSettingsKind,
  SCRAPE_RUN_STATUSES,
  type ScrapeRunKind,
  type ScrapeRunStatus,
} from "./types";
// Issue #82: the cost report (same CASL gate: read ScrapeRun).
import {
  SCRAPE_COST_DEFAULT_MONTHS,
  SCRAPE_COST_GROUP_BYS,
  SCRAPE_COST_MAX_MONTHS,
  scrapeCostService,
  type ScrapeCostGroupBy,
} from "../cost/scrape-cost.service";
import { addMonths, isMonthKey, monthKeyUtc, monthsBetween } from "../cost/scrape-cost-pricing";

// ============================================
// ADMIN — SCRAPE RUNS + SOURCE HEALTH (issue #81)
// ============================================
//
// Mounted at /admin/scrape-runs and /admin/scrape-sources
// (scrapers/shared/runs/scrape-run.routes.ts). Every route runs `verifyAuth` first (no
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

/**
 * Parse a scrape-costs `from` / `to` bound to a UTC month key: "YYYY-MM", or
 * any ISO date/time / epoch ms (its UTC month). undefined = invalid.
 */
function parseMonthParam(raw: string): string | undefined {
  if (isMonthKey(raw)) return raw;
  const ms = parseDateParam(raw);
  return ms === undefined ? undefined : monthKeyUtc(ms);
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

  /**
   * GET /admin/scrape-runs/stats?from=&to=&bucket=day&kind=
   * Per-UTC-day run counts by status, per kind (see scrapeRunService.runStats).
   *  - to: default now; from: default to − 30 days (ISO or epoch ms);
   *  - range at most 90 days, from <= to (else 400);
   *  - bucket: only "day" (default); kind: visa | news (default both).
   */
  async stats(req: AuthenticatedRequest, res: Response): Promise<void> {
    if (!this.allowed(req, res)) return;
    if (!this.singleValued(req, res, ["from", "to", "bucket", "kind"])) return;
    const { from, to, bucket, kind } = req.query as Record<string, string | undefined>;
    if (bucket !== undefined && bucket !== "day") {
      sendError(res, "VALIDATION_ERROR", "bucket must be day", 400);
      return;
    }
    if (kind !== undefined && !SCRAPE_RUN_KINDS.includes(kind as ScrapeRunKind)) {
      sendError(res, "VALIDATION_ERROR", `kind must be one of: ${SCRAPE_RUN_KINDS.join(", ")}`, 400);
      return;
    }
    const toMs = to === undefined ? Date.now() : parseDateParam(to);
    if (toMs === undefined) {
      sendError(res, "VALIDATION_ERROR", "to must be an ISO date/time or epoch milliseconds", 400);
      return;
    }
    const fromMs = from === undefined ? toMs - RUN_STATS_DEFAULT_DAYS * 24 * 60 * 60 * 1000 : parseDateParam(from);
    if (fromMs === undefined) {
      sendError(res, "VALIDATION_ERROR", "from must be an ISO date/time or epoch milliseconds", 400);
      return;
    }
    if (fromMs > toMs) {
      sendError(res, "VALIDATION_ERROR", "from must not be after to", 400);
      return;
    }
    if (toMs - fromMs > RUN_STATS_MAX_DAYS * 24 * 60 * 60 * 1000) {
      sendError(res, "VALIDATION_ERROR", `the range must be at most ${RUN_STATS_MAX_DAYS} days`, 400);
      return;
    }
    try {
      sendSuccess(res, await scrapeRunService.runStats({ fromMs, toMs, kind: kind as ScrapeRunKind | undefined }));
    } catch (error) {
      console.error("Error computing scrape run stats:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * GET /admin/scrape-costs?from=&to=&groupBy=month|country|model|kind&kind=
   * (issue #82). Read from the monthly rollup `scrapeCosts/{YYYY-MM}`.
   *  - from / to: "YYYY-MM", or an ISO date/time / epoch ms (its UTC month),
   *    inclusive. Defaults: to = the current month, from = to − 5 months.
   *    At most SCRAPE_COST_MAX_MONTHS months; from > to → 400;
   *  - groupBy: month (default; every month zero-filled, oldest first) |
   *    country | model | kind (highest cost first);
   *  - kind: visa | news; filters every groupBy (budget stays all-kinds).
   * → ScrapeCostReport: groups, totals, budget (current month vs
   *   appConfig/scrapeBudget) and the price table with sourceUrl / effectiveFrom.
   */
  async costs(req: AuthenticatedRequest, res: Response): Promise<void> {
    if (!this.allowed(req, res)) return;
    if (!this.singleValued(req, res, ["from", "to", "groupBy", "kind"])) return;
    const { from, to, groupBy, kind } = req.query as Record<string, string | undefined>;
    if (groupBy !== undefined && !SCRAPE_COST_GROUP_BYS.includes(groupBy as ScrapeCostGroupBy)) {
      sendError(res, "VALIDATION_ERROR", `groupBy must be one of: ${SCRAPE_COST_GROUP_BYS.join(", ")}`, 400);
      return;
    }
    if (kind !== undefined && !SCRAPE_RUN_KINDS.includes(kind as ScrapeRunKind)) {
      sendError(res, "VALIDATION_ERROR", `kind must be one of: ${SCRAPE_RUN_KINDS.join(", ")}`, 400);
      return;
    }
    const toMonth = to === undefined ? monthKeyUtc(Date.now()) : parseMonthParam(to);
    if (toMonth === undefined) {
      sendError(res, "VALIDATION_ERROR", "to must be YYYY-MM, an ISO date/time or epoch milliseconds", 400);
      return;
    }
    const fromMonth = from === undefined ? addMonths(toMonth, -(SCRAPE_COST_DEFAULT_MONTHS - 1)) : parseMonthParam(from);
    if (fromMonth === undefined) {
      sendError(res, "VALIDATION_ERROR", "from must be YYYY-MM, an ISO date/time or epoch milliseconds", 400);
      return;
    }
    if (fromMonth > toMonth) {
      sendError(res, "VALIDATION_ERROR", "from must not be after to", 400);
      return;
    }
    if (monthsBetween(fromMonth, toMonth).length > SCRAPE_COST_MAX_MONTHS) {
      sendError(res, "VALIDATION_ERROR", `the range must be at most ${SCRAPE_COST_MAX_MONTHS} months`, 400);
      return;
    }
    try {
      sendSuccess(
        res,
        await scrapeCostService.report({
          from: fromMonth,
          to: toMonth,
          groupBy: (groupBy as ScrapeCostGroupBy | undefined) ?? "month",
          kind: kind as ScrapeRunKind | undefined,
        })
      );
    } catch (error) {
      console.error("Error computing scrape costs:", error);
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
    if (kind !== undefined && !SCRAPER_SETTINGS_KINDS.includes(kind as ScraperSettingsKind)) {
      sendError(res, "VALIDATION_ERROR", `kind must be one of: ${SCRAPER_SETTINGS_KINDS.join(", ")}`, 400);
      return;
    }
    try {
      sendSuccess(res, await scrapeRunService.listSourceHealth(kind as ScraperSettingsKind | undefined));
    } catch (error) {
      console.error("Error listing scrape sources:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }
}

export const scrapeRunController = new ScrapeRunController();
