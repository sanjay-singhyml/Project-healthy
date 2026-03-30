// M-06: PR Complexity Module
// GitHub/GitLab PR API integration
// Diff stats collection
// Cross-module change count
// Review turnaround time
// Detects LARGE_PR, STALE_PR, MISSING_TESTS, MISSING_DESCRIPTION, NO_REVIEW

import {
  ModuleResult,
  ModuleId,
  ProjectHealthConfig,
  Finding,
  Severity,
} from "../../types/index.js";
import { v4 as uuidv4 } from "uuid";
import { simpleGit } from "simple-git";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("ph:prcomplexity");

export const MODULE_ID: ModuleId = "M-06";
export const MODULE_NAME = "PR Complexity";

// Validate that a GitHub token looks real (not a placeholder)
function isValidGitHubToken(token: string | undefined): boolean {
  if (!token) return false;
  const trimmed = token.trim();
  if (trimmed.length < 10) return false;
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
  if (
    !trimmed.startsWith("ghp_") &&
    !trimmed.startsWith("gho_") &&
    !trimmed.startsWith("ghu_") &&
    !trimmed.startsWith("ghs_") &&
    !trimmed.startsWith("ghr_") &&
    !trimmed.startsWith("github_pat_")
  ) {
    if (!/^[a-f0-9]{40}$/i.test(trimmed)) {
      return false;
    }
  }
  return true;
}

interface PRInfo {
  number: number;
  title: string;
  body: string;
  linesAdded: number;
  linesDeleted: number;
  filesChanged: string[];
  createdAt: Date;
  updatedAt: Date;
  reviewCount: number;
  approvedReviewCount: number;
  lastReviewAt: Date | null;
  isStale: boolean;
}

// Get remote info from git
async function getRemoteInfo(
  projectRoot: string,
): Promise<{ owner: string; repo: string } | null> {
  const git = simpleGit(projectRoot);

  try {
    const remotes = await git.getRemotes(true);
    const origin = remotes.find((r) => r.name === "origin");

    if (origin && origin.refs.fetch) {
      const match = origin.refs.fetch.match(
        /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/,
      );

      if (match) {
        return { owner: match[1], repo: match[2] };
      }
    }
  } catch (err) {
    log("Error in getRemoteInfo: %O", err);
    // Ignore
  }

  return null;
}

