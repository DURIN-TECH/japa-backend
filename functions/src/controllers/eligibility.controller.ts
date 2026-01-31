import { Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import { eligibilityService } from "../services/eligibility.service";
import {
  sendSuccess,
  sendError,
  sendCreated,
  ErrorMessages,
} from "../utils/response";

export class EligibilityController {
  /**
   * POST /eligibility/pre-check
   * Check if user needs a visa based on nationality and destination
   */
  async preCheck(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { nationality, destinationCountry, travelPurpose, intendedStayDays } = req.body;

      if (!nationality || !destinationCountry || !travelPurpose) {
        sendError(
          res,
          "VALIDATION_ERROR",
          "nationality, destinationCountry, and travelPurpose are required",
          400
        );
        return;
      }

      const validPurposes = ["tourism", "business", "work", "study", "family", "transit", "other"];
      if (!validPurposes.includes(travelPurpose)) {
        sendError(
          res,
          "VALIDATION_ERROR",
          `Invalid travelPurpose. Allowed: ${validPurposes.join(", ")}`,
          400
        );
        return;
      }

      const result = await eligibilityService.preCheck({
        nationality,
        destinationCountry,
        travelPurpose,
        intendedStayDays: intendedStayDays ? Number(intendedStayDays) : undefined,
      });

      sendSuccess(res, result);
    } catch (error) {
      console.error("Error in visa pre-check:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * GET /eligibility/questions/:visaTypeId
   * Get eligibility questions for a visa type
   */
  async getQuestions(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { visaTypeId } = req.params;
      const { nationality, destinationCountry } = req.query;

      if (!visaTypeId) {
        sendError(res, "VALIDATION_ERROR", "visaTypeId is required", 400);
        return;
      }

      const questions = await eligibilityService.getQuestions(
        visaTypeId,
        nationality as string | undefined,
        destinationCountry as string | undefined
      );

      sendSuccess(res, questions);
    } catch (error) {
      console.error("Error getting eligibility questions:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * POST /eligibility/check
   * Submit eligibility answers and get score
   */
  async submitCheck(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.userId!;
      const { visaTypeId, countryCode, nationality, travelPurpose, answers } = req.body;

      if (!visaTypeId || !countryCode || !nationality || !answers) {
        sendError(
          res,
          "VALIDATION_ERROR",
          "visaTypeId, countryCode, nationality, and answers are required",
          400
        );
        return;
      }

      if (!Array.isArray(answers)) {
        sendError(res, "VALIDATION_ERROR", "answers must be an array", 400);
        return;
      }

      const result = await eligibilityService.submitCheck(userId, {
        visaTypeId,
        countryCode,
        nationality,
        travelPurpose,
        answers,
      });

      sendCreated(res, result, "Eligibility check completed");
    } catch (error) {
      console.error("Error submitting eligibility check:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * GET /eligibility/checks
   * Get user's eligibility check history
   */
  async getUserChecks(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.userId!;

      const checks = await eligibilityService.getUserChecks(userId);

      sendSuccess(res, checks);
    } catch (error) {
      console.error("Error getting user eligibility checks:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * GET /eligibility/checks/:checkId
   * Get a specific eligibility check
   */
  async getCheck(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.userId!;
      const { checkId } = req.params;

      const check = await eligibilityService.getCheckById(checkId);

      if (!check) {
        sendError(res, "NOT_FOUND", "Eligibility check not found", 404);
        return;
      }

      // Verify ownership
      if (check.userId !== userId) {
        sendError(res, "FORBIDDEN", ErrorMessages.FORBIDDEN, 403);
        return;
      }

      sendSuccess(res, check);
    } catch (error) {
      console.error("Error getting eligibility check:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * GET /eligibility/checks/latest/:visaTypeId
   * Get user's latest check for a specific visa type
   */
  async getLatestCheck(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const userId = req.userId!;
      const { visaTypeId } = req.params;

      const check = await eligibilityService.getLatestCheck(userId, visaTypeId);

      if (!check) {
        sendSuccess(res, null, "No previous eligibility check found");
        return;
      }

      sendSuccess(res, check);
    } catch (error) {
      console.error("Error getting latest eligibility check:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  // ============================================
  // ADMIN ENDPOINTS
  // ============================================

  /**
   * POST /admin/eligibility/questions
   * Create a new eligibility question (admin only)
   */
  async createQuestion(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const {
        scope,
        question,
        description,
        helpText,
        type,
        options,
        weight,
        correctAnswers,
        partialAnswers,
        minValue,
        maxValue,
        idealMin,
        idealMax,
        unit,
        failRecommendation,
        orderIndex,
        isRequired,
        visaTypeId,
        applicableNationalities,
        excludedNationalities,
        dependsOn,
      } = req.body;

      if (!scope || !question || !type || weight === undefined || orderIndex === undefined) {
        sendError(
          res,
          "VALIDATION_ERROR",
          "scope, question, type, weight, and orderIndex are required",
          400
        );
        return;
      }

      const validTypes = ["boolean", "single", "multiple", "number", "date", "text"];
      if (!validTypes.includes(type)) {
        sendError(
          res,
          "VALIDATION_ERROR",
          `Invalid type. Allowed: ${validTypes.join(", ")}`,
          400
        );
        return;
      }

      const created = await eligibilityService.createQuestion({
        scope,
        question,
        description,
        helpText,
        type,
        options,
        weight,
        correctAnswers,
        partialAnswers,
        minValue,
        maxValue,
        idealMin,
        idealMax,
        unit,
        failRecommendation,
        orderIndex,
        isRequired: isRequired ?? true,
        isActive: true,
        visaTypeId,
        applicableNationalities,
        excludedNationalities,
        dependsOn,
      });

      sendCreated(res, created, "Eligibility question created");
    } catch (error) {
      console.error("Error creating eligibility question:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * POST /admin/eligibility/seed
   * Seed questions for a visa type (admin only)
   */
  async seedQuestions(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { visaTypeId, questions } = req.body;

      if (!visaTypeId || !questions || !Array.isArray(questions)) {
        sendError(
          res,
          "VALIDATION_ERROR",
          "visaTypeId and questions array are required",
          400
        );
        return;
      }

      await eligibilityService.seedVisaQuestions(visaTypeId, questions);

      sendSuccess(res, { seeded: questions.length }, "Questions seeded successfully");
    } catch (error) {
      console.error("Error seeding eligibility questions:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * POST /admin/eligibility/seed/nigeria-ireland
   * Seed Nigeria → Ireland eligibility questions (admin only)
   */
  async seedNigeriaIreland(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const result = await eligibilityService.seedNigeriaIreland();

      sendSuccess(
        res,
        result,
        `Seeded ${result.questionsSeeded} questions and ${result.exemptionsSeeded} exemption(s) for Nigeria → Ireland`
      );
    } catch (error) {
      console.error("Error seeding Nigeria-Ireland eligibility:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * GET /admin/eligibility/questions
   * Get all questions (admin only)
   */
  async listQuestions(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { scope, isActive, limit } = req.query;

      const questions = await eligibilityService.getAllQuestions({
        scope: scope as string | undefined,
        isActive: isActive === "true" ? true : isActive === "false" ? false : undefined,
        limit: limit ? Number(limit) : undefined,
      });

      sendSuccess(res, questions);
    } catch (error) {
      console.error("Error listing eligibility questions:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * PUT /admin/eligibility/questions/:questionId
   * Update a question (admin only)
   */
  async updateQuestion(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { questionId } = req.params;
      const updates = req.body;

      // Remove fields that shouldn't be updated directly
      delete updates.id;
      delete updates.createdAt;

      const updated = await eligibilityService.updateQuestion(questionId, updates);

      if (!updated) {
        sendError(res, "NOT_FOUND", "Question not found", 404);
        return;
      }

      sendSuccess(res, updated, "Question updated successfully");
    } catch (error) {
      console.error("Error updating eligibility question:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * DELETE /admin/eligibility/questions/:questionId
   * Delete a question (admin only)
   */
  async deleteQuestion(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const { questionId } = req.params;

      const deleted = await eligibilityService.deleteQuestion(questionId);

      if (!deleted) {
        sendError(res, "NOT_FOUND", "Question not found", 404);
        return;
      }

      sendSuccess(res, { deleted: true }, "Question deleted successfully");
    } catch (error) {
      console.error("Error deleting eligibility question:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }
}

export const eligibilityController = new EligibilityController();
