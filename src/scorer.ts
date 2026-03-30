// Scorer - compatibility wrapper around the shared runner scoring logic

import type { ModuleResult, ProjectHealthConfig, HealthReport, Finding } from './types/index.js';
import { DEFAULT_SCORING_WEIGHTS } from './types/index.js';
import { calculateHealthScore } from './modules/runner.js';

export const DEFAULT_WEIGHTS = { ...DEFAULT_SCORING_WEIGHTS };
export { calculateHealthScore };

// Generate top actions from findings
export function generateTopActions(findings: Finding[]): string[] {
  // Sort by severity (CRITICAL first)
  const severityOrder: Record<string, number> = {
    CRITICAL: 0,
    HIGH: 1,
    MEDIUM: 2,
    LOW: 3,
  };
  
  const sorted = [...findings].sort((a, b) => {
    const aOrder = severityOrder[a.severity] ?? 4;
    const bOrder = severityOrder[b.severity] ?? 4;
    return aOrder - bOrder;
  });
  
  // Return top 3 actions
  return sorted.slice(0, 3).map(f => f.fix || f.message);
}

// Create full health report
export function createHealthReport(
  moduleResults: ModuleResult[],
  config: ProjectHealthConfig,
  projectRoot: string
): HealthReport {
  // Collect all findings
  const findings: Finding[] = [];
  for (const result of moduleResults) {
    findings.push(...result.findings);
  }
  
  // Calculate overall score
  const score = calculateHealthScore(moduleResults, config);
  
  // Generate top actions
  const topActions = generateTopActions(findings);
  
  return {
    score,
    generatedAt: new Date().toISOString(),
    projectRoot,
    modules: moduleResults,
    findings,
    topActions,
  };
}