// Fetch open PRs from GitHub API
async function fetchGitHubPRs(
  owner: string,
  repo: string,
  token: string,
): Promise<PRInfo[]> {
  const prs: PRInfo[] = [];

  try {
    const headers = {
      Authorization: `Bearer ${token}`,
      "User-Agent": "project-health/2.0",
      Accept: "application/vnd.github.v3+json",
    };

    // Fetch open PRs
    const prsResponse = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/pulls?state=open&per_page=100`,
      { headers },
    );

    if (!prsResponse.ok) {
      if (prsResponse.status === 401) {
        console.error(
          "\n  GitHub API returned 401 Unauthorized.",
          "\n  Your GITHUB_TOKEN is invalid or expired.",
          "\n  Generate a new token at: https://github.com/settings/tokens/new?scopes=repo,read:org",
          "\n  Then set it in your .env file: GITHUB_TOKEN=ghp_your_token_here\n",
        );
      } else {
        log("GitHub API error fetching PRs: %d", prsResponse.status);
      }
      return prs;
    }

    const prsData = (await prsResponse.json()) as Array<{
      number: number;
      title: string;
      body: string | null;
      created_at: string;
      updated_at: string;
    }>;

    for (const pr of prsData) {
      // Fetch files changed for this PR
      const filesResponse = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/pulls/${pr.number}/files`,
        { headers },
      );

      const files: string[] = [];
      let additions = 0;
      let deletions = 0;

      if (filesResponse.ok) {
        const filesData = (await filesResponse.json()) as Array<{
          filename: string;
          additions: number;
          deletions: number;
        }>;

        for (const file of filesData) {
          files.push(file.filename);
          additions += file.additions || 0;
          deletions += file.deletions || 0;
        }
      }

      // Fetch reviews for this PR
      const reviewsResponse = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/pulls/${pr.number}/reviews`,
        { headers },
      );

      let reviewCount = 0;
      let approvedReviewCount = 0;
      let lastReviewAt: Date | null = null;

      if (reviewsResponse.ok) {
        const reviewsData = (await reviewsResponse.json()) as Array<{
          state: string;
          submitted_at: string;
        }>;

        reviewCount = reviewsData.length;
        approvedReviewCount = reviewsData.filter(
          (r) => r.state === "APPROVED",
        ).length;

        if (reviewsData.length > 0) {
          const lastReview = reviewsData[reviewsData.length - 1];
          if (lastReview.submitted_at) {
            lastReviewAt = new Date(lastReview.submitted_at);
          }
        }
      }

      prs.push({
        number: pr.number,
        title: pr.title,
        body: pr.body || "",
        linesAdded: additions,
        linesDeleted: deletions,
        filesChanged: files,
        createdAt: new Date(pr.created_at),
        updatedAt: new Date(pr.updated_at),
        reviewCount,
        approvedReviewCount,
        lastReviewAt,
        isStale: false,
      });
    }
  } catch (error) {
    console.error("GitHub API fetch error:", error);
  }

  return prs;
}

// Analyze local branches vs main (fallback when no GITHUB_TOKEN)
async function analyzeLocalBranches(projectRoot: string): Promise<PRInfo[]> {
  const prs: PRInfo[] = [];
  const git = simpleGit(projectRoot);

  try {
    // Get current branch
    const currentBranch = await git.revparse(["--abbrev-ref", "HEAD"]);

    // Skip if on main/master
    if (currentBranch === "main" || currentBranch === "master") {
      return prs;
    }

    // Get commits in branch vs main
    const logOutput = await git
      .log({
        from: "main",
        to: "HEAD",
      })
      .catch(() => null);

    if (!logOutput || logOutput.all.length === 0) {
      // Try master if main doesn't exist
      const logOutputMaster = await git
        .log({
          from: "master",
          to: "HEAD",
        })
        .catch(() => null);

      if (!logOutputMaster || logOutputMaster.all.length === 0) {
        return prs;
      }
    }

    // Get diff stats
    const diffSummary = await git
      .diffSummary(["main...HEAD"])
      .catch(() => null);

    if (!diffSummary) {
      const diffSummaryMaster = await git
        .diffSummary(["master...HEAD"])
        .catch(() => null);
      if (!diffSummaryMaster) {
        return prs;
      }
    }

    const files: string[] = [];
    let additions = 0;
    let deletions = 0;

    const summary =
      diffSummary ||
      (await git.diffSummary(["master...HEAD"]).catch(() => null));

    if (summary) {
      for (const file of summary.files) {
        files.push(file.file);
        if ("insertions" in file) {
          additions += file.insertions;
        }
        if ("deletions" in file) {
          deletions += file.deletions;
        }
      }
    }

    // Get first commit date
    const firstCommit = logOutput?.all[logOutput.all.length - 1];
    const createdAt = firstCommit ? new Date(firstCommit.date) : new Date();

    // Get last commit date
    const lastCommit = logOutput?.all[0];
    const updatedAt = lastCommit ? new Date(lastCommit.date) : new Date();

    prs.push({
      number: 0, // Local branch, no PR number
      title: `Local branch: ${currentBranch}`,
      body: "",
      linesAdded: additions,
      linesDeleted: deletions,
      filesChanged: files,
      createdAt,
      updatedAt,
      reviewCount: 0,
      approvedReviewCount: 0,
      lastReviewAt: null,
      isStale: false,
    });
  } catch (error) {
    // Ignore errors in local analysis
  }

  return prs;
}

// Check if file is a test file
function isTestFile(filename: string): boolean {
  const testPatterns = [
    /\.test\.[jt]sx?$/,
    /\.spec\.[jt]sx?$/,
    /__tests__\//,
    /tests?\//,
    /test\//,
    /spec\//,
    /\.test$/,
    /\.spec$/,
  ];

  return testPatterns.some((pattern) => pattern.test(filename));
}

// Check if file is a source file
function isSourceFile(filename: string): boolean {
  const sourcePatterns = [
    /^src\//,
    /^lib\//,
    /^app\//,
    /^components\//,
    /^services\//,
    /^utils\//,
    /^helpers\//,
  ];

  return sourcePatterns.some((pattern) => pattern.test(filename));
}

// Analyze PR complexity
function analyzePRComplexity(
  prs: PRInfo[],
  config: ProjectHealthConfig,
): Finding[] {
  const findings: Finding[] = [];
  const { maxLinesChanged, maxFilesChanged, reviewTimeoutDays } =
    config.modules.prComplexity;

  for (const pr of prs) {
    const linesChanged = pr.linesAdded + pr.linesDeleted;
    const now = new Date();
    const daysOpen =
      (now.getTime() - pr.createdAt.getTime()) / (1000 * 60 * 60 * 24);
    const daysSinceUpdate =
      (now.getTime() - pr.updatedAt.getTime()) / (1000 * 60 * 60 * 24);

    // LARGE_PR: PR changes > 400 lines
    if (linesChanged > maxLinesChanged) {
      findings.push({
        id: uuidv4(),
        moduleId: MODULE_ID,
        type: "LARGE_PR",
        severity: "HIGH" as Severity,
        message:
          pr.number > 0
            ? `PR #${pr.number} '${pr.title}' changes ${linesChanged} lines. Large PRs are hard to review.`
            : `Branch '${pr.title}' changes ${linesChanged} lines. Large changes are hard to review.`,
        fix: "Split into smaller PRs focusing on one concern each",
        metadata: {
          prNumber: pr.number,
          linesChanged,
          filesChanged: pr.filesChanged.length,
        },
      });
    }

    // STALE_PR: PR last updated > 14 days ago with no activity
    if (daysSinceUpdate > 14) {
      findings.push({
        id: uuidv4(),
        moduleId: MODULE_ID,
        type: "STALE_PR",
        severity: "MEDIUM" as Severity,
        message:
          pr.number > 0
            ? `PR #${pr.number} '${pr.title}' has been open for ${Math.round(daysOpen)} days without updates`
            : `Branch '${pr.title}' has been inactive for ${Math.round(daysSinceUpdate)} days`,
        fix: "Rebase on main and request review, or close if no longer needed",
        metadata: {
          prNumber: pr.number,
          daysOpen: Math.round(daysOpen),
          daysSinceUpdate: Math.round(daysSinceUpdate),
        },
      });
    }

    // MISSING_TESTS: PR changes src/ files but no test files
    const srcFiles = pr.filesChanged.filter((f) => isSourceFile(f));
    const testFiles = pr.filesChanged.filter((f) => isTestFile(f));

    if (srcFiles.length > 0 && testFiles.length === 0) {
      findings.push({
        id: uuidv4(),
        moduleId: MODULE_ID,
        type: "MISSING_TESTS",
        severity: "HIGH" as Severity,
        message:
          pr.number > 0
            ? `PR #${pr.number} changes ${srcFiles.length} source files but includes no test changes`
            : `Branch changes ${srcFiles.length} source files but includes no test changes`,
        fix: "Add tests for the changed functionality",
        metadata: {
          prNumber: pr.number,
          srcFiles: srcFiles.length,
          testFiles: testFiles.length,
        },
      });
    }

    // MISSING_DESCRIPTION: PR has body.length < 100 chars
    if (pr.body.length < 100) {
      findings.push({
        id: uuidv4(),
        moduleId: MODULE_ID,
        type: "MISSING_DESCRIPTION",
        severity: "LOW" as Severity,
        message:
          pr.number > 0
            ? `PR #${pr.number} has a very short description (${pr.body.length} chars)`
            : `Branch has a very short description (${pr.body.length} chars)`,
        fix: "Add context: what changed, why, and how to test it",
        metadata: {
          prNumber: pr.number,
          descriptionLength: pr.body.length,
        },
      });
    }

    // NO_REVIEW: PR has 0 approved reviews and is > 3 days old
    if (daysOpen > 3 && pr.approvedReviewCount === 0) {
      findings.push({
        id: uuidv4(),
        moduleId: MODULE_ID,
        type: "NO_REVIEW",
        severity: "MEDIUM" as Severity,
        message:
          pr.number > 0
            ? `PR #${pr.number} has no approvals after ${Math.round(daysOpen)} days`
            : `Branch has no approvals after ${Math.round(daysOpen)} days`,
        fix: "Request review from a team member",
        metadata: {
          prNumber: pr.number,
          daysOpen: Math.round(daysOpen),
          approvedReviews: pr.approvedReviewCount,
        },
      });
    }
  }

  return findings;
}

