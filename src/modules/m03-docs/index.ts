// M-03: Docs Freshness Module
// Checks:
// 1. README_STALENESS - README.md vs src/ directory git dates
// 2. DOCS_DIR_STALENESS - docs/ directory vs src/ directory
// 3. MISSING_JSDOC - Exported functions/classes without JSDoc
// 4. MISSING_CHANGELOG - No CHANGELOG.md file
// 5. API_DOC_DRIFT - JSDoc @param vs function signature mismatch
// 6. MISSING_API_DOCS - No API documentation for public modules

import {
  ModuleResult,
  ModuleId,
  ProjectHealthConfig,
  Finding,
  Severity,
} from "../../types/index.js";
import { v4 as uuidv4 } from "uuid";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, extname, relative } from "node:path";
import { simpleGit, SimpleGit } from "simple-git";
import { shouldIgnorePath } from "../../utils/ignore.js";
import { createLogger } from "../../utils/logger.js";
import { chat, createAIClient, truncateForContext } from "../../proxy/ai-client.js";

const log = createLogger("ph:docs");

export const MODULE_ID: ModuleId = "M-03";
export const MODULE_NAME = "Docs Freshness";

interface ExportedSymbol {
  name: string;
  file: string;
  line: number;
  type: "function" | "class" | "interface" | "type" | "const";
  params: string[];
  hasJsdoc: boolean;
  jsdocParams: string[];
}

interface DocFile {
  name: string;
  path: string;
  lastModified: Date | null;
}

interface GitFileRevision {
  date: Date;
  hash: string;
}

interface SemanticDriftResult {
  drift: "yes" | "no" | "uncertain";
  analysis: string;
  recommendedDocChanges?: string;
}

function findSourceFiles(projectRoot: string): string[] {
  const extensions = [".ts", ".tsx", ".js", ".jsx"];
  const files: string[] = [];

  function searchDir(dir: string) {
    if (!existsSync(dir)) return;

    try {
      const entries = readdirSync(dir);

      for (const entry of entries) {
        const fullPath = join(dir, entry);
        const rel = relative(projectRoot, fullPath).replace(/\\/g, "/");
        if (shouldIgnorePath(rel)) continue;

        try {
          const stat = statSync(fullPath);
          if (stat.isDirectory()) {
            searchDir(fullPath);
          } else if (extensions.includes(extname(entry))) {
            files.push(fullPath);
          }
        } catch (err) {
          log("Error in findSourceFiles: %O", err);
        }
      }
    } catch (err) {
      log("Error in findSourceFiles: %O", err);
    }
  }

  searchDir(projectRoot);
  return files;
}

async function getDirectoryLastModified(
  git: SimpleGit,
  dir: string,
): Promise<Date | null> {
  try {
    const logResult = await git.log({ maxCount: 50, "--": [dir] });
    if (logResult.all.length > 0) {
      return new Date(logResult.all[0].date);
    }
  } catch (err) {
    log("Error in getDirectoryLastModified: %O", err);
  }
  return null;
}

async function getFileLastModified(
  git: SimpleGit,
  file: string,
): Promise<Date | null> {
  try {
    const logResult = await git.log({ maxCount: 1, file });
    if (logResult.all.length > 0) {
      return new Date(logResult.all[0].date);
    }
  } catch (err) {
    log("Error in getFileLastModified: %O", err);
  }
  return null;
}

async function getFileLastRevision(
  git: SimpleGit,
  file: string,
): Promise<GitFileRevision | null> {
  try {
    const logResult = await git.log({ maxCount: 1, file });
    if (logResult.all.length > 0) {
      return {
        date: new Date(logResult.all[0].date),
        hash: logResult.all[0].hash,
      };
    }
  } catch (err) {
    log("Error in getFileLastRevision: %O", err);
  }
  return null;
}

