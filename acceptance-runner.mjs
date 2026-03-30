import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runSecurityModule } from './dist/modules/m05-security/index.js';
import { runEnvModule } from './dist/modules/m07-env/index.js';
import { runQualityModule } from './dist/modules/m02-quality/index.js';
import { runCicdModule } from './dist/modules/m01-cicd/index.js';
import { runFlakinessModule } from './dist/modules/m04-flakiness/index.js';
import { calculateHealthScore } from './dist/scorer.js';
import { runAllModules } from './dist/modules/runner.js';

const gitExe = 'C:/Program Files/Git/cmd/git.exe';
const repoRoot = process.cwd();
const tmpRoot = path.join(repoRoot, 'tmp', 'acceptance');
fs.rmSync(tmpRoot, { recursive: true, force: true });
fs.mkdirSync(tmpRoot, { recursive: true });

function baseConfig() {
  return {
    proxy: { url: 'http://localhost:3000', timeout: 30000 },
    modules: {
      cicd: { enabled: true, slowJobThresholdMinutes: 5, failureRateThreshold: 20 },
      quality: { enabled: true, complexityThreshold: 10, duplicateLineMin: 20 },
      docs: { enabled: false, stalenessDays: 14, aiSemanticCheck: false },
      flakiness: { enabled: false, lookbackRuns: 20, passRateThreshold: 95 },
      security: { enabled: true, blockedLicenses: ['GPL', 'AGPL', 'UNLICENSED'] },
      prComplexity: { enabled: false, maxLinesChanged: 500, maxFilesChanged: 5, reviewTimeoutDays: 3 },
      env: { enabled: true, secretPatterns: [] },
      buildPerf: { enabled: false, bottleneckThresholdPct: 30 },
    },
    scoring: {
      weights: { security: 20, quality: 18, cicd: 15, flakiness: 14, env: 13, buildPerf: 10, docs: 6, prComplexity: 4 },
      failUnder: 60,
    },
    docUpdater: { mode: 'pr' },
  };
}

function writeCmd(dir, name, contents) {
  fs.writeFileSync(path.join(dir, name), contents.replace(/\n/g, '\r\n'));
}

function writeFlakinessHistory(dir, runs) {
  const cacheDir = path.join(dir, '.ph-cache', 'flakiness');
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(
    path.join(cacheDir, 'history.json'),
    JSON.stringify(
      {
        projectRoot: dir,
        runs,
        lastScanTimestamp: '2026-01-01T00:00:00.000Z',
      },
      null,
      2,
    ),
  );
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

{
  const dir = path.join(tmpRoot, 'p2-security');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}');
  writeCmd(dir, 'npm.cmd', `@echo off\nif "%~1"=="audit" echo {"vulnerabilities":{"pkg-a":{"severity":"high","via":[{"source":"npm","name":"pkg-a","version":"1.0.0","fix_version":"1.0.1"}]},"pkg-b":{"severity":"critical","via":[{"source":"npm","name":"CVE-2026-0001","version":"2.0.0","fix_version":"2.0.1"}]}}}`);
  writeCmd(dir, 'npx.cmd', `@echo off\nif "%~1"=="license-checker" echo {"badpkg@1.0.0":{"license":"GPL-3.0"}}`);
  process.env.PATH = `${dir};${process.env.PATH}`;
  const security = await runInDir(dir, () => runSecurityModule(baseConfig()));
  results.p2_tc01 = security.findings.filter(f => f.type === 'CVE').map(f => ({ severity: f.severity, package: f.metadata.package, version: f.metadata.version, cveId: f.metadata.cveId ?? null, fixVersion: f.metadata.fixVersion ?? null }));
  results.p2_tc02 = security.score;
  results.p2_tc03 = security.findings.filter(f => f.type === 'LICENSE_RISK').map(f => ({ severity: f.severity, package: f.metadata.package, license: f.metadata.license }));
}

