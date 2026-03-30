// Test suite for Config and Cache managers
import { describe, it, expect, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

let testIdx = 0;
function getTestDir(): string {
  testIdx++;
  const dir = join(process.cwd(), `.test-config-${Date.now()}-${testIdx}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("Cache Manager", () => {
  it("ph scan bootstraps missing cache automatically", () => {
    const TEST_DIR = getTestDir();
    const repoRoot = process.cwd();
    const cliPath = join(repoRoot, "src", "cli", "index.ts");
    const tsxCli = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
    const command = process.execPath;
    const args = [tsxCli, cliPath, "scan", "--module", "M-07", "--format", "json"];

    const result = spawnSync(command, args, {
      cwd: TEST_DIR,
      encoding: "utf-8",
      timeout: 20000,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain('Run "ph init" first.');
    expect(existsSync(join(TEST_DIR, ".ph-cache", "last-scan.json"))).toBe(true);
    expect(existsSync(join(TEST_DIR, "project-health.config.ts"))).toBe(true);
    expect(readFileSync(join(TEST_DIR, ".gitignore"), "utf-8")).toContain(
      ".ph-cache/",
    );
  });

  it("creates cache directory", async () => {
    const TEST_DIR = getTestDir();
    const { createCacheManager } = await import("../src/cache/index.js");
    const cache = createCacheManager(TEST_DIR);
    await cache.ensureCacheDir();
    expect(existsSync(join(TEST_DIR, ".ph-cache"))).toBe(true);
  });

  it("saves and retrieves last scan", async () => {
    const TEST_DIR = getTestDir();
    const { createCacheManager } = await import("../src/cache/index.js");
    const cache = createCacheManager(TEST_DIR);

    const report = {
      score: 85,
      generatedAt: new Date().toISOString(),
      projectRoot: TEST_DIR,
      modules: [],
      findings: [],
      topActions: [],
    };

    await cache.saveLastScan(report);
    const retrieved = await cache.getLastScan();
    expect(retrieved).not.toBeNull();
    expect(retrieved!.score).toBe(85);
  });

  it("returns null for missing scan", async () => {
    const TEST_DIR = getTestDir();
    const { createCacheManager } = await import("../src/cache/index.js");
    const cache = createCacheManager(TEST_DIR);
    const scan = await cache.getLastScan();
    expect(scan).toBeNull();
  });

  it("saves and retrieves AST index", async () => {
    const TEST_DIR = getTestDir();
    const { createCacheManager } = await import("../src/cache/index.js");
    const cache = createCacheManager(TEST_DIR);

    const index = {
      UserService: {
        file: "src/services/user.ts",
        line: 10,
        kind: "class" as const,
      },
    };

    await cache.saveAstIndex(index);
    const retrieved = await cache.getAstIndex();
    expect(retrieved).not.toBeNull();
    expect(retrieved!.UserService.file).toBe("src/services/user.ts");
  });

  it("saves and retrieves docs index", async () => {
    const TEST_DIR = getTestDir();
    const { createCacheManager } = await import("../src/cache/index.js");
    const cache = createCacheManager(TEST_DIR);

    const index = {
      "src/auth/index.ts": ["docs/auth.md#overview"],
    };

    await cache.saveDocsIndex(index);
    const retrieved = await cache.getDocsIndex();
    expect(retrieved).not.toBeNull();
    expect(retrieved!["src/auth/index.ts"]).toEqual(["docs/auth.md#overview"]);
  });

  it("saves and retrieves chat sessions", async () => {
    const TEST_DIR = getTestDir();
    const { createCacheManager } = await import("../src/cache/index.js");
    const cache = createCacheManager(TEST_DIR);

    const session = {
      id: "session-001",
      createdAt: new Date().toISOString(),
      messages: [
        { role: "system" as const, content: "You are helpful" },
        { role: "user" as const, content: "Hello" },
        { role: "assistant" as const, content: "Hi there!" },
      ],
    };

    await cache.saveSession(session);
    const retrieved = await cache.getSession("session-001");
    expect(retrieved).not.toBeNull();
    expect(retrieved!.messages.length).toBe(3);
  });

  it("lists sessions", async () => {
    const TEST_DIR = getTestDir();
    const { createCacheManager } = await import("../src/cache/index.js");
    const cache = createCacheManager(TEST_DIR);

    await cache.saveSession({ id: "sess-1", createdAt: "", messages: [] });
    await cache.saveSession({ id: "sess-2", createdAt: "", messages: [] });

    const sessions = await cache.listSessions();
    expect(sessions).toContain("sess-1");
    expect(sessions).toContain("sess-2");
  });

  it("clears cache", async () => {
    const TEST_DIR = getTestDir();
    const { createCacheManager } = await import("../src/cache/index.js");
    const cache = createCacheManager(TEST_DIR);

    await cache.saveLastScan({
      score: 50,
      generatedAt: "",
      projectRoot: TEST_DIR,
      modules: [],
      findings: [],
      topActions: [],
    });
    await cache.clearCache();

    const scan = await cache.getLastScan();
    expect(scan).toBeNull();
  });

  it("isInitialized checks if cache exists", async () => {
    const TEST_DIR = getTestDir();
    const { createCacheManager } = await import("../src/cache/index.js");
    const cache = createCacheManager(TEST_DIR);

    expect(await cache.isInitialized()).toBe(false);
    await cache.ensureCacheDir();
    expect(await cache.isInitialized()).toBe(true);
  });
});

describe("Config Manager", () => {
  it("creates default config when none exists", async () => {
    const TEST_DIR = getTestDir();
    const { createConfigManager } = await import("../src/config/index.js");
    const manager = createConfigManager(TEST_DIR);
    const config = await manager.load();

    expect(config).toBeDefined();
    expect(config.modules).toBeDefined();
    expect(config.modules.cicd).toBeDefined();
    expect(config.modules.quality).toBeDefined();
    expect(config.modules.security).toBeDefined();
    expect(config.modules.env).toBeDefined();
    expect(config.scoring).toBeDefined();
    expect(config.scoring.weights.security).toBe(20);
  });

  it("weights sum to 100", async () => {
    const TEST_DIR = getTestDir();
    const { createConfigManager } = await import("../src/config/index.js");
    const manager = createConfigManager(TEST_DIR);
    const config = await manager.load();

    const sum = Object.values(config.scoring.weights).reduce(
      (a, b) => a + b,
      0,
    );
    expect(sum).toBe(100);
  });

  it("sets and gets config values", async () => {
    const TEST_DIR = getTestDir();
    const { createConfigManager } = await import("../src/config/index.js");
    const manager = createConfigManager(TEST_DIR);
    await manager.load();

    await manager.setValue("scoring.failUnder", 75);
    // After setValue + save, load should return the persisted value
    expect(manager.getConfig()!.scoring.failUnder).toBe(75);
  });

  it("reads from existing config file with export const config", async () => {
    const TEST_DIR = getTestDir();
    const configContent = `import { ProjectHealthConfig } from 'project-health';

export const config: ProjectHealthConfig = {
  proxy: { url: "http://localhost:4000", timeout: 60000 },
  modules: {
    cicd: { enabled: true, slowJobThresholdMinutes: 10, failureRateThreshold: 20 },
    quality: { enabled: true, complexityThreshold: 15, duplicateLineMin: 5 },
    docs: { enabled: true, stalenessDays: 30, aiSemanticCheck: false },
    flakiness: { enabled: true, lookbackRuns: 30, passRateThreshold: 90 },
    security: { enabled: true, snykToken: "", blockedLicenses: ["GPL-3.0"] },
    prComplexity: { enabled: true, maxLinesChanged: 1000, maxFilesChanged: 10, reviewTimeoutDays: 5 },
    env: { enabled: true, secretPatterns: [] },
    buildPerf: { enabled: true, bottleneckThresholdPct: 40 },
  },
  scoring: { weights: { security: 20, quality: 18, cicd: 15, flakiness: 14, env: 13, buildPerf: 10, docs: 6, prComplexity: 4 }, failUnder: 50 },
  docUpdater: { mode: "direct" },
};
`;
    writeFileSync(join(TEST_DIR, "project-health.config.ts"), configContent);

    const { createConfigManager } = await import("../src/config/index.js");
    const manager = createConfigManager(TEST_DIR);
    const config = await manager.load();

    expect(config.scoring.failUnder).toBe(50);
  });
});
