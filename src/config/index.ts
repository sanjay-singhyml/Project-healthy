import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import Ajv from "ajv";
import {
  ProjectHealthConfig,
  DEFAULT_SCORING_WEIGHTS,
  ModulesConfig,
} from "../types/index.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("ph:cli");

const CONFIG_FILE = "project-health.config.ts";

const ajv = new Ajv();

const defaultModulesConfig: ModulesConfig = {
  cicd: {
    enabled: true,
    slowJobThresholdMinutes: 5,
    failureRateThreshold: 20,
  },
  quality: {
    enabled: true,
    complexityThreshold: 30,
    duplicateLineMin: 200,
  },
  docs: {
    enabled: true,
    stalenessDays: 14,
    aiSemanticCheck: false,
  },
  flakiness: {
    enabled: true,
    lookbackRuns: 20,
    passRateThreshold: 95,
  },
  security: {
    enabled: true,
    blockedLicenses: ["GPL", "AGPL", "UNLICENSED"],
  },
  prComplexity: {
    enabled: true,
    maxLinesChanged: 500,
    maxFilesChanged: 5,
    reviewTimeoutDays: 3,
  },
  env: {
    enabled: true,
    secretPatterns: [
      "password",
      "secret",
      "token",
      "api_key",
      "apikey",
      "private_key",
      "aws_access",
    ],
  },
  buildPerf: {
    enabled: true,
    bottleneckThresholdPct: 30,
    maxBuildTimeMs: 300000,
  },
};

const defaultConfig: ProjectHealthConfig = {
  proxy: {
    url: "https://project-healthy.vercel.app/v1",
    timeout: 30000,
  },
  modules: defaultModulesConfig,
  scoring: {
    weights: { ...DEFAULT_SCORING_WEIGHTS },
    failUnder: 60,
  },
  docUpdater: {
    mode: "pr",
  },
};

export class ConfigManager {
  private configPath: string;
  private config: ProjectHealthConfig | null = null;

  constructor(projectRoot: string) {
    this.configPath = resolve(projectRoot, CONFIG_FILE);
  }

  async load(): Promise<ProjectHealthConfig> {
    // First try to load from project-health.config.ts
    try {
      const content = await fs.readFile(this.configPath, "utf-8");
      // Extract JSON object by finding the opening { and counting braces
      const startMatch = content.match(/export\s+const\s+config[^=]*=\s*/);
      if (startMatch) {
        const startIdx = content.indexOf(
          "{",
          startMatch.index! + startMatch[0].length,
        );
        if (startIdx !== -1) {
          let depth = 0;
          let endIdx = -1;
          for (let i = startIdx; i < content.length; i++) {
            if (content[i] === "{") depth++;
            else if (content[i] === "}") {
              depth--;
              if (depth === 0) {
                endIdx = i + 1;
                break;
              }
            }
          }
          if (endIdx !== -1) {
            const objStr = content.slice(startIdx, endIdx);
            const configModule = new Function("return " + objStr)();
            this.config = this.mergeWithDefaults(configModule);
            return this.config;
          }
        }
      }
    } catch (err) {
      log("Error in load: %O", err);
      // Config file doesn't exist, return defaults
    }

    // Return default config
    this.config = {
      ...defaultConfig,
      proxy: { ...defaultConfig.proxy },
      scoring: {
        ...defaultConfig.scoring,
        weights: { ...defaultConfig.scoring.weights },
      },
      docUpdater: { ...defaultConfig.docUpdater },
    };
    return this.config;
  }

