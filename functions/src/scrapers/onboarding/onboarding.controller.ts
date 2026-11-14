import { Response } from "express";
import type { Timestamp } from "firebase-admin/firestore";
import { AuthenticatedRequest } from "../../middleware/auth";
import { asSubject, can, forbidden } from "../../middleware/authz";
import { ErrorMessages, sendError, sendSuccess } from "../../utils/response";
// Issue #232: authority id shapes (pure; no Firebase).
import { checkAuthorityId } from "../../authorities/authority-ids";
import { loadOnboardingSettings, parseOnboardingSettingsPatch, updateOnboardingSettings } from "./onboarding-settings";
import { routeOnboardingService, type ChecklistItem } from "./route-onboarding.service";
import { OnboardingError, RUN_STATUSES, type RouteOnboardingRun, type RunStatus } from "./onboarding-types";

// ============================================
// ADMIN — ROUTE ONBOARDING RUNS (issue #217)
// ============================================
//
//   POST  /admin/route-onboarding              start a run               update ScrapeRun
//   GET   /admin/route-onboarding              list runs                 read   ScrapeRun
//   GET   /admin/route-onboarding/settings     the onboarding settings   read   ScrapeRun
//   PATCH /admin/route-onboarding/settings     change them (audited)     update ScrapeRun
//   GET   /admin/route-onboarding/:id          one run with its steps    read   ScrapeRun
//   POST  /admin/route-onboarding/:id/confirm  confirm the estimate      update ScrapeRun
//   POST  /admin/route-onboarding/:id/cancel   cancel                    update ScrapeRun
//
// Every route runs `verifyAuth` (401), `verifyAdmin` and then this file's CASL
// check on the admin-only `ScrapeRun` subject (403) BEFORE any body is read or
// document touched. Bodies are strict: unknown keys are 400. The response
// shape is an explicit WHITELIST (`runView`): lease fields, the retry counter
// and the kick counter never leave the server.
//
// Error body: `{ success:false, error: CODE, message, ...extra }`.

/** Admin uid for audit fields (verifyAuth always sets it). */
const uid = (req: AuthenticatedRequest): string => req.userId ?? req.authz?.uid ?? "unknown";

/** A run id: the route key, `__r`, a number. */
const RUN_ID_RE = /^[A-Za-z0-9_-]{1,140}__r[0-9]{1,6}$/;

/** Timestamp -> ISO (null when absent). */
const iso = (t: Timestamp | null | undefined): string | null => (t && typeof t.toDate === "function" ? t.toDate().toISOString() : null);

/** The run as the portal gets it: explicit fields, ISO dates, no internals. */
export function runView(run: RouteOnboardingRun) {
  return {
    runId: run.runId,
    routeKey: run.routeKey,
    countryCode: run.countryCode,
    visaTypeId: run.visaTypeId,
    status: run.status,
    summary: run.summary,
    steps: run.steps.map((s) => ({ id: s.id, label: s.label, status: s.status, startedAt: iso(s.startedAt), finishedAt: iso(s.finishedAt), detail: s.detail })),
    estimate: run.estimate ? { ...run.estimate, createdAt: iso(run.estimate.createdAt) } : null,
    confirmation: run.confirmation ? confirmationView(run.confirmation) : null,
    voidedConfirmations: run.voidedConfirmations.map(confirmationView),
    allowlist: run.allowlist,
    counters: run.counters,
    holdReason: run.holdReason,
    links: run.links,
    unchanged: run.unchanged,
    createdBy: run.createdBy,
    cancelRequested: run.cancelRequested,
    createdAt: iso(run.createdAt),
    updatedAt: iso(run.updatedAt),
    finishedAt: iso(run.finishedAt),
  };
}

function confirmationView(c: NonNullable<RouteOnboardingRun["confirmation"]>) {
  return { by: c.by, at: iso(c.at), estimateId: c.estimateId, maxRequests: c.maxRequests, statementAccepted: c.statementAccepted, addToAllowlist: c.addToAllowlist };
}

