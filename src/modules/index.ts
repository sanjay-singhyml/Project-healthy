// Export all analysis modules
// Each module runs in parallel via Promise.allSettled() as per RULES.md rule 13

import type { ModuleId, ModuleRunner } from '../types/index.js';

// Import all modules
import { runCicdModule } from './m01-cicd/index.js';
import { runQualityModule } from './m02-quality/index.js';
import { runDocsModule } from './m03-docs/index.js';
import { runFlakinessModule } from './m04-flakiness/index.js';
import { runSecurityModule } from './m05-security/index.js';
import { runPrComplexityModule } from './m06-prcomplexity/index.js';
import { runEnvModule } from './m07-env/index.js';
import { runBuildPerfModule } from './m08-buildperf/index.js';

export { runAllModules, runSingleModule, createHealthReport } from './runner.js';
export { getModuleName, getAllModuleIds } from './runner.js';

// Map of module ID to runner function
export const modules: Map<ModuleId, ModuleRunner> = new Map([
  ['M-01', runCicdModule],
  ['M-02', runQualityModule],
  ['M-03', runDocsModule],
  ['M-04', runFlakinessModule],
  ['M-05', runSecurityModule],
  ['M-06', runPrComplexityModule],
  ['M-07', runEnvModule],
  ['M-08', runBuildPerfModule],
]);

// Export individual modules for direct imports
export {
  runCicdModule,
  runQualityModule,
  runDocsModule,
  runFlakinessModule,
  runSecurityModule,
  runPrComplexityModule,
  runEnvModule,
  runBuildPerfModule,
};

// Module metadata
export const MODULE_METADATA: Record<ModuleId, { name: string; description: string }> = {
  'M-01': { name: 'CI/CD Pipeline', description: 'Analyzes CI/CD pipeline configuration and build history' },
  'M-02': { name: 'Code Quality', description: 'Runs linters, complexity analysis, and dead code detection' },
  'M-03': { name: 'Docs Freshness', description: 'Checks documentation staleness against source changes' },
  'M-04': { name: 'Test Flakiness', description: 'Analyzes test pass rates and identifies flaky tests' },
  'M-05': { name: 'Dependency Security', description: 'Scans for CVEs and risky licenses' },
  'M-06': { name: 'PR Complexity', description: 'Evaluates open PR size and review turnaround' },
  'M-07': { name: 'Environment Integrity', description: 'Validates .env files and secret exposure' },
  'M-08': { name: 'Build Performance', description: 'Analyzes build times and cache effectiveness' },
};
