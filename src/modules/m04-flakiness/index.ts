// M-04: Test Flakiness Module
// Real Flakiness Detection via Git History Correlation
// Stores test results in .ph-cache/flakiness/ and computes true pass rates over time
// Detects test ordering dependencies - same test passes/fails with no source change
// Enhanced with: Jest JSON, pytest support, duration tracking, test categorization

import {
  ModuleResult,
  ModuleId,
  ProjectHealthConfig,
  Finding,
  Severity,
} from "../../types/index.js";
import { v4 as uuidv4 } from "uuid";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  mkdirSync,
} from "node:fs";
import { join, relative } from "node:path";
import { simpleGit } from "simple-git";
import { XMLParser } from "fast-xml-parser";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("ph:flakiness");

export const MODULE_ID: ModuleId = "M-04";
export const MODULE_NAME = "Test Flakiness";

const FLAKINESS_CACHE_DIR = ".ph-cache/flakiness";
const HISTORY_FILE = "history.json";

interface JUnitTestCase {
  "@_name"?: string;
  "@_classname"?: string;
  failure?: { "@_message"?: string };
  error?: { "@_message"?: string };
  skipped?: unknown;
  "@_time"?: string;
}

interface JUnitTestSuite {
  "@_name"?: string;
  "@_tests"?: string;
  "@_failures"?: string;
  "@_errors"?: string;
  testcase?: JUnitTestCase | JUnitTestCase[];
}

interface JUnitReport {
  testsuites?: { testsuite?: JUnitTestSuite | JUnitTestSuite[] };
  testsuite?: JUnitTestSuite;
}

interface TestResult {
  name: string;
  classname: string;
  passed: boolean;
  duration?: number;
  file?: string;
  status: "passed" | "failed" | "skipped" | "pending";
}

interface TestRunEntry {
  timestamp: string;
  commitHash: string;
  test: string;
  classname: string;
  passed: boolean;
  duration?: number;
  status: "passed" | "failed" | "skipped" | "pending";
}

interface FlakinessHistory {
  projectRoot: string;
  runs: TestRunEntry[];
  lastScanTimestamp: string;
}

interface TestHistory {
  name: string;
  classname: string;
  totalRuns: number;
  passedRuns: number;
  passRate: number;
  commits: string[];
  uniqueCommits: number;
  isFlaky: boolean;
  flakyPattern: "ordering" | "random" | "none";
  failedRuns: number;
  threshold: number;
  avgDuration?: number;
  maxDuration?: number;
  category?: "unit" | "integration" | "e2e" | "unknown";
}

interface TestGroup {
  [directory: string]: TestHistory[];
}

interface TestSuppression {
  name: string;
  classname: string;
  reason: "recent_source_change";
  file?: string;
  lastModified?: string;
}

const MIN_RUNS_FOR_PASS_RATE_ANALYSIS = 3;
const SLOW_TEST_THRESHOLD_MS = 5000; // 5 seconds

function ensureCacheDir(projectRoot: string): string {
  const cacheDir = join(projectRoot, FLAKINESS_CACHE_DIR);
  if (!existsSync(cacheDir)) {
    mkdirSync(cacheDir, { recursive: true });
  }
  return cacheDir;
}

function loadHistory(projectRoot: string): FlakinessHistory {
  const cacheDir = ensureCacheDir(projectRoot);
  const historyPath = join(cacheDir, HISTORY_FILE);

  if (existsSync(historyPath)) {
    try {
      const content = readFileSync(historyPath, "utf-8");
      return JSON.parse(content);
    } catch (err) {
      log("Error in loadHistory: %O", err);
    }
  }

  return {
    projectRoot,
    runs: [],
    lastScanTimestamp: "",
  };
}

function saveHistory(projectRoot: string, history: FlakinessHistory): void {
  const cacheDir = ensureCacheDir(projectRoot);
  const historyPath = join(cacheDir, HISTORY_FILE);

  history.lastScanTimestamp = new Date().toISOString();

  writeFileSync(historyPath, JSON.stringify(history, null, 2), "utf-8");
}

