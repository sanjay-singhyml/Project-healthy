import type { Request, Response, NextFunction } from "express";
import { config } from "../config.js";

interface RateLimitEntry {
  count: number;
  resetTime: number;
}

const store = new Map<string, RateLimitEntry>();

// Cleanup stale entries every 5 minutes
setInterval(
  () => {
    const now = Date.now();
    for (const [key, entry] of store) {
      if (now > entry.resetTime) store.delete(key);
    }
  },
  5 * 60 * 1000,
);

export function rateLimitMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const clientId =
    (req.headers["x-user-id"] as string) || req.ip || "anonymous";
  const now = Date.now();
  const windowMs = 60_000;

  let entry = store.get(clientId);

  if (!entry || now > entry.resetTime) {
    entry = { count: 0, resetTime: now + windowMs };
    store.set(clientId, entry);
  }

  entry.count++;

  // Set rate limit headers
  res.setHeader("X-RateLimit-Limit", config.rateLimitRpm);
  res.setHeader(
    "X-RateLimit-Remaining",
    Math.max(0, config.rateLimitRpm - entry.count),
  );
  res.setHeader("X-RateLimit-Reset", Math.ceil(entry.resetTime / 1000));

  if (entry.count > config.rateLimitRpm) {
    res.status(429).json({
      error: "RATE_LIMITED",
      message: `Rate limit exceeded. Maximum ${config.rateLimitRpm} requests per minute.`,
      retryAfter: Math.ceil((entry.resetTime - now) / 1000),
    });
    return;
  }

  next();
}
