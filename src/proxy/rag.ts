import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { ChatCompletionMessageParam } from "openai/resources/index.js";
import type { HealthReport } from "../types/index.js";

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "do",
  "does",
  "for",
  "from",
  "how",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "the",
  "this",
  "to",
  "what",
  "when",
  "where",
  "which",
  "why",
  "with",
]);

export interface RagFunction {
  name: string;
  line?: number;
}

export interface RagFileEntry {
  filePath: string;
  exports: string[];
  imports: string[];
  functions: RagFunction[];
}

interface LegacyAstSymbol {
  file: string;
  line: number;
  kind: "class" | "function" | "interface" | "type" | "const";
}

export interface ScoredRagFile extends RagFileEntry {
  score: number;
}

export interface RagContext {
  prompt: string;
  report: HealthReport;
  topFiles: ScoredRagFile[];
  keywords: string[];
}

function splitIdentifierParts(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^a-zA-Z0-9]+/)
    .map((part) => part.toLowerCase())
    .filter(Boolean);
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      if (typeof item === "string") {
        return item;
      }

      if (item && typeof item === "object" && "name" in item) {
        const name = (item as { name?: unknown }).name;
        return typeof name === "string" ? name : "";
      }

      return "";
    })
    .filter(Boolean);
}

function normalizeFunctionList(value: unknown): RagFunction[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const functions: RagFunction[] = [];

  for (const item of value) {
    if (typeof item === "string") {
      functions.push({ name: item });
      continue;
    }

    if (item && typeof item === "object" && "name" in item) {
      const fn = item as { name?: unknown; line?: unknown };
      if (typeof fn.name === "string") {
        functions.push({
          name: fn.name,
          line: typeof fn.line === "number" ? fn.line : undefined,
        });
      }
    }
  }

  return functions;
}

export function extractQuestionKeywords(question: string): string[] {
  return Array.from(
    new Set(
      question
        .toLowerCase()
        .split(/[^a-zA-Z0-9]+/)
        .map((token) => token.trim())
        .filter((token) => token.length > 1 && !STOPWORDS.has(token)),
    ),
  );
}

export function normalizeAstIndex(astIndex: unknown): RagFileEntry[] {
  if (Array.isArray(astIndex)) {
    return astIndex
      .map((entry) => {
        if (!entry || typeof entry !== "object") {
          return null;
        }

        const file = entry as {
          filePath?: unknown;
          exports?: unknown;
          imports?: unknown;
          functions?: unknown;
        };

        if (typeof file.filePath !== "string") {
          return null;
        }

        return {
          filePath: file.filePath,
          exports: normalizeStringList(file.exports),
          imports: normalizeStringList(file.imports),
          functions: normalizeFunctionList(file.functions),
        };
      })
      .filter((entry): entry is RagFileEntry => entry !== null);
  }

  if (!astIndex || typeof astIndex !== "object") {
    return [];
  }

  const objectValues = Object.values(astIndex);
  if (
    objectValues.every(
      (value) =>
        value &&
        typeof value === "object" &&
        "filePath" in value &&
        typeof (value as { filePath?: unknown }).filePath === "string",
    )
  ) {
    return normalizeAstIndex(objectValues);
  }

  const grouped = new Map<string, RagFileEntry>();
  for (const [name, value] of Object.entries(astIndex)) {
    if (!value || typeof value !== "object") {
      continue;
    }

    const symbol = value as Partial<LegacyAstSymbol>;
    if (typeof symbol.file !== "string") {
      continue;
    }

    const existing = grouped.get(symbol.file) ?? {
      filePath: symbol.file,
      exports: [],
      imports: [],
      functions: [],
    };

    if (symbol.kind === "function" || symbol.kind === "class") {
      existing.functions.push({
        name,
        line: typeof symbol.line === "number" ? symbol.line : undefined,
      });
    }

    if (
      symbol.kind === "const" ||
      symbol.kind === "function" ||
      symbol.kind === "class"
    ) {
      existing.exports.push(name);
    }

    grouped.set(symbol.file, existing);
  }

  return Array.from(grouped.values());
}

function countKeywordMatches(keyword: string, values: string[]): number {
  let matches = 0;

  for (const value of values) {
    const normalized = value.toLowerCase();
    if (normalized === keyword || normalized.includes(keyword)) {
      matches++;
      continue;
    }

    for (const part of splitIdentifierParts(value)) {
      if (part === keyword || part.includes(keyword)) {
        matches++;
      }
    }
  }

  return matches;
}

export function scoreAstFile(entry: RagFileEntry, keywords: string[]): number {
  const pathSegments = entry.filePath
    .split(/[\\/]+/)
    .flatMap(splitIdentifierParts);
  const exportNames = entry.exports.flatMap((value) => [
    value,
    ...splitIdentifierParts(value),
  ]);
  const functionNames = entry.functions.flatMap((fn) => [
    fn.name,
    ...splitIdentifierParts(fn.name),
  ]);

  return keywords.reduce((total, keyword) => {
    return (
      total +
      countKeywordMatches(keyword, pathSegments) +
      countKeywordMatches(keyword, exportNames) +
      countKeywordMatches(keyword, functionNames)
    );
  }, 0);
}

export function rankRelevantFiles(
  astEntries: RagFileEntry[],
  keywords: string[],
  limit = 5,
): ScoredRagFile[] {
  return astEntries
    .map((entry) => ({
      ...entry,
      score: scoreAstFile(entry, keywords),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }

      return a.filePath.localeCompare(b.filePath);
    })
    .slice(0, limit);
}

export function buildAskPrompt(
  report: HealthReport,
  topFiles: RagFileEntry[],
  question: string,
): string {
  const topIssues =
    report.topActions && report.topActions.length > 0
      ? report.topActions.join(", ")
      : "None";

  const relevantFiles =
    topFiles.length > 0
      ? topFiles
          .map((file) =>
            [
              `=== ${file.filePath} ===`,
              `Exports: ${file.exports.join(", ") || "None"}`,
              `Functions: ${file.functions.map((fn) => fn.name).join(", ") || "None"}`,
            ].join("\n"),
          )
          .join("\n")
      : "No strongly relevant files found in ast-index.json.";

  return `You are a codebase expert for a project analyzed by project-health.

PROJECT HEALTH SUMMARY: Overall score: ${report.score ?? "N/A"}/100 Top issues: ${topIssues}

RELEVANT FILES:
${relevantFiles}

USER QUESTION: ${question}

Answer concisely and reference specific files and line numbers where known.`;
}

export async function buildRagContext(
  projectRoot: string,
  question: string,
): Promise<RagContext> {
  const cacheDir = join(projectRoot, ".ph-cache");
  const [astRaw, reportRaw] = await Promise.all([
    fs.readFile(join(cacheDir, "ast-index.json"), "utf-8"),
    fs.readFile(join(cacheDir, "last-scan.json"), "utf-8"),
  ]);

  const astEntries = normalizeAstIndex(JSON.parse(astRaw));
  const report = JSON.parse(reportRaw) as HealthReport;
  const keywords = extractQuestionKeywords(question);
  const topFiles = rankRelevantFiles(astEntries, keywords, 5);

  return {
    prompt: buildAskPrompt(report, topFiles, question),
    report,
    topFiles,
    keywords,
  };
}

export function buildRagAskMessages(
  prompt: string,
): ChatCompletionMessageParam[] {
  return [
    {
      role: "system",
      content:
        "You answer questions about this repository using only the supplied project-health context.",
    },
    {
      role: "user",
      content: prompt,
    },
  ];
}
