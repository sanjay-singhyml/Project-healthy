// M-05: Dependency Security Module
// Detects package manager from lockfile
// Runs npm audit with --json (handles both v2 advisories and v3 vulnerabilities formats)
// Directly reads node_modules for license checking — no shell-out
// Flags CRITICAL/HIGH CVEs and GPL/AGPL/UNLICENSED licenses
// Enhanced with: npm outdated detection, dependency freshness scoring, license compatibility analysis

import {
  ModuleResult,
  ModuleId,
  ProjectHealthConfig,
  Finding,
  Severity,
  Vulnerability,
} from "../../types/index.js";
import { v4 as uuidv4 } from "uuid";
import { execa } from "execa";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("ph:security");

export const MODULE_ID: ModuleId = "M-05";
export const MODULE_NAME = "Dependency Security";

const BLOCKED_LICENSES = [
  "GPL",
  "AGPL",
  "UNLICENSED",
  "GPL-3.0",
  "GPL-3.0-only",
  "GPL-2.0",
  "AGPL-3.0",
];

const COPYLEFT_LICENSES = ["GPL", "AGPL", "LGPL", "MPL", "EUPL", "OSL"];

type PackageManager = "npm" | "pip" | "yarn" | "pnpm" | null;

function detectPackageManager(projectRoot: string): PackageManager {
  if (existsSync(join(projectRoot, "package-lock.json"))) return "npm";
  if (existsSync(join(projectRoot, "yarn.lock"))) return "yarn";
  if (existsSync(join(projectRoot, "pnpm-lock.yaml"))) return "pnpm";
  if (
    existsSync(join(projectRoot, "requirements.txt")) ||
    existsSync(join(projectRoot, "Pipfile.lock"))
  )
    return "pip";
  return null;
}

// ─── npm audit parsers ───────────────────────────────────────────────────────

function parseNpmAuditV3(audit: Record<string, unknown>): Vulnerability[] {
  const vulnerabilities: Vulnerability[] = [];
  const vulnMap = audit.vulnerabilities as Record<string, any> | undefined;
  if (!vulnMap) return vulnerabilities;

  for (const [pkg, data] of Object.entries(vulnMap)) {
    const severity = mapNpmSeverity(data.severity);
    const range = data.range || "*";

    if (Array.isArray(data.via)) {
      for (const via of data.via) {
        if (typeof via === "object" && via !== null) {
          vulnerabilities.push({
            severity,
            package: via.name || pkg,
            version: via.version || range,
            cveId: via.source
              ? String(via.source)
              : via.url
                ? via.url.split("/").pop()
                : undefined,
            fixVersion:
              via.fix_version ||
              (data.fixAvailable && typeof data.fixAvailable === "object"
                ? data.fixAvailable.version
                : undefined),
          });
        } else if (typeof via === "string") {
          vulnerabilities.push({ severity, package: pkg, version: range });
        }
      }
    }
  }

  return vulnerabilities;
}

function parseNpmAuditV2(audit: Record<string, unknown>): Vulnerability[] {
  const vulnerabilities: Vulnerability[] = [];
  const advisories = audit.advisories as Record<string, any> | undefined;
  if (!advisories) return vulnerabilities;

  for (const [, adv] of Object.entries(advisories)) {
    vulnerabilities.push({
      severity: mapNpmSeverity(adv.severity),
      package: adv.module_name || adv.moduleName || "unknown",
      version: adv.findings?.[0]?.version || adv.vulnerable_versions || "*",
      cveId: adv.cves?.[0] || adv.id ? `npm-${adv.id}` : undefined,
      fixVersion: adv.patched_versions || undefined,
    });
  }

  return vulnerabilities;
}

function parseNpmAudit(rawOutput: string): Vulnerability[] {
  try {
    const audit = JSON.parse(rawOutput);

    if (audit.vulnerabilities) {
      return parseNpmAuditV3(audit);
    }

    if (audit.advisories) {
      return parseNpmAuditV2(audit);
    }

    return [];
  } catch (err) {
    log("Error in parseNpmAudit: %O", err);
    return [];
  }
}

