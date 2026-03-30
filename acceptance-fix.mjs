import fs from 'node:fs';
import path from 'node:path';
import { runSecurityModule } from './dist/modules/m05-security/index.js';
import { runQualityModule } from './dist/modules/m02-quality/index.js';

const repoRoot = process.cwd();
const tmpRoot = path.join(repoRoot, 'tmp', 'acceptance-fix');
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
    scoring: { weights: { security: 20, quality: 18, cicd: 15, flakiness: 14, env: 13, buildPerf: 10, docs: 6, prComplexity: 4 }, failUnder: 60 },
    docUpdater: { mode: 'pr' },
  };
}

function writeCmd(dir, name, contents) {
  fs.writeFileSync(path.join(dir, name), contents.replace(/\n/g, '\r\n'));
}

async function runInDir(dir, fn) {
  const prev = process.cwd();
  process.chdir(dir);
  try { return await fn(); } finally { process.chdir(prev); }
}

const results = {};

{
  const dir = path.join(tmpRoot, 'security');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}');
  writeCmd(dir, 'npm.cmd', `@echo off\nif "%1"=="audit" (\n  echo {"vulnerabilities":{"pkg-a":{"severity":"high","via":[{"source":"npm","name":"pkg-a","version":"1.0.0","fix_version":"1.0.1"}]},"pkg-b":{"severity":"critical","via":[{"source":"npm","name":"pkg-b","version":"2.0.0","fix_version":"2.0.1"}]}}}\n  exit /b 0\n)\nexit /b 0`);
  writeCmd(dir, 'npx.cmd', `@echo off\nif "%1"=="license-checker" (\n  echo {"badpkg@1.0.0":{"license":"GPL-3.0"}}\n  exit /b 0\n)\nexit /b 0`);
  process.env.PATH = `${dir};${process.env.PATH}`;
  const security = await runInDir(dir, () => runSecurityModule(baseConfig()));
  results.security = { score: security.score, findings: security.findings.map(f => ({ type: f.type, severity: f.severity, message: f.message, metadata: f.metadata })) };
}

{
  const dir = path.join(tmpRoot, 'quality');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'sample.ts'), `export function complex(x:number){\n  if(x===1){}\n  if(x===2){}\n  if(x===3){}\n  if(x===4){}\n  if(x===5){}\n  if(x===6){}\n  if(x===7){}\n  if(x===8){}\n  if(x===9){}\n  if(x===10){}\n  if(x===11){}\n  if(x===12){}\n  if(x===13){}\n  if(x===14){}\n  return x;\n}\n`);
  writeCmd(dir, 'npx.cmd', `@echo off\nif "%1"=="eslint" (\n  echo [{"filePath":"sample.ts","messages":[{"severity":2,"ruleId":"no-unused-vars","line":1,"column":1,"message":"Unused var"},{"severity":2,"ruleId":"semi","line":2,"column":1,"message":"Missing semicolon"},{"severity":1,"ruleId":"quotes","line":3,"column":1,"message":"Wrong quotes"}]}]\n  exit /b 0\n)\nif "%1"=="ts-prune" (\n  echo sample.ts:20: deadOne - deadOne (used in module)\n  echo sample.ts:21: deadTwo - deadTwo (used in module)\n  echo sample.ts:22: deadThree - deadThree (used in module)\n  exit /b 0\n)\nif "%1"=="jscpd" (\n  echo {"duplicates":[{"firstFile":"a.ts","secondFile":"b.ts","firstStart":1,"secondStart":1,"lines":25}]}\n  exit /b 0\n)\nexit /b 0`);
  process.env.PATH = `${dir};${process.env.PATH}`;
  const quality = await runInDir(dir, () => runQualityModule(baseConfig()));
  results.quality = { score: quality.score, findings: quality.findings.map(f => ({ type: f.type, severity: f.severity, file: f.file ?? null, line: f.line ?? null, message: f.message, metadata: f.metadata })) };
}

console.log(JSON.stringify(results, null, 2));
