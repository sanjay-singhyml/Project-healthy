// M-08: Build Performance Module
// Detects build system, analyzes bundle size, checks build freshness,
// analyzes dependencies, validates TypeScript strict mode,
// and parses CI logs for bottlenecks

import {
  ModuleResult,
  ModuleId,
  ProjectHealthConfig,
  Finding,
  Severity,
} from "../../types/index.js";
import { v4 as uuidv4 } from "uuid";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("ph:buildperf");

export const MODULE_ID: ModuleId = "M-08";
export const MODULE_NAME = "Build Performance";

// Build system types
type BuildSystem = "nodejs" | "make" | "cmake" | "gradle" | "unknown";

// Parse CI log to extract step timings
interface StepTiming {
  name: string;
  duration: number; // in seconds
  percentage: number;
}

// Detect build system based on project files
function detectBuildSystem(projectRoot: string): BuildSystem {
  // Check for package.json with build script
  const packageJsonPath = join(projectRoot, "package.json");
  if (existsSync(packageJsonPath)) {
    try {
      const content = readFileSync(packageJsonPath, "utf-8");
      const pkg = JSON.parse(content);
      if (pkg.scripts?.build) {
        return "nodejs";
      }
    } catch (err) {
      log("Error in detectBuildSystem: %O", err);
      // Ignore parse errors
    }
  }

  // Check for Makefile
  if (existsSync(join(projectRoot, "Makefile"))) {
    return "make";
  }

  // Check for CMakeLists.txt
  if (existsSync(join(projectRoot, "CMakeLists.txt"))) {
    return "cmake";
  }

  // Check for build.gradle
  if (existsSync(join(projectRoot, "build.gradle"))) {
    return "gradle";
  }

  return "unknown";
}

// Parse CI log to extract step timings
function parseCiLog(logContent: string): StepTiming[] {
  const steps: StepTiming[] = [];

  // Common CI log patterns
  const timingPatterns = [
    // "Step X/Y : command - 1m30s"
    /Step\s+\d+\/\d+\s+:\s+(.+?)\s+-\s+(\d+m)?(\d+s)?/gi,
    // "Run command  1:30"
    /Run\s+(.+?)\s{2,}(\d+m)?(\d+s)?/gi,
    // "command completed in 1m30s"
    /(.+?)\s+completed\s+in\s+(\d+m)?(\d+s)?/gi,
  ];

  for (const pattern of timingPatterns) {
    const matches = [...logContent.matchAll(pattern)];

    for (const match of matches) {
      const name = match[1]?.trim() || "Unknown";
      const minutes = parseInt(match[2] || "0", 10);
      const seconds = parseInt(match[3] || "0", 10);
      const duration = minutes * 60 + seconds;

      if (duration > 0) {
        steps.push({
          name,
          duration,
          percentage: 0, // Will calculate later
        });
      }
    }
  }

  // Calculate percentages
  const totalDuration = steps.reduce((sum, s) => sum + s.duration, 0);
  for (const step of steps) {
    step.percentage =
      totalDuration > 0 ? (step.duration / totalDuration) * 100 : 0;
  }

  return steps;
}

// Find CI logs
function findCiLogs(projectRoot: string): string[] {
  const logs: string[] = [];

  // Common CI log locations
  const logDirs = [
    join(projectRoot, ".github", "workflows", "logs"),
    join(projectRoot, "logs"),
    join(projectRoot, ".circleci"),
    join(projectRoot, ".gitlab-ci"),
  ];

  for (const dir of logDirs) {
    if (existsSync(dir)) {
      try {
        const entries = readdirSync(dir);
        for (const entry of entries) {
          const entryPath = join(dir, entry);
          const stat = statSync(entryPath);
          if (stat.isFile() && /\.(log|txt)$/i.test(entry)) {
            logs.push(entryPath);
          }
        }
      } catch (err) {
        log("Error in findCiLogs: %O", err);
        // Ignore unreadable directories
      }
    }
  }

  return logs;
}