export function normalizePassRateThreshold(threshold: number): number {
  if (!Number.isFinite(threshold) || threshold <= 0) {
    return 0.95;
  }

  if (threshold > 1) {
    return Math.min(1, threshold / 100);
  }

  return threshold;
}

// ─── JUnit XML Parser ───────────────────────────────────────────────────────

function parseJUnitXml(xmlContent: string): TestResult[] {
  const results: TestResult[] = [];

  try {
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
    });

    const report = parser.parse(xmlContent) as JUnitReport;

    const testSuites =
      report["testsuites"]?.["testsuite"] || report["testsuite"];
    const suites = Array.isArray(testSuites)
      ? testSuites
      : [testSuites].filter(Boolean);

    for (const suite of suites) {
      if (!suite) continue;

      const testCases = suite["testcase"];
      if (!testCases) continue;

      const cases = Array.isArray(testCases) ? testCases : [testCases];

      for (const testCase of cases) {
        if (!testCase) continue;

        const passed =
          !testCase.failure && !testCase.error && !testCase.skipped;
        const duration = testCase["@_time"]
          ? parseFloat(testCase["@_time"])
          : undefined;

        results.push({
          name: testCase["@_name"] || "unknown",
          classname: testCase["@_classname"] || "unknown",
          passed,
          duration,
          status: passed ? "passed" : testCase.skipped ? "skipped" : "failed",
        });
      }
    }
  } catch (err) {
    log("Error in parseJUnitXml: %O", err);
  }

  return results;
}

// ─── Jest JSON Parser ───────────────────────────────────────────────────────

function parseJestJson(jsonContent: string): TestResult[] {
  const results: TestResult[] = [];

  try {
    const data = JSON.parse(jsonContent);

    // Jest JSON reporter format
    const suites = data.testResults || [];

    for (const suite of suites) {
      const filePath = suite.name || "";
      const assertions = suite.assertionResults || [];

      for (const assertion of assertions) {
        const name = assertion.name || "unknown";
        const status = assertion.status || "unknown";
        const duration = assertion.duration;

        results.push({
          name,
          classname: filePath,
          passed: status === "passed",
          duration,
          status: status as TestResult["status"],
          file: filePath,
        });
      }
    }
  } catch (err) {
    log("Error in parseJestJson: %O", err);
  }

  return results;
}

// ─── Pytest JSON Parser ──────────────────────────────────────────────────────

function parsePytestJson(jsonContent: string): TestResult[] {
  const results: TestResult[] = [];

  try {
    const data = JSON.parse(jsonContent);

    // Pytest JSON report format
    const tests = data.tests || [];

    for (const test of tests) {
      const name = test.name || test.nodeid || "unknown";
      const classname = test.classname || test.module || "unknown";
      const outcome = test.outcome || "unknown";
      const duration = test.duration;

      results.push({
        name,
        classname,
        passed: outcome === "passed",
        duration,
        status:
          outcome === "passed"
            ? "passed"
            : outcome === "skipped"
              ? "skipped"
              : "failed",
        file: test.file,
      });
    }
  } catch (err) {
    log("Error in parsePytestJson: %O", err);
  }

  return results;
}

// ─── Pytest XML Parser ───────────────────────────────────────────────────────

function parsePytestXml(xmlContent: string): TestResult[] {
  // Pytest uses JUnit XML format, so reuse the JUnit parser
  return parseJUnitXml(xmlContent);
}

// ─── Find Test Result Files ───────────────────────────────────────────────