function mapNpmSeverity(npmSeverity: string): Severity {
  switch ((npmSeverity || "").toLowerCase()) {
    case "critical":
      return "CRITICAL";
    case "high":
      return "HIGH";
    case "moderate":
    case "medium":
      return "MEDIUM";
    case "low":
      return "LOW";
    default:
      return "MEDIUM";
  }
}

// ─── npm audit execution ────────────────────────────────────────────────────

async function runNpmAudit(projectRoot: string): Promise<Vulnerability[]> {
  try {
    const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
    const { stdout, stderr } = await execa(npmCmd, ["audit", "--json"], {
      cwd: projectRoot,
      reject: false,
      timeout: 30000,
    });

    const output = stdout || stderr;
    return output ? parseNpmAudit(output) : [];
  } catch (err) {
    log("Error in runNpmAudit: %O", err);
    return [];
  }
}

// ─── npm outdated ──────────────────────────────────────────────────────────

interface OutdatedPackage {
  name: string;
  current: string;
  wanted: string;
  latest: string;
  type: "dependencies" | "devDependencies";
}

async function runNpmOutdated(projectRoot: string): Promise<OutdatedPackage[]> {
  const outdated: OutdatedPackage[] = [];

  try {
    const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
    const { stdout } = await execa(npmCmd, ["outdated", "--json"], {
      cwd: projectRoot,
      reject: false,
      timeout: 30000,
    });

    if (!stdout) return outdated;

    const data = JSON.parse(stdout);

    for (const [name, info] of Object.entries(data as Record<string, any>)) {
      outdated.push({
        name,
        current: info.current || "unknown",
        wanted: info.wanted || "unknown",
        latest: info.latest || "unknown",
        type:
          info.type === "devDependencies" ? "devDependencies" : "dependencies",
      });
    }
  } catch (err) {
    log("Error in runNpmOutdated: %O", err);
  }

  return outdated;
}

// ─── pip-audit execution ────────────────────────────────────────────────────

async function runPipAudit(projectRoot: string): Promise<Vulnerability[]> {
  try {
    const { stdout } = await execa("pip-audit", ["--format", "json"], {
      cwd: projectRoot,
      reject: false,
      timeout: 30000,
    });

    const audit = JSON.parse(stdout);
    const vulnerabilities: Vulnerability[] = [];

    if (audit.dependencies) {
      for (const dep of audit.dependencies) {
        if (dep.vulns && dep.vulns.length > 0) {
          for (const vuln of dep.vulns) {
            vulnerabilities.push({
              severity: mapNpmSeverity(vuln.severity || "medium"),
              package: dep.name,
              version: dep.version,
              cveId: vuln.id,
              fixVersion: vuln.fix_versions?.[0],
            });
          }
        }
      }
    }

    return vulnerabilities;
  } catch (err) {
    log("Error in runPipAudit: %O", err);
    return [];
  }
}

// ─── Snyk execution ─────────────────────────────────────────────────────────

async function runSnykTest(
  projectRoot: string,
  snykToken?: string,
): Promise<Vulnerability[]> {
  try {
    const env = snykToken
      ? { ...process.env, SNYK_TOKEN: snykToken }
      : process.env;
    const { stdout } = await execa("npx", ["snyk", "test", "--json"], {
      cwd: projectRoot,
      env,
      reject: false,
      timeout: 30000,
    });

    const results = JSON.parse(stdout);
    const vulns = Array.isArray(results)
      ? results.flatMap((r: any) => r.vulnerabilities || [])
      : results.vulnerabilities || [];

    return vulns.map((vuln: any) => ({
      severity:
        typeof vuln.severity === "string"
          ? mapNpmSeverity(vuln.severity)
          : ("MEDIUM" as Severity),
      package: vuln.packageName || vuln.name || "unknown",
      version: vuln.version || "unknown",
      cveId: vuln.identifiers?.CVE?.[0],
      fixVersion: vuln.fixedIn?.[0],
    }));
  } catch (err) {
    log("Error in runSnykTest: %O", err);
    return [];
  }
}

