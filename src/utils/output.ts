/**
 * output.ts — Terminal Rendering Layer for project-health (ph)
 *
 * Design philosophy: structure through whitespace, colour carries meaning only,
 * hierarchy through type weight, scannable from 5 feet away.
 *
 * All public functions are pure renderers: receive data → print to stdout → return void.
 * No business logic, no API calls, no file reads.
 */

import chalk from 'chalk';
import * as readline from 'node:readline';
import {
  Severity,
  Finding,
  ScoreBand,
  getScoreBand,
  HealthReport,
  ModuleResult,
} from '../types/index.js';
import { analyzeProject, formatProjectOverview } from './project-analyzer.js';

// ─────────────────────────────────────────────────────────────────────────────
// THEME CONSTANTS — single source of truth for all visual tokens
// ─────────────────────────────────────────────────────────────────────────────

export const THEME = {
  // Base typography
  text: '#cdd6f4',
  dimMeta: '#3d4466',
  sectionLabel: '#4a5180',
  border: '#1e2330',

  // Semantic colours
  critical: '#f38ba8',
  warning: '#f9e2af',
  success: '#a6e3a1',
  info: '#89b4fa',
  ai: '#cba6f7',
  accent: '#b4befe',

  // Spacing
  INDENT: '  ',
  SECTION_GAP: '\n',
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────────────────────────────────────

/** Terminal width, clamped to sane bounds */
function cols(): number {
  return Math.max(60, Math.min(process.stdout.columns || 100, 200));
}

/** Horizontal rule adapted to terminal width */
function rule(): string {
  return chalk.hex(THEME.border)('─'.repeat(cols() - 4));
}

/** Semantic colour for a numeric score */
export function scoreColour(score: number): string {
  if (score >= 90) return THEME.success;
  if (score >= 75) return THEME.warning;
  if (score >= 60) return THEME.warning;
  if (score >= 40) return THEME.critical;
  return THEME.critical;
}

/** Score band label */
function scoreBandLabel(score: number): string {
  if (score >= 90) return 'EXCELLENT';
  if (score >= 75) return 'GOOD';
  if (score >= 60) return 'MODERATE';
  if (score >= 40) return 'HIGH RISK';
  return 'CRITICAL';
}

/** Colour for a severity level */
function severityColour(severity: Severity): string {
  switch (severity) {
    case 'CRITICAL': return THEME.critical;
    case 'HIGH':     return THEME.critical;
    case 'MEDIUM':   return THEME.warning;
    case 'LOW':      return THEME.success;
    default:         return THEME.text;
  }
}

/** Dot indicator in severity colour */
function severityDot(severity: Severity): string {
  return chalk.hex(severityColour(severity))('●');
}

/** Wrap text to terminal width with a left-hand prefix */
function wrapText(text: string, prefix: string): string {
  const maxWidth = cols() - 4 - prefix.length;
  const words = text.split(' ');
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    if (current.length + word.length + 1 > maxWidth && current.length > 0) {
      lines.push(prefix + current);
      current = word;
    } else {
      current = current ? current + ' ' + word : word;
    }
  }
  if (current) lines.push(prefix + current);
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION DIVIDER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Print a section divider with a label.
 * @example  ──  top findings  ──────────────────────
 */
export function sectionDivider(label: string): void {
  const left   = chalk.hex(THEME.sectionLabel)(`  ─  ${label}  `);
  const used   = 6 + label.length;
  const remain = Math.max(0, cols() - 4 - used);
  const right  = chalk.hex(THEME.border)('─'.repeat(remain));
  process.stdout.write(`${left}${right}\n`);
}

// ─────────────────────────────────────────────────────────────────────────────
// KEYBOARD HINTS
// ─────────────────────────────────────────────────────────────────────────────

export interface KeyHint { key: string; label: string }

/** Print keyboard hints row — always at the bottom, small and dim */
export function keyboardHints(hints: KeyHint[]): void {
  const parts = hints.map(
    ({ key, label }) =>
      chalk.dim('[') + chalk.hex(THEME.info)(key) + chalk.dim(`] ${label}`)
  );
  process.stdout.write(`\n  ${parts.join(chalk.dim('  '))}\n`);
}

// ─────────────────────────────────────────────────────────────────────────────
// MODULE BAR
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Print a single module bar-chart row.
 * Format:  dim-id  dim-name  ████████░░░░  score
 */
export function moduleBar(moduleId: string, name: string, score: number, delta?: number): void {
  const colour    = scoreColour(score);
  const barMax    = Math.max(10, cols() - 44);
  const filled    = Math.round((score / 100) * barMax);
  const empty     = barMax - filled;

  const idStr   = chalk.dim(moduleId.padEnd(5));
  const nameStr = chalk.dim(name.slice(0, 14).padEnd(14));
  const bar     = chalk.hex(colour)('█'.repeat(filled)) + chalk.hex(THEME.border)('░'.repeat(empty));
  const scoreStr = chalk.hex(colour).bold(score.toString().padStart(3));

  let deltaStr = '';
  if (delta !== undefined) {
    if (delta > 0)       deltaStr = chalk.hex(THEME.success)(` ↑${delta}`);
    else if (delta < 0)  deltaStr = chalk.hex(THEME.critical)(` ↓${Math.abs(delta)}`);
    else                 deltaStr = chalk.dim(' –');
  }

  process.stdout.write(`  ${idStr}${nameStr}  ${bar}  ${scoreStr}${deltaStr}\n`);
}

// ─────────────────────────────────────────────────────────────────────────────
// FINDING RENDERER
// ─────────────────────────────────────────────────────────────────────────────

export function renderFinding(finding: Finding): void {
  const colour = severityColour(finding.severity);

  // Line 1: dot + type
  process.stdout.write(
    `  ${severityDot(finding.severity)}  ${chalk.hex(colour).bold(finding.type)}\n`
  );

  // Line 2: message
  const msgPrefix = `${THEME.INDENT}${THEME.INDENT}`;
  process.stdout.write(wrapText(finding.message, msgPrefix) + '\n');

  // Line 3: module · file:line
  const location = finding.file
    ? `  · ${chalk.hex(THEME.info)(finding.file)}${finding.line ? chalk.dim(':' + finding.line) : ''}`
    : '';
  process.stdout.write(
    `${msgPrefix}${chalk.dim(finding.moduleId)}${location}\n`
  );

  // Line 4: fix suggestion
  if (finding.fix) {
    process.stdout.write(
      `${msgPrefix}${chalk.hex(THEME.success)('→ ')}${chalk.hex(THEME.success)(finding.fix)}\n`
    );
  }

  process.stdout.write('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// SCAN RENDERER
// ─────────────────────────────────────────────────────────────────────────────

export function renderScan(report: HealthReport): void {
  const score  = report.score;
  const colour = scoreColour(score);
  const band   = scoreBandLabel(score);
  const totalMs = report.modules.reduce((s, m) => s + m.durationMs, 0);
  const timeStr = totalMs > 1000 ? `${(totalMs / 1000).toFixed(1)}s` : `${totalMs}ms`;

  // ── Rule
  process.stdout.write('\n');
  process.stdout.write('  ' + rule() + '\n');
  process.stdout.write('\n');

  // ── Big score
  process.stdout.write(
    `  ${chalk.hex(colour).bold(score.toString())}  ` +
    `${chalk.bgHex(colour).hex('#0b0d12').bold(` ${band} `)}  ` +
    `${chalk.dim(`${report.modules.length} modules · ${timeStr} · ph v2.0`)}\n`
  );

  process.stdout.write('\n');

  // ── Module bars
  for (const mod of report.modules) {
    moduleBar(mod.moduleId, mod.moduleName, mod.score);
  }

  process.stdout.write('\n');

  // ── Top findings (up to 5)
  const topFindings = [...report.findings]
    .sort((a, b) => {
      const order: Record<Severity, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
      return order[a.severity] - order[b.severity];
    })
    .slice(0, 5);

  if (topFindings.length > 0) {
    sectionDivider('top findings');
    process.stdout.write('\n');
    for (const finding of topFindings) {
      renderFinding(finding);
    }
  }

  if (report.findings.length > 5) {
    process.stdout.write(
      `  ${chalk.dim(`... and ${report.findings.length - 5} more findings`)}\n`
    );
  }

  process.stdout.write('\n');
  keyboardHints([
    { key: 'r', label: 'refresh' },
    { key: 'a', label: 'ask' },
    { key: 'f', label: 'fix' },
    { key: 'q', label: 'quit' },
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────
// DASHBOARD RENDERER
// ─────────────────────────────────────────────────────────────────────────────

export interface ScanHistory {
  score: number;
  generatedAt: string;
  commitHash?: string;
}

/** Generate a block sparkline for a score series */
function sparkline(scores: number[]): string {
  const BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
  const min = Math.min(...scores);
  const max = Math.max(...scores);

  return scores.map(s => {
    const norm  = max === min ? 1 : (s - min) / (max - min);
    const idx   = Math.round(norm * (BLOCKS.length - 1));
    const block = BLOCKS[idx];
    const col   = scoreColour(s);
    return chalk.hex(col)(block);
  }).join('');
}

let _dashboardInterval: ReturnType<typeof setInterval> | null = null;

export function renderDashboard(report: HealthReport, history: ScanHistory[]): void {
  if (_dashboardInterval) {
    clearInterval(_dashboardInterval);
    _dashboardInterval = null;
  }

  function draw(): void {
    process.stdout.write('\x1b[2J\x1b[H'); // clear screen

    const score   = report.score;
    const colour  = scoreColour(score);
    const band    = scoreBandLabel(score);
    const recentScores = history.slice(-14).map(h => h.score);

    // ── Header: big score + sparkline
    const spark  = recentScores.length > 1 ? '  ' + sparkline(recentScores) : '';
    process.stdout.write('\n');
    process.stdout.write(
      `  ${chalk.hex(colour).bold(score.toString())}  ` +
      `${chalk.bgHex(colour).hex('#0b0d12').bold(` ${band} `)}` +
      `${spark}\n`
    );
    process.stdout.write('\n');
    process.stdout.write('  ' + rule() + '\n');
    process.stdout.write('\n');

    // ── Module bars with deltas
    const prevHistory = history[history.length - 2];
    for (const mod of report.modules) {
      let delta: number | undefined;
      if (prevHistory) {
        // History stores full reports — just use 0 delta if not available
        delta = 0;
      }
      moduleBar(mod.moduleId, mod.moduleName, mod.score, delta);
    }

    process.stdout.write('\n');
    process.stdout.write('  ' + rule() + '\n');
    process.stdout.write('\n');

    // ── Recent activity (last 5 history events)
    sectionDivider('recent activity');
    process.stdout.write('\n');

    const recent = history.slice(-5).reverse();
    for (const entry of recent) {
      const ts    = new Date(entry.generatedAt).toLocaleTimeString();
      const sc    = entry.score;
      const col   = scoreColour(sc);
      const hash  = entry.commitHash ? chalk.dim(` ${entry.commitHash.slice(0, 7)}`) : '';
      process.stdout.write(
        `  ${chalk.dim(ts)}  ${chalk.hex(col).bold(sc.toString().padStart(3))}  ` +
        `${chalk.hex(THEME.sectionLabel)(scoreBandLabel(sc))}${hash}\n`
      );
    }

    if (recent.length === 0) {
      process.stdout.write(`  ${chalk.dim('No scan history yet')}\n`);
    }

    process.stdout.write('\n');
    keyboardHints([
      { key: 'r', label: 'refresh' },
      { key: 'a', label: 'ask' },
      { key: 'f', label: 'fix' },
      { key: 'q', label: 'quit' },
      { key: '↑↓', label: 'navigate' },
    ]);

    process.stdout.write(chalk.dim(`\n  auto-refreshes every 5s\n`));
  }

  draw();
  _dashboardInterval = setInterval(draw, 5000);
}

// ─────────────────────────────────────────────────────────────────────────────
// FIX LIST RENDERER (interactive checkbox picker)
// ─────────────────────────────────────────────────────────────────────────────

export interface AutoFix {
  moduleId: string;
  description: string;
  scoreDelta: number;
  severity: 'safe' | 'manual';
  cveId?: string;
  enabled?: boolean;
}

/**
 * Interactive checkbox picker for `ph fix --auto`.
 * Returns a Promise that resolves to the list of selected fixes.
 */
export async function renderFixList(fixes: AutoFix[]): Promise<AutoFix[]> {
  if (fixes.length === 0) {
    process.stdout.write(`\n  ${chalk.dim('No auto-fixable issues found.')}\n`);
    return [];
  }

  const states: boolean[] = fixes.map((f) => f.severity === 'safe');
  let cursor = 0;

  function renderCheckbox(checked: boolean, isManual: boolean, isSelected: boolean): string {
    const bracket = isSelected
      ? chalk.hex(THEME.info)('[') + (checked ? chalk.hex(THEME.success)('✓') : ' ') + chalk.hex(THEME.info)(']')
      : isManual
        ? chalk.dim('[–]')
        : checked
          ? chalk.dim('[') + chalk.hex(THEME.success)('✓') + chalk.dim(']')
          : chalk.dim('[ ]');
    return bracket;
  }

  function renderList(): void {
    process.stdout.write('\x1b[2J\x1b[H');
    process.stdout.write('\n');
    sectionDivider(`safe fixes (${fixes.filter((_,i) => states[i]).length})`);
    process.stdout.write('\n');

    for (let i = 0; i < fixes.length; i++) {
      const fix       = fixes[i];
      const isManual  = fix.severity === 'manual';
      const isSelected = i === cursor;
      const cb        = renderCheckbox(states[i], isManual, isSelected);
      const idStr     = chalk.dim(fix.moduleId.padEnd(5));
      const desc      = isSelected
        ? chalk.white(fix.description)
        : chalk.hex(THEME.text)(fix.description);
      const delta     = fix.scoreDelta > 0
        ? chalk.hex(THEME.success)(` +${fix.scoreDelta}pts`)
        : chalk.dim(' manual');
      const cve       = fix.cveId ? chalk.dim(` (${fix.cveId})`) : '';

      const line = `  ${cb} ${idStr}  ${desc}${cve}${delta}`;
      process.stdout.write(line + '\n');
    }

    // Summary
    const selected    = fixes.filter((_, i) => states[i]);
    const totalDelta  = selected.reduce((s, f) => s + (f.scoreDelta || 0), 0);

    process.stdout.write('\n');
    sectionDivider('summary');
    process.stdout.write('\n');
    process.stdout.write(
      `  ${chalk.dim('projected delta')}  ` +
      chalk.hex(THEME.success).bold(`+${totalDelta} pts`) + '\n'
    );
    process.stdout.write('\n');

    keyboardHints([
      { key: '↑↓', label: 'navigate' },
      { key: 'space', label: 'toggle' },
      { key: 'enter', label: 'confirm' },
      { key: 'q', label: 'quit' },
    ]);
  }

  return new Promise<AutoFix[]>((resolve) => {
    if (!process.stdin.isTTY) {
      resolve(fixes.filter((_, i) => states[i]));
      return;
    }

    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);

    render();

    function render() { renderList(); }

    process.stdin.on('keypress', function onKey(_ch: unknown, key: { name?: string; sequence?: string }) {
      if (!key) return;

      const fix = fixes[cursor];
      const isManual = fix?.severity === 'manual';

      if (key.name === 'up') {
        cursor = Math.max(0, cursor - 1);
      } else if (key.name === 'down') {
        cursor = Math.min(fixes.length - 1, cursor + 1);
      } else if (key.sequence === ' ' && !isManual) {
        states[cursor] = !states[cursor];
      } else if (key.name === 'return') {
        process.stdin.removeListener('keypress', onKey);
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
        process.stdout.write('\n');
        resolve(fixes.filter((_, i) => states[i]));
        return;
      } else if (key.name === 'q' || (key.name === 'c' && key.sequence === '\x03')) {
        process.stdin.removeListener('keypress', onKey);
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
        process.stdout.write('\n');
        resolve([]);
        return;
      }

      render();
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// COMPARE RENDERER  (ph compare [branch])
// ─────────────────────────────────────────────────────────────────────────────

export function renderCompare(base: HealthReport, head: HealthReport): void {
  const baseCo = scoreColour(base.score);
  const headCo = scoreColour(head.score);
  const delta  = head.score - base.score;

  process.stdout.write('\n');

  // ── Side-by-side scores
  process.stdout.write(
    `  ${chalk.hex(baseCo).bold(base.score.toString())}  ${chalk.dim('→')}  ` +
    `${chalk.hex(headCo).bold(head.score.toString())}  ` +
    (delta > 0
      ? chalk.hex(THEME.success).bold(`▲${delta}pts`)
      : delta < 0
        ? chalk.hex(THEME.critical).bold(`▼${Math.abs(delta)}pts`)
        : chalk.dim('no change')) + '\n'
  );

  process.stdout.write('\n');
  process.stdout.write('  ' + rule() + '\n');

  // ── New findings
  const baseIds = new Set(base.findings.map(f => f.id));
  const headIds = new Set(head.findings.map(f => f.id));

  const newFindings      = head.findings.filter(f => !baseIds.has(f.id));
  const resolvedFindings = base.findings.filter(f => !headIds.has(f.id));
  const unchangedCount   = head.findings.filter(f =>  baseIds.has(f.id)).length;

  if (newFindings.length > 0) {
    process.stdout.write('\n');
    sectionDivider(`new findings (${newFindings.length})`);
    process.stdout.write('\n');
    for (const f of newFindings) {
      const col = severityColour(f.severity);
      process.stdout.write(
        `  ${chalk.hex(THEME.critical)('+')}  ${chalk.hex(col).bold(f.type)}  ` +
        chalk.hex(THEME.text)(f.message) + '\n'
      );
      if (f.file) {
        process.stdout.write(
          `       ${chalk.hex(THEME.info)(f.file)}${f.line ? chalk.dim(':' + f.line) : ''}\n`
        );
      }
    }
  }

  if (resolvedFindings.length > 0) {
    process.stdout.write('\n');
    sectionDivider(`resolved findings (${resolvedFindings.length})`);
    process.stdout.write('\n');
    for (const f of resolvedFindings) {
      process.stdout.write(
        `  ${chalk.hex(THEME.success)('✓')}  ${chalk.dim(f.type)}  ` +
        chalk.dim(f.message) + '\n'
      );
    }
  }

  if (unchangedCount > 0) {
    process.stdout.write('\n');
    process.stdout.write(`  ${chalk.dim(`${unchangedCount} findings unchanged`)}\n`);
  }

  process.stdout.write('\n');
  keyboardHints([
    { key: 'p', label: 'post to PR' },
    { key: 'a', label: 'ask about diff' },
    { key: 'q', label: 'quit' },
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────
// CHAT RENDERER (readline REPL)
// ─────────────────────────────────────────────────────────────────────────────

export interface ChatContext {
  score?: number;
  moduleCount?: number;
  findingCount?: number;
  onMessage: (input: string, history: Array<{role: string; content: string}>) => Promise<AsyncIterable<string> | string>;
  onExit?: () => void;
}

export async function renderChat(ctx: ChatContext): Promise<void> {
  const history: Array<{role: string; content: string}> = [];

  // Session header
  process.stdout.write('\n');
  if (ctx.score !== undefined) {
    process.stdout.write(
      `  ${chalk.dim('score')} ${chalk.hex(scoreColour(ctx.score)).bold(ctx.score.toString())}  ` +
      `${chalk.dim(`${ctx.moduleCount ?? 0} modules · ${ctx.findingCount ?? 0} findings`)}\n`
    );
  }
  process.stdout.write('\n');
  process.stdout.write(chalk.dim('  type your question, or "exit" to quit\n'));
  process.stdout.write('\n');

  const rl = readline.createInterface({
    input:  process.stdin,
    output: process.stdout,
    prompt: chalk.hex(THEME.info)('you') + chalk.dim(' › '),
    historySize: 100,
    terminal: true,
  });

  // Enable cursor
  process.stdout.write('\x1b[?25h');

  rl.prompt();

  rl.on('line', async (rawInput) => {
    const input = rawInput.trim();
    if (!input) { rl.prompt(); return; }
    if (input === 'exit' || input === 'quit') {
      rl.close();
      return;
    }

    history.push({ role: 'user', content: input });

    process.stdout.write('\n');
    process.stdout.write(chalk.hex(THEME.success)(' ph') + chalk.dim(' › '));

    try {
      const response = await ctx.onMessage(input, history);

      let fullContent = '';

      if (typeof response === 'string') {
        // Non-streaming
        process.stdout.write('    ' + response + '\n');
        fullContent = response;
      } else {
        // Streaming — write token by token with left-indent
        let lineStart = true;
        for await (const token of response) {
          if (lineStart) {
            process.stdout.write('    ');
            lineStart = false;
          }
          process.stdout.write(token);
          fullContent += token;
          if (token.includes('\n')) lineStart = true;
        }
        process.stdout.write('\n');
      }

      history.push({ role: 'assistant', content: fullContent });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stdout.write(`\n  ${chalk.hex(THEME.critical)('✗')} ${chalk.dim(msg)}\n`);
    }

    process.stdout.write('\n');
    rl.prompt();
  });

  return new Promise<void>((resolve) => {
    rl.on('close', () => {
      process.stdout.write('\n');
      ctx.onExit?.();
      resolve();
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// INIT RENDERER
// ─────────────────────────────────────────────────────────────────────────────

export interface InitStep {
  label: string;
  run: () => Promise<string>;
}

const LOGO = `
  ██████╗ ██╗  ██╗
  ██╔══██╗██║  ██║
  ██████╔╝███████║
  ██╔═══╝ ██╔══██║
  ██║     ██║  ██║
  ╚═╝     ╚═╝  ╚═╝
`.trimStart();

const PROJECT_HEALTH_LOGO = `
  PPPP   RRRR    OOO    JJJJ  EEEEE   CCCC  TTTTT         H   H  EEEEE   A    L      TTTTT  H   H
  P   P  R   R  O   O     J   E      C        T           H   H  E      A A   L        T    H   H
  PPPP   RRRR   O   O     J   EEEE   C        T           HHHHH  EEEE  AAAAA  L        T    HHHHH
  P      R  R   O   O  J  J   E      C        T           H   H  E     A   A  L        T    H   H
  P      R   R   OOO    JJ    EEEEE   CCCC    T           H   H  EEEEE A   A  LLLLL    T    H   H
`.trimStart();

const PROJECT_HEALTH_LOGO_PALETTE = [
  '#f38ba8',
  '#fab387',
  '#f9e2af',
  '#a6e3a1',
  '#74c7ec',
] as const;

export async function renderInit(steps: InitStep[]): Promise<void> {
  // Logo
  PROJECT_HEALTH_LOGO.split('\n').forEach((line, index) => {
    process.stdout.write(
      chalk
        .hex(PROJECT_HEALTH_LOGO_PALETTE[index % PROJECT_HEALTH_LOGO_PALETTE.length])
        .bold(line) + '\n'
    );
  });

  process.stdout.write('\n');
  process.stdout.write(
    `  ${chalk.bgHex(THEME.accent).hex('#0b0d12').bold(' INIT ')}  ` +
      `${chalk.hex(THEME.accent).bold('PROJECT-HEALTH')}  ${chalk.dim('v2.0.0')}\n`
  );
  process.stdout.write(
    `  ${chalk.hex(THEME.info)('designer CLI setup')}  ${chalk.dim('cache, config, hooks, ready state')}\n`
  );
  process.stdout.write(
    `  ${chalk.dim('codebase intelligence with a polished first-run experience')}\n`
  );
  process.stdout.write('\n');
  process.stdout.write('  ' + rule() + '\n');
  process.stdout.write('\n');

  // Steps
  for (const step of steps) {
    process.stdout.write(`  ${chalk.dim('⠋')}  ${chalk.hex(THEME.text)(step.label)}`);

    try {
      const msg = await step.run();
      // Clear line + rewrite with ✓
      process.stdout.write(`\r  ${chalk.hex(THEME.success)('✓')}  ${chalk.hex(THEME.text)(step.label)}  ${chalk.dim(msg)}\n`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stdout.write(`\r  ${chalk.hex(THEME.critical)('✗')}  ${chalk.hex(THEME.text)(step.label)}  ${chalk.dim(msg)}\n`);
    }
  }

  process.stdout.write('\n');
  process.stdout.write(
    `  ${chalk.hex(THEME.success)('ready.')}  ` +
    chalk.dim('run ') + chalk.hex(THEME.info)('ph scan') + chalk.dim(' to analyse your project\n')
  );
  process.stdout.write('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// TREND RENDERER
// ─────────────────────────────────────────────────────────────────────────────

export function renderTrend(history: ScanHistory[]): void {
  if (history.length === 0) {
    process.stdout.write(`\n  ${chalk.dim('No scan history. Run ph scan first.')}\n`);
    return;
  }

  const scores = history.slice(-14);
  const values = scores.map(h => h.score);
  const min    = Math.min(...values);
  const max    = Math.max(...values);
  const avg    = Math.round(values.reduce((s, v) => s + v, 0) / values.length);

  // Date range
  const startDate = new Date(scores[0].generatedAt).toLocaleDateString();
  const endDate   = new Date(scores[scores.length - 1].generatedAt).toLocaleDateString();

  process.stdout.write('\n');
  sectionDivider('trend');
  process.stdout.write('\n');

  // Full-width sparkline
  process.stdout.write('  ' + sparkline(values) + '\n');
  process.stdout.write('\n');

  // Stats row
  process.stdout.write(
    `  ${chalk.hex(THEME.success)('max')} ${chalk.hex(THEME.success).bold(max.toString())}  ` +
    `${chalk.hex(THEME.warning)('avg')} ${chalk.hex(THEME.warning).bold(avg.toString())}  ` +
    `${chalk.hex(THEME.critical)('min')} ${chalk.hex(THEME.critical).bold(min.toString())}  ` +
    `${chalk.dim(startDate + ' → ' + endDate)}\n`
  );

  process.stdout.write('\n');

  // Biggest drop
  let biggestDrop = 0;
  let biggestDropIdx = -1;
  let biggestGain = 0;
  let biggestGainIdx = -1;

  for (let i = 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    if (diff < biggestDrop)  { biggestDrop = diff;  biggestDropIdx = i; }
    if (diff > biggestGain)  { biggestGain = diff;  biggestGainIdx = i; }
  }

  if (biggestDropIdx >= 0) {
    const entry = scores[biggestDropIdx];
    const hash  = entry.commitHash ? chalk.dim(' ' + entry.commitHash.slice(0, 7)) : '';
    process.stdout.write(
      `  ${chalk.hex(THEME.critical)('▼')} biggest drop  ` +
      `${chalk.hex(THEME.critical).bold(biggestDrop.toString() + 'pts')}  ` +
      chalk.dim(new Date(entry.generatedAt).toLocaleDateString()) + hash + '\n'
    );
  }

  if (biggestGainIdx >= 0) {
    const entry = scores[biggestGainIdx];
    const hash  = entry.commitHash ? chalk.dim(' ' + entry.commitHash.slice(0, 7)) : '';
    process.stdout.write(
      `  ${chalk.hex(THEME.success)('▲')} biggest gain  ` +
      `${chalk.hex(THEME.success).bold('+' + biggestGain.toString() + 'pts')}  ` +
      chalk.dim(new Date(entry.generatedAt).toLocaleDateString()) + hash + '\n'
    );
  }

  process.stdout.write('\n');
  keyboardHints([
    { key: 'r', label: 'refresh' },
    { key: 'q', label: 'quit' },
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────
// ERROR HANDLER — never raw stack traces
// ─────────────────────────────────────────────────────────────────────────────

export type ErrorCode =
  | 'PROXY_NOT_CONFIGURED'
  | 'JWT_NOT_FOUND'
  | 'RATE_LIMIT'
  | 'MODULE_FAILED'
  | 'CONTEXT_TOO_LARGE'
  | 'NOT_INITIALISED'
  | 'UNKNOWN';

const ERROR_MESSAGES: Record<ErrorCode, { title: string; hint: string; suggestion?: string }> = {
  PROXY_NOT_CONFIGURED: {
    title: 'Proxy not configured',
    hint:  'Set proxy.url in your project-health.config.ts',
    suggestion: 'ph init',
  },
  JWT_NOT_FOUND: {
    title: 'Authentication token not found',
    hint:  'Log in first to enable AI features',
    suggestion: 'ph auth login',
  },
  RATE_LIMIT: {
    title: 'Rate limit reached',
    hint:  'Too many requests — waiting for the window to reset',
  },
  MODULE_FAILED: {
    title: 'Module analysis failed',
    hint:  'This module was skipped — other modules completed normally',
  },
  CONTEXT_TOO_LARGE: {
    title: 'Context window exceeded',
    hint:  'Response was truncated gracefully — consider scoping your question',
  },
  NOT_INITIALISED: {
    title: 'Project not initialised',
    hint:  'Run ph init to set up project-health in this directory',
    suggestion: 'ph init',
  },
  UNKNOWN: {
    title: 'An unexpected error occurred',
    hint:  'If this persists, check your configuration',
  },
};

export function error(
  code: ErrorCode,
  context?: Record<string, string>,
): void {
  const { title, hint, suggestion } = ERROR_MESSAGES[code] ?? ERROR_MESSAGES.UNKNOWN;

  let resolvedHint = hint;
  let resolvedTitle = title;

  if (context) {
    // Interpolate context values
    for (const [k, v] of Object.entries(context)) {
      resolvedTitle = resolvedTitle.replace(`{${k}}`, v);
      resolvedHint  = resolvedHint.replace(`{${k}}`, v);
    }
  }

  // Special handling for rate limit: show retry seconds
  if (code === 'RATE_LIMIT' && context?.retryAfter) {
    resolvedHint = `Retry in ${context.retryAfter}s`;
  }

  process.stdout.write('\n');
  process.stdout.write(
    `  ${chalk.hex(THEME.critical)('✗')}  ${chalk.bold(resolvedTitle)}\n`
  );
  process.stdout.write(
    `     ${chalk.dim(resolvedHint)}\n`
  );

  if (suggestion) {
    process.stdout.write('\n');
    process.stdout.write(
      `  ${chalk.hex(THEME.info)('→')}  ${chalk.dim(suggestion)}\n`
    );
  }

  process.stdout.write('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// BACKWARDS-COMPATIBLE LEGACY EXPORTS (used by cli/index.ts)
// ─────────────────────────────────────────────────────────────────────────────

/** @deprecated use renderScan() */
export function printHealthReport(report: HealthReport): void {
  renderScan(report);
}

/** @deprecated use renderFinding() */
export function printFinding(finding: Finding): void {
  renderFinding(finding);
}

/** @deprecated use renderFinding() */
export function formatFinding(finding: Finding): string {
  const colour = severityColour(finding.severity);
  const loc = finding.file
    ? ` ${chalk.hex(THEME.info)(finding.file)}${finding.line ? ':' + finding.line : ''}`
    : '';
  return (
    `${chalk.hex(colour)(finding.severity)}  ` +
    `${chalk.bold(finding.type.padEnd(20))}  ` +
    `${loc}  ${finding.message}`
  );
}

export function formatSeverity(severity: Severity): string {
  return chalk.hex(severityColour(severity))(severity);
}

export function formatScoreBand(band: ScoreBand): string {
  const s = { EXCELLENT: 100, GOOD: 80, MODERATE: 65, HIGH_RISK: 50, CRITICAL: 20 }[band] ?? 50;
  return chalk.hex(scoreColour(s)).bold(band);
}

export function formatHealthScore(score: number, _band: ScoreBand): string {
  return chalk.hex(scoreColour(score)).bold(`${score}/100`);
}

export function printSection(title: string): void {
  sectionDivider(title.toLowerCase());
}

export function printSubSection(title: string): void {
  process.stdout.write(`\n  ${chalk.hex(THEME.sectionLabel)(title)}\n\n`);
}

export function printFindings(findings: Finding[]): void {
  if (findings.length === 0) {
    process.stdout.write(chalk.dim('  No findings\n'));
    return;
  }
  for (const f of findings) renderFinding(f);
}

export function printModuleResult(result: ModuleResult): void {
  const colour = scoreColour(result.score);
  const status = result.status === 'ok'
    ? chalk.hex(THEME.success)('✓')
    : result.status === 'warning'
      ? chalk.hex(THEME.warning)('●')
      : chalk.hex(THEME.critical)('✗');

  process.stdout.write('\n');
  process.stdout.write(
    `  ${status}  ${chalk.bold(result.moduleName)}  ${chalk.dim(result.moduleId)}\n`
  );
  process.stdout.write(
    `     ${chalk.dim('score')}  ${chalk.hex(colour).bold(result.score.toString())}` +
    `  ${chalk.dim(result.durationMs + 'ms')}\n`
  );

  if (result.findings.length > 0) {
    process.stdout.write('\n');
    for (const f of result.findings.slice(0, 3)) renderFinding(f);
    if (result.findings.length > 3) {
      process.stdout.write(
        `     ${chalk.dim(`... and ${result.findings.length - 3} more`)}\n`
      );
    }
  }
}

export function printError(message: string, isRateLimit = false): void {
  if (isRateLimit) {
    error('RATE_LIMIT', {});
  } else {
    process.stdout.write(
      `\n  ${chalk.hex(THEME.critical)('✗')}  ${chalk.bold(message)}\n\n`
    );
  }
}

export function printSuccess(message: string): void {
  process.stdout.write(
    `  ${chalk.hex(THEME.success)('✓')}  ${chalk.hex(THEME.text)(message)}\n`
  );
}

export function printWarning(message: string): void {
  process.stdout.write(
    `  ${chalk.hex(THEME.warning)('●')}  ${chalk.hex(THEME.warning)(message)}\n`
  );
}

export function printInfo(message: string): void {
  process.stdout.write(
    `  ${chalk.dim('·')}  ${chalk.dim(message)}\n`
  );
}

export function printJson(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, 2) + '\n');
}

export function printHtml(html: string): void {
  process.stdout.write(html + '\n');
}

// Simple spinner interface (kept for backwards compatibility with watch mode)
export interface SimpleSpinner {
  start(text?: string): this;
  succeed(text?: string): this;
  fail(text?: string): this;
  warn(text?: string): this;
  stop(): void;
}

export function createSpinner(text: string): SimpleSpinner {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let frame = 0;
  let interval: ReturnType<typeof setInterval> | null = null;
  let currentText = text;

  function startInterval() {
    interval = setInterval(() => {
      process.stdout.write(
        `\r  ${chalk.hex(THEME.info)(frames[frame % frames.length])}  ${chalk.dim(currentText)}`
      );
      frame++;
    }, 80);
  }

  function clear(icon: string, color: string, msg?: string) {
    if (interval) { clearInterval(interval); interval = null; }
    const label = msg ?? currentText;
    process.stdout.write(`\r  ${chalk.hex(color)(icon)}  ${chalk.hex(THEME.text)(label)}\n`);
  }

  const spinner: SimpleSpinner = {
    start(msg?) {
      if (msg) currentText = msg;
      startInterval();
      return this;
    },
    succeed(msg?) { clear('✓', THEME.success, msg); return this; },
    fail(msg?)    { clear('✗', THEME.critical, msg); return this; },
    warn(msg?)    { clear('●', THEME.warning, msg);  return this; },
    stop()        { if (interval) { clearInterval(interval); interval = null; } process.stdout.write('\n'); },
  };

  return spinner;
}

// HTML report generator (unchanged — not part of terminal UI layer)
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function generateHtmlReport(report: HealthReport): string {
  const band       = scoreBandLabel(report.score);
  const scoreColor = scoreColour(report.score);

  let modulesHtml = '';
  for (const mod of report.modules) {
    const modScoreColor = scoreColour(mod.score);
    const statusIcon =
      mod.status === 'ok' ? '✓' : mod.status === 'warning' ? '●' : '✗';

    let findingsHtml = '';
    for (const f of mod.findings) {
      const sevColour = severityColour(f.severity);
      findingsHtml += `
        <div class="finding" style="border-left:3px solid ${sevColour};padding:8px 12px;margin:8px 0;background:#0d0f17">
          <span style="font-weight:bold;color:${sevColour}">[${f.severity}]</span>
          <span style="margin-left:8px;color:#89b4fa">${f.type}</span>
          ${f.file ? `<span style="color:#3d4466;margin-left:8px">${escapeHtml(f.file)}${f.line ? ':' + f.line : ''}</span>` : ''}
          <div style="margin-top:4px;color:#cdd6f4">${escapeHtml(f.message)}</div>
          ${f.fix ? `<div style="margin-top:4px;color:#a6e3a1;font-size:0.9em">→ ${escapeHtml(f.fix)}</div>` : ''}
        </div>`;
    }

    modulesHtml += `
      <div class="module" style="margin-bottom:24px;border:1px solid #1e2330;border-radius:8px;overflow:hidden">
        <div style="background:#0d0f17;padding:12px 16px;display:flex;justify-content:space-between;align-items:center">
          <span style="font-weight:bold;color:#cdd6f4">${statusIcon} ${mod.moduleName} <span style="color:#3d4466">${mod.moduleId}</span></span>
          <span style="color:${modScoreColor};font-weight:bold">${mod.score}/100</span>
        </div>
        <div style="padding:16px">
          <div style="color:#3d4466;margin-bottom:12px">${mod.durationMs}ms</div>
          ${findingsHtml || '<div style="color:#a6e3a1">No findings</div>'}
        </div>
      </div>`;
  }

  let actionsHtml = '';
  if (report.topActions.length > 0) {
    actionsHtml = `
      <div style="margin-top:24px">
        <h3 style="color:#cdd6f4;border-bottom:1px solid #1e2330;padding-bottom:8px">Top Actions</h3>
        <ol style="padding-left:20px;color:#cdd6f4">
          ${report.topActions.map(a => `<li style="margin:8px 0">${escapeHtml(a)}</li>`).join('')}
        </ol>
      </div>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>Project Health Report</title>
  <style>
    *{box-sizing:border-box}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,monospace;line-height:1.6;color:#cdd6f4;max-width:1200px;margin:0 auto;padding:20px;background:#0b0d12}
    h1,h2,h3{color:#cdd6f4}
    .score-section{text-align:center;padding:32px;background:#0d0f17;border:1px solid #1e2330;border-radius:12px;margin-bottom:32px}
    .score{font-size:72px;font-weight:bold;color:${scoreColor}}
    .band{font-size:20px;color:${scoreColor};margin-top:8px;letter-spacing:.2em}
    .meta{color:#3d4466;margin-top:16px}
  </style>
</head>
<body>
  <h1>Project Health Report</h1>
  <div class="score-section">
    <div class="score">${report.score}</div>
    <div class="band">${band}</div>
    <div class="meta">
      <div>${escapeHtml(report.projectRoot)}</div>
      <div>${new Date(report.generatedAt).toLocaleString()}</div>
    </div>
  </div>
  <h2>Module Results</h2>
  ${modulesHtml}
  ${actionsHtml}
</body>
</html>`;
}

// Exit codes
export const ExitCode = {
  SUCCESS:    0,
  FAIL_UNDER: 1,
  RATE_LIMIT: 2,
} as const;
