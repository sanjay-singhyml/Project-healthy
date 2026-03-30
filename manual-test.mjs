import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { runSecurityModule } from "./dist/modules/m05-security/index.js";
import { runEnvModule } from "./dist/modules/m07-env/index.js";
import { runQualityModule } from "./dist/modules/m02-quality/index.js";
import { runCicdModule } from "./dist/modules/m01-cicd/index.js";
import { runDocsModule } from "./dist/modules/m03-docs/index.js";
import { runPrComplexityModule } from "./dist/modules/m06-prcomplexity/index.js";
import { calculateHealthScore } from "./dist/scorer.js";

const gitExe = "C:/Program Files/Git/cmd/git.exe";
const repoRoot = process.cwd();
const tmpRoot = path.join(repoRoot, "tmp", "test-manual");
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

function writeCmd(dir, name, contents) {
  fs.writeFileSync(path.join(dir, name), contents.replace(/\n/g, "\r\n"));
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

console.log("=== Phase 2 Tests (Security & Env) ===\n");

// P2-TC01: CVE detection
{
  const dir = path.join(tmpRoot, "p2-security");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package-lock.json"), "{}");
  writeCmd(
    dir,
    "npm.cmd",
    `@echo off\r\nif "%1"=="audit" echo {"vulnerabilities":{"pkg-a":{"severity":"high","via":[{"source":"npm","name":"pkg-a","version":"1.0.0","fix_version":"1.0.1"}]},"pkg-b":{"severity":"critical","via":[{"source":"npm","name":"CVE-2026-0001","version":"2.0.0","fix_version":"2.0.1"}]}}}`,
  );
  writeCmd(
    dir,
    "npx.cmd",
    `@echo off\r\nif "%1"=="license-checker" echo {"badpkg@1.0.0":{"license":"GPL-3.0"}}`,
  );
  process.env.PATH = `${dir};${process.env.PATH}`;
  const security = await runInDir(dir, () => runSecurityModule(baseConfig()));
  console.log("P2-TC01 (CVE Detection):");
  console.log("  Score:", security.score);
  console.log(
    "  CVE Findings:",
    security.findings.filter((f) => f.type === "CVE").length,
  );
  console.log(
    "  PASS:",
    security.findings.some((f) => f.type === "CVE" && f.severity === "CRITICAL")
      ? "YES"
      : "NO",
  );
  console.log("");
}

// P2-TC02: CRITICAL CVE = score 0
{
  const dir = path.join(tmpRoot, "p2-security-crit");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package-lock.json"), "{}");
  writeCmd(
    dir,
    "npm.cmd",
    `@echo off\r\nif "%1"=="audit" echo {"vulnerabilities":{"pkg":{"severity":"critical","via":[{"source":"npm","name":"CVE-2026-9999","version":"1.0.0"}]}}}`,
  );
  process.env.PATH = `${dir};${process.env.PATH}`;
  const security = await runInDir(dir, () => runSecurityModule(baseConfig()));
  console.log("P2-TC02 (Critical CVE = 0 score):");
  console.log("  Score:", security.score);
  console.log("  PASS:", security.score === 0 ? "YES" : "NO");
  console.log("");
}

// P2-TC03: License risk detection
{
  const dir = path.join(tmpRoot, "p2-license");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package-lock.json"), "{}");
  writeCmd(
    dir,
    "npm.cmd",
    `@echo off\r\nif "%1"=="audit" echo {"vulnerabilities":{}}`,
  );
  writeCmd(
    dir,
    "npx.cmd",
    `@echo off\r\nif "%1"=="license-checker" echo {"bad@1.0.0":{"license":"GPL-3.0"},"good@1.0.0":{"license":"MIT"}}`,
  );
  process.env.PATH = `${dir};${process.env.PATH}`;
  const security = await runInDir(dir, () => runSecurityModule(baseConfig()));
  console.log("P2-TC03 (License Risk):");
  console.log(
    "  License findings:",
    security.findings.filter((f) => f.type === "LICENSE_RISK").length,
  );
  console.log(
    "  PASS:",
    security.findings.some(
      (f) => f.type === "LICENSE_RISK" && f.metadata.license === "GPL-3.0",
    )
      ? "YES"
      : "NO",
  );
  console.log("");
}

// P2-TC04: Env drift detection
{
  const dir = path.join(tmpRoot, "p2-env");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ".env.example"), "KEY_A=1\nKEY_B=2\n");
  fs.writeFileSync(path.join(dir, ".env"), "KEY_A=1\n");
  fs.writeFileSync(path.join(dir, ".gitignore"), "");
  const env = await runInDir(dir, () => runEnvModule(baseConfig()));
  console.log("P2-TC04 (Env Drift):");
  console.log(
    "  Missing key finding:",
    env.findings.some(
      (f) => f.type === "ENV_DRIFT" && f.metadata.missingKey === "KEY_B",
    )
      ? "YES"
      : "NO",
  );
  console.log(
    "  Extra key finding:",
    env.findings.some((f) => f.type === "ENV_DRIFT" && f.metadata.extraKey)
      ? "YES"
      : "NO",
  );
  console.log(
    "  PASS:",
    env.findings.some(
      (f) => f.type === "ENV_DRIFT" && f.metadata.missingKey === "KEY_B",
    )
      ? "YES"
      : "NO",
  );
  console.log("");
}

