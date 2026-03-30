import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildContextDocument,
  writeContextFile,
} from "../src/context/index.js";

let testIdx = 0;

function getTestDir(): string {
  testIdx++;
  const dir = join(process.cwd(), `.test-context-${Date.now()}-${testIdx}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function initGitRepo(dir: string) {
  execSync("git init -b main", { cwd: dir, stdio: "pipe" });
  execSync('git config user.email "test@test.com"', {
    cwd: dir,
    stdio: "pipe",
  });
  execSync('git config user.name "Test User"', { cwd: dir, stdio: "pipe" });
}

function commitAll(dir: string, message: string) {
  execSync("git add .", { cwd: dir, stdio: "pipe" });
  execSync(`git commit -m "${message}"`, { cwd: dir, stdio: "pipe" });
}

describe("context packer", () => {
  it("generates a repo context XML document and respects ignored files", async () => {
    const dir = getTestDir();
    initGitRepo(dir);

    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name: "context-fixture",
        version: "1.0.0",
        scripts: { build: "tsc" },
      }),
    );
    writeFileSync(join(dir, "README.md"), "# Fixture\n");
    writeFileSync(join(dir, ".gitignore"), "ignored.txt\n");
    writeFileSync(join(dir, "src", "index.ts"), "export const value = 1;\n");
    writeFileSync(join(dir, "ignored.txt"), "do not include me\n");
    writeFileSync(join(dir, "dist", "bundle.js"), "console.log('ignore');\n");

    commitAll(dir, "initial");

    const result = await writeContextFile(dir, {
      outputPath: "repo-context.xml",
      includeGitLog: false,
      includeDiffs: false,
    });

    const outputPath = join(dir, "repo-context.xml");
    const content = readFileSync(outputPath, "utf-8");

    expect(result.outputFiles).toEqual([outputPath]);
    expect(content).toContain("<project_context");
    expect(content).toContain("<directory_structure><![CDATA[");
    expect(content).toContain('<file path="src/index.ts"');
    expect(content).not.toContain("ignored.txt");
    expect(content).not.toContain("dist/bundle.js");
  });

  it("truncates oversized files to keep the output compact", async () => {
    const dir = getTestDir();
    initGitRepo(dir);

    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "truncate-fixture", version: "1.0.0" }),
    );
    writeFileSync(
      join(dir, "src", "large.ts"),
      `export const payload = "${"a".repeat(2000)}";\n`,
    );

    commitAll(dir, "initial");

    const content = await buildContextDocument(dir, {
      includeGitLog: false,
      includeDiffs: false,
      maxFileSizeBytes: 120,
    });

    expect(content).toContain('path="src/large.ts"');
    expect(content).toContain('truncated="true"');
    expect(content).toContain("[... truncated after 120 bytes for context output ...]");
  });

  it("splits large output into numbered XML documents", async () => {
    const dir = getTestDir();
    initGitRepo(dir);

    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "split-fixture", version: "1.0.0" }),
    );

    for (let index = 0; index < 6; index++) {
      writeFileSync(
        join(dir, "src", `file-${index}.ts`),
        `export const value${index} = "${"x".repeat(300)}";\n`,
      );
    }

    commitAll(dir, "initial");

    const result = await writeContextFile(dir, {
      outputPath: "repo-context.xml",
      includeGitLog: false,
      includeDiffs: false,
      splitOutputChars: 600,
    });

    expect(result.outputFiles.length).toBeGreaterThan(1);
    expect(existsSync(join(dir, "repo-context.1.xml"))).toBe(true);
    expect(existsSync(join(dir, "repo-context.2.xml"))).toBe(true);
    expect(readFileSync(join(dir, "repo-context.1.xml"), "utf-8")).toContain(
      'part="1"',
    );
  });

  it("embeds git log and active diffs when available", async () => {
    const dir = getTestDir();
    initGitRepo(dir);

    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "git-fixture", version: "1.0.0" }),
    );
    writeFileSync(join(dir, "src", "index.ts"), "export const value = 1;\n");

    commitAll(dir, "initial commit");

    writeFileSync(join(dir, "src", "index.ts"), "export const value = 2;\n");
    writeFileSync(join(dir, "src", "staged.ts"), "export const staged = true;\n");
    execSync("git add src/staged.ts", { cwd: dir, stdio: "pipe" });

    const content = await buildContextDocument(dir, {
      gitLogLimit: 5,
      diffCharLimit: 4000,
    });

    expect(content).toContain("<git_log><![CDATA[");
    expect(content).toContain("initial commit");
    expect(
      content.includes("<worktree_diff><![CDATA[") ||
        content.includes("<staged_diff><![CDATA["),
    ).toBe(true);
    expect(content).toContain("export const value = 2;");
  });
});
