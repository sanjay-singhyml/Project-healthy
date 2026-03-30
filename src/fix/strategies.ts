// Fix Strategies for project-health
// Implements FixStrategy interface for automated remediation

import { Finding, Severity } from '../types/index.js';
import { execa } from 'execa';
import { existsSync, readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

export interface FixResult {
  success: boolean;
  message: string;
  command?: string;
  error?: string;
}


// Base FixStrategy interface
export interface FixStrategy {
  canFix(finding: Finding): boolean;
  fix(finding: Finding, projectRoot: string, dryRun: boolean): Promise<FixResult>;
}

// ============================================
// NpmUpgradeStrategy - for CVE fixes
// ============================================
export class NpmUpgradeStrategy implements FixStrategy {
  canFix(finding: Finding): boolean {
    // Can fix CVE findings with a fixVersion
    return (
      finding.type === 'CVE' &&
      finding.metadata?.fixVersion !== undefined &&
      finding.metadata?.package !== undefined
    );
  }

  async fix(finding: Finding, projectRoot: string, dryRun: boolean): Promise<FixResult> {
    const pkg = finding.metadata.package as string;
    const fixVersion = finding.metadata.fixVersion as string;
    const command = `npm install ${pkg}@${fixVersion}`;

    if (dryRun) {
      return {
        success: true,
        message: `Would upgrade ${pkg} to ${fixVersion}`,
        command,
      };
    }

    try {
      await execa('npm', ['install', `${pkg}@${fixVersion}`], {
        cwd: projectRoot,
        stdio: 'pipe',
      });

      return {
        success: true,
        message: `Successfully upgraded ${pkg} to ${fixVersion}`,
        command,
      };
    } catch (error) {
      return {
        success: false,
        message: `Failed to upgrade ${pkg}`,
        command,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

// ============================================
// YarnUpgradeStrategy - for CVE fixes with yarn
// ============================================
export class YarnUpgradeStrategy implements FixStrategy {
  canFix(finding: Finding): boolean {
    // Check if yarn.lock exists and finding is a CVE with fixVersion
    return (
      finding.type === 'CVE' &&
      finding.metadata?.fixVersion !== undefined &&
      finding.metadata?.package !== undefined
    );
  }

  async fix(finding: Finding, projectRoot: string, dryRun: boolean): Promise<FixResult> {
    const hasYarnLock = existsSync(join(projectRoot, 'yarn.lock'));
    
    if (!hasYarnLock) {
      return {
        success: false,
        message: 'yarn.lock not found, skipping yarn upgrade',
      };
    }

    const pkg = finding.metadata.package as string;
    const fixVersion = finding.metadata.fixVersion as string;
    const command = `yarn add ${pkg}@${fixVersion}`;

    if (dryRun) {
      return {
        success: true,
        message: `Would upgrade ${pkg} to ${fixVersion} using yarn`,
        command,
      };
    }

    try {
      await execa('yarn', ['add', `${pkg}@${fixVersion}`], {
        cwd: projectRoot,
        stdio: 'pipe',
      });

      return {
        success: true,
        message: `Successfully upgraded ${pkg} to ${fixVersion} using yarn`,
        command,
      };
    } catch (error) {
      return {
        success: false,
        message: `Failed to upgrade ${pkg} with yarn`,
        command,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

// ============================================
// PipUpgradeStrategy - for Python CVE fixes
// ============================================
export class PipUpgradeStrategy implements FixStrategy {
  canFix(finding: Finding): boolean {
    return (
      finding.type === 'CVE' &&
      finding.metadata?.fixVersion !== undefined &&
      finding.metadata?.package !== undefined
    );
  }

  async fix(finding: Finding, projectRoot: string, dryRun: boolean): Promise<FixResult> {
    const hasPipfile = existsSync(join(projectRoot, 'Pipfile'));
    const hasRequirements = existsSync(join(projectRoot, 'requirements.txt'));
    
    const pkg = finding.metadata.package as string;
    const fixVersion = finding.metadata.fixVersion as string;
    
    let command: string;
    if (hasPipfile) {
      command = `pipenv install ${pkg}==${fixVersion}`;
    } else if (hasRequirements) {
      command = `pip install ${pkg}==${fixVersion}`;
    } else {
      return {
        success: false,
        message: 'No Pipfile or requirements.txt found',
      };
    }

    if (dryRun) {
      return {
        success: true,
        message: `Would upgrade ${pkg} to ${fixVersion}`,
        command,
      };
    }

    try {
      if (hasPipfile) {
        await execa('pipenv', ['install', `${pkg}==${fixVersion}`], {
          cwd: projectRoot,
          stdio: 'pipe',
        });
      } else {
        await execa('pip', ['install', `${pkg}==${fixVersion}`], {
          cwd: projectRoot,
          stdio: 'pipe',
        });
      }

      return {
        success: true,
        message: `Successfully upgraded ${pkg} to ${fixVersion}`,
        command,
      };
    } catch (error) {
      return {
        success: false,
        message: `Failed to upgrade ${pkg}`,
        command,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

// ============================================
// EslintFixStrategy - for lint errors
// ============================================
export class EslintFixStrategy implements FixStrategy {
  canFix(finding: Finding): boolean {
    return (
      finding.type === 'LINT_ERROR' ||
      (finding.type === 'HIGH_COMPLEXITY' && finding.file !== undefined)
    );
  }

  async fix(finding: Finding, projectRoot: string, dryRun: boolean): Promise<FixResult> {
    const file = finding.file;
    
    if (!file) {
      return {
        success: false,
        message: 'No file specified in finding',
      };
    }

    const command = `eslint --fix "${file}"`;

    if (dryRun) {
      return {
        success: true,
        message: `Would run ESLint fix on ${file}`,
        command,
      };
    }

    try {
      await execa('npx', ['eslint', '--fix', file], {
        cwd: projectRoot,
        stdio: 'pipe',
      });

      return {
        success: true,
        message: `Successfully fixed lint errors in ${file}`,
        command,
      };
    } catch (error) {
      return {
        success: false,
        message: `Failed to fix lint errors in ${file}`,
        command,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

// ============================================
// EnvTemplateStrategy - for missing .env.example keys
// ============================================
export class EnvTemplateStrategy implements FixStrategy {
  canFix(finding: Finding): boolean {
    return (
      finding.type === 'ENV_DRIFT' &&
      finding.metadata?.missingKey !== undefined
    );
  }

  async fix(finding: Finding, projectRoot: string, dryRun: boolean): Promise<FixResult> {
    const missingKey = finding.metadata.missingKey as string;
    const envExamplePath = join(projectRoot, '.env.example');
    
    // Ensure .env.example exists
    if (!existsSync(envExamplePath)) {
      return {
        success: false,
        message: '.env.example does not exist',
      };
    }

    const lineToAdd = `${missingKey}=`;
    const command = `echo "${missingKey}=" >> .env.example`;

    if (dryRun) {
      return {
        success: true,
        message: `Would add "${missingKey}=" to .env.example`,
        command,
      };
    }

    try {
      // Check if key already exists
      const content = readFileSync(envExamplePath, 'utf-8');
      const lines = content.split('\n');
      const keyExists = lines.some(line => 
        line.trim().startsWith(`${missingKey}=`)
      );
      
      if (keyExists) {
        return {
          success: true,
          message: `Key "${missingKey}" already exists in .env.example`,
        };
      }

      appendFileSync(envExamplePath, `\n${lineToAdd}`);

      return {
        success: true,
        message: `Successfully added "${missingKey}=" to .env.example`,
        command,
      };
    } catch (error) {
      return {
        success: false,
        message: `Failed to add key to .env.example`,
        command,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

// ============================================
// EnvGitignoreStrategy - for .env not in .gitignore
// ============================================
export class EnvGitignoreStrategy implements FixStrategy {
  canFix(finding: Finding): boolean {
    return finding.type === 'ENV_EXPOSED';
  }

  async fix(finding: Finding, projectRoot: string, dryRun: boolean): Promise<FixResult> {
    const gitignorePath = join(projectRoot, '.gitignore');
    const command = `echo ".env" >> .gitignore`;

    if (dryRun) {
      return {
        success: true,
        message: 'Would add ".env" to .gitignore',
        command,
      };
    }

    try {
      // Check if .env already in .gitignore
      if (existsSync(gitignorePath)) {
        const content = readFileSync(gitignorePath, 'utf-8');
        const lines = content.split('\n');
        const envIgnored = lines.some(line => 
          line.trim() === '.env' || line.trim() === '.env*'
        );
        
        if (envIgnored) {
          return {
            success: true,
            message: '.env already in .gitignore',
          };
        }
      }

      appendFileSync(gitignorePath, '\n.env\n');

      return {
        success: true,
        message: 'Successfully added ".env" to .gitignore',
        command,
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to add .env to .gitignore',
        command,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

// ============================================
// TsconfigIncrementalStrategy - for missing tsc --incremental
// ============================================
export class TsconfigIncrementalStrategy implements FixStrategy {
  canFix(finding: Finding): boolean {
    return finding.type === 'MISSING_INCREMENTAL_TS';
  }

  async fix(finding: Finding, projectRoot: string, dryRun: boolean): Promise<FixResult> {
    const tsconfigPath = join(projectRoot, 'tsconfig.json');
    
    if (!existsSync(tsconfigPath)) {
      return {
        success: false,
        message: 'tsconfig.json does not exist',
      };
    }

    const command = 'Add "incremental": true and "tsBuildInfoFile": ".tsbuildinfo" to tsconfig.json';

    try {
      const content = readFileSync(tsconfigPath, 'utf-8');
      const config = JSON.parse(content);
      
      if (config.compilerOptions?.incremental === true) {
        return {
          success: true,
          message: 'incremental already enabled in tsconfig.json',
        };
      }

      if (!config.compilerOptions) {
        config.compilerOptions = {};
      }
      config.compilerOptions.incremental = true;
      if (!config.compilerOptions.tsBuildInfoFile) {
        config.compilerOptions.tsBuildInfoFile = '.tsbuildinfo';
      }

      if (dryRun) {
        return {
          success: true,
          message: '[dry-run] Would add "incremental": true + "tsBuildInfoFile" to tsconfig.json',
          command,
        };
      }

      // Write back with 2-space indentation
      const { writeFileSync } = await import('node:fs');
      writeFileSync(tsconfigPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');

      return {
        success: true,
        message: 'Successfully enabled incremental builds in tsconfig.json',
        command,
      };
    } catch (error) {
      return {
        success: false,
        message: 'Failed to update tsconfig.json',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

// ============================================
// Strategy Registry
// ============================================
export const FIX_STRATEGIES: FixStrategy[] = [
  new NpmUpgradeStrategy(),
  new YarnUpgradeStrategy(),
  new PipUpgradeStrategy(),
  new EslintFixStrategy(),
  new EnvTemplateStrategy(),
  new EnvGitignoreStrategy(),
  new TsconfigIncrementalStrategy(),
];

// Find a strategy that can fix a finding
export function findFixStrategy(finding: Finding): FixStrategy | undefined {
  return FIX_STRATEGIES.find(strategy => strategy.canFix(finding));
}
