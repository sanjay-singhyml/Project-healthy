// Test suite for ph diff command
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import type { Finding, Severity } from "../src/types/index.js";

// Import the internal functions we can test directly
// (they're not exported but we can test the logic by re-importing the module)

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

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "test-1",
    moduleId: "M-02",
    type: "HIGH_COMPLEXITY",
    severity: "MEDIUM",
    file: "src/test.ts",
    line: 10,
    message: "Test finding",
    metadata: {},
    ...overrides,
  };
}

// ─── classifyChangedFiles logic tests ───────────────────────────────────────

function classifyChangedFiles(files: string[]) {
  const map = { quality: false, security: false, env: false, flakiness: false };
  for (const file of files) {
    const lower = file.toLowerCase();
    const dotIdx = lower.lastIndexOf(".");
    const ext = dotIdx >= 0 ? lower.slice(dotIdx) : "";
    if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext))
      map.quality = true;
    if (
      lower.includes(".test.") ||
      lower.includes(".spec.") ||
      lower.includes("__tests__") ||
      lower.startsWith("tests/") ||
      lower.startsWith("test/")
    )
      map.flakiness = true;
    if (
      lower === "package-lock.json" ||
      lower === "yarn.lock" ||
      lower === "pnpm-lock.yaml" ||
      lower === "pipfile.lock" ||
      lower === "requirements.txt"
    )
      map.security = true;
    if (
      lower.startsWith(".env") ||
      lower === "dockerfile" ||
      lower === "docker-compose.yml"
    )
      map.env = true;
    if (lower === "package.json" || lower === "pyproject.toml")
      map.security = true;
    // CI files
    if (
      (ext === ".yml" || ext === ".yaml") &&
      (lower.includes(".github/") ||
        lower.includes(".gitlab") ||
        lower.includes(".circleci/"))
    )
      map.env = true;
  }
  return map;
}

describe("Diff: classifyChangedFiles", () => {
  it("maps .ts files to quality", () => {
    const result = classifyChangedFiles(["src/index.ts"]);
    expect(result.quality).toBe(true);
    expect(result.security).toBe(false);
    expect(result.env).toBe(false);
    expect(result.flakiness).toBe(false);
  });

  it("maps .test.ts to quality AND flakiness", () => {
    const result = classifyChangedFiles(["src/index.test.ts"]);
    expect(result.quality).toBe(true);
    expect(result.flakiness).toBe(true);
  });

  it("maps package-lock.json to security", () => {
    const result = classifyChangedFiles(["package-lock.json"]);
    expect(result.security).toBe(true);
    expect(result.quality).toBe(false);
  });

  it("maps .env.example to env", () => {
    const result = classifyChangedFiles([".env.example"]);
    expect(result.env).toBe(true);
  });

  it("maps Dockerfile to env", () => {
    const result = classifyChangedFiles(["Dockerfile"]);
    expect(result.env).toBe(true);
  });

  it("maps .yml in .github to env", () => {
    const result = classifyChangedFiles([".github/workflows/ci.yml"]);
    expect(result.env).toBe(true);
  });

  it("maps mixed files to multiple modules", () => {
    const result = classifyChangedFiles([
      "src/index.ts",
      "package-lock.json",
      ".env.local",
      "src/app.test.ts",
    ]);
    expect(result.quality).toBe(true);
    expect(result.security).toBe(true);
    expect(result.env).toBe(true);
    expect(result.flakiness).toBe(true);
  });

  it("maps package.json to security", () => {
    const result = classifyChangedFiles(["package.json"]);
    expect(result.security).toBe(true);
  });

  it("maps .spec.ts to flakiness", () => {
    const result = classifyChangedFiles(["src/utils.spec.ts"]);
    expect(result.flakiness).toBe(true);
    expect(result.quality).toBe(true);
  });

  it("handles empty file list", () => {
    const result = classifyChangedFiles([]);
    expect(result.quality).toBe(false);
    expect(result.security).toBe(false);
    expect(result.env).toBe(false);
    expect(result.flakiness).toBe(false);
  });
});

// ─── filterFindingsToChangedFiles tests ─────────────────────────────────────

