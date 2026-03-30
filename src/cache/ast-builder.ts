// AST Index Builder
// Builds ast-index.json for ph ask functionality
// Uses cache manager to save (RULES.md rule 14)

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { createCacheManager } from "./index.js";
import type { AstIndex, AstSymbol } from "../types/index.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("ph:cache");

interface ParsedSymbol {
  name: string;
  line: number;
  kind: "class" | "function" | "interface" | "type" | "const";
}

function findSourceFiles(projectRoot: string): string[] {
  const files: string[] = [];
  const supportedExts = [".ts", ".tsx", ".js", ".jsx"];

  function walkDir(dir: string) {
    try {
      const entries = readdirSync(dir);
      for (const entry of entries) {
        const fullPath = join(dir, entry);
        const stat = statSync(fullPath);

        if (stat.isDirectory()) {
          if (
            !["node_modules", ".git", "dist", "build", ".ph-cache"].includes(
              entry,
            )
          ) {
            walkDir(fullPath);
          }
        } else if (supportedExts.includes(extname(entry))) {
          files.push(fullPath);
        }
      }
    } catch (err) {
      log("Error in walkDir: %O", err);
      // Ignore permission errors
    }
  }

  walkDir(projectRoot);
  return files;
}

function extractSymbols(
  filePath: string,
  projectRoot: string,
): Map<string, AstSymbol> {
  const symbolMap = new Map<string, AstSymbol>();

  try {
    const content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n");
    const relativePath = filePath.replace(projectRoot + "/", "");

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      // Function declarations
      const funcMatch = trimmed.match(
        /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/,
      );
      if (funcMatch) {
        const name = funcMatch[1];
        symbolMap.set(name, {
          file: relativePath,
          line: i + 1,
          kind: "function",
        });
      }

      // Class declarations
      const classMatch = trimmed.match(/^(?:export\s+)?class\s+(\w+)/);
      if (classMatch) {
        const name = classMatch[1];
        symbolMap.set(name, {
          file: relativePath,
          line: i + 1,
          kind: "class",
        });
      }

      // Interface declarations
      const interfaceMatch = trimmed.match(/^(?:export\s+)?interface\s+(\w+)/);
      if (interfaceMatch) {
        const name = interfaceMatch[1];
        symbolMap.set(name, {
          file: relativePath,
          line: i + 1,
          kind: "interface",
        });
      }

      // Type declarations
      const typeMatch = trimmed.match(/^(?:export\s+)?type\s+(\w+)/);
      if (typeMatch) {
        const name = typeMatch[1];
        symbolMap.set(name, {
          file: relativePath,
          line: i + 1,
          kind: "type",
        });
      }

      // Const declarations (exported)
      const constMatch = trimmed.match(/^(?:export\s+)?const\s+(\w+)/);
      if (constMatch) {
        const name = constMatch[1];
        symbolMap.set(name, {
          file: relativePath,
          line: i + 1,
          kind: "const",
        });
      }
    }
  } catch (err) {
    log("Error in extractSymbols: %O", err);
    // Skip unreadable files
  }

  return symbolMap;
}

export async function buildAstIndex(projectRoot: string): Promise<AstIndex> {
  const cache = createCacheManager(projectRoot);
  const files = findSourceFiles(projectRoot);

  const astIndex: AstIndex = {};

  for (const file of files) {
    const symbols = extractSymbols(file, projectRoot);

    for (const [name, symbol] of symbols) {
      // Keep last occurrence (most recent definition)
      astIndex[name] = symbol;
    }
  }

  // Save using cache manager (RULES.md rule 14)
  await cache.saveAstIndex(astIndex);

  return astIndex;
}

// Extract keywords from a question for AST lookup
export function extractKeywords(question: string): string[] {
  const keywords: string[] = [];

  // Look for camelCase identifiers in the question
  const camelCaseMatches = question.match(/[a-z]+[A-Z][a-zA-Z]*/g);
  if (camelCaseMatches) {
    keywords.push(...camelCaseMatches);
  }

  // Also look for common patterns
  const words = question.split(/\s+/);
  for (const word of words) {
    // Filter out common words
    const cleaned = word.replace(/[^a-zA-Z0-9]/g, "");
    if (
      cleaned.length > 2 &&
      ![
        "how",
        "does",
        "what",
        "where",
        "when",
        "why",
        "which",
        "the",
        "this",
        "that",
        "file",
        "function",
        "class",
      ].includes(cleaned.toLowerCase())
    ) {
      keywords.push(cleaned);
    }
  }

  return keywords;
}

// Find relevant files based on keywords
export function findRelevantFiles(
  astIndex: AstIndex,
  keywords: string[],
): Array<{ path: string; line: number }> {
  const relevantFiles: Map<string, number> = new Map();

  for (const keyword of keywords) {
    // Direct match
    if (astIndex[keyword]) {
      const symbol = astIndex[keyword];
      relevantFiles.set(
        symbol.file,
        Math.min(relevantFiles.get(symbol.file) || Infinity, symbol.line),
      );
    }

    // Partial match (case-insensitive)
    for (const [name, symbol] of Object.entries(astIndex)) {
      if (
        name.toLowerCase().includes(keyword.toLowerCase()) ||
        keyword.toLowerCase().includes(name.toLowerCase())
      ) {
        relevantFiles.set(
          symbol.file,
          Math.min(relevantFiles.get(symbol.file) || Infinity, symbol.line),
        );
      }
    }
  }

  // Convert to sorted array (most relevant first)
  return Array.from(relevantFiles.entries())
    .map(([path, line]) => ({ path, line }))
    .sort((a, b) => a.line - b.line);
}

export default buildAstIndex;
