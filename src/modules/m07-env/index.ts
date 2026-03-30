// M-07: Environment Integrity Module
// Diffs .env.example vs .env keys
// Scans git history for secret patterns (regex only - no AI)
// Checks Dockerfile FROM vs CI image consistency
// Validates .env in .gitignore

import {
  ModuleResult,
  ModuleId,
  ProjectHealthConfig,
  Finding,
  Severity,
} from "../../types/index.js";
import { v4 as uuidv4 } from "uuid";
import { simpleGit } from "simple-git";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { execa } from "execa";
import { shouldIgnorePath, IGNORED_DIRS } from "../../utils/ignore.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("ph:env");

export const MODULE_ID: ModuleId = "M-07";
export const MODULE_NAME = "Environment Integrity";

// Secret patterns for detection (RULES.md rule 21: regex only)
// IMPORTANT: Use specific patterns to avoid false positives in build artifacts
const SECRET_PATTERNS = [
  // AWS Access Key ID - specific format: AKIA + 16 alphanumeric chars
  {
    name: "AWS_ACCESS_KEY_ID",
    pattern: /AKIA[0-9A-Z]{16}/,
    requireEntropy: false,
  },
  // AWS Secret Access Key - very specific base64 AWS format (only when preceded by AWS prefix in context)
  {
    name: "AWS_SECRET_ACCESS_KEY",
    pattern:
      /(?:aws_secret_access_key|aws_secret_key|secret_key)["']?\s*[:=]\s*["']?[A-Za-z0-9/+=]{40}["']?/i,
  },
  // GitHub Token - ghp_ or gho_ or ghg_ prefix
  {
    name: "GITHUB_TOKEN",
    pattern: /gh[pougs]_[A-Za-z0-9_]{36,}/,
    requireEntropy: false,
  },
  // GitLab Token - glpat- prefix
  {
    name: "GITLAB_TOKEN",
    pattern: /glpat-[A-Za-z0-9\-]{20,}/,
    requireEntropy: false,
  },
  // Private Key - specific header/footer
  {
    name: "PRIVATE_KEY",
    pattern: /-----BEGIN (RSA|EC|DSA|OPENSSH) PRIVATE KEY-----/,
    requireEntropy: false,
  },
  // Generic API Key - more specific context required
  {
    name: "API_KEY",
    pattern: /(?:api[_-]?key|apikey)["']?\s*[:=]\s*["'][A-Za-z0-9_-]{32,}["']/i,
  },
  // Generic Password - more specific context required
  {
    name: "PASSWORD",
    pattern: /(?:password|passwd|pwd)["']?\s*[:=]\s*["'][^\s"']{8,}["']/i,
  },
  // Generic Secret - more specific context required
  {
    name: "SECRET",
    pattern: /(?:secret|secret_key)["']?\s*[:=]\s*["'][A-Za-z0-9_-]{32,}["']/i,
  },
  // Generic Token - more specific context required
  {
    name: "TOKEN",
    pattern:
      /(?:token|auth_token|access_token)["']?\s*[:=]\s*["'][A-Za-z0-9_-]{32,}["']/i,
  },
  // Stripe Key
  {
    name: "STRIPE_KEY",
    pattern: /sk_live_[A-Za-z0-9]{24,}/,
    requireEntropy: false,
  },
  // Slack Token
  {
    name: "SLACK_TOKEN",
    pattern: /xox[baprs]-[0-9]{10,}/,
    requireEntropy: false,
  },
];

const SECRET_ENTROPY_THRESHOLD = 4.5;
const MIN_SECRET_LENGTH = 20;
const HIGH_ENTROPY_TOKEN = /[A-Za-z0-9_+/=-]{20,}/g;
const PLACEHOLDER_PATTERNS = [
  /changeme/i,
  /example/i,
  /sample/i,
  /placeholder/i,
  /your[_-]?/i,
  /dummy/i,
  /test/i,
  /fake/i,
  /^x+$/i,
  /^a+$/i,
  /^0+$/,
];

// Directories to exclude from secret scanning — uses shared ignore list
const EXCLUDED_DIRS = IGNORED_DIRS;

// File extensions to exclude from secret scanning (compiled/bundled)
const EXCLUDED_EXTENSIONS = [
  ".map", // Source maps
  ".min.js", // Minified JS
  ".bundle.js", // Bundled JS
  ".jsbundle", // React Native bundle
  ".wasm", // WebAssembly
  ".ico", // Icons
  ".png", // Images
  ".jpg", // Images
  ".jpeg", // Images
  ".gif", // Images
  ".svg", // SVG images
  ".woff", // Fonts
  ".woff2", // Fonts
  ".ttf", // Fonts
  ".eot", // Fonts
  ".pdf", // Documents
  ".zip", // Archives
  ".tar", // Archives
  ".gz", // Archives
  ".exe", // Executables
  ".dll", // Windows libraries
  ".so", // Linux libraries
  ".dylib", // macOS libraries
  ".md", // Documentation often contains example secret patterns
  ".mdx", // Documentation often contains example secret patterns
  ".rst", // Documentation often contains example secret patterns
  ".adoc", // Documentation often contains example secret patterns
  ".txt", // Notes and examples often contain detector regex references
];

// File name patterns to exclude (test files, mocks, fixtures)
const EXCLUDED_FILE_PATTERNS = [
  ".test.",
  ".spec.",
  "-test.",
  "-spec.",
  ".mock.",
  ".fixture.",
  "acceptance-runner",
  "manual-test",
  "test-helper",
  "mock-data",
  "fixture",
  "repomix-output",
  "project-context-",
  "scan_output",
  "html_output",
  "test-report",
];

// Check if file should be scanned
function shouldScanFile(filePath: string): boolean {
  const lowerPath = filePath.toLowerCase();
  const normalizedPath = lowerPath.replace(/\\/g, "/");
  const fileName = normalizedPath.split("/").pop() || "";

  // Check extension exclusions
  for (const ext of EXCLUDED_EXTENSIONS) {
    if (lowerPath.endsWith(ext)) {
      return false;
    }
  }

  // Check for minified file patterns in name
  if (
    lowerPath.includes(".min.") ||
    lowerPath.includes(".bundle.") ||
    lowerPath.includes("chunk.")
  ) {
    return false;
  }

  // Check for test file patterns
  for (const pattern of EXCLUDED_FILE_PATTERNS) {
    if (fileName.includes(pattern)) {
      return false;
    }
  }

  // Check for source map references in file content (not actual secrets)
  return true;
}

function getRelativeProjectPath(projectRoot: string, fullPath: string): string {
  return relative(projectRoot, fullPath).replace(/\\/g, "/");
}

function shouldScanProjectFile(projectRoot: string, fullPath: string): boolean {
  const relativePath = getRelativeProjectPath(projectRoot, fullPath);
  if (!relativePath || relativePath.startsWith("..")) {
    return false;
  }

  return !shouldIgnorePath(relativePath) && shouldScanFile(relativePath);
}

function normalizeReportedFilePath(
  projectRoot: string,
  filePath?: string,
): string | undefined {
  if (!filePath) {
    return undefined;
  }

  const normalized = filePath.replace(/\\/g, "/").trim();
  if (!normalized) {
    return undefined;
  }

  const resolvedPath =
    normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)
      ? normalized
      : join(projectRoot, normalized);
  const relativePath = getRelativeProjectPath(projectRoot, resolvedPath);

  if (!relativePath || relativePath.startsWith("..")) {
    return undefined;
  }

  return relativePath;
}

