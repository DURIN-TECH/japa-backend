import { Router } from "express";
import { verifyAuth } from "../middleware/auth";
import { feedbackController } from "../controllers/feedback.controller";

// In-app tester feedback (issue #257). Any signed-in role; the write block for
// lapsed plans is lifted for these two POSTs in middleware/auth.ts.
export const feedbackRoutes = Router();

// Step 1: signed PUT URL for the optional screenshot.
feedbackRoutes.post("/screenshot-url", verifyAuth, (req, res) =>
  feedbackController.getScreenshotUploadUrl(req, res)
);

// Step 2: the note itself.
feedbackRoutes.post("/", verifyAuth, (req, res) => feedbackController.create(req, res));
