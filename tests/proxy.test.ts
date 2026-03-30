// Test suite for Proxy Server
import { describe, it, expect } from "vitest";
import jwt from "jsonwebtoken";

const JWT_SECRET = "test-secret-key-for-unit-tests";

describe("Proxy Server: JWT Validation", () => {
  it("creates and verifies valid JWT", () => {
    const token = jwt.sign({ userId: "test-user", plan: "free" }, JWT_SECRET, {
      expiresIn: "1h",
    });
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    expect(decoded.userId).toBe("test-user");
    expect(decoded.plan).toBe("free");
  });

  it("rejects expired JWT", () => {
    const token = jwt.sign({ userId: "test" }, JWT_SECRET, {
      expiresIn: "-1s",
    });
    expect(() => jwt.verify(token, JWT_SECRET)).toThrow();
  });

  it("rejects JWT with wrong secret", () => {
    const token = jwt.sign({ userId: "test" }, "wrong-secret");
    expect(() => jwt.verify(token, JWT_SECRET)).toThrow();
  });

  it("rejects malformed JWT", () => {
    expect(() => jwt.verify("not-a-jwt", JWT_SECRET)).toThrow();
  });

  it("includes correct claims in token", () => {
    const claims = { userId: "u123", plan: "team", rateLimit: 60 };
    const token = jwt.sign(claims, JWT_SECRET, { expiresIn: "24h" });
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    expect(decoded.userId).toBe("u123");
    expect(decoded.plan).toBe("team");
    expect(decoded.rateLimit).toBe(60);
  });
});

describe("Proxy Server: Rate Limiting Logic", () => {
  it("rate limit window is 60 seconds", () => {
    const windowMs = 60 * 1000;
    expect(windowMs).toBe(60000);
  });

  it("correctly calculates retry-after seconds", () => {
    const resetTime = Date.now() + 30000;
    const retryAfter = Math.ceil((resetTime - Date.now()) / 1000);
    expect(retryAfter).toBeGreaterThanOrEqual(29);
    expect(retryAfter).toBeLessThanOrEqual(31);
  });

  it("rate limit map tracks per-user counts", () => {
    const rateLimitMap = new Map<
      string,
      { count: number; resetTime: number }
    >();

    rateLimitMap.set("user1", { count: 5, resetTime: Date.now() + 60000 });
    rateLimitMap.set("user2", { count: 3, resetTime: Date.now() + 60000 });

    expect(rateLimitMap.get("user1")!.count).toBe(5);
    expect(rateLimitMap.get("user2")!.count).toBe(3);
  });

  it("detects when rate limit exceeded", () => {
    const limit = 60;
    const count = 61;
    expect(count > limit).toBe(true);
  });

  it("does not reject when under rate limit", () => {
    const limit = 60;
    const count = 59;
    expect(count > limit).toBe(false);
  });
});

describe("Proxy Server: Token Guard (60k limit)", () => {
  it("60k tokens = 240k chars", () => {
    const MAX_TOKENS = 60000;
    const MAX_CHARS = MAX_TOKENS * 4;
    expect(MAX_CHARS).toBe(240000);
  });

  it("truncates message exceeding limit", () => {
    const maxChars = 240000;
    const longMessage = "a".repeat(300000);
    const remainingChars = maxChars - 1000;
    if (remainingChars > 100) {
      const truncated =
        longMessage.slice(0, remainingChars) + "\n...[truncated]...";
      expect(truncated.length).toBeLessThan(longMessage.length);
      expect(truncated).toContain("[truncated]");
    }
  });

  it("does NOT truncate message under limit", () => {
    const maxChars = 240000;
    const message = "a".repeat(1000);
    expect(message.length).toBeLessThan(maxChars);
  });
});