function shouldKeepDetectedFile(projectRoot: string, filePath?: string): boolean {
  if (!filePath) {
    return true;
  }

  const relativePath = normalizeReportedFilePath(projectRoot, filePath);
  if (!relativePath) {
    return false;
  }

  if (shouldIgnorePath(relativePath) || !shouldScanFile(relativePath)) {
    return false;
  }

  if (isLocalEnvFile(relativePath) && isEnvInGitignore(projectRoot)) {
    return false;
  }

  return true;
}

function dedupeSecretFindings(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  const deduped: Finding[] = [];

  for (const finding of findings) {
    const metadata = finding.metadata as Record<string, unknown>;
    const key = [
      finding.type,
      String(metadata.pattern ?? ""),
      String(metadata.commit ?? ""),
      finding.file ?? "",
      finding.message,
    ].join("::");

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(finding);
  }

  return deduped;
}

function isLocalEnvFile(relativePath: string): boolean {
  const name = basename(relativePath).toLowerCase();
  return name === ".env" || name.startsWith(".env.");
}

// Check if directory should be walked
function shouldWalkDir(dirName: string): boolean {
  return !EXCLUDED_DIRS.has(dirName);
}

// Read .env file and extract keys
function readEnvKeys(envPath: string): Set<string> {
  const keys = new Set<string>();

  if (!existsSync(envPath)) {
    return keys;
  }

  try {
    const content = readFileSync(envPath, "utf-8");
    const lines = content.split("\n");

    for (const line of lines) {
      const trimmed = line.trim();
      // Skip comments and empty lines
      if (trimmed.startsWith("#") || trimmed === "") {
        continue;
      }

      // Extract key (before =)
      const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
      if (match && match[1]) {
        keys.add(match[1]);
      }
    }
  } catch (err) {
    log("Error in readEnvKeys: %O", err);
    // Ignore read errors
  }

  return keys;
}

