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
// (GET /admin/sources was removed in issue #17; it is superseded by
// GET /admin/scrape-sources?kind=news.)
router.get("/admin/sources/:sourceId/runs", verifyAuth, (req, res) =>
  newsController.getScrapeRuns(req, res)
);

// Article detail (after specific routes to avoid collision)
router.get("/:id", optionalAuth, (req, res) =>
  newsController.getArticle(req, res)
);

export { router as newsRoutes };
