import { Octokit } from "@octokit/rest";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { createLogger } from "./logger.js";

const log = createLogger("ph:cli");

export interface RemoteRepoInfo {
  owner: string;
  repo: string;
  branch: string;
}

export function parseGitHubUrl(url: string): RemoteRepoInfo | null {
  const patterns = [
    /github\.com[/:]([^/]+)\/([^/.]+)(?:\.git)?$/,
    /github\.com[/:]([^/]+)\/([^/.]+)\/tree\/([^/]+)/,
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) {
      return {
        owner: match[1],
        repo: match[2].replace(/\.git$/, ""),
        branch: match[3] || "main",
      };
    }
  }
  return null;
}

export async function fetchRepoContents(
  owner: string,
  repo: string,
  branch: string = "main",
  token?: string,
): Promise<Map<string, string>> {
  const octokit = new Octokit({ auth: token });
  const contents = new Map<string, string>();

  const queue: Array<{ path: string; sha?: string }> = [{ path: "" }];
  const processed = new Set<string>();

  while (queue.length > 0) {
    const item = queue.shift();
    if (!item || processed.has(item.path)) continue;
    processed.add(item.path);

    try {
      const { data } = await octokit.repos.getContent({
        owner,
        repo,
        path: item.path,
        ref: branch,
      });

      if (Array.isArray(data)) {
        for (const entry of data) {
          if (entry.type === "dir") {
            queue.push({ path: entry.path });
          } else if (entry.type === "file" && isRelevantFile(entry.name)) {
            const fileContent = await fetchFileContent(
              octokit,
              owner,
              repo,
              entry.path,
              branch,
            );
            if (fileContent) {
              contents.set(entry.path, fileContent);
            }
          }
        }
      }
    } catch (err) {
      log(`Error fetching ${item.path}: %O`, err);
    }
  }

  return contents;
}

async function fetchFileContent(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
  branch: string,
): Promise<string | null> {
  try {
    const { data } = await octokit.repos.getContent({
      owner,
      repo,
      path,
      ref: branch,
    });

    if ("content" in data && data.content) {
      const decoded = Buffer.from(data.content, "base64").toString("utf-8");
      return decoded;
    }
  } catch (err) {
    log(`Error fetching file ${path}: %O`, err);
  }
  return null;
}

const RELEVANT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".json",
  ".md",
  ".yaml",
  ".yml",
  ".txt",
  ".env",
  ".eslintrc",
  ".gitignore",
  "Dockerfile",
]);

function isRelevantFile(filename: string): boolean {
  if (RELEVANT_EXTENSIONS.has(filename)) return true;
  if (filename.startsWith(".")) return true;
  const ext = filename.substring(filename.lastIndexOf("."));
  if (ext && [".ts", ".js", ".json", ".md"].includes(ext)) return true;
  return false;
}

export async function cloneToTemp(
  contents: Map<string, string>,
  targetDir: string,
): Promise<void> {
  if (existsSync(targetDir)) {
    rmSync(targetDir, { recursive: true, force: true });
  }
  mkdirSync(targetDir, { recursive: true });

  for (const [filePath, content] of contents) {
    const fullPath = join(targetDir, filePath);
    const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));
    if (dir) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(fullPath, content, "utf-8");
  }
}
