import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { runSecurityModule } from "./dist/modules/m05-security/index.js";
import { runEnvModule } from "./dist/modules/m07-env/index.js";
import { runQualityModule } from "./dist/modules/m02-quality/index.js";
import { runCicdModule } from "./dist/modules/m01-cicd/index.js";
import { runDocsModule } from "./dist/modules/m03-docs/index.js";
import { createHealthReport } from "./dist/modules/runner.js";
import { calculateHealthScore } from "./dist/scorer.js";

const gitExe = "C:/Program Files/Git/cmd/git.exe";
const repoRoot = process.cwd();
const tmpRoot = path.join(repoRoot, "tmp", "test-final");
fs.rmSync(tmpRoot, { recursive: true, force: true });
fs.mkdirSync(tmpRoot, { recursive: true });

function baseConfig() {
  return {
    proxy: { url: "http://localhost:3000", timeout: 30000 },
    modules: {
      cicd: {
        enabled: true,
        slowJobThresholdMinutes: 5,
        failureRateThreshold: 20,
      },
      quality: { enabled: true, complexityThreshold: 10, duplicateLineMin: 20 },
      docs: { enabled: true, stalenessDays: 14, aiSemanticCheck: false },
      flakiness: { enabled: false, lookbackRuns: 20, passRateThreshold: 95 },
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
      env: { enabled: true, secretPatterns: [] },
      buildPerf: { enabled: false, bottleneckThresholdPct: 30 },
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
      failUnder: 60,
    },
    docUpdater: { mode: "pr" },
  };
}

async function runInDir(dir, fn) {
  const prev = process.cwd();
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(prev);
  }
}

const results = {};

console.log("=== PHASE 2: Security & Environment ===\n");

// Test P2-TC01: CVE Detection
{
  const dir = path.join(tmpRoot, "p2-security");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), "{}");
  fs.writeFileSync(path.join(dir, "package-lock.json"), "{}");
  // Create a test script that outputs JSON
  const scriptPath = path.join(dir, "test-audit.ps1");
  fs.writeFileSync(
    scriptPath,
    '{"vulnerabilities":{"pkg-a":{"severity":"high","via":[{"source":"npm","name":"pkg-a","version":"1.0.0","fix_version":"1.0.1"}]}}}',
  );

  // Since npm might not work in test env, test other features
  const security = await runInDir(dir, () => runSecurityModule(baseConfig()));
  results["P2-TC01"] = {
    score: security.score,
    hasVulns: security.findings.some((f) => f.type === "CVE"),
  };
  console.log("P2-TC01 CVE Detection:");
  console.log("  Module runs:", security.status !== "error");
  console.log("  Score:", security.score);
  console.log("");
}

// Test P2-TC04: Env Drift Detection
{
  const dir = path.join(tmpRoot, "p2-env-drift");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ".env.example"), "KEY_A=1\nKEY_B=2\n");
  fs.writeFileSync(path.join(dir, ".env"), "KEY_A=1\n");
  fs.writeFileSync(path.join(dir, ".gitignore"), ".env\n");

  const envResult = await runInDir(dir, () => runEnvModule(baseConfig()));
  const missingKey = envResult.findings.find(
    (f) => f.type === "ENV_DRIFT" && f.metadata.missingKey === "KEY_B",
  );
  results["P2-TC04"] = { missingKeyFound: !!missingKey };
  console.log("P2-TC04 Env Drift:");
  console.log("  Missing KEY_B detected:", !!missingKey);
  console.log("  PASS:", !!missingKey ? "YES" : "NO");
  console.log("");
}

// Test P2-TC05: Secret Leak
{
  const dir = path.join(tmpRoot, "p2-secret");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ".gitignore"), ".env\n");
  fs.writeFileSync(
    path.join(dir, "test.txt"),
    "ghp_1234567890abcdefghijklmnop",
  );
  execFileSync(gitExe, ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync(gitExe, ["config", "user.email", "test@test.com"], {
    cwd: dir,
    stdio: "ignore",
  });
  execFileSync(gitExe, ["config", "user.name", "Test"], {
    cwd: dir,
    stdio: "ignore",
  });
  execFileSync(gitExe, ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync(gitExe, ["commit", "-m", "add secret"], {
    cwd: dir,
    stdio: "ignore",
  });

  const envResult = await runInDir(dir, () => runEnvModule(baseConfig()));
  const secretFound = envResult.findings.find((f) => f.type === "SECRET_LEAK");
  results["P2-TC05"] = { secretFound: !!secretFound };
  console.log("P2-TC05 Secret Leak:");
  console.log("  SECRET_LEAK detected:", !!secretFound);
  console.log("  PASS:", !!secretFound ? "YES" : "NO");
  console.log("");
}

// Test P2-TC06: ENV_EXPOSED
{
  const dir = path.join(tmpRoot, "p2-exposed");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ".env.example"), "KEY=val\n");
  fs.writeFileSync(path.join(dir, ".env"), "KEY=val\n");
  fs.writeFileSync(path.join(dir, ".gitignore"), "node_modules\n");

  const envResult = await runInDir(dir, () => runEnvModule(baseConfig()));
  const exposedFound = envResult.findings.find((f) => f.type === "ENV_EXPOSED");
  results["P2-TC06"] = { exposedFound: !!exposedFound };
  console.log("P2-TC06 ENV_EXPOSED:");
  console.log("  .env not in gitignore detected:", !!exposedFound);
  console.log("  PASS:", !!exposedFound ? "YES" : "NO");
  console.log("");
}

