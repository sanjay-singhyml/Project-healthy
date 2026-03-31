import type { Request, Response, NextFunction } from "express";

export function requestLogger(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const ts = new Date().toISOString();
  const method = req.method;
  const url = req.originalUrl || req.url;
  console.log(`[${ts}] ${method} ${url}`);
  next();
}