{
  const dir = path.join(tmpRoot, 'p2-env');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.env.example'), 'KEY_A=1\nKEY_B=2\n');
  fs.writeFileSync(path.join(dir, '.env'), 'KEY_A=1\n');
  fs.writeFileSync(path.join(dir, 'secrets.txt'), 'AKIA1234567890ABCDEF\n');
  execFileSync(gitExe, ['init'], { cwd: dir, stdio: 'ignore' });
  execFileSync(gitExe, ['config', 'user.email', 'test@example.com'], { cwd: dir, stdio: 'ignore' });
  execFileSync(gitExe, ['config', 'user.name', 'Test User'], { cwd: dir, stdio: 'ignore' });
  execFileSync(gitExe, ['add', '.'], { cwd: dir, stdio: 'ignore' });
  execFileSync(gitExe, ['commit', '-m', 'seed'], { cwd: dir, stdio: 'ignore' });
  const envResult = await runInDir(dir, () => runEnvModule(baseConfig()));
  results.p2_tc04 = envResult.findings.filter(f => f.type === 'ENV_DRIFT').map(f => ({ message: f.message, missingKey: f.metadata.missingKey ?? null, extraKey: f.metadata.extraKey ?? null }));
  results.p2_tc05 = envResult.findings.filter(f => f.type === 'SECRET_LEAK').map(f => ({ pattern: f.metadata.pattern, commit: f.metadata.commit, file: f.file ?? null }));
  results.p2_tc06 = envResult.findings.filter(f => f.type === 'ENV_EXPOSED').map(f => ({ message: f.message }));
}

{
  const config = baseConfig();
  config.modules.quality.enabled = false;
  config.modules.cicd.enabled = false;
  config.modules.flakiness.enabled = false;
  config.modules.docs.enabled = false;
  config.modules.prComplexity.enabled = false;
  config.modules.buildPerf.enabled = false;
  const score = calculateHealthScore([
    { moduleId: 'M-05', moduleName: 'Dependency Security', score: 60, status: 'warning', findings: [], metadata: {}, durationMs: 1 },
    { moduleId: 'M-07', moduleName: 'Environment Integrity', score: 80, status: 'ok', findings: [], metadata: {}, durationMs: 1 },
  ], config);
  results.p2_tc07 = score;
}

{
  const dir = path.join(tmpRoot, 'p3-quality');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), '{}');
  fs.writeFileSync(path.join(dir, 'tsconfig.json'), '{}');
  fs.writeFileSync(path.join(dir, 'sample.ts'), `export function complex(x:number){\n  if(x===1){}\n  if(x===2){}\n  if(x===3){}\n  if(x===4){}\n  if(x===5){}\n  if(x===6){}\n  if(x===7){}\n  if(x===8){}\n  if(x===9){}\n  if(x===10){}\n  if(x===11){}\n  if(x===12){}\n  if(x===13){}\n  if(x===14){}\n  return x;\n}\n`);
  writeCmd(dir, 'npx.cmd', `@echo off\nif "%~1"=="eslint" (\n  echo [{"filePath":"sample.ts","messages":[{"severity":2,"ruleId":"no-unused-vars","line":1,"column":1,"message":"Unused var"},{"severity":2,"ruleId":"semi","line":2,"column":1,"message":"Missing semicolon"},{"severity":1,"ruleId":"quotes","line":3,"column":1,"message":"Wrong quotes"}]}]\n  exit /b 0\n)\nif "%~1"=="ts-prune" (\n  echo sample.ts:20: deadOne - deadOne ^(used in module^)\n  echo sample.ts:21: deadTwo - deadTwo ^(used in module^)\n  echo sample.ts:22: deadThree - deadThree ^(used in module^)\n  exit /b 0\n)\nif "%~1"=="jscpd" (\n  echo {"duplicates":[{"firstFile":"a.ts","secondFile":"b.ts","firstStart":1,"secondStart":1,"lines":25}]}\n  exit /b 0\n)\nif "%~2"=="complexity-report-es" (\n  echo {"reports":[{"path":"sample.ts","functions":[{"name":"complex","cyclomatic":15,"line":1}]}]}\n  exit /b 0\n)\nexit /b 0`);
  process.env.PATH = `${dir};${process.env.PATH}`;
  const quality = await runInDir(dir, () => runQualityModule(baseConfig()));
  results.p3_tc01 = quality.findings.filter(f => f.type === 'HIGH_COMPLEXITY' && f.metadata.complexity).map(f => ({ message: f.message, complexity: f.metadata.complexity }));
  results.p3_tc02 = quality.findings.filter(f => f.metadata.rule).map(f => ({ severity: f.severity, rule: f.metadata.rule, file: f.file, line: f.line, message: f.message }));
  results.p3_tc03 = quality.findings.filter(f => f.type === 'DUPLICATE_CODE').map(f => ({ file: f.file, lines: f.metadata.lines, secondFile: f.metadata.secondFile }));
  results.p3_tc06 = quality.findings.filter(f => f.type === 'DEAD_EXPORT').map(f => ({ file: f.file, line: f.line, message: f.message }));
}

