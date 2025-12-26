import { Request, Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import { visaService } from "../services/visa.service";
import {
  sendSuccess,
  sendError,
  sendCreated,
  ErrorMessages,
} from "../utils/response";
import { VisaCategory } from "../types";

export class VisaController {
  // ============================================
  // COUNTRY ENDPOINTS
  // ============================================

  /**
   * GET /countries
   * Get all supported countries
   */
  async getCountries(req: Request, res: Response): Promise<void> {
    try {
      const includeUnsupported = req.query.includeUnsupported === "true";
      const countries = await visaService.getCountries(!includeUnsupported);

      sendSuccess(res, countries);
    } catch (error) {
      console.error("Error getting countries:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * GET /countries/:code
   * Get country by code
   */
  async getCountry(req: Request, res: Response): Promise<void> {
    try {
      const { code } = req.params;
      const country = await visaService.getCountryByCode(code);

      if (!country) {
        sendError(res, "NOT_FOUND", "Country not found", 404);
        return;
      }

      sendSuccess(res, country);
    } catch (error) {
      console.error("Error getting country:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * POST /countries (admin only)
   * Create a new country
   */
  async createCountry(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      const { code, name, flagUrl, isSupported } = req.body;

      if (!code || !name) {
        sendError(
          res,
          "VALIDATION_ERROR",
          "code and name are required",
          400
        );
        return;
      }

      const country = await visaService.createCountry({
        code,
        name,
        flagUrl,
        isSupported,
      });

      sendCreated(res, country, "Country created successfully");
    } catch (error) {
      console.error("Error creating country:", error);
      if ((error as Error).message === "Country already exists") {
        sendError(res, "DUPLICATE", "Country already exists", 409);
        return;
      }
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  // ============================================
  // VISA TYPE ENDPOINTS
  // ============================================

  /**
   * GET /countries/:code/visas
   * Get all visa types for a country
   */
  async getVisaTypes(req: Request, res: Response): Promise<void> {
    try {
      const { code } = req.params;
      const { category } = req.query;

      // Check country exists
      const country = await visaService.getCountryByCode(code);
      if (!country) {
        sendError(res, "NOT_FOUND", "Country not found", 404);
        return;
      }

      let visaTypes;
      if (category) {
        visaTypes = await visaService.getVisaTypesByCategory(
          code,
          category as VisaCategory
        );
      } else {
        visaTypes = await visaService.getVisaTypesByCountry(code);
      }

      sendSuccess(res, visaTypes);
    } catch (error) {
      console.error("Error getting visa types:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * GET /countries/:code/visas/:visaId
   * Get visa type details
   */
  async getVisaType(req: Request, res: Response): Promise<void> {
    try {
      const { code, visaId } = req.params;

      const visaType = await visaService.getVisaType(code, visaId);

      if (!visaType) {
        sendError(res, "NOT_FOUND", "Visa type not found", 404);
        return;
      }

      sendSuccess(res, visaType);
    } catch (error) {
      console.error("Error getting visa type:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * GET /countries/:code/visas/:visaId/full
   * Get visa type with requirements
   */
  async getVisaTypeWithRequirements(
    req: Request,
    res: Response
  ): Promise<void> {
    try {
      const { code, visaId } = req.params;

      const result = await visaService.getVisaTypeWithRequirements(
        code,
        visaId
      );

      if (!result) {
        sendError(res, "NOT_FOUND", "Visa type not found", 404);
        return;
      }

      sendSuccess(res, result);
    } catch (error) {
      console.error("Error getting visa type with requirements:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * POST /countries/:code/visas (admin only)
   * Create a new visa type
   */
  async createVisaType(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      const { code } = req.params;
      const input = req.body;

      // Validate required fields
      const requiredFields = [
        "name",
        "code",
        "description",
        "category",
        "processingTime",
        "processingDaysMin",
        "processingDaysMax",
        "baseCostUsd",
        "validityPeriod",
        "eligibilityCriteria",
      ];

      const missing = requiredFields.filter((f) => !input[f]);
      if (missing.length > 0) {
        sendError(
          res,
          "VALIDATION_ERROR",
          `Missing required fields: ${missing.join(", ")}`,
          400
        );
        return;
      }

      const visaType = await visaService.createVisaType({
        ...input,
        countryCode: code,
      });

      sendCreated(res, visaType, "Visa type created successfully");
    } catch (error) {
      console.error("Error creating visa type:", error);
      if ((error as Error).message === "Country not found") {
        sendError(res, "NOT_FOUND", "Country not found", 404);
        return;
      }
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  // ============================================
  // REQUIREMENT ENDPOINTS
  // ============================================

  /**
   * GET /countries/:code/visas/:visaId/requirements
   * Get all requirements for a visa type
   */
  async getRequirements(req: Request, res: Response): Promise<void> {
    try {
      const { code, visaId } = req.params;

      const requirements = await visaService.getRequirements(code, visaId);
      sendSuccess(res, requirements);
    } catch (error) {
      console.error("Error getting requirements:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * POST /countries/:code/visas/:visaId/requirements (admin only)
   * Create a new requirement
   */
  async createRequirement(
    req: AuthenticatedRequest,
    res: Response
  ): Promise<void> {
    try {
      const { code, visaId } = req.params;
      const input = req.body;

      // Validate required fields
      if (
        !input.title ||
        !input.description ||
        !input.estimatedTime ||
        input.orderIndex === undefined
      ) {
        sendError(
          res,
          "VALIDATION_ERROR",
          "title, description, estimatedTime, and orderIndex are required",
          400
        );
        return;
      }

      const requirement = await visaService.createRequirement(
        code,
        visaId,
        input
      );

      sendCreated(res, requirement, "Requirement created successfully");
    } catch (error) {
      console.error("Error creating requirement:", error);
      if ((error as Error).message === "Visa type not found") {
        sendError(res, "NOT_FOUND", "Visa type not found", 404);
        return;
      }
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  // ============================================
  // SEARCH ENDPOINTS
  // ============================================

  /**
   * GET /visas/search
   * Search visa types across all countries
   */
  async searchVisaTypes(req: Request, res: Response): Promise<void> {
    try {
      const { q } = req.query;

      if (!q || typeof q !== "string") {
        sendError(res, "VALIDATION_ERROR", "Search query is required", 400);
        return;
      }

      const results = await visaService.searchVisaTypes(q);
      sendSuccess(res, results);
    } catch (error) {
      console.error("Error searching visa types:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }

  /**
   * GET /visas/popular
   * Get popular visa types
   */
  async getPopularVisaTypes(req: Request, res: Response): Promise<void> {
    try {
      const limit = parseInt(req.query.limit as string) || 10;
      const visaTypes = await visaService.getPopularVisaTypes(limit);

      sendSuccess(res, visaTypes);
    } catch (error) {
      console.error("Error getting popular visa types:", error);
      sendError(res, "INTERNAL_ERROR", ErrorMessages.INTERNAL_ERROR, 500);
    }
  }
}

export const visaController = new VisaController();
