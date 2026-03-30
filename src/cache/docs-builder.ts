// docs-builder.ts - Build docs index mapping source files to doc sections
// Maps source files to doc section headings for AI-05 Commit Doc Updater

import { promises as fs } from "node:fs";
import { join, extname } from "node:path";
import { simpleGit, SimpleGit } from "simple-git";
import { DocsIndex } from "../types/index.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("ph:cache");

interface DocSection {
  file: string;
  heading: string;
  content: string;
}

// Find all source files in the project
async function findSourceFiles(projectRoot: string): Promise<string[]> {
  const extensions = [
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".py",
    ".go",
    ".rs",
    ".java",
  ];
  const files: string[] = [];

  async function searchDir(dir: string, depth: number = 0): Promise<void> {
    if (depth > 10) return; // Prevent infinite recursion

    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        if (
          entry.name.startsWith(".") ||
          entry.name === "node_modules" ||
          entry.name === "dist" ||
          entry.name === "build"
        ) {
          continue;
        }

        const fullPath = join(dir, entry.name);

        if (entry.isDirectory()) {
          await searchDir(fullPath, depth + 1);
        } else if (extensions.includes(extname(entry.name).toLowerCase())) {
          files.push(fullPath);
        }
      }
    } catch (err) {
      log("Error in searchDir: %O", err);
      // Skip directories we can't access
    }
  }

  await searchDir(projectRoot);
  return files;
}

// Find all documentation files
async function findDocFiles(projectRoot: string): Promise<string[]> {
  const extensions = [".md", ".rst", ".txt", ".adoc"];
  const files: string[] = [];

  const docDirs = ["docs", "doc", "documentation", "guides", "api", "wiki"];

  async function searchDir(dir: string, depth: number = 0): Promise<void> {
    if (depth > 10) return;

    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.name.startsWith(".") || entry.name === "node_modules") {
          continue;
        }

        const fullPath = join(dir, entry.name);

        if (entry.isDirectory()) {
          await searchDir(fullPath, depth + 1);
        } else if (extensions.includes(extname(entry.name).toLowerCase())) {
          files.push(fullPath);
        }
      }
    } catch (err) {
      log("Error in searchDir: %O", err);
      // Skip
    }
  }

  // Search common doc directories
  for (const dir of docDirs) {
    await searchDir(join(projectRoot, dir));
  }

  // Also check root level markdown files
  try {
    const rootEntries = await fs.readdir(projectRoot);
    for (const entry of rootEntries) {
      if (extensions.includes(extname(entry).toLowerCase())) {
        files.push(join(projectRoot, entry));
      }
    }
  } catch (err) {
    log("Error in findDocFiles: %O", err);
    // Ignore
  }

  return files;
}

// Extract symbols from a source file
async function extractSymbols(filePath: string): Promise<string[]> {
  const symbols: string[] = [];
  const ext = extname(filePath).toLowerCase();

  if (![".ts", ".tsx", ".js", ".jsx"].includes(ext)) {
    return symbols;
  }

  try {
    const content = await fs.readFile(filePath, "utf-8");

    // Extract function names
    const functionMatches = content.matchAll(
      /(?:function|const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*(?:=|\(|,)/g,
    );
    for (const match of functionMatches) {
      if (match[1] && match[1].length > 2) {
        symbols.push(match[1]);
      }
    }

    // Extract class names
    const classMatches = content.matchAll(
      /class\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g,
    );
    for (const match of classMatches) {
      if (match[1]) {
        symbols.push(match[1]);
      }
    }

    // Extract interface names
    const interfaceMatches = content.matchAll(
      /interface\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g,
    );
    for (const match of interfaceMatches) {
      if (match[1]) {
        symbols.push(match[1]);
      }
    }

    // Extract type aliases
    const typeMatches = content.matchAll(
      /type\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=/g,
    );
    for (const match of typeMatches) {
      if (match[1]) {
        symbols.push(match[1]);
      }
    }
  } catch (err) {
    log("Error in extractSymbols: %O", err);
    // Ignore read errors
  }

  return [...new Set(symbols)]; // Remove duplicates
}

// Extract sections from a markdown file
async function extractDocSections(docPath: string): Promise<DocSection[]> {
  const sections: DocSection[] = [];

  try {
    const content = await fs.readFile(docPath, "utf-8");
    const lines = content.split("\n");

    let currentHeading = "";
    let currentContent = "";
    let headingLine = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Match markdown headings (# Heading, ## Heading, etc.)
      const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);

      if (headingMatch) {
        // Save previous section
        if (currentHeading) {
          sections.push({
            file: docPath,
            heading: currentHeading,
            content: currentContent.trim(),
          });
        }

        currentHeading = headingMatch[2].trim();
        currentContent = "";
        headingLine = i + 1;
      } else {
        currentContent += line + "\n";
      }
    }

    // Add last section
    if (currentHeading) {
      sections.push({
        file: docPath,
        heading: currentHeading,
        content: currentContent.trim(),
      });
    }
  } catch (err) {
    log("Error in extractDocSections: %O", err);
    // Ignore read errors
  }

  return sections;
}

// Normalize heading to anchor-friendly format
function headingToAnchor(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .trim();
}

// Build the docs index
export async function buildDocsIndex(projectRoot: string): Promise<DocsIndex> {
  const index: DocsIndex = {};

  const sourceFiles = await findSourceFiles(projectRoot);
  const docFiles = await findDocFiles(projectRoot);

  // For each source file, find which doc sections reference its symbols
  for (const sourceFile of sourceFiles) {
    const symbols = await extractSymbols(sourceFile);
    const relativeSource = sourceFile
      .replace(projectRoot, "")
      .replace(/^[/\\]/, "")
      .replace(/^\\/, "");

    if (symbols.length === 0) continue;

    // For each doc file, check which sections reference these symbols
    for (const docFile of docFiles) {
      const sections = await extractDocSections(docFile);

      for (const section of sections) {
        const sectionAnchor = `${section.file
          .replace(projectRoot, "")
          .replace(/^[/\\]/, "")
          .replace(/^\\/, "")}#${headingToAnchor(section.heading)}`;

        for (const symbol of symbols) {
          // Check if symbol is mentioned in section content (case-insensitive)
          const regex = new RegExp(`\\b${symbol}\\b`, "i");
          if (regex.test(section.content) || regex.test(section.heading)) {
            // Add to index - source file -> list of doc sections
            const existing = index[relativeSource] || [];
            if (!existing.includes(sectionAnchor)) {
              existing.push(sectionAnchor);
            }
            index[relativeSource] = existing;
          }
        }
      }
    }
  }

  return index;
}

// Build and save the docs index to cache
export async function buildAndSaveDocsIndex(
  projectRoot: string,
  cachePath: string,
): Promise<DocsIndex> {
  const index = await buildDocsIndex(projectRoot);

  // Save to cache
  const indexPath = join(cachePath, "docs-index.json");
  await fs.writeFile(indexPath, JSON.stringify(index, null, 2), "utf-8");

  return index;
}

// Get the doc section that references a specific source file
export async function getDocSectionsForFile(
  projectRoot: string,
  sourceFile: string,
): Promise<string[]> {
  const index = await buildDocsIndex(projectRoot);
  const relativeSource = sourceFile
    .replace(projectRoot, "")
    .replace(/^[/\\]/, "")
    .replace(/^\\/, "");
  return index[relativeSource] || [];
}

export default buildDocsIndex;
