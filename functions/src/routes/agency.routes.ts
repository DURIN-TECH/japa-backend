import { Router } from "express";
import { agencyController } from "../controllers/agency.controller";
import { complianceController } from "../controllers/compliance.controller";
import { consultationController } from "../controllers/consultation.controller";
import { verifyAuth, verifyAdmin, optionalAuth } from "../middleware/auth";
import { requireFeature } from "../middleware/authz";
import { FEATURES } from "@durin-tech/authz";
import { sendError } from "../utils/response";

// Routes mounted at /agencies
const agencyRoutes = Router();

// PUBLIC — no auth: powers the shareable public agency landing page.
// Two-segment "/public/:slug" path, defined before the single-segment "/:id"
// matcher so it can't be shadowed. Returns only whitelisted, non-sensitive fields.
// Issue #286: `optionalAuth` on every public price read here, so a signed-in
// client sees prices in their own currency; no / invalid token = guest.
agencyRoutes.get("/public/:slug", optionalAuth, (req, res) =>
  agencyController.getPublicAgency(req, res)
);

// PUBLIC — no auth: guest books a consultation with this agency from the public
// page. Provisions a client by email and (when the agency charges a fee) returns
// a Paystack checkout URL. Also a 3-segment "/public/..." path, safe from "/:id".
agencyRoutes.post("/public/:slug/consultations", (req, res) =>
  consultationController.createPublicConsultation(req, res)
);

// PUBLIC — no auth: agency directory for the mobile Explorer (issue #144).
// Registered BEFORE every "/:id..." param route so the literal "browse"
// segment is never captured as an ":id" (e.g. GET /agencies/browse is not
// "agency browse"). Read-only; each returns the PUBLIC-safe projection only.
agencyRoutes.get("/browse", optionalAuth, (req, res) =>
  agencyController.browseAgencies(req, res)
);
agencyRoutes.get("/browse/:id", optionalAuth, (req, res) =>
  agencyController.getPublicAgencyById(req, res)
);
agencyRoutes.get("/browse/:id/agents", optionalAuth, (req, res) =>
  agencyController.getPublicAgencyAgents(req, res)
);

// The directory is read-only: any other method on /browse or below gets a
// 405 here and writes nothing. Without this, e.g. PUT /agencies/browse/approval
// would fall through to the "/:id/approval" route (id = "browse"). GET / HEAD
// requests that matched no route above fall through to the normal 404.
agencyRoutes.all(["/browse", "/browse/*"], (req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD") {
    next();
    return;
  }
  res.set("Allow", "GET, HEAD");
  sendError(res, "METHOD_NOT_ALLOWED", "Method not allowed", 405);
});

// Agency CRUD — /me routes before /:id
agencyRoutes.get("/me", verifyAuth, (req, res) =>
  agencyController.getMyAgency(req, res)
);
agencyRoutes.put("/me", verifyAuth, (req, res) =>
  agencyController.updateMyAgency(req, res)
);

// Agency logo (white-label branding) — owner only. Defined before "/:id"
// routes; both are 3-segment "/me/..." paths so they can't be shadowed by
// the single-segment "/:id" matcher.
agencyRoutes.post("/me/logo/upload-url", verifyAuth, (req, res) =>
  agencyController.getLogoUploadUrl(req, res)
);
agencyRoutes.post("/me/logo", verifyAuth, (req, res) =>
  agencyController.setLogo(req, res)
);

// Agency compliance (KYC/KYB/payout) — owner only. All are 3-segment
// "/me/compliance..." paths, defined before "/:id" so they can't be shadowed.
agencyRoutes.get("/me/compliance", verifyAuth, (req, res) =>
  complianceController.getMyCompliance(req, res)
);
agencyRoutes.put("/me/compliance", verifyAuth, (req, res) =>
  complianceController.updateMyCompliance(req, res)
);
agencyRoutes.post("/me/compliance/upload-url", verifyAuth, (req, res) =>
  complianceController.getUploadUrl(req, res)
);
agencyRoutes.post("/me/compliance/documents", verifyAuth, (req, res) =>
  complianceController.registerDocument(req, res)
);
agencyRoutes.post("/me/compliance/submit", verifyAuth, (req, res) =>
  complianceController.submitForReview(req, res)
);

agencyRoutes.post("/", verifyAuth, (req, res) =>
  agencyController.createAgency(req, res)
);

// Admin: list pending agencies
agencyRoutes.get("/pending", verifyAuth, verifyAdmin, (req, res) =>
  agencyController.getPendingAgencies(req, res)
);

// Admin: list all agencies
agencyRoutes.get("/", verifyAuth, verifyAdmin, (req, res) =>
  agencyController.getAllAgencies(req, res)
);

// Admin: get agency review data
agencyRoutes.get("/:id/review", verifyAuth, verifyAdmin, (req, res) =>
  agencyController.getAgencyReview(req, res)
);

// Admin: approve/reject agency
agencyRoutes.put("/:id/approval", verifyAuth, verifyAdmin, (req, res) =>
  agencyController.updateAgencyApproval(req, res)
);

// Admin: review + decide agency compliance (KYC/KYB/payout)
agencyRoutes.get("/:id/compliance", verifyAuth, verifyAdmin, (req, res) =>
  complianceController.getComplianceForReview(req, res)
);
agencyRoutes.put("/:id/compliance/decision", verifyAuth, verifyAdmin, (req, res) =>
  complianceController.decide(req, res)
);

// Agency members
agencyRoutes.get("/:id/members", verifyAuth, (req, res) =>
  agencyController.getMembers(req, res)
);
// "Add an existing agent" sends that agent an invitation they must accept
// (issue #138), so it carries the same entitlement gate as the invitation
// route below.
agencyRoutes.post("/:id/members", verifyAuth, requireFeature(FEATURES.AGENCY_INVITE_AGENTS), (req, res) =>
  agencyController.addMember(req, res)
);
agencyRoutes.delete("/:id/members/:agentId", verifyAuth, (req, res) =>
  agencyController.removeMember(req, res)
);

// Agency invitations — gated by the "agency.invite_agents" entitlement (seat limit
// is additionally enforced in the controller/service).
agencyRoutes.post("/:id/invitations", verifyAuth, requireFeature(FEATURES.AGENCY_INVITE_AGENTS), (req, res) =>
  agencyController.inviteAgent(req, res)
);
agencyRoutes.get("/:id/invitations", verifyAuth, (req, res) =>
  agencyController.getInvitations(req, res)
);

// Routes mounted at /invitations
const invitationRoutes = Router();

// Must come before /:id routes
invitationRoutes.get("/pending", verifyAuth, (req, res) =>
  agencyController.getMyPendingInvitations(req, res)
);

// PUBLIC — no auth: lets the signup page show the invite's agency before the
// invitee has an account. Returns only non-sensitive fields.
invitationRoutes.get("/:id/preview", (req, res) =>
  agencyController.getInvitationPreview(req, res)
);

invitationRoutes.post("/:id/accept", verifyAuth, (req, res) =>
  agencyController.acceptInvitation(req, res)
);
invitationRoutes.post("/:id/decline", verifyAuth, (req, res) =>
  agencyController.declineInvitation(req, res)
);

// Owner-initiated cancel of a pending invite (ownership enforced in controller).
invitationRoutes.delete("/:id", verifyAuth, (req, res) =>
  agencyController.cancelInvitation(req, res)
);

export { agencyRoutes, invitationRoutes };
