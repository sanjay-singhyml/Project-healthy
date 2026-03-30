// Test suite for M-01 CI/CD Pipeline module
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const TEST_DIR = join(process.cwd(), ".test-m01-tmp");
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
});

afterEach(() => {
  vi.restoreAllMocks();
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("M-01: CI/CD Pipeline", () => {
  it("P3-TC05: detects MISSING_CACHE when workflow has npm install but no cache", async () => {
    mkdirSync(join(TEST_DIR, ".github", "workflows"), { recursive: true });
    writeFileSync(
      join(TEST_DIR, ".github/workflows/ci.yml"),
      `
name: CI
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Install
        run: npm install
      - name: Test
        run: npm test
`,
    );

    vi.spyOn(process, "cwd").mockReturnValue(TEST_DIR);

    const { runCicdModule } = await import("../src/modules/m01-cicd/index.js");
    const result = await runCicdModule(DEFAULT_CONFIG as any);

    const findings = result.findings.filter((f) => f.type === "MISSING_CACHE");
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings[0].severity).toBe("MEDIUM");
  });

  it("does NOT flag MISSING_CACHE when workflow has cache action", async () => {
    mkdirSync(join(TEST_DIR, ".github", "workflows"), { recursive: true });
    writeFileSync(
      join(TEST_DIR, ".github/workflows/ci.yml"),
      `
name: CI
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/cache@v4
        with:
          path: node_modules
          key: deps-\${{ hashFiles('package-lock.json') }}
      - name: Install
        run: npm install
      - name: Test
        run: npm test
`,
    );

    vi.spyOn(process, "cwd").mockReturnValue(TEST_DIR);

    const { runCicdModule } = await import("../src/modules/m01-cicd/index.js");
    const result = await runCicdModule(DEFAULT_CONFIG as any);

    const findings = result.findings.filter((f) => f.type === "MISSING_CACHE");
    expect(findings.length).toBe(0);
  });

  it("returns ~100 when no workflow files exist", async () => {
    vi.spyOn(process, "cwd").mockReturnValue(TEST_DIR);

    const { runCicdModule } = await import("../src/modules/m01-cicd/index.js");
    const result = await runCicdModule(DEFAULT_CONFIG as any);

    // New implementation adds a LOW severity finding for missing CI config
    expect(result.score).toBeGreaterThanOrEqual(95);
  });

  it("module disabled returns 100", async () => {
    const config = {
      ...DEFAULT_CONFIG,
      modules: {
        ...DEFAULT_CONFIG.modules,
        cicd: {
          enabled: false,
          slowJobThresholdMinutes: 5,
          failureRateThreshold: 0.2,
        },
      },
    };

    vi.spyOn(process, "cwd").mockReturnValue(TEST_DIR);

    const { runCicdModule } = await import("../src/modules/m01-cicd/index.js");
    const result = await runCicdModule(config as any);

    expect(result.score).toBe(100);
    expect(result.metadata).toHaveProperty("enabled", false);
  });

  it("includes durationMs", async () => {
    vi.spyOn(process, "cwd").mockReturnValue(TEST_DIR);

    const { runCicdModule } = await import("../src/modules/m01-cicd/index.js");
    const result = await runCicdModule(DEFAULT_CONFIG as any);

    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("handles multiple workflow files", async () => {
    mkdirSync(join(TEST_DIR, ".github", "workflows"), { recursive: true });
    writeFileSync(
      join(TEST_DIR, ".github/workflows/ci.yml"),
      `
name: CI
jobs:
  test:
    steps:
      - run: npm install
`,
    );
    writeFileSync(
      join(TEST_DIR, ".github/workflows/deploy.yml"),
      `
name: Deploy
jobs:
  deploy:
    steps:
      - uses: actions/cache@v4
      - run: npm install
`,
    );

    vi.spyOn(process, "cwd").mockReturnValue(TEST_DIR);

    const { runCicdModule } = await import("../src/modules/m01-cicd/index.js");
    const result = await runCicdModule(DEFAULT_CONFIG as any);

    expect(result.moduleId).toBe("M-01");
  });
});