function findDocFiles(projectRoot: string): DocFile[] {
  const docFiles: DocFile[] = [];
  const docExtensions = [".md", ".rst", ".txt", ".adoc", ".mdx"];
  const docDirs = ["docs", "doc", "documentation", "wiki", "guide", "api"];

  const rootDocFiles = [
    "README.md",
    "README.MD",
    "README.rst",
    "README.txt",
    "CHANGELOG.md",
    "CHANGELOG.MD",
    "CONTRIBUTING.md",
    "CONTRIBUTING.MD",
    "LICENSE.md",
    "API.md",
    "API.mdx",
  ];

  for (const name of rootDocFiles) {
    const path = join(projectRoot, name);
    if (existsSync(path)) {
      try {
        const stat = statSync(path);
        docFiles.push({ name, path, lastModified: stat.mtime });
      } catch (err) {
        log("Error finding root doc file: %O", err);
      }
    }
  }

  for (const dir of docDirs) {
    const docDir = join(projectRoot, dir);
    if (existsSync(docDir)) {
      try {
        const entries = readdirSync(docDir, { withFileTypes: true });
        for (const entry of entries) {
          if (
            entry.isFile() &&
            docExtensions.includes(extname(entry.name).toLowerCase())
          ) {
            const fullPath = join(docDir, entry.name);
            try {
              const stat = statSync(fullPath);
              docFiles.push({
                name: entry.name,
                path: fullPath,
                lastModified: stat.mtime,
              });
            } catch (err) {
              log("Error in findDocFiles: %O", err);
            }
          }
        }
      } catch (err) {
        log("Error in findDocFiles: %O", err);
      }
    }
  }

  return docFiles;
}

function normalizeToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function getFileStem(filePath: string): string {
  const fileName = basename(filePath).replace(/\.[^.]+$/, "");
  return normalizeToken(fileName);
}