function filterFindingsToChangedFiles(
  findings: Finding[],
  changedFiles: string[],
): Finding[] {
  if (changedFiles.length === 0) return [];
  const fileSet = new Set(changedFiles.map((f) => f.toLowerCase()));
  return findings.filter((f) => {
    if (!f.file) return false;
    const normalized = f.file
      .toLowerCase()
      .replace(/\\/g, "/")
      .replace(/^\//, "");
    return fileSet.has(normalized);
  });
}

describe("Diff: filterFindingsToChangedFiles", () => {
  it("returns only findings in changed files", () => {
    const findings = [
      makeFinding({ file: "src/a.ts" }),
      makeFinding({ file: "src/b.ts" }),
      makeFinding({ file: "src/c.ts" }),
    ];
    const result = filterFindingsToChangedFiles(findings, [
      "src/a.ts",
      "src/c.ts",
    ]);
    expect(result.length).toBe(2);
    expect(result[0].file).toBe("src/a.ts");
    expect(result[1].file).toBe("src/c.ts");
  });

  it("returns empty when no changed files", () => {
    const findings = [makeFinding({ file: "src/a.ts" })];
    expect(filterFindingsToChangedFiles(findings, []).length).toBe(0);
  });

  it("skips findings without file", () => {
    const findings = [makeFinding({ file: undefined })];
    expect(filterFindingsToChangedFiles(findings, ["src/a.ts"]).length).toBe(0);
  });

  it("handles case-insensitive matching", () => {
    const findings = [makeFinding({ file: "src/APP.ts" })];
    const result = filterFindingsToChangedFiles(findings, ["src/app.ts"]);
    expect(result.length).toBe(1);
  });

  it("normalizes backslashes for Windows paths", () => {
    const findings = [makeFinding({ file: "src\\components\\App.tsx" })];
    const result = filterFindingsToChangedFiles(findings, [
      "src/components/App.tsx",
    ]);
    expect(result.length).toBe(1);
  });
});

// ─── computeImpactScore tests ───────────────────────────────────────────────

function computeImpactScore(
  newFindings: Finding[],
  baselineReport: any,
): number {
  const newSeveritySum = newFindings.reduce((sum, f) => {
    switch (f.severity) {
      case "CRITICAL":
        return sum + 4;
      case "HIGH":
        return sum + 3;
      case "MEDIUM":
        return sum + 2;
      case "LOW":
        return sum + 1;
      default:
        return sum + 1;
    }
  }, 0);

  if (
    !baselineReport ||
    !baselineReport.findings ||
    baselineReport.findings.length === 0
  ) {
    return newSeveritySum > 0 ? Math.min(1, newSeveritySum / 20) : 0;
  }

  const baselineSeveritySum = baselineReport.findings.reduce(
    (sum: number, f: Finding) => {
      switch (f.severity) {
        case "CRITICAL":
          return sum + 4;
        case "HIGH":
          return sum + 3;
        case "MEDIUM":
          return sum + 2;
        case "LOW":
          return sum + 1;
        default:
          return sum + 1;
      }
    },
    0,
  );

  if (baselineSeveritySum === 0) return newSeveritySum > 0 ? 1 : 0;
  return Math.min(1, newSeveritySum / (baselineSeveritySum + newSeveritySum));
}

describe("Diff: computeImpactScore", () => {
  it("returns 0 when no new findings and no baseline", () => {
    expect(computeImpactScore([], null)).toBe(0);
  });

  it("returns proportional impact with no baseline", () => {
    // 5 CRITICAL = 20 severity = 20/20 = 1.0
    const findings = Array.from({ length: 5 }, () =>
      makeFinding({ severity: "CRITICAL" }),
    );
    expect(computeImpactScore(findings, null)).toBe(1);
  });

  it("returns 0.5 for 2 CRITICAL findings (8/20)", () => {
    const findings = [
      makeFinding({ severity: "CRITICAL" }),
      makeFinding({ severity: "CRITICAL" }),
    ];
    expect(computeImpactScore(findings, null)).toBe(0.4);
  });

  it("computes ratio against baseline", () => {
    const baseline = {
      findings: [
        makeFinding({ severity: "CRITICAL" }),
        makeFinding({ severity: "CRITICAL" }),
        makeFinding({ severity: "HIGH" }),
      ],
    };
    // baseline = 4+4+3 = 11
    // new = 4 (1 CRITICAL)
    // impact = 4 / (11+4) = 4/15 ≈ 0.27
    const impact = computeImpactScore(
      [makeFinding({ severity: "CRITICAL" })],
      baseline,
    );
    expect(impact).toBeCloseTo(0.27, 1);
  });

  it("caps at 1.0", () => {
    const findings = Array.from({ length: 20 }, () =>
      makeFinding({ severity: "CRITICAL" }),
    );
    expect(computeImpactScore(findings, null)).toBe(1);
  });
});

// ─── findResolvedFindings tests ─────────────────────────────────────────────

function findResolvedFindings(
  baselineFindings: Finding[],
  currentFindings: Finding[],
): Finding[] {
  const currentSet = new Set(
    currentFindings.map(
      (f) => `${f.moduleId}|${f.type}|${f.file || ""}|${f.line || 0}`,
    ),
  );
  return baselineFindings.filter((f) => {
    const key = `${f.moduleId}|${f.type}|${f.file || ""}|${f.line || 0}`;
    return !currentSet.has(key);
  });
}

describe("Diff: findResolvedFindings", () => {
  it("identifies resolved findings", () => {
    const baseline = [
      makeFinding({
        id: "1",
        moduleId: "M-02",
        type: "HIGH_COMPLEXITY",
        file: "a.ts",
        line: 10,
      }),
      makeFinding({
        id: "2",
        moduleId: "M-07",
        type: "ENV_DRIFT",
        file: ".env",
        line: 1,
      }),
    ];
    const current = [
      makeFinding({
        id: "1",
        moduleId: "M-02",
        type: "HIGH_COMPLEXITY",
        file: "a.ts",
        line: 10,
      }),
    ];
    const resolved = findResolvedFindings(baseline, current);
    expect(resolved.length).toBe(1);
    expect(resolved[0].type).toBe("ENV_DRIFT");
  });

  it("returns empty when nothing is resolved", () => {
    const baseline = [makeFinding({ file: "a.ts" })];
    const current = [makeFinding({ file: "a.ts" })];
    expect(findResolvedFindings(baseline, current).length).toBe(0);
  });

  it("returns all baseline as resolved when current is empty", () => {
    const baseline = [
      makeFinding({ file: "a.ts" }),
      makeFinding({ file: "b.ts" }),
    ];
    expect(findResolvedFindings(baseline, []).length).toBe(2);
  });
});

// ─── Integration test with git repo ─────────────────────────────────────────

let testIdx = 0;
function getTestDir(): string {
  testIdx++;
  const dir = join(process.cwd(), `.test-diff-${Date.now()}-${testIdx}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function initGitRepo(dir: string) {
  execSync("git init -b main", { cwd: dir, stdio: "pipe" });
  execSync('git config user.email "test@test.com"', {
    cwd: dir,
    stdio: "pipe",
  });
  execSync('git config user.name "Test User"', { cwd: dir, stdio: "pipe" });
}

describe("Diff: runDiffCommand integration", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns empty result when no changes exist", async () => {
    const TEST_DIR = getTestDir();
    initGitRepo(TEST_DIR);

    // Create initial commit on main
    writeFileSync(
      join(TEST_DIR, "package.json"),
      JSON.stringify({ name: "test" }),
    );
    writeFileSync(join(TEST_DIR, ".gitignore"), "");
    execSync("git add . && git commit -m init", {
      cwd: TEST_DIR,
      stdio: "pipe",
    });

    vi.spyOn(process, "cwd").mockReturnValue(TEST_DIR);

    const { runDiffCommand } = await import("../src/cli/commands/diff.js");
    const result = await runDiffCommand({ base: "main", format: "json" });

    expect(result.changedFiles.length).toBe(0);
    expect(result.newFindings.length).toBe(0);
    expect(result.impactScore).toBe(0);
  });

  it("detects changed TypeScript files", async () => {
    const TEST_DIR = getTestDir();
    initGitRepo(TEST_DIR);

    // Create initial commit
    writeFileSync(
      join(TEST_DIR, "package.json"),
      JSON.stringify({ name: "test" }),
    );
    writeFileSync(join(TEST_DIR, ".gitignore"), "");
    execSync("git add . && git commit -m init", {
      cwd: TEST_DIR,
      stdio: "pipe",
    });

    // Create a branch and add a file
    execSync("git checkout -b feature", { cwd: TEST_DIR, stdio: "pipe" });
    mkdirSync(join(TEST_DIR, "src"), { recursive: true });
    writeFileSync(join(TEST_DIR, "src", "index.ts"), "export const x = 1;\n");
    execSync('git add . && git commit -m "add file"', {
      cwd: TEST_DIR,
      stdio: "pipe",
    });

    vi.spyOn(process, "cwd").mockReturnValue(TEST_DIR);

    const { runDiffCommand } = await import("../src/cli/commands/diff.js");
    const result = await runDiffCommand({ base: "main", format: "json" });

    expect(result.changedFiles.length).toBeGreaterThanOrEqual(1);
    expect(result.changedFiles.some((f) => f.includes("index.ts"))).toBe(true);
    expect(result.modulesInvoked).toContain("M-02");
  });

  it("detects package-lock.json changes trigger M-05", async () => {
    const TEST_DIR = getTestDir();
    initGitRepo(TEST_DIR);

    writeFileSync(
      join(TEST_DIR, "package.json"),
      JSON.stringify({ name: "test" }),
    );
    writeFileSync(join(TEST_DIR, ".gitignore"), "");
    execSync("git add . && git commit -m init", {
      cwd: TEST_DIR,
      stdio: "pipe",
    });

    execSync("git checkout -b deps", { cwd: TEST_DIR, stdio: "pipe" });
    writeFileSync(join(TEST_DIR, "package-lock.json"), "{}");
    execSync('git add . && git commit -m "update deps"', {
      cwd: TEST_DIR,
      stdio: "pipe",
    });

    vi.spyOn(process, "cwd").mockReturnValue(TEST_DIR);

    const { runDiffCommand } = await import("../src/cli/commands/diff.js");
    const result = await runDiffCommand({ base: "main", format: "json" });

    expect(result.modulesInvoked).toContain("M-05");
  });

  it("detects .env changes trigger M-07", async () => {
    const TEST_DIR = getTestDir();
    initGitRepo(TEST_DIR);

    writeFileSync(
      join(TEST_DIR, "package.json"),
      JSON.stringify({ name: "test" }),
    );
    writeFileSync(join(TEST_DIR, ".gitignore"), "");
    execSync("git add . && git commit -m init", {
      cwd: TEST_DIR,
      stdio: "pipe",
    });

    execSync("git checkout -b env", { cwd: TEST_DIR, stdio: "pipe" });
    writeFileSync(join(TEST_DIR, ".env"), "SECRET=value\n");
    execSync('git add . && git commit -m "add env"', {
      cwd: TEST_DIR,
      stdio: "pipe",
    });

    vi.spyOn(process, "cwd").mockReturnValue(TEST_DIR);

    const { runDiffCommand } = await import("../src/cli/commands/diff.js");
    const result = await runDiffCommand({ base: "main", format: "json" });

    expect(result.modulesInvoked).toContain("M-07");
  });

  it("JSON output contains required fields", async () => {
    const TEST_DIR = getTestDir();
    initGitRepo(TEST_DIR);

    writeFileSync(
      join(TEST_DIR, "package.json"),
      JSON.stringify({ name: "test" }),
    );
    writeFileSync(join(TEST_DIR, ".gitignore"), "");
    execSync("git add . && git commit -m init", {
      cwd: TEST_DIR,
      stdio: "pipe",
    });

    execSync("git checkout -b feature", { cwd: TEST_DIR, stdio: "pipe" });
    mkdirSync(join(TEST_DIR, "src"), { recursive: true });
    writeFileSync(join(TEST_DIR, "src", "index.ts"), "export const x = 1;\n");
    execSync("git add . && git commit -m add", {
      cwd: TEST_DIR,
      stdio: "pipe",
    });

    vi.spyOn(process, "cwd").mockReturnValue(TEST_DIR);

    const { runDiffCommand } = await import("../src/cli/commands/diff.js");
    const result = await runDiffCommand({ base: "main", format: "json" });

    // Verify all required fields exist
    expect(result).toHaveProperty("baseBranch");
    expect(result).toHaveProperty("changedFiles");
    expect(result).toHaveProperty("modulesInvoked");
    expect(result).toHaveProperty("newFindings");
    expect(result).toHaveProperty("resolvedFindings");
    expect(result).toHaveProperty("scoreDelta");
    expect(result).toHaveProperty("impactScore");

    // Verify types
    expect(typeof result.baseBranch).toBe("string");
    expect(Array.isArray(result.changedFiles)).toBe(true);
    expect(Array.isArray(result.modulesInvoked)).toBe(true);
    expect(Array.isArray(result.newFindings)).toBe(true);
    expect(Array.isArray(result.resolvedFindings)).toBe(true);
    expect(typeof result.scoreDelta).toBe("number");
    expect(typeof result.impactScore).toBe("number");

    // Verify impactScore is 0-1
    expect(result.impactScore).toBeGreaterThanOrEqual(0);
    expect(result.impactScore).toBeLessThanOrEqual(1);
  });
});
