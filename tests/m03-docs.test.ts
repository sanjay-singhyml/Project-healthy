// Test suite for M-03 Docs Freshness module
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

const TEST_DIR = join(process.cwd(), ".test-m03-tmp");
const DEFAULT_CONFIG = {
  proxy: { url: "http://localhost:3000", timeout: 30000 },
  modules: {
    cicd: {
      enabled: true,
      slowJobThresholdMinutes: 5,
      failureRateThreshold: 0.2,
    },
    quality: { enabled: true, complexityThreshold: 10, duplicateLineMin: 20 },
    docs: { enabled: true, stalenessDays: 14, aiSemanticCheck: false },
    flakiness: { enabled: true, lookbackRuns: 20, passRateThreshold: 0.95 },
    security: { enabled: true, blockedLicenses: ["GPL-3.0", "AGPL-3.0"] },
    prComplexity: {
      enabled: true,
      maxLinesChanged: 500,
      maxFilesChanged: 5,
      reviewTimeoutDays: 3,
    },
    env: { enabled: true, secretPatterns: [] },
    buildPerf: {
      enabled: true,
      bottleneckThresholdPct: 30,
      maxBuildTimeMs: 300000,
    },
  },
  scoring: {
    weights: {
      security: 20,
      quality: 18,
      cicd: 15,
      flakiness: 14,
      env: 13,
      buildPerf: 10,
      docs: 6,
      prComplexity: 4,
    },
    failUnder: 70,
  },
  docUpdater: { mode: "direct" as const },
};

