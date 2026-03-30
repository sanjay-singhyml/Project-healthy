// Self-Healing Codebase — ph fix command
// The auto-fix engine: scan → triage → AI/command patch → validate → diff → commit

import { Command } from "commander";
import chalk from "chalk";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { execa } from "execa";
import { simpleGit } from "simple-git";
import { checkbox, confirm, select } from "@inquirer/prompts";
import type { Finding, HealthReport } from "../../types/index.js";
import {
  findFixStrategy,
  NpmUpgradeStrategy,
  YarnUpgradeStrategy,
  type FixResult,
  type FixStrategy,
} from "../../fix/strategies.js";
import { aiFixFinding, AI_FIXABLE_TYPES } from "../../fix/ai-fix.js";

// ─── Severity ordering ─────────────────────────────────────────────
const SEVERITY_ORDER: Record<string, number> = {
  CRITICAL: 4,
  HIGH: 3,
  MEDIUM: 2,
  LOW: 1,
};

function severityColor(sev: string): string {
  if (sev === "CRITICAL") return chalk.red.bold(sev);
  if (sev === "HIGH") return chalk.yellow.bold(sev);
  if (sev === "MEDIUM") return chalk.cyan(sev);
  return chalk.gray(sev);
}

// ─── Load last scan from cache ─────────────────────────────────────
function loadLastScan(projectRoot: string): HealthReport | null {
  const cachePath = join(projectRoot, ".ph-cache", "last-scan.json");
  if (!existsSync(cachePath)) return null;
  try {
    return JSON.parse(readFileSync(cachePath, "utf-8")) as HealthReport;
  } catch {
    return null;
  }
}

// ─── Determine fix mode per finding ───────────────────────────────
function getFixMode(finding: Finding): "command" | "ai" | "none" {
  if (findFixStrategy(finding)) return "command";
  if (AI_FIXABLE_TYPES.includes(finding.type)) return "ai";
  return "none";
}

// ─── Batch CVE upgrades by package manager ─────────────────────────
async function batchCveFix(
  cveFindings: Finding[],
  projectRoot: string,
  dryRun: boolean,
): Promise<FixResult[]> {
  const hasYarnLock = existsSync(join(projectRoot, "yarn.lock"));

  // Group: pkg -> fixVersion
  const upgrades: Record<string, string> = {};
  for (const f of cveFindings) {
    const pkg = f.metadata?.package as string | undefined;
    const ver = f.metadata?.fixVersion as string | undefined;
    if (pkg && ver) upgrades[pkg] = ver;
  }

  const deps = Object.entries(upgrades).map(([p, v]) => `${p}@${v}`);
  if (deps.length === 0) {
    return [
      { success: false, message: "No CVE findings had fixVersion metadata" },
    ];
  }

  const mgr = hasYarnLock ? "yarn" : "npm";
  const cmd = hasYarnLock ? ["add", ...deps] : ["install", ...deps];
  const displayCmd = `${mgr} ${cmd.join(" ")}`;

  if (dryRun) {
    return [
      {
        success: true,
        message: `[dry-run] Would batch-upgrade ${deps.length} packages: ${deps.join(", ")}`,
        command: displayCmd,
      },
    ];
  }

  try {
    await execa(mgr, cmd, { cwd: projectRoot, stdio: "pipe" });
    return [
      {
        success: true,
        message: `Upgraded ${deps.length} packages: ${deps.join(", ")}`,
        command: displayCmd,
      },
    ];
  } catch (err) {
    return [
      {
        success: false,
        message: `Batch upgrade failed`,
        error: err instanceof Error ? err.message : String(err),
        command: displayCmd,
      },
    ];
  }
}

// ─── Generate a simple text diff view ─────────────────────────────
function fileDiff(originalPath: string, newContent: string): string {
  if (!existsSync(originalPath)) return newContent;
  const original = readFileSync(originalPath, "utf-8").split("\n");
  const updated = newContent.split("\n");
  const lines: string[] = [];
  const max = Math.max(original.length, updated.length);
  for (let i = 0; i < max; i++) {
    if (original[i] !== updated[i]) {
      if (original[i] !== undefined) lines.push(chalk.red(`- ${original[i]}`));
      if (updated[i] !== undefined) lines.push(chalk.green(`+ ${updated[i]}`));
    }
  }
  return lines.slice(0, 60).join("\n"); // show first 60 diff lines
}

