import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  detectProjectType,
  getWeightPreset,
  hasCustomWeightConfig,
} from "../src/utils/project-type.js";

let testIdx = 0;

function getTestDir(): string {
  testIdx++;
  const dir = join(process.cwd(), `.test-project-type-${Date.now()}-${testIdx}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("project type detection", () => {
  it("detects cli-tool projects from the bin field", () => {
    const testDir = getTestDir();
    writeFileSync(
      join(testDir, "package.json"),
      JSON.stringify({
        name: "my-cli",
        version: "1.0.0",
        bin: { ph: "./bin/ph" },
        dependencies: {},
      }),
    );

    expect(detectProjectType(testDir)).toBe("cli-tool");
  });

  it("detects webapps from UI dependencies", () => {
    const testDir = getTestDir();
    writeFileSync(
      join(testDir, "package.json"),
      JSON.stringify({
        name: "frontend-app",
        version: "1.0.0",
        dependencies: { react: "^18.0.0" },
      }),
    );

    expect(detectProjectType(testDir)).toBe("webapp");
  });

  it("detects custom scoring weights from project-health.config.ts", () => {
    const testDir = getTestDir();
    writeFileSync(
      join(testDir, "project-health.config.ts"),
      `export const config = {
  scoring: {
    weights: {
      security: 50,
      quality: 50,
    },
    failUnder: 70,
  },
};`,
    );

    expect(hasCustomWeightConfig(testDir)).toBe(true);
  });

  it("returns false when config does not define scoring weights", () => {
    const testDir = getTestDir();
    writeFileSync(
      join(testDir, "project-health.config.ts"),
      `export const config = {
  scoring: {
    failUnder: 70,
  },
};`,
    );

    expect(hasCustomWeightConfig(testDir)).toBe(false);
  });

  it("returns the webapp preset in config-key format", () => {
    expect(getWeightPreset("webapp")).toEqual({
      security: 20,
      env: 20,
      quality: 18,
      cicd: 15,
      flakiness: 12,
      prComplexity: 8,
      docs: 5,
      buildPerf: 2,
    });
  });
});