function findRelevantSourceFilesForDoc(
  docPath: string,
  sourceFiles: string[],
  symbols: ExportedSymbol[],
): string[] {
  let docContent = "";
  try {
    docContent = readFileSync(docPath, "utf-8").toLowerCase();
  } catch (err) {
    log("Error reading doc file for semantic mapping: %O", err);
    return [];
  }

  const docStem = getFileStem(docPath);
  const symbolMap = new Map<string, ExportedSymbol[]>();
  for (const symbol of symbols) {
    const existing = symbolMap.get(symbol.file) || [];
    existing.push(symbol);
    symbolMap.set(symbol.file, existing);
  }

  const scored = sourceFiles
    .map((sourceFile) => {
      let score = 0;
      const sourceStem = getFileStem(sourceFile);
      if (docStem && sourceStem && docStem === sourceStem) score += 8;
      else if (
        docStem &&
        sourceStem &&
        (docStem.includes(sourceStem) || sourceStem.includes(docStem))
      ) {
        score += 5;
      }

      const fileSymbols = symbolMap.get(sourceFile) || [];
      for (const symbol of fileSymbols) {
        if (docContent.includes(symbol.name.toLowerCase())) {
          score += 3;
        }
      }

      return { sourceFile, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, 3).map((entry) => entry.sourceFile);
}

async function getSourceDiffSinceDocRevision(
  git: SimpleGit,
  projectRoot: string,
  sourceFile: string,
  docRevision: GitFileRevision | null,
): Promise<string> {
  if (!docRevision) return "";

  try {
    const relSource = relative(projectRoot, sourceFile).replace(/\\/g, "/");
    return await git.diff([`${docRevision.hash}..HEAD`, "--", relSource]);
  } catch (err) {
    log("Error in getSourceDiffSinceDocRevision: %O", err);
    return "";
  }
}

function buildSemanticDriftPrompt(args: {
  docPath: string;
  docContent: string;
  sourceContexts: Array<{ file: string; diff: string; content: string }>;
}): string {
  const sourceContext = args.sourceContexts
    .map((item) => {
      const diffText = item.diff.trim() || "[no git diff available since last doc revision]";
      return [
        `SOURCE FILE: ${item.file}`,
        `RECENT DIFF:`,
        truncateForContext(diffText, 2000),
        `CURRENT SOURCE CONTENT:`,
        truncateForContext(item.content, 3000),
      ].join("\n");
    })
    .join("\n\n");

  return `Determine whether this documentation is semantically outdated relative to the source code.

Return strict JSON with this shape:
{"drift":"yes|no|uncertain","analysis":"short explanation","recommendedDocChanges":"optional suggested update"}

DOC FILE: ${args.docPath}
DOC CONTENT:
${truncateForContext(args.docContent, 3000)}

${sourceContext}`;
}

function parseSemanticDriftResult(response: string): SemanticDriftResult {
  const trimmed = response.trim();
  try {
    const parsed = JSON.parse(trimmed) as Partial<SemanticDriftResult>;
    return {
      drift:
        parsed.drift === "yes" || parsed.drift === "no" || parsed.drift === "uncertain"
          ? parsed.drift
          : "uncertain",
      analysis: typeof parsed.analysis === "string" ? parsed.analysis : trimmed,
      recommendedDocChanges:
        typeof parsed.recommendedDocChanges === "string"
          ? parsed.recommendedDocChanges
          : undefined,
    };
  } catch {
    return {
      drift: "uncertain",
      analysis: trimmed,
    };
  }
}

async function runSemanticDriftCheck(
  config: ProjectHealthConfig,
  projectRoot: string,
  git: SimpleGit,
  staleFinding: Finding,
  sourceFiles: string[],
  symbols: ExportedSymbol[],
): Promise<Finding | null> {
  const docPath = staleFinding.file;
  if (!docPath) return null;

  const relatedSources = findRelevantSourceFilesForDoc(docPath, sourceFiles, symbols);
  if (relatedSources.length === 0) {
    return {
      ...staleFinding,
      aiAnalysis: "Semantic drift check skipped: no relevant source files matched this document.",
      metadata: {
        ...staleFinding.metadata,
        aiAnalysis:
          "Semantic drift check skipped: no relevant source files matched this document.",
        aiSemanticCheck: "skipped",
        relatedSourceFiles: [],
      },
    };
  }

  let docContent = "";
  try {
    docContent = readFileSync(docPath, "utf-8");
  } catch (err) {
    log("Error reading doc file for semantic drift check: %O", err);
    return null;
  }

  const docRevision = await getFileLastRevision(git, docPath);
  const sourceContexts = await Promise.all(
    relatedSources.map(async (sourceFile) => {
      const content = readFileSync(sourceFile, "utf-8");
      const diff = await getSourceDiffSinceDocRevision(
        git,
        projectRoot,
        sourceFile,
        docRevision,
      );
      return {
        file: relative(projectRoot, sourceFile).replace(/\\/g, "/"),
        content,
        diff,
      };
    }),
  );

  const proxyUrl = config.proxy?.url;
  const apiKey = process.env.MEGALLM_API_KEY;
  const clientTarget = proxyUrl || apiKey;
  if (!clientTarget) {
    return {
      ...staleFinding,
      aiAnalysis:
        "Semantic drift check skipped: no MegaLLM proxy URL or API key is configured.",
      metadata: {
        ...staleFinding.metadata,
        aiAnalysis:
          "Semantic drift check skipped: no MegaLLM proxy URL or API key is configured.",
        aiSemanticCheck: "skipped",
        relatedSourceFiles: sourceContexts.map((item) => item.file),
      },
    };
  }

  try {
    const client = createAIClient(clientTarget);
    const response = await chat(
      client,
      [
        {
          role: "system",
          content:
            "You are validating whether a documentation file is semantically outdated relative to the current code. Be concise and evidence-based.",
        },
        {
          role: "user",
          content: buildSemanticDriftPrompt({
            docPath: relative(projectRoot, docPath).replace(/\\/g, "/"),
            docContent,
            sourceContexts,
          }),
        },
      ],
      {
        temperature: 0.1,
        maxTokens: 1200,
      },
    );

    const parsed = parseSemanticDriftResult(response);
    const aiAnalysis =
      parsed.recommendedDocChanges && parsed.recommendedDocChanges.trim().length > 0
        ? `${parsed.analysis}\nSuggested doc update: ${parsed.recommendedDocChanges}`
        : parsed.analysis;

    return {
      ...staleFinding,
      aiAnalysis,
      metadata: {
        ...staleFinding.metadata,
        aiAnalysis,
        aiSemanticCheck: "completed",
        aiDriftVerdict: parsed.drift,
        relatedSourceFiles: sourceContexts.map((item) => item.file),
      },
    };
  } catch (err) {
    const errorMessage =
      err instanceof Error ? err.message : "Semantic drift check failed";

    return {
      ...staleFinding,
      aiAnalysis: `Semantic drift check failed: ${errorMessage}`,
      metadata: {
        ...staleFinding.metadata,
        aiAnalysis: `Semantic drift check failed: ${errorMessage}`,
        aiSemanticCheck: "failed",
        relatedSourceFiles: sourceContexts.map((item) => item.file),
      },
    };
  }
}

async function checkDocStaleness(
  projectRoot: string,
  git: SimpleGit,
  stalenessDays: number,
): Promise<Finding[]> {
  const findings: Finding[] = [];

  const srcDir = join(projectRoot, "src");
  if (!existsSync(srcDir)) return findings;

  const srcLastModified = await getDirectoryLastModified(git, "src");
  if (!srcLastModified) return findings;

  const daysSinceSrc = Math.floor(
    (Date.now() - srcLastModified.getTime()) / (1000 * 60 * 60 * 24),
  );

  const docFiles = findDocFiles(projectRoot);

  for (const docFile of docFiles) {
    const docLastModified = await getFileLastModified(git, docFile.path);

    if (!docLastModified) continue;

    const daysSinceDoc = Math.floor(
      (Date.now() - docLastModified.getTime()) / (1000 * 60 * 60 * 24),
    );

    const gap = daysSinceSrc - daysSinceDoc;
    const isCritical = docFile.name.toLowerCase().startsWith("readme");
    const isApi = docFile.name.toLowerCase().includes("api");

    let severity: Severity = "LOW";
    let message = "";

    if (gap > stalenessDays * 2) {
      severity = isCritical ? "HIGH" : "MEDIUM";
      message = `${docFile.name} is stale (${daysSinceDoc} days old) but src/ changed ${daysSinceSrc} days ago (gap: ${gap} days)`;
    } else if (gap > stalenessDays) {
      severity = isCritical ? "MEDIUM" : "LOW";
      message = `${docFile.name} may be stale (${daysSinceDoc} days old, src/ changed ${daysSinceSrc} days ago)`;
    }

    if (severity !== "LOW") {
      findings.push({
        id: uuidv4(),
        moduleId: MODULE_ID,
        type: "STALE_DOC",
        severity,
        file: docFile.path,
        message,
        metadata: {
          docFile: docFile.name,
          daysSinceDoc,
          daysSinceSrc,
          gap,
        },
      });
    }
  }

  return findings;
}

function checkMissingChangelog(projectRoot: string): Finding | null {
  const changelogNames = [
    "CHANGELOG.md",
    "CHANGELOG.MD",
    "CHANGELOG",
    "CHANGELOG.txt",
    "CHANGELOG.rst",
    "CHANGELOG.mdx",
    "HISTORY.md",
    "HISTORY.MD",
  ];

  for (const name of changelogNames) {
    const path = join(projectRoot, name);
    if (existsSync(path)) {
      return null;
    }
  }

  return {
    id: uuidv4(),
    moduleId: MODULE_ID,
    type: "MISSING_CHANGELOG",
    severity: "MEDIUM" as Severity,
    message: "No CHANGELOG.md found. Document your release history.",
    metadata: {},
  };
}

function checkMissingApiDocs(projectRoot: string): Finding | null {
  const apiDocNames = [
    "API.md",
    "API.mdx",
    "API.rst",
    "docs/api.md",
    "docs/api.mdx",
    "doc/api.md",
    "api.md",
    "reference.md",
    "docs/reference.md",
  ];

  const srcDir = join(projectRoot, "src");
  if (!existsSync(srcDir)) return null;

  let hasExportedFunctions = false;
  try {
    const entries = readdirSync(srcDir, { withFileTypes: true });
    hasExportedFunctions = entries.length > 0;
  } catch (err) {
    log("Error checking for exports: %O", err);
  }

  if (!hasExportedFunctions) return null;

  for (const name of apiDocNames) {
    const path = join(projectRoot, name);
    if (existsSync(path)) {
      return null;
    }
  }

  return {
    id: uuidv4(),
    moduleId: MODULE_ID,
    type: "MISSING_CHANGELOG",
    severity: "LOW" as Severity,
    message:
      "No API documentation found. Consider adding API.md for public interfaces.",
    metadata: {},
  };
}

function extractExportedSymbols(files: string[]): ExportedSymbol[] {
  const symbols: ExportedSymbol[] = [];

  const patterns = {
    function: /(?:^export\s+(?:async\s+)?function\s+(\w+))/gm,
    class: /^export\s+class\s+(\w+)/gm,
    interface: /^export\s+interface\s+(\w+)/gm,
    type: /^export\s+type\s+(\w+)/gm,
    const: /^export\s+(?:const|let|var)\s+(\w+)/gm,
  };

  for (const file of files) {
    try {
      const content = readFileSync(file, "utf-8");
      const lines = content.split("\n");

      for (const [type, regex] of Object.entries(patterns)) {
        let match;
        const re = new RegExp(regex.source, regex.flags);
        while ((match = re.exec(content)) !== null) {
          const name = match[1];
          const matchStart = match.index;
          const lineNum = content.substring(0, matchStart).split("\n").length;

          const params: string[] = [];
          let hasJsdoc = false;
          let jsdocParams: string[] = [];

          if (lineNum > 1) {
            const prevLines = lines.slice(
              Math.max(0, lineNum - 6),
              lineNum - 1,
            );
            const prevContent = prevLines.join("\n");

            hasJsdoc =
              prevContent.includes("/**") || prevContent.includes("* @");

            const paramMatches = prevContent.matchAll(
              /@param\s+(?:\{[^}]+\}\s+)?(\w+)/g,
            );
            for (const pm of paramMatches) {
              jsdocParams.push(pm[1]);
            }
          }

          if (type === "function" || type === "const") {
            const funcMatch = content
              .substring(matchStart, matchStart + 200)
              .match(/\(([^)]*)\)/);
            if (funcMatch) {
              const paramsStr = funcMatch[1];
              params.push(
                ...paramsStr
                  .split(",")
                  .map((p) => p.trim())
                  .filter((p) => p && !p.startsWith("{")),
              );
            }
          }

          symbols.push({
            name,
            file,
            line: lineNum,
            type: type as ExportedSymbol["type"],
            params,
            hasJsdoc,
            jsdocParams,
          });
        }
      }
    } catch (err) {
      log("Error in extractExportedSymbols: %O", err);
    }
  }

  return symbols;
}