// ─── Run lint/test validation ──────────────────────────────────────
async function runValidation(
  projectRoot: string,
): Promise<{ lint: boolean; tests: boolean }> {
  const pkgPath = join(projectRoot, "package.json");
  if (!existsSync(pkgPath)) return { lint: false, tests: false };

  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  const scripts: Record<string, string> = pkg.scripts ?? {};

  let lint = true;
  let tests = true;

  if (scripts.lint) {
    try {
      await execa("npm", ["run", "lint", "--", "--max-warnings", "0"], {
        cwd: projectRoot,
        stdio: "pipe",
      });
    } catch {
      lint = false;
    }
  }

  if (scripts.test) {
    try {
      await execa("npm", ["run", "test"], { cwd: projectRoot, stdio: "pipe" });
    } catch {
      tests = false;
    }
  }

  return { lint, tests };
}

// ─── Git commit findings fix to new branch ────────────────────────
async function commitFixes(
  projectRoot: string,
  fixCount: number,
): Promise<void> {
  const git = simpleGit(projectRoot);
  const branch = `ph-fixes/${Date.now()}`;
  await git.checkoutLocalBranch(branch);
  await git.add(".");
  await git.commit(`fix(ph): auto-fix ${fixCount} findings via ph fix --auto`);
  console.log(chalk.green(`\n✓ Committed on branch: ${chalk.bold(branch)}`));
}

// ─── Print results summary ─────────────────────────────────────────
function printSummary(results: Array<{ finding: Finding; result: FixResult }>) {
  const ok = results.filter((r) => r.result.success).length;
  const fail = results.filter((r) => !r.result.success).length;

  console.log(
    "\n" + chalk.bold("══ Fix Summary ════════════════════════════════"),
  );
  for (const { finding, result } of results) {
    const icon = result.success ? chalk.green("✓") : chalk.red("✗");
    const sev = severityColor(finding.severity);
    const file = finding.file ? chalk.dim(` → ${finding.file}`) : "";
    console.log(`  ${icon} [${sev}] ${chalk.bold(finding.type)}${file}`);
    console.log(`     ${chalk.dim(result.message)}`);
    if (result.command)
      console.log(`     ${chalk.cyan(`$ ${result.command}`)}`);
    if (result.error) console.log(`     ${chalk.red(result.error)}`);
  }
  console.log(" ");
  console.log(
    `  ${chalk.green.bold(`${ok} fixed`)}  ${fail > 0 ? chalk.red.bold(`${fail} failed`) : chalk.dim("0 failed")}`,
  );
  console.log(chalk.bold("═══════════════════════════════════════════════"));
}

