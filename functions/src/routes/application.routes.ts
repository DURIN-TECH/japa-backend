import { Router } from "express";
import { applicationController } from "../controllers/application.controller";
import { noteController } from "../controllers/note.controller";
import { documentController } from "../controllers/document.controller";
import { verifyAuth } from "../middleware/auth";

const router = Router();

// Application CRUD
router.post("/", verifyAuth, (req, res) =>
  applicationController.createApplication(req, res)
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

export { router as applicationRoutes };
