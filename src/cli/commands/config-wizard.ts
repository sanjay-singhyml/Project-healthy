// ph config wizard — interactive configuration using @inquirer/prompts
// Guides users through all config options step by step

import { confirm, number, checkbox, input } from "@inquirer/prompts";
import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";

// Helper to handle Ctrl+C gracefully in prompts
async function safePrompt<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof Error && err.name === "ExitPromptError") {
      console.log(chalk.yellow("\n  Cancelled.\n"));
      return null;
    }
    throw err;
  }
}

interface WizardAnswers {
  enabledModules: string[];
  weights: Record<string, number>;
  complexityThreshold: number;
  failUnder: number;
  flakinessPassRate: number;
  snykToken: string;
  watchModeDefault: boolean;
}

const ALL_MODULES = [
  { name: "CI/CD Pipeline (M-01)", value: "cicd", weight: 15 },
  { name: "Code Quality (M-02)", value: "quality", weight: 18 },
  { name: "Docs Freshness (M-03)", value: "docs", weight: 6 },
  { name: "Test Flakiness (M-04)", value: "flakiness", weight: 14 },
  { name: "Dependency Security (M-05)", value: "security", weight: 20 },
  { name: "PR Complexity (M-06)", value: "prComplexity", weight: 4 },
  { name: "Environment Integrity (M-07)", value: "env", weight: 13 },
  { name: "Build Performance (M-08)", value: "buildPerf", weight: 10 },
];

export async function runConfigWizard(): Promise<void> {
  console.log("\n  project-health configuration wizard\n");

  // ─── Step 1: Module selection ───────────────────────────────────────────

  const enabledModulesResult = await safePrompt(() =>
    checkbox({
      message: "Which modules do you want to enable?",
      choices: ALL_MODULES.map((m) => ({
        name: m.name,
        value: m.value,
        checked: true,
      })),
    }),
  );
  if (enabledModulesResult === null) return;
  let enabledModules: string[] = enabledModulesResult;

  if (enabledModules.length === 0) {
    console.log("\n  No modules selected. Using all modules.\n");
    enabledModules.push(...ALL_MODULES.map((m) => m.value));
  }

  // ─── Step 2: Score weights ──────────────────────────────────────────────

  console.log("\n  Set score weights (must total 100):\n");

  const weights: Record<string, number> = {};
  const selectedModules = ALL_MODULES.filter((m) =>
    enabledModules.includes(m.value),
  );

  for (const mod of selectedModules) {
    const defaultWeight = mod.weight;
    const weight = await safePrompt(() =>
      number({
        message: `  ${mod.name} weight (default: ${defaultWeight}):`,
        default: defaultWeight,
        min: 0,
        max: 100,
        required: true,
      }),
    );
    if (weight === null) return;

    if (weight !== undefined) {
      weights[mod.value] = weight;
    }
  }

  // Validate sum
  const totalWeight = Object.values(weights).reduce((sum, w) => sum + w, 0);
  if (totalWeight !== 100) {
    console.log(
      `\n  Weights total ${totalWeight}, not 100. Auto-normalizing...\n`,
    );
    const ratio = 100 / totalWeight;
    for (const key of Object.keys(weights)) {
      weights[key] = Math.round(weights[key] * ratio * 100) / 100;
    }
    const newTotal = Object.values(weights).reduce((s, w) => s + w, 0);
    // Adjust rounding error on first module
    if (newTotal !== 100 && selectedModules.length > 0) {
      const first = selectedModules[0].value;
      weights[first] =
        Math.round((weights[first] + (100 - newTotal)) * 100) / 100;
    }
  }

  // ─── Step 3: Complexity threshold ───────────────────────────────────────

  const complexityThreshold = await safePrompt(() =>
    number({
      message: "Cyclomatic complexity threshold (default: 10):",
      default: 10,
      min: 1,
      max: 100,
      required: true,
    }),
  );
  if (complexityThreshold === null) return;

  // ─── Step 4: Fail-under ─────────────────────────────────────────────────

  const failUnder = await safePrompt(() =>
    number({
      message: "Minimum score to fail CI (0 = disabled):",
      default: 0,
      min: 0,
      max: 100,
      required: true,
    }),
  );
  if (failUnder === null) return;

  // ─── Step 5: Flakiness threshold ────────────────────────────────────────

  const flakinessPassRate = await safePrompt(() =>
    number({
      message: "Flakiness pass-rate threshold % (default: 95):",
      default: 95,
      min: 0,
      max: 100,
      required: true,
    }),
  );
  if (flakinessPassRate === null) return;

  // ─── Step 6: Snyk token ─────────────────────────────────────────────────

  let snykToken = "";
  const hasSnyk = await safePrompt(() =>
    confirm({
      message: "Do you have a Snyk token?",
      default: false,
    }),
  );
  if (hasSnyk === null) return;

  if (hasSnyk) {
    const tokenResult = await safePrompt(() =>
      input({
        message: "Enter your Snyk token:",
        default: "",
        transformer: (value) => (value ? "****" + value.slice(-4) : ""),
        validate: (value) => {
          if (!value) return "Token cannot be empty";
          return true;
        },
      }),
    );
    if (tokenResult === null) return;
    snykToken = tokenResult;
  }

  // ─── Step 7: Watch mode ─────────────────────────────────────────────────

  const watchModeDefault = await safePrompt(() =>
    confirm({
      message: "Enable watch mode by default?",
      default: false,
    }),
  );
  if (watchModeDefault === null) return;

  // ─── Generate config ────────────────────────────────────────────────────

  const configContent = generateConfigContent({
    enabledModules,
    weights,
    complexityThreshold,
    failUnder,
    failUnderRaw: failUnder,
    flakinessPassRate,
    snykToken,
    watchModeDefault,
  });

  const projectRoot = process.cwd();
  const configPath = join(projectRoot, "project-health.config.ts");

  writeFileSync(configPath, configContent, "utf-8");

  console.log(`\n  Config written to project-health.config.ts ✓\n`);

  // Print summary
  console.log("  Configuration summary:");
  console.log(
    `    Modules: ${enabledModules.length}/${ALL_MODULES.length} enabled`,
  );
  console.log(
    `    Weights: ${Object.entries(weights)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ")}`,
  );
  console.log(`    Complexity threshold: ${complexityThreshold}`);
  console.log(
    `    CI fail threshold: ${failUnder === 0 ? "disabled" : failUnder}`,
  );
  console.log(`    Flakiness threshold: ${flakinessPassRate}%`);
  console.log(`    Snyk: ${snykToken ? "configured" : "not configured"}`);
  console.log(`    Watch mode: ${watchModeDefault ? "enabled" : "disabled"}`);
  console.log();
}

