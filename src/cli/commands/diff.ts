// ph diff — compare current branch against base, run relevant modules on changed files only
// Outputs impact score and findings delta

import { simpleGit } from "simple-git";
import { join, extname } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { v4 as uuidv4 } from "uuid";
import {
  Finding,
  ModuleResult,
  ModuleId,
  ProjectHealthConfig,
  HealthReport,
  Severity,
} from "../../types/index.js";
import {
  runQualityModule,
  runSecurityModule,
  runEnvModule,
  runFlakinessModule,
} from "../../modules/index.js";
import { createConfigManager } from "../../config/index.js";
import { createCacheManager } from "../../cache/index.js";
import { printError, printInfo, ExitCode } from "../../utils/output.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("ph:cli");

// ─── Types ──────────────────────────────────────────────────────────────────

export interface DiffResult {
  baseBranch: string;
  changedFiles: string[];
  modulesInvoked: ModuleId[];
  newFindings: Finding[];
  resolvedFindings: Finding[];
  scoreDelta: number;
  impactScore: number;
  baselineScore: number | null;
  summary: string;
}

// ─── File-to-module mapping ─────────────────────────────────────────────────

interface FileChangeMap {
  quality: boolean; // M-02
  security: boolean; // M-05
  env: boolean; // M-07
  flakiness: boolean; // M-04
}

function classifyChangedFiles(files: string[]): FileChangeMap {
  const map: FileChangeMap = {
    quality: false,
    security: false,
    env: false,
    flakiness: false,
  };

  for (const file of files) {
    const lower = file.toLowerCase();
    const ext = extname(lower);

    // Source code → M-02 Quality
    if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) {
      map.quality = true;
    }

    // Test files → M-04 Flakiness
    if (
      lower.includes(".test.") ||
      lower.includes(".spec.") ||
      lower.includes("__tests__") ||
      lower.startsWith("tests/") ||
      lower.startsWith("test/")
    ) {
      map.flakiness = true;
    }

    // Lock files → M-05 Security
    if (
      lower === "package-lock.json" ||
      lower === "yarn.lock" ||
      lower === "pnpm-lock.yaml" ||
      lower === "pipfile.lock" ||
      lower === "requirements.txt"
    ) {
      map.security = true;
    }

    // Env / Docker / CI → M-07 Environment
    if (
      lower.startsWith(".env") ||
      lower === "dockerfile" ||
      lower === "docker-compose.yml" ||
      lower === "docker-compose.yaml" ||
      ((ext === ".yml" || ext === ".yaml") &&
        (lower.includes(".github/") ||
          lower.includes(".gitlab") ||
          lower.includes(".circleci/")))
    ) {
      map.env = true;
    }

    // package.json dependency changes → M-05 Security
    if (lower === "package.json" || lower === "pyproject.toml") {
      map.security = true;
    }
  }

  return map;
}

function getModulesToRun(classification: FileChangeMap): ModuleId[] {
  const modules: ModuleId[] = [];
  if (classification.quality) modules.push("M-02");
  if (classification.flakiness) modules.push("M-04");
  if (classification.security) modules.push("M-05");
  if (classification.env) modules.push("M-07");
  return modules;
}

// ─── Filter findings to changed files only ──────────────────────────────────

