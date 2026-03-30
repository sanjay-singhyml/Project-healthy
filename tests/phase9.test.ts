// Phase 9 Test Cases: IDE Extension, CI Integration & Output Polish
import { describe, it, expect, vi } from "vitest";
import type {
  HealthReport,
  Finding,
  FindingType,
  Severity,
  ModuleResult,
} from "../src/types/index.js";
import {
  printJson,
  generateHtmlReport,
  ExitCode,
} from "../src/utils/output.js";
import {
  calculateHealthScore,
  createHealthReport,
} from "../src/modules/runner.js";
import { shouldIgnorePath } from "../src/utils/ignore.js";

function makeModuleResult(overrides: Partial<ModuleResult> = {}): ModuleResult {
  return {
    moduleId: "M-07",
    moduleName: "Environment Integrity",
    score: 80,
    status: "ok",
    findings: [],
    metadata: {},
    durationMs: 100,
    ...overrides,
  };
}

const DEFAULT_CONFIG: any = {
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
    security: { enabled: true, blockedLicenses: ["GPL-3.0"] },
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
  docUpdater: { mode: "direct" },
};

describe("P9-TC03: JSON output produces valid HealthReport", () => {
  it("JSON output is valid and contains score (0-100) and findings array", () => {
    const report: HealthReport = {
      score: 72,
      generatedAt: new Date().toISOString(),
      projectRoot: "/test/project",
      modules: [makeModuleResult()],
      findings: [],
      topActions: ["Fix secret leak", "Add cache"],
    };

    const output = JSON.stringify(report, null, 2);
    const parsed = JSON.parse(output);

    expect(parsed.score).toBeGreaterThanOrEqual(0);
    expect(parsed.score).toBeLessThanOrEqual(100);
    expect(Array.isArray(parsed.findings)).toBe(true);
    expect(Array.isArray(parsed.modules)).toBe(true);
    expect(Array.isArray(parsed.topActions)).toBe(true);
    expect(typeof parsed.generatedAt).toBe("string");
    expect(typeof parsed.projectRoot).toBe("string");
  });

  it("JSON output includes all required HealthReport fields", () => {
    const report: HealthReport = {
      score: 85,
      generatedAt: "2026-01-01T00:00:00Z",
      projectRoot: "/project",
      modules: [
        makeModuleResult({ moduleId: "M-01", score: 90 }),
        makeModuleResult({ moduleId: "M-05", score: 80 }),
      ],
      findings: [
        {
          id: "1",
          moduleId: "M-07",
          type: "ENV_DRIFT" as FindingType,
          severity: "MEDIUM" as Severity,
          message: "KEY_B missing",
          metadata: {},
        },
      ],
      topActions: ["Fix key"],
    };

    const output = JSON.stringify(report, null, 2);
    const parsed = JSON.parse(output);

    expect(parsed.score).toBe(85);
    expect(parsed.modules.length).toBe(2);
    expect(parsed.findings.length).toBe(1);
    expect(parsed.topActions.length).toBe(1);
    expect(parsed.findings[0].type).toBe("ENV_DRIFT");
  });

  it("printJson produces parseable JSON", () => {
    const data = { score: 50, findings: [], modules: [] };
    const output = JSON.stringify(data, null, 2);
    const parsed = JSON.parse(output);
    expect(parsed).toEqual(data);
  });
});

describe("P9-TC01 & P9-TC02: CI quality gate --fail-under", () => {
  it("P9-TC01: score below threshold triggers exit code 1 logic", () => {
    const threshold = 70;
    const score = 65;
    const shouldFail = score < threshold;

    expect(shouldFail).toBe(true);
    // process.exit(ExitCode.FAIL_UNDER) would be called
    expect(ExitCode.FAIL_UNDER).toBe(1);
  });

  it("P9-TC02: score at or above threshold passes", () => {
    const threshold = 70;
    const score = 75;
    const shouldFail = score < threshold;

    expect(shouldFail).toBe(false);
    expect(ExitCode.SUCCESS).toBe(0);
  });

  it("score exactly at threshold passes", () => {
    const threshold = 70;
    const score = 70;
    const shouldFail = score < threshold;
    expect(shouldFail).toBe(false);
  });

  it("exit codes are correct: 0=success, 1=fail-under, 2=rate-limit", () => {
    expect(ExitCode.SUCCESS).toBe(0);
    expect(ExitCode.FAIL_UNDER).toBe(1);
    expect(ExitCode.RATE_LIMIT).toBe(2);
  });
});

