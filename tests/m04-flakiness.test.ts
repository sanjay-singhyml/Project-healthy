import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

const TEST_DIR = join(process.cwd(), ".test-m04-tmp");

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

function writeHistory(runs: Array<Record<string, unknown>>): void {
  const cacheDir = join(TEST_DIR, ".ph-cache", "flakiness");
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(
    join(cacheDir, "history.json"),
    JSON.stringify(
      {
        projectRoot: TEST_DIR,
        runs,
        lastScanTimestamp: "2026-01-01T00:00:00.000Z",
      },
      null,
      2,
    ),
  );
}

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("M-04: Test Flakiness", () => {
  it("normalizes pass rate thresholds expressed as ratios or percentages", async () => {
    const mod = await import("../src/modules/m04-flakiness/index.js");

    expect(mod.normalizePassRateThreshold(95)).toBe(0.95);
    expect(mod.normalizePassRateThreshold(0.95)).toBe(0.95);
  });

  it("flags flaky tests consistently for 0.95 and 95 threshold configs", async () => {
    writeHistory([
      {
        timestamp: "2026-01-01T00:00:00.000Z",
        commitHash: "a1",
        test: "login",
        classname: "auth.LoginSuite",
        passed: true,
      },
      {
        timestamp: "2026-01-02T00:00:00.000Z",
        commitHash: "a2",
        test: "login",
        classname: "auth.LoginSuite",
        passed: true,
      },
      {
        timestamp: "2026-01-03T00:00:00.000Z",
        commitHash: "a3",
        test: "login",
        classname: "auth.LoginSuite",
        passed: false,
      },
    ]);

    vi.spyOn(process, "cwd").mockReturnValue(TEST_DIR);

    const { runFlakinessModule } =
      await import("../src/modules/m04-flakiness/index.js");

    const ratioResult = await runFlakinessModule(DEFAULT_CONFIG as any);
    const pctResult = await runFlakinessModule({
      ...DEFAULT_CONFIG,
      modules: {
        ...DEFAULT_CONFIG.modules,
        flakiness: {
          ...DEFAULT_CONFIG.modules.flakiness,
          passRateThreshold: 95,
        },
      },
    } as any);

    expect(ratioResult.findings).toHaveLength(1);
    expect(pctResult.findings).toHaveLength(1);
    expect(ratioResult.findings[0].metadata.thresholdPct).toBe(95);
    expect(pctResult.findings[0].metadata.thresholdPct).toBe(95);
  });

  it("reports grouped summaries and unique run counts in metadata", async () => {
    writeHistory([
      {
        timestamp: "2026-01-01T00:00:00.000Z",
        commitHash: "a1",
        test: "login",
        classname: "auth.LoginSuite",
        passed: true,
      },
      {
        timestamp: "2026-01-02T00:00:00.000Z",
        commitHash: "a2",
        test: "login",
        classname: "auth.LoginSuite",
        passed: false,
      },
      {
        timestamp: "2026-01-03T00:00:00.000Z",
        commitHash: "a3",
        test: "login",
        classname: "auth.LoginSuite",
        passed: true,
      },
      {
        timestamp: "2026-01-04T00:00:00.000Z",
        commitHash: "a3",
        test: "charge",
        classname: "payment.ChargeSuite",
        passed: true,
      },
      {
        timestamp: "2026-01-05T00:00:00.000Z",
        commitHash: "a4",
        test: "charge",
        classname: "payment.ChargeSuite",
        passed: false,
      },
      {
        timestamp: "2026-01-06T00:00:00.000Z",
        commitHash: "a5",
        test: "charge",
        classname: "payment.ChargeSuite",
        passed: true,
      },
    ]);

    vi.spyOn(process, "cwd").mockReturnValue(TEST_DIR);

    const { runFlakinessModule } =
      await import("../src/modules/m04-flakiness/index.js");
    const result = await runFlakinessModule(DEFAULT_CONFIG as any);

    expect(result.metadata.historyRuns).toBe(6);
    expect(result.metadata.historyEntries).toBe(6);
    expect(result.metadata.uniqueTests).toBe(2);
    expect(result.metadata.flakyTests).toBe(2);
    expect(result.metadata.groups).toEqual({
      auth: [
        expect.objectContaining({
          name: "login",
          passRatePct: 67,
          failedRuns: 1,
        }),
      ],
      payment: [
        expect.objectContaining({
          name: "charge",
          totalRuns: 3,
        }),
      ],
    });
  });

  it("suppresses flaky findings when the test file changed recently", async () => {
    mkdirSync(join(TEST_DIR, "tests", "auth"), { recursive: true });
    writeFileSync(join(TEST_DIR, "tests", "auth", "LoginSuite.ts"), "export {};");
    execSync("git init", { cwd: TEST_DIR, stdio: "pipe" });
    execSync('git config user.email "test@test.com"', {
      cwd: TEST_DIR,
      stdio: "pipe",
    });
    execSync('git config user.name "Test User"', {
      cwd: TEST_DIR,
      stdio: "pipe",
    });
    execSync("git add .", { cwd: TEST_DIR, stdio: "pipe" });
    execSync('git commit -m "add test file"', { cwd: TEST_DIR, stdio: "pipe" });
    const commitHash = execSync("git rev-parse HEAD", {
      cwd: TEST_DIR,
      stdio: "pipe",
    })
      .toString()
      .trim();

    writeHistory([
      {
        timestamp: "2026-01-01T00:00:00.000Z",
        commitHash,
        test: "login",
        classname: "auth.LoginSuite",
        passed: true,
      },
      {
        timestamp: "2026-01-02T00:00:00.000Z",
        commitHash,
        test: "login",
        classname: "auth.LoginSuite",
        passed: false,
      },
      {
        timestamp: "2026-01-03T00:00:00.000Z",
        commitHash,
        test: "login",
        classname: "auth.LoginSuite",
        passed: true,
      },
    ]);

    vi.spyOn(process, "cwd").mockReturnValue(TEST_DIR);

    const { runFlakinessModule } =
      await import("../src/modules/m04-flakiness/index.js");
    const result = await runFlakinessModule(DEFAULT_CONFIG as any);

    expect(result.findings).toHaveLength(0);
    expect(result.metadata.suppressedDueToRecentChanges).toBe(1);
    expect(result.metadata.suppressedTests).toEqual([
      expect.objectContaining({
        name: "login",
        reason: "recent_source_change",
        file: expect.stringMatching(/tests[\\/]auth[\\/]LoginSuite\.ts/),
      }),
    ]);
  });
});