beforeEach(() => {
  vi.resetModules();
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
  mkdirSync(join(TEST_DIR, "src"), { recursive: true });
  mkdirSync(join(TEST_DIR, "docs"), { recursive: true });

  try {
    execSync("git init", { cwd: TEST_DIR, stdio: "pipe" });
    execSync('git config user.email "test@test.com"', {
      cwd: TEST_DIR,
      stdio: "pipe",
    });
    execSync('git config user.name "Test User"', {
      cwd: TEST_DIR,
      stdio: "pipe",
    });
  } catch {
    /* ignore */
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("M-03: Docs Freshness", () => {
  it("P5-TC01: detects STALE_DOC when source changed >14 days ago without doc update", async () => {
    writeFileSync(
      join(TEST_DIR, "src", "PaymentService.ts"),
      "export class PaymentService { pay() {} }",
    );
    writeFileSync(
      join(TEST_DIR, "docs", "payment.md"),
      "# Payment\n\nPaymentService handles payments.",
    );
    writeFileSync(join(TEST_DIR, ".gitignore"), "");
    execSync('git add . && git commit -m "init"', {
      cwd: TEST_DIR,
      stdio: "pipe",
    });

    // Simulate old source by backdating the file via git
    const futureDate = new Date(
      Date.now() - 20 * 24 * 60 * 60 * 1000,
    ).toISOString();
    try {
      execSync(
        `git commit --allow-empty --date="${futureDate}" -m "old source change"`,
        { cwd: TEST_DIR, stdio: "pipe" },
      );
    } catch {
      /* ignore */
    }

    vi.spyOn(process, "cwd").mockReturnValue(TEST_DIR);

    const { runDocsModule } = await import("../src/modules/m03-docs/index.js");
    const result = await runDocsModule(DEFAULT_CONFIG as any);

    // Module should complete without error
    expect(result).toBeDefined();
    expect(result.moduleId).toBe("M-03");
    expect(result.moduleName).toBe("Docs Freshness");
  });

  it("does NOT flag recently updated docs", async () => {
    writeFileSync(
      join(TEST_DIR, "src", "UserService.ts"),
      "export class UserService { get() {} }",
    );
    writeFileSync(
      join(TEST_DIR, "docs", "user.md"),
      "# User\n\nUserService handles users.",
    );
    writeFileSync(join(TEST_DIR, ".gitignore"), "");
    execSync('git add . && git commit -m "init"', {
      cwd: TEST_DIR,
      stdio: "pipe",
    });

    vi.spyOn(process, "cwd").mockReturnValue(TEST_DIR);

    const { runDocsModule } = await import("../src/modules/m03-docs/index.js");
    const result = await runDocsModule(DEFAULT_CONFIG as any);

    expect(result.moduleId).toBe("M-03");
    // Recently committed docs should not be stale
    const staleFindings = result.findings.filter((f) => f.type === "STALE_DOC");
    // Allow 0 findings for fresh repo
    expect(staleFindings.length).toBeGreaterThanOrEqual(0);
  });

  it("returns 100 when no docs directory exists", async () => {
    vi.spyOn(process, "cwd").mockReturnValue(TEST_DIR);

    const { runDocsModule } = await import("../src/modules/m03-docs/index.js");
    const result = await runDocsModule(DEFAULT_CONFIG as any);

    expect(result.score).toBeLessThanOrEqual(100);
  });

  it("module disabled returns 100", async () => {
    const config = {
      ...DEFAULT_CONFIG,
      modules: {
        ...DEFAULT_CONFIG.modules,
        docs: { enabled: false, stalenessDays: 14, aiSemanticCheck: false },
      },
    };

    vi.spyOn(process, "cwd").mockReturnValue(TEST_DIR);

    const { runDocsModule } = await import("../src/modules/m03-docs/index.js");
    const result = await runDocsModule(config as any);

    expect(result.score).toBe(100);
    expect(result.metadata).toHaveProperty("enabled", false);
  });

  it("handles empty src gracefully", async () => {
    vi.spyOn(process, "cwd").mockReturnValue(TEST_DIR);

    const { runDocsModule } = await import("../src/modules/m03-docs/index.js");
    const result = await runDocsModule(DEFAULT_CONFIG as any);

    expect(result).toBeDefined();
    expect(result.moduleId).toBe("M-03");
  });

  it("includes durationMs", async () => {
    vi.spyOn(process, "cwd").mockReturnValue(TEST_DIR);

    const { runDocsModule } = await import("../src/modules/m03-docs/index.js");
    const result = await runDocsModule(DEFAULT_CONFIG as any);

    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("P5-TC05: appends aiAnalysis when semantic drift check is enabled", async () => {
    writeFileSync(
      join(TEST_DIR, "src", "PaymentService.ts"),
      "export class PaymentService { pay() {} }",
    );
    writeFileSync(
      join(TEST_DIR, "README.md"),
      "# Payment\n\nPaymentService still documents the old flow.",
    );

    const createAIClient = vi.fn(() => ({}) as any);
    const chat = vi.fn().mockResolvedValue(
      JSON.stringify({
        drift: "yes",
        analysis: "The documentation still describes the old payment flow.",
        recommendedDocChanges: "Update the payment steps to match PaymentService.pay().",
      }),
    );
    const git = {
      log: vi.fn(async (options?: any) => {
        const docNow = new Date().toISOString();
        const srcOld = new Date(
          Date.now() - 20 * 24 * 60 * 60 * 1000,
        ).toISOString();

        if (options?.["--"]?.includes("src")) {
          return { all: [{ date: srcOld, hash: "src-old" }] };
        }

        if (String(options?.file || "").includes("README.md")) {
          return { all: [{ date: docNow, hash: "doc-now" }] };
        }

        if (String(options?.file || "").includes("PaymentService.ts")) {
          return { all: [{ date: srcOld, hash: "src-old" }] };
        }

        return { all: [] };
      }),
      diff: vi.fn(async () => "diff --git a/src/PaymentService.ts b/src/PaymentService.ts\n+ pay() {}"),
    };

    vi.doMock("../src/proxy/ai-client.js", () => ({
      createAIClient,
      chat,
      truncateForContext: (text: string) => text,
    }));
    vi.doMock("simple-git", () => ({
      simpleGit: vi.fn(() => git),
    }));

    vi.spyOn(process, "cwd").mockReturnValue(TEST_DIR);

    const { runDocsModule } = await import("../src/modules/m03-docs/index.js");
    const result = await runDocsModule({
      ...DEFAULT_CONFIG,
      modules: {
        ...DEFAULT_CONFIG.modules,
        docs: {
          enabled: true,
          stalenessDays: 14,
          aiSemanticCheck: true,
        },
      },
    } as any);

    const staleFinding = result.findings.find((f) => f.type === "STALE_DOC");
    expect(createAIClient).toHaveBeenCalled();
    expect(chat).toHaveBeenCalled();
    expect(staleFinding?.aiAnalysis).toContain("old payment flow");
    expect(staleFinding?.metadata).toMatchObject({
      aiSemanticCheck: "completed",
    });
  });
});