export async function runPrComplexityModule(
  config: ProjectHealthConfig,
): Promise<ModuleResult> {
  const startTime = Date.now();
  const findings: Finding[] = [];

  if (!config.modules.prComplexity.enabled) {
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

  try {
    // Try to get GitHub token (skip placeholders)
    const rawToken = process.env.GITHUB_TOKEN;
    const githubToken = isValidGitHubToken(rawToken) ? rawToken : undefined;
    let prs: PRInfo[] = [];
    let dataSource = "none";

    if (githubToken) {
      // Get remote info
      const remote = await getRemoteInfo(projectRoot);

      if (remote) {
        // Fetch PRs from GitHub API
        log("Fetching PRs for %s/%s", remote.owner, remote.repo);
        prs = await fetchGitHubPRs(remote.owner, remote.repo, githubToken);
        dataSource = "github_api";
      }
    } else if (rawToken) {
      log(
        "GITHUB_TOKEN appears to be a placeholder — falling back to local branch analysis",
      );
    }

    // Fallback to local branch analysis if no GitHub token or no PRs found
    if (prs.length === 0) {
      prs = await analyzeLocalBranches(projectRoot);
      dataSource = prs.length > 0 ? "local_branch" : "none";
    }

    // Analyze complexity
    const prFindings = analyzePRComplexity(prs, config);
    findings.push(...prFindings);

    const score = calculateModuleScore(findings);

    return {
      moduleId: MODULE_ID,
      moduleName: MODULE_NAME,
      score,
      status: score >= 80 ? "ok" : score >= 60 ? "warning" : "error",
      findings,
      metadata: {
        dataSource,
        prsAnalyzed: prs.length,
        largePRs: prs.filter(
          (p) =>
            p.linesAdded + p.linesDeleted >
            config.modules.prComplexity.maxLinesChanged,
        ).length,
        stalePRs: prs.filter((p) => {
          const days =
            (Date.now() - p.updatedAt.getTime()) / (1000 * 60 * 60 * 24);
          return days > 14;
        }).length,
        missingTests: prs.filter((p) => {
          const srcFiles = p.filesChanged.filter((f) => isSourceFile(f));
          const testFiles = p.filesChanged.filter((f) => isTestFile(f));
          return srcFiles.length > 0 && testFiles.length === 0;
        }).length,
        missingDescription: prs.filter((p) => p.body.length < 100).length,
        noReview: prs.filter((p) => {
          const days =
            (Date.now() - p.createdAt.getTime()) / (1000 * 60 * 60 * 24);
          return days > 3 && p.approvedReviewCount === 0;
        }).length,
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
          type: "LARGE_PR",
          severity: "CRITICAL" as Severity,
          message:
            error instanceof Error
              ? error.message
              : "PR Complexity scan failed",
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
    switch (f.type) {
      case "LARGE_PR":
        deduction += 15;
        break;
      case "STALE_PR":
        deduction += 10;
        break;
      case "MISSING_TESTS":
        deduction += 15;
        break;
      case "MISSING_DESCRIPTION":
        deduction += 3;
        break;
      case "NO_REVIEW":
        deduction += 10;
        break;
      default:
        // Use severity-based deduction for other findings
        if (f.severity === "CRITICAL") deduction += 30;
        else if (f.severity === "HIGH") deduction += 15;
        else if (f.severity === "MEDIUM") deduction += 5;
        else if (f.severity === "LOW") deduction += 2;
        break;
    }
  }

  return Math.max(0, 100 - deduction);
}

export default runPrComplexityModule;
