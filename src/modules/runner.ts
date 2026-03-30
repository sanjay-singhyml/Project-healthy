import { ModuleResult, ModuleId, ProjectHealthConfig, HealthReport, Finding, DEFAULT_SCORING_WEIGHTS } from '../types/index.js';
import { createCacheManager } from '../cache/index.js';

// Module runner - runs all 8 modules in parallel via Promise.allSettled()
// as per RULES.md rule 13

export type ModuleRunner = (config: ProjectHealthConfig) => Promise<ModuleResult>;

const MODULE_NAMES: Record<ModuleId, string> = {
  'M-01': 'CI/CD Pipeline',
  'M-02': 'Code Quality',
  'M-03': 'Docs Freshness',
  'M-04': 'Test Flakiness',
  'M-05': 'Dependency Security',
  'M-06': 'PR Complexity',
  'M-07': 'Environment Integrity',
  'M-08': 'Build Performance',
};

export function getModuleName(moduleId: ModuleId): string {
  return MODULE_NAMES[moduleId];
}

export function getAllModuleIds(): ModuleId[] {
  return ['M-01', 'M-02', 'M-03', 'M-04', 'M-05', 'M-06', 'M-07', 'M-08'];
}

// Run all modules in parallel via Promise.allSettled()
// One failure must not block others (RULES.md rule 13)
export async function runAllModules(
  config: ProjectHealthConfig,
  modules: Map<ModuleId, ModuleRunner>
): Promise<ModuleResult[]> {
  const enabledModules = getAllModuleIds().filter(id => {
    const moduleKey = getModuleKey(id);
    const modules = config.modules as unknown as Record<string, { enabled?: boolean }>;
    return modules[moduleKey]?.enabled ?? true;
  });

  const promises = enabledModules.map(async (moduleId) => {
    const moduleRunner = modules.get(moduleId);
    if (!moduleRunner) {
      return createErrorModuleResult(moduleId, `Module ${moduleId} not registered`);
    }

    try {
      return await moduleRunner(config);
    } catch (error) {
      return createErrorModuleResult(
        moduleId,
        error instanceof Error ? error.message : String(error)
      );
    }
  });

  const results = await Promise.allSettled(promises);

  // Extract results, handling rejected promises
  return results.map((result, index) => {
    if (result.status === 'fulfilled') {
      return result.value;
    }
    // This shouldn't happen since we catch in the promise, but handle it anyway
    const fallbackId: ModuleId = `M-0${(index % 8) + 1}` as ModuleId;
    return createErrorModuleResult(
      enabledModules[index] || fallbackId,
      'Module execution failed unexpectedly'
    );
  });
}

// Run a single module by ID
export async function runSingleModule(
  moduleId: ModuleId,
  config: ProjectHealthConfig,
  modules: Map<ModuleId, ModuleRunner>
): Promise<ModuleResult> {
  const moduleRunner = modules.get(moduleId);
  
  if (!moduleRunner) {
    return createErrorModuleResult(moduleId, `Module ${moduleId} not found`);
  }

  try {
    return await moduleRunner(config);
  } catch (error) {
    return createErrorModuleResult(
      moduleId,
      error instanceof Error ? error.message : String(error)
    );
  }
}

function normalizeWeights(weights: Record<string, number>): Record<string, number> {
  const weightSum = Object.values(weights).reduce((sum, weight) => sum + weight, 0);

  if (weightSum <= 0 || Math.abs(weightSum - 100) <= 0.01) {
    return { ...weights };
  }

  const ratio = 100 / weightSum;
  const normalized: Record<string, number> = {};

  for (const [key, weight] of Object.entries(weights)) {
    normalized[key] = Math.round(weight * ratio * 100) / 100;
  }

  return normalized;
}

// Calculate overall health score from module results
// Weights must sum to 100, redistributed when module disabled
export function calculateHealthScore(
  moduleResults: ModuleResult[],
  config: ProjectHealthConfig
): number {
  const weights = {
    ...DEFAULT_SCORING_WEIGHTS,
    ...(config.scoring?.weights ?? {}),
  };
  const enabledWeights: Record<string, number> = {};
  const modulesConfig =
    config.modules as unknown as Record<string, { enabled?: boolean }>;

  for (const [key, weight] of Object.entries(weights)) {
    if (modulesConfig[key]?.enabled !== false) {
      enabledWeights[key] = weight;
    }
  }

  if (Object.keys(enabledWeights).length === 0) {
    return 0;
  }
  
  const normalizedWeights = normalizeWeights(enabledWeights);

  // Calculate weighted score
  let totalScore = 0;
  let totalWeight = 0;

  for (const result of moduleResults) {
    const moduleKey = getModuleKey(result.moduleId);
    const weight = normalizedWeights[moduleKey] ?? 0;
    
    if (weight > 0) {
      totalScore += result.score * weight;
      totalWeight += weight;
    }
  }

  // Return integer in [0, 100] as per RULES.md rule 23
  return Math.round(totalWeight > 0 ? totalScore / totalWeight : 0);
}

// Generate top actions from findings
export function generateTopActions(findings: Finding[]): string[] {
  // Sort by severity (CRITICAL first)
  const sorted = [...findings].sort((a, b) => {
    const severityOrder = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
    return severityOrder[a.severity] - severityOrder[b.severity];
  });

  const seen = new Set<string>();
  const actions: string[] = [];

  for (const finding of sorted) {
    const action = finding.fix || finding.message;
    if (seen.has(action)) {
      continue;
    }

    seen.add(action);
    actions.push(action);

    if (actions.length === 3) {
      break;
    }
  }

  return actions;
}

// Create full health report
export async function createHealthReport(
  moduleResults: ModuleResult[],
  config: ProjectHealthConfig,
  projectRoot: string
): Promise<HealthReport> {
  // Collect all findings
  const findings: Finding[] = [];
  for (const result of moduleResults) {
    findings.push(...result.findings);
  }

  // Calculate overall score
  const score = calculateHealthScore(moduleResults, config);

  // Generate top actions
  const topActions = generateTopActions(findings);

  const report: HealthReport = {
    score,
    generatedAt: new Date().toISOString(),
    projectRoot,
    modules: moduleResults,
    findings,
    topActions,
  };

  // Cache the report
  const cache = createCacheManager(projectRoot);
  await cache.saveLastScan(report);

  return report;
}

// Helper to convert module ID to config key
function getModuleKey(moduleId: ModuleId): string {
  const mapping: Record<ModuleId, string> = {
    'M-01': 'cicd',
    'M-02': 'quality',
    'M-03': 'docs',
    'M-04': 'flakiness',
    'M-05': 'security',
    'M-06': 'prComplexity',
    'M-07': 'env',
    'M-08': 'buildPerf',
  };
  return mapping[moduleId];
}

// Create error module result
function createErrorModuleResult(moduleId: ModuleId, errorMessage: string): ModuleResult {
  return {
    moduleId,
    moduleName: getModuleName(moduleId),
    score: 0,
    status: 'error',
    findings: [{
      id: `error-${moduleId}`,
      moduleId,
      type: 'BUILD_BOTTLENECK',
      severity: 'CRITICAL',
      message: errorMessage,
      metadata: {},
    }],
    metadata: { error: errorMessage },
    durationMs: 0,
  };
}