export function generateConfigContent(answers: {
  enabledModules: string[];
  weights: Record<string, number>;
  complexityThreshold: number;
  failUnder: number;
  failUnderRaw: number;
  flakinessPassRate: number;
  snykToken: string;
  watchModeDefault: boolean;
}): string {
  const isModuleEnabled = (key: string) => answers.enabledModules.includes(key);
  const getWeight = (key: string) => answers.weights[key] ?? 0;

  return `// Auto-generated by ph config wizard
// Run 'ph config wizard' to regenerate this file

import type { ProjectHealthConfig } from 'project-health';

export const config: ProjectHealthConfig = {
  proxy: {
    url: "https://project-healthy.vercel.app/v1",
    timeout: 30000,
  },

  modules: {
    cicd: {
      enabled: ${isModuleEnabled("cicd")},
      slowJobThresholdMinutes: 5,
      failureRateThreshold: 0.2,
    },

    quality: {
      enabled: ${isModuleEnabled("quality")},
      complexityThreshold: ${answers.complexityThreshold},
      duplicateLineMin: 51,
    },

    docs: {
      enabled: ${isModuleEnabled("docs")},
      stalenessDays: 14,
      aiSemanticCheck: false,
    },

    flakiness: {
      enabled: ${isModuleEnabled("flakiness")},
      lookbackRuns: 20,
      passRateThreshold: ${answers.flakinessPassRate / 100},
    },

    security: {
      enabled: ${isModuleEnabled("security")},
      snykToken: "${answers.snykToken}",
      blockedLicenses: ["GPL-3.0", "AGPL-3.0", "UNLICENSED"],
    },

    prComplexity: {
      enabled: ${isModuleEnabled("prComplexity")},
      maxLinesChanged: 500,
      maxFilesChanged: 5,
      reviewTimeoutDays: 3,
    },

    env: {
      enabled: ${isModuleEnabled("env")},
      secretPatterns: [],
    },

    buildPerf: {
      enabled: ${isModuleEnabled("buildPerf")},
      bottleneckThresholdPct: 30,
    },
  },

  scoring: {
    weights: {
      security: ${getWeight("security")},
      quality: ${getWeight("quality")},
      cicd: ${getWeight("cicd")},
      flakiness: ${getWeight("flakiness")},
      env: ${getWeight("env")},
      buildPerf: ${getWeight("buildPerf")},
      docs: ${getWeight("docs")},
      prComplexity: ${getWeight("prComplexity")},
    },
    failUnder: ${answers.failUnder},
  },

  docUpdater: {
    mode: "direct",
  },
};
`;
}
