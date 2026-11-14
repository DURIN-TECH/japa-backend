import { Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import { asSubject, can, forbidden } from "../middleware/authz";
import { sendError, sendSuccess, ErrorMessages } from "../utils/response";
import { isCountryCode, checkAuthorityId, parseCalendarDate } from "../authorities/authority-ids";
import { HELD_DOCUMENT_KINDS, type HeldDocumentKind } from "../types/applicant-facts";
import type { HeldDocumentFact } from "../services/ai/applicant-groups";
import type { TravelPurpose } from "../types/eligibility";
import { ENTRY_RULE_STATUSES } from "../types/entry-requirements";
import { ENTRY_PURPOSES } from "./entry-rule-validate";
import { entryRequirementsService, type EntryRequirementsService, type LookupInput } from "./entry-requirements.service";
import { entryRuleStore, type EntryRuleStore } from "./entry-rule.store";

// ============================================
// ENTRY REQUIREMENTS — CONTROLLER (issue #236, P7 of #228)
// ============================================
//
//   GET /entry-requirements?destination=XA&nationality=XB,XC&residence=XD
//       &holds=residence_permit:XE:2027-05-01&purpose=tourism&stayDays=30
//       &useMyHoldings=true
//     Signed-in users (any role, any plan): the answer is stored data, no AI
//     call, so it is free (decision on the issue). Rate limited per user.
//     Reads the CALLER's own holdings only when `useMyHoldings=true`; no
//     parameter can name another person.
//
//   GET /admin/entry-rules?authorityId=&status=&limit=       admin review data
//   GET /admin/entry-rules/runs?authorityId=&limit=          admin review data
//     Admin only (CASL `read ScrapeRun`, the registry's admin subject).
//
// Refusals name the PARAMETER, never the value (nationality and holdings are
// personal data and are never logged).

/** Most lookups one user may make per minute on one instance. */
export const LOOKUPS_PER_MINUTE = 60;

/** The query parameters the lookup accepts (anything else is a 400). */
const LOOKUP_PARAMS = new Set(["destination", "nationality", "residence", "holds", "purpose", "stayDays", "useMyHoldings"]);

/** A refused query: 400 naming the parameter. */
export class LookupQueryError extends Error {
  constructor(readonly param: string, message: string) {
    super(message);
    this.name = "LookupQueryError";
  }
}

/** A query value as one string (a repeated parameter is refused). */
function one(query: Record<string, unknown>, name: string): string | undefined {
  const v = query[name];
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw new LookupQueryError(name, `${name} must be given once`);
  return v.trim();
}

/** A comma list of values ("" items refused). */
function list(raw: string, name: string, max: number): string[] {
  const items = raw.split(",").map((s) => s.trim());
  if (items.length > max) throw new LookupQueryError(name, `${name} takes at most ${max} values`);
  if (items.some((s) => s.length === 0)) throw new LookupQueryError(name, `${name} has an empty value`);
  return items;
}

/** A two-letter code, upper-cased. */
function code(raw: string, name: string): string {
  const c = raw.toUpperCase();
  if (!isCountryCode(c)) throw new LookupQueryError(name, `${name} must be a two-letter country code`);
  return c;
}

/**
 * Parse one held document given in the query: `kind:issuer:YYYY-MM-DD`
 * (issuer a country code or an authority id; the date it is valid until). The
 * date is REQUIRED: an expired document must never match, so a document with
 * no date is refused rather than assumed valid.
 */
export function parseHoldsParam(raw: string): HeldDocumentFact {
  const [kind, issuer, validUntil, ...rest] = raw.split(":");
  if (rest.length > 0 || !kind || !issuer || !validUntil) throw new LookupQueryError("holds", "each holds value is kind:issuer:YYYY-MM-DD");
  if (!(HELD_DOCUMENT_KINDS as readonly string[]).includes(kind)) throw new LookupQueryError("holds", "holds kind must be visa, residence_permit or travel_authorisation");
  const date = parseCalendarDate(validUntil);
  if (!date) throw new LookupQueryError("holds", "holds date must be YYYY-MM-DD");
  const upper = issuer.toUpperCase();
  if (isCountryCode(upper)) return { kind: kind as HeldDocumentKind, issuerCountryCode: upper, validUntil: date };
  if (checkAuthorityId(issuer).ok) return { kind: kind as HeldDocumentKind, issuerAuthorityId: issuer, validUntil: date };
  throw new LookupQueryError("holds", "holds issuer must be a country code or an authority id");
}

/** Parse and validate the lookup query. Pure (exported for tests). */
export function parseLookupQuery(query: Record<string, unknown>, uid: string): LookupInput {
  for (const key of Object.keys(query)) if (!LOOKUP_PARAMS.has(key)) throw new LookupQueryError(key, `${key} is not a lookup parameter`);
  const destination = one(query, "destination");
  if (!destination) throw new LookupQueryError("destination", "destination is required");
  const input: LookupInput = { destination: code(destination, "destination") };
  const nat = one(query, "nationality");
  if (nat) input.nationalities = [...new Set(list(nat, "nationality", 5).map((n) => code(n, "nationality")))];
  const res = one(query, "residence");
  if (res) input.residentialCountry = code(res, "residence");
  const holds = one(query, "holds");
  if (holds !== undefined) input.heldDocuments = holds === "" ? [] : list(holds, "holds", 20).map(parseHoldsParam);
  const purpose = one(query, "purpose");
  if (purpose) {
    if (!(ENTRY_PURPOSES as readonly string[]).includes(purpose)) throw new LookupQueryError("purpose", `purpose must be one of ${ENTRY_PURPOSES.join(", ")}`);
    input.purpose = purpose as TravelPurpose;
  }
  const stay = one(query, "stayDays");
  if (stay) {
    const n = Number(stay);
    if (!Number.isInteger(n) || n < 1 || n > 3650) throw new LookupQueryError("stayDays", "stayDays must be a whole number of days from 1 to 3650");
    input.stayDays = n;
  }
  const mine = one(query, "useMyHoldings");
  if (mine !== undefined) {
    if (mine !== "true" && mine !== "false") throw new LookupQueryError("useMyHoldings", "useMyHoldings must be true or false");
    // Always the signed-in caller: no parameter names whose holdings are read.
    if (mine === "true") input.useMyHoldings = { uid };
  }
  return input;
}

/**
 * A small per-user, per-instance rate limit (a sliding minute). The lookup is
 * free and cached, so this only stops a runaway client; it is not a quota.
 */
export class LookupRateLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly perMinute = LOOKUPS_PER_MINUTE, private readonly now: () => number = () => Date.now()) {}

  /** Record a hit; false when the user is over the limit. */
  allow(uid: string): boolean {
    const t = this.now();
    const recent = (this.hits.get(uid) ?? []).filter((at) => t - at < 60_000);
    if (recent.length >= this.perMinute) {
      this.hits.set(uid, recent);
      return false;
    }
    recent.push(t);
    // Bound the map: forget everyone when it grows large (only costs a fresh window).
    if (this.hits.size > 10_000) this.hits.clear();
    this.hits.set(uid, recent);
    return true;
  }
}