// ─── License checking ───────────────────────────────────────────────────────

interface LicenseInfo {
  package: string;
  license: string;
  version?: string;
}

function readPackageLicense(
  pkgDir: string,
  pkgName: string,
): LicenseInfo | null {
  const pkgJsonPath = join(pkgDir, "package.json");
  if (!existsSync(pkgJsonPath)) return null;

  try {
    const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
    const license =
      pkgJson.license ||
      (Array.isArray(pkgJson.licenses)
        ? pkgJson.licenses
            .map((l: any) => (typeof l === "string" ? l : l.type))
            .join(", ")
        : null) ||
      "UNKNOWN";

    return {
      package: pkgName,
      license: String(license),
      version: pkgJson.version,
    };
  } catch (err) {
    log("Error in readPackageLicense: %O", err);
    return null;
  }
}

function scanNodeModulesForLicenses(projectRoot: string): LicenseInfo[] {
  const results: LicenseInfo[] = [];
  const nodeModulesDir = join(projectRoot, "node_modules");
  if (!existsSync(nodeModulesDir)) return results;

  try {
    const entries = readdirSync(nodeModulesDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      if (entry.name.startsWith("@")) {
        const scopedDir = join(nodeModulesDir, entry.name);
        try {
          const scopedEntries = readdirSync(scopedDir, { withFileTypes: true });
          for (const scopedEntry of scopedEntries) {
            if (scopedEntry.isDirectory()) {
              const pkgName = `${entry.name}/${scopedEntry.name}`;
              const info = readPackageLicense(
                join(scopedDir, scopedEntry.name),
                pkgName,
              );
              if (info) results.push(info);
            }
          }
        } catch (err) {
          log("Error in scanNodeModulesForLicenses: %O", err);
        }
      } else {
        const info = readPackageLicense(
          join(nodeModulesDir, entry.name),
          entry.name,
        );
        if (info) results.push(info);
      }
    }
  } catch (err) {
    log("Error in scanNodeModulesForLicenses: %O", err);
  }

  return results;
}

function isLicenseBlocked(license: string): boolean {
  if (!license) return false;
  const upper = license.toUpperCase();
  return BLOCKED_LICENSES.some(
    (blocked) => upper.includes(blocked) || upper === blocked,
  );
}

function isCopyleft(license: string): boolean {
  if (!license) return false;
  const upper = license.toUpperCase();
  return COPYLEFT_LICENSES.some((cl) => upper.includes(cl) || upper === cl);
}

// ─── License Compatibility Analysis ─────────────────────────────────────────

interface LicenseCompatibility {
  package: string;
  license: string;
  issue: string;
  severity: Severity;
}

function analyzeLicenseCompatibility(
  licenses: LicenseInfo[],
  projectLicense?: string,
): LicenseCompatibility[] {
  const issues: LicenseCompatibility[] = [];

  // Check for copyleft packages in production dependencies
  for (const { package: pkg, license } of licenses) {
    if (isLicenseBlocked(license)) {
      issues.push({
        package: pkg,
        license,
        issue: `Package has blocked license: ${license}`,
        severity: "HIGH",
      });
    } else if (isCopyleft(license)) {
      issues.push({
        package: pkg,
        license,
        issue: `Copyleft license (${license}) may have licensing implications`,
        severity: "MEDIUM",
      });
    }
  }

  // Check project license compatibility with dependencies
  if (projectLicense) {
    const projectUpper = projectLicense.toUpperCase();

    // If project is proprietary (no license or proprietary), flag GPL dependencies
    if (!projectLicense.includes("GPL") && !projectLicense.includes("AGPL")) {
      for (const { package: pkg, license } of licenses) {
        if (
          license.toUpperCase().includes("GPL") ||
          license.toUpperCase().includes("AGPL")
        ) {
          issues.push({
            package: pkg,
            license,
            issue: `GPL/AGPL package may require your project to be open source`,
            severity: "HIGH",
          });
        }
      }
    }
  }

  return issues;
}

