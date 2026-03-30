import type { Finding, HealthReport, ModuleId } from "../../types/index.js";

export const DEFAULT_CI_CHECK_MODULES: ModuleId[] = ["M-05", "M-07"];
export const DISALLOWED_CI_CHECK_MODULES = new Set<ModuleId>(["M-04", "M-08"]);

const VALID_CI_CHECK_MODULES = new Set<ModuleId>([
  "M-01",
  "M-02",
  "M-03",
  "M-05",
  "M-06",
  "M-07",
]);

export function parseCiCheckModules(value?: string): ModuleId[] {
  if (!value || value.trim() === "") {
    return [...DEFAULT_CI_CHECK_MODULES];
  }

  const modules = Array.from(
    new Set(
      value
        .split(",")
        .map((moduleId) => moduleId.trim().toUpperCase())
        .filter(Boolean),
    ),
  ) as ModuleId[];

  if (modules.length === 0) {
    return [...DEFAULT_CI_CHECK_MODULES];
  }

  for (const moduleId of modules) {
    if (DISALLOWED_CI_CHECK_MODULES.has(moduleId)) {
      throw new Error(`${moduleId} is not allowed in ci-check mode.`);
    }

    if (!VALID_CI_CHECK_MODULES.has(moduleId)) {
      throw new Error(
        `Unknown module: ${moduleId}. ci-check supports M-01, M-02, M-03, M-05, M-06, M-07.`,
      );
    }
  }

  return modules;
}

export function getCriticalFindings(report: HealthReport): Finding[] {
  return report.findings.filter((finding) => finding.severity === "CRITICAL");
}

export function buildCiCheckJson(
  report: HealthReport,
  failUnder: number,
): {
  passed: boolean;
  score: number;
  criticalFindings: Finding[];
} {
  return {
    passed: report.score >= failUnder,
    score: report.score,
    criticalFindings: getCriticalFindings(report),
  };
}

export function renderCiCheckText(report: HealthReport): string {
  const lines = [`Overall score: ${report.score}/100`, "Modules:"];

  for (const module of report.modules) {
    lines.push(`- ${module.moduleName}: ${module.score}/100`);
  }

  const criticalFindings = getCriticalFindings(report);
  if (criticalFindings.length === 0) {
    lines.push("Critical findings: none");
    return lines.join("\n");
  }

  lines.push("Critical findings:");
  for (const finding of criticalFindings) {
    const location = finding.file
      ? `${finding.file}${finding.line ? `:${finding.line}` : ""}`
      : "";
    lines.push(
      `- ${finding.type}${location ? ` ${location}` : ""} ${finding.message}`,
    );
  }

  return lines.join("\n");
}
