// Test suite for M-02 Code Quality module
import { describe, it, expect, beforeEach, vi } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_CONFIG = {
  proxy: { url: "http://localhost:3000", timeout: 30000 },
  modules: {
    cicd: {
      enabled: true,
      slowJobThresholdMinutes: 5,
      failureRateThreshold: 0.2,
    },
    quality: { enabled: true, complexityThreshold: 10, duplicateLineMin: 51 },
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

let testIdx = 0;
function getTestDir(): string {
  testIdx++;
  return join(process.cwd(), `.test-m02-${Date.now()}-${testIdx}`);
}

describe("M-02: Code Quality", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("P3-TC01: detects HIGH_COMPLEXITY with cyclomatic complexity >10", async () => {
    const TEST_DIR = getTestDir();
    mkdirSync(join(TEST_DIR, "src"), { recursive: true });

    const complexFn = `
function processPayment(user, amount) {
  if (amount <= 0) throw new Error("bad");
  if (!user) return null;
  if (user.balance < amount) return null;
  if (user.isPremium) {
    if (amount > 1000) {
      if (!user.verified) return null;
      if (user.tier === 'gold') {
        if (amount > 5000) {
          if (!user.whitelisted) return null;
          if (!user.securityCode) return null;
        }
      }
    }
  }
  return { status: 'ok' };
}`;
    writeFileSync(join(TEST_DIR, "src", "payment.ts"), complexFn);

    vi.spyOn(process, "cwd").mockReturnValue(TEST_DIR);

    const { runQualityModule } =
      await import("../src/modules/m02-quality/index.js");
    const result = await runQualityModule(DEFAULT_CONFIG as any);

    const findings = result.findings.filter(
      (f) => f.type === "HIGH_COMPLEXITY",
    );
    expect(findings.length).toBeGreaterThanOrEqual(1);
    if (findings.length > 0) {
      expect(findings[0].metadata).toHaveProperty("complexity");
    }
  });

  it("does NOT flag simple functions", async () => {
    const TEST_DIR = getTestDir();
    mkdirSync(join(TEST_DIR, "src"), { recursive: true });

    const simpleFn = `function add(a: number, b: number): number { return a + b; }\n`;
    writeFileSync(join(TEST_DIR, "src", "math.ts"), simpleFn);

    vi.spyOn(process, "cwd").mockReturnValue(TEST_DIR);

    const { runQualityModule } =
      await import("../src/modules/m02-quality/index.js");
    const result = await runQualityModule(DEFAULT_CONFIG as any);

    const findings = result.findings.filter(
      (f) => f.type === "HIGH_COMPLEXITY",
    );
    expect(findings.length).toBe(0);
  });

  it("module disabled returns 100", async () => {
    const TEST_DIR = getTestDir();
    mkdirSync(join(TEST_DIR, "src"), { recursive: true });
    const config = {
      ...DEFAULT_CONFIG,
      modules: {
        ...DEFAULT_CONFIG.modules,
        quality: {
          enabled: false,
          complexityThreshold: 10,
          duplicateLineMin: 51,
        },
      },
    };

    vi.spyOn(process, "cwd").mockReturnValue(TEST_DIR);

    const { runQualityModule } =
      await import("../src/modules/m02-quality/index.js");
    const result = await runQualityModule(config as any);

    expect(result.score).toBe(100);
    expect(result.metadata).toHaveProperty("enabled", false);
  });

  it("handles empty src directory", async () => {
    const TEST_DIR = getTestDir();
    mkdirSync(join(TEST_DIR, "src"), { recursive: true });

    vi.spyOn(process, "cwd").mockReturnValue(TEST_DIR);

    const { runQualityModule } =
      await import("../src/modules/m02-quality/index.js");
    const result = await runQualityModule(DEFAULT_CONFIG as any);

    expect(result).toBeDefined();
    expect(result.moduleId).toBe("M-02");
  });

  it("skips bogus lint fallback when no ESLint config is present", async () => {
    const TEST_DIR = getTestDir();
    mkdirSync(join(TEST_DIR, "src"), { recursive: true });
    writeFileSync(join(TEST_DIR, "src", "plain.ts"), "const value = 1;\n");

    vi.spyOn(process, "cwd").mockReturnValue(TEST_DIR);

    const { runQualityModule } =
      await import("../src/modules/m02-quality/index.js");
    const result = await runQualityModule(DEFAULT_CONFIG as any);

    const lintFindings = result.findings.filter((f) => f.type === "LINT_ERROR");
    expect(lintFindings).toHaveLength(0);
    expect((result.metadata as any).lintMode).toBe("skipped-no-config");
  });

  it("includes durationMs", async () => {
    const TEST_DIR = getTestDir();
    mkdirSync(join(TEST_DIR, "src"), { recursive: true });

    vi.spyOn(process, "cwd").mockReturnValue(TEST_DIR);

    const { runQualityModule } =
      await import("../src/modules/m02-quality/index.js");
    const result = await runQualityModule(DEFAULT_CONFIG as any);

    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("does not miss exported declarations due to modifier parsing", async () => {
    const TEST_DIR = getTestDir();
    mkdirSync(join(TEST_DIR, "src"), { recursive: true });

    writeFileSync(
      join(TEST_DIR, "src", "lib.ts"),
      `export function usedFunction() { return 1; }
export const usedValue = 2;
export class UsedClass {}
`,
    );
    writeFileSync(
      join(TEST_DIR, "src", "consumer.ts"),
      `import { usedFunction, usedValue, UsedClass } from "./lib";
usedFunction();
console.log(usedValue, UsedClass);
`,
    );

    vi.spyOn(process, "cwd").mockReturnValue(TEST_DIR);

    const { runQualityModule } =
      await import("../src/modules/m02-quality/index.js");
    const result = await runQualityModule(DEFAULT_CONFIG as any);

    const deadExports = result.findings.filter((f) => f.type === "DEAD_EXPORT");
    expect(deadExports).toHaveLength(0);
  });

  it("does not flag exports used through barrels and star imports", async () => {
    const TEST_DIR = getTestDir();
    mkdirSync(join(TEST_DIR, "src"), { recursive: true });

    writeFileSync(
      join(TEST_DIR, "src", "foo.ts"),
      `export function sharedFn() { return "ok"; }
export const sharedValue = 42;
`,
    );
    writeFileSync(
      join(TEST_DIR, "src", "barrel.ts"),
      `export { sharedFn, sharedValue } from "./foo";
`,
    );
    writeFileSync(
      join(TEST_DIR, "src", "consumer.ts"),
      `import * as api from "./barrel";
api.sharedFn();
console.log(api.sharedValue);
`,
    );

    vi.spyOn(process, "cwd").mockReturnValue(TEST_DIR);

    const { runQualityModule } =
      await import("../src/modules/m02-quality/index.js");
    const result = await runQualityModule(DEFAULT_CONFIG as any);

    const deadExports = result.findings.filter((f) => f.type === "DEAD_EXPORT");
    expect(deadExports).toHaveLength(0);
  });

  it("only reports duplicate code when the duplicate block exceeds 50 lines", async () => {
    const TEST_DIR = getTestDir();
    mkdirSync(join(TEST_DIR, "src"), { recursive: true });

    const duplicatedBlock = Array.from({ length: 51 }, (_, index) =>
      `const value${index} = ${index};`,
    ).join("\n");

    writeFileSync(
      join(TEST_DIR, "src", "a.ts"),
      `${duplicatedBlock}\nexport const a = true;\n`,
    );
    writeFileSync(
      join(TEST_DIR, "src", "b.ts"),
      `${duplicatedBlock}\nexport const b = true;\n`,
    );

    vi.spyOn(process, "cwd").mockReturnValue(TEST_DIR);

    const { runQualityModule } =
      await import("../src/modules/m02-quality/index.js");
    const result = await runQualityModule(DEFAULT_CONFIG as any);

    const duplicateFindings = result.findings.filter(
      (f) => f.type === "DUPLICATE_CODE",
    );
    expect(duplicateFindings.length).toBeGreaterThan(0);
  });

  it("only flags large files above 1000 lines", async () => {
    const TEST_DIR = getTestDir();
    mkdirSync(join(TEST_DIR, "src"), { recursive: true });

    const thousandLines = Array.from({ length: 1000 }, (_, index) =>
      `export const value${index} = ${index};`,
    ).join("\n");
    const thousandOneLines = Array.from({ length: 1001 }, (_, index) =>
      `export const item${index} = ${index};`,
    ).join("\n");

    writeFileSync(join(TEST_DIR, "src", "ok.ts"), thousandLines);
    writeFileSync(join(TEST_DIR, "src", "large.ts"), thousandOneLines);

    vi.spyOn(process, "cwd").mockReturnValue(TEST_DIR);

    const { runQualityModule } =
      await import("../src/modules/m02-quality/index.js");
    const result = await runQualityModule(DEFAULT_CONFIG as any);

    const largeFileFindings = result.findings.filter(
      (f) => f.type === "LARGE_FILE",
    );

    expect(largeFileFindings).toHaveLength(1);
    expect(largeFileFindings[0]?.file).toBe("src/large.ts");
    expect(largeFileFindings[0]?.metadata).toMatchObject({ lines: 1001 });
  });
});
