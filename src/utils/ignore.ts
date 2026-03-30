// Shared ignore list for all analysis modules
// These directories should NEVER be scanned or included in results

import { relative } from "node:path";

// Directories to always skip (exact match on directory name)
export const IGNORED_DIRS = new Set([
  "node_modules",
  ".next",
  "dist",
  "build",
  "out",
  ".git",
  ".ph-cache",
  ".turbo",
  ".cache",
  ".parcel-cache",
  ".eslintcache",
  ".nuxt",
  ".svelte-kit",
  ".output",
  ".vercel",
  ".netlify",
  "coverage",
  ".nyc_output",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".venv",
  "venv",
  "env",
  ".env.local",
  "vendor",
  "target",
  ".gradle",
  ".idea",
  ".vscode",
  ".DS_Store",
  "tmp",
  "temp",
  ".tmp",
  ".swo",
  "logs",
  ".terraform",
  "cdk.out",
  ".serverless",
  ".aws-sam",
]);

// Files to always skip
export const IGNORED_FILES = new Set([
  ".DS_Store",
  "Thumbs.db",
  ".env.local",
  ".env.production",
  ".env.development",
]);

// File extensions that are NEVER source code
export const NON_SOURCE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".ico",
  ".webp",
  ".avif",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".otf",
  ".mp3",
  ".mp4",
  ".wav",
  ".ogg",
  ".webm",
  ".zip",
  ".tar",
  ".gz",
  ".rar",
  ".7z",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".bin",
  ".map",
  ".lock",
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
]);

// Source code extensions for analysis
export const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".c",
  ".cpp",
  ".cs",
  ".h",
  ".hpp",
  ".php",
  ".swift",
  ".scala",
  ".clj",
  ".vue",
  ".svelte",
  ".astro",
]);

// Documentation extensions
export const DOC_EXTENSIONS = new Set([
  ".md",
  ".mdx",
  ".rst",
  ".txt",
  ".adoc",
  ".asciidoc",
]);

// Configuration extensions
export const CONFIG_EXTENSIONS = new Set([
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".cfg",
  ".conf",
  ".env",
  ".env.example",
]);

/**
 * Check if a relative path should be ignored
 * @param relPath - path relative to project root (uses forward slashes)
 */
export function shouldIgnorePath(relPath: string): boolean {
  const parts = relPath.replace(/\\/g, "/").split("/");
  const fileName = parts[parts.length - 1];

  // Never ignore well-known dotfiles that should be scanned
  const allowListedDotFiles = new Set([
    ".gitlab-ci.yml",
    ".gitlab-ci.yaml",
    ".circleci",
    ".env",
    ".env.example",
    ".env.development",
    ".env.production",
    ".env.test",
    ".eslintignore",
    ".eslintrc",
    ".eslintrc.json",
    ".eslintrc.js",
    ".prettierignore",
    ".prettierrc",
    ".nvmrc",
    ".node-version",
    ".editorconfig",
    ".gitignore",
    ".dockerignore",
    ".npmrc",
    ".browserslistrc",
  ]);

  // Check each path segment for ignored directories
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (IGNORED_DIRS.has(part)) {
      return true;
    }
    // Skip hidden directories except well-known CI config dirs
    if (
      part.startsWith(".") &&
      part !== ".github" &&
      part !== ".gitlab" &&
      part !== ".circleci"
    ) {
      return true;
    }
  }

  // Check the file itself
  if (fileName && IGNORED_FILES.has(fileName)) {
    return true;
  }

  // Allow well-known dotfiles even if they start with "."
  if (fileName && allowListedDotFiles.has(fileName)) {
    return false;
  }

  // Ignore hidden files (but not the allow-listed ones above)
  if (
    fileName &&
    fileName.startsWith(".") &&
    !allowListedDotFiles.has(fileName)
  ) {
    return true;
  }

  return false;
}

/**
 * Check if a file path is a source file
 */
export function isSourceFile(filePath: string): boolean {
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  return SOURCE_EXTENSIONS.has(ext);
}

/**
 * Check if a file path is a documentation file
 */
export function isDocFile(filePath: string): boolean {
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  return DOC_EXTENSIONS.has(ext);
}

/**
 * Check if a file is a configuration file
 */
export function isConfigFile(filePath: string): boolean {
  const fileName = filePath.slice(filePath.lastIndexOf("/") + 1);
  if (
    fileName.startsWith(".") ||
    fileName.endsWith(".config.ts") ||
    fileName.endsWith(".config.js")
  ) {
    return true;
  }
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  return CONFIG_EXTENSIONS.has(ext);
}

/**
 * Get the relative path from project root, normalized to forward slashes
 */
export function getRelativePath(projectRoot: string, fullPath: string): string {
  return relative(projectRoot, fullPath).replace(/\\/g, "/");
}
