import { Response } from "express";
import type { Timestamp } from "firebase-admin/firestore";
import { AuthenticatedRequest } from "../../../middleware/auth";
import { asSubject, can, forbidden } from "../../../middleware/authz";
import { ErrorMessages, sendError, sendSuccess } from "../../../utils/response";
import { guidanceSourceEditService } from "./guidance-source-edit.service";
import { officialDomainsService, type OfficialDomain } from "./official-domains.service";
import { parseRegistryUrl } from "./registry-address";
import { isRegistryError, RegistryError } from "./registry-errors";
import { registryRateLimiter } from "./registry-rate-limit";
import { loadRegistrySettings } from "./registry-settings";
import { countryLookup, routeRegistrationService } from "./route-registration.service";
import { sourcePreviewService } from "./source-preview.service";

// ============================================
// ADMIN — SOURCE REGISTRY API (issue #215)
// ============================================
//
//   POST  /admin/official-domains/preview        update ScrapeRun   check an address
//   POST  /admin/official-domains                update ScrapeRun   confirm one exact host for an authority
//   GET   /admin/official-domains                read   ScrapeRun   list
//   POST  /admin/official-domains/:host/revoke   update ScrapeRun   revoke + pause its sources
//   GET   /admin/route-sources/country-lookup    read   ScrapeRun   code -> English name, what exists
//   POST  /admin/route-sources                   update ScrapeRun   register a route under an authority
//   PATCH /admin/guidance-sources/:id            update ScrapeRun   status / role
//
// Every route runs `verifyAuth` first (401 without a valid token), then the
// shared CASL ability on the admin-only `ScrapeRun` subject (403 for client,
// agent and agency owner), BEFORE any validation, read or fetch, so nothing
// leaks to non-admins. No role strings here: the ability decides. Bodies are
// strict: unknown keys are rejected with 400.
//
// Error body: `{ success:false, error: CODE, message, ...extra }`.
//
// Issue #232 (P3 of #228): official websites and registered routes belong to
// an issuing AUTHORITY (country, bloc or treaty). Bodies and views carry
// `authorityId` where they carried `countryCode`; an unknown authority is
// 400 INVALID_AUTHORITY, a retired one 409 AUTHORITY_RETIRED, and a host
// already confirmed for another authority 409 HOST_CONFIRMED_FOR_OTHER_AUTHORITY.

/** Admin uid for audit fields (verifyAuth always sets it). */
const uid = (req: AuthenticatedRequest): string => req.userId ?? req.authz?.uid ?? "unknown";

/** Send a RegistryError, or a 500 for anything unexpected (never leaking details). */
function fail(res: Response, err: unknown, what: string): void {
  if (isRegistryError(err)) {
    res.status(err.status).json({ success: false, error: err.code, message: err.message, ...err.extra });
    return;
  }
  console.error(`Registry: error ${what}:`, err);
  sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
}

/** Epoch -> ISO for a stored Timestamp (null when absent). */
const iso = (v: unknown): string | null => (v && typeof (v as Timestamp).toDate === "function" ? (v as Timestamp).toDate().toISOString() : null);

/** Admin view of one stored domain (explicit fields, ISO dates). */
function domainView(d: OfficialDomain) {
  return {
    host: d.host,
    // The authority the host belongs to (a country code, or a bloc/treaty id).
    authorityId: d.authorityId,
    status: d.status,
    confirmedBy: d.confirmedBy,
    confirmedAt: iso(d.confirmedAt),
    statement: d.statement,
    evidencePreview: d.evidencePreview ? { ...d.evidencePreview, previewedAt: iso(d.evidencePreview.previewedAt) } : null,
    addedVia: d.addedVia,
    revokedBy: d.revokedBy ?? null,
    revokedAt: iso(d.revokedAt),
    revokeReason: d.revokeReason ?? null,
  };
}

/** An object body with only `allowed` keys, or a RegistryError 400. */
function strictBody(raw: unknown, allowed: readonly string[]): Record<string, unknown> {
  const body = raw === undefined || raw === null ? {} : raw;
  if (typeof body !== "object" || Array.isArray(body)) throw new RegistryError("VALIDATION_ERROR", 400, "The body must be a JSON object");
  for (const k of Object.keys(body)) {
    if (!allowed.includes(k)) throw new RegistryError("VALIDATION_ERROR", 400, `"${k}" is not a known field`, { field: k });
  }
  return body as Record<string, unknown>;
}