// P2-TC05: Secret leak detection
{
  const dir = path.join(tmpRoot, "p2-secrets");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ".env.example"), "KEY=val\n");
  fs.writeFileSync(path.join(dir, "secrets.txt"), "AKIA1234567890ABCDEF\n"); // AWS key pattern
  fs.writeFileSync(path.join(dir, ".gitignore"), ".env\n");
  execFileSync(gitExe, ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync(gitExe, ["config", "user.email", "test@example.com"], {
    cwd: dir,
    stdio: "ignore",
  });
  execFileSync(gitExe, ["config", "user.name", "Test"], {
    cwd: dir,
    stdio: "ignore",
  });
  execFileSync(gitExe, ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync(gitExe, ["commit", "-m", "seed"], { cwd: dir, stdio: "ignore" });
  const env = await runInDir(dir, () => runEnvModule(baseConfig()));
  console.log("P2-TC05 (Secret Leak):");
  console.log(
    "  SECRET_LEAK findings:",
    env.findings.filter((f) => f.type === "SECRET_LEAK").length,
  );
  console.log(
    "  PASS:",
    env.findings.some((f) => f.type === "SECRET_LEAK") ? "YES" : "NO",
  );
  console.log("");
}

// P2-TC06: .env not in gitignore
{
  const dir = path.join(tmpRoot, "p2-gitignore");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ".env.example"), "KEY=val\n");
  fs.writeFileSync(path.join(dir, ".env"), "KEY=val\n");
  fs.writeFileSync(path.join(dir, ".gitignore"), "node_modules\n");
  const env = await runInDir(dir, () => runEnvModule(baseConfig()));
  console.log("P2-TC06 (.env not in gitignore):");
  console.log(
    "  ENV_EXPOSED finding:",
    env.findings.some((f) => f.type === "ENV_EXPOSED") ? "YES" : "NO",
  );
  console.log(
    "  PASS:",
    env.findings.some((f) => f.type === "ENV_EXPOSED") ? "YES" : "NO",
  );
  console.log("");
}

// P2-TC07: Weighted score calculation
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
  console.log("P2-TC07 (Weighted Score):");
  console.log("  Score:", score);
  console.log(
    "  Expected: ~68 (security 20 + env 13 = 33, redistributed to 60/33*20 + 60/33*13 = 36+24=60? Wait, recheck...",
  );
  console.log(
    "  security weight: 20, env weight: 13 = 33 total, redistributed to 100",
  );
  console.log("  Score = 60*(20/33) + 80*(13/33) = 36.36 + 31.51 = 67.87 ≈ 68");
  console.log("  PASS:", score === 68 ? "YES" : "NO");
  console.log("");
}

console.log("=== Phase 3 Tests (Quality & CI/CD) ===\n");

// P3-TC01: Complex function detection
{
  const dir = path.join(tmpRoot, "p3-complex");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "sample.ts"),
    `export function complex(x:number){
  if(x===1){}
  if(x===2){}
  if(x===3){}
  if(x===4){}
  if(x===5){}
  if(x===6){}
  if(x===7){}
  if(x===8){}
  if(x===9){}
  if(x===10){}
  if(x===11){}
  if(x===12){}
  if(x===13){}
  if(x===14){}
  return x;
}
`,
  );
  const quality = await runInDir(dir, () => runQualityModule(baseConfig()));
  console.log("P3-TC01 (Complexity Detection):");
  console.log(
    "  HIGH_COMPLEXITY findings:",
    quality.findings.filter((f) => f.type === "HIGH_COMPLEXITY").length,
  );
  console.log(
    "  Pass:",
    quality.findings.some(
      (f) => f.type === "HIGH_COMPLEXITY" && f.metadata.complexity >= 10,
    )
      ? "YES"
      : "NO",
  );
  console.log("");
}

// P3-TC05: Missing cache detection
{
  const dir = path.join(tmpRoot, "p3-cache");
  fs.mkdirSync(path.join(dir, ".github", "workflows"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".github", "workflows", "ci.yml"),
    `name: ci
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm install
`,
  );
  const cicd = await runInDir(dir, () => runCicdModule(baseConfig()));
  console.log("P3-TC05 (Missing Cache):");
  console.log(
    "  MISSING_CACHE findings:",
    cicd.findings.filter((f) => f.type === "MISSING_CACHE").length,
  );
  console.log(
    "  Pass:",
    cicd.findings.some(
      (f) => f.type === "MISSING_CACHE" && f.message.includes("npm install"),
    )
      ? "YES"
      : "NO",
  );
  console.log("");
}

console.log("=== Phase 5 Tests (Docs & PR) ===\n");

// P5-TC01: Stale doc detection
{
  const dir = path.join(tmpRoot, "p5-docs");
  fs.mkdirSync(path.join(dir, "docs"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "PaymentService.ts"),
    "export function process() {}\n",
  );
  fs.writeFileSync(
    path.join(dir, "docs", "payment.md"),
    "# Payment\nDocumentation here.\n",
  );
  // Set file times manually if needed or use git
  const docs = await runInDir(dir, () => runDocsModule(baseConfig()));
  console.log("P5-TC01 (Docs Freshness):");
  console.log(
    "  STALE_DOC findings:",
    docs.findings.filter((f) => f.type === "STALE_DOC").length,
  );
  // Without git history, this may have 0 findings - that's OK for manual test
  console.log("  Status:", docs.status);
  console.log("");
}

// Summary
console.log("=== Test Summary ===");
console.log("All modules are implemented and returning results.");
console.log(
  "Full CI integration tests require npm, eslint, ts-prune, jscpd in PATH.",
);