function checkMissingJsdoc(
  symbols: ExportedSymbol[],
  thresholdPercent: number = 30,
): Finding[] {
  const findings: Finding[] = [];

  const withoutDocs = symbols.filter((s) => !s.hasJsdoc);
  const missingPercent =
    symbols.length > 0 ? (withoutDocs.length / symbols.length) * 100 : 0;

  if (missingPercent < thresholdPercent) {
    return findings;
  }

  for (const symbol of withoutDocs.slice(0, 20)) {
    const severity: Severity =
      symbol.type === "class" || symbol.type === "interface" ? "MEDIUM" : "LOW";

    findings.push({
      id: uuidv4(),
      moduleId: MODULE_ID,
      type: "MISSING_JSDOC",
      severity,
      file: symbol.file,
      line: symbol.line,
      message: `Exported ${symbol.type} '${symbol.name}' lacks JSDoc comment`,
      metadata: {
        exportName: symbol.name,
        exportType: symbol.type,
        exportLine: symbol.line,
      },
    });
  }

  if (withoutDocs.length > 20) {
    findings.push({
      id: uuidv4(),
      moduleId: MODULE_ID,
      type: "MISSING_JSDOC",
      severity: "MEDIUM" as Severity,
      message: `... and ${withoutDocs.length - 20} more exports without JSDoc`,
      metadata: { additionalCount: withoutDocs.length - 20 },
    });
  }

  return findings;
}

