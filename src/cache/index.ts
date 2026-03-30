import {
  promises as fs,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import {
  HealthReport,
  AstIndex,
  DocsIndex,
  ChatSession,
  ScanContext,
  Finding,
} from "../types/index.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("ph:cache");

const CACHE_DIR = ".ph-cache";

export class CacheManager {
  private rootPath: string;

  constructor(projectRoot: string) {
    this.rootPath = projectRoot;
  }

  private get cachePath(): string {
    return join(this.rootPath, CACHE_DIR);
  }

  async ensureCacheDir(): Promise<void> {
    try {
      await fs.mkdir(this.cachePath, { recursive: true });
    } catch (err) {
      log("Error in ensureCacheDir: %O", err);
      // Directory might already exist
    }
  }

  private async readJson<T>(filename: string): Promise<T | null> {
    try {
      const filePath = join(this.cachePath, filename);
      const content = await fs.readFile(filePath, "utf-8");
      return JSON.parse(content) as T;
    } catch (err) {
      log("Error in readJson: %O", err);
      return null;
    }
  }

  private async writeJson<T>(filename: string, data: T): Promise<void> {
    await this.ensureCacheDir();
    const filePath = join(this.cachePath, filename);
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
  }

  // Health report cache
  async getLastScan(): Promise<HealthReport | null> {
    return this.readJson<HealthReport>("last-scan.json");
  }

  async saveLastScan(report: HealthReport): Promise<void> {
    await this.writeJson("last-scan.json", report);
  }

  // AST index for ph ask
  async getAstIndex(): Promise<AstIndex | null> {
    return this.readJson<AstIndex>("ast-index.json");
  }

  async saveAstIndex(index: AstIndex): Promise<void> {
    await this.writeJson("ast-index.json", index);
  }

  // Docs index for doc freshness
  async getDocsIndex(): Promise<DocsIndex | null> {
    return this.readJson<DocsIndex>("docs-index.json");
  }

  async saveDocsIndex(index: DocsIndex): Promise<void> {
    await this.writeJson("docs-index.json", index);
  }

  // Chat sessions
  async getSession(sessionId: string): Promise<ChatSession | null> {
    return this.readJson<ChatSession>(`sessions/${sessionId}.json`);
  }

  async saveSession(session: ChatSession): Promise<void> {
    await this.ensureCacheDir();
    const sessionsDir = join(this.cachePath, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    await this.writeJson(`sessions/${session.id}.json`, session);
  }

  async listSessions(): Promise<string[]> {
    try {
      const sessionsDir = join(this.cachePath, "sessions");
      const files = await fs.readdir(sessionsDir);
      return files
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.replace(".json", ""));
    } catch (err) {
      log("Error in listSessions: %O", err);
      return [];
    }
  }

  // Get cache path for external reference
  getCachePath(): string {
    return this.cachePath;
  }

  // Check if cache exists
  async isInitialized(): Promise<boolean> {
    try {
      await fs.access(this.cachePath);
      return true;
    } catch (err) {
      log("Error in isInitialized: %O", err);
      return false;
    }
  }

  // Clear all cache
  async clearCache(): Promise<void> {
    try {
      await fs.rm(this.cachePath, { recursive: true, force: true });
    } catch (err) {
      log("Error in clearCache: %O", err);
      // Ignore errors
    }
  }
}

// Factory function for convenience
export function createCacheManager(projectRoot?: string): CacheManager {
  const root = projectRoot ?? process.cwd();
  return new CacheManager(root);
}

// Check if .ph-cache exists (for ph init)
export async function checkCacheExists(projectRoot: string): Promise<boolean> {
  const cachePath = resolve(projectRoot, CACHE_DIR);
  try {
    await fs.access(cachePath);
    return true;
  } catch (err) {
    log("Error in checkCacheExists: %O", err);
    return false;
  }
}

// Create cache directory (for ph init)
export async function initCache(projectRoot: string): Promise<string> {
  const cache = new CacheManager(projectRoot);
  await cache.ensureCacheDir();
  return cache.getCachePath();
}

// ─── File-level incremental caching ─────────────────────────────────────────

export interface FileCache {
  [filePath: string]: {
    hash: string;
    findings: Finding[];
    analyzedAt: string;
  };
}

export function computeFileHash(filePath: string): string {
  const content = readFileSync(filePath, "utf-8");
  return createHash("sha256").update(content).digest("hex");
}

export function loadFileCache(projectRoot: string): FileCache {
  try {
    const cachePath = join(projectRoot, CACHE_DIR, "file-cache.json");
    const content = readFileSync(cachePath, "utf-8");
    return JSON.parse(content) as FileCache;
  } catch (err) {
    log("Error in loadFileCache: %O", err);
    return {};
  }
}

export function saveFileCache(projectRoot: string, cache: FileCache): void {
  const cacheDir = join(projectRoot, CACHE_DIR);
  try {
    mkdirSync(cacheDir, { recursive: true });
  } catch (err) {
    log("Error in saveFileCache: %O", err);
  }
  const cachePath = join(cacheDir, "file-cache.json");
  writeFileSync(cachePath, JSON.stringify(cache, null, 2), "utf-8");
}

export function getCachedFindings(
  cache: FileCache,
  filePath: string,
): Finding[] | null {
  const entry = cache[filePath];
  if (!entry) return null;

  try {
    const currentHash = computeFileHash(filePath);
    if (entry.hash !== currentHash) return null;
    return entry.findings;
  } catch (err) {
    log("Error in getCachedFindings: %O", err);
    return null;
  }
}

export function setCachedFindings(
  cache: FileCache,
  filePath: string,
  findings: Finding[],
): void {
  try {
    const hash = computeFileHash(filePath);
    cache[filePath] = {
      hash,
      findings,
      analyzedAt: new Date().toISOString(),
    };
  } catch (err) {
    log("Error in setCachedFindings: %O", err);
    // File not found or unreadable, skip caching
  }
}
