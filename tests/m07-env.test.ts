// Comprehensive test suite for M-07 Environment Integrity module
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

const DEFAULT_CONFIG = {
  proxy: { url: "http://localhost:3000", timeout: 30000 },
  modules: {
    cicd: {
      enabled: true,
      slowJobThresholdMinutes: 5,
      failureRateThreshold: 0.2,
    },
    quality: { enabled: true, complexityThreshold: 10, duplicateLineMin: 20 },
    docs: { enabled: true, stalenessDays: 14, aiSemanticCheck: false },
    flakiness: { enabled: true, lookbackRuns: 20, passRateThreshold: 0.95 },
    security: { enabled: true, blockedLicenses: ["GPL-3.0", "AGPL-3.0"] },
    prComplexity: {
      enabled: true,
      maxLinesChanged: 500,
      maxFilesChanged: 5,
      reviewTimeoutDays: 3,
    },
    env: { enabled: true, secretPatterns: [] },
    buildPerf: { enabled: true, bottleneckThresholdPct: 30 },
  },
  scoring: {
    weights: {
      security: 20,
      quality: 18,
      cicd: 15,
      flakiness: 14,
      env: 13,
      buildPerf: 10,
      docs: 6,
      prComplexity: 4,
    },
    failUnder: 70,
  },
  docUpdater: { mode: "direct" as const },
};

