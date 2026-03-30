import { describe, expect, it } from "vitest";
import type { HealthReport } from "../src/types/index.js";
import {
  buildAskPrompt,
  buildRagAskMessages,
  extractQuestionKeywords,
  normalizeAstIndex,
  rankRelevantFiles,
  scoreAstFile,
} from "../src/proxy/rag.js";

const report: HealthReport = {
  score: 68,
  generatedAt: "2026-03-24T22:58:33.672Z",
  projectRoot: "/project",
  modules: [],
  findings: [],
  topActions: ["Fix auth flow", "Improve docs"],
};

describe("RAG pipeline", () => {
  it("extracts question keywords and removes stopwords", () => {
    expect(
      extractQuestionKeywords("How does the auth middleware work in the proxy?"),
    ).toEqual(["auth", "middleware", "work", "proxy"]);
  });

  it("scores files using file paths, exports, and functions", () => {
    const score = scoreAstFile(
      {
        filePath: "src/proxy/auth-middleware.ts",
        exports: ["authMiddleware"],
        imports: [],
        functions: [{ name: "validateAuthToken", line: 12 }],
      },
      ["auth", "middleware"],
    );

    expect(score).toBeGreaterThan(0);
  });

  it("ranks the top relevant files", () => {
    const ranked = rankRelevantFiles(
      [
        {
          filePath: "src/auth/index.ts",
          exports: ["authLogin"],
          imports: [],
          functions: [{ name: "authLogin", line: 10 }],
        },
        {
          filePath: "src/proxy/server.ts",
          exports: ["startServer"],
          imports: [],
          functions: [{ name: "streamChat", line: 40 }],
        },
      ],
      ["auth"],
      5,
    );

    expect(ranked).toHaveLength(1);
    expect(ranked[0].filePath).toBe("src/auth/index.ts");
  });

  it("builds the prompt with health summary and relevant files", () => {
    const prompt = buildAskPrompt(
      report,
      [
        {
          filePath: "src/auth/index.ts",
          exports: ["authLogin", "authStatus"],
          imports: [],
          functions: [{ name: "authLogin", line: 10 }],
        },
      ],
      "How does login work?",
    );

    expect(prompt).toContain("PROJECT HEALTH SUMMARY");
    expect(prompt).toContain("Overall score: 68/100");
    expect(prompt).toContain("=== src/auth/index.ts ===");
    expect(prompt).toContain("USER QUESTION: How does login work?");
  });

  it("builds chat messages from the prompt", () => {
    const messages = buildRagAskMessages("prompt body");

    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("system");
    expect(messages[1].role).toBe("user");
  });

  it("normalizes legacy symbol-map ast indexes", () => {
    const normalized = normalizeAstIndex({
      authLogin: {
        file: "src/auth/index.ts",
        line: 12,
        kind: "function",
      },
      AuthService: {
        file: "src/auth/index.ts",
        line: 3,
        kind: "class",
      },
    });

    expect(normalized).toHaveLength(1);
    expect(normalized[0].filePath).toBe("src/auth/index.ts");
    expect(normalized[0].functions.map((fn) => fn.name)).toEqual([
      "authLogin",
      "AuthService",
    ]);
  });
});