// Check for tsc incremental flag
function checkTsIncremental(projectRoot: string): Finding | null {
  // Check tsconfig.json
  const tsconfigPath = join(projectRoot, "tsconfig.json");

  if (existsSync(tsconfigPath)) {
    try {
      const content = readFileSync(tsconfigPath, "utf-8");
      const config = JSON.parse(content);

      if (config.compilerOptions?.incremental === true) {
        return null; // Good - incremental is enabled
      }
    } catch (err) {
      log("Error in checkTsIncremental: %O", err);
      // Ignore parse errors
    }
  }

  // Check package.json scripts
  const packageJsonPath = join(projectRoot, "package.json");

  if (existsSync(packageJsonPath)) {
    try {
      const content = readFileSync(packageJsonPath, "utf-8");
      const pkg = JSON.parse(content);

      const buildScript = pkg.scripts?.build || pkg.scripts?.["build:ts"];

      if (buildScript && buildScript.includes("tsc")) {
        if (!buildScript.includes("--incremental")) {
          return {
            id: uuidv4(),
            moduleId: MODULE_ID,
            type: "MISSING_INCREMENTAL_TS",
            severity: "MEDIUM" as Severity,
            message: "TypeScript build does not use --incremental flag",
            fix: "Add --incremental to tsc command for faster builds",
            metadata: {},
          };
        }
      }
    } catch (err) {
      log("Error in checkTsIncremental: %O", err);
      // Ignore parse errors
    }
  }

  // No build script found - this might be fine for non-TS projects
  return null;
}

// Check for uncached npm install
function checkUncachedInstall(logContent: string): Finding | null {
  // Look for npm install without cache restore
  const hasNpmInstall = /npm install|npm ci/i.test(logContent);
  const hasCacheRestore = /cache.*restore|::restore-cache/i.test(logContent);

  if (hasNpmInstall && !hasCacheRestore) {
    return {
      id: uuidv4(),
      moduleId: MODULE_ID,
      type: "UNCACHED_INSTALL",
      severity: "MEDIUM" as Severity,
      message: "npm install step without cache restore detected",
      fix: "Add cache restore step before npm install",
      metadata: { step: "npm install" },
    };
  }

  return null;
}

// Get build output directory (dist or build)
function getBuildOutputDir(projectRoot: string): string | null {
  const distPath = join(projectRoot, "dist");
  const buildPath = join(projectRoot, "build");

  if (existsSync(distPath)) {
    return distPath;
  }
  if (existsSync(buildPath)) {
    return buildPath;
  }
  return null;
}

// Recursively get all files in directory
function getAllFiles(dir: string): string[] {
  const files: string[] = [];

  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);

      if (stat.isDirectory()) {
        files.push(...getAllFiles(fullPath));
      } else {
        files.push(fullPath);
      }
    }
  } catch (err) {
    log("Error in getAllFiles: %O", err);
    // Ignore errors
  }

  return files;
}

// Format bytes to human readable
function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

