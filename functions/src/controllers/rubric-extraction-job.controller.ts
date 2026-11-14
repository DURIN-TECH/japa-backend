import { Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import { ErrorMessages, sendError, sendSuccess } from "../utils/response";
// Reached through the scrapers module's public entry point (ESLint boundary, #91).
import { rubricExtractionJobService } from "../scrapers";
import type { StartJobInput, StartJobResult } from "../scrapers";

// ============================================
// ADMIN — RULEBOOK DRAFTING JOBS (issue #216)
// ============================================
//
// Mounted at /admin/rubric-extraction-jobs (routes/rubric-extraction-job.routes.ts):
//
//   POST /admin/rubric-extraction-jobs            start a drafting job (or plan it: dryRun)
//   GET  /admin/rubric-extraction-jobs/:id        status, counters, steps done, the reason
//   POST /admin/rubric-extraction-jobs/:id/cancel stop the job before its next step
//
// ADMIN ONLY: the router runs the same gate as the other rubric admin routes
// (`verifyAuth`, `requireRubricAdmin`, `verifyAdmin`) before any handler, so a
// non-admin is refused before a body is read or a document is touched.
//
// Thin on purpose: validate the request, call the job service, map the result
// to HTTP. The rules live in scrapers/rubric/rubric-extraction-job.ts.

/** Body of `POST /`: exactly these keys, nothing else (a strict body). */
const START_KEYS = ["countryCode", "visaTypeId", "sourceIds", "dryRun", "force"] as const;
/** At most this many sources per route (a route has a handful). */
const MAX_SOURCES = 50;
/** A guidance source id as the registry writes it (a slug-like document id). */
const SOURCE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
/** A visa type id, as `rubricRouteKey` accepts it. */
const VISA_TYPE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
/** A job id: the route key, `__`, a hex digest. */
const JOB_ID_RE = /^[A-Za-z0-9_-]{1,120}__[0-9a-f]{16}$/;

/** A parsed start request, or the message that says what is wrong. */
export function parseStartBody(raw: unknown): { ok: true; input: StartJobInput } | { ok: false; message: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, message: "the body must be a JSON object" };
  const body = raw as Record<string, unknown>;
  const extra = Object.keys(body).filter((k) => !(START_KEYS as readonly string[]).includes(k));
  if (extra.length > 0) return { ok: false, message: `unknown field(s): ${extra.slice(0, 5).join(", ")}` };
  if (typeof body.countryCode !== "string" || !/^[A-Z]{2}$/.test(body.countryCode)) return { ok: false, message: "countryCode must be two upper-case letters" };
  if (typeof body.visaTypeId !== "string" || !VISA_TYPE_ID_RE.test(body.visaTypeId)) return { ok: false, message: "visaTypeId is missing or not a valid visa type id" };
  let sourceIds: string[] | undefined;
  if (body.sourceIds !== undefined) {
    if (!Array.isArray(body.sourceIds) || body.sourceIds.length === 0 || body.sourceIds.length > MAX_SOURCES) return { ok: false, message: `sourceIds must be a list of 1 to ${MAX_SOURCES} source ids` };
    if (!body.sourceIds.every((s) => typeof s === "string" && SOURCE_ID_RE.test(s))) return { ok: false, message: "sourceIds holds an invalid source id" };
    sourceIds = body.sourceIds as string[];
  }
  for (const flag of ["dryRun", "force"] as const) {
    if (body[flag] !== undefined && typeof body[flag] !== "boolean") return { ok: false, message: `${flag} must be true or false` };
  }
  return {
    ok: true,
    input: {
      countryCode: body.countryCode,
      visaTypeId: body.visaTypeId,
      ...(sourceIds ? { sourceIds } : {}),
      ...(body.dryRun === true ? { dryRun: true } : {}),
      ...(body.force === true ? { force: true } : {}),
    },
  };
}

/** HTTP status and error code of a refused start, from the stop code (the service's own codes). */
function refusal(result: StartJobResult): { status: number; code: string } {
  switch (result.reasonCode) {
  case "visa_type_not_found":
  case "source_not_found":
    return { status: 404, code: "NOT_FOUND" };
  case "invalid_route":
  case "no_sources":
  case "no_text":
  case "source_has_no_snapshot":
  case "snapshot_meta_missing":
    return { status: 400, code: "VALIDATION_ERROR" };
  case "settings_unavailable":
    return { status: 503, code: "SERVICE_UNAVAILABLE" };
  case "unexpected_error":
    return { status: 500, code: "INTERNAL_ERROR" };
    // disabled, run_cap_exceeded, daily_cap_reached, run_record_unavailable: the request is fine, the state refuses it.
  default:
    return { status: 409, code: "CONFLICT" };
  }
}

class RubricExtractionJobController {
  /** POST / — start (or plan) a drafting job. */
  async start(req: AuthenticatedRequest, res: Response): Promise<void> {
    const parsed = parseStartBody(req.body);
    if (!parsed.ok) {
      sendError(res, "VALIDATION_ERROR", parsed.message, 400);
      return;
    }
    try {
      const result = await rubricExtractionJobService.startJob({ ...parsed.input, trigger: "manual", requestedBy: req.authz?.uid ?? null });
      if (result.outcome === "refused") {
        const { status, code } = refusal(result);
        sendError(res, code, result.message ?? "the job could not be started", status);
        return;
      }
      // A new job is 201; everything else (a duplicate, a plan, nothing to do, a restart) is 200.
      sendSuccess(res, result, undefined, result.outcome === "started" ? 201 : 200);
    } catch (error) {
      console.error(`Error starting a rulebook drafting job: ${(error as Error)?.message ?? error}`);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /** GET /:id — the job's status. */
  async get(req: AuthenticatedRequest, res: Response): Promise<void> {
    const id = String(req.params.id ?? "");
    if (!JOB_ID_RE.test(id)) {
      sendError(res, "NOT_FOUND", "no such drafting job", 404);
      return;
    }
    try {
      const view = await rubricExtractionJobService.getStatus(id);
      if (!view) {
        sendError(res, "NOT_FOUND", "no such drafting job", 404);
        return;
      }
      sendSuccess(res, view);
    } catch (error) {
      console.error(`Error reading a rulebook drafting job: ${(error as Error)?.message ?? error}`);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /** POST /:id/cancel — stop the job before its next step. */
  async cancel(req: AuthenticatedRequest, res: Response): Promise<void> {
    const id = String(req.params.id ?? "");
    if (!JOB_ID_RE.test(id)) {
      sendError(res, "NOT_FOUND", "no such drafting job", 404);
      return;
    }
    // A strict body: this route takes none.
    if (req.body && typeof req.body === "object" && Object.keys(req.body as object).length > 0) {
      sendError(res, "VALIDATION_ERROR", "this request takes no body", 400);
      return;
    }
    try {
      const view = await rubricExtractionJobService.cancel(id, req.authz?.uid ?? null);
      if (!view) {
        sendError(res, "NOT_FOUND", "no such drafting job", 404);
        return;
      }
      sendSuccess(res, view);
    } catch (error) {
      console.error(`Error cancelling a rulebook drafting job: ${(error as Error)?.message ?? error}`);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }
}

export const rubricExtractionJobController = new RubricExtractionJobController();