function filterFindingsToChangedFiles(
  findings: Finding[],
  changedFiles: string[],
): Finding[] {
  if (changedFiles.length === 0) return [];

  const fileSet = new Set(changedFiles.map((f) => f.toLowerCase()));
  const fileBaseSet = new Set(
    changedFiles.map((f) => {
      const parts = f.replace(/\\/g, "/").split("/");
      return parts[parts.length - 1].toLowerCase();
    }),
  );

  return findings.filter((f) => {
    if (!f.file) return false;
    const normalized = f.file
      .toLowerCase()
      .replace(/\\/g, "/")
      .replace(/^\//, "");

    // Match exact path
    if (fileSet.has(normalized)) return true;

    // Match by basename (module reports might use relative paths)
    const basename = normalized.split("/").pop() || "";
    return fileBaseSet.has(basename);
  });
}

// ─── Compute impact score ───────────────────────────────────────────────────

function computeImpactScore(
  newFindings: Finding[],
  baselineReport: HealthReport | null,
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
    // No baseline — impact is proportional to new findings
    return newSeveritySum > 0 ? Math.min(1, newSeveritySum / 20) : 0;
  }

  const baselineSeveritySum = baselineReport.findings.reduce((sum, f) => {
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

  if (baselineSeveritySum === 0) return newSeveritySum > 0 ? 1 : 0;

  // impact = new findings severity / (baseline + new)
  return Math.min(1, newSeveritySum / (baselineSeveritySum + newSeveritySum));
}

// ─── Compute score delta ────────────────────────────────────────────────────

function computeScoreDelta(
  diffResults: ModuleResult[],
  baselineReport: HealthReport | null,
): number {
  if (diffResults.length === 0) return 0;

  const diffAvg = Math.round(
    diffResults.reduce((s, r) => s + r.score, 0) / diffResults.length,
  );

  if (!baselineReport) return diffAvg - 100;

  return diffAvg - baselineReport.score;
}

// ─── Find resolved findings ─────────────────────────────────────────────────

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

// ─── Build summary string ───────────────────────────────────────────────────

function buildSummary(result: DiffResult): string {
  const lines: string[] = [];

  lines.push(`Compared to ${result.baseBranch}:`);
  lines.push(`  Files changed: ${result.changedFiles.length}`);
  lines.push(
    `  Modules invoked: ${result.modulesInvoked.join(", ") || "none"}`,
  );

  if (result.newFindings.length > 0) {
    const critical = result.newFindings.filter(
      (f) => f.severity === "CRITICAL",
    ).length;
    const high = result.newFindings.filter((f) => f.severity === "HIGH").length;
    const medium = result.newFindings.filter(
      (f) => f.severity === "MEDIUM",
    ).length;
    lines.push(
      `  New findings: ${result.newFindings.length} (${critical} critical, ${high} high, ${medium} medium)`,
    );
  } else {
    lines.push(`  New findings: 0`);
  }

  if (result.resolvedFindings.length > 0) {
    lines.push(`  Resolved: ${result.resolvedFindings.length}`);
  }

  const deltaStr =
    result.scoreDelta > 0 ? `+${result.scoreDelta}` : String(result.scoreDelta);
  lines.push(`  Score delta: ${deltaStr}`);
  lines.push(`  Impact: ${(result.impactScore * 100).toFixed(0)}%`);

  if (result.impactScore > 0.5) {
    lines.push(`  ⚠ This change degrades project health significantly`);
  } else if (result.impactScore > 0.2) {
    lines.push(`  ⚡ Moderate health impact — review findings above`);
  } else {
    lines.push(`  ✓ Low impact`);
  }

  return lines.join("\n");
}

// ─── Main entry point ───────────────────────────────────────────────────────

export async function runDiffCommand(options: {
  base: string;
  format: string;
}): Promise<DiffResult> {
  const projectRoot = process.cwd();
  const git = simpleGit(projectRoot);
  const baseBranch = options.base || "main";

  // 1. Get changed files
  let changedFiles: string[] = [];
  try {
    const diffOutput = await git.diff(["--name-only", `${baseBranch}...HEAD`]);
    changedFiles = diffOutput
      .split("\n")
      .map((f) => f.trim().replace(/\\/g, "/"))
      .filter((f) => f.length > 0);
  } catch (err) {
    log("Error in runDiffCommand: %O", err);
    // Try with two dots if three dots fails
    try {
      const diffOutput = await git.diff(["--name-only", baseBranch, "HEAD"]);
      changedFiles = diffOutput
        .split("\n")
        .map((f) => f.trim().replace(/\\/g, "/"))
        .filter((f) => f.length > 0);
    } catch (err) {
      log("Error in runDiffCommand: %O", err);
      printError(
        `Could not diff against branch "${baseBranch}". Is it a valid branch?`,
      );
      throw new Error(`Branch "${baseBranch}" not found`);
    }
  }

  if (changedFiles.length === 0) {
    return {
      baseBranch,
      changedFiles: [],
      modulesInvoked: [],
      newFindings: [],
      resolvedFindings: [],
      scoreDelta: 0,
      impactScore: 0,
      baselineScore: null,
      summary: `No changes found relative to ${baseBranch}`,
    };
  }

  // 2. Classify files → determine which modules to run
  const classification = classifyChangedFiles(changedFiles);
  const modulesToRun = getModulesToRun(classification);

  // 3. Load config
  const configManager = createConfigManager(projectRoot);
  const config = await configManager.load();

  // 4. Run relevant modules in parallel
  const moduleRunners: Record<
    ModuleId,
    (config: ProjectHealthConfig) => Promise<ModuleResult>
  > = {
    "M-02": runQualityModule,
    "M-04": runFlakinessModule,
    "M-05": runSecurityModule,
    "M-07": runEnvModule,
    // These won't be called but need to satisfy the type
    "M-01": async () => ({
      moduleId: "M-01",
      moduleName: "",
      score: 100,
      status: "ok",
      findings: [],
      metadata: {},
      durationMs: 0,
    }),
    "M-03": async () => ({
      moduleId: "M-03",
      moduleName: "",
      score: 100,
      status: "ok",
      findings: [],
      metadata: {},
      durationMs: 0,
    }),
    "M-06": async () => ({
      moduleId: "M-06",
      moduleName: "",
      score: 100,
      status: "ok",
      findings: [],
      metadata: {},
      durationMs: 0,
    }),
    "M-08": async () => ({
      moduleId: "M-08",
      moduleName: "",
      score: 100,
      status: "ok",
      findings: [],
      metadata: {},
      durationMs: 0,
    }),
  };

  const promises = modulesToRun.map(async (moduleId): Promise<ModuleResult> => {
    try {
      return await moduleRunners[moduleId](config);
    } catch (error) {
      return {
        moduleId,
        moduleName: moduleId,
        score: 0,
        status: "error" as const,
        findings: [
          {
            id: uuidv4(),
            moduleId,
            type: "BUILD_BOTTLENECK" as const,
            severity: "CRITICAL" as Severity,
            message: error instanceof Error ? error.message : String(error),
            metadata: {},
          },
        ],
        metadata: { error: String(error) },
        durationMs: 0,
      };
    }
  });

  const allResults = await Promise.allSettled(promises);
  const diffResults: ModuleResult[] = allResults.map((r, i) =>
    r.status === "fulfilled"
      ? r.value
      : {
          moduleId: modulesToRun[i],
          moduleName: modulesToRun[i],
          score: 0,
          status: "error" as const,
          findings: [],
          metadata: {},
          durationMs: 0,
        },
  );

  // 5. Collect all findings from diff results
  const allDiffFindings: Finding[] = [];
  for (const result of diffResults) {
    allDiffFindings.push(...result.findings);
  }

  // 6. Filter to only findings in changed files
  const newFindings = filterFindingsToChangedFiles(
    allDiffFindings,
    changedFiles,
  );

  // 7. Load baseline from last-scan.json
  const cache = createCacheManager(projectRoot);
  let baselineReport: HealthReport | null = null;
  try {
    baselineReport = await cache.getLastScan();
  } catch (err) {
    log("Error in runDiffCommand: %O", err);
    // No baseline available
  }

  // 8. Find resolved findings
  const baselineFindings = baselineReport?.findings || [];
  const baselineInChangedFiles = filterFindingsToChangedFiles(
    baselineFindings,
    changedFiles,
  );
  const resolvedFindings = findResolvedFindings(
    baselineInChangedFiles,
    newFindings,
  );

  // 9. Compute metrics
  const impactScore = computeImpactScore(newFindings, baselineReport);
  const scoreDelta = computeScoreDelta(diffResults, baselineReport);

  const result: DiffResult = {
    baseBranch,
    changedFiles,
    modulesInvoked: modulesToRun,
    newFindings,
    resolvedFindings,
    scoreDelta,
    impactScore: Math.round(impactScore * 100) / 100,
    baselineScore: baselineReport?.score ?? null,
    summary: "",
  };

  result.summary = buildSummary(result);

  return result;
}
