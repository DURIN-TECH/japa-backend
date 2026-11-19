// ============================================
// Agency visas: HTTP handlers (issue #100)
// ============================================
//
// Mounted at `/agency/visas` (see ./agency-visa.routes.ts and the contract,
// ./agency-visas.md). Every route runs `verifyAuth` first (401 without a
// valid token); these handlers then:
//
//  1. Gate the CALLER (403): they must belong to an agency (`agencyId` claim)
//     AND their shared CASL ability must allow the action on a `Visa` owned
//     by that agency. The probe is a tagged subject
//     (`asSubject("Visa", { ownerAgencyId, source })`), never a string
//     subject: a string-subject `can(..., "Visa")` ignores the rule
//     conditions and would say yes to any role with any conditional grant.
//     An agent with no agency, a client and an admin (no agency) all get 403.
//  2. Validate the body (400, naming the field; protected keys refused).
//  3. Call the service, which scopes every lookup to the caller's agency
//     (another agency's id = 404, same body as an unknown id) and re-checks
//     the ability on the real doc via the `authorize` callback built here.
//
// No role literals: who may do what comes from the ability only.

import { Response } from "express";
import { AGENCY_VISA_SOURCE, Action } from "@durin-tech/authz";
import { AuthenticatedRequest } from "../middleware/auth";
import { asSubject, can, forbidden } from "../middleware/authz";
import { sendCreated, sendError, sendSuccess, ErrorMessages } from "../utils/response";
import type { VisaType } from "../types";
import { AgencyVisaActor, AuthorizeVisa, agencyVisaService } from "./agency-visa.service";
import { AgencyVisaContent, AgencyVisaError, parseAgencyVisaBody } from "./agency-visa.validation";

// ============================================
// Helpers
// ============================================

/**
 * Step 1: the caller gate. Returns the actor (agency + uid) when the caller
 * belongs to an agency and may `action` a visa of that agency; otherwise
 * answers 403 and returns null.
 */
function gate(req: AuthenticatedRequest, res: Response, action: Action): AgencyVisaActor | null {
  const agencyId = req.authz?.agencyId;
  const uid = req.userId ?? req.authz?.uid;
  if (!agencyId || !uid) {
    forbidden(res, "Only members of an agency can manage agency visas");
    return null;
  }
  // Tagged probe: the conditions (`ownerAgencyId`, `source`) are matched.
  const probe = asSubject("Visa", { ownerAgencyId: agencyId, source: AGENCY_VISA_SOURCE });
  if (!can(req, action, probe)) {
    forbidden(res, "You do not have access to agency visas");
    return null;
  }
  return { agencyId, uid };
}

/**
 * The `authorize` callback the service calls on the real doc: CASL `action`
 * on the doc tagged as a `Visa` (a copy, so the tag never ends up in a write),
 * and, when `fields` are given, `action` on each field (the field-level
 * `cannot update` rules on VISA_PROTECTED_FIELDS).
 */
function authorizer(req: AuthenticatedRequest, action: Action): AuthorizeVisa {
  return (visa: VisaType, fields?: string[]) => {
    const subject = asSubject("Visa", { ...visa } as unknown as Record<string, unknown>);
    if (!can(req, action, subject)) return false;
    return (fields ?? []).every((f) => req.ability?.can(action, subject as never, f) ?? false);
  };
}

/** Send an AgencyVisaError, or a 500 for anything else. */
function sendFailure(res: Response, error: unknown, what: string): void {
  if (error instanceof AgencyVisaError) {
    res.status(error.httpStatus).json({
      success: false,
      error: error.code,
      message: error.message,
      ...(error.field ? { field: error.field } : {}),
    });
    return;
  }
  console.error(`Error ${what} agency visa:`, error);
  sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
}

// ============================================
// Handlers
// ============================================

export class AgencyVisaController {
  /** GET /agency/visas — this agency's visas, newest first (`[]` when none). */
  async list(req: AuthenticatedRequest, res: Response): Promise<void> {
    const actor = gate(req, res, "read");
    if (!actor) return;
    try {
      const visas = await agencyVisaService.list(actor.agencyId, authorizer(req, "read"));
      sendSuccess(res, visas);
    } catch (error) {
      sendFailure(res, error, "listing");
    }
  }

  /** GET /agency/visas/:id — one visa + pending revision; 404 if not this agency's. */
  async get(req: AuthenticatedRequest, res: Response): Promise<void> {
    const actor = gate(req, res, "read");
    if (!actor) return;
    try {
      const visa = await agencyVisaService.get(actor.agencyId, req.params.id, authorizer(req, "read"));
      sendSuccess(res, visa);
    } catch (error) {
      sendFailure(res, error, "getting");
    }
  }

  /** POST /agency/visas — create a draft (full set of required fields). */
  async create(req: AuthenticatedRequest, res: Response): Promise<void> {
    const actor = gate(req, res, "create");
    if (!actor) return;
    try {
      const parsed = parseAgencyVisaBody(req.body, "create");
      const visa = await agencyVisaService.create(
        parsed.fields as AgencyVisaContent,
        actor,
        authorizer(req, "create")
      );
      sendCreated(res, visa, "Visa draft created");
    } catch (error) {
      sendFailure(res, error, "creating");
    }
  }

  /**
   * PUT|PATCH /agency/visas/:id — partial update (both verbs merge). An
   * approved visa gets a pending revision instead (live doc unchanged).
   */
  async update(req: AuthenticatedRequest, res: Response): Promise<void> {
    const actor = gate(req, res, "update");
    if (!actor) return;
    try {
      const parsed = parseAgencyVisaBody(req.body, "update");
      const visa = await agencyVisaService.update(req.params.id, parsed, actor, authorizer(req, "update"));
      sendSuccess(res, visa, "Visa updated");
    } catch (error) {
      sendFailure(res, error, "updating");
    }
  }

  /** POST /agency/visas/:id/submit — send a draft / rejected visa for review. */
  async submit(req: AuthenticatedRequest, res: Response): Promise<void> {
    const actor = gate(req, res, "update");
    if (!actor) return;
    try {
      const visa = await agencyVisaService.submit(req.params.id, actor, authorizer(req, "update"));
      sendSuccess(res, visa, "Visa submitted for review");
    } catch (error) {
      sendFailure(res, error, "submitting");
    }
  }

  /** DELETE /agency/visas/:id — delete a never-submitted draft. */
  async remove(req: AuthenticatedRequest, res: Response): Promise<void> {
    const actor = gate(req, res, "delete");
    if (!actor) return;
    try {
      await agencyVisaService.remove(req.params.id, actor, authorizer(req, "delete"));
      sendSuccess(res, { id: req.params.id }, "Visa draft deleted");
    } catch (error) {
      sendFailure(res, error, "deleting");
    }
  }
}

export const agencyVisaController = new AgencyVisaController();
