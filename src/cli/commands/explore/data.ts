// ph explore — data gathering and file tree construction

import { simpleGit, type SimpleGit } from "simple-git";
import { join, relative } from "node:path";
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { createCacheManager } from "../../../cache/index.js";
import { createLogger } from "../../../utils/logger.js";
import {
  analyzeProject,
  formatProjectOverview,
} from "../../../utils/project-analyzer.js";
import type {
  FileEntry,
  CommitInfo,
  GitFileInfo,
  ExploreAnalysis,
  ExploreSnapshot,
  HeatLevel,
} from "./types.js";

const log = createLogger("ph:explore");

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function toFwd(p: string): string {
  return p.replace(/\\/g, "/");
}

function relPath(root: string, fullPath: string): string {
  return toFwd(relative(root, fullPath));
}

// ---------------------------------------------------------------------------
// Age helpers
// ---------------------------------------------------------------------------

export function formatAge(dateStr: string): string {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return "unknown";
  const ms = Date.now() - d.getTime();
  const sec = Math.floor(ms / 1000);
  const min = Math.floor(sec / 60);
  const hrs = Math.floor(min / 60);
  const days = Math.floor(hrs / 24);

  if (sec < 60) return "just now";
  if (min < 60) return `${min}m ago`;
  if (hrs < 24) return `${hrs}h ago`;
  if (days === 1) return "1 day ago";
  if (days < 7) return `${days} days ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

function parseAgeDays(dateStr: string): number {
  if (!dateStr || dateStr === "unknown") return 999;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return 999;
  return (Date.now() - d.getTime()) / (1000 * 60 * 60 * 24);
}

// ---------------------------------------------------------------------------
// Heat calculation
// ---------------------------------------------------------------------------

export function heatRank(h: string): number {
  return { h1: 5, h2: 4, h3: 3, h4: 2, h5: 1 }[h] ?? 1;
}

function calcHeat(changeCount: number, lastDate: string): HeatLevel {
  const days = parseAgeDays(lastDate);
  if (days <= 1 && changeCount >= 3) return "h1";
  if (days <= 3 && changeCount >= 2) return "h2";
  if (days <= 7 && changeCount >= 1) return "h3";
  if (days <= 30) return "h4";
  return "h5";
}

// ---------------------------------------------------------------------------
// Git data gathering
// ---------------------------------------------------------------------------

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf899d69f82bf0207";

/**
 * Collect last-commit metadata + change count per file from the last 200 commits.
 */
export async function gatherGitFileInfo(
  git: SimpleGit,
): Promise<Map<string, GitFileInfo>> {
  const map = new Map<string, GitFileInfo>();
  try {
    const raw = await git.raw([
      "log",
      "--name-only",
      "--format=__COMMIT__%H|%an|%aI|%s",
      "--diff-filter=AM",
      "-200",
    ]);
    const lines = raw.replace(/\r\n/g, "\n").split("\n");
    let hash = "",
      author = "",
      date = "",
      msg = "";

    for (const line of lines) {
      if (line.startsWith("__COMMIT__")) {
        const parts = line.slice(10).split("|");
        hash = parts[0] || "";
        author = parts[1] || "Unknown";
        date = parts[2] || "";
        msg = parts.slice(3).join("|") || "No message";
      } else if (line.trim()) {
        const fp = toFwd(line.trim());
        if (!fp || fp.startsWith(".git/")) continue;
        if (!map.has(fp)) {
          map.set(fp, { hash, author, date, message: msg, changeCount: 0 });
        }
        map.get(fp)!.changeCount++;
      }
    }
  } catch (err) {
    log("gatherGitFileInfo error: %O", err);
  }
  return map;
}

/**
 * Get up to 20 commits touching `filePath` with +/- stats.
 */
export async function getFileCommits(
  git: SimpleGit,
  filePath: string,
): Promise<CommitInfo[]> {
  try {
    const logResult = await git.log({
      file: filePath,
      maxCount: 20,
      format: { hash: "%H", message: "%s", author_name: "%an", date: "%aI" },
    });
    const commits: CommitInfo[] = [];
    for (const c of logResult.all) {
      let additions = 0,
        deletions = 0;
      try {
        const parent = await git
          .raw(["rev-parse", `${c.hash}^`])
          .catch(() => null);
        const base = parent ? `${c.hash}~1` : EMPTY_TREE;
        const stats = await git.diff([
          base,
          c.hash,
          "--",
          filePath,
          "--numstat",
        ]);
        const parts = stats.trim().split(/\s+/);
        if (parts.length >= 2) {
          additions = parseInt(parts[0]) || 0;
          deletions = parseInt(parts[1]) || 0;
        }
      } catch {
        /* stats unavailable */
      }
      commits.push({
        hash: c.hash.substring(0, 7),
        fullHash: c.hash,
        message: c.message,
        author: c.author_name,
        date: c.date,
        age: formatAge(c.date),
        additions,
        deletions,
      });
    }
    return commits;
  } catch (err) {
    log("getFileCommits error for %s: %O", filePath, err);
    return [];
  }
}

/**
 * Get unified diff for a commit+file pair. Returns at most 200 lines.
 */
export async function getCommitDiff(
  git: SimpleGit,
  commitHash: string,
  filePath: string,
): Promise<string[]> {
  try {
    const fullHash = (await git.raw(["rev-parse", commitHash])).trim();
    const parent = await git
      .raw(["rev-parse", `${fullHash}^`])
      .catch(() => null);
    const base = parent ? `${fullHash}~1` : EMPTY_TREE;
    const diff = await git.diff([base, fullHash, "--", filePath]);
    if (!diff) return ["(no changes detected for this file in this commit)"];
    return diff.split("\n").slice(0, 200);
  } catch (err) {
    log("getCommitDiff error: %O", err);
    return ["(failed to load diff)"];
  }
}

/**
 * Read file content at a given commit hash (or null on failure).
 */
export async function getFileContent(
  git: SimpleGit,
  commitHash: string,
  filePath: string,
): Promise<string | null> {
  try {
    return await git.show([`${commitHash}:${filePath}`]);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// File tree
// ---------------------------------------------------------------------------

const IGNORED_PREFIXES = new Set([
  "node_modules",
  "dist",
  "build",
  ".git",
  "ai-proxy",
  "__tests__",
]);

/**
 * Walk the filesystem and build a hierarchical file tree enriched with git metadata.
 */
export function buildFileTree(
  projectRoot: string,
  gitMap: Map<string, GitFileInfo>,
): FileEntry[] {
  const dirs = new Map<string, FileEntry>();
  const files: FileEntry[] = [];

  function walk(dir: string) {
    let items: string[];
    try {
      items = readdirSync(dir);
    } catch {
      return;
    }

    for (const name of items) {
      if (name.startsWith(".") || IGNORED_PREFIXES.has(name)) continue;
      const full = join(dir, name);
      const rel = relPath(projectRoot, full);

      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }

      if (st.isDirectory()) {
        if (!dirs.has(full)) {
          dirs.set(full, {
            path: rel,
            type: "dir",
            name,
            children: [],
            changeCount: 0,
            heat: "h5",
          });
        }
        walk(full);
      } else {
        const gi = gitMap.get(rel);
        const cc = gi?.changeCount ?? 0;
        const lastDate = gi?.date ?? "";
        files.push({
          path: rel,
          type: "file",
          name,
          lastCommit: gi
            ? {
                hash: gi.hash.substring(0, 7),
                message: gi.message,
                author: gi.author,
                date: gi.date,
                age: formatAge(gi.date),
              }
            : undefined,
          changeCount: cc,
          heat: calcHeat(cc, lastDate),
        });
      }
    }
  }

  walk(projectRoot);

  // Merge dirs + files into a flat list, then build hierarchy
  const all = [...dirs.values(), ...files];
  return nest(all);
}

/**
 * Turn a flat list (dirs + files) into a nested tree.
 */
function nest(entries: FileEntry[]): FileEntry[] {
  const dirMap = new Map<string, FileEntry>();
  const roots: FileEntry[] = [];

  for (const e of entries) {
    if (e.type === "dir") {
      e.children = [];
      dirMap.set(e.path, e);
    }
  }

  for (const e of entries) {
    const parts = e.path.split("/");
    if (parts.length === 1) {
      roots.push(e);
    } else {
      const parentPath = parts.slice(0, -1).join("/");
      const parent = dirMap.get(parentPath);
      if (parent?.children) {
        parent.children.push(e);
      } else {
        roots.push(e);
      }
    }
  }

  // Sort: dirs first, then alphabetical
  function sortTree(list: FileEntry[]) {
    list.sort((a, b) =>
      a.type !== b.type
        ? a.type === "dir"
          ? -1
          : 1
        : a.name.localeCompare(b.name),
    );
    for (const e of list) if (e.children) sortTree(e.children);
  }
  sortTree(roots);

  // Propagate heat upwards through directories
  function aggregateHeat(e: FileEntry): void {
    if (e.type !== "dir" || !e.children) return;
    let best: HeatLevel = "h5";
    let total = 0;
    let latest = "";
    for (const ch of e.children) {
      if (ch.type === "dir") aggregateHeat(ch);
      total += ch.changeCount;
      if (heatRank(ch.heat) > heatRank(best)) best = ch.heat;
      if (
        ch.lastCommit &&
        (!latest || new Date(ch.lastCommit.date) > new Date(latest))
      ) {
        latest = ch.lastCommit.date;
      }
    }
    e.heat = best;
    e.changeCount = total;
    if (latest) {
      e.lastCommit = {
        hash: "",
        message: "",
        author: "",
        date: latest,
        age: formatAge(latest),
      };
    }
  }
  for (const e of roots) aggregateHeat(e);

  return roots;
}

// ---------------------------------------------------------------------------
// Flatten & analysis
// ---------------------------------------------------------------------------

export function flattenFiles(entries: FileEntry[]): FileEntry[] {
  const out: FileEntry[] = [];
  for (const e of entries) {
    out.push(e);
    if (e.children) out.push(...flattenFiles(e.children));
  }
  return out;
}

function buildAnalysis(
  projectRoot: string,
  files: FileEntry[],
  astIndex: Record<string, { file: string; line: number; kind: string }> | null,
  lastScan: any,
): ExploreAnalysis {
  const desc = analyzeProject(projectRoot);
  const flat = flattenFiles(files).filter((e) => e.type === "file");

  const hotFiles = flat
    .sort(
      (a, b) =>
        heatRank(b.heat) - heatRank(a.heat) || b.changeCount - a.changeCount,
    )
    .slice(0, 8)
    .map((e) => ({
      path: e.path,
      changeCount: e.changeCount,
      heat: e.heat,
      lastAge: e.lastCommit?.age ?? "unknown",
    }));

  const symEntries = Object.entries(astIndex ?? {});
  const uniqueFiles = new Set(
    symEntries.map(([, s]) => s.file).filter(Boolean),
  );

  return {
    descriptor: {
      name: desc.name,
      type: desc.type,
      language: desc.language,
      framework: desc.framework,
      fileCount: desc.fileCount,
      dependencyCount: desc.dependencyCount,
      moduleCount: desc.moduleCount,
    },
    overview: formatProjectOverview(desc),
    healthScore: lastScan?.score ?? null,
    generatedAt: lastScan?.generatedAt ?? null,
    hotFiles,
    moduleScores:
      lastScan?.modules?.map((m: any) => ({
        moduleId: m.moduleId,
        moduleName: m.moduleName,
        score: m.score,
        status: m.status,
        findingCount: m.findings?.length ?? 0,
      })) ?? [],
    topFindings:
      lastScan?.findings?.slice(0, 8).map((f: any) => ({
        severity: f.severity,
        type: f.type,
        message: f.message,
        file: f.file,
      })) ?? [],
    topActions: lastScan?.topActions?.slice(0, 5) ?? [],
    symbolSummary: {
      totalSymbols: symEntries.length,
      uniqueFiles: uniqueFiles.size,
      sample: symEntries.slice(0, 8).map(([name, s]) => ({
        name,
        file: s.file,
        kind: s.kind,
        line: s.line,
      })),
    },
  };
}

// ---------------------------------------------------------------------------
// Snapshot builder
// ---------------------------------------------------------------------------

export async function buildSnapshot(
  git: SimpleGit,
  projectRoot: string,
): Promise<ExploreSnapshot> {
  const cache = createCacheManager(projectRoot);
  const [gitMap, astIndex, lastScan] = await Promise.all([
    gatherGitFileInfo(git),
    cache.getAstIndex(),
    cache.getLastScan(),
  ]);

  const tree = buildFileTree(projectRoot, gitMap);
  return {
    files: tree,
    astIndex: (astIndex as any) ?? {},
    analysis: buildAnalysis(projectRoot, tree, astIndex as any, lastScan),
    projectRoot: toFwd(projectRoot),
  };
}
