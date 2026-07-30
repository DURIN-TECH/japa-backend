import { Router } from "express";
import { agencyController } from "../controllers/agency.controller";
import { complianceController } from "../controllers/compliance.controller";
import { consultationController } from "../controllers/consultation.controller";
import { verifyAuth, verifyAdmin } from "../middleware/auth";
import { requireFeature } from "../middleware/authz";
import { FEATURES } from "@durin-tech/authz";

// Routes mounted at /agencies
const agencyRoutes = Router();

// PUBLIC — no auth: powers the shareable public agency landing page.
// Two-segment "/public/:slug" path, defined before the single-segment "/:id"
// matcher so it can't be shadowed. Returns only whitelisted, non-sensitive fields.
agencyRoutes.get("/public/:slug", (req, res) =>
  agencyController.getPublicAgency(req, res)
);

// PUBLIC — no auth: guest books a consultation with this agency from the public
// page. Provisions a client by email and (when the agency charges a fee) returns
// a Paystack checkout URL. Also a 3-segment "/public/..." path, safe from "/:id".
agencyRoutes.post("/public/:slug/consultations", (req, res) =>
  consultationController.createPublicConsultation(req, res)
);

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
agencyRoutes.post("/:id/members", verifyAuth, (req, res) =>
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