/** A limit query parameter (1..200, default 50). */
function limitOf(raw: unknown): number {
  const n = typeof raw === "string" ? Number(raw) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= 200 ? n : 50;
}

export class EntryRequirementsController {
  constructor(
    private readonly service: Pick<EntryRequirementsService, "lookup"> = entryRequirementsService,
    private readonly store: Pick<EntryRuleStore, "listRules" | "listRuns"> = entryRuleStore,
    private readonly limiter: LookupRateLimiter = new LookupRateLimiter()
  ) {}

  /** GET /entry-requirements */
  async lookup(req: AuthenticatedRequest, res: Response): Promise<void> {
    const uid = req.userId;
    if (!uid) {
      sendError(res, "UNAUTHORIZED", "Sign in to check entry requirements", 401);
      return;
    }
    if (!this.limiter.allow(uid)) {
      sendError(res, "RATE_LIMITED", "Too many checks in a minute. Try again shortly.", 429);
      return;
    }
    let input: LookupInput;
    try {
      input = parseLookupQuery(req.query as Record<string, unknown>, uid);
    } catch (error) {
      if (error instanceof LookupQueryError) {
        sendError(res, "VALIDATION_ERROR", error.message, 400);
        return;
      }
      throw error;
    }
    try {
      sendSuccess(res, await this.service.lookup(input));
    } catch (error) {
      // The error's name only: never the query (personal data).
      console.error("[entry-requirements] lookup failed:", error instanceof Error ? error.name : "unknown error");
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /** CASL gate for the admin review reads: 403 and false when not allowed. */
  private adminAllowed(req: AuthenticatedRequest, res: Response): boolean {
    if (can(req, "read", asSubject("ScrapeRun", {}))) return true;
    forbidden(res, "Only admins can review entry rules");
    return false;
  }

  /** GET /admin/entry-rules */
  async listRules(req: AuthenticatedRequest, res: Response): Promise<void> {
    if (!this.adminAllowed(req, res)) return;
    const authorityId = typeof req.query.authorityId === "string" ? req.query.authorityId : undefined;
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    if (authorityId !== undefined && !checkAuthorityId(authorityId).ok) {
      sendError(res, "VALIDATION_ERROR", "authorityId is not an authority id", 400);
      return;
    }
    if (status !== undefined && !(ENTRY_RULE_STATUSES as readonly string[]).includes(status)) {
      sendError(res, "VALIDATION_ERROR", `status must be one of ${ENTRY_RULE_STATUSES.join(", ")}`, 400);
      return;
    }
    try {
      const rules = await this.store.listRules({ authorityId, status, limit: limitOf(req.query.limit) });
      sendSuccess(res, { rules, total: rules.length });
    } catch (error) {
      console.error("[entry-requirements] admin rule list failed:", error instanceof Error ? error.name : "unknown error");
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /** GET /admin/entry-rules/runs */
  async listRuns(req: AuthenticatedRequest, res: Response): Promise<void> {
    if (!this.adminAllowed(req, res)) return;
    const authorityId = typeof req.query.authorityId === "string" ? req.query.authorityId : undefined;
    if (authorityId !== undefined && !checkAuthorityId(authorityId).ok) {
      sendError(res, "VALIDATION_ERROR", "authorityId is not an authority id", 400);
      return;
    }
    try {
      const runs = await this.store.listRuns({ authorityId, limit: limitOf(req.query.limit) });
      sendSuccess(res, { runs, total: runs.length });
    } catch (error) {
      console.error("[entry-requirements] admin run list failed:", error instanceof Error ? error.name : "unknown error");
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }
}

/** The shared instance. */
export const entryRequirementsController = new EntryRequirementsController();
