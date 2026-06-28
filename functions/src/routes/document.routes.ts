import { Router } from "express";
import { documentController } from "../controllers/document.controller";
import { verifyAuth } from "../middleware/auth";
import { requireFeature } from "../middleware/authz";
import { FEATURES } from "@durin-tech/authz";

const router = Router();

// Get signed upload URL — gated by the "documents.upload" entitlement
router.post("/upload-url", verifyAuth, requireFeature(FEATURES.DOCUMENTS_UPLOAD), (req, res) =>
  documentController.getUploadUrl(req, res)
);

// Document CRUD — registering an uploaded doc is also gated
router.post("/", verifyAuth, requireFeature(FEATURES.DOCUMENTS_UPLOAD), (req, res) =>
  documentController.createDocument(req, res)
);
router.get("/:id", verifyAuth, (req, res) =>
  documentController.getDocument(req, res)
);
router.get("/:id/download", verifyAuth, (req, res) =>
  documentController.getDownloadUrl(req, res)
);
router.delete("/:id", verifyAuth, (req, res) =>
  documentController.deleteDocument(req, res)
);

// Document status (for agents)
router.put("/:id/status", verifyAuth, (req, res) =>
  documentController.updateDocumentStatus(req, res)
);

export { router as documentRoutes };