{
  const dir = path.join(tmpRoot, 'p3-cicd');
  fs.mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.github', 'workflows', 'ci.yml'), `name: ci\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: npm install\n`);
  execFileSync(gitExe, ['init'], { cwd: dir, stdio: 'ignore' });
  execFileSync(gitExe, ['remote', 'add', 'origin', 'https://github.com/mockOwner/mockRepo.git'], { cwd: dir, stdio: 'ignore' });
  const cicd = await runInDir(dir, () => runCicdModule(baseConfig()));
  results.p3_tc05 = cicd.findings.filter(f => f.type === 'MISSING_CACHE').map(f => ({ file: f.file, message: f.message, job: f.metadata.job ?? null }));
  results.p3_tc04 = cicd.findings.filter(f => f.type === 'SLOW_JOB').map(f => ({ avgMinutes: f.metadata.avgMinutes, file: f.file }));
}

{
  const dir = path.join(tmpRoot, 'p4-flakiness');
  fs.mkdirSync(path.join(dir, 'tests', 'auth'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'tests', 'auth', 'LoginSuite.ts'), 'export {};');
  writeFlakinessHistory(dir, [
    {
      timestamp: '2026-01-01T00:00:00.000Z',
      commitHash: 'a1',
      test: 'login',
      classname: 'auth.LoginSuite',
      passed: true,
    },
    {
      timestamp: '2026-01-02T00:00:00.000Z',
      commitHash: 'a2',
      test: 'login',
      classname: 'auth.LoginSuite',
      passed: true,
    },
    {
      timestamp: '2026-01-03T00:00:00.000Z',
      commitHash: 'a3',
      test: 'login',
      classname: 'auth.LoginSuite',
      passed: false,
    },
  ]);

  const config = baseConfig();
  config.modules.flakiness.enabled = true;
  const flakiness = await runInDir(dir, () => runFlakinessModule(config));
  results.p4_tc01 = flakiness.findings
    .filter(f => f.type === 'FLAKY_TEST')
    .map(f => ({
      severity: f.severity,
      message: f.message,
      passRatePct: f.metadata.passRatePct ?? null,
      thresholdPct: f.metadata.thresholdPct ?? null,
      test: f.metadata.test ?? null,
      groupKeys: Object.keys(flakiness.metadata.groups ?? {}),
    }));
}

{
  const config = baseConfig();
  const modules = new Map([
    ['M-01', async () => { await new Promise(r => setTimeout(r, 200)); return { moduleId: 'M-01', moduleName: 'CI/CD Pipeline', score: 100, status: 'ok', findings: [], metadata: {}, durationMs: 200 }; }],
    ['M-02', async () => { await new Promise(r => setTimeout(r, 200)); return { moduleId: 'M-02', moduleName: 'Code Quality', score: 100, status: 'ok', findings: [], metadata: {}, durationMs: 200 }; }],
    ['M-03', async () => ({ moduleId: 'M-03', moduleName: 'Docs Freshness', score: 100, status: 'ok', findings: [], metadata: {}, durationMs: 0 })],
    ['M-04', runFlakinessModule],
    ['M-05', async () => { await new Promise(r => setTimeout(r, 200)); return { moduleId: 'M-05', moduleName: 'Dependency Security', score: 100, status: 'ok', findings: [], metadata: {}, durationMs: 200 }; }],
    ['M-06', async () => ({ moduleId: 'M-06', moduleName: 'PR Complexity', score: 100, status: 'ok', findings: [], metadata: {}, durationMs: 0 })],
    ['M-07', async () => { await new Promise(r => setTimeout(r, 200)); return { moduleId: 'M-07', moduleName: 'Environment Integrity', score: 100, status: 'ok', findings: [], metadata: {}, durationMs: 200 }; }],
    ['M-08', async () => ({ moduleId: 'M-08', moduleName: 'Build Performance', score: 100, status: 'ok', findings: [], metadata: {}, durationMs: 0 })],
  ]);
  const start = Date.now();
  await runAllModules(config, modules);
  results.p3_tc07 = Date.now() - start;
}

console.log(JSON.stringify(results, null, 2));
