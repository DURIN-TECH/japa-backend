import { Router } from "express";
import { documentCheckController } from "../controllers/document-check.controller";
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

// Per-upload document check (issue #115). No requireFeature: the tier is decided
// in the handler (fail closed), and a free caller gets an upgrade state, not a 402,
// on the read.
router.get("/:id/check", verifyAuth, (req, res) => documentCheckController.get(req, res));
router.post("/:id/check/retry", verifyAuth, (req, res) => documentCheckController.retry(req, res));

export { router as documentRoutes };
