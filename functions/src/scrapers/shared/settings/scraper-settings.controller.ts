import { Response } from "express";
import { AuthenticatedRequest } from "../../../middleware/auth";
import { asSubject, can, forbidden } from "../../../middleware/authz";
import { sendError, sendSuccess, ErrorMessages } from "../../../utils/response";
import { scrapeRunService } from "../runs/scrape-run.service";
import { SCRAPE_RUN_KINDS, type ScrapeRunKind } from "../runs/types";
import { isValidDocId } from "../../visa-catalog/changes/visa-catalog-changes.service";
import {
  InvalidHistoryCursorError,
  SETTINGS_HISTORY_DEFAULT_LIMIT,
  SETTINGS_HISTORY_MAX_LIMIT,
  SourceNotFoundError,
  scraperSettingsService,
} from "./scraper-settings.service";
import { SettingsValidationError, parseSettingsPatch, parseSourcePatch } from "./scraper-settings.validate";
import { RunRequestError, scrapeRunRequestService } from "./scrape-run-request.service";

// ============================================
// ADMIN — SCRAPER SETTINGS + MANUAL RUNS (issue #96)
// ============================================
//
// Routes (scraper-settings.routes.ts; contract: scraper-settings.md):
//   GET   /admin/scraper-settings                 read ScrapeRun
//   PATCH /admin/scraper-settings                 update ScrapeRun
//   GET   /admin/scraper-settings/history         read ScrapeRun
//   PATCH /admin/scrape-sources/:kind/:id         update ScrapeRun
//   POST  /admin/scrape-sources/:kind/:id/run     update ScrapeRun
//   POST  /admin/scrapers/:kind/run               update ScrapeRun
//   GET   /admin/scrape-run-requests/:id          read ScrapeRun
//
// Every route runs `verifyAuth` first (401), then the shared CASL ability
// on the #81 `ScrapeRun` subject (admin-only via `manage all`) -> 403,
// BEFORE any validation or Firestore read, so nothing leaks to non-admins.
// No role strings here: access is the ability's decision alone.
//
// Validation errors are 400 VALIDATION_ERROR with `field` = the dotted path
// of the first bad field.

/** Visa source ids are ISO alpha-2 country codes. */
const VISA_SOURCE_ID_RE = /^[A-Z]{2}$/;
/** Request ids are Firestore auto ids. */
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** HTTP status per Run now refusal. */
const REFUSAL_STATUS: Record<RunRequestError["code"], number> = {
  NOT_FOUND: 404,
  SOURCE_NOT_ACTIVE: 409,
  SCRAPER_DISABLED: 409,
  RUN_IN_PROGRESS: 409,
  RUN_COOLDOWN: 409,
};

/** 400 naming the offending field (sendError has no extra fields). */
function validationError(res: Response, field: string, message: string): void {
  res.status(400).json({ success: false, error: "VALIDATION_ERROR", message, field });
}

class ScraperSettingsController {
  /** CASL gate shared by every handler: 403 and false when not allowed. */
  private allowed(req: AuthenticatedRequest, res: Response, action: "read" | "update"): boolean {
    if (can(req, action, asSubject("ScrapeRun", {}))) return true;
    forbidden(res, action === "read" ? "Only admins can view scraper settings" : "Only admins can change scraper settings");
    return false;
  }

  /** The admin's uid for audit fields (verifyAuth always sets it). */
  private uid(req: AuthenticatedRequest): string {
    return req.userId ?? req.authz?.uid ?? "unknown";
  }

  /**
   * `:kind` + `:id` of a per-source route. Sends 400 / 404 and returns null
   * when invalid (an id that cannot exist is a 404, like an unknown one).
   */
  private sourceParams(req: AuthenticatedRequest, res: Response): { kind: ScrapeRunKind; id: string } | null {
    const { kind, id } = req.params as { kind?: string; id?: string };
    if (!SCRAPE_RUN_KINDS.includes(kind as ScrapeRunKind)) {
      validationError(res, "kind", `kind must be one of: ${SCRAPE_RUN_KINDS.join(", ")}`);
      return null;
    }
    const ok = kind === "visa" ? VISA_SOURCE_ID_RE.test(id ?? "") : isValidDocId(id);
    if (!ok) {
      sendError(res, "NOT_FOUND", `${kind} source not found`, 404);
      return null;
    }
    return { kind: kind as ScrapeRunKind, id: id as string };
  }