/** The list row: enough for a table. */
function runRow(run: RouteOnboardingRun) {
  return {
    runId: run.runId, routeKey: run.routeKey, countryCode: run.countryCode, visaTypeId: run.visaTypeId, status: run.status, summary: run.summary,
    createdBy: run.createdBy, createdAt: iso(run.createdAt), finishedAt: iso(run.finishedAt), counters: run.counters, holdReason: run.holdReason,
  };
}

/** An object body with only `allowed` keys, or a 400. */
function strictBody(raw: unknown, allowed: readonly string[]): Record<string, unknown> {
  const body = raw === undefined || raw === null ? {} : raw;
  if (typeof body !== "object" || Array.isArray(body)) throw new OnboardingError("VALIDATION_ERROR", 400, "The body must be a JSON object");
  for (const k of Object.keys(body)) {
    if (!allowed.includes(k)) throw new OnboardingError("VALIDATION_ERROR", 400, `"${k}" is not a known field`, { field: k });
  }
  return body as Record<string, unknown>;
}

/** Send an OnboardingError, or a 500 for anything unexpected (never leaking details). */
function fail(res: Response, err: unknown, what: string): void {
  if (err instanceof OnboardingError) {
    res.status(err.status).json({ success: false, error: err.code, message: err.message, ...err.extra });
    return;
  }
  console.error(`Route onboarding: error ${what}: ${(err as { code?: unknown } | null)?.code ?? (err as Error)?.constructor?.name}`);
  sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
}

class OnboardingController {
  /** CASL gate: 403 and false when not allowed. */
  private allowed(req: AuthenticatedRequest, res: Response, action: "read" | "update"): boolean {
    if (can(req, action, asSubject("ScrapeRun", {}))) return true;
    forbidden(res, "Only admins can manage route onboarding");
    return false;
  }

  /**
   * POST / { authorityId, visaTypeId }
   *
   * Issue #232: the route's issuing authority is `authorityId` (a country
   * code, or a bloc/treaty id). `countryCode` is still accepted in its place
   * (same value for a country) so the existing screen keeps working until it
   * sends `authorityId`; give exactly one of the two.
   */
  async start(req: AuthenticatedRequest, res: Response): Promise<void> {
    if (!this.allowed(req, res, "update")) return;
    try {
      const body = strictBody(req.body, ["authorityId", "countryCode", "visaTypeId"]);
      if (body.authorityId !== undefined && body.countryCode !== undefined) {
        throw new OnboardingError("VALIDATION_ERROR", 400, "Give authorityId or countryCode, not both", { field: "authorityId" });
      }
      const field = body.authorityId !== undefined ? "authorityId" : "countryCode";
      const authorityId = body[field];
      // Shape only here; the service checks the id rules and the registry.
      if (typeof authorityId !== "string" || !checkAuthorityId(authorityId).ok) {
        throw new OnboardingError("VALIDATION_ERROR", 400, "authorityId must be a two-letter country code in capitals, or a bloc or treaty id", { field });
      }
      if (typeof body.visaTypeId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(body.visaTypeId)) throw new OnboardingError("VALIDATION_ERROR", 400, "visaTypeId is missing or not a valid visa id", { field: "visaTypeId" });
      const run = await routeOnboardingService.start(authorityId, body.visaTypeId, uid(req));
      sendSuccess(res, { runId: run.runId, status: run.status, run: runView(run) }, undefined, 201);
    } catch (err) {
      fail(res, err, "starting a run");
    }
  }

  /** GET /?status=&limit= */
  async list(req: AuthenticatedRequest, res: Response): Promise<void> {
    if (!this.allowed(req, res, "read")) return;
    try {
      const q = req.query as Record<string, unknown>;
      let status: RunStatus | undefined;
      if (q.status !== undefined) {
        if (typeof q.status !== "string" || !(RUN_STATUSES as readonly string[]).includes(q.status)) throw new OnboardingError("VALIDATION_ERROR", 400, "status is not a known run status", { field: "status" });
        status = q.status as RunStatus;
      }
      let limit = 50;
      if (q.limit !== undefined) {
        const n = Number(q.limit);
        if (!Number.isInteger(n) || n < 1 || n > 100) throw new OnboardingError("VALIDATION_ERROR", 400, "limit must be a whole number from 1 to 100", { field: "limit" });
        limit = n;
      }
      const runs = await routeOnboardingService.list({ status, limit });
      sendSuccess(res, { runs: runs.map(runRow), total: runs.length });
    } catch (err) {
      fail(res, err, "listing runs");
    }
  }