// ─── Read project license ──────────────────────────────────────────────────

function getProjectLicense(projectRoot: string): string | null {
  const licenseFiles = [
    "LICENSE",
    "LICENSE.md",
    "LICENSE.txt",
    "COPYING",
    "COPYING.md",
  ];

  for (const file of licenseFiles) {
    const path = join(projectRoot, file);
    if (existsSync(path)) {
      try {
        const content = readFileSync(path, "utf-8").slice(0, 500);

        // Try to detect license type
        if (content.includes("MIT License")) return "MIT";
        if (content.includes("Apache License")) return "Apache-2.0";
        if (content.includes("GNU GENERAL PUBLIC LICENSE")) return "GPL";
        if (content.includes("BSD License")) return "BSD";
        if (content.includes("ISC License")) return "ISC";
        if (content.includes("Mozilla Public License")) return "MPL";

        return content.split("\n")[0].slice(0, 100);
      } catch (err) {
        log("Error reading license file: %O", err);
      }
    }
  }

  // Check package.json for license
  const pkgPath = join(projectRoot, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      if (pkg.license) {
        return String(pkg.license);
      }
    } catch (err) {
      log("Error reading package.json license: %O", err);
    }
  }

  return null;
}

// ─── Main entry point ───────────────────────────────────────────────────────