  private mergeWithDefaults(
    userConfig: Partial<ProjectHealthConfig>,
  ): ProjectHealthConfig {
    const config = { ...defaultConfig };

    if (userConfig.proxy) {
      config.proxy = { ...config.proxy, ...userConfig.proxy };
    }

    if (userConfig.modules) {
      const userModules = userConfig.modules as unknown as Record<
        string,
        Record<string, unknown>
      >;
      const configModules = config.modules as unknown as Record<
        string,
        Record<string, unknown>
      >;
      for (const key of Object.keys(
        config.modules,
      ) as (keyof ModulesConfig)[]) {
        if (userModules[key]) {
          configModules[key] = {
            ...configModules[key],
            ...userModules[key],
          };
        }
      }
    }

    if (userConfig.scoring) {
      config.scoring = { ...config.scoring, ...userConfig.scoring };
      if (userConfig.scoring.weights) {
        config.scoring.weights = {
          ...config.scoring.weights,
          ...userConfig.scoring.weights,
        };
      }
    }

    if (userConfig.docUpdater) {
      config.docUpdater = { ...config.docUpdater, ...userConfig.docUpdater };
    }

    return config;
  }

  async save(config: ProjectHealthConfig): Promise<void> {
    const configContent = `import { ProjectHealthConfig } from 'project-health';

export const config: ProjectHealthConfig = ${JSON.stringify(config, null, 2)};
`;
    await fs.writeFile(this.configPath, configContent, "utf-8");
    this.config = config;
  }

  getConfig(): ProjectHealthConfig | null {
    return this.config;
  }

  async setValue(key: string, value: unknown): Promise<void> {
    if (!this.config) {
      await this.load();
    }

    const keys = key.split(".");
    let obj: Record<string, unknown> = this.config as unknown as Record<
      string,
      unknown
    >;

    for (let i = 0; i < keys.length - 1; i++) {
      const k = keys[i] as string;
      if (!obj[k]) {
        obj[k] = {};
      }
      const next = obj[k];
      if (typeof next === "object" && next !== null) {
        obj = next as Record<string, unknown>;
      } else {
        break;
      }
    }

    const lastKey = keys[keys.length - 1] as string;
    obj[lastKey] = value;
    await this.save(this.config!);
  }

  getConfigPath(): string {
    return this.configPath;
  }

  // Validate scoring weights sum to 100
  validateWeights(): { valid: boolean; sum: number } {
    if (!this.config) {
      return { valid: false, sum: 0 };
    }

    const weights = this.config.scoring.weights;
    const sum = Object.values(weights).reduce((acc, w) => acc + w, 0);

    return {
      valid: Math.abs(sum - 100) < 0.01,
      sum,
    };
  }

  // Redistribute weights when a module is disabled
  redistributeWeights(disabledModule: string): void {
    if (!this.config) return;

    const weights = { ...this.config.scoring.weights };
    const disabledWeight = weights[disabledModule] ?? 0;

    if (disabledWeight === 0) return;

    delete weights[disabledModule];

    const enabledSum = Object.values(weights).reduce((acc, w) => acc + w, 0);
    const ratio = 100 / enabledSum;

    for (const key of Object.keys(weights)) {
      const w = weights[key];
      if (w !== undefined) {
        weights[key] = Math.round(w * ratio * 100) / 100;
      }
    }

    this.config.scoring.weights = weights;
  }
}

export function createConfigManager(projectRoot?: string): ConfigManager {
  const root = projectRoot ?? process.cwd();
  return new ConfigManager(root);
}

// Generate default config file content
export function generateConfigContent(
  config: ProjectHealthConfig = defaultConfig,
): string {
  return `import { ProjectHealthConfig } from 'project-health';

/**
 * Project Health Configuration
 * 
 * This file is auto-generated by 'ph init'.
 * Modify the values below to customize analysis behavior.
 */
export const config: ProjectHealthConfig = ${JSON.stringify(config, null, 2)};
`;
}

// Check if config file exists
export async function configExists(projectRoot: string): Promise<boolean> {
  const configPath = resolve(projectRoot, CONFIG_FILE);
  try {
    await fs.access(configPath);
    return true;
  } catch (err) {
    log("Error in configExists: %O", err);
    return false;
  }
}
