// Project Analyzer — provides concise project overview for scan summary and ph brief
// Detects tech stack, project type, entry points, and generates project descriptor

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { IGNORED_DIRS, shouldIgnorePath, SOURCE_EXTENSIONS } from "./ignore.js";
import { createLogger } from "./logger.js";

const log = createLogger("ph:cli");

export interface ProjectDescriptor {
  name: string;
  type: string;
  language: string;
  framework: string;
  fileCount: number;
  lineCount: number;
  moduleCount: number;
  dependencyCount: number;
  hasTests: boolean;
  hasCI: boolean;
  hasDocs: boolean;
  hasDocker: boolean;
  entryPoints: string[];
  topDirs: Array<{ name: string; files: number }>;
}

/**
 * Analyze project and return a concise descriptor
 */
export function analyzeProject(projectRoot: string): ProjectDescriptor {
  // Read package.json for name and dependencies
  let name = "unknown";
  let dependencyCount = 0;
  let framework = "none";
  let language = "TypeScript";

  const pkgPath = join(projectRoot, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      name = pkg.name || "unknown";
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      dependencyCount = Object.keys(deps).length;
      const hasBin = Boolean(pkg.bin);

      // Detect framework
      if (hasBin || deps["commander"]) framework = "CLI (commander)";
      else if (deps["next"]) framework = "Next.js";
      else if (deps["nuxt"]) framework = "Nuxt";
      else if (deps["svelte"]) framework = "Svelte";
      else if (deps["vue"]) framework = "Vue";
      else if (deps["react"]) framework = "React";
      else if (deps["express"]) framework = "Express";
      else if (deps["fastify"]) framework = "Fastify";
      else if (deps["@nestjs/core"]) framework = "NestJS";
      else if (deps["angular"]) framework = "Angular";

      // Detect language
      if (pkg.type === "module" && !deps["typescript"])
        language = "JavaScript (ESM)";
      else if (deps["typescript"]) language = "TypeScript";
      else language = "JavaScript";
    } catch (err) {
      log("Error in analyzeProject: %O", err);
      /* ignore */
    }
  }

  // Scan file tree (3 levels deep)
  const topDirs = new Map<string, number>();
  let fileCount = 0;
  let lineCount = 0;
  let moduleCount = 0;
  const entryPoints: string[] = [];

  function scanDir(dir: string, depth: number, topDirName: string | null) {
    if (depth > 3) return;

    try {
      const entries = readdirSync(dir);
      for (const entry of entries) {
        const fullPath = join(dir, entry);
        const rel = fullPath
          .replace(projectRoot, "")
          .replace(/\\/g, "/")
          .replace(/^\//, "");

        if (shouldIgnorePath(rel)) continue;

        try {
          const stat = statSync(fullPath);
          if (stat.isDirectory()) {
            const dirTop = topDirName || entry;
            scanDir(fullPath, depth + 1, dirTop);
          } else {
            const ext = entry.slice(entry.lastIndexOf(".")).toLowerCase();
            if (SOURCE_EXTENSIONS.has(ext)) {
              fileCount++;
              const count = topDirs.get(topDirName || "root") || 0;
              topDirs.set(topDirName || "root", count + 1);

              // Count lines (quick approximate)
              try {
                const content = readFileSync(fullPath, "utf-8");
                lineCount += content.split("\n").length;
              } catch (err) {
                log("Error in scanDir: %O", err);
                /* ignore */
              }
            }
          }
        } catch (err) {
          log("Error in scanDir: %O", err);
          /* ignore */
        }
      }
    } catch (err) {
      log("Error in scanDir: %O", err);
      /* ignore */
    }
  }

  scanDir(projectRoot, 0, null);

  // Sort top dirs by file count
  const sortedDirs = [...topDirs.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name, files]) => ({ name, files }));

  moduleCount = sortedDirs.filter(
    (d) => d.name !== "root" && d.name !== "tests" && d.name !== "test",
  ).length;

  // Detect entry points
  const entryCandidates = [
    "src/index.ts",
    "src/index.js",
    "src/main.ts",
    "src/app.ts",
    "src/server.ts",
    "index.ts",
    "index.js",
    "app.ts",
  ];
  for (const candidate of entryCandidates) {
    if (existsSync(join(projectRoot, candidate))) {
      entryPoints.push(candidate);
    }
  }

  // Detect features
  const hasTests =
    existsSync(join(projectRoot, "tests")) ||
    existsSync(join(projectRoot, "__tests__")) ||
    existsSync(join(projectRoot, "test")) ||
    existsSync(join(projectRoot, "src", "__tests__"));

  const hasCI =
    existsSync(join(projectRoot, ".github", "workflows")) ||
    existsSync(join(projectRoot, ".gitlab-ci.yml")) ||
    existsSync(join(projectRoot, "Jenkinsfile"));

  const hasDocs =
    existsSync(join(projectRoot, "docs")) ||
    existsSync(join(projectRoot, "README.md"));

  const hasDocker =
    existsSync(join(projectRoot, "Dockerfile")) ||
    existsSync(join(projectRoot, "docker-compose.yml"));

  // Determine project type
  let type = "library";
  if (
    framework === "Express" ||
    framework === "Fastify" ||
    framework === "NestJS"
  )
    type = "API server";
  else if (
    framework === "Next.js" ||
    framework === "Nuxt" ||
    framework === "Svelte"
  )
    type = "web app";
  else if (
    framework === "React" ||
    framework === "Vue" ||
    framework === "Angular"
  )
    type = "frontend app";
  else if (framework === "CLI (commander)") type = "CLI tool";

  return {
    name,
    type,
    language,
    framework,
    fileCount,
    lineCount,
    moduleCount,
    dependencyCount,
    hasTests,
    hasCI,
    hasDocs,
    hasDocker,
    entryPoints,
    topDirs: sortedDirs,
  };
}

/**
 * Format project descriptor as a concise one-liner
 */
export function formatProjectOverview(desc: ProjectDescriptor): string {
  const parts: string[] = [];

  parts.push(`${desc.name} — ${desc.type}`);
  parts.push(
    `${desc.language}${desc.framework !== "none" ? ` / ${desc.framework}` : ""}`,
  );
  parts.push(
    `${desc.fileCount} source files, ~${formatNumber(desc.lineCount)} lines`,
  );
  parts.push(
    `${desc.moduleCount} modules, ${desc.dependencyCount} dependencies`,
  );

  const features: string[] = [];
  if (desc.hasTests) features.push("tests");
  if (desc.hasCI) features.push("CI");
  if (desc.hasDocs) features.push("docs");
  if (desc.hasDocker) features.push("Docker");
  if (features.length > 0) {
    parts.push(features.join(", "));
  }

  return parts.join(" | ");
}

/**
 * Format number with K suffix for readability
 */
function formatNumber(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}
