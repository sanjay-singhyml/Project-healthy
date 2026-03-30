// Test suite for M-06 PR Complexity module
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

const TEST_DIR = join(process.cwd(), ".test-m06-tmp");
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
    buildPerf: { enabled: true, bottleneckThresholdPct: 30 },
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
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });

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

describe("M-06: PR Complexity", () => {
  it("runs without GitHub token (no crash)", async () => {
    vi.spyOn(process, "cwd").mockReturnValue(TEST_DIR);
    delete process.env.GITHUB_TOKEN;

    const { runPrComplexityModule } =
      await import("../src/modules/m06-prcomplexity/index.js");
    const result = await runPrComplexityModule(DEFAULT_CONFIG as any);

    expect(result).toBeDefined();
    expect(result.moduleId).toBe("M-06");
  });

  it("module disabled returns 100", async () => {
    const config = {
      ...DEFAULT_CONFIG,
      modules: {
        ...DEFAULT_CONFIG.modules,
        prComplexity: {
          enabled: false,
          maxLinesChanged: 500,
          maxFilesChanged: 5,
          reviewTimeoutDays: 3,
        },
      },
    };

    vi.spyOn(process, "cwd").mockReturnValue(TEST_DIR);

    const { runPrComplexityModule } =
      await import("../src/modules/m06-prcomplexity/index.js");
    const result = await runPrComplexityModule(config as any);

    expect(result.score).toBe(100);
    expect(result.metadata).toHaveProperty("enabled", false);
  });

  it("includes durationMs", async () => {
    vi.spyOn(process, "cwd").mockReturnValue(TEST_DIR);
    delete process.env.GITHUB_TOKEN;

    const { runPrComplexityModule } =
      await import("../src/modules/m06-prcomplexity/index.js");
    const result = await runPrComplexityModule(DEFAULT_CONFIG as any);

    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("handles missing remote gracefully", async () => {
    // No remote configured
    vi.spyOn(process, "cwd").mockReturnValue(TEST_DIR);

    const { runPrComplexityModule } =
      await import("../src/modules/m06-prcomplexity/index.js");
    const result = await runPrComplexityModule(DEFAULT_CONFIG as any);

    expect(result).toBeDefined();
    expect(result.moduleId).toBe("M-06");
  });
});