function findTestResultFiles(
  projectRoot: string,
): { type: string; path: string }[] {
  const files: { type: string; path: string }[] = [];

  const searchDirs = [
    { dir: "test-results", type: "junit" },
    { dir: "target/surefire-reports", type: "junit" },
    { dir: "build/test-results", type: "junit" },
    { dir: ".pytest_cache", type: "pytest-json" },
    { dir: "coverage/junit", type: "junit" },
    { dir: "__pycache__", type: "pytest-json" },
    { dir: ".jest", type: "jest-json" },
    { dir: "jest-results", type: "jest-json" },
    { dir: "test-results/jest", type: "jest-json" },
  ];

  for (const { dir, type } of searchDirs) {
    const dirPath = join(projectRoot, dir);
    if (existsSync(dirPath)) {
      try {
        const entries = readdirSync(dirPath);
        for (const entry of entries) {
          if (entry.endsWith(".xml")) {
            files.push({ type: "junit", path: join(dirPath, entry) });
          } else if (entry.endsWith(".json")) {
            // Check if it's a Jest or pytest JSON file
            if (entry.includes("jest") || entry === "test-results.json") {
              files.push({ type: "jest-json", path: join(dirPath, entry) });
            } else if (entry.includes("pytest") || entry === "junit.json") {
              files.push({ type: "pytest-json", path: join(dirPath, entry) });
            } else {
              // Try to detect by content
              try {
                const content = readFileSync(
                  join(dirPath, entry),
                  "utf-8",
                ).slice(0, 100);
                if (content.includes("testResults")) {
                  files.push({ type: "jest-json", path: join(dirPath, entry) });
                } else if (content.includes("tests")) {
                  files.push({
                    type: "pytest-json",
                    path: join(dirPath, entry),
                  });
                }
              } catch (e) {
                // Skip files we can't read
              }
            }
          }
        }
      } catch (err) {
        log("Error in findTestResultFiles: %O", err);
      }
    }
  }

  return files;
}

// ─── Test Categorization ───────────────────────────────────────────────────

function categorizeTest(
  classname: string,
  name: string,
): "unit" | "integration" | "e2e" | "unknown" {
  const fullName = `${classname} ${name}`.toLowerCase();

  // E2E patterns
  if (
    fullName.includes("e2e") ||
    fullName.includes("endtoend") ||
    fullName.includes("end-to-end") ||
    (fullName.includes("integration.") && fullName.includes("browser")) ||
    fullName.includes("selenium") ||
    fullName.includes("playwright") ||
    fullName.includes("cypress")
  ) {
    return "e2e";
  }

  // Integration patterns
  if (
    fullName.includes("integration") ||
    (fullName.includes("api") && fullName.includes("test")) ||
    fullName.includes("database") ||
    fullName.includes("integration-test") ||
    fullName.includes("e2e") // already caught above but being explicit
  ) {
    return "integration";
  }

  // Unit test patterns
  if (
    fullName.includes("unit") ||
    fullName.includes(".test.") ||
    fullName.includes(".spec.") ||
    fullName.includes("__tests__") ||
    fullName.includes("__stubs__")
  ) {
    return "unit";
  }

  return "unknown";
}

// ─── Git Operations ───────────────────────────────────────────────────────

async function getCurrentCommitHash(
  projectRoot: string,
): Promise<string | null> {
  const git = simpleGit(projectRoot);
  try {
    const log = await git.log({ maxCount: 1 });
    if (log.all.length > 0) {
      return log.all[0].hash;
    }
  } catch (err) {
    log("Error in getCurrentCommitHash: %O", err);
  }

  try {
    const output = await git.raw(["rev-parse", "HEAD"]);
    return output.trim() || null;
  } catch (err) {
    log("Error in getCurrentCommitHash: %O", err);
  }

  return null;
}

async function getCommitsForTestFile(
  projectRoot: string,
  testFilePath: string,
): Promise<string[]> {
  const git = simpleGit(projectRoot);
  const relativePath = relative(projectRoot, testFilePath).replace(/\\/g, "/");

  try {
    const output = await git.raw(["log", "--format=%H", "--", relativePath]);
    return output.trim().split("\n").filter(Boolean);
  } catch (err) {
    log("Error in getCommitsForTestFile: %O", err);
    return [];
  }
}

