import { Response } from "express";
import type { Timestamp } from "firebase-admin/firestore";
import { AuthenticatedRequest } from "../middleware/auth";
import { asSubject, can, forbidden } from "../middleware/authz";
import { ErrorMessages, sendError, sendSuccess } from "../utils/response";
import { isRegistryError, RegistryError } from "../scrapers";
import type { Authority, AuthorityMember } from "../types/authority";
import { authorityService, requireAuthorityId } from "./authority.service";

// ============================================
// ADMIN — AUTHORITIES API (issue #230, P1 of #228)
// ============================================
//
//   GET   /admin/authorities                              read   ScrapeRun   list
//   POST  /admin/authorities                              update ScrapeRun   create { id, kind, name }
//   GET   /admin/authorities/:id                          read   ScrapeRun   one
//   PATCH /admin/authorities/:id                          update ScrapeRun   { name?, status? }
//   GET   /admin/authorities/:id/members?on=YYYY-MM-DD    read   ScrapeRun   members current on that date
//   PUT   /admin/authorities/:id/members/:countryCode     update ScrapeRun   add/change one member
//
// Same gates as the source registry (scrapers/shared/registry): `verifyAuth`
// (401) and `verifyAdmin` in the router, then the shared CASL ability on the
// admin-only `ScrapeRun` subject (403 for client, agent and agency owner),
// BEFORE any validation or read, so nothing leaks to non-admins. Bodies are
// strict (unknown keys: 400). There is no delete: an authority is retired, a
// member gets a `leftOn` date.
//
// Error body: `{ success:false, error: CODE, message, ...extra }`.

/** Admin uid for audit fields (verifyAuth always sets it). */
const uid = (req: AuthenticatedRequest): string => req.userId ?? req.authz?.uid ?? "unknown";

/** Send a RegistryError, or a 500 for anything unexpected (never leaking details). */
function fail(res: Response, err: unknown, what: string): void {
  if (isRegistryError(err)) {
    res.status(err.status).json({ success: false, error: err.code, message: err.message, ...err.extra });
    return;
  }
  console.error(`Authorities: error ${what}:`, err);
  sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
}

/** Stored Timestamp -> ISO string (null when absent). */
const iso = (v: unknown): string | null => (v && typeof (v as Timestamp).toDate === "function" ? (v as Timestamp).toDate().toISOString() : null);

/** Admin view of an authority (explicit fields, ISO dates). */
export function authorityView(a: Authority) {
  return { id: a.id, kind: a.kind, name: a.name, status: a.status, createdBy: a.createdBy, createdAt: iso(a.createdAt), updatedBy: a.updatedBy, updatedAt: iso(a.updatedAt) };
}

/** Admin view of a member (explicit fields, ISO timestamps; calendar dates stay YYYY-MM-DD). */
export function memberView(m: AuthorityMember) {
  return {
    countryCode: m.countryCode,
    joinedOn: m.joinedOn,
    leftOn: m.leftOn ?? null,
    sourceQuote: m.sourceQuote,
    sourceUrl: m.sourceUrl,
    createdBy: m.createdBy,
    createdAt: iso(m.createdAt),
    updatedBy: m.updatedBy,
    updatedAt: iso(m.updatedAt),
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

/** Path parameter as a string (Express gives string | undefined). */
const param = (req: AuthenticatedRequest, name: string): string | undefined => (req.params as Record<string, string | undefined>)[name];

class AuthorityController {
  /** CASL gate: 403 and false when not allowed. */
  private allowed(req: AuthenticatedRequest, res: Response, action: "read" | "update"): boolean {
    if (can(req, action, asSubject("ScrapeRun", {}))) return true;
    forbidden(res, "Only admins can manage authorities");
    return false;
  }

  /** GET /admin/authorities */
  async list(req: AuthenticatedRequest, res: Response): Promise<void> {
    if (!this.allowed(req, res, "read")) return;
    try {
      const authorities = (await authorityService.list()).map(authorityView);
      sendSuccess(res, { authorities, total: authorities.length });
    } catch (err) {
      fail(res, err, "listing authorities");
    }
  }

  /** POST /admin/authorities { id, kind, name } -> 201 new, 200 same body again. */
  async create(req: AuthenticatedRequest, res: Response): Promise<void> {
    if (!this.allowed(req, res, "update")) return;
    try {
      const body = strictBody(req.body, ["id", "kind", "name"]);
      const { authority, created } = await authorityService.create(body, uid(req));
      sendSuccess(res, { created, authority: authorityView(authority) }, undefined, created ? 201 : 200);
    } catch (err) {
      fail(res, err, "creating an authority");
    }
  }

  /** GET /admin/authorities/:id */
  async get(req: AuthenticatedRequest, res: Response): Promise<void> {
    if (!this.allowed(req, res, "read")) return;
    try {
      const id = requireAuthorityId(param(req, "id"));
      const authority = await authorityService.get(id);
      if (!authority) throw new RegistryError("NOT_FOUND", 404, "There is no authority with that id");
      sendSuccess(res, { authority: authorityView(authority) });
    } catch (err) {
      fail(res, err, "reading an authority");
    }
  }

  /** PATCH /admin/authorities/:id { name?, status? } */
  async update(req: AuthenticatedRequest, res: Response): Promise<void> {
    if (!this.allowed(req, res, "update")) return;
    try {
      const body = strictBody(req.body, ["name", "status"]);
      const { authority, changed } = await authorityService.update(param(req, "id"), body, uid(req));
      sendSuccess(res, { changed, authority: authorityView(authority) });
    } catch (err) {
      fail(res, err, "editing an authority");
    }
  }

  /** GET /admin/authorities/:id/members?on=YYYY-MM-DD (default today, UTC) */
  async members(req: AuthenticatedRequest, res: Response): Promise<void> {
    if (!this.allowed(req, res, "read")) return;
    try {
      const query = req.query as Record<string, unknown>;
      // A repeated ?on=...&on=... arrives as an array: refuse rather than pick one.
      if (query.on !== undefined && typeof query.on !== "string") {
        throw new RegistryError("INVALID_DATE", 400, "on must be one date written YYYY-MM-DD", { field: "on" });
      }
      const r = await authorityService.membersOn(param(req, "id"), query.on);
      sendSuccess(res, { authorityId: r.authority.id, on: r.on, members: r.members.map(memberView), total: r.members.length });
    } catch (err) {
      fail(res, err, "listing members");
    }
  }

  /** PUT /admin/authorities/:id/members/:countryCode { joinedOn, leftOn?, sourceQuote, sourceUrl } */
  async putMember(req: AuthenticatedRequest, res: Response): Promise<void> {
    if (!this.allowed(req, res, "update")) return;
    try {
      const body = strictBody(req.body, ["joinedOn", "leftOn", "sourceQuote", "sourceUrl"]);
      const r = await authorityService.putMember(param(req, "id"), param(req, "countryCode"), body, uid(req));
      sendSuccess(res, { created: r.created, changed: r.changed, member: memberView(r.member) }, undefined, r.created ? 201 : 200);
    } catch (err) {
      fail(res, err, "saving a member");
    }
  }
}

export const authorityController = new AuthorityController();
