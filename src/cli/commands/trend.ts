import type { Command } from "commander";
import chalk from "chalk";
import { loadHistory, type HistoryEntry } from "../../history/index.js";
import { printError, printInfo, printJson } from "../../utils/output.js";
import { createLogger } from "../../utils/logger.js";
import type { ModuleId } from "../../types/index.js";

const log = createLogger("ph:cli");

type TrendFormat = "sparkline" | "table" | "json";

const SPARKLINE_BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

function parseLastDays(value: string): number {
  const match = value.trim().match(/^(\d+)d$/i);
  if (!match) {
    throw new Error(
      `Invalid --last value "${value}". Use values like 7d or 30d.`,
    );
  }

  return Math.max(1, Number.parseInt(match[1], 10));
}

function normalizeModuleId(moduleId?: string): ModuleId | undefined {
  if (!moduleId) {
    return undefined;
  }

  const normalized = moduleId.toUpperCase();
  const match = normalized.match(/^M-0[1-8]$/);
  if (!match) {
    throw new Error(`Invalid module id "${moduleId}". Use M-01 through M-08.`);
  }

  return normalized as ModuleId;
}

function getEntryScore(
  entry: HistoryEntry,
  moduleId?: ModuleId,
): number | null {
  if (!moduleId) {
    return entry.score;
  }

  const moduleScore = entry.moduleScores[moduleId];
  return typeof moduleScore === "number" ? moduleScore : null;
}

function aggregateByDate(
  entries: HistoryEntry[],
  moduleId?: ModuleId,
): HistoryEntry[] {
  const byDate = new Map<string, HistoryEntry[]>();

  for (const entry of entries) {
    const date = entry.timestamp.slice(0, 10);
    const existing = byDate.get(date) ?? [];
    existing.push(entry);
    byDate.set(date, existing);
  }

  return Array.from(byDate.entries())
    .map(([date, dayEntries]) => {
      const scores = dayEntries
        .map((e) => getEntryScore(e, moduleId))
        .filter((s): s is number => s !== null);

      if (scores.length === 0) {
        return null;
      }

      const avgScore = Math.round(
        scores.reduce((a, b) => a + b, 0) / scores.length,
      );
      const latestEntry = dayEntries[dayEntries.length - 1];

      return {
        timestamp: `${date}T00:00:00.000Z`,
        projectRoot: latestEntry.projectRoot,
        score: avgScore,
        moduleScores: latestEntry.moduleScores,
        topFinding: latestEntry.topFinding,
      };
    })
    .filter((e): e is HistoryEntry => e !== null)
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
}

function deduplicateConsecutive(
  entries: HistoryEntry[],
  moduleId?: ModuleId,
): HistoryEntry[] {
  const result: HistoryEntry[] = [];
  let lastScore: number | null = null;

  for (const entry of entries) {
    const score = getEntryScore(entry, moduleId);
    if (score === null) {
      continue;
    }

    if (score !== lastScore) {
      result.push(entry);
      lastScore = score;
    }
  }

  return result;
}

function calculateTrend(
  entries: HistoryEntry[],
  moduleId?: ModuleId,
): {
  direction: "up" | "down" | "stable";
  percentChange: number;
} {
  const scores = entries
    .map((e) => getEntryScore(e, moduleId))
    .filter((s): s is number => s !== null);

  if (scores.length < 2) {
    return { direction: "stable", percentChange: 0 };
  }

  const first = scores[0];
  const last = scores[scores.length - 1];
  const change = first === 0 ? last - first : ((last - first) / first) * 100;

  if (Math.abs(change) < 5) {
    return { direction: "stable", percentChange: Math.round(change) };
  }
  return {
    direction: change > 0 ? "up" : "down",
    percentChange: Math.round(change),
  };
}

function formatDelta(current: number, previous: number | null): string {
  if (previous === null) {
    return "N/A";
  }

  const delta = current - previous;
  if (delta === 0) {
    return "0";
  }

  return `${delta > 0 ? "+" : ""}${delta}`;
}

function processEntries(
  entries: HistoryEntry[],
  moduleId?: ModuleId,
): HistoryEntry[] {
  const aggregated = aggregateByDate(entries, moduleId);
  return deduplicateConsecutive(aggregated, moduleId);
}

