import { Router } from "express";
import { newsController } from "../controllers/news.controller";
import { verifyAuth, optionalAuth } from "../middleware/auth";

const router = Router();

// Public routes (optionalAuth for personalization if logged in)
router.get("/", optionalAuth, (req, res) =>
  newsController.getArticles(req, res)
);

// Subscription routes (must come before /:id to avoid collision)
router.get("/subscriptions/me", verifyAuth, (req, res) =>
  newsController.getMySubscription(req, res)
);

router.put("/subscriptions/me", verifyAuth, (req, res) =>
  newsController.updateMySubscription(req, res)
);

// Admin routes
router.get("/admin/sources", verifyAuth, (req, res) =>
  newsController.getSources(req, res)
);

router.get("/admin/sources/:sourceId/runs", verifyAuth, (req, res) =>
  newsController.getScrapeRuns(req, res)
);

// Article detail (after specific routes to avoid collision)
router.get("/:id", optionalAuth, (req, res) =>
  newsController.getArticle(req, res)
);

export { router as newsRoutes };