// ─── Flakiness Detection ───────────────────────────────────────────────────

function detectOrderingDependency(
  testRuns: TestRunEntry[],
  testName: string,
  classname: string,
): "ordering" | "random" | "none" {
  const relevantRuns = testRuns
    .filter((r) => r.test === testName && r.classname === classname)
    .sort(
      (a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );

  if (relevantRuns.length < 3) {
    return "none";
  }

  let alternatingCount = 0;
  for (let i = 1; i < relevantRuns.length; i++) {
    if (relevantRuns[i].passed !== relevantRuns[i - 1].passed) {
      alternatingCount++;
    }
  }

  const failRate =
    relevantRuns.filter((r) => !r.passed).length / relevantRuns.length;
  const alternatingRatio = alternatingCount / (relevantRuns.length - 1);

  if (alternatingRatio > 0.4 && failRate > 0.2 && failRate < 0.8) {
    return "ordering";
  }

  if (failRate > 0.1 && failRate < 0.9) {
    return "random";
  }

  return "none";
}

function groupTestsByDirectory(tests: TestHistory[]): TestGroup {
  const groups: TestGroup = {};

  for (const test of tests) {
    const parts = test.classname.split(".");
    let dir = "root";
    if (parts.length >= 2) {
      dir = parts.slice(0, -1).join("/");
    }

    if (!groups[dir]) {
      groups[dir] = [];
    }
    groups[dir].push(test);
  }

  return groups;
}

function summarizeGroupedTests(groupedTests: TestGroup): Record<string, object[]> {
  const summary: Record<string, object[]> = {};

  for (const [group, tests] of Object.entries(groupedTests)) {
    summary[group] = tests.map((test) => ({
      name: test.name,
      classname: test.classname,
      totalRuns: test.totalRuns,
      passedRuns: test.passedRuns,
      failedRuns: test.failedRuns,
      passRate: test.passRate,
      passRatePct: Math.round(test.passRate * 100),
      uniqueCommits: test.uniqueCommits,
      flakyPattern: test.flakyPattern,
      category: test.category,
      avgDurationMs: test.avgDuration
        ? Math.round(test.avgDuration)
        : undefined,
      maxDurationMs: test.maxDuration
        ? Math.round(test.maxDuration)
        : undefined,
    }));
  }

  return summary;
}

// ─── Slow Test Detection ───────────────────────────────────────────────────

function detectSlowTests(testRuns: TestRunEntry[]): Finding[] {
  const findings: Finding[] = [];

  // Group by test
  const testDurations = new Map<
    string,
    { total: number; count: number; max: number }
  >();

  for (const run of testRuns) {
    if (run.duration === undefined || run.duration === null) continue;

    const key = `${run.classname}::${run.test}`;
    const existing = testDurations.get(key) || { total: 0, count: 0, max: 0 };
    existing.total += run.duration;
    existing.count += 1;
    existing.max = Math.max(existing.max, run.duration);
    testDurations.set(key, existing);
  }

  // Check for slow tests
  for (const [key, stats] of testDurations) {
    const avgDuration = stats.total / stats.count;

    if (avgDuration > SLOW_TEST_THRESHOLD_MS) {
      const [classname, testName] = key.split("::");
      findings.push({
        id: uuidv4(),
        moduleId: MODULE_ID,
        type: "FLAKY_TEST",
        severity: "MEDIUM" as Severity,
        file: classname,
        message: `Test "${testName}" is slow: avg ${(avgDuration / 1000).toFixed(2)}s (threshold: 5s)`,
        fix: "Optimize the test or split it into smaller unit tests",
        metadata: {
          test: testName,
          classname,
          avgDurationMs: Math.round(avgDuration),
          maxDurationMs: Math.round(stats.max),
          runs: stats.count,
        },
      });
    }
  }

  return findings;
}

// ─── Main Entry Point ───────────────────────────────────────────────────────

export async function runFlakinessModule(
  config: ProjectHealthConfig,
): Promise<ModuleResult> {
  const startTime = Date.now();
  const findings: Finding[] = [];
  const testHistory: TestHistory[] = [];
  const suppressedTests: TestSuppression[] = [];

  if (!config.modules.flakiness.enabled) {
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
  const { lookbackRuns, passRateThreshold } = config.modules.flakiness;
  const normalizedThreshold = normalizePassRateThreshold(passRateThreshold);

  try {
    const history = loadHistory(projectRoot);
    const commitHash = (await getCurrentCommitHash(projectRoot)) || "unknown";

    // Find all test result files
    const testFiles = findTestResultFiles(projectRoot);
    const runTimestamp = new Date().toISOString();

    const currentRunResults: TestRunEntry[] = [];

    for (const { type, path } of testFiles) {
      try {
        const content = readFileSync(path, "utf-8");
        let results: TestResult[] = [];

        if (type === "junit") {
          results = parseJUnitXml(content);
        } else if (type === "jest-json") {
          results = parseJestJson(content);
        } else if (type === "pytest-json") {
          results = parsePytestJson(content);
        }

        for (const result of results) {
          currentRunResults.push({
            timestamp: runTimestamp,
            commitHash,
            test: result.name,
            classname: result.classname,
            passed: result.passed,
            duration: result.duration,
            status: result.status,
          });
        }
      } catch (err) {
        log(`Error parsing test file ${path}: %O`, err);
      }
    }

    // If no test results found
    if (currentRunResults.length === 0 && history.runs.length === 0) {
      return {
        moduleId: MODULE_ID,
        moduleName: MODULE_NAME,
        score: 100,
        status: "ok",
        findings: [
          {
            id: uuidv4(),
            moduleId: MODULE_ID,
            type: "FLAKY_TEST",
            severity: "LOW" as Severity,
            message:
              "No test results found - ensure test reporters are configured",
            fix: "Configure your test runner to output JUnit XML, Jest JSON, or pytest JSON reports",
            metadata: {
              supportedFormats: ["JUnit XML", "Jest JSON", "pytest JSON/XML"],
            },
          },
        ],
        metadata: { totalTests: 0, flakyTests: 0, testTypesFound: [] },
        durationMs: Date.now() - startTime,
      };
    }

    // Append current run to history
    history.runs.push(...currentRunResults);

    // Keep only last N runs
    const uniqueTimestamps = [
      ...new Set(history.runs.map((r) => r.timestamp)),
    ].sort((a, b) => new Date(b).getTime() - new Date(a).getTime());

    const runsToKeep = uniqueTimestamps.slice(0, lookbackRuns);
    const cutoffTime =
      runsToKeep.length > 0
        ? new Date(runsToKeep[runsToKeep.length - 1]).getTime()
        : 0;

    history.runs = history.runs.filter(
      (r) => new Date(r.timestamp).getTime() >= cutoffTime,
    );

    saveHistory(projectRoot, history);

    // Aggregate test results
    const testRunsMap = new Map<string, TestRunEntry[]>();

    for (const run of history.runs) {
      const key = `${run.classname}::${run.test}`;

      if (!testRunsMap.has(key)) {
        testRunsMap.set(key, []);
      }
      testRunsMap.get(key)!.push(run);
    }

    const testResultsMap = new Map<string, TestHistory>();

    // Compute statistics for each test
    for (const [key, runs] of testRunsMap) {
      const [classname, testName] = key.split("::");
      const commits = [...new Set(runs.map((r) => r.commitHash))];
      const flakyPattern = detectOrderingDependency(runs, testName, classname);

      const passedRuns = runs.filter((r) => r.passed).length;
      const totalRuns = runs.length;
      const passRate = totalRuns > 0 ? passedRuns / totalRuns : 0;
      const failedRuns = totalRuns - passedRuns;

      // Calculate duration stats
      const durations = runs
        .filter((r) => r.duration !== undefined)
        .map((r) => r.duration!);
      const avgDuration =
        durations.length > 0
          ? durations.reduce((a, b) => a + b, 0) / durations.length
          : undefined;
      const maxDuration =
        durations.length > 0 ? Math.max(...durations) : undefined;

      const isFlaky =
        (totalRuns >= MIN_RUNS_FOR_PASS_RATE_ANALYSIS &&
          passRate < normalizedThreshold) ||
        flakyPattern !== "none";

      const historyEntry: TestHistory = {
        name: testName,
        classname,
        totalRuns,
        passedRuns,
        passRate,
        commits,
        uniqueCommits: commits.length,
        isFlaky,
        flakyPattern,
        failedRuns,
        threshold: normalizedThreshold,
        avgDuration,
        maxDuration,
        category: categorizeTest(classname, testName),
      };

      testHistory.push(historyEntry);
      testResultsMap.set(key, historyEntry);
    }

    // Detect slow tests
    const slowTestFindings = detectSlowTests(history.runs);
    findings.push(...slowTestFindings);

    // Process each test for flakiness
    for (const historyResult of testHistory) {
      if (!historyResult.isFlaky) {
        continue;
      }

      let sourceChangedRecently = false;
      let sourceLastModified: Date | null = null;

      const testFile = getTestFileFromClassname(
        historyResult.classname,
        projectRoot,
      );

      if (testFile) {
        const changedCommits = await getCommitsForTestFile(
          projectRoot,
          testFile,
        );

        for (const run of history.runs) {
          if (
            run.classname === historyResult.classname &&
            run.test === historyResult.name
          ) {
            if (changedCommits.includes(run.commitHash)) {
              sourceChangedRecently = true;
              break;
            }
          }
        }

        if (!sourceChangedRecently) {
          sourceLastModified = await getFileLastModified(projectRoot, testFile);
          if (sourceLastModified) {
            const daysSinceChange =
              (Date.now() - sourceLastModified.getTime()) /
              (1000 * 60 * 60 * 24);
            if (daysSinceChange <= 7) {
              sourceChangedRecently = true;
            }
          }
        }
      }

      if (sourceChangedRecently) {
        suppressedTests.push({
          name: historyResult.name,
          classname: historyResult.classname,
          reason: "recent_source_change",
          file: testFile ? relative(projectRoot, testFile) : undefined,
          lastModified: sourceLastModified?.toISOString(),
        });
        continue;
      }

      let severity: Severity = "HIGH";
      let message = `Test "${historyResult.name}" pass rate is ${Math.round(historyResult.passRate * 100)}% (${historyResult.passedRuns}/${historyResult.totalRuns} passes, ${historyResult.failedRuns} failures) across ${historyResult.uniqueCommits} commits; threshold ${Math.round(historyResult.threshold * 100)}%`;
      let reason = "pass_rate_below_threshold";

      if (historyResult.flakyPattern === "ordering") {
        severity = "CRITICAL";
        reason = "ordering_dependency";
        message = `Test "${historyResult.name}" shows an ordering dependency: pass/fail outcomes alternate without source changes`;
      } else if (historyResult.flakyPattern === "random") {
        severity = "HIGH";
        reason = "random_flakiness_pattern";
        message = `Test "${historyResult.name}" appears randomly flaky: mixed pass/fail outcomes with no stable pattern`;
      }

      findings.push({
        id: uuidv4(),
        moduleId: MODULE_ID,
        type: "FLAKY_TEST",
        severity,
        file: testFile ? relative(projectRoot, testFile) : undefined,
        message,
        fix:
          historyResult.flakyPattern === "ordering"
            ? "Test likely depends on execution order. Make tests independent or use --randomize seed"
            : "Review test for timing issues, shared state, or external dependencies",
        metadata: {
          test: historyResult.name,
          classname: historyResult.classname,
          passRate: historyResult.passRate,
          passRatePct: Math.round(historyResult.passRate * 100),
          threshold: historyResult.threshold,
          thresholdPct: Math.round(historyResult.threshold * 100),
          passedRuns: historyResult.passedRuns,
          failedRuns: historyResult.failedRuns,
          runs: historyResult.totalRuns,
          commits: historyResult.uniqueCommits,
          flakyPattern: historyResult.flakyPattern,
          reason,
          category: historyResult.category,
          avgDurationMs: historyResult.avgDuration
            ? Math.round(historyResult.avgDuration)
            : undefined,
        },
      });
    }

    const groupedTests = groupTestsByDirectory(
      testHistory.filter((test) => test.isFlaky),
    );
    const groupedSummary = summarizeGroupedTests(groupedTests);
    const runCount = uniqueTimestamps.length;
    const flakyCount = findings.filter(
      (f) => f.type === "FLAKY_TEST" && f.metadata.reason !== undefined,
    ).length;

    // Count test types
    const testTypes = new Set(testHistory.map((t) => t.category));
    const testTypesFound = Array.from(testTypes);

    const score = calculateModuleScore(findings);

    return {
      moduleId: MODULE_ID,
      moduleName: MODULE_NAME,
      score,
      status: score >= 80 ? "ok" : score >= 60 ? "warning" : "error",
      findings,
      metadata: {
        totalTests: testHistory.length,
        flakyTests: flakyCount,
        slowTests: slowTestFindings.length,
        historyRuns: runCount,
        historyEntries: history.runs.length,
        uniqueTests: testResultsMap.size,
        testFilesScanned: testFiles.length,
        lookbackRuns,
        passRateThreshold: normalizedThreshold,
        passRateThresholdPct: Math.round(normalizedThreshold * 100),
        suppressedDueToRecentChanges: suppressedTests.length,
        suppressedTests,
        groups: groupedSummary,
        testTypesFound,
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
          type: "FLAKY_TEST",
          severity: "CRITICAL" as Severity,
          message:
            error instanceof Error
              ? error.message
              : "Test Flakiness scan failed",
          metadata: { error: String(error) },
        },
      ],
      metadata: { error: String(error) },
      durationMs: Date.now() - startTime,
    };
  }
}

// Get test file path from classname
function getTestFileFromClassname(
  classname: string,
  projectRoot: string,
): string | undefined {
  const parts = classname.split(".");
  const testDirs = [
    "src/test",
    "test",
    "__tests__",
    "tests",
    "spec",
    "src/__tests__",
  ];
  const extensions = [".ts", ".js", ".py", ".java", ".go"];

  for (const testDir of testDirs) {
    for (const ext of extensions) {
      const filePath = join(projectRoot, testDir, ...parts) + ext;
      if (existsSync(filePath)) {
        return filePath;
      }
      // Try without full path
      const simplePath = join(
        projectRoot,
        testDir,
        parts[parts.length - 1] + ext,
      );
      if (existsSync(simplePath)) {
        return simplePath;
      }
    }
  }

  return undefined;
}

async function getFileLastModified(
  projectRoot: string,
  filePath: string,
): Promise<Date | null> {
  const git = simpleGit(projectRoot);
  const relativePath = relative(projectRoot, filePath).replace(/\\/g, "/");

  try {
    const output = await git.raw([
      "log",
      "-1",
      "--format=%cI",
      "--",
      relativePath,
    ]);
    const isoDate = output.trim();
    if (isoDate) {
      return new Date(isoDate);
    }
  } catch (err) {
    log("Error in getFileLastModified: %O", err);
  }

  return null;
}

function calculateModuleScore(findings: Finding[]): number {
  if (findings.length === 0) return 100;

  const criticalCount = findings.filter(
    (f) => f.severity === "CRITICAL",
  ).length;
  const highCount = findings.filter((f) => f.severity === "HIGH").length;
  const mediumCount = findings.filter((f) => f.severity === "MEDIUM").length;

  const deduction = criticalCount * 35 + highCount * 15 + mediumCount * 5;
  return Math.max(0, 100 - deduction);
}

export default runFlakinessModule;
