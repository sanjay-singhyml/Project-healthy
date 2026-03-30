// M-01: CI/CD Pipeline Module
// Detects CI/CD anomalies across GitHub Actions, GitLab CI, Jenkinsfile, CircleCI
// Finds workflow files, parses YAML, flags missing cache, slow patterns, parallelization gaps
// Supports GitHub Actions REST API for runtime metrics when GITHUB_TOKEN is set

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
import yaml from "js-yaml";
import { simpleGit } from "simple-git";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("ph:cicd");

export const MODULE_ID: ModuleId = "M-01";
export const MODULE_NAME = "CI/CD Pipeline";

// ─── GitHub API Integration ───────────────────────────────────────────────────

interface GitHubApiJob {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  started_at: string;
  completed_at: string | null;
}

interface GitHubApiRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  created_at: string;
  updated_at: string;
  run_started_at: string;
  jobs_url: string;
}

interface GitHubRunMetrics {
  averageJobDurationMs: number;
  slowestJob: { name: string; durationMs: number } | null;
  p95DurationMs: number;
  jobsWithoutCacheStep: string[];
  totalRuns: number;
  totalJobs: number;
}

// Validate that a GitHub token looks real (not a placeholder)
function isValidGitHubToken(token: string | undefined): boolean {
  if (!token) return false;
  const trimmed = token.trim();
  if (trimmed.length < 10) return false;
  // Common placeholder patterns
  const placeholders = [
    "your_github_token_here",
    "your_token_here",
    "YOUR_TOKEN",
    "xxx",
    "changeme",
    "replace_me",
    "TODO",
  ];
  if (
    placeholders.some((p) => trimmed.toLowerCase().includes(p.toLowerCase()))
  ) {
    return false;
  }
  // GitHub tokens start with ghp_, gho_, ghu_, ghs_, ghr_, or github_pat_
  if (
    !trimmed.startsWith("ghp_") &&
    !trimmed.startsWith("gho_") &&
    !trimmed.startsWith("ghu_") &&
    !trimmed.startsWith("ghs_") &&
    !trimmed.startsWith("ghr_") &&
    !trimmed.startsWith("github_pat_")
  ) {
    // Could still be a legacy token (40 hex chars)
    if (!/^[a-f0-9]{40}$/i.test(trimmed)) {
      return false;
    }
  }
  return true;
}

// Parse GitHub remote URL to get owner/repo
function parseGitHubRemote(
  url: string,
): { owner: string; repo: string } | null {
  // HTTPS format: https://github.com/owner/repo.git
  const httpsMatch = url.match(/github\.com[/:]([^/]+)\/([^/.]+)(?:\.git)?$/);
  if (httpsMatch) {
    return { owner: httpsMatch[1], repo: httpsMatch[2] };
  }

  // SSH format: git@github.com:owner/repo.git
  const sshMatch = url.match(/git@github\.com:([^/]+)\/([^/.]+)(?:\.git)?$/);
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }

  return null;
}

// Get GitHub remote info
async function getGitHubRemote(
  projectRoot: string,
): Promise<{ owner: string; repo: string } | null> {
  const git = simpleGit(projectRoot);

  try {
    const url = await git.remote(["get-url", "origin"]);
    if (!url) return null;

    return parseGitHubRemote(url.trim());
  } catch (err) {
    log("Error in getGitHubRemote: %O", err);
    return null;
  }
}

