// post-commit hook - AI-05 Commit Doc Updater
// Parses commit diff, looks up docs-index, patches stale doc sections via AI

import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import { simpleGit, SimpleGit } from "simple-git";
import { createCacheManager } from "../cache/index.js";
import { buildDocsIndex } from "../cache/docs-builder.js";
import { createConfigManager } from "../config/index.js";
import { MODEL } from "../proxy/ai-client.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("ph:cli");

// File extensions that are considered source files (not docs)
const SOURCE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".c",
  ".cpp",
  ".cs",
];

// File extensions that are considered documentation
const DOC_EXTENSIONS = [".md", ".rst", ".txt", ".adoc", ".html"];

interface CommitDiff {
  file: string;
  additions: number;
  deletions: number;
  status: "added" | "modified" | "deleted" | "renamed";
}

// Check if a file is a source file (not documentation)
function isSourceFile(filePath: string): boolean {
  const ext = filePath.toLowerCase().slice(filePath.lastIndexOf("."));
  return SOURCE_EXTENSIONS.includes(ext);
}

// Check if a file is a documentation file
function isDocFile(filePath: string): boolean {
  const ext = filePath.toLowerCase().slice(filePath.lastIndexOf("."));
  return DOC_EXTENSIONS.includes(ext);
}

// Get the commit hash of the most recent commit
async function getLatestCommitHash(git: SimpleGit): Promise<string> {
  const log = await git.log({ maxCount: 1 });
  return log.latest?.hash || "";
}

// Get the diff of the most recent commit
async function getCommitDiff(
  git: SimpleGit,
  commitHash: string,
): Promise<CommitDiff[]> {
  try {
    const diff = await git.diff([`${commitHash}^..${commitHash}`, "--stat"]);
    const diffs: CommitDiff[] = [];

    const lines = diff.split("\n");
    for (const line of lines) {
      // Parse lines like: src/auth/index.ts | 10 +++++++---
      const match = line.match(/^(.+?)\s*\|\s*(\d+)\s*([+-]+)$/);
      if (match) {
        const file = match[1].trim();
        const additions = (match[3].match(/\+/g) || []).length;
        const deletions = (match[3].match(/-/g) || []).length;

        let status: CommitDiff["status"] = "modified";
        if (additions > 0 && deletions === 0) status = "added";
        if (deletions > 0 && additions === 0) status = "deleted";

        diffs.push({ file, additions, deletions, status });
      }
    }

    return diffs;
  } catch (err) {
    log("Error in getCommitDiff: %O", err);
    return [];
  }
}

// Get doc sections that reference a source file from docs-index
async function getDocSectionsForFile(
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

// Parse a docs section reference like "docs/api.md#getting-started"
function parseDocSectionRef(
  ref: string,
): { file: string; section: string } | null {
  const match = ref.match(/^(.+?)#(.+)$/);
  if (match) {
    return { file: match[1], section: match[2] };
  }
  return null;
}

// Get the content of a specific section from a markdown file
async function getSectionContent(
  docPath: string,
  sectionHeading: string,
): Promise<string | null> {
  try {
    const content = await fs.readFile(docPath, "utf-8");
    const lines = content.split("\n");

    let inSection = false;
    let sectionContent = "";
    let foundHeading: string | null = null;

    for (const line of lines) {
      const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);

      if (headingMatch) {
        if (inSection && foundHeading) {
          // End of the section we were in
          return sectionContent.trim();
        }

        const currentHeading = headingMatch[2]
          .trim()
          .toLowerCase()
          .replace(/\s+/g, "-")
          .replace(/[^a-z0-9-]/g, "");
        const targetHeading = sectionHeading
          .toLowerCase()
          .replace(/\s+/g, "-")
          .replace(/[^a-z0-9-]/g, "");

        if (currentHeading === targetHeading) {
          inSection = true;
          foundHeading = headingMatch[2].trim();
        }
      } else if (inSection) {
        sectionContent += line + "\n";
      }
    }

    // Return last section if we're still in it
    if (inSection) {
      return sectionContent.trim();
    }

    return null;
  } catch (err) {
    log("Error in getSectionContent: %O", err);
    return null;
  }
}

// Update a specific section in a markdown file
async function updateDocSection(
  docPath: string,
  sectionHeading: string,
  newContent: string,
): Promise<void> {
  try {
    const content = await fs.readFile(docPath, "utf-8");
    const lines = content.split("\n");

    let inSection = false;
    const newLines: string[] = [];
    let foundHeading: string | null = null;

    for (const line of lines) {
      const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);

      if (headingMatch) {
        if (inSection && foundHeading) {
          // End of the section - insert new content before next heading
          newLines.push(newContent);
          newLines.push(""); // Empty line after new content
          inSection = false;
          foundHeading = null;
        }

        const currentHeading = headingMatch[2]
          .trim()
          .toLowerCase()
          .replace(/\s+/g, "-")
          .replace(/[^a-z0-9-]/g, "");
        const targetHeading = sectionHeading
          .toLowerCase()
          .replace(/\s+/g, "-")
          .replace(/[^a-z0-9-]/g, "");

        if (currentHeading === targetHeading) {
          inSection = true;
          foundHeading = headingMatch[2].trim();
        }

        newLines.push(line);
      } else if (!inSection) {
        newLines.push(line);
      }
    }

    // Handle last section
    if (inSection) {
      newLines.push(newContent);
    }

    await fs.writeFile(docPath, newLines.join("\n"), "utf-8");
  } catch (error) {
    console.error(`Error updating doc section: ${error}`);
    throw error;
  }
}

