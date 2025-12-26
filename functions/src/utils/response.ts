import { Response } from "express";

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
  pagination?: PaginationMeta;
}

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

/**
 * Send a successful response
 */
export function sendSuccess<T>(
  res: Response,
  data: T,
  message?: string,
  statusCode = 200
): void {
  const response: ApiResponse<T> = {
    success: true,
    data,
  };

  if (message) {
    response.message = message;
  }

  res.status(statusCode).json(response);
}

/**
 * Send a successful response with pagination
 */
export function sendPaginatedSuccess<T>(
  res: Response,
  data: T[],
  pagination: PaginationMeta,
  message?: string
): void {
  const response: ApiResponse<T[]> = {
    success: true,
    data,
    pagination,
  };

  if (message) {
    response.message = message;
  }

  res.status(200).json(response);
}

/**
 * Send an error response
 */
export function sendError(
  res: Response,
  error: string,
  message: string,
  statusCode = 400
): void {
  res.status(statusCode).json({
    success: false,
    error,
    message,
  });
}

/**
 * Send a created response (201)
 */
export function sendCreated<T>(
  res: Response,
  data: T,
  message = "Resource created successfully"
): void {
  sendSuccess(res, data, message, 201);
}

/**
 * Send a no content response (204)
 */
export function sendNoContent(res: Response): void {
  res.status(204).send();
}

/**
 * Standard error messages
 */
export const ErrorMessages = {
  NOT_FOUND: "Resource not found",
  UNAUTHORIZED: "Authentication required",
  FORBIDDEN: "You don't have permission to access this resource",
  VALIDATION_ERROR: "Validation failed",
  INTERNAL_ERROR: "An unexpected error occurred",
  DUPLICATE: "Resource already exists",
  INVALID_INPUT: "Invalid input provided",
} as const;

/**
 * Calculate pagination meta
 */
export function calculatePagination(
  page: number,
  limit: number,
  total: number
): PaginationMeta {
  const totalPages = Math.ceil(total / limit);
  
  return {
    page,
    limit,
    total,
    totalPages,
    hasNext: page < totalPages,
    hasPrev: page > 1,
  };
}

/**
 * Parse pagination params from query string
 */
export function parsePaginationParams(query: {
  page?: string;
  limit?: string;
}): { page: number; limit: number; offset: number } {
  const page = Math.max(1, parseInt(query.page || "1", 10));
  const limit = Math.min(100, Math.max(1, parseInt(query.limit || "20", 10)));
  const offset = (page - 1) * limit;

  return { page, limit, offset };
}
