import { Request, Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import { asSubject, can, forbidden } from "../middleware/authz";
import { newsService } from "../services/news.service";
import {
  sendSuccess,
  sendError,
  sendNotFound,
  ErrorMessages,
} from "../utils/response";
import { SupportedCountryCode } from "../types/news";
import { Timestamp } from "firebase-admin/firestore";

class NewsController {
  /**
   * GET /news?country=CA&limit=20&after=<timestamp>
   */
  async getArticles(req: Request, res: Response): Promise<void> {
    try {
      const { country, limit, after } = req.query;

      const articles = await newsService.getArticles({
        countryCode: country as SupportedCountryCode | undefined,
        limit: limit ? parseInt(limit as string, 10) : 20,
        startAfter: after
          ? Timestamp.fromMillis(parseInt(after as string, 10))
          : undefined,
      });

      sendSuccess(res, articles);
    } catch (error) {
      console.error("Error getting news articles:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * GET /news/:id
   */
  async getArticle(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const article = await newsService.getArticleById(id);

      if (!article) {
        sendNotFound(res, "Article not found");
        return;
      }

      // Fire-and-forget view count increment
      newsService.incrementViewCount(id).catch(() => {});

      sendSuccess(res, article);
    } catch (error) {
      console.error("Error getting article:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * GET /news/subscriptions/me
   */
  async getMySubscription(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      const userId = req.userId!;
      const subscription = await newsService.getSubscription(userId);
      sendSuccess(res, subscription);
    } catch (error) {
      console.error("Error getting subscription:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * PUT /news/subscriptions/me
   */
  async updateMySubscription(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      const userId = req.userId!;
      const { countryCodes, importanceThreshold, pushEnabled } = req.body;

      const subscription = await newsService.upsertSubscription(userId, {
        countryCodes,
        importanceThreshold,
        pushEnabled,
      });

      sendSuccess(res, subscription, "Subscription updated");
    } catch (error) {
      console.error("Error updating subscription:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * GET /news/admin/sources/:sourceId/runs (admin only, CASL `read ScrapeRun`).
   * (GET /news/admin/sources was removed in issue #17: use
   * GET /admin/scrape-sources?kind=news.)
   */
  async getScrapeRuns(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      // Issue #17: the standard CASL gate (admin-only via the ScrapeRun
      // subject), replacing the hand-rolled `req.user?.admin` check. Runs
      // before any read so non-admins learn nothing.
      if (!can(req, "read", asSubject("ScrapeRun", {}))) {
        forbidden(res);
        return;
      }

      const { sourceId } = req.params;
      const limit = parseInt(req.query.limit as string) || 20;

      const runs = await newsService.getScrapeRuns(sourceId, limit);
      sendSuccess(res, runs);
    } catch (error) {
      console.error("Error getting scrape runs:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }
}

export const newsController = new NewsController();