// Analyze bundle size
function analyzeBundleSize(projectRoot: string): Finding[] {
  const findings: Finding[] = [];
  const buildDir = getBuildOutputDir(projectRoot);

  if (!buildDir) {
    return findings;
  }

  const files = getAllFiles(buildDir);

  // Filter out .map files
  const nonMapFiles = files.filter((f) => !f.endsWith(".map"));

  if (nonMapFiles.length === 0) {
    return findings;
  }

  // Calculate total size
  let totalSize = 0;
  let largestFile = { path: "", size: 0 };

  for (const file of nonMapFiles) {
    try {
      const stat = statSync(file);
      totalSize += stat.size;

      if (stat.size > largestFile.size) {
        largestFile = { path: file, size: stat.size };
      }
    } catch (err) {
      log("Error in analyzeBundleSize: %O", err);
      // Ignore errors
    }
  }

  const totalSizeMB = totalSize / (1024 * 1024);
  const largestSizeMB = largestFile.size / (1024 * 1024);

  // Check for large bundle (> 5MB)
  if (totalSizeMB > 5) {
    findings.push({
      id: uuidv4(),
      moduleId: MODULE_ID,
      type: "LARGE_BUNDLE",
      severity: "HIGH" as Severity,
      message: `Bundle size ${formatBytes(totalSize)} exceeds 5MB threshold`,
      fix: "Enable tree shaking, dynamic imports, and check for accidentally bundled node_modules",
      metadata: { totalSize, totalSizeMB: Math.round(totalSizeMB * 100) / 100 },
    });
  }

  // Check for large chunk (> 1MB)
  if (largestSizeMB > 1) {
    const relativePath = largestFile.path
      .replace(projectRoot, "")
      .replace(/\\/g, "/");
    findings.push({
      id: uuidv4(),
      moduleId: MODULE_ID,
      type: "LARGE_CHUNK",
      severity: "MEDIUM" as Severity,
      message: `Chunk ${relativePath} is ${formatBytes(largestFile.size)} — consider code splitting`,
      metadata: {
        file: relativePath,
        size: largestFile.size,
        sizeMB: Math.round(largestSizeMB * 100) / 100,
      },
    });
  }

  return findings;
}

// Check build output freshness
function checkBuildFreshness(projectRoot: string): Finding[] {
  const findings: Finding[] = [];
  const buildDir = getBuildOutputDir(projectRoot);

  if (!buildDir) {
    return findings;
  }

  const srcPath = join(projectRoot, "src");

  if (!existsSync(srcPath)) {
    return findings;
  }

  try {
    // Get last modified time of build output
    const buildFiles = getAllFiles(buildDir);
    if (buildFiles.length === 0) {
      return findings;
    }

    let buildMtime = 0;
    for (const file of buildFiles) {
      try {
        const stat = statSync(file);
        if (stat.mtimeMs > buildMtime) {
          buildMtime = stat.mtimeMs;
        }
      } catch (err) {
        log("Error in checkBuildFreshness: %O", err);
        // Ignore errors
      }
    }

    // Get last modified time of src
    const srcFiles = getAllFiles(srcPath);
    let srcMtime = 0;
    for (const file of srcFiles) {
      try {
        const stat = statSync(file);
        if (stat.mtimeMs > srcMtime) {
          srcMtime = stat.mtimeMs;
        }
      } catch (err) {
        log("Error in checkBuildFreshness: %O", err);
        // Ignore errors
      }
    }

    // If build is older than src by more than 1 day
    const oneDayMs = 24 * 60 * 60 * 1000;
    const ageDiffMs = srcMtime - buildMtime;

    if (ageDiffMs > oneDayMs) {
      const days = Math.floor(ageDiffMs / oneDayMs);
      findings.push({
        id: uuidv4(),
        moduleId: MODULE_ID,
        type: "STALE_BUILD",
        severity: "LOW" as Severity,
        message: `Build output is ${days} days older than source — rebuild needed`,
        metadata: { days, ageDiffMs },
      });
    }
  } catch (err) {
    log("Error checking build freshness: %O", err);
  }

  return findings;
}