// Fetch GitHub Actions runs and compute metrics
async function fetchGitHubActionsMetrics(
  owner: string,
  repo: string,
  token: string,
): Promise<GitHubRunMetrics | null> {
  try {
    const runsResponse = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/actions/runs?per_page=50`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "User-Agent": "project-health/2.0",
          Accept: "application/vnd.github.v3+json",
        },
      },
    );

    if (!runsResponse.ok) {
      if (runsResponse.status === 401) {
        console.error(
          "\n  GitHub API returned 401 Unauthorized.",
          "\n  Your GITHUB_TOKEN is invalid or expired.",
          "\n  Generate a new token at: https://github.com/settings/tokens/new?scopes=repo,read:org,actions:read",
          "\n  Then set it in your .env file: GITHUB_TOKEN=ghp_your_token_here\n",
        );
      } else {
        log("GitHub API error: %d", runsResponse.status);
      }
      return null;
    }

    const runsData = (await runsResponse.json()) as {
      workflow_runs: GitHubApiRun[];
    };
    const runs = runsData.workflow_runs || [];

    if (runs.length === 0) {
      return null;
    }

    // Collect job durations from runs
    const jobDurations: number[] = [];
    const jobNames: Map<string, number[]> = new Map();
    const jobsWithoutCache: Set<string> = new Set();
    let totalJobs = 0;

    // Fetch jobs for each run (limit to avoid rate limiting)
    const runsToCheck = runs.slice(0, 10); // Last 10 runs

    for (const run of runsToCheck) {
      try {
        const jobsResponse = await fetch(run.jobs_url, {
          headers: {
            Authorization: `Bearer ${token}`,
            "User-Agent": "project-health/2.0",
            Accept: "application/vnd.github.v3+json",
          },
        });

        if (!jobsResponse.ok) continue;

        const jobsData = (await jobsResponse.json()) as {
          jobs: GitHubApiJob[];
        };
        const jobs = jobsData.jobs || [];

        for (const job of jobs) {
          totalJobs++;

          if (job.started_at && job.completed_at) {
            const startTime = new Date(job.started_at).getTime();
            const endTime = new Date(job.completed_at).getTime();
            const duration = endTime - startTime;

            if (duration > 0) {
              jobDurations.push(duration);

              // Track durations by job name
              const durations = jobNames.get(job.name) || [];
              durations.push(duration);
              jobNames.set(job.name, durations);
            }
          }

          // Check for cache step in job name (rough heuristic)
          if (!job.name.toLowerCase().includes("cache")) {
            jobsWithoutCache.add(job.name);
          }
        }
      } catch (err) {
        log("Error in fetchGitHubActionsMetrics: %O", err);
        // Skip failed job fetches
      }
    }

    if (jobDurations.length === 0) {
      return null;
    }

    // Calculate average
    const avgDuration =
      jobDurations.reduce((a, b) => a + b, 0) / jobDurations.length;

    // Calculate p95
    const sortedDurations = [...jobDurations].sort((a, b) => a - b);
    const p95Index = Math.floor(sortedDurations.length * 0.95);
    const p95Duration = sortedDurations[p95Index] || 0;

    // Find slowest job
    let slowestJob: { name: string; durationMs: number } | null = null;
    for (const [name, durations] of jobNames) {
      const avgJobDuration =
        durations.reduce((a, b) => a + b, 0) / durations.length;
      if (!slowestJob || avgJobDuration > slowestJob.durationMs) {
        slowestJob = { name, durationMs: avgJobDuration };
      }
    }

    return {
      averageJobDurationMs: avgDuration,
      slowestJob,
      p95DurationMs: p95Duration,
      jobsWithoutCacheStep: Array.from(jobsWithoutCache),
      totalRuns: runs.length,
      totalJobs,
    };
  } catch (error) {
    console.error("GitHub API fetch error:", error);
    return null;
  }
}

// Detect slow pipeline based on API metrics
function detectSlowPipeline(metrics: GitHubRunMetrics): Finding[] {
  const findings: Finding[] = [];
  const tenMinutesMs = 10 * 60 * 1000; // 10 minutes

  if (metrics.averageJobDurationMs > tenMinutesMs) {
    const avgMinutes = Math.round(metrics.averageJobDurationMs / 60000);
    findings.push({
      id: uuidv4(),
      moduleId: MODULE_ID,
      type: "SLOW_PIPELINE" as const,
      severity: "HIGH" as Severity,
      message: `Average CI job duration is ${avgMinutes} minutes. Target is <10 min.`,
      fix: "Add dependency caching (actions/cache) and split into parallel jobs",
      metadata: {
        averageDurationMs: metrics.averageJobDurationMs,
        p95DurationMs: metrics.p95DurationMs,
        totalRuns: metrics.totalRuns,
      },
    });
  }

  return findings;
}

// Detect jobs without cache from API data
function detectMissingCacheFromApi(metrics: GitHubRunMetrics): Finding[] {
  const findings: Finding[] = [];

  for (const jobName of metrics.jobsWithoutCacheStep) {
    findings.push({
      id: uuidv4(),
      moduleId: MODULE_ID,
      type: "MISSING_CACHE" as const,
      severity: "MEDIUM" as Severity,
      message: `Job '${jobName}' has no caching step.`,
      fix: "Add actions/cache for node_modules or pip cache",
      metadata: { job: jobName },
    });
  }

  return findings;
}

// Detect no parallelism from API data
function detectNoParallelism(metrics: GitHubRunMetrics): Finding[] {
  const findings: Finding[] = [];

  // If total jobs is low relative to runs, might not be parallel
  if (metrics.totalJobs / metrics.totalRuns <= 1.5) {
    findings.push({
      id: uuidv4(),
      moduleId: MODULE_ID,
      type: "NO_PARALLELISM" as const,
      severity: "LOW" as Severity,
      message:
        "Only 1 job in the workflow - consider parallelizing with matrix strategy",
      fix: "Use strategy.matrix to run tests across Node versions or split lint/test into parallel jobs",
      metadata: {
        jobsPerRun: metrics.totalJobs / metrics.totalRuns,
      },
    });
  }

  return findings;
}

// ─── CI file discovery ───────────────────────────────────────────────────────

interface CiSource {
  type: "github_actions" | "gitlab_ci" | "jenkins" | "circleci";
  path: string;
  name: string;
}

function findCiFiles(projectRoot: string): CiSource[] {
  const sources: CiSource[] = [];

  // GitHub Actions
  const ghDir = join(projectRoot, ".github", "workflows");
  if (existsSync(ghDir)) {
    try {
      for (const entry of readdirSync(ghDir)) {
        if (entry.endsWith(".yml") || entry.endsWith(".yaml")) {
          sources.push({
            type: "github_actions",
            path: join(ghDir, entry),
            name: entry,
          });
        }
      }
    } catch (err) {
      log("Error in findCiFiles: %O", err);
      /* ignore */
    }
  }

  // GitLab CI
  const gitlabPath = join(projectRoot, ".gitlab-ci.yml");
  if (existsSync(gitlabPath)) {
    sources.push({
      type: "gitlab_ci",
      path: gitlabPath,
      name: ".gitlab-ci.yml",
    });
  }

  // Jenkinsfile
  const jenkinsPath = join(projectRoot, "Jenkinsfile");
  if (existsSync(jenkinsPath)) {
    sources.push({ type: "jenkins", path: jenkinsPath, name: "Jenkinsfile" });
  }

  // CircleCI
  const circlePath = join(projectRoot, ".circleci", "config.yml");
  if (existsSync(circlePath)) {
    sources.push({ type: "circleci", path: circlePath, name: "config.yml" });
  }

  return sources;
}

// ─── GitHub Actions analysis ─────────────────────────────────────────────────

interface GhJob {
  name: string;
  runsOn: string[];
  steps: GhStep[];
  needs: string[];
  usesMatrix: boolean;
  hasCache: boolean;
  hasCheckout: boolean;
}

interface GhStep {
  name: string;
  uses: string;
  run: string;
  isInstall: boolean;
  isCache: boolean;
  isCheckout: boolean;
}

function parseGitHubWorkflow(filePath: string): {
  name: string;
  jobs: GhJob[];
  rawJobs: Record<string, unknown>;
} | null {
  try {
    const content = readFileSync(filePath, "utf-8");
    const wf = yaml.load(content) as Record<string, unknown>;
    if (!wf || !wf.jobs) return null;

    const rawJobs = wf.jobs as Record<string, unknown>;
    const jobs: GhJob[] = [];

    for (const [jobName, jobRaw] of Object.entries(rawJobs)) {
      const j = jobRaw as Record<string, unknown>;
      const stepsRaw = (j.steps || []) as Array<Record<string, unknown>>;

      const steps: GhStep[] = stepsRaw.map((s) => {
        const uses = (s.uses as string) || "";
        const run = (s.run as string) || "";
        const name = (s.name as string) || uses || run.split("\n")[0] || "step";
        return {
          name,
          uses,
          run,
          isInstall:
            /\b(npm|yarn|pnpm|bun)\s+(ci|install)\b/i.test(run) ||
            /setup-node|setup-python|setup-go/.test(uses),
          isCache: /actions\/cache|uses:.*cache|restore-cache|save-cache/i.test(
            uses + name + run,
          ),
          isCheckout: /actions\/checkout/.test(uses),
        };
      });

      // runs-on
      const runsOnRaw = j["runs-on"] as string | string[] | undefined;
      const runsOn = Array.isArray(runsOnRaw)
        ? runsOnRaw
        : runsOnRaw
          ? [runsOnRaw]
          : [];

      // needs
      const needsRaw = j.needs as string | string[] | undefined;
      const needs = Array.isArray(needsRaw)
        ? needsRaw
        : needsRaw
          ? [needsRaw]
          : [];

      // matrix
      const strategy = j.strategy as Record<string, unknown> | undefined;
      const usesMatrix = !!(strategy && strategy.matrix);

      jobs.push({
        name: jobName,
        runsOn,
        steps,
        needs,
        usesMatrix,
        hasCache: steps.some((s) => s.isCache),
        hasCheckout: steps.some((s) => s.isCheckout),
      });
    }

    return {
      name: (wf.name as string) || filePath.split(/[/\\]/).pop() || "workflow",
      jobs,
      rawJobs,
    };
  } catch (err) {
    log("Error in parseGitHubWorkflow: %O", err);
    return null;
  }
}

// ─── Anomaly detectors ───────────────────────────────────────────────────────

function detectMissingCache(
  workflow: ReturnType<typeof parseGitHubWorkflow>,
): Finding[] {
  if (!workflow) return [];
  const findings: Finding[] = [];

  for (const job of workflow.jobs) {
    const hasInstall = job.steps.some((s) => s.isInstall);
    if (hasInstall && !job.hasCache) {
      findings.push({
        id: uuidv4(),
        moduleId: MODULE_ID,
        type: "MISSING_CACHE" as const,
        severity: "MEDIUM" as Severity,
        file: workflow.name,
        message: `Job "${job.name}" runs install step but has no cache — every run re-downloads dependencies`,
        fix: `Add actions/cache@v4 before the install step to cache ~/.npm or node_modules`,
        metadata: { job: job.name, workflow: workflow.name },
      });
    }
  }
  return findings;
}

function detectParallelization(
  workflow: ReturnType<typeof parseGitHubWorkflow>,
): Finding[] {
  if (!workflow) return [];
  const findings: Finding[] = [];
  const jobs = workflow.jobs;

  // Find independent jobs (no needs between them)
  const independentGroups = new Map<string, string[]>();
  for (const job of jobs) {
    const depKey = job.needs.sort().join(",") || "__root__";
    const group = independentGroups.get(depKey) || [];
    group.push(job.name);
    independentGroups.set(depKey, group);
  }

  for (const [key, group] of independentGroups) {
    if (key !== "__root__" && group.length >= 2) {
      findings.push({
        id: uuidv4(),
        moduleId: MODULE_ID,
        type: "PARALLEL_OPPORTUNITY" as const,
        severity: "LOW" as Severity,
        file: workflow.name,
        message: `Jobs [${group.join(", ")}] share the same dependencies and could be parallelized`,
        metadata: { jobs: group, workflow: workflow.name },
      });
    }
  }

  // Check for sequential jobs with no dependency (they run anyway, but good to note)
  if (jobs.length >= 3 && jobs.every((j) => j.needs.length === 0)) {
    findings.push({
      id: uuidv4(),
      moduleId: MODULE_ID,
      type: "PARALLEL_OPPORTUNITY" as const,
      severity: "LOW" as Severity,
      file: workflow.name,
      message: `${jobs.length} jobs with no dependencies — all run in parallel by default (OK if intentional)`,
      metadata: { jobCount: jobs.length, workflow: workflow.name },
    });
  }

  return findings;
}

function detectRedundantCheckout(
  workflow: ReturnType<typeof parseGitHubWorkflow>,
): Finding[] {
  if (!workflow) return [];
  const findings: Finding[] = [];

  for (const job of workflow.jobs) {
    const checkoutSteps = job.steps.filter((s) => s.isCheckout);
    if (checkoutSteps.length > 1) {
      findings.push({
        id: uuidv4(),
        moduleId: MODULE_ID,
        type: "SLOW_JOB" as const,
        severity: "MEDIUM" as Severity,
        file: workflow.name,
        message: `Job "${job.name}" has ${checkoutSteps.length} checkout steps — likely redundant`,
        fix: `Remove duplicate checkout steps`,
        metadata: { job: job.name, workflow: workflow.name },
      });
    }
  }
  return findings;
}

function detectMissingMatrix(
  workflow: ReturnType<typeof parseGitHubWorkflow>,
): Finding[] {
  if (!workflow) return [];
  const findings: Finding[] = [];

  const testJobs = workflow.jobs.filter(
    (j) =>
      j.name.toLowerCase().includes("test") ||
      j.name.toLowerCase().includes("lint"),
  );

  for (const job of testJobs) {
    if (!job.usesMatrix && job.steps.length >= 2) {
      findings.push({
        id: uuidv4(),
        moduleId: MODULE_ID,
        type: "SLOW_JOB" as const,
        severity: "LOW" as Severity,
        file: workflow.name,
        message: `Job "${job.name}" does not use strategy.matrix — consider testing across multiple Node versions`,
        metadata: { job: job.name, workflow: workflow.name },
      });
    }
  }

  return findings;
}

function detectGitlabAnomalies(filePath: string): Finding[] {
  const findings: Finding[] = [];
  try {
    const content = readFileSync(filePath, "utf-8");
    const ci = yaml.load(content) as Record<string, unknown>;
    if (!ci) return findings;

    const stages = (ci.stages as string[]) || [];
    const jobEntries = Object.entries(ci).filter(
      ([k, v]) =>
        typeof v === "object" &&
        v !== null &&
        ![
          "stages",
          "variables",
          "include",
          "before_script",
          "after_script",
          "cache",
          "image",
        ].includes(k),
    );

    // Check for missing cache at top level
    if (!ci.cache && jobEntries.length > 0) {
      const hasInstallJob = jobEntries.some(([, j]) => {
        const scripts =
          ((j as Record<string, unknown>).script as string[]) || [];
        return scripts.some((s) =>
          /\b(npm|yarn|pnpm)\s+(ci|install)\b/.test(s),
        );
      });
      if (hasInstallJob) {
        findings.push({
          id: uuidv4(),
          moduleId: MODULE_ID,
          type: "MISSING_CACHE" as const,
          severity: "MEDIUM" as Severity,
          file: filePath.split(/[/\\]/).pop(),
          message:
            "GitLab CI has install steps but no top-level cache configuration",
          fix: "Add cache:key and cache:paths for node_modules or package manager cache",
          metadata: { file: ".gitlab-ci.yml" },
        });
      }
    }

    // Check for many stages without parallelism hints
    if (stages.length > 4) {
      findings.push({
        id: uuidv4(),
        moduleId: MODULE_ID,
        type: "SLOW_JOB" as const,
        severity: "LOW" as Severity,
        file: ".gitlab-ci.yml",
        message: `${stages.length} stages defined — ensure jobs within the same stage run in parallel`,
        metadata: { stages: stages.length },
      });
    }
  } catch (err) {
    log("Error in detectGitlabAnomalies: %O", err);
    /* ignore */
  }
  return findings;
}

function detectJenkinsAnomalies(filePath: string): Finding[] {
  const findings: Finding[] = [];
  try {
    const content = readFileSync(filePath, "utf-8");

    // Check for missing parallel block
    const hasParallel = /parallel\s*\{|ParallelExecution/.test(content);
    const hasStages = /stages\s*\{/.test(content);
    const stageCount = (content.match(/stage\s*\(/g) || []).length;

    if (hasStages && !hasParallel && stageCount >= 3) {
      findings.push({
        id: uuidv4(),
        moduleId: MODULE_ID,
        type: "PARALLEL_OPPORTUNITY" as const,
        severity: "MEDIUM" as Severity,
        file: "Jenkinsfile",
        message: `${stageCount} stages without parallel block — build runs sequentially`,
        fix: "Wrap independent stages in parallel { ... } to reduce build time",
        metadata: { stages: stageCount },
      });
    }

    // Check for missing node/npm cache
    const hasNpmInstall = /npm\s+(ci|install)/.test(content);
    const hasCache = /cache|stash|unstash/.test(content);
    if (hasNpmInstall && !hasCache) {
      findings.push({
        id: uuidv4(),
        moduleId: MODULE_ID,
        type: "MISSING_CACHE" as const,
        severity: "MEDIUM" as Severity,
        file: "Jenkinsfile",
        message:
          "Jenkinsfile has npm install but no caching strategy (stash/unstash or pipeline cache)",
        fix: "Use stash/unstash or a cache plugin for node_modules",
        metadata: {},
      });
    }
  } catch (err) {
    log("Error in detectJenkinsAnomalies: %O", err);
    /* ignore */
  }
  return findings;
}

// ─── Main entry point ────────────────────────────────────────────────────────

export async function runCicdModule(
  config: ProjectHealthConfig,
): Promise<ModuleResult> {
  const startTime = Date.now();
  const findings: Finding[] = [];

  if (!config.modules.cicd.enabled) {
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
  const ciFiles = findCiFiles(projectRoot);

  // Check for GitHub token for API integration (skip placeholders)
  const rawToken = process.env.GITHUB_TOKEN;
  const githubToken = isValidGitHubToken(rawToken) ? rawToken : undefined;
  let githubMetrics: GitHubRunMetrics | null = null;

  // Try to get GitHub metrics if token is available
  if (githubToken) {
    const remote = await getGitHubRemote(projectRoot);
    if (remote) {
      log(
        `Fetching GitHub Actions metrics for ${remote.owner}/${remote.repo}...`,
      );
      githubMetrics = await fetchGitHubActionsMetrics(
        remote.owner,
        remote.repo,
        githubToken,
      );
    }
  } else if (rawToken) {
    log("GITHUB_TOKEN appears to be a placeholder — skipping GitHub API calls");
  }

  try {
    // Track metadata
    const ciTypes: string[] = [];
    let totalWorkflows = 0;

    for (const source of ciFiles) {
      ciTypes.push(source.type);

      if (source.type === "github_actions") {
        const wf = parseGitHubWorkflow(source.path);
        if (wf) {
          totalWorkflows++;
          findings.push(...detectMissingCache(wf));
          findings.push(...detectParallelization(wf));
          findings.push(...detectRedundantCheckout(wf));
          findings.push(...detectMissingMatrix(wf));
        }
      } else if (source.type === "gitlab_ci") {
        findings.push(...detectGitlabAnomalies(source.path));
      } else if (source.type === "jenkins") {
        findings.push(...detectJenkinsAnomalies(source.path));
      } else if (source.type === "circleci") {
        // CircleCI uses similar YAML structure, treat like GitLab
        findings.push(...detectGitlabAnomalies(source.path));
      }
    }

    // Add GitHub API-based findings
    if (githubMetrics) {
      findings.push(...detectSlowPipeline(githubMetrics));
      findings.push(...detectMissingCacheFromApi(githubMetrics));
      findings.push(...detectNoParallelism(githubMetrics));
    }

    // If no CI files at all
    if (ciFiles.length === 0) {
      findings.push({
        id: uuidv4(),
        moduleId: MODULE_ID,
        type: "MISSING_CACHE" as const,
        severity: "LOW" as Severity,
        message:
          "No CI/CD configuration found — consider adding GitHub Actions or similar",
        fix: "Create .github/workflows/ci.yml with basic build + test pipeline",
        metadata: {},
      });
    }

    const score = calculateModuleScore(findings);

    return {
      moduleId: MODULE_ID,
      moduleName: MODULE_NAME,
      score,
      status: score >= 80 ? "ok" : score >= 60 ? "warning" : "error",
      findings,
      metadata: {
        ciTypes: [...new Set(ciTypes)],
        workflowsAnalyzed: totalWorkflows,
        filesAnalyzed: ciFiles.length,
        missingCache: findings.filter((f) => f.type === "MISSING_CACHE").length,
        parallelizationGaps: findings.filter(
          (f) => f.type === "PARALLEL_OPPORTUNITY",
        ).length,
        slowPatterns: findings.filter((f) => f.type === "SLOW_JOB").length,
        githubApiUsed: !!githubMetrics,
        githubMetrics: githubMetrics
          ? {
              averageJobDurationMs: githubMetrics.averageJobDurationMs,
              slowestJob: githubMetrics.slowestJob,
              p95DurationMs: githubMetrics.p95DurationMs,
              totalRuns: githubMetrics.totalRuns,
              totalJobs: githubMetrics.totalJobs,
            }
          : undefined,
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
          type: "SLOW_JOB" as const,
          severity: "CRITICAL" as Severity,
          message: `CI/CD analysis failed: ${error instanceof Error ? error.message : String(error)}`,
          metadata: { error: String(error) },
        },
      ],
      metadata: { error: String(error) },
      durationMs: Date.now() - startTime,
    };
  }
}

function calculateModuleScore(findings: Finding[]): number {
  if (findings.length === 0) return 100;

  let deduction = 0;
  for (const f of findings) {
    switch (f.severity) {
      case "CRITICAL":
        deduction += 30;
        break;
      case "HIGH":
        deduction += 15;
        break;
      case "MEDIUM":
        deduction += 5;
        break;
      case "LOW":
        deduction += 2;
        break;
    }
  }
  return Math.max(0, 100 - deduction);
}

export default runCicdModule;
