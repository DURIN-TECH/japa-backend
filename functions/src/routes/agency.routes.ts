import { Router } from "express";
import { agencyController } from "../controllers/agency.controller";
import { verifyAuth, verifyAdmin } from "../middleware/auth";

// Routes mounted at /agencies
const agencyRoutes = Router();

// Agency CRUD — /me routes before /:id
agencyRoutes.get("/me", verifyAuth, (req, res) =>
  agencyController.getMyAgency(req, res)
);
agencyRoutes.put("/me", verifyAuth, (req, res) =>
  agencyController.updateMyAgency(req, res)
);

agencyRoutes.post("/", verifyAuth, (req, res) =>
  agencyController.createAgency(req, res)
);

// Admin: list all agencies
agencyRoutes.get("/", verifyAuth, verifyAdmin, (req, res) =>
  agencyController.getAllAgencies(req, res)
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

// Agency invitations
agencyRoutes.post("/:id/invitations", verifyAuth, (req, res) =>
  agencyController.inviteAgent(req, res)
);
agencyRoutes.get("/:id/invitations", verifyAuth, (req, res) =>
  agencyController.getInvitations(req, res)
);

// Routes mounted at /invitations
const invitationRoutes = Router();

invitationRoutes.post("/:id/accept", verifyAuth, (req, res) =>
  agencyController.acceptInvitation(req, res)
);
invitationRoutes.post("/:id/decline", verifyAuth, (req, res) =>
  agencyController.declineInvitation(req, res)
);

export { agencyRoutes, invitationRoutes };
