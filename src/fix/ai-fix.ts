// AI-powered fix generator for project-health
// Uses MegaLLM to generate patches for complex findings that can't be fixed with shell commands

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Finding } from "../types/index.js";
import {
  createAIClient,
  chat,
  truncateForContext,
} from "../proxy/ai-client.js";
import type { FixResult } from "./strategies.js";

// Finding types that can be fixed by AI
export const AI_FIXABLE_TYPES: Finding["type"][] = [
  "MISSING_JSDOC",
  "HIGH_COMPLEXITY",
  "DEAD_EXPORT",
  "STALE_DOC",
  "TOO_MANY_PARAMETERS",
  "API_DOC_DRIFT",
];

// System prompt for the AI fix engine
const SYSTEM_PROMPT = `You are an expert TypeScript/JavaScript software engineer performing automated code repairs.
Your task is to fix a specific code quality issue in a file.

STRICT OUTPUT FORMAT:
- Output ONLY a unified diff in the standard format (--- a/... +++ b/... @@ ... @@ ...)
- Do NOT include explanations, markdown code fences, or any other text
- Do NOT output the entire file — only output the changed lines in diff format
- Maintain the original code style, indentation, and formatting
- Minimal changes only — fix ONLY the reported issue, nothing else
- If you cannot produce a safe diff, output exactly the string: CANNOT_FIX`;

// Build the AI prompt for a specific finding type
function buildFixPrompt(finding: Finding, fileContent: string): string {
  const location = finding.line ? ` at line ${finding.line}` : "";
  const truncated = truncateForContext(fileContent, 8000);

  const typeInstructions: Partial<Record<Finding["type"], string>> = {
    MISSING_JSDOC:
      `Add a JSDoc comment block (/** ... */) immediately before the function/class/interface${location}. ` +
      `Include @param tags for each parameter and @returns tag if there is a return value.`,

    HIGH_COMPLEXITY:
      `The function${location} has cyclomatic complexity above 10. ` +
      `Refactor it by extracting one or more private helper functions. ` +
      `Each helper should have a single, clear responsibility.`,

    TOO_MANY_PARAMETERS:
      `The function${location} has too many parameters. ` +
      `Consolidate them into a single options/config object parameter with the existing parameters as properties. ` +
      `Update both the function signature and all call sites in this same file.`,

    DEAD_EXPORT:
      `The exported symbol${location} (${finding.metadata?.name ?? ""}) is unused outside this file. ` +
      `Remove the \`export\` keyword to make it module-private. ` +
      `If everything that referenced it was in the same file, that is sufficient.`,

    STALE_DOC:
      `The documentation in this file is stale relative to the source. ` +
      `Update the relevant markdown section to accurately reflect the current API and behaviour${location}.`,

    API_DOC_DRIFT:
      `The API documentation${location} does not match the actual function signature. ` +
      `Update the JSDoc/comment to match the real parameters and return type.`,
  };

  const instruction =
    typeInstructions[finding.type] ??
    `Fix the following issue: ${finding.message}`;

  return `FILE: ${finding.file ?? "unknown"}

ISSUE TYPE: ${finding.type}
SEVERITY: ${finding.severity}
FINDING: ${finding.message}

TASK: ${instruction}

FILE CONTENT:
${truncated}

Remember — output ONLY the unified diff, nothing else.`;
}

// Parse a unified diff from AI response and apply it to a file
function applyUnifiedDiff(
  filePath: string,
  diffText: string,
): { success: boolean; error?: string } {
  try {
    const lines = diffText.split("\n");

    // Simple hunk parser — handles single-file diffs
    const hunks: Array<{
      startLine: number;
      removes: string[];
      adds: string[];
    }> = [];
    let currentHunk: {
      startLine: number;
      removes: string[];
      adds: string[];
    } | null = null;

    for (const line of lines) {
      if (line.startsWith("---") || line.startsWith("+++")) continue;
      if (line.startsWith("@@")) {
        const match = line.match(/@@ -(\d+)/);
        if (match) {
          currentHunk = {
            startLine: parseInt(match[1], 10),
            removes: [],
            adds: [],
          };
          hunks.push(currentHunk);
        }
        continue;
      }
      if (currentHunk) {
        if (line.startsWith("-")) currentHunk.removes.push(line.slice(1));
        else if (line.startsWith("+")) currentHunk.adds.push(line.slice(1));
      }
    }

    if (hunks.length === 0) {
      return { success: false, error: "No hunks found in diff" };
    }

    const fileLines = readFileSync(filePath, "utf-8").split("\n");
    let offset = 0;

    for (const hunk of hunks) {
      const start = hunk.startLine - 1 + offset;
      // Find the actual position of the removes block
      let idx = start;
      if (hunk.removes.length > 0) {
        // Try to find matching sequence
        outer: for (
          let i = Math.max(0, start - 3);
          i < Math.min(fileLines.length, start + 10);
          i++
        ) {
          for (let j = 0; j < hunk.removes.length; j++) {
            if (fileLines[i + j] !== hunk.removes[j]) continue outer;
          }
          idx = i;
          break;
        }
      }
      fileLines.splice(idx, hunk.removes.length, ...hunk.adds);
      offset += hunk.adds.length - hunk.removes.length;
    }

    writeFileSync(filePath, fileLines.join("\n"), "utf-8");
    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface AiFixOptions {
  proxyUrl?: string;
  dryRun?: boolean;
}

// Fix a finding using the AI client
export async function aiFixFinding(
  finding: Finding,
  projectRoot: string,
  options: AiFixOptions = {},
): Promise<FixResult> {
  if (!AI_FIXABLE_TYPES.includes(finding.type)) {
    return {
      success: false,
      message: `AI fix not supported for finding type ${finding.type}`,
    };
  }

  const filePath = finding.file ? resolve(projectRoot, finding.file) : null;

  if (!filePath || !existsSync(filePath)) {
    return {
      success: false,
      message: `File not found: ${finding.file}`,
    };
  }

  const baseUrl =
    options.proxyUrl ??
    process.env.PROJECT_HEALTH_BACKEND_URL ??
    process.env.MEGALLM_BASE_URL ??
    "http://localhost:3000/v1";

  try {
    const fileContent = readFileSync(filePath, "utf-8");
    const client = createAIClient(baseUrl);

    const userPrompt = buildFixPrompt(finding, fileContent);

    const response = await chat(
      client,
      [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      {
        temperature: 0.1, // Low temperature for deterministic code fixes
      },
    );

    const trimmed = response.trim();

    if (trimmed === "CANNOT_FIX" || trimmed === "") {
      return {
        success: false,
        message: `AI was unable to generate a safe patch for: ${finding.message}`,
      };
    }

    if (options.dryRun) {
      return {
        success: true,
        message: `[dry-run] AI would apply the following patch to ${finding.file}:\n\n${trimmed}`,
        command: "AI patch (dry-run)",
      };
    }

    const result = applyUnifiedDiff(filePath, trimmed);

    if (!result.success) {
      return {
        success: false,
        message: `Failed to apply patch: ${result.error}`,
        error: result.error,
      };
    }

    return {
      success: true,
      message: `AI fixed ${finding.type} in ${finding.file}`,
    };
  } catch (err) {
    return {
      success: false,
      message: `AI fix failed`,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
