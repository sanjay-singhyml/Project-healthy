// Test suite for Output utilities
import { describe, it, expect } from "vitest";
import type {
  Finding,
  HealthReport,
  ModuleResult,
  ModuleId,
} from "../src/types/index.js";
import {
  formatFinding,
  formatSeverity,
  formatScoreBand,
  printJson,
  generateHtmlReport,
  ExitCode,
} from "../src/utils/output.js";

describe("Output Utilities", () => {
  describe("formatFinding", () => {
    it("formats finding with severity, type, file:line, message", () => {
      const finding: Finding = {
        id: "test-1",
        moduleId: "M-07",
        type: "ENV_DRIFT",
        severity: "HIGH",
        file: ".env.example",
        line: 10,
        message: "Missing KEY_B",
        metadata: {},
      };
      const output = formatFinding(finding);
      expect(output).toContain("HIGH");
      expect(output).toContain("ENV_DRIFT");
      expect(output).toContain(".env.example:10");
      expect(output).toContain("Missing KEY_B");
    });

    it("handles finding without file and line", () => {
      const finding: Finding = {
        id: "test-2",
        moduleId: "M-05",
        type: "CVE",
        severity: "CRITICAL",
        message: "Critical vulnerability",
        metadata: {},
      };
      const output = formatFinding(finding);
      expect(output).toContain("CRITICAL");
      expect(output).toContain("Critical vulnerability");
    });
  });

  describe("ExitCode", () => {
    it("defines correct exit codes", () => {
      expect(ExitCode.SUCCESS).toBe(0);
      expect(ExitCode.FAIL_UNDER).toBe(1);
      expect(ExitCode.RATE_LIMIT).toBe(2);
    });
  });

  describe("generateHtmlReport", () => {
    it("generates self-contained HTML with score", () => {
      const report: HealthReport = {
        score: 85,
        generatedAt: "2026-01-01T00:00:00Z",
        projectRoot: "/test/project",
        modules: [
          {
            moduleId: "M-05",
            moduleName: "Dependency Security",
            score: 90,
            status: "ok",
            findings: [],
            metadata: {},
            durationMs: 100,
          },
        ],
        findings: [],
        topActions: ["Fix CVE in lodash"],
      };

      const html = generateHtmlReport(report);
      expect(html).toContain("<!DOCTYPE html>");
      expect(html).toContain("85");
      expect(html).toContain("GOOD");
      expect(html).toContain("Dependency Security");
      expect(html).toContain("Fix CVE in lodash");
      expect(html).toContain("</html>");
    });

    it("escapes HTML in findings", () => {
      const report: HealthReport = {
        score: 50,
        generatedAt: "2026-01-01T00:00:00Z",
        projectRoot: "/test",
        modules: [
          {
            moduleId: "M-07",
            moduleName: "Env",
            score: 50,
            status: "warning",
            findings: [
              {
                id: "1",
                moduleId: "M-07",
                type: "SECRET_LEAK",
                severity: "CRITICAL",
                message: 'Found <script>alert("xss")</script> in history',
                metadata: {},
              },
            ],
            metadata: {},
            durationMs: 10,
          },
        ],
        findings: [],
        topActions: [],
      };

      const html = generateHtmlReport(report);
      expect(html).not.toContain("<script>alert");
      expect(html).toContain("&lt;script&gt;");
    });

    it("handles 0-39 CRITICAL band", () => {
      const report: HealthReport = {
        score: 25,
        generatedAt: "2026-01-01T00:00:00Z",
        projectRoot: "/test",
        modules: [],
        findings: [],
        topActions: [],
      };

      const html = generateHtmlReport(report);
      expect(html).toContain("CRITICAL");
    });
  });
});