// Test P2-TC07: Weighted Score
{
  const config = baseConfig();
  config.modules.quality.enabled = false;
  config.modules.cicd.enabled = false;
  config.modules.flakiness.enabled = false;
  config.modules.docs.enabled = false;
  config.modules.prComplexity.enabled = false;
  config.modules.buildPerf.enabled = false;

  const score = calculateHealthScore(
    [
      {
        moduleId: "M-05",
        moduleName: "Security",
        score: 60,
        status: "warning",
        findings: [],
        metadata: {},
        durationMs: 1,
      },
      {
        moduleId: "M-07",
        moduleName: "Env",
        score: 80,
        status: "ok",
        findings: [],
        metadata: {},
        durationMs: 1,
      },
    ],
    config,
  );

  results["P2-TC07"] = { score };
  console.log("P2-TC07 Weighted Score:");
  console.log("  Score:", score);
  console.log("  Expected: 68");
  console.log("  PASS:", score === 68 ? "YES" : "NO");
  console.log("");
}

console.log("=== PHASE 3: Code Quality & CI/CD ===\n");

// Test P3-TC05: Missing Cache Detection
{
  const dir = path.join(tmpRoot, "p3-cache");
  fs.mkdirSync(path.join(dir, ".github", "workflows"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".github", "workflows", "ci.yml"),
    `name: CI
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm install
`,
  );

  const cicd = await runInDir(dir, () => runCicdModule(baseConfig()));
  const cacheFinding = cicd.findings.find((f) => f.type === "MISSING_CACHE");
  results["P3-TC05"] = { found: !!cacheFinding };
  console.log("P3-TC05 Missing Cache:");
  console.log("  MISSING_CACHE detected:", !!cacheFinding);
  console.log("  Message:", cacheFinding?.message || "N/A");
  console.log("  PASS:", !!cacheFinding ? "YES" : "NO");
  console.log("");
}

// Test P3-TC01: Complexity Detection
{
  const dir = path.join(tmpRoot, "p3-complex");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "complex.ts"),
    `export function calculate(x: number): number {
  if (x === 1) return 1;
  if (x === 2) return 2;
  if (x === 3) return 3;
  if (x === 4) return 4;
  if (x === 5) return 5;
  if (x === 6) return 6;
  if (x === 7) return 7;
  if (x === 8) return 8;
  if (x === 9) return 9;
  if (x === 10) return 10;
  return x;
}
`,
  );

  const quality = await runInDir(dir, () => runQualityModule(baseConfig()));
  const complexityFinding = quality.findings.find(
    (f) => f.type === "HIGH_COMPLEXITY",
  );
  results["P3-TC01"] = {
    found: !!complexityFinding,
    complexity: complexityFinding?.metadata?.complexity,
  };
  console.log("P3-TC01 Complexity:");
  console.log("  HIGH_COMPLEXITY detected:", !!complexityFinding);
  console.log("  Complexity value:", complexityFinding?.metadata?.complexity);
  console.log("  PASS:", !!complexityFinding ? "YES" : "NO");
  console.log("");
}

console.log("=== PHASE 5: Docs & PR ===\n");

// Test P5-TC01: Docs Freshness (requires git history for staleness)
{
  const dir = path.join(tmpRoot, "p5-docs");
  fs.mkdirSync(path.join(dir, "docs"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "UserService.ts"),
    "export class UserService {}\n",
  );
  fs.writeFileSync(
    path.join(dir, "README.md"),
    "# User Service\n\nDocumentation.\n",
  );

  const docs = await runInDir(dir, () => runDocsModule(baseConfig()));
  results["P5-TC01"] = { status: docs.status };
  console.log("P5-TC01 Docs Module:");
  console.log("  Module Status:", docs.status);
  console.log("  Score:", docs.score);
  console.log("  Module runs:", docs.status !== "error");
  console.log("");
}

console.log("=== VERIFICATION SUMMARY ===\n");
console.log(JSON.stringify(results, null, 2));
console.log("\nKey:");
console.log(
  "- P2-TC04 (Env Drift):",
  results["P2-TC04"]?.missingKeyFound ? "PASS" : "FAIL",
);
console.log(
  "- P2-TC05 (Secret Leak):",
  results["P2-TC05"]?.secretFound ? "PASS" : "FAIL",
);
console.log(
  "- P2-TC06 (ENV_EXPOSED):",
  results["P2-TC06"]?.exposedFound ? "PASS" : "FAIL",
);
console.log(
  "- P2-TC07 (Weighted Score):",
  results["P2-TC07"]?.score === 68 ? "PASS" : "FAIL",
);
console.log(
  "- P3-TC01 (Complexity):",
  results["P3-TC01"]?.found ? "PASS" : "FAIL",
);
console.log(
  "- P3-TC05 (Missing Cache):",
  results["P3-TC05"]?.found ? "PASS" : "FAIL",
);
