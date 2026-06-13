import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { logger } from "./logger.js";

export class HttpError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

export const errorHandler = (
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void => {
  if (err instanceof HttpError) {
    res.status(err.statusCode).json({ error: err.code, message: err.message });
    return;
  }
  if (err instanceof z.ZodError) {
    res
      .status(400)
      .json({ error: "invalid_request", message: "Validation failed", details: err.issues });
    return;
  }
  logger.error({ err }, "unhandled error");
  res.status(500).json({ error: "internal_error", message: "Internal server error" });
};
