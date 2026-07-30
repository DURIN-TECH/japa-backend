import { Router } from "express";
import { consultationController } from "../controllers/consultation.controller";
import { verifyAuth } from "../middleware/auth";
import { requireFeature } from "../middleware/authz";
import { FEATURES } from "@durin-tech/authz";

const router = Router();

// PUBLIC — no auth: verify-on-return for a guest consultation payment. Defined
// before "/:id" so "public" isn't matched as a consultation id.
router.post("/public/verify", (req, res) =>
  consultationController.verifyPublicConsultation(req, res)
);

// /stats must come before /:id to avoid "stats" matching as an id
router.get("/stats", verifyAuth, (req, res) =>
  consultationController.getStats(req, res)
);

router.get("/", verifyAuth, (req, res) =>
  consultationController.getConsultations(req, res)
);

router.post("/", verifyAuth, requireFeature(FEATURES.CONSULTATIONS_BOOK), (req, res) =>
  consultationController.createConsultation(req, res)
);

router.get("/:id", verifyAuth, (req, res) =>
  consultationController.getConsultation(req, res)
);

router.put("/:id", verifyAuth, (req, res) =>
  consultationController.updateConsultation(req, res)
);

router.put("/:id/status", verifyAuth, (req, res) =>
  consultationController.updateStatus(req, res)
);

router.delete("/:id", verifyAuth, (req, res) =>
  consultationController.deleteConsultation(req, res)
);

export { router as consultationRoutes };
