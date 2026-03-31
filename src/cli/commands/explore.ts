// ph explore — entry point and Express server
// Delegates data gathering to explore/data.ts and UI to explore/ui.ts

import express from "express";
import { simpleGit } from "simple-git";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { createLogger } from "../../utils/logger.js";
import type { ExploreOptions, ExploreSnapshot } from "./explore/types.js";
import {
  buildSnapshot,
  getFileCommits,
  getCommitDiff,
  getFileContent,
} from "./explore/data.js";
import { getExploreUI } from "./explore/ui.js";

const log = createLogger("ph:explore");

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function runExplore(
  projectRoot: string,
  options: ExploreOptions = {},
): Promise<void> {
  const port = options.port || 7878;
  const app = express();
  const git = simpleGit(projectRoot);

  // Cached snapshot — rebuilt on /refresh
  let snapshotPromise: Promise<ExploreSnapshot> = buildSnapshot(
    git,
    projectRoot,
  );

  // --- API routes -----------------------------------------------------------

  /** GET /api/files — full snapshot (tree + analysis) */
  app.get("/api/files", async (_req, res) => {
    try {
      const snap = await snapshotPromise;
      res.json(snap);
    } catch (err) {
      log("GET /api/files error: %O", err);
      res.status(500).json({ error: "Failed to load files" });
    }
  });

  /** POST /api/files/refresh — rebuild snapshot from disk */
  app.post("/api/files/refresh", async (_req, res) => {
    try {
      snapshotPromise = buildSnapshot(git, projectRoot);
      const snap = await snapshotPromise;
      res.json(snap);
    } catch (err) {
      log("POST /api/files/refresh error: %O", err);
      res.status(500).json({ error: "Failed to refresh" });
    }
  });

  /** GET /api/commits/:path(*) — commit history for a file */
  app.get("/api/commits/:path(*)", async (req, res) => {
    try {
      const filePath = req.params[0];
      if (!filePath) {
        res.status(400).json({ error: "File path is required" });
        return;
      }
      const commits = await getFileCommits(git, filePath);
      res.json(commits);
    } catch (err) {
      log("GET /api/commits error: %O", err);
      res.status(500).json({ error: "Failed to load commits" });
    }
  });

  /** GET /api/diff/:hash/:path(*) — unified diff for commit+file */
  app.get("/api/diff/:hash/:path(*)", async (req, res) => {
    try {
      const { hash } = req.params;
      const filePath = req.params[0];
      if (!hash || !filePath) {
        res.status(400).json({ error: "Hash and file path are required" });
        return;
      }
      const diff = await getCommitDiff(git, hash, filePath);
      res.json({ diff });
    } catch (err) {
      log("GET /api/diff error: %O", err);
      res.status(500).json({ error: "Failed to load diff" });
    }
  });

  /** GET /api/content/:hash/:path(*) — file content at a commit or local */
  app.get("/api/content/:hash/:path(*)", async (req, res) => {
    try {
      const { hash } = req.params;
      const filePath = req.params[0];
      if (!hash || !filePath) {
        res.status(400).json({ error: "Hash and file path are required" });
        return;
      }

      let content: string | null;
      if (hash === "local") {
        try {
          content = readFileSync(join(projectRoot, filePath), "utf-8");
        } catch {
          content = null;
        }
      } else {
        content = await getFileContent(git, hash, filePath);
      }

      res.json({ content: content ?? "(unable to read file)" });
    } catch (err) {
      log("GET /api/content error: %O", err);
      res.status(500).json({ error: "Failed to load file content" });
    }
  });

  /** GET / — serve the single-page UI */
  app.get("/", (_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(getExploreUI(port));
  });

  // --- Start server ---------------------------------------------------------

  const server = app.listen(port, () => {
    console.log(`\n  ph explore --- http://localhost:${port}\n`);
    console.log("  Press 'q' + Enter or Ctrl+C to stop the server.\n");
  });

  // Auto-open browser (best-effort)
  try {
    const open = await import("open");
    await open.default(`http://localhost:${port}`);
  } catch {
    console.log(`Open your browser to: http://localhost:${port}`);
  }

  // Listen for 'q' on stdin to shut down
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
    process.stdin.resume();
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (key: string) => {
      if (key.trim().toLowerCase() === "q") {
        console.log("\nShutting down ph explore...");
        server.close();
        process.exit(0);
      }
    });
  }

  // Clean shutdown
  process.on("SIGINT", () => {
    console.log("\nShutting down ph explore...");
    server.close();
    process.exit(0);
  });
}

export default runExplore;