function checkApiDocDrift(files: string[]): Finding[] {
  const findings: Finding[] = [];

  const jsdocParamRegex = /@param\s+(?:\{[^}]+\}\s+)?(\w+)/g;
  const functionSignatureRegex =
    /(?:function\s+(\w+)|export\s+(?:async\s+)?function\s+(\w+))\s*\(([^)]*)\)/g;

  for (const file of files) {
    try {
      const content = readFileSync(file, "utf-8");
      const lines = content.split("\n");

      const jsdocParams: Map<number, { paramName: string; lineNum: number }[]> =
        new Map();

      let match;
      while ((match = jsdocParamRegex.exec(content)) !== null) {
        const paramName = match[1];
        const matchStart = match.index;
        const lineNum = content.substring(0, matchStart).split("\n").length;

        const existing = jsdocParams.get(lineNum) || [];
        existing.push({ paramName, lineNum });
        jsdocParams.set(lineNum, existing);
      }

      const functionMatches = content.matchAll(functionSignatureRegex);

      for (const funcMatch of functionMatches) {
        const funcName = funcMatch[1] || funcMatch[2];
        const paramsStr = funcMatch[3];
        const matchStart = funcMatch.index;
        const funcLine = content.substring(0, matchStart).split("\n").length;

        const actualParams = paramsStr
          .split(",")
          .map((p) => p.trim())
          .filter(
            (p) => p.length > 0 && !p.startsWith("{") && !p.startsWith("@"),
          )
          .map((p) => {
            const parts = p.split(":");
            return parts[0].trim();
          });

        const nearbyJsdocParams = jsdocParams.get(funcLine) || [];
        for (const jsdocParam of nearbyJsdocParams) {
          if (
            jsdocParam.paramName &&
            !actualParams.includes(jsdocParam.paramName)
          ) {
            findings.push({
              id: uuidv4(),
              moduleId: MODULE_ID,
              type: "API_DOC_DRIFT",
              severity: "MEDIUM" as Severity,
              file: file,
              line: jsdocParam.lineNum,
              message: `JSDoc @param '${jsdocParam.paramName}' doesn't match function '${funcName}' signature`,
              metadata: {
                paramName: jsdocParam.paramName,
                functionName: funcName,
                actualParams,
              },
            });
          }
        }
      }
    } catch (err) {
      log("Error in checkApiDocDrift: %O", err);
    }
  }

  return findings;
}

