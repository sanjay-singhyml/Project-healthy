// Test suite for M-05 Dependency Security module
// Tests use direct node_modules traversal — no shell-out stubs needed
import { describe, it, expect, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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

let testIdx = 0;
function getTestDir(): string {
  testIdx++;
  const dir = join(process.cwd(), `.test-m05-${Date.now()}-${testIdx}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("M-05: Dependency Security", () => {
  it("detects LICENSE_RISK for GPL packages via direct node_modules read", async () => {
    const TEST_DIR = getTestDir();
    writeFileSync(
      join(TEST_DIR, "package.json"),
      JSON.stringify({ name: "test" }),
    );

    // Create actual node_modules with GPL package
    mkdirSync(join(TEST_DIR, "node_modules", "gplpackage"), {
      recursive: true,
    });
    writeFileSync(
      join(TEST_DIR, "node_modules/gplpackage/package.json"),
      JSON.stringify({
        name: "gplpackage",
        version: "1.0.0",
        license: "GPL-3.0",
      }),
    );

    vi.spyOn(process, "cwd").mockReturnValue(TEST_DIR);

    const { runSecurityModule } =
      await import("../src/modules/m05-security/index.js");
    const result = await runSecurityModule(DEFAULT_CONFIG as any);

    const licenseFindings = result.findings.filter(
      (f) => f.type === "LICENSE_RISK",
    );
    expect(licenseFindings.length).toBeGreaterThanOrEqual(1);
    expect(licenseFindings[0].severity).toBe("HIGH");
  });

  it("does NOT flag MIT license packages", async () => {
    const TEST_DIR = getTestDir();
    writeFileSync(
      join(TEST_DIR, "package.json"),
      JSON.stringify({ name: "test" }),
    );

    mkdirSync(join(TEST_DIR, "node_modules", "mitpackage"), {
      recursive: true,
    });
    writeFileSync(
      join(TEST_DIR, "node_modules/mitpackage/package.json"),
      JSON.stringify({ name: "mitpackage", version: "1.0.0", license: "MIT" }),
    );

    vi.spyOn(process, "cwd").mockReturnValue(TEST_DIR);

    const { runSecurityModule } =
      await import("../src/modules/m05-security/index.js");
    const result = await runSecurityModule(DEFAULT_CONFIG as any);

    const licenseFindings = result.findings.filter(
      (f) => f.type === "LICENSE_RISK",
    );
    expect(licenseFindings.length).toBe(0);
  });

  it("detects scoped packages with blocked license", async () => {
    const TEST_DIR = getTestDir();
    writeFileSync(
      join(TEST_DIR, "package.json"),
      JSON.stringify({ name: "test" }),
    );

    mkdirSync(join(TEST_DIR, "node_modules", "@scope", "agpl-pkg"), {
      recursive: true,
    });
    writeFileSync(
      join(TEST_DIR, "node_modules/@scope/agpl-pkg/package.json"),
      JSON.stringify({
        name: "@scope/agpl-pkg",
        version: "2.0.0",
        license: "AGPL-3.0",
      }),
    );

    vi.spyOn(process, "cwd").mockReturnValue(TEST_DIR);

    const { runSecurityModule } =
      await import("../src/modules/m05-security/index.js");
    const result = await runSecurityModule(DEFAULT_CONFIG as any);

    const licenseFindings = result.findings.filter(
      (f) => f.type === "LICENSE_RISK",
    );
    expect(licenseFindings.length).toBeGreaterThanOrEqual(1);
  });

  it("module disabled returns 100", async () => {
    const TEST_DIR = getTestDir();
    const config = {
      ...DEFAULT_CONFIG,
      modules: {
        ...DEFAULT_CONFIG.modules,
        security: { enabled: false, blockedLicenses: [] },
      },
    };

    vi.spyOn(process, "cwd").mockReturnValue(TEST_DIR);

    const { runSecurityModule } =
      await import("../src/modules/m05-security/index.js");
    const result = await runSecurityModule(config as any);

    expect(result.score).toBe(100);
    expect(result.metadata).toHaveProperty("enabled", false);
  });

  it("handles missing package.json gracefully", async () => {
    const TEST_DIR = getTestDir();
    vi.spyOn(process, "cwd").mockReturnValue(TEST_DIR);

    const { runSecurityModule } =
      await import("../src/modules/m05-security/index.js");
    const result = await runSecurityModule(DEFAULT_CONFIG as any);

    expect(result).toBeDefined();
    expect(result.moduleId).toBe("M-05");
  });

  it("handles missing node_modules gracefully", async () => {
    const TEST_DIR = getTestDir();
    writeFileSync(
      join(TEST_DIR, "package.json"),
      JSON.stringify({ name: "test" }),
    );
    vi.spyOn(process, "cwd").mockReturnValue(TEST_DIR);

    const { runSecurityModule } =
      await import("../src/modules/m05-security/index.js");
    const result = await runSecurityModule(DEFAULT_CONFIG as any);

    expect(result).toBeDefined();
    expect(result.moduleId).toBe("M-05");
    expect(result.score).toBe(100);
  });

  it("counts packages scanned in metadata", async () => {
    const TEST_DIR = getTestDir();
    writeFileSync(
      join(TEST_DIR, "package.json"),
      JSON.stringify({ name: "test" }),
    );

    mkdirSync(join(TEST_DIR, "node_modules", "pkg-a"), { recursive: true });
    writeFileSync(
      join(TEST_DIR, "node_modules/pkg-a/package.json"),
      JSON.stringify({ license: "MIT" }),
    );
    mkdirSync(join(TEST_DIR, "node_modules", "pkg-b"), { recursive: true });
    writeFileSync(
      join(TEST_DIR, "node_modules/pkg-b/package.json"),
      JSON.stringify({ license: "Apache-2.0" }),
    );

    vi.spyOn(process, "cwd").mockReturnValue(TEST_DIR);

    const { runSecurityModule } =
      await import("../src/modules/m05-security/index.js");
    const result = await runSecurityModule(DEFAULT_CONFIG as any);

    expect(result.metadata).toHaveProperty("packagesScanned");
    expect((result.metadata as any).packagesScanned).toBeGreaterThanOrEqual(2);
  });

  it("includes durationMs", async () => {
    const TEST_DIR = getTestDir();
    vi.spyOn(process, "cwd").mockReturnValue(TEST_DIR);

    const { runSecurityModule } =
      await import("../src/modules/m05-security/index.js");
    const result = await runSecurityModule(DEFAULT_CONFIG as any);

    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});
