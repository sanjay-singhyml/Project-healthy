import type { Request, Response, NextFunction } from "express";

export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  console.error(`[ERROR] ${new Date().toISOString()} ${err.message}`);
  if (process.env.NODE_ENV !== "production") {
    console.error(err.stack);
  }

  res.status(500).json({
    error: "INTERNAL_ERROR",
    message:
      process.env.NODE_ENV === "production"
        ? "An internal error occurred"
        : err.message,
  });
}