class RegistryController {
  /** CASL gate: 403 and false when not allowed. */
  private allowed(req: AuthenticatedRequest, res: Response, action: "read" | "update"): boolean {
    if (can(req, action, asSubject("ScrapeRun", {}))) return true;
    forbidden(res, "Only admins can manage the source registry");
    return false;
  }

  /** POST /admin/official-domains/preview { url } */
  async preview(req: AuthenticatedRequest, res: Response): Promise<void> {
    if (!this.allowed(req, res, "update")) return;
    try {
      const body = strictBody(req.body, ["url"]);
      // Shape first: a bad address costs no allowance and makes no request.
      const parsed = parseRegistryUrl(body.url);
      if (!parsed.ok) throw new RegistryError(parsed.code, 400, parsed.message);
      const loaded = await loadRegistrySettings();
      if (loaded.readError) throw new RegistryError("SETTINGS_UNAVAILABLE", 503, "Settings could not be read; try again shortly");
      const limit = await registryRateLimiter.consume(uid(req), "preview", loaded.settings.previewsPerHour);
      if (!limit.allowed) {
        throw new RegistryError("RATE_LIMITED", 429, `You have checked ${loaded.settings.previewsPerHour} addresses this hour; try again later`, { retryAfterSeconds: limit.retryAfterSeconds });
      }
      const preview = await sourcePreviewService.preview(parsed.url.href, { purpose: "check" });
      // Server-held evidence for a later confirmation.
      await officialDomainsService.recordPreview(uid(req), preview);
      const [hostStatus, finalHostStatus] = await Promise.all([officialDomainsService.statusOf(preview.host), officialDomainsService.statusOf(preview.finalHost)]);
      sendSuccess(res, { ...preview, hostStatus, finalHostStatus });
    } catch (err) {
      fail(res, err, "checking an address");
    }
  }

  /** POST /admin/official-domains { host, authorityId, statement } */
  async confirm(req: AuthenticatedRequest, res: Response): Promise<void> {
    if (!this.allowed(req, res, "update")) return;
    try {
      const body = strictBody(req.body, ["host", "authorityId", "statement"]);
      const { domain, created } = await officialDomainsService.confirm(body as { host: unknown; authorityId: unknown; statement: unknown }, uid(req));
      sendSuccess(res, { created, domain: domainView(domain) }, undefined, created ? 201 : 200);
    } catch (err) {
      fail(res, err, "confirming a host");
    }
  }

  /** GET /admin/official-domains */
  async list(req: AuthenticatedRequest, res: Response): Promise<void> {
    if (!this.allowed(req, res, "read")) return;
    try {
      const domains = (await officialDomainsService.list()).map(domainView);
      sendSuccess(res, { domains, total: domains.length });
    } catch (err) {
      fail(res, err, "listing hosts");
    }
  }

  /** POST /admin/official-domains/:host/revoke { reason? } */
  async revoke(req: AuthenticatedRequest, res: Response): Promise<void> {
    if (!this.allowed(req, res, "update")) return;
    try {
      const body = strictBody(req.body, ["reason"]);
      const r = await officialDomainsService.revoke((req.params as { host?: string }).host, body.reason, uid(req));
      sendSuccess(res, { changed: r.changed, domain: domainView(r.domain), pausedGuidanceSources: r.pausedGuidanceSources, pausedVisaPages: r.pausedVisaPages });
    } catch (err) {
      fail(res, err, "revoking a host");
    }
  }

  /** GET /admin/route-sources/country-lookup?code=SV */
  async countryLookup(req: AuthenticatedRequest, res: Response): Promise<void> {
    if (!this.allowed(req, res, "read")) return;
    try {
      const code = (req.query as Record<string, unknown>).code;
      sendSuccess(res, await countryLookup(code));
    } catch (err) {
      fail(res, err, "looking up a country");
    }
  }

  /** POST /admin/route-sources */
  async register(req: AuthenticatedRequest, res: Response): Promise<void> {
    if (!this.allowed(req, res, "update")) return;
    try {
      const result = await routeRegistrationService.register(req.body, uid(req));
      sendSuccess(res, result, undefined, result.created ? 201 : 200);
    } catch (err) {
      fail(res, err, "registering a route");
    }
  }

  /** PATCH /admin/guidance-sources/:id { status?, role? } */
  async patchGuidanceSource(req: AuthenticatedRequest, res: Response): Promise<void> {
    if (!this.allowed(req, res, "update")) return;
    try {
      const r = await guidanceSourceEditService.patch((req.params as { id?: string }).id ?? "", req.body, uid(req));
      sendSuccess(res, r);
    } catch (err) {
      fail(res, err, "editing a guidance source");
    }
  }
}

export const registryController = new RegistryController();