let testIdx = 0;
function getTestDir(): string {
  testIdx++;
  const dir = join(process.cwd(), `.test-m07-${Date.now()}-${testIdx}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function initGit(dir: string) {
  try {
    execSync("git init", { cwd: dir, stdio: "pipe" });
    execSync('git config user.email "test@test.com"', {
      cwd: dir,
      stdio: "pipe",
    });
    execSync('git config user.name "Test User"', { cwd: dir, stdio: "pipe" });
  } catch {
    /* ignore */
  }
}

describe("M-07: Environment Integrity — P2-TC04 through P2-TC06", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("P2-TC04: detects ENV_DRIFT when .env missing keys from .env.example", async () => {
    const TEST_DIR = getTestDir();
    initGit(TEST_DIR);
    writeFileSync(join(TEST_DIR, ".env.example"), "KEY_A=\nKEY_B=\n");
    writeFileSync(join(TEST_DIR, ".env"), "KEY_A=value\n");
    writeFileSync(join(TEST_DIR, ".gitignore"), "");
    execSync('git add . && git commit -m "init"', {
      cwd: TEST_DIR,
      stdio: "pipe",
    });

    vi.spyOn(process, "cwd").mockReturnValue(TEST_DIR);

    const { runEnvModule } = await import("../src/modules/m07-env/index.js");
    const result = await runEnvModule(DEFAULT_CONFIG as any);

    const driftFindings = result.findings.filter((f) => f.type === "ENV_DRIFT");
    expect(driftFindings.length).toBeGreaterThanOrEqual(1);
    const hasKeyB = driftFindings.some(
      (f) =>
        (f.metadata as any)?.missingKey === "KEY_B" ||
        f.message.includes("KEY_B"),
    );
    expect(hasKeyB).toBe(true);
  });

  it("does NOT flag ENV_DRIFT when .env has all keys from .env.example", async () => {
    const TEST_DIR = getTestDir();
    initGit(TEST_DIR);
    writeFileSync(join(TEST_DIR, ".env.example"), "KEY_A=\nKEY_B=\n");
    writeFileSync(join(TEST_DIR, ".env"), "KEY_A=value\nKEY_B=value2\n");
    writeFileSync(join(TEST_DIR, ".gitignore"), "");
    execSync('git add . && git commit -m "init"', {
      cwd: TEST_DIR,
      stdio: "pipe",
    });

    vi.spyOn(process, "cwd").mockReturnValue(TEST_DIR);

    const { runEnvModule } = await import("../src/modules/m07-env/index.js");
    const result = await runEnvModule(DEFAULT_CONFIG as any);

    const driftFindings = result.findings.filter((f) => f.type === "ENV_DRIFT");
    expect(driftFindings.length).toBe(0);
  });

  it("P2-TC05: detects SECRET_LEAK with AWS key pattern in git history", async () => {
    const TEST_DIR = getTestDir();
    initGit(TEST_DIR);
    writeFileSync(
      join(TEST_DIR, "config.txt"),
      "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLX\n",
    );
    writeFileSync(join(TEST_DIR, ".gitignore"), "");
    execSync('git add . && git commit -m "add config"', {
      cwd: TEST_DIR,
      stdio: "pipe",
    });

    vi.spyOn(process, "cwd").mockReturnValue(TEST_DIR);

    const { runEnvModule } = await import("../src/modules/m07-env/index.js");
    const result = await runEnvModule(DEFAULT_CONFIG as any);

    const secretFindings = result.findings.filter(
      (f) => f.type === "SECRET_LEAK",
    );
    expect(secretFindings.length).toBeGreaterThanOrEqual(1);
    expect(secretFindings[0].severity).toBe("CRITICAL");
  });

  it("P2-TC05: detects SECRET_LEAK with GitHub token pattern", async () => {
    const TEST_DIR = getTestDir();
    initGit(TEST_DIR);
    writeFileSync(
      join(TEST_DIR, "secrets.json"),
      '{"token": "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijkl"}\n',
    );
    writeFileSync(join(TEST_DIR, ".gitignore"), "");
    execSync('git add . && git commit -m "add token"', {
      cwd: TEST_DIR,
      stdio: "pipe",
    });

    vi.spyOn(process, "cwd").mockReturnValue(TEST_DIR);

    const { runEnvModule } = await import("../src/modules/m07-env/index.js");
    const result = await runEnvModule(DEFAULT_CONFIG as any);

    const secretFindings = result.findings.filter(
      (f) => f.type === "SECRET_LEAK",
    );
    expect(secretFindings.length).toBeGreaterThanOrEqual(1);
  });

  it("P2-TC06: detects ENV_EXPOSED when .env not in .gitignore", async () => {
    const TEST_DIR = getTestDir();
    initGit(TEST_DIR);
    writeFileSync(join(TEST_DIR, ".env"), "SECRET=value\n");
    writeFileSync(join(TEST_DIR, ".gitignore"), "");
    execSync('git add . && git commit -m "init"', {
      cwd: TEST_DIR,
      stdio: "pipe",
    });

    vi.spyOn(process, "cwd").mockReturnValue(TEST_DIR);

    const { runEnvModule } = await import("../src/modules/m07-env/index.js");
    const result = await runEnvModule(DEFAULT_CONFIG as any);

    const exposedFindings = result.findings.filter(
      (f) => f.type === "ENV_EXPOSED",
    );
    expect(exposedFindings.length).toBeGreaterThanOrEqual(1);
  });

  it("does NOT detect ENV_EXPOSED when .env is in .gitignore", async () => {
    const TEST_DIR = getTestDir();
    initGit(TEST_DIR);
    writeFileSync(join(TEST_DIR, ".env"), "SECRET=value\n");
    writeFileSync(join(TEST_DIR, ".gitignore"), ".env\n");
    execSync('git add . && git commit -m "init"', {
      cwd: TEST_DIR,
      stdio: "pipe",
    });

    vi.spyOn(process, "cwd").mockReturnValue(TEST_DIR);

    const { runEnvModule } = await import("../src/modules/m07-env/index.js");
    const result = await runEnvModule(DEFAULT_CONFIG as any);

    const exposedFindings = result.findings.filter(
      (f) => f.type === "ENV_EXPOSED",
    );
    expect(exposedFindings.length).toBe(0);
  });

  it("does NOT flag secrets from ignored local .env files", async () => {
    const TEST_DIR = getTestDir();
    initGit(TEST_DIR);
    writeFileSync(
      join(TEST_DIR, ".env"),
      "GITHUB_TOKEN=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijkl\n",
    );
    writeFileSync(join(TEST_DIR, ".gitignore"), ".env\n");
    execSync('git add .gitignore && git commit -m "ignore env"', {
      cwd: TEST_DIR,
      stdio: "pipe",
    });

    vi.spyOn(process, "cwd").mockReturnValue(TEST_DIR);

    const { runEnvModule } = await import("../src/modules/m07-env/index.js");
    const result = await runEnvModule(DEFAULT_CONFIG as any);

    const envSecretFindings = result.findings.filter(
      (f) => f.type === "SECRET_LEAK" && f.file === ".env",
    );
    expect(envSecretFindings.length).toBe(0);
  });

  it("does NOT flag regex examples in markdown documentation as live secrets", async () => {
    const TEST_DIR = getTestDir();
    initGit(TEST_DIR);
    writeFileSync(
      join(TEST_DIR, "SECURITY_NOTES.md"),
      [
        "Example patterns:",
        "AKIA[0-9A-Z]{16}",
        "ghp_[A-Za-z0-9_]{36}",
        "-----BEGIN RSA PRIVATE KEY-----",
        "",
      ].join("\n"),
    );
    writeFileSync(join(TEST_DIR, ".gitignore"), "");
    execSync('git add . && git commit -m "add docs"', {
      cwd: TEST_DIR,
      stdio: "pipe",
    });

    vi.spyOn(process, "cwd").mockReturnValue(TEST_DIR);

    const { runEnvModule } = await import("../src/modules/m07-env/index.js");
    const result = await runEnvModule(DEFAULT_CONFIG as any);

    const docSecretFindings = result.findings.filter(
      (f) => f.type === "SECRET_LEAK" && f.file === "SECURITY_NOTES.md",
    );
    expect(docSecretFindings.length).toBe(0);
  });

  it("returns 100 score with no findings", async () => {
    const TEST_DIR = getTestDir();
    initGit(TEST_DIR);
    writeFileSync(join(TEST_DIR, ".env.example"), "KEY_A=\n");
    writeFileSync(join(TEST_DIR, ".env"), "KEY_A=value\n");
    writeFileSync(join(TEST_DIR, ".gitignore"), ".env\n");
    execSync('git add . && git commit -m "init"', {
      cwd: TEST_DIR,
      stdio: "pipe",
    });

    vi.spyOn(process, "cwd").mockReturnValue(TEST_DIR);

    const { runEnvModule } = await import("../src/modules/m07-env/index.js");
    const result = await runEnvModule(DEFAULT_CONFIG as any);

    expect(result.score).toBe(100);
    expect(result.status).toBe("ok");
    expect(result.moduleId).toBe("M-07");
  });

  it("module disabled returns 100 with enabled=false metadata", async () => {
    const TEST_DIR = getTestDir();
    const config = {
      ...DEFAULT_CONFIG,
      modules: {
        ...DEFAULT_CONFIG.modules,
        env: { enabled: false, secretPatterns: [] },
      },
    };

    vi.spyOn(process, "cwd").mockReturnValue(TEST_DIR);

    const { runEnvModule } = await import("../src/modules/m07-env/index.js");
    const result = await runEnvModule(config as any);

    expect(result.score).toBe(100);
    expect(result.metadata).toHaveProperty("enabled", false);
  });

  it("handles missing .env.example gracefully (no crash)", async () => {
    const TEST_DIR = getTestDir();
    writeFileSync(join(TEST_DIR, ".gitignore"), "");

    vi.spyOn(process, "cwd").mockReturnValue(TEST_DIR);

    const { runEnvModule } = await import("../src/modules/m07-env/index.js");
    const result = await runEnvModule(DEFAULT_CONFIG as any);

    expect(result).toBeDefined();
    expect(result.moduleId).toBe("M-07");
    expect(result.moduleName).toBe("Environment Integrity");
  });

  it("includes durationMs in result", async () => {
    const TEST_DIR = getTestDir();
    writeFileSync(join(TEST_DIR, ".gitignore"), "");

    vi.spyOn(process, "cwd").mockReturnValue(TEST_DIR);

    const { runEnvModule } = await import("../src/modules/m07-env/index.js");
    const result = await runEnvModule(DEFAULT_CONFIG as any);

    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});