function renderSparkline(entries: HistoryEntry[], moduleId?: ModuleId): void {
  const processed = processEntries(entries, moduleId);

  const scores = processed
    .map((entry) => getEntryScore(entry, moduleId))
    .filter((score): score is number => score !== null);

  if (scores.length === 0) {
    printInfo("No trend data available for the selected range.");
    return;
  }

  const sparkline = scores
    .map((score) => {
      const index = Math.min(
        SPARKLINE_BLOCKS.length - 1,
        Math.max(0, Math.floor((score / 100) * (SPARKLINE_BLOCKS.length - 1))),
      );
      return SPARKLINE_BLOCKS[index];
    })
    .join("");

  const latest = scores.at(-1) ?? 0;
  const trend = calculateTrend(processed, moduleId);

  const trendIcon =
    trend.direction === "up"
      ? chalk.green("↑")
      : trend.direction === "down"
        ? chalk.red("↓")
        : chalk.gray("→");
  const trendText =
    trend.percentChange === 0
      ? ""
      : ` (${trend.percentChange > 0 ? "+" : ""}${trend.percentChange}%)`;

  const label = moduleId ? `${moduleId} trend` : "Score trend";

  console.log(chalk.bold(label));
  console.log(`${sparkline}  ${latest}/100 ${trendIcon}${trendText}`);
}

async function renderTable(
  entries: HistoryEntry[],
  moduleId?: ModuleId,
): Promise<void> {
  const processed = processEntries(entries, moduleId);

  const rows = processed
    .map((entry, index) => {
      const score = getEntryScore(entry, moduleId);
      if (score === null) {
        return null;
      }

      const previousScore =
        index > 0 ? getEntryScore(processed[index - 1], moduleId) : null;

      return [
        new Date(entry.timestamp).toISOString().slice(0, 10),
        `${score}/100`,
        formatDelta(score, previousScore),
        entry.topFinding ?? "-",
      ];
    })
    .filter((row): row is [string, string, string, string] => row !== null);

  if (rows.length === 0) {
    printInfo("No trend data available for the selected range.");
    return;
  }

  try {
    const tableModule = (await import("cli-table3")) as {
      default: new (options: {
        head: string[];
        wordWrap?: boolean;
        colWidths?: number[];
      }) => {
        push: (...rows: Array<[string, string, string, string]>) => void;
        toString: () => string;
      };
    };
    const Table = tableModule.default;
    const table = new Table({
      head: ["Date", "Score", "Delta", "Top Finding"],
      wordWrap: true,
      colWidths: [12, 10, 10, 80],
    });
    table.push(...rows.slice().reverse());
    console.log(table.toString());
  } catch (err) {
    log("Error in renderTable: %O", err);
    console.log(["Date", "Score", "Delta", "Top Finding"].join(" | "));
    for (const row of rows.slice().reverse()) {
      console.log(row.join(" | "));
    }
  }
}

export function registerTrendCommand(program: Command): void {
  program
    .command("trend")
    .description("Show persistent project health score history")
    .option("--last <N>d", "Lookback window in days", "30d")
    .option("--module <id>", "Show trend for a single module")
    .option(
      "--format <format>",
      "Output format: sparkline, table, json",
      "sparkline",
    )
    .action(
      async (options: {
        last: string;
        module?: string;
        format: TrendFormat;
      }) => {
        try {
          const days = parseLastDays(options.last);
          const moduleId = normalizeModuleId(options.module);
          const format = (options.format || "sparkline") as TrendFormat;
          const history = await loadHistory(process.cwd(), days);

          if (format === "json") {
            const processed = processEntries(history, moduleId);

            const entries = processed
              .map((entry, index) => {
                const score = getEntryScore(entry, moduleId);
                if (score === null) {
                  return null;
                }

                const previousScore =
                  index > 0
                    ? getEntryScore(processed[index - 1], moduleId)
                    : null;

                return {
                  timestamp: entry.timestamp,
                  score,
                  delta: previousScore === null ? null : score - previousScore,
                  topFinding: entry.topFinding ?? null,
                  moduleScores: entry.moduleScores,
                };
              })
              .filter(Boolean);
            printJson(entries);
            return;
          }

          if (format === "table") {
            await renderTable(history, moduleId);
            return;
          }

          renderSparkline(history, moduleId);
        } catch (error) {
          printError(error instanceof Error ? error.message : String(error));
          process.exit(1);
        }
      },
    );
}