// Call AI to update a doc section
async function updateDocSectionWithAI(
  projectRoot: string,
  sourceFile: string,
  docFile: string,
  sectionHeading: string,
  sectionContent: string,
  commitHash: string,
): Promise<string> {
  const prompt = `You are updating documentation for a source file that was just changed.

Source file changed: ${sourceFile}
Commit hash: ${commitHash}

The following documentation section may be stale or need updating:

## Section: ${sectionHeading}

Current content:
${sectionContent}

Please update this section to reflect any changes in the source file. 
If no changes are needed, return the original content unchanged.
If the section needs updates, provide the updated content.
Just return the new section content, nothing else.`;

  try {
    const response = await fetch(
      `${process.env.PH_PROXY_URL || process.env.PROJECT_HEALTH_BACKEND_URL || "http://localhost:3000/v1"}/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: MODEL,
          messages: [
            {
              role: "system",
              content: "You are a helpful documentation assistant.",
            },
            { role: "user", content: prompt },
          ],
          stream: false,
        }),
      },
    );

    if (!response.ok) {
      console.error(`AI request failed: ${response.status}`);
      return sectionContent;
    }

    const data = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    return data.choices?.[0]?.message?.content || sectionContent;
  } catch (error) {
    console.error(`AI request error: ${error}`);
    return sectionContent;
  }
}

// Create a GitHub PR with doc updates
async function createDocUpdatePR(
  projectRoot: string,
  commitHash: string,
  docFiles: string[],
): Promise<void> {
  const githubToken = process.env.GITHUB_TOKEN;

  if (!githubToken) {
    console.log("GITHUB_TOKEN not set. Cannot create PR.");
    return;
  }

  const git = simpleGit(projectRoot);

  // Get remote info
  const remotes = await git.getRemotes(true);
  const originRemote = remotes.find((r) => r.name === "origin");

  if (!originRemote?.refs.fetch) {
    console.log("Could not determine GitHub remote.");
    return;
  }

  const remoteUrl = originRemote.refs.fetch;
  const match = remoteUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/);

  if (!match) {
    console.log("Could not parse GitHub owner/repo from remote.");
    return;
  }

  const owner = match[1];
  const repo = match[2].replace(/\.git$/, "");

  // Use Octokit via dynamic import
  const { Octokit } = await import("@octokit/rest");
  const octokit = new Octokit({ auth: githubToken });

  const prTitle = `docs: update documentation for commit ${commitHash.slice(0, 7)}`;
  const prBody = `Automated documentation update for commit ${commitHash}

Affected documentation files:
${docFiles.map((f) => `- ${f}`).join("\n")}

This PR was created by project-health AI-05 Commit Doc Updater.`;

  try {
    await octokit.pulls.create({
      owner,
      repo,
      title: prTitle,
      body: prBody,
      head: `docs-update-${commitHash.slice(0, 7)}`,
      base: "main",
    });
    console.log(`Created PR: ${prTitle}`);
  } catch (error) {
    console.error(`Failed to create PR: ${error}`);
  }
}

// Stage and amend commit with doc updates (Direct mode)
async function amendCommitWithDocUpdate(projectRoot: string): Promise<void> {
  const git = simpleGit(projectRoot);

  // Stage all changes
  await git.add(".");

  // Amend the previous commit using git commit with --amend flag
  await git.raw(["commit", "--amend", "--no-edit", "-C", "HEAD"]);

  console.log("Amended previous commit with documentation updates.");
}

// Main post-commit hook function
export async function runPostCommitHook(projectRoot?: string): Promise<void> {
  const root = projectRoot || process.cwd();

  // P8-TC02: Check if this is a git repository
  const git = simpleGit(root);
  const isRepo = await git.checkIsRepo();

  if (!isRepo) {
    console.log("Not a git repository. Skipping hook.");
    return;
  }

  // Get the latest commit hash
  const commitHash = await getLatestCommitHash(git);

  if (!commitHash) {
    console.log("No commits found.");
    return;
  }

  // Get the diff of the latest commit
  const diffs = await getCommitDiff(git, commitHash);

  // P8-TC02: Filter out doc files - hook fires only when source files are committed
  const sourceFileDiffs = diffs.filter((d) => isSourceFile(d.file));

  if (sourceFileDiffs.length === 0) {
    console.log(
      "No source files changed in this commit. Skipping AI doc update.",
    );
    return;
  }

  console.log(`Found ${sourceFileDiffs.length} source file(s) changed.`);

  // Get config to determine mode
  const configManager = createConfigManager(root);
  const config = await configManager.load();

  const { mode } = config.docUpdater;

  // For each source file, find related doc sections
  const docUpdates: Array<{
    sourceFile: string;
    docFile: string;
    section: string;
  }> = [];

  for (const diff of sourceFileDiffs) {
    const fullPath = resolve(root, diff.file);
    const docSections = await getDocSectionsForFile(root, fullPath);

    for (const sectionRef of docSections) {
      const parsed = parseDocSectionRef(sectionRef);
      if (parsed) {
        docUpdates.push({
          sourceFile: diff.file,
          docFile: parsed.file,
          section: parsed.section,
        });
      }
    }
  }

  if (docUpdates.length === 0) {
    console.log("No related documentation found to update.");
    return;
  }

  console.log(`Found ${docUpdates.length} documentation section(s) to review.`);

  // Process each doc update
  const updatedDocFiles: string[] = [];

  for (const update of docUpdates) {
    const docPath = resolve(root, update.docFile);

    // Get current section content
    const sectionContent = await getSectionContent(docPath, update.section);

    if (!sectionContent) {
      console.log(
        `Could not find section "${update.section}" in ${update.docFile}`,
      );
      continue;
    }

    // P8-TC03: Only update the specific section, not the full file
    // Call AI to get updated content
    const updatedContent = await updateDocSectionWithAI(
      root,
      update.sourceFile,
      update.docFile,
      update.section,
      sectionContent,
      commitHash,
    );

    // Only update if content changed
    if (updatedContent !== sectionContent) {
      await updateDocSection(docPath, update.section, updatedContent);
      console.log(`Updated section "${update.section}" in ${update.docFile}`);

      if (!updatedDocFiles.includes(update.docFile)) {
        updatedDocFiles.push(update.docFile);
      }
    }
  }

  if (updatedDocFiles.length === 0) {
    console.log("No documentation updates needed.");
    return;
  }

  // Handle based on mode
  if (mode === "pr") {
    // P8-TC04: PR mode creates GitHub PR with correct title
    await createDocUpdatePR(root, commitHash, updatedDocFiles);
  } else {
    // Direct mode - P8-TC05: Amend commit with doc update
    await amendCommitWithDocUpdate(root);
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runPostCommitHook().catch(console.error);
}

export default runPostCommitHook;
