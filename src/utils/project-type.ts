// Project type detection and weight presets
// Automatically adjusts module weights based on detected project type

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ModuleId } from "../types/index.js";
import { createLogger } from "./logger.js";

const log = createLogger("ph:cli");

export type ProjectType =
  | "library"
  | "webapp"
  | "cli-tool"
  | "microservice"
  | "prototype";

const CONFIG_FILE = "project-health.config.ts";

// Map ModuleId to config key name
const MODULE_ID_TO_CONFIG_KEY: Record<ModuleId, string> = {
  "M-01": "cicd",
  "M-02": "quality",
  "M-03": "docs",
  "M-04": "flakiness",
  "M-05": "security",
  "M-06": "prComplexity",
  "M-07": "env",
  "M-08": "buildPerf",
};

// Weight presets by project type (using ModuleId format)
const WEIGHT_PRESETS_BY_MODULE_ID: Record<
  ProjectType,
  Record<ModuleId, number>
> = {
  library: {
    "M-02": 25,
    "M-05": 25,
    "M-03": 20,
    "M-04": 10,
    "M-01": 5,
    "M-06": 5,
    "M-07": 5,
    "M-08": 5,
  },
  webapp: {
    "M-05": 20,
    "M-07": 20,
    "M-02": 18,
    "M-01": 15,
    "M-04": 12,
    "M-06": 8,
    "M-03": 5,
    "M-08": 2,
  },
  "cli-tool": {
    "M-02": 25,
    "M-05": 20,
    "M-04": 20,
    "M-01": 15,
    "M-07": 10,
    "M-03": 5,
    "M-06": 3,
    "M-08": 2,
  },
  microservice: {
    "M-07": 25,
    "M-05": 25,
    "M-01": 20,
    "M-04": 15,
    "M-02": 10,
    "M-06": 3,
    "M-03": 1,
    "M-08": 1,
  },
  prototype: {
    "M-05": 40,
    "M-07": 30,
    "M-02": 15,
    "M-01": 10,
    "M-04": 5,
    "M-06": 0,
    "M-03": 0,
    "M-08": 0,
  },
};

// Convert ModuleId-based presets to config key-based presets
export const WEIGHT_PRESETS: Record<
  ProjectType,
  Record<string, number>
> = {} as Record<ProjectType, Record<string, number>>;

for (const [projectType, moduleIdWeights] of Object.entries(
  WEIGHT_PRESETS_BY_MODULE_ID,
)) {
  const configKeyWeights: Record<string, number> = {};
  for (const [moduleId, weight] of Object.entries(moduleIdWeights)) {
    const configKey = MODULE_ID_TO_CONFIG_KEY[moduleId as ModuleId];
    configKeyWeights[configKey] = weight;
  }
  WEIGHT_PRESETS[projectType as ProjectType] = configKeyWeights;
}

/**
 * Detects the project type based on package.json heuristics
 * @param projectRoot - Path to the project root directory
 * @returns The detected project type
 */
export function detectProjectType(projectRoot: string): ProjectType {
  try {
    const packageJsonPath = join(projectRoot, "package.json");
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8"));

    const hasMain = !!pkg.main;
    const hasScriptsStart = !!(pkg.scripts && pkg.scripts.start);
    const hasBin = !!pkg.bin;
    const version = pkg.version || "";
    const name = pkg.name || "";
    const dependencies = pkg.dependencies || {};
    const devDependencies = pkg.devDependencies || {};
    const allDeps = { ...dependencies, ...devDependencies };
    const depCount = Object.keys(allDeps).length;

    // Check for UI frameworks
    const hasReact = !!(allDeps.react || allDeps["react-dom"]);
    const hasNext = !!allDeps.next;
    const hasVue = !!(allDeps.vue || allDeps["@vue/cli-service"]);
    const hasSvelte = !!allDeps.svelte;
    const hasUIFramework = hasReact || hasNext || hasVue || hasSvelte;

    // Check for server frameworks
    const hasExpress = !!allDeps.express;
    const hasFastify = !!allDeps.fastify;
    const hasServerFramework = hasExpress || hasFastify;

    // Heuristic 1: Has "bin" field → cli-tool
    if (hasBin) {
      return "cli-tool";
    }

    // Heuristic 2: Has UI framework → webapp
    if (hasUIFramework) {
      return "webapp";
    }

    // Heuristic 3: package.json name contains 'service' or has server framework + no UI → microservice
    if (name.includes("service") || (hasServerFramework && !hasUIFramework)) {
      return "microservice";
    }

    // Heuristic 4: Version is '0.0.1' or '0.1.0' AND very few deps → prototype
    if ((version === "0.0.1" || version === "0.1.0") && depCount <= 5) {
      return "prototype";
    }

    // Heuristic 5: Has "main" but no "scripts.start" + no express/fastify dep → library
    if (hasMain && !hasScriptsStart && !hasServerFramework) {
      return "library";
    }

    // Default to library if no other type matches
    return "library";
  } catch (error) {
    // If package.json doesn't exist or can't be parsed, default to library
    return "library";
  }
}

/**
 * Gets the weight preset for a given project type
 * @param projectType - The project type
 * @returns Weight preset as config key weights
 */
export function getWeightPreset(
  projectType: ProjectType,
): Record<string, number> {
  return WEIGHT_PRESETS[projectType];
}

/**
 * Checks whether the project config explicitly defines custom scoring weights.
 */
export function hasCustomWeightConfig(projectRoot: string): boolean {
  try {
    const configContent = readFileSync(join(projectRoot, CONFIG_FILE), "utf-8");

    return /scoring\s*:\s*\{[\s\S]*?weights\s*:/.test(configContent);
  } catch (err) {
    log("Error in hasCustomWeightConfig: %O", err);
    return false;
  }
}

/**
 * Gets all valid project types
 * @returns Array of valid project types
 */
export function getValidProjectTypes(): ProjectType[] {
  return ["library", "webapp", "cli-tool", "microservice", "prototype"];
}