function shannonEntropy(value: string): number {
  if (value.length === 0) {
    return 0;
  }

  const frequencies = new Map<string, number>();
  for (const char of value) {
    frequencies.set(char, (frequencies.get(char) ?? 0) + 1);
  }

  let entropy = 0;
  for (const count of frequencies.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }

  return entropy;
}

function normalizeCandidate(candidate: string): string {
  return candidate.replace(/^['"`]+|['"`]+$/g, "").trim();
}

function extractSecretCandidates(content: string, pattern: RegExp): string[] {
  const globalFlags = pattern.flags.includes("g")
    ? pattern.flags
    : `${pattern.flags}g`;
  const regex = new RegExp(pattern.source, globalFlags);
  const candidates = new Set<string>();

  for (const match of content.matchAll(regex)) {
    const matchedText = match[0];
    const quotedValueMatch = matchedText.match(/["'`](.{8,})["'`]/);
    if (quotedValueMatch?.[1]) {
      candidates.add(normalizeCandidate(quotedValueMatch[1]));
    }

    const longTokenMatches = matchedText.match(HIGH_ENTROPY_TOKEN) ?? [];
    for (const token of longTokenMatches) {
      candidates.add(normalizeCandidate(token));
    }

    if (candidates.size === 0) {
      candidates.add(normalizeCandidate(matchedText));
    }
  }

  return [...candidates].filter(Boolean);
}

function looksLikePlaceholder(candidate: string): boolean {
  return PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(candidate));
}

function isEntropyQualifiedSecret(
  patternName: string,
  content: string,
): {
  matched: boolean;
  candidate?: string;
  entropy?: number;
} {
  const patternConfig = SECRET_PATTERNS.find(
    (entry) => entry.name === patternName,
  );
  if (!patternConfig) {
    return { matched: false };
  }

  if (patternConfig.requireEntropy === false) {
    return {
      matched: patternConfig.pattern.test(content),
    };
  }

  const candidates = extractSecretCandidates(content, patternConfig.pattern);
  if (candidates.length === 0 && patternConfig.pattern.test(content)) {
    return { matched: true };
  }

  for (const candidate of candidates) {
    if (looksLikePlaceholder(candidate)) {
      continue;
    }

    if (patternName === "PRIVATE_KEY") {
      return { matched: true, candidate, entropy: shannonEntropy(candidate) };
    }

    if (candidate.length < MIN_SECRET_LENGTH) {
      continue;
    }

    const entropy = shannonEntropy(candidate);
    if (entropy >= SECRET_ENTROPY_THRESHOLD) {
      return { matched: true, candidate, entropy };
    }
  }

  return { matched: false };
}

async function scanWithGitleaks(projectRoot: string): Promise<Finding[]> {
  try {
    const { stdout } = await execa(
      "gitleaks",
      [
        "detect",
        "--no-banner",
        "--source",
        projectRoot,
        "--report-format",
        "json",
        "--report-path",
        "-",
        "--redact",
      ],
      {
        reject: false,
        windowsHide: true,
        cwd: projectRoot,
      },
    );

    const parsed = JSON.parse(stdout || "[]");
    if (!Array.isArray(parsed)) {
      return [];
    }

    const findings: Finding[] = [];
    for (const entry of parsed) {
      const rawFile = typeof entry.File === "string" ? entry.File : undefined;
      if (!shouldKeepDetectedFile(projectRoot, rawFile)) {
        continue;
      }

      findings.push({
        id: uuidv4(),
        moduleId: MODULE_ID,
        type: "SECRET_LEAK",
        severity: "CRITICAL" as Severity,
        message: `Potential secret detected by gitleaks${typeof entry.RuleID === "string" ? ` (${entry.RuleID})` : ""}`,
        fix: "Remove the secret from git history using git-filter-repo or BFG Repo-Cleaner",
        file: normalizeReportedFilePath(projectRoot, rawFile),
        metadata: {
          detector: "gitleaks",
          pattern: typeof entry.RuleID === "string" ? entry.RuleID : "gitleaks",
          commit: typeof entry.Commit === "string" ? entry.Commit : "WORKTREE",
        },
      });
    }

    return dedupeSecretFindings(findings);
  } catch (err) {
    log("Error in scanWithGitleaks: %O", err);
    return [];
  }
}

async function scanWithDetectSecrets(projectRoot: string): Promise<Finding[]> {
  try {
    const { stdout } = await execa(
      "detect-secrets",
      ["scan", "--all-files", projectRoot],
      {
        reject: false,
        windowsHide: true,
        cwd: projectRoot,
      },
    );

    const parsed = JSON.parse(stdout || "{}") as {
      results?: Record<string, Array<Record<string, unknown>>>;
    };
    if (!parsed.results) {
      return [];
    }

    const findings: Finding[] = [];
    for (const [file, entries] of Object.entries(parsed.results)) {
      for (const entry of entries) {
        if (!shouldKeepDetectedFile(projectRoot, file)) {
          continue;
        }

        findings.push({
          id: uuidv4(),
          moduleId: MODULE_ID,
          type: "SECRET_LEAK",
          severity: "CRITICAL" as Severity,
          message: `Potential secret detected by detect-secrets${typeof entry.type === "string" ? ` (${entry.type})` : ""}`,
          fix: "Remove the secret from git history using git-filter-repo or BFG Repo-Cleaner",
          file: normalizeReportedFilePath(projectRoot, file),
          metadata: {
            detector: "detect-secrets",
            pattern:
              typeof entry.type === "string" ? entry.type : "detect-secrets",
            commit: "WORKTREE",
          },
        });
      }
    }

    return dedupeSecretFindings(findings);
  } catch (err) {
    log("Error in scanWithDetectSecrets: %O", err);
    return [];
  }
}

async function scanWithExternalSecretTools(
  projectRoot: string,
): Promise<Finding[]> {
  const gitleaksFindings = await scanWithGitleaks(projectRoot);
  if (gitleaksFindings.length > 0) {
    return gitleaksFindings;
  }

  return scanWithDetectSecrets(projectRoot);
}

function scanWorkingTreeForSecrets(projectRoot: string): Finding[] {
  const findings: Finding[] = [];

  const walk = (dir: string): void => {
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch (err) {
      log("Error in scanWorkingTreeForSecrets walk readdirSync: %O", err);
      return;
    }

    for (const entry of entries) {
      if (!shouldWalkDir(entry)) {
        continue;
      }

      const fullPath = join(dir, entry);
      let stat;
      try {
        stat = statSync(fullPath);
      } catch (err) {
        log("Error in scanWorkingTreeForSecrets walk statSync: %O", err);
        continue;
      }

      if (stat.isDirectory()) {
        walk(fullPath);
        continue;
      }

      if (!shouldScanProjectFile(projectRoot, fullPath)) {
        continue;
      }

      const relativeFile = getRelativeProjectPath(projectRoot, fullPath);
      if (isLocalEnvFile(relativeFile) && isEnvInGitignore(projectRoot)) {
        continue;
      }

      let content = "";
      try {
        content = readFileSync(fullPath, "utf-8");
      } catch (err) {
        log("Error in scanWorkingTreeForSecrets walk readFileSync: %O", err);
        continue;
      }

      for (const { name } of SECRET_PATTERNS) {
        const matched = isEntropyQualifiedSecret(name, content);
        if (matched.matched) {
          findings.push({
            id: uuidv4(),
            moduleId: MODULE_ID,
            type: "SECRET_LEAK",
            severity: "CRITICAL" as Severity,
            message: `Potential secret pattern "${name}" found in working tree`,
            fix: `Remove the secret from git history using git-filter-repo or BFG Repo-Cleaner`,
            file: relativeFile,
            metadata: {
              pattern: name,
              commit: "WORKTREE",
              entropy: matched.entropy,
              candidatePreview: matched.candidate?.slice(0, 8),
            },
          });
          break;
        }
      }
    }
  };

  walk(projectRoot);
  return findings;
}

// Read .gitignore and check if .env is present
function isEnvInGitignore(projectRoot: string): boolean {
  const gitignorePath = join(projectRoot, ".gitignore");

  if (!existsSync(gitignorePath)) {
    return false;
  }

  try {
    const content = readFileSync(gitignorePath, "utf-8");
    const lines = content.split("\n");

    for (const line of lines) {
      const trimmed = line.trim();
      // Skip comments and empty lines
      if (trimmed.startsWith("#") || trimmed === "") {
        continue;
      }

      // Check for .env or .env*
      if (trimmed === ".env" || trimmed.startsWith(".env")) {
        return true;
      }
    }
  } catch (err) {
    log("Error in isEnvInGitignore: %O", err);
    // Ignore read errors
  }

  return false;
}

// Scan git history for secrets (RULES.md rule 21: regex only)
async function scanGitHistoryForSecrets(
  projectRoot: string,
): Promise<Finding[]> {
  const findings: Finding[] = [];
  const git = simpleGit(projectRoot);
  const seen = new Set<string>();

  const pushSecretFinding = (
    patternName: string,
    commit: string,
    file?: string,
  ): void => {
    const normalizedFile = normalizeReportedFilePath(projectRoot, file);
    const key = [patternName, commit, normalizedFile ?? ""].join("::");
    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    findings.push({
      id: uuidv4(),
      moduleId: MODULE_ID,
      type: "SECRET_LEAK",
      severity: "CRITICAL" as Severity,
      message: `Potential secret pattern "${patternName}" found in git history`,
      fix: `Remove the secret from git history using git-filter-repo or BFG Repo-Cleaner`,
      file: normalizedFile,
      metadata: {
        pattern: patternName,
        commit,
      },
    });
  };

  try {
    // Get last 100 commits worth of file changes
    const gitLog = await git.log({ maxCount: 100 });

    for (const commit of gitLog.all) {
      // Get the full diff for this commit (works for root commits too)
      const files = await git
        .raw([
          "diff-tree",
          "--root",
          "--no-commit-id",
          "--name-only",
          "-r",
          commit.hash,
        ])
        .catch(() => "");
      const fileList = files
        .split("\n")
        .map((file) => file.trim())
        .filter(Boolean);

      for (const file of fileList) {
        if (shouldIgnorePath(file) || !shouldScanFile(file)) {
          continue;
        }

        const content = await git
          .raw(["show", `${commit.hash}:${file}`])
          .catch(() => "");
        for (const { name } of SECRET_PATTERNS) {
          if (isEntropyQualifiedSecret(name, content).matched) {
            pushSecretFinding(name, commit.hash, file);
            break;
          }
        }
      }
    }
  } catch (err) {
    log("Error in scanGitHistoryForSecrets: %O", err);
    // Git history scan failed - not a critical error
  }

  return dedupeSecretFindings(findings);
}

// Check Dockerfile consistency with CI
async function checkDockerfileConsistency(
  projectRoot: string,
): Promise<Finding | null> {
  const dockerfilePath = join(projectRoot, "Dockerfile");

  if (!existsSync(dockerfilePath)) {
    return null;
  }

  try {
    const content = readFileSync(dockerfilePath, "utf-8");

    // Check for FROM statement
    const fromMatch = content.match(/^FROM\s+([^\s]+)/m);
    if (!fromMatch) {
      return null;
    }

    const baseImage = fromMatch[1];

    // Check for common issues
    if (baseImage && baseImage.includes("latest")) {
      return {
        id: uuidv4(),
        moduleId: MODULE_ID,
        type: "ENV_DRIFT",
        severity: "MEDIUM" as Severity,
        message: `Dockerfile uses "latest" tag: ${baseImage}`,
        fix: "Use specific version tags for reproducibility",
        metadata: { baseImage },
      };
    }
  } catch (err) {
    log("Error in checkDockerfileConsistency: %O", err);
    // Ignore errors
  }

  return null;
}

export async function runEnvModule(
  config: ProjectHealthConfig,
): Promise<ModuleResult> {
  const startTime = Date.now();
  const findings: Finding[] = [];

  if (!config.modules.env.enabled) {
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
    // P2-TC04: Check .env vs .env.example
    const envPath = join(projectRoot, ".env");
    const envExamplePath = join(projectRoot, ".env.example");

    const envKeys = readEnvKeys(envPath);
    const envExampleKeys = readEnvKeys(envExamplePath);

    // Check for missing keys in .env
    for (const key of envExampleKeys) {
      if (!envKeys.has(key)) {
        findings.push({
          id: uuidv4(),
          moduleId: MODULE_ID,
          type: "ENV_DRIFT",
          severity: "HIGH" as Severity,
          message: `Key "${key}" is in .env.example but missing from .env`,
          fix: `Add ${key} to your .env file`,
          metadata: { missingKey: key },
        });
      }
    }

    // Check for extra keys in .env (warnings only)
    for (const key of envKeys) {
      // Ensure we don't flag comments or empty lines
      if (
        !envExampleKeys.has(key) &&
        key.trim().length > 0 &&
        !key.startsWith("#")
      ) {
        findings.push({
          id: uuidv4(),
          moduleId: MODULE_ID,
          type: "ENV_DRIFT",
          severity: "LOW" as Severity,
          message: `Key "${key}" is in .env but not in .env.example`,
          fix: `Add ${key} to your .env.example file`,
          metadata: { extraKey: key },
        });
      }
    }

    // P2-TC06: Check .env in .gitignore
    const envInGitignore = isEnvInGitignore(projectRoot);
    if (!envInGitignore && envKeys.size > 0) {
      findings.push({
        id: uuidv4(),
        moduleId: MODULE_ID,
        type: "ENV_EXPOSED",
        severity: "HIGH" as Severity,
        message: ".env file is not in .gitignore - risk of committing secrets",
        fix: 'Add ".env" to .gitignore',
        metadata: {},
      });
    }

    // Prefer external detectors when installed, otherwise fall back to entropy-gated regex scan.
    const externalSecretFindings =
      await scanWithExternalSecretTools(projectRoot);
    const fallbackSecretFindings =
      externalSecretFindings.length > 0
        ? []
        : dedupeSecretFindings([
            ...(await scanGitHistoryForSecrets(projectRoot)),
            ...scanWorkingTreeForSecrets(projectRoot),
          ]);
    const secretFindings =
      externalSecretFindings.length > 0
        ? externalSecretFindings
        : fallbackSecretFindings;
    findings.push(...secretFindings);

    // Check Dockerfile consistency
    const dockerfileFinding = await checkDockerfileConsistency(projectRoot);
    if (dockerfileFinding) {
      findings.push(dockerfileFinding);
    }

    // Calculate score
    const score = calculateModuleScore(findings);

    return {
      moduleId: MODULE_ID,
      moduleName: MODULE_NAME,
      score,
      status: score >= 80 ? "ok" : score >= 60 ? "warning" : "error",
      findings,
      metadata: {
        envKeys: envKeys.size,
        exampleKeys: envExampleKeys.size,
        secretsFound: secretFindings.length,
        dockerfileIssues: dockerfileFinding ? 1 : 0,
        secretScan: {
          entropyThreshold: SECRET_ENTROPY_THRESHOLD,
          detector:
            externalSecretFindings.length > 0
              ? (externalSecretFindings[0]?.metadata?.detector ?? "external")
              : "regex-fallback",
        },
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
          type: "ENV_DRIFT",
          severity: "CRITICAL" as Severity,
          message:
            error instanceof Error ? error.message : "Environment scan failed",
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

  const criticalCount = findings.filter(
    (f) => f.severity === "CRITICAL",
  ).length;
  const highCount = findings.filter((f) => f.severity === "HIGH").length;
  const mediumCount = findings.filter((f) => f.severity === "MEDIUM").length;
  const lowCount = findings.filter((f) => f.severity === "LOW").length;

  // Critical secrets in git history = score 0
  if (criticalCount > 0) return 0;

  const deduction = highCount * 25 + mediumCount * 10 + lowCount * 5;
  return Math.max(0, 100 - deduction);
}

export default runEnvModule;
