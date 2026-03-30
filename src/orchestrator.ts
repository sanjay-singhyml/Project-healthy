 // Orchestrator - runs modules in parallel via Promise.allSettled()
// As per RULES.md rule 13

import type { ModuleId, ModuleRunner, ModuleResult, ProjectHealthConfig } from './types/index.js';

export type { ModuleRunner };

// Map of all available modules
const moduleRegistry: Map<ModuleId, ModuleRunner> = new Map();

// Register a module
export function registerModule(id: ModuleId, runner: ModuleRunner): void {
  moduleRegistry.set(id, runner);
}

// Get all registered module IDs
export function getRegisteredModules(): ModuleId[] {
  return Array.from(moduleRegistry.keys());
}

// Get module runner by ID
export function getModule(id: ModuleId): ModuleRunner | undefined {
  return moduleRegistry.get(id);
}

// Orchestrator - runs selected modules in parallel
export class Orchestrator {
  private config: ProjectHealthConfig;
  
  constructor(config: ProjectHealthConfig) {
    this.config = config;
  }
  
  // Run all enabled modules in parallel via Promise.allSettled()
  // One failure must not block others (RULES.md rule 13)
  async runAllModules(): Promise<ModuleResult[]> {
    const enabledModules = this.getEnabledModules();
    return this.runModules(enabledModules);
  }
  
  // Run specific modules by ID (for --module flag)
  async runModules(moduleIds: ModuleId[]): Promise<ModuleResult[]> {
    const promises = moduleIds.map(async (moduleId) => {
      const runner = moduleRegistry.get(moduleId);
      
      if (!runner) {
        return this.createErrorResult(moduleId, `Module ${moduleId} not registered`);
      }
      
      try {
        return await runner(this.config);
      } catch (error) {
        return this.createErrorResult(
          moduleId,
          error instanceof Error ? error.message : String(error)
        );
      }
    });
    
    // Run all in parallel via Promise.allSettled()
    // One failure must not block others (RULES.md rule 13)
    const results = await Promise.allSettled(promises);
    
    // Extract results, handling rejected promises
    return results.map((result) => {
      if (result.status === 'fulfilled') {
        return result.value;
      }
      // This shouldn't happen since we catch in the promise
      return this.createErrorResult(
        'M-01',
        'Module execution failed unexpectedly'
      );
    });
  }
  
  // Get list of enabled modules based on config
  private getEnabledModules(): ModuleId[] {
    const allIds: ModuleId[] = ['M-01', 'M-02', 'M-03', 'M-04', 'M-05', 'M-06', 'M-07', 'M-08'];
    
    return allIds.filter(id => {
      const moduleKey = this.getModuleKey(id);
      const moduleConfig = (this.config.modules as unknown as Record<string, { enabled?: boolean }>)[moduleKey];
      return moduleConfig?.enabled ?? true;
    });
  }
  
  // Map module ID to config key
  private getModuleKey(moduleId: ModuleId): string {
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
  
  // Create error result
  private createErrorResult(moduleId: ModuleId, errorMessage: string): ModuleResult {
    return {
      moduleId,
      moduleName: this.getModuleName(moduleId),
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
  
  private getModuleName(moduleId: ModuleId): string {
    const names: Record<ModuleId, string> = {
      'M-01': 'CI/CD Pipeline',
      'M-02': 'Code Quality',
      'M-03': 'Docs Freshness',
      'M-04': 'Test Flakiness',
      'M-05': 'Dependency Security',
      'M-06': 'PR Complexity',
      'M-07': 'Environment Integrity',
      'M-08': 'Build Performance',
    };
    return names[moduleId];
  }
}

// Create orchestrator instance
export function createOrchestrator(config: ProjectHealthConfig): Orchestrator {
  return new Orchestrator(config);
}
