// Core Data Models for project-health
// These must match exactly what's defined in CONTEXT.md

export type ModuleId =
  | "M-01"
  | "M-02"
  | "M-03"
  | "M-04"
  | "M-05"
  | "M-06"
  | "M-07"
  | "M-08";

// Module runner function type
export type ModuleRunner = (
  config: ProjectHealthConfig,
) => Promise<ModuleResult>;

export type FindingType =
  | "SLOW_JOB"
  | "MISSING_CACHE"
  | "PARALLEL_OPPORTUNITY"
  | "ALWAYS_FAILING_STAGE"
  | "HIGH_COMPLEXITY"
  | "TOO_MANY_PARAMETERS"
  | "DUPLICATE_CODE"
  | "LARGE_FILE"
  | "DEAD_EXPORT"
  | "LINT_ERROR"
  | "STALE_DOC"
  | "SEMANTIC_DRIFT"
  | "MISSING_JSDOC"
  | "MISSING_CHANGELOG"
  | "API_DOC_DRIFT"
  | "FLAKY_TEST"
  | "CVE"
  | "LICENSE_RISK"
  | "OUTDATED_PACKAGE"
  | "LARGE_PR"
  | "STALE_PR"
  | "CROSS_MODULE_PR"
  | "MISSING_TESTS"
  | "MISSING_DESCRIPTION"
  | "NO_REVIEW"
  | "ENV_DRIFT"
  | "SECRET_LEAK"
  | "ENV_EXPOSED"
  | "DOCKER_MISMATCH"
  | "BUILD_BOTTLENECK"
  | "UNCACHED_INSTALL"
  | "MISSING_INCREMENTAL_TS"
  | "CACHE_MISS"
  | "SLOW_PIPELINE"
  | "NO_PARALLELISM"
  | "LARGE_BUNDLE"
  | "LARGE_CHUNK"
  | "STALE_BUILD"
  | "HEAVY_DEPENDENCIES"
  | "DEVDEP_RATIO"
  | "TS_NOT_STRICT";

export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
export type ModuleStatus = "ok" | "warning" | "error";

export interface Finding {
  id: string;
  moduleId: ModuleId;
  type: FindingType;
  severity: Severity;
  file?: string;
  line?: number;
  message: string;
  fix?: string;
  aiAnalysis?: string;
  metadata: Record<string, unknown>;
}

export interface ModuleResult {
  moduleId: ModuleId;
  moduleName: string;
  score: number;
  status: ModuleStatus;
  findings: Finding[];
  metadata: Record<string, unknown>;
  durationMs: number;
}

export interface HealthReport {
  score: number;
  generatedAt: string;
  projectRoot: string;
  modules: ModuleResult[];
  findings: Finding[];
  topActions: string[];
}

export interface Vulnerability {
  severity: Severity;
  package: string;
  version: string;
  cveId?: string;
  fixVersion?: string;
  license?: string;
}

export interface AstSymbol {
  file: string;
  line: number;
  kind: "class" | "function" | "interface" | "type" | "const";
}

export interface AstIndex {
  [symbolName: string]: AstSymbol;
}

export interface DocsIndex {
  [sourceFilePath: string]: string[];
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatSession {
  id: string;
  createdAt: string;
  messages: ChatMessage[];
}

export interface ScanContext {
  projectRoot: string;
  astIndex: AstIndex;
  config: ProjectHealthConfig;
  gitRemote?: string;
}

// Module configuration types
export interface CicdModuleConfig {
  enabled: boolean;
  slowJobThresholdMinutes: number;
  failureRateThreshold: number;
}

export interface QualityModuleConfig {
  enabled: boolean;
  complexityThreshold: number;
  duplicateLineMin: number;
}

export interface DocsModuleConfig {
  enabled: boolean;
  stalenessDays: number;
  aiSemanticCheck: boolean;
}

export interface FlakinessModuleConfig {
  enabled: boolean;
  lookbackRuns: number;
  passRateThreshold: number;
}

export interface SecurityModuleConfig {
  enabled: boolean;
  snykToken?: string;
  blockedLicenses: string[];
}

export interface PrComplexityModuleConfig {
  enabled: boolean;
  maxLinesChanged: number;
  maxFilesChanged: number;
  reviewTimeoutDays: number;
}

export interface EnvModuleConfig {
  enabled: boolean;
  secretPatterns: string[];
}

export interface BuildPerfModuleConfig {
  enabled: boolean;
  bottleneckThresholdPct: number;
  maxBuildTimeMs: number;
}

export interface ModulesConfig {
  cicd: CicdModuleConfig;
  quality: QualityModuleConfig;
  docs: DocsModuleConfig;
  flakiness: FlakinessModuleConfig;
  security: SecurityModuleConfig;
  prComplexity: PrComplexityModuleConfig;
  env: EnvModuleConfig;
  buildPerf: BuildPerfModuleConfig;
}

export interface ScoringConfig {
  weights: Record<string, number>;
  failUnder: number;
}

export interface DocUpdaterConfig {
  mode: "pr" | "direct";
  githubToken?: string;
}

export interface ProxyConfig {
  url: string;
  timeout: number;
}

export interface ProjectHealthConfig {
  proxy: ProxyConfig;
  modules: ModulesConfig;
  scoring: ScoringConfig;
  docUpdater: DocUpdaterConfig;
}

// Score band types
export type ScoreBand =
  | "EXCELLENT"
  | "GOOD"
  | "MODERATE"
  | "HIGH_RISK"
  | "CRITICAL";

export const SCORE_BANDS: Record<
  ScoreBand,
  { min: number; max: number; color: string }
> = {
  EXCELLENT: { min: 90, max: 100, color: "green" },
  GOOD: { min: 75, max: 89, color: "blue" },
  MODERATE: { min: 60, max: 74, color: "yellow" },
  HIGH_RISK: { min: 40, max: 59, color: "amber" },
  CRITICAL: { min: 0, max: 39, color: "red" },
};

export const DEFAULT_SCORING_WEIGHTS: Record<string, number> = {
  security: 20,
  quality: 18,
  cicd: 15,
  flakiness: 14,
  env: 13,
  buildPerf: 10,
  docs: 6,
  prComplexity: 4,
};

export function getScoreBand(score: number): ScoreBand {
  if (score >= 90) return "EXCELLENT";
  if (score >= 75) return "GOOD";
  if (score >= 60) return "MODERATE";
  if (score >= 40) return "HIGH_RISK";
  return "CRITICAL";
}