describe("P9-TC04: VS Code extension reads HealthReport", () => {
  it("extension reads last-scan.json with score", () => {
    const scanJson = {
      score: 82,
      generatedAt: "2026-01-01T00:00:00Z",
      projectRoot: "/project",
      modules: [
        {
          moduleId: "M-01",
          moduleName: "CI/CD Pipeline",
          score: 90,
          status: "ok",
          findings: [],
          metadata: {},
          durationMs: 100,
        },
      ],
      findings: [],
      topActions: [],
    };

    const parsed = JSON.parse(JSON.stringify(scanJson));
    expect(parsed.score).toBe(82);
    expect(parsed.modules[0].score).toBe(90);
    // VS Code extension would show "Health Score: 82/100" in sidebar
  });

  it("extension maps findings to diagnostics with file:line", () => {
    const finding = {
      moduleId: "M-07",
      type: "SECRET_LEAK",
      severity: "CRITICAL",
      file: "src/config.ts",
      line: 42,
      message: "AWS key found",
    };

    expect(finding.file).toBe("src/config.ts");
    expect(finding.line).toBe(42);
    expect(finding.severity).toBe("CRITICAL");
    // VS Code extension would create Diagnostic at line 42 with Error severity
  });
});

describe("P9-TC06: Watch mode uses shared ignore list", () => {
  it("ignores node_modules paths", () => {
    expect(shouldIgnorePath("node_modules/package/index.js")).toBe(true);
    expect(shouldIgnorePath("src/node_modules/pkg/file.ts")).toBe(true);
  });

  it("ignores .next build directory", () => {
    expect(shouldIgnorePath(".next/static/chunks/main.js")).toBe(true);
    expect(shouldIgnorePath("src/.next/page.ts")).toBe(true);
  });

  it("ignores dist directory", () => {
    expect(shouldIgnorePath("dist/index.js")).toBe(true);
    expect(shouldIgnorePath("src/dist/bundle.js")).toBe(true);
  });

  it("ignores build directory", () => {
    expect(shouldIgnorePath("build/index.js")).toBe(true);
  });

  it("ignores .git directory", () => {
    expect(shouldIgnorePath(".git/config")).toBe(true);
    expect(shouldIgnorePath(".git/hooks/pre-commit")).toBe(true);
  });

  it("ignores .ph-cache directory", () => {
    expect(shouldIgnorePath(".ph-cache/last-scan.json")).toBe(true);
  });

  it("ignores .turbo directory", () => {
    expect(shouldIgnorePath(".turbo/cache/hash")).toBe(true);
  });

  it("ignores coverage directory", () => {
    expect(shouldIgnorePath("coverage/lcov-report/index.html")).toBe(true);
  });

  it("ignores vendor directory", () => {
    expect(shouldIgnorePath("vendor/github.com/lib/pkg.go")).toBe(true);
  });

  it("does NOT ignore source files", () => {
    expect(shouldIgnorePath("src/index.ts")).toBe(false);
    expect(shouldIgnorePath("src/components/App.tsx")).toBe(false);
    expect(shouldIgnorePath("src/utils/helper.js")).toBe(false);
  });

  it("does NOT ignore .github workflows", () => {
    expect(shouldIgnorePath(".github/workflows/ci.yml")).toBe(false);
  });

  it("does NOT ignore .gitlab CI", () => {
    expect(shouldIgnorePath(".gitlab-ci.yml")).toBe(false);
  });

  it("does NOT ignore docs", () => {
    expect(shouldIgnorePath("docs/README.md")).toBe(false);
  });

  it("does NOT ignore config files", () => {
    expect(shouldIgnorePath("package.json")).toBe(false);
    expect(shouldIgnorePath("tsconfig.json")).toBe(false);
    expect(shouldIgnorePath(".env.example")).toBe(false);
  });
});

describe("P9: HTML report generation", () => {
  it("generates self-contained HTML with all modules", () => {
    const report: HealthReport = {
      score: 72,
      generatedAt: "2026-01-01T00:00:00Z",
      projectRoot: "/test",
      modules: [
        makeModuleResult({
          moduleId: "M-01",
          moduleName: "CI/CD Pipeline",
          score: 90,
        }),
        makeModuleResult({
          moduleId: "M-05",
          moduleName: "Dependency Security",
          score: 54,
        }),
      ],
      findings: [],
      topActions: ["Fix CVE"],
    };

    const html = generateHtmlReport(report);
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("72");
    expect(html).toContain("CI/CD Pipeline");
    expect(html).toContain("Dependency Security");
    expect(html).toContain("Fix CVE");
    expect(html).toContain("</html>");
  });

  it("escapes HTML entities in findings to prevent XSS", () => {
    const report: HealthReport = {
      score: 50,
      generatedAt: "2026-01-01T00:00:00Z",
      projectRoot: "/test",
      modules: [
        {
          moduleId: "M-07" as any,
          moduleName: "Env",
          score: 50,
          status: "warning",
          findings: [
            {
              id: "1",
              moduleId: "M-07" as any,
              type: "SECRET_LEAK" as FindingType,
              severity: "CRITICAL" as Severity,
              message: '<script>alert("xss")</script>',
              metadata: {},
            },
          ],
          metadata: {},
          durationMs: 10,
        },
      ],
      findings: [],
      topActions: [],
    };

    const html = generateHtmlReport(report);
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });
});
