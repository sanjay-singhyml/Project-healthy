import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { HealthReport, ModuleResult, ModuleId } from "../types/index.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("ph:cli");

export interface HistoryEntry {
  timestamp: string;
  projectRoot: string;
  score: number;
  moduleScores: Partial<Record<ModuleId, number>>;
  topFinding?: string;
}

const HISTORY_PATH = join(homedir(), ".ph-history.jsonl");

function getHistoryPath(): string {
  return HISTORY_PATH;
}

function normalizeHistoryEntry(
  report: HealthReport | ModuleResult[],
): HistoryEntry | null {
  if (Array.isArray(report)) {
    if (report.length === 0) {
      return null;
    }

    const projectRoot = resolve(process.cwd());
    const moduleScores = Object.fromEntries(
      report.map((result) => [result.moduleId, result.score]),
    ) as Partial<Record<ModuleId, number>>;
    const findings = report
      .flatMap((result) => result.findings)
      .sort(
        (left, right) =>
          severityRank(right.severity) - severityRank(left.severity),
      );
    const score = Math.round(
      report.reduce((sum, result) => sum + result.score, 0) / report.length,
    );

    return {
      timestamp: new Date().toISOString(),
      projectRoot,
      score,
      moduleScores,
      topFinding: findings[0]?.message,
    };
  }

  return {
    timestamp: report.generatedAt || new Date().toISOString(),
    projectRoot: resolve(report.projectRoot),
    score: report.score,
    moduleScores: Object.fromEntries(
      report.modules.map((result) => [result.moduleId, result.score]),
    ) as Partial<Record<ModuleId, number>>,
    topFinding: report.findings[0]?.message,
  };
}

function severityRank(severity: string): number {
  switch (severity) {
    case "CRITICAL":
      return 4;
    case "HIGH":
      return 3;
    case "MEDIUM":
      return 2;
    case "LOW":
      return 1;
    default:
      return 0;
  }
}

export async function appendHistoryEntry(
  report: HealthReport | ModuleResult[],
): Promise<void> {
  const entry = normalizeHistoryEntry(report);
  if (!entry) {
    return;
  }

  const historyPath = getHistoryPath();
  mkdirSync(dirname(historyPath), { recursive: true });
  appendFileSync(historyPath, `${JSON.stringify(entry)}\n`, "utf-8");
}

export async function loadHistory(
  projectRoot: string,
  days: number,
): Promise<HistoryEntry[]> {
  const historyPath = getHistoryPath();
  if (!existsSync(historyPath)) {
    return [];
  }

  const cutoffTime = Date.now() - days * 24 * 60 * 60 * 1000;
  const normalizedRoot = resolve(projectRoot);
  const content = readFileSync(historyPath, "utf-8");

  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as HistoryEntry];
      } catch (err) {
        log("Error in loadHistory: %O", err);
        return [];
      }
    })
    .filter((entry) => {
      const timestamp = Date.parse(entry.timestamp);
      return (
        entry.projectRoot === normalizedRoot &&
        Number.isFinite(timestamp) &&
        timestamp >= cutoffTime
      );
    })
    .sort(
      (left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp),
    );
}
