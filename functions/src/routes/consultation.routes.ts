import { Router } from "express";
import { consultationController } from "../controllers/consultation.controller";
import { verifyAuth } from "../middleware/auth";

const router = Router();

// /stats must come before /:id to avoid "stats" matching as an id
router.get("/stats", verifyAuth, (req, res) =>
  consultationController.getStats(req, res)
);

router.get("/", verifyAuth, (req, res) =>
  consultationController.getConsultations(req, res)
);

router.post("/", verifyAuth, (req, res) =>
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