export async function runSecurityModule(
  config: ProjectHealthConfig,
): Promise<ModuleResult> {
  const startTime = Date.now();
  const findings: Finding[] = [];
  const vulnerabilities: Vulnerability[] = [];

  if (!config.modules.security.enabled) {
    return {
      moduleId: MODULE_ID,
      moduleName: MODULE_NAME,
      score: 100,
      status: "ok",
      findings: [],
      metadata: { enabled: false },
      durationMs: Date.now() - startTime,
    };
  }

  const projectRoot = process.cwd();
  const packageManager = detectPackageManager(projectRoot);

  try {
    // Run audit + Snyk in parallel
    const [npmVulns, pipVulns, snykVulns, outdatedPkgs] = await Promise.all([
      packageManager === "npm" ? runNpmAudit(projectRoot) : Promise.resolve([]),
      packageManager === "pip" ? runPipAudit(projectRoot) : Promise.resolve([]),
      config.modules.security.snykToken
        ? runSnykTest(projectRoot, config.modules.security.snykToken)
        : Promise.resolve([]),
      packageManager === "npm"
        ? runNpmOutdated(projectRoot)
        : Promise.resolve([]),
    ]);

    vulnerabilities.push(...npmVulns, ...pipVulns, ...snykVulns);

    // License check
    const licenses = scanNodeModulesForLicenses(projectRoot);
    const projectLicense = getProjectLicense(projectRoot);

    // License compatibility analysis
    const licenseIssues = analyzeLicenseCompatibility(
      licenses,
      projectLicense || undefined,
    );

    for (const issue of licenseIssues) {
      findings.push({
        id: uuidv4(),
        moduleId: MODULE_ID,
        type: "LICENSE_RISK",
        severity: issue.severity,
        message: `Package "${issue.package}" has ${issue.issue}`,
        fix: `Consider replacing "${issue.package}" with an alternative under MIT, Apache-2.0, or BSD license`,
        metadata: { package: issue.package, license: issue.license },
      });
    }

    // CVE findings
    for (const vuln of vulnerabilities) {
      const finding: Finding = {
        id: uuidv4(),
        moduleId: MODULE_ID,
        type: "CVE",
        severity: vuln.severity,
        message: `Vulnerability in ${vuln.package}@${vuln.version}${vuln.cveId ? ` (${vuln.cveId})` : ""}`,
        metadata: {
          package: vuln.package,
          version: vuln.version,
          cveId: vuln.cveId,
          fixVersion: vuln.fixVersion,
        },
      };
      if (vuln.fixVersion) {
        finding.fix = `Upgrade to ${vuln.package}@${vuln.fixVersion}`;
      }
      findings.push(finding);
    }

    // Outdated package findings
    for (const pkg of outdatedPkgs) {
      const severity: Severity =
        // Major version behind
        pkg.latest.startsWith(pkg.current.split(".")[0] + ".0.0")
          ? "HIGH"
          : // Minor version behind
            pkg.latest.startsWith(
                pkg.current.split(".")[0] + "." + pkg.current.split(".")[1],
              )
            ? "MEDIUM"
            : "LOW";

      findings.push({
        id: uuidv4(),
        moduleId: MODULE_ID,
        type: "OUTDATED_PACKAGE",
        severity,
        message: `Package "${pkg.name}" is outdated: ${pkg.current} → ${pkg.latest} (wanted: ${pkg.wanted})`,
        fix: `Run "npm update ${pkg.name}" or "npm install ${pkg.name}@latest"`,
        metadata: {
          package: pkg.name,
          currentVersion: pkg.current,
          wantedVersion: pkg.wanted,
          latestVersion: pkg.latest,
          type: pkg.type,
        },
      });
    }

    // Check for packages with no maintainers (deprecated packages)
    const deprecatedPatterns = [
      /-deprecated$/,
      /^deprecated-/,
      /\bdeprecated\b/i,
    ];

    for (const { package: pkg, license } of licenses) {
      const isDeprecated = deprecatedPatterns.some((p) => p.test(pkg));
      if (isDeprecated) {
        findings.push({
          id: uuidv4(),
          moduleId: MODULE_ID,
          type: "OUTDATED_PACKAGE",
          severity: "HIGH",
          message: `Package "${pkg}" appears to be deprecated`,
          fix: `Find an actively maintained alternative to "${pkg}"`,
          metadata: { package: pkg, license },
        });
      }
    }

    const score = calculateModuleScore(findings);

    return {
      moduleId: MODULE_ID,
      moduleName: MODULE_NAME,
      score,
      status: score >= 80 ? "ok" : score >= 60 ? "warning" : "error",
      findings,
      metadata: {
        packageManager,
        vulnerabilities: vulnerabilities.length,
        licenseRisks: licenseIssues.length,
        outdatedPackages: outdatedPkgs.length,
        packagesScanned: licenses.length,
        criticalVulns: vulnerabilities.filter((v) => v.severity === "CRITICAL")
          .length,
        highVulns: vulnerabilities.filter((v) => v.severity === "HIGH").length,
        projectLicense: projectLicense || "Not detected",
      },
      durationMs: Date.now() - startTime,
    };
  } catch (error) {
    return {
      moduleId: MODULE_ID,
      moduleName: MODULE_NAME,
      score: 0,
      status: "error",
      findings: [
        {
          id: uuidv4(),
          moduleId: MODULE_ID,
          type: "CVE",
          severity: "CRITICAL",
          message:
            error instanceof Error ? error.message : "Security scan failed",
          metadata: { error: String(error) },
        },
      ],
      metadata: { error: String(error) },
      durationMs: Date.now() - startTime,
    };
  }
}

function calculateModuleScore(findings: Finding[]): number {
  if (findings.length === 0) return 100;

  const criticalCount = findings.filter(
    (f) => f.severity === "CRITICAL",
  ).length;
  if (criticalCount > 0) return 0;

  const highCount = findings.filter((f) => f.severity === "HIGH").length;
  const mediumCount = findings.filter((f) => f.severity === "MEDIUM").length;
  const lowCount = findings.filter((f) => f.severity === "LOW").length;

  const deduction = highCount * 20 + mediumCount * 10 + lowCount * 5;
  return Math.max(0, 100 - deduction);
}

export default runSecurityModule;
