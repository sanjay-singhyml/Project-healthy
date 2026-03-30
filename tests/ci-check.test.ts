import { describe, expect, it } from "vitest";
import type { HealthReport } from "../src/types/index.js";
import {
  buildCiCheckJson,
  parseCiCheckModules,
  renderCiCheckText,
} from "../src/cli/commands/ci-check.js";

const report: HealthReport = {
  score: 72,
  generatedAt: "2026-03-26T00:00:00.000Z",
  projectRoot: "/project",
  modules: [
    {
      moduleId: "M-05",
      moduleName: "Dependency Security",
      score: 80,
      status: "warning",
      findings: [],
      metadata: {},
      durationMs: 100,
    },
    {
      moduleId: "M-07",
      moduleName: "Environment Integrity",
      score: 64,
      status: "error",
      findings: [],
      metadata: {},
      durationMs: 50,
    },
  ],
  findings: [
    {
      id: "f1",
      moduleId: "M-07",
      type: "SECRET_LEAK",
      severity: "CRITICAL",
      file: ".env",
      line: 3,
      message: "Hardcoded secret detected",
      metadata: {},
    },
  ],
  topActions: [],
};

describe("ci-check helpers", () => {
  it("uses default modules when none are provided", () => {
    expect(parseCiCheckModules()).toEqual(["M-05", "M-07"]);
  });

  it("parses and deduplicates module lists", () => {
    expect(parseCiCheckModules("M-05,m-07,M-05")).toEqual(["M-05", "M-07"]);
  });

  it("rejects disallowed modules", () => {
    expect(() => parseCiCheckModules("M-04")).toThrow(
      "M-04 is not allowed in ci-check mode.",
    );
  });

  it("renders minimal text output", () => {
    const text = renderCiCheckText(report);

    expect(text).toContain("Overall score: 72/100");
    expect(text).toContain("Dependency Security: 80/100");
    expect(text).toContain("Critical findings:");
    expect(text).toContain("Hardcoded secret detected");
  });

  it("builds ci-check json output", () => {
    expect(buildCiCheckJson(report, 70)).toEqual({
      passed: true,
      score: 72,
      criticalFindings: [report.findings[0]],
    });
  });
});