// Analyze dependencies
function analyzeDependencies(projectRoot: string): Finding[] {
  const findings: Finding[] = [];
  const packageJsonPath = join(projectRoot, "package.json");

  if (!existsSync(packageJsonPath)) {
    return findings;
  }

  try {
    const content = readFileSync(packageJsonPath, "utf-8");
    const pkg = JSON.parse(content);

    const dependencies = Object.keys(pkg.dependencies || {});
    const devDependencies = Object.keys(pkg.devDependencies || {});

    const totalDeps = dependencies.length + devDependencies.length;

    // Check for heavy dependencies (> 200)
    if (totalDeps > 200) {
      findings.push({
        id: uuidv4(),
        moduleId: MODULE_ID,
        type: "HEAVY_DEPENDENCIES",
        severity: "MEDIUM" as Severity,
        message: `${totalDeps} total dependencies. Consider auditing unused packages.`,
        fix: "Run `npx depcheck` to find unused dependencies",
        metadata: {
          totalDeps,
          dependencies: dependencies.length,
          devDependencies: devDependencies.length,
        },
      });
    }

    // Check dev dependency ratio
    if (
      dependencies.length > 0 &&
      devDependencies.length > dependencies.length * 3
    ) {
      findings.push({
        id: uuidv4(),
        moduleId: MODULE_ID,
        type: "DEVDEP_RATIO",
        severity: "LOW" as Severity,
        message:
          "Dev dependencies outnumber prod dependencies 3:1. Consider if all are needed.",
        metadata: {
          dependencies: dependencies.length,
          devDependencies: devDependencies.length,
          ratio:
            Math.round((devDependencies.length / dependencies.length) * 10) /
            10,
        },
      });
    }
  } catch (err) {
    log("Error analyzing dependencies: %O", err);
  }

  return findings;
}