  /** `{ force?: boolean }` of a Run now body; null after sending 400. */
  private runBody(req: AuthenticatedRequest, res: Response): { force: boolean } | null {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body !== "object" || Array.isArray(body)) {
      validationError(res, "body", "the body must be a JSON object");
      return null;
    }
    for (const key of Object.keys(body)) {
      if (key !== "force") {
        validationError(res, key, `${key} is not a known option (only force)`);
        return null;
      }
    }
    if (body.force !== undefined && typeof body.force !== "boolean") {
      validationError(res, "force", "force must be a boolean");
      return null;
    }
    return { force: body.force === true };
  }

  /** GET /admin/scraper-settings -> the full view (scraper-settings.md §1). */
  async get(req: AuthenticatedRequest, res: Response): Promise<void> {
    if (!this.allowed(req, res, "read")) return;
    try {
      sendSuccess(res, await scraperSettingsService.getView());
    } catch (error) {
      console.error("Error reading scraper settings:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /** PATCH /admin/scraper-settings (partial) -> the new view. */
  async patch(req: AuthenticatedRequest, res: Response): Promise<void> {
    if (!this.allowed(req, res, "update")) return;
    try {
      const parsed = parseSettingsPatch(req.body);
      const { view } = await scraperSettingsService.applyPatch(parsed, this.uid(req));
      sendSuccess(res, view);
    } catch (error) {
      if (error instanceof SettingsValidationError) {
        validationError(res, error.field, error.message);
        return;
      }
      console.error("Error updating scraper settings:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /** GET /admin/scraper-settings/history?limit=&cursor= (newest first). */
  async history(req: AuthenticatedRequest, res: Response): Promise<void> {
    if (!this.allowed(req, res, "read")) return;
    const { limit, cursor } = req.query as Record<string, unknown>;
    for (const [key, v] of [["limit", limit], ["cursor", cursor]] as const) {
      if (v !== undefined && typeof v !== "string") {
        validationError(res, key, `${key} must be given once, as a single value`);
        return;
      }
    }
    let n = SETTINGS_HISTORY_DEFAULT_LIMIT;
    if (limit !== undefined) {
      n = Number(limit);
      if (!Number.isInteger(n) || n < 1) {
        validationError(res, "limit", "limit must be a positive integer");
        return;
      }
      n = Math.min(n, SETTINGS_HISTORY_MAX_LIMIT);
    }
    if (cursor !== undefined && !REQUEST_ID_RE.test(cursor as string)) {
      sendError(res, "INVALID_CURSOR", "cursor is not valid", 400);
      return;
    }
    try {
      sendSuccess(res, await scraperSettingsService.listHistory({ limit: n, cursor: cursor as string | undefined }));
    } catch (error) {
      if (error instanceof InvalidHistoryCursorError) {
        sendError(res, "INVALID_CURSOR", error.message, 400);
        return;
      }
      console.error("Error listing scraper settings history:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /** PATCH /admin/scrape-sources/:kind/:id -> the source's health row. */
  async patchSource(req: AuthenticatedRequest, res: Response): Promise<void> {
    if (!this.allowed(req, res, "update")) return;
    const p = this.sourceParams(req, res);
    if (!p) return;
    try {
      const parsed = parseSourcePatch(p.kind, req.body);
      await scraperSettingsService.updateSource(p.kind, p.id, parsed, this.uid(req));
      const row = await scrapeRunService.getSourceHealth(p.kind, p.id);
      if (!row) {
        sendError(res, "NOT_FOUND", `${p.kind} source not found`, 404);
        return;
      }
      sendSuccess(res, row);
    } catch (error) {
      if (error instanceof SettingsValidationError) {
        validationError(res, error.field, error.message);
        return;
      }
      if (error instanceof SourceNotFoundError) {
        sendError(res, "NOT_FOUND", `${p.kind} source not found`, 404);
        return;
      }
      console.error("Error updating scrape source:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /** POST /admin/scrape-sources/:kind/:id/run -> 202 { requestId, runId, status }. */
  async runSource(req: AuthenticatedRequest, res: Response): Promise<void> {
    if (!this.allowed(req, res, "update")) return;
    const p = this.sourceParams(req, res);
    if (!p) return;
    const body = this.runBody(req, res);
    if (!body) return;
    await this.createRequest(res, { kind: p.kind, sourceId: p.id, force: body.force, uid: this.uid(req) });
  }

  /** POST /admin/scrapers/:kind/run -> 202 (every due source, windows ignored). */
  async runScraper(req: AuthenticatedRequest, res: Response): Promise<void> {
    if (!this.allowed(req, res, "update")) return;
    const kind = (req.params as { kind?: string }).kind;
    if (!SCRAPE_RUN_KINDS.includes(kind as ScrapeRunKind)) {
      validationError(res, "kind", `kind must be one of: ${SCRAPE_RUN_KINDS.join(", ")}`);
      return;
    }
    const body = this.runBody(req, res);
    if (!body) return;
    await this.createRequest(res, { kind: kind as ScrapeRunKind, sourceId: null, force: body.force, uid: this.uid(req) });
  }

  /** Shared tail of both Run now routes: create the request, map refusals. */
  private async createRequest(
    res: Response,
    input: { kind: ScrapeRunKind; sourceId: string | null; force: boolean; uid: string }
  ): Promise<void> {
    try {
      sendSuccess(res, await scrapeRunRequestService.create(input), undefined, 202);
    } catch (error) {
      if (error instanceof RunRequestError) {
        res.status(REFUSAL_STATUS[error.code]).json({ success: false, error: error.code, message: error.message, ...error.extra });
        return;
      }
      console.error("Error creating scrape run request:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /** GET /admin/scrape-run-requests/:id -> the request (poll for runId / status). */
  async getRequest(req: AuthenticatedRequest, res: Response): Promise<void> {
    if (!this.allowed(req, res, "read")) return;
    const { id } = req.params as { id?: string };
    if (!REQUEST_ID_RE.test(id ?? "")) {
      sendError(res, "NOT_FOUND", "Run request not found", 404);
      return;
    }
    try {
      const doc = await scrapeRunRequestService.get(id as string);
      if (!doc) {
        sendError(res, "NOT_FOUND", "Run request not found", 404);
        return;
      }
      sendSuccess(res, doc);
    } catch (error) {
      console.error("Error reading scrape run request:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }
}

export const scraperSettingsController = new ScraperSettingsController();
