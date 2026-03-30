// Test suite for M-08 Build Performance module
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

const TEST_DIR = join(process.cwd(), ".test-m08-tmp");
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

describe("M-08: Build Performance", () => {
  it("P4-TC05: detects MISSING_INCREMENTAL_TS when tsc without --incremental", async () => {
    writeFileSync(
      join(TEST_DIR, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2020",
          module: "ESNext",
          outDir: "./dist",
        },
      }),
    );
    writeFileSync(
      join(TEST_DIR, "package.json"),
      JSON.stringify({
        name: "test-project",
        scripts: { build: "tsc" },
      }),
    );

    vi.spyOn(process, "cwd").mockReturnValue(TEST_DIR);

    const { runBuildPerfModule } =
      await import("../src/modules/m08-buildperf/index.js");
    const result = await runBuildPerfModule(DEFAULT_CONFIG as any);

    const findings = result.findings.filter(
      (f) => f.type === "MISSING_INCREMENTAL_TS",
    );
    expect(findings.length).toBe(1);
    expect(findings[0].severity).toBe("MEDIUM");
  });

  it("does NOT flag MISSING_INCREMENTAL_TS when tsconfig has incremental: true", async () => {
    writeFileSync(
      join(TEST_DIR, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2020",
          module: "ESNext",
          incremental: true,
        },
      }),
    );
    writeFileSync(
      join(TEST_DIR, "package.json"),
      JSON.stringify({
        name: "test-project",
        scripts: { build: "tsc" },
      }),
    );

    vi.spyOn(process, "cwd").mockReturnValue(TEST_DIR);

    const { runBuildPerfModule } =
      await import("../src/modules/m08-buildperf/index.js");
    const result = await runBuildPerfModule(DEFAULT_CONFIG as any);

    const findings = result.findings.filter(
      (f) => f.type === "MISSING_INCREMENTAL_TS",
    );
    expect(findings.length).toBe(0);
  });

  it("does NOT flag when build script has --incremental", async () => {
    writeFileSync(
      join(TEST_DIR, "package.json"),
      JSON.stringify({
        name: "test-project",
        scripts: { build: "tsc --incremental" },
      }),
    );

    vi.spyOn(process, "cwd").mockReturnValue(TEST_DIR);

    const { runBuildPerfModule } =
      await import("../src/modules/m08-buildperf/index.js");
    const result = await runBuildPerfModule(DEFAULT_CONFIG as any);

    const findings = result.findings.filter(
      (f) => f.type === "MISSING_INCREMENTAL_TS",
    );
    expect(findings.length).toBe(0);
  });

  it("P4-TC03: detects BUILD_BOTTLENECK when step >30% of build time", async () => {
    mkdirSync(join(TEST_DIR, ".github", "workflows", "logs"), {
      recursive: true,
    });
    writeFileSync(
      join(TEST_DIR, ".github/workflows/logs/ci.log"),
      `
Step 1/3 : Install dependencies - 2m15s
Step 2/3 : Run tests - 7m30s
Step 3/3 : Build - 1m30s
`,
    );

    vi.spyOn(process, "cwd").mockReturnValue(TEST_DIR);

    const { runBuildPerfModule } =
      await import("../src/modules/m08-buildperf/index.js");
    const result = await runBuildPerfModule(DEFAULT_CONFIG as any);

    const findings = result.findings.filter(
      (f) => f.type === "BUILD_BOTTLENECK",
    );
    expect(findings.length).toBeGreaterThanOrEqual(1);
    const bottleneck = findings.find(
      (f) => (f.metadata as any)?.step === "Run tests",
    );
    expect(bottleneck).toBeDefined();
  });

  it("P4-TC04: detects UNCACHED_INSTALL in CI log", async () => {
    mkdirSync(join(TEST_DIR, ".github", "workflows", "logs"), {
      recursive: true,
    });
    writeFileSync(
      join(TEST_DIR, ".github/workflows/logs/ci.log"),
      `
npm install
npm test
`,
    );

    vi.spyOn(process, "cwd").mockReturnValue(TEST_DIR);

    const { runBuildPerfModule } =
      await import("../src/modules/m08-buildperf/index.js");
    const result = await runBuildPerfModule(DEFAULT_CONFIG as any);

    const findings = result.findings.filter(
      (f) => f.type === "UNCACHED_INSTALL",
    );
    expect(findings.length).toBeGreaterThanOrEqual(1);
  });

  it("does NOT flag UNCACHED_INSTALL when cache restore present", async () => {
    mkdirSync(join(TEST_DIR, ".github", "workflows", "logs"), {
      recursive: true,
    });
    writeFileSync(
      join(TEST_DIR, ".github/workflows/logs/ci.log"),
      `
::restore-cache
npm install
npm test
`,
    );

    vi.spyOn(process, "cwd").mockReturnValue(TEST_DIR);

    const { runBuildPerfModule } =
      await import("../src/modules/m08-buildperf/index.js");
    const result = await runBuildPerfModule(DEFAULT_CONFIG as any);

    const findings = result.findings.filter(
      (f) => f.type === "UNCACHED_INSTALL",
    );
    expect(findings.length).toBe(0);
  });

  it("returns 100 when no findings and module enabled", async () => {
    writeFileSync(
      join(TEST_DIR, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { incremental: true, strict: true },
      }),
    );
    writeFileSync(
      join(TEST_DIR, "package.json"),
      JSON.stringify({
        name: "test-project",
        scripts: { build: "tsc --incremental" },
      }),
    );

    vi.spyOn(process, "cwd").mockReturnValue(TEST_DIR);

    const { runBuildPerfModule } =
      await import("../src/modules/m08-buildperf/index.js");
    const result = await runBuildPerfModule(DEFAULT_CONFIG as any);

    expect(result.score).toBe(100);
    expect(result.status).toBe("ok");
  });

  it("module disabled returns 100", async () => {
    const config = {
      ...DEFAULT_CONFIG,
      modules: {
        ...DEFAULT_CONFIG.modules,
        buildPerf: { enabled: false, bottleneckThresholdPct: 30 },
      },
    };

    vi.spyOn(process, "cwd").mockReturnValue(TEST_DIR);

    const { runBuildPerfModule } =
      await import("../src/modules/m08-buildperf/index.js");
    const result = await runBuildPerfModule(config as any);

    expect(result.score).toBe(100);
    expect(result.metadata).toHaveProperty("enabled", false);
  });

  it("includes durationMs", async () => {
    vi.spyOn(process, "cwd").mockReturnValue(TEST_DIR);

    const { runBuildPerfModule } =
      await import("../src/modules/m08-buildperf/index.js");
    const result = await runBuildPerfModule(DEFAULT_CONFIG as any);

    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});
