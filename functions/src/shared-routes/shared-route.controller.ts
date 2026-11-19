import { Response } from "express";
import type { Timestamp } from "firebase-admin/firestore";
import { AuthenticatedRequest } from "../middleware/auth";
import { asSubject, can, forbidden } from "../middleware/authz";
import { ErrorMessages, sendError, sendSuccess } from "../utils/response";
import { isRegistryError, RegistryError } from "../scrapers";
import { isCountryCode } from "../authorities/authority-ids";
import type { SharedRoute } from "../types/shared-route";
import { resolveRouteStack } from "./route-stack";
import { requireSharedRouteId, sharedRouteService } from "./shared-route.service";

// ============================================
// ADMIN — SHARED ROUTES API (issue #231, P2 of #228)
// ============================================
//
//   GET   /admin/shared-routes                                      read   ScrapeRun  list
//   POST  /admin/shared-routes                                      update ScrapeRun  create { id, name, category, issuingAuthorityId, destinations }
//   GET   /admin/shared-routes/:id?on=YYYY-MM-DD                    read   ScrapeRun  one, with the countries it covers that day
//   PATCH /admin/shared-routes/:id                                  update ScrapeRun  { name?, category?, destinations?, status? }
//   PUT   /admin/shared-routes/inheritance/:countryCode/:visaTypeId update ScrapeRun  { inheritsFrom: [{ sharedRouteId }] }
//   GET   /admin/shared-routes/resolve/:countryCode/:visaTypeId     read   ScrapeRun  the ordered rulebook stack
//
// Same gates as the authorities API (and the source registry): `verifyAuth`
// (401) and `verifyAdmin` in the router, then the CASL ability on the
// admin-only `ScrapeRun` subject (403) BEFORE any validation or read. Strict
// bodies (unknown keys: 400). No delete: a shared route is retired.
//
// Error body: `{ success:false, error: CODE, message, ...extra }`.

const uid = (req: AuthenticatedRequest): string => req.userId ?? req.authz?.uid ?? "unknown";

function fail(res: Response, err: unknown, what: string): void {
  if (isRegistryError(err)) {
    res.status(err.status).json({ success: false, error: err.code, message: err.message, ...err.extra });
    return;
  }
  console.error(`SharedRoutes: error ${what}:`, err);
  sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
}

const iso = (v: unknown): string | null => (v && typeof (v as Timestamp).toDate === "function" ? (v as Timestamp).toDate().toISOString() : null);

/** Admin view of a shared route (explicit fields, ISO dates). */
export function sharedRouteView(r: SharedRoute) {
  return {
    id: r.id,
    name: r.name,
    category: r.category,
    issuingAuthorityId: r.issuingAuthorityId,
    destinations: r.destinations,
    status: r.status,
    createdBy: r.createdBy,
    createdAt: iso(r.createdAt),
    updatedBy: r.updatedBy,
    updatedAt: iso(r.updatedAt),
  };
}

function strictBody(raw: unknown, allowed: readonly string[]): Record<string, unknown> {
  const body = raw === undefined || raw === null ? {} : raw;
  if (typeof body !== "object" || Array.isArray(body)) throw new RegistryError("VALIDATION_ERROR", 400, "The body must be a JSON object");
  for (const k of Object.keys(body)) {
    if (!allowed.includes(k)) throw new RegistryError("VALIDATION_ERROR", 400, `"${k}" is not a known field`, { field: k });
  }
  return body as Record<string, unknown>;
}

const param = (req: AuthenticatedRequest, name: string): string | undefined => (req.params as Record<string, string | undefined>)[name];

class SharedRouteController {
  private allowed(req: AuthenticatedRequest, res: Response, action: "read" | "update"): boolean {
    if (can(req, action, asSubject("ScrapeRun", {}))) return true;
    forbidden(res, "Only admins can manage shared routes");
    return false;
  }

  async list(req: AuthenticatedRequest, res: Response): Promise<void> {
    if (!this.allowed(req, res, "read")) return;
    try {
      const sharedRoutes = (await sharedRouteService.list()).map(sharedRouteView);
      sendSuccess(res, { sharedRoutes, total: sharedRoutes.length });
    } catch (err) {
      fail(res, err, "listing shared routes");
    }
  }

  async create(req: AuthenticatedRequest, res: Response): Promise<void> {
    if (!this.allowed(req, res, "update")) return;
    try {
      const body = strictBody(req.body, ["id", "name", "category", "issuingAuthorityId", "destinations"]);
      const r = await sharedRouteService.create(body, uid(req));
      sendSuccess(res, { created: r.created, sharedRoute: sharedRouteView(r.sharedRoute) }, undefined, r.created ? 201 : 200);
    } catch (err) {
      fail(res, err, "creating a shared route");
    }
  }

  async get(req: AuthenticatedRequest, res: Response): Promise<void> {
    if (!this.allowed(req, res, "read")) return;
    try {
      const id = requireSharedRouteId(param(req, "id"));
      const route = await sharedRouteService.get(id);
      if (!route) throw new RegistryError("NOT_FOUND", 404, "There is no shared route with that id");
      const on = (req.query as Record<string, unknown>).on;
      if (on !== undefined && typeof on !== "string") throw new RegistryError("INVALID_DATE", 400, "on must be one date written YYYY-MM-DD", { field: "on" });
      const countryCodes = await sharedRouteService.destinationsOn(route, on === "" ? undefined : on);
      sendSuccess(res, { sharedRoute: sharedRouteView(route), coveredCountryCodes: countryCodes });
    } catch (err) {
      fail(res, err, "reading a shared route");
    }
  }

  async update(req: AuthenticatedRequest, res: Response): Promise<void> {
    if (!this.allowed(req, res, "update")) return;
    try {
      const body = strictBody(req.body, ["name", "category", "destinations", "status"]);
      const r = await sharedRouteService.update(param(req, "id"), body, uid(req));
      sendSuccess(res, { changed: r.changed, sharedRoute: sharedRouteView(r.sharedRoute) });
    } catch (err) {
      fail(res, err, "editing a shared route");
    }
  }

  async setInheritance(req: AuthenticatedRequest, res: Response): Promise<void> {
    if (!this.allowed(req, res, "update")) return;
    try {
      const body = strictBody(req.body, ["inheritsFrom"]);
      const r = await sharedRouteService.setInheritance(param(req, "countryCode"), param(req, "visaTypeId"), body.inheritsFrom, uid(req));
      sendSuccess(res, { changed: r.changed, countryCode: r.countryCode, visaTypeId: r.visaTypeId, inheritsFrom: r.inheritsFrom });
    } catch (err) {
      fail(res, err, "setting a visa's inheritance");
    }
  }

  async resolve(req: AuthenticatedRequest, res: Response): Promise<void> {
    if (!this.allowed(req, res, "read")) return;
    try {
      const cc = param(req, "countryCode");
      const vid = param(req, "visaTypeId");
      if (!isCountryCode(cc)) throw new RegistryError("INVALID_COUNTRY_CODE", 400, "A country is a two-letter code in capitals");
      if (!vid) throw new RegistryError("INVALID_VISA_ID", 400, "That is not a valid visa record id");
      const stack = await resolveRouteStack(cc, vid);
      sendSuccess(res, { countryCode: cc, visaTypeId: vid, stack });
    } catch (err) {
      fail(res, err, "resolving a route stack");
    }
  }
}

export const sharedRouteController = new SharedRouteController();