  /** GET /:id */
  async get(req: AuthenticatedRequest, res: Response): Promise<void> {
    if (!this.allowed(req, res, "read")) return;
    try {
      const id = String(req.params.id ?? "");
      if (!RUN_ID_RE.test(id)) throw new OnboardingError("NOT_FOUND", 404, "No such onboarding run.");
      const found = await routeOnboardingService.get(id);
      if (!found) throw new OnboardingError("NOT_FOUND", 404, "No such onboarding run.");
      sendSuccess(res, { run: runView(found.run), checklist: found.checklist satisfies ChecklistItem[] });
    } catch (err) {
      fail(res, err, "reading a run");
    }
  }

  /** POST /:id/confirm { estimateId, statementAccepted: true, addToAllowlist? } */
  async confirm(req: AuthenticatedRequest, res: Response): Promise<void> {
    if (!this.allowed(req, res, "update")) return;
    try {
      const id = String(req.params.id ?? "");
      if (!RUN_ID_RE.test(id)) throw new OnboardingError("NOT_FOUND", 404, "No such onboarding run.");
      const body = strictBody(req.body, ["estimateId", "statementAccepted", "addToAllowlist"]);
      if (typeof body.estimateId !== "string" || !/^est_[0-9a-f]{16}$/.test(body.estimateId)) throw new OnboardingError("VALIDATION_ERROR", 400, "estimateId must be the id of the stored estimate", { field: "estimateId" });
      if (body.statementAccepted !== true) throw new OnboardingError("STATEMENT_REQUIRED", 400, "Confirming needs statementAccepted: true: the statement on the estimate must be accepted.", { field: "statementAccepted" });
      if (body.addToAllowlist !== undefined && typeof body.addToAllowlist !== "boolean") throw new OnboardingError("VALIDATION_ERROR", 400, "addToAllowlist must be true or false", { field: "addToAllowlist" });
      const r = await routeOnboardingService.confirm(id, { estimateId: body.estimateId, addToAllowlist: body.addToAllowlist === true }, uid(req));
      sendSuccess(res, { alreadyConfirmed: r.alreadyConfirmed, run: runView(r.run) });
    } catch (err) {
      fail(res, err, "confirming a run");
    }
  }

  /** POST /:id/cancel (no body) */
  async cancel(req: AuthenticatedRequest, res: Response): Promise<void> {
    if (!this.allowed(req, res, "update")) return;
    try {
      const id = String(req.params.id ?? "");
      if (!RUN_ID_RE.test(id)) throw new OnboardingError("NOT_FOUND", 404, "No such onboarding run.");
      strictBody(req.body, []);
      const run = await routeOnboardingService.cancel(id, uid(req));
      sendSuccess(res, { run: runView(run) });
    } catch (err) {
      fail(res, err, "cancelling a run");
    }
  }

  /** GET /settings */
  async getSettings(req: AuthenticatedRequest, res: Response): Promise<void> {
    if (!this.allowed(req, res, "read")) return;
    try {
      const loaded = await loadOnboardingSettings();
      if (loaded.readError) throw new OnboardingError("SETTINGS_UNAVAILABLE", 503, "Settings could not be read; try again shortly");
      sendSuccess(res, { settings: loaded.settings, problems: loaded.problems });
    } catch (err) {
      fail(res, err, "reading settings");
    }
  }

  /** PATCH /settings */
  async patchSettings(req: AuthenticatedRequest, res: Response): Promise<void> {
    if (!this.allowed(req, res, "update")) return;
    try {
      const patch = parseOnboardingSettingsPatch(req.body);
      const loaded = await updateOnboardingSettings(patch, uid(req));
      sendSuccess(res, { settings: loaded.settings, problems: loaded.problems });
    } catch (err) {
      fail(res, err, "changing settings");
    }
  }
}

export const onboardingController = new OnboardingController();