// Check TypeScript strict mode
function checkTsStrictMode(projectRoot: string): Finding[] {
  const findings: Finding[] = [];
  const tsconfigPath = join(projectRoot, "tsconfig.json");

  if (!existsSync(tsconfigPath)) {
    return findings;
  }

  try {
    const content = readFileSync(tsconfigPath, "utf-8");
    // Remove comments from JSON
    const cleanContent = content
      .replace(/\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    const config = JSON.parse(cleanContent);

    // Check if strict is false or not set
    if (config.compilerOptions?.strict !== true) {
      findings.push({
        id: uuidv4(),
        moduleId: MODULE_ID,
        type: "TS_NOT_STRICT",
        severity: "MEDIUM" as Severity,
        message:
          "TypeScript strict mode is disabled. Enable for better type safety.",
        fix: "Set compilerOptions.strict: true in tsconfig.json",
        metadata: {
          strict: config.compilerOptions?.strict,
        },
      });
    }
  } catch (err) {
    log("Error checking TypeScript strict mode: %O", err);
  }

  return findings;
}

// Calculate module score
function calculateModuleScore(findings: Finding[]): number {
  if (findings.length === 0) return 100;

  const highCount = findings.filter((f) => f.severity === "HIGH").length;
  const mediumCount = findings.filter((f) => f.severity === "MEDIUM").length;
  const lowCount = findings.filter((f) => f.severity === "LOW").length;

  // Score formula: 100 - (HIGH*20 + MEDIUM*10 + LOW*5), min 0
  const deduction = highCount * 20 + mediumCount * 10 + lowCount * 5;
  return Math.max(0, 100 - deduction);
}

export async function runBuildPerfModule(
  config: ProjectHealthConfig,
): Promise<ModuleResult> {
  const startTime = Date.now();
  const findings: Finding[] = [];

  if (!config.modules.buildPerf.enabled) {
    return {
      moduleId: MODULE_ID,
      moduleName: MODULE_NAME,
      score: 100,
      status: "ok",
      findings: [],
      metadata: { enabled: false },
      durationMs: Date.now() - startTime,
    };
  }

  const projectRoot = process.cwd();
  const { bottleneckThresholdPct } = config.modules.buildPerf;

  try {
    // 1. Check for TypeScript incremental compilation (legacy check)
    const incrementalFinding = checkTsIncremental(projectRoot);
    if (incrementalFinding) {
      findings.push(incrementalFinding);
    }

    // 2. Try to find and parse local CI logs (legacy check)
    const logFiles = findCiLogs(projectRoot);

    for (const logFile of logFiles) {
      try {
        const logContent = readFileSync(logFile, "utf-8");
        const timings = parseCiLog(logContent);

        for (const timing of timings) {
          if (timing.percentage > bottleneckThresholdPct) {
            findings.push({
              id: uuidv4(),
              moduleId: MODULE_ID,
              type: "BUILD_BOTTLENECK",
              severity: "HIGH" as Severity,
              message: `Build step "${timing.name}" consumes ${Math.round(timing.percentage)}% of build time`,
              fix: "Optimize or parallelize this build step",
              metadata: {
                step: timing.name,
                pct: Math.round(timing.percentage),
                avgMinutes: Math.round((timing.duration / 60) * 10) / 10,
                file: logFile,
              },
            });
          }
        }

        const uncachedInstall = checkUncachedInstall(logContent);
        if (uncachedInstall) {
          uncachedInstall.metadata = {
            ...uncachedInstall.metadata,
            workflow: logFile,
          };
          findings.push(uncachedInstall);
        }
      } catch (err) {
        log("Error in runBuildPerfModule: %O", err);
        // Ignore unreadable logs
      }
    }

    // 3. Detect build system
    const buildSystem = detectBuildSystem(projectRoot);

    // 4. Bundle size analysis (for Node.js/frontend projects)
    if (buildSystem === "nodejs") {
      const bundleFindings = analyzeBundleSize(projectRoot);
      findings.push(...bundleFindings);
    }

    // 5. Build output freshness
    const freshnessFindings = checkBuildFreshness(projectRoot);
    findings.push(...freshnessFindings);

    // 6. Dependency count analysis
    const depFindings = analyzeDependencies(projectRoot);
    findings.push(...depFindings);

    // 7. TypeScript strict mode check
    const tsFindings = checkTsStrictMode(projectRoot);
    findings.push(...tsFindings);

    // 8. Check for common build scripts that might indicate issues
    const packageJsonPath = join(projectRoot, "package.json");
    if (existsSync(packageJsonPath)) {
      try {
        const content = readFileSync(packageJsonPath, "utf-8");
        const pkg = JSON.parse(content);

        // Check if there's a build script at all
        if (!pkg.scripts?.build) {
          findings.push({
            id: uuidv4(),
            moduleId: MODULE_ID,
            type: "BUILD_BOTTLENECK",
            severity: "LOW" as Severity,
            message: "No build script found in package.json",
            metadata: {},
          });
        }
      } catch (err) {
        log("Error in runBuildPerfModule: %O", err);
        // Ignore errors
      }
    }

    const score = calculateModuleScore(findings);

    return {
      moduleId: MODULE_ID,
      moduleName: MODULE_NAME,
      score,
      status: score >= 80 ? "ok" : score >= 60 ? "warning" : "error",
      findings,
      metadata: {
        buildSystem,
        incrementalTsEnabled: incrementalFinding === null,
        bottlenecks: findings.filter((f) => f.type === "BUILD_BOTTLENECK")
          .length,
        cacheMisses: findings.filter((f) => f.type === "UNCACHED_INSTALL")
          .length,
        largeBundles: findings.filter((f) => f.type === "LARGE_BUNDLE").length,
        largeChunks: findings.filter((f) => f.type === "LARGE_CHUNK").length,
        staleBuilds: findings.filter((f) => f.type === "STALE_BUILD").length,
        heavyDeps: findings.filter((f) => f.type === "HEAVY_DEPENDENCIES")
          .length,
        devDepRatioIssues: findings.filter((f) => f.type === "DEVDEP_RATIO")
          .length,
        tsNotStrict: findings.filter((f) => f.type === "TS_NOT_STRICT").length,
      },
      durationMs: Date.now() - startTime,
    };
  } catch (error) {
    return {
      moduleId: MODULE_ID,
      moduleName: MODULE_NAME,
      score: 0,
      status: "error",
      findings: [
        {
          id: uuidv4(),
          moduleId: MODULE_ID,
          type: "BUILD_BOTTLENECK",
          severity: "CRITICAL" as Severity,
          message:
            error instanceof Error
              ? error.message
              : "Build Performance scan failed",
          metadata: { error: String(error) },
        },
      ],
      metadata: { error: String(error) },
      durationMs: Date.now() - startTime,
    };
  }
}

export default runBuildPerfModule;