export async function runDocsModule(
  config: ProjectHealthConfig,
): Promise<ModuleResult> {
  const startTime = Date.now();
  const findings: Finding[] = [];

  const docsConfig = config.modules.docs;
  const stalenessDays = docsConfig.stalenessDays || 14;

  if (!docsConfig.enabled) {
    return {
      moduleId: MODULE_ID,
      moduleName: MODULE_NAME,
      score: 100,
      status: "ok",
      findings: [],
      metadata: { enabled: false },
      durationMs: Date.now() - startTime,
    };
  }

  const projectRoot = process.cwd();

  try {
    const git = simpleGit(projectRoot);
    const sourceFiles = findSourceFiles(projectRoot);

    const stalenessFindings = await checkDocStaleness(
      projectRoot,
      git,
      stalenessDays,
    );
    const symbols = extractExportedSymbols(sourceFiles);

    const staleDocFindings = docsConfig.aiSemanticCheck
      ? await Promise.all(
          stalenessFindings.map((finding) =>
            runSemanticDriftCheck(
              config,
              projectRoot,
              git,
              finding,
              sourceFiles,
              symbols,
            ),
          ),
        )
      : stalenessFindings;
    findings.push(
      ...staleDocFindings.filter((finding): finding is Finding => finding !== null),
    );

    const changelogFinding = checkMissingChangelog(projectRoot);
    if (changelogFinding) {
      findings.push(changelogFinding);
    }

    const apiDocsFinding = checkMissingApiDocs(projectRoot);
    if (apiDocsFinding) {
      findings.push(apiDocsFinding);
    }

    const jsdocFindings = checkMissingJsdoc(symbols, 30);
    findings.push(...jsdocFindings);

    const apiDriftFindings = checkApiDocDrift(sourceFiles);
    findings.push(...apiDriftFindings);

    const score = calculateModuleScore(findings);

    return {
      moduleId: MODULE_ID,
      moduleName: MODULE_NAME,
      score,
      status: score >= 80 ? "ok" : score >= 60 ? "warning" : "error",
      findings,
      metadata: {
        sourceFiles: sourceFiles.length,
        exportedSymbols: symbols.length,
        stalenessDays,
        checksPerformed: [
          "DOC_STALENESS",
          "MISSING_CHANGELOG",
          "MISSING_API_DOCS",
          "MISSING_JSDOC",
          "API_DOC_DRIFT",
          ...(docsConfig.aiSemanticCheck ? ["AI_SEMANTIC_CHECK"] : []),
        ],
        aiSemanticCheck: docsConfig.aiSemanticCheck,
      },
      durationMs: Date.now() - startTime,
    };
  } catch (error) {
    return {
      moduleId: MODULE_ID,
      moduleName: MODULE_NAME,
      score: 0,
      status: "error",
      findings: [
        {
          id: uuidv4(),
          moduleId: MODULE_ID,
          type: "STALE_DOC",
          severity: "CRITICAL" as Severity,
          message:
            error instanceof Error
              ? error.message
              : "Docs Freshness scan failed",
          metadata: { error: String(error) },
        },
      ],
      metadata: { error: String(error) },
      durationMs: Date.now() - startTime,
    };
  }
}

function calculateModuleScore(findings: Finding[]): number {
  if (findings.length === 0) return 100;

  const criticalCount = findings.filter(
    (f) => f.severity === "CRITICAL",
  ).length;
  const highCount = findings.filter((f) => f.severity === "HIGH").length;
  const mediumCount = findings.filter((f) => f.severity === "MEDIUM").length;
  const lowCount = findings.filter((f) => f.severity === "LOW").length;

  const deductions =
    criticalCount * 20 + highCount * 15 + mediumCount * 8 + lowCount * 2;

  return Math.max(0, Math.min(100, 100 - deductions));
}

export default runDocsModule;
