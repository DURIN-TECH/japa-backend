import { Router } from "express";
import { applicationController } from "../controllers/application.controller";
import { noteController } from "../controllers/note.controller";
import { documentController } from "../controllers/document.controller";
import { verifyAuth } from "../middleware/auth";
import { requireFeature } from "../middleware/authz";
import { FEATURES } from "@durin-tech/authz";

const router = Router();

// Application CRUD — creating is gated by the "applications.create" entitlement;
// the per-plan active-application limit is enforced inside the handlers.
router.post("/", verifyAuth, requireFeature(FEATURES.APPLICATIONS_CREATE), (req, res) =>
  applicationController.createApplication(req, res)
);
// Agent starts an application on a client's behalf (portal flow). Must be declared
// before the parameterized "/:id" routes so it isn't shadowed by them.
router.post("/for-client", verifyAuth, requireFeature(FEATURES.APPLICATIONS_CREATE), (req, res) =>
  applicationController.createApplicationForClient(req, res)
);
router.get("/", verifyAuth, (req, res) =>
  applicationController.getApplications(req, res)
);
router.get("/:id", verifyAuth, (req, res) =>
  applicationController.getApplication(req, res)
);
router.put("/:id", verifyAuth, (req, res) =>
  applicationController.updateApplication(req, res)
);
router.delete("/:id", verifyAuth, (req, res) =>
  applicationController.deleteApplication(req, res)
);

// Application status & timeline
router.put("/:id/status", verifyAuth, (req, res) =>
  applicationController.updateStatus(req, res)
);
router.get("/:id/timeline", verifyAuth, (req, res) =>
  applicationController.getTimeline(req, res)
);

// Application notes
router.get("/:id/notes", verifyAuth, (req, res) =>
  noteController.getNotes(req, res)
);
router.post("/:id/notes", verifyAuth, (req, res) =>
  noteController.addNote(req, res)
);
router.put("/:id/notes/:noteId", verifyAuth, (req, res) =>
  noteController.updateNote(req, res)
);
router.delete("/:id/notes/:noteId", verifyAuth, (req, res) =>
  noteController.deleteNote(req, res)
);

// Application documents
router.get("/:applicationId/documents", verifyAuth, (req, res) =>
  documentController.getApplicationDocuments(req, res)
);
// Agent requests a document from the client (records an activity note + notifies)
router.post("/:id/documents/request", verifyAuth, (req, res) =>
  applicationController.requestDocument(req, res)
);

export { router as applicationRoutes };