// ─── Main command handler ─────────────────────────────────────────
async function runFixCommand(opts: {
  auto: boolean;
  dryRun: boolean;
  ai: boolean;
  commit: boolean;
  limit: string;
  proxy?: string;
  interactive: boolean;
}) {
  const projectRoot = process.cwd();
  const limit = parseInt(opts.limit, 10) || 10;

  // 1. Load last scan
  const report = loadLastScan(projectRoot);
  if (!report) {
    console.error(chalk.red("\n✗ No scan data found. Run `ph scan` first.\n"));
    process.exit(1);
  }

  // 2. Triage: sort by severity, filter to fixable only
  const allFindings = report.findings ?? [];
  const sortedFindings = [...allFindings]
    .sort(
      (a, b) =>
        (SEVERITY_ORDER[b.severity] ?? 0) - (SEVERITY_ORDER[a.severity] ?? 0),
    )
    .filter((f) => getFixMode(f) !== "none")
    .slice(0, limit);

  if (sortedFindings.length === 0) {
    console.log(
      chalk.green("\n✓ No auto-fixable findings found in last scan.\n"),
    );
    return;
  }

  console.log(chalk.bold.cyan("\n🔧 Self-Healing Codebase — Auto-Fix Engine"));
  console.log(
    chalk.dim(
      `   Loaded ${allFindings.length} findings · ${sortedFindings.length} auto-fixable · limit ${limit}\n`,
    ),
  );

  // 3. Selection (interactive or auto)
  let selectedFindings = sortedFindings;

  if (opts.interactive || !opts.auto) {
    const choices = sortedFindings.map((f) => ({
      value: f,
      name: `[${f.severity}] ${f.type}${f.file ? ` — ${f.file}` : ""}: ${f.message.slice(0, 70)}`,
      checked: f.severity === "CRITICAL" || f.severity === "HIGH",
    }));

    selectedFindings = await checkbox({
      message: "Select findings to fix (Space to toggle, Enter to confirm):",
      choices,
    }).catch((err) => {
      if (err instanceof Error && err.name === "ExitPromptError") {
        console.log(chalk.yellow("\n  Cancelled.\n"));
        return [];
      }
      throw err;
    });

    if (selectedFindings.length === 0) {
      console.log(chalk.yellow("\n  No findings selected. Exiting.\n"));
      return;
    }
  }

  // 4. Dry-run preview
  if (opts.dryRun) {
    console.log(
      chalk.yellow.bold("\n⚡ Dry-run mode — no changes will be made\n"),
    );
  }

  // 5. Batch CVE fixes separately for performance
  const cveFindings = selectedFindings.filter((f) => f.type === "CVE");
  const nonCveFindings = selectedFindings.filter((f) => f.type !== "CVE");
  const results: Array<{ finding: Finding; result: FixResult }> = [];

  if (cveFindings.length > 0) {
    console.log(
      chalk.bold(
        `\n📦 Batching ${cveFindings.length} CVE package upgrade(s)...`,
      ),
    );
    const batchResults = await batchCveFix(
      cveFindings,
      projectRoot,
      opts.dryRun,
    );
    // Map batch results back to individual findings
    for (const f of cveFindings) {
      results.push({ finding: f, result: batchResults[0] });
    }
  }

  // 6. Fix each remaining finding
  for (const finding of nonCveFindings) {
    const mode = getFixMode(finding);
    const file = finding.file ? chalk.dim(finding.file) : "";
    process.stdout.write(
      `  ${chalk.cyan("→")} [${severityColor(finding.severity)}] ${chalk.bold(finding.type)} ${file} ... `,
    );

    let result: FixResult;

    if (mode === "command") {
      const strategy = findFixStrategy(finding)!;
      result = await strategy.fix(finding, projectRoot, opts.dryRun);
    } else if (mode === "ai" && opts.ai) {
      result = await aiFixFinding(finding, projectRoot, {
        dryRun: opts.dryRun,
        proxyUrl: opts.proxy,
      });
    } else if (mode === "ai" && !opts.ai) {
      result = {
        success: false,
        message: `AI fix available but --ai flag not provided (add --ai to enable)`,
      };
    } else {
      result = { success: false, message: "No strategy available" };
    }

    if (result.success) {
      console.log(chalk.green("✓"));
    } else {
      console.log(chalk.red("✗"));
    }

    results.push({ finding, result });
  }

  // 7. Print summary
  printSummary(results);

  if (opts.dryRun) return;

  // 8. Validate
  const fixedCount = results.filter((r) => r.result.success).length;
  if (fixedCount > 0) {
    console.log(chalk.bold("\n🔍 Running validation (lint + tests)..."));
    const { lint, tests } = await runValidation(projectRoot);
    console.log(
      `  Lint:  ${lint ? chalk.green("✓ passed") : chalk.yellow("⚠ issues found")}`,
    );
    console.log(
      `  Tests: ${tests ? chalk.green("✓ passed") : chalk.yellow("⚠ issues found")}`,
    );
  }

  // 9. Commit prompt
  if (opts.commit && fixedCount > 0) {
    const doCommit = await confirm({
      message: `Commit ${fixedCount} fix(es) to a new branch?`,
      default: true,
    }).catch((err) => {
      if (err instanceof Error && err.name === "ExitPromptError") {
        console.log(chalk.yellow("\n  Cancelled.\n"));
        return false;
      }
      throw err;
    });
    if (doCommit) {
      await commitFixes(projectRoot, fixedCount);
    }
  } else if (!opts.commit && fixedCount > 0 && !opts.dryRun) {
    console.log(
      chalk.dim(
        "\n  Tip: Add --commit to automatically commit the fixes to a new branch.\n",
      ),
    );
  }
}

// ─── Register command ──────────────────────────────────────────────
export function registerFixCommand(program: Command): void {
  program
    .command("fix")
    .description(
      "Auto-fix findings from last scan — the Self-Healing Codebase engine",
    )
    .option(
      "--auto",
      "Non-interactive: fix top critical findings automatically",
    )
    .option("--interactive", "Interactively select which findings to fix")
    .option("--dry-run", "Preview what would be fixed without making changes")
    .option(
      "--ai",
      "Use AI (MegaLLM) for complex fixes (JSDoc, complexity, etc.)",
    )
    .option("--commit", "Commit fixes to a new git branch after validation")
    .option("--proxy <url>", "Custom AI proxy URL (overrides MEGALLM_BASE_URL)")
    .option("--limit <n>", "Max number of findings to fix (default: 10)", "10")
    .action(async (opts) => {
      // Default to interactive mode if neither --auto nor --interactive is specified
      if (!opts.auto && !opts.interactive) {
        opts.interactive = true;
      }
      try {
        await runFixCommand(opts);
      } catch (err) {
        if (err instanceof Error && err.name === "ExitPromptError") {
          console.log(chalk.yellow("\n  Cancelled.\n"));
          process.exit(0);
        }
        throw err;
      }
    });
}
