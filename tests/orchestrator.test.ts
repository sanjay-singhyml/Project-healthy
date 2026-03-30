// Test suite for orchestrator (runner.ts) and scorer
import { describe, it, expect } from "vitest";
import type {
  ModuleResult,
  ModuleId,
  ProjectHealthConfig,
  HealthReport,
} from "../src/types/index.js";
import {
  runAllModules,
  runSingleModule,
  calculateHealthScore,
  generateTopActions,
  createHealthReport,
} from "../src/modules/runner.js";

function makeModuleResult(overrides: Partial<ModuleResult> = {}): ModuleResult {
  return {
    moduleId: "M-07",
    moduleName: "Environment Integrity",
    score: 80,
    status: "ok",
    findings: [],
    metadata: {},
    durationMs: 100,
    ...overrides,
  };
}

const DEFAULT_CONFIG: ProjectHealthConfig = {
  proxy: { url: "http://localhost:3000", timeout: 30000 },
  modules: {
    cicd: {
      enabled: true,
      slowJobThresholdMinutes: 5,
      failureRateThreshold: 0.2,
    },
    quality: { enabled: true, complexityThreshold: 10, duplicateLineMin: 20 },
    docs: { enabled: true, stalenessDays: 14, aiSemanticCheck: false },
    flakiness: { enabled: true, lookbackRuns: 20, passRateThreshold: 0.95 },
    security: { enabled: true, blockedLicenses: ["GPL-3.0", "AGPL-3.0"] },
    prComplexity: {
      enabled: true,
      maxLinesChanged: 500,
      maxFilesChanged: 5,
      reviewTimeoutDays: 3,
    },
    env: { enabled: true, secretPatterns: [] },
    buildPerf: { enabled: true, bottleneckThresholdPct: 30 },
  },
  scoring: {
    weights: {
      security: 20,
      quality: 18,
      cicd: 15,
      flakiness: 14,
      env: 13,
      buildPerf: 10,
      docs: 6,
      prComplexity: 4,
    },
    failUnder: 70,
  },
  docUpdater: { mode: "direct" },
};

describe("Orchestrator: runAllModules", () => {
  it("runs all 8 modules in parallel via Promise.allSettled", async () => {
    const modulesMap = new Map<
      ModuleId,
      (config: any) => Promise<ModuleResult>
    >();
    let callCount = 0;

    for (const id of [
      "M-01",
      "M-02",
      "M-03",
      "M-04",
      "M-05",
      "M-06",
      "M-07",
      "M-08",
    ] as ModuleId[]) {
      modulesMap.set(id, async () => {
        callCount++;
        return makeModuleResult({ moduleId: id, moduleName: id });
      });
    }

    const results = await runAllModules(DEFAULT_CONFIG, modulesMap);
    expect(results.length).toBe(8);
    expect(callCount).toBe(8);
  });

  it("one failing module does not block others (Promise.allSettled)", async () => {
    const modulesMap = new Map<
      ModuleId,
      (config: any) => Promise<ModuleResult>
    >();

    modulesMap.set("M-01", async () => {
      throw new Error("M-01 failed");
    });
    for (const id of [
      "M-02",
      "M-03",
      "M-04",
      "M-05",
      "M-06",
      "M-07",
      "M-08",
    ] as ModuleId[]) {
      modulesMap.set(id, async () => makeModuleResult({ moduleId: id }));
    }

    const results = await runAllModules(DEFAULT_CONFIG, modulesMap);
    expect(results.length).toBe(8);
    // M-01 should have error status
    const m01 = results.find((r) => r.moduleId === "M-01");
    expect(m01).toBeDefined();
    expect(m01!.status).toBe("error");
  });

  it("skips disabled modules", async () => {
    const config = {
      ...DEFAULT_CONFIG,
      modules: {
        ...DEFAULT_CONFIG.modules,
        env: { enabled: false, secretPatterns: [] },
      },
    };

    const modulesMap = new Map<
      ModuleId,
      (config: any) => Promise<ModuleResult>
    >();
    const calledIds: ModuleId[] = [];

    for (const id of [
      "M-01",
      "M-02",
      "M-03",
      "M-04",
      "M-05",
      "M-06",
      "M-07",
      "M-08",
    ] as ModuleId[]) {
      modulesMap.set(id, async () => {
        calledIds.push(id);
        return makeModuleResult({ moduleId: id });
      });
    }

    const results = await runAllModules(config, modulesMap);
    expect(calledIds).not.toContain("M-07");
    expect(results.length).toBe(7);
  });

  it("unregistered module returns error result", async () => {
    const modulesMap = new Map<
      ModuleId,
      (config: any) => Promise<ModuleResult>
    >();
    // Only register M-01
    modulesMap.set("M-01", async () => makeModuleResult({ moduleId: "M-01" }));

    const results = await runAllModules(DEFAULT_CONFIG, modulesMap);
    expect(results.length).toBe(8);
    const m02 = results.find((r) => r.moduleId === "M-02");
    expect(m02).toBeDefined();
    expect(m02!.status).toBe("error");
  });
});

describe("Orchestrator: runSingleModule", () => {
  it("runs single module by ID", async () => {
    const modulesMap = new Map<
      ModuleId,
      (config: any) => Promise<ModuleResult>
    >();
    modulesMap.set("M-05", async () =>
      makeModuleResult({ moduleId: "M-05", score: 90 }),
    );

    const result = await runSingleModule("M-05", DEFAULT_CONFIG, modulesMap);
    expect(result.moduleId).toBe("M-05");
    expect(result.score).toBe(90);
  });

  it("returns error for unknown module", async () => {
    const modulesMap = new Map<
      ModuleId,
      (config: any) => Promise<ModuleResult>
    >();
    const result = await runSingleModule(
      "M-99" as ModuleId,
      DEFAULT_CONFIG,
      modulesMap,
    );
    expect(result.status).toBe("error");
  });

  it("catches errors from module runner", async () => {
    const modulesMap = new Map<
      ModuleId,
      (config: any) => Promise<ModuleResult>
    >();
    modulesMap.set("M-01", async () => {
      throw new Error("crash");
    });

    const result = await runSingleModule("M-01", DEFAULT_CONFIG, modulesMap);
    expect(result.status).toBe("error");
    expect(result.findings[0].message).toContain("crash");
  });
});

describe("Scorer: calculateHealthScore", () => {
  it("P2-TC07: computes correct weighted average", () => {
    const results = [
      makeModuleResult({ moduleId: "M-05", score: 60 }), // weight 20
      makeModuleResult({ moduleId: "M-07", score: 80 }), // weight 13
    ];
    // (60*20 + 80*13) / (20+13) = (1200 + 1040) / 33 = 2240/33 ≈ 67.88 → 68
    const score = calculateHealthScore(results, DEFAULT_CONFIG);
    expect(score).toBe(68);
  });

  it("returns 0 when no module results", () => {
    const score = calculateHealthScore([], DEFAULT_CONFIG);
    expect(score).toBe(0);
  });

  it("returns integer (Math.round, not Math.floor or Math.ceil)", () => {
    // (60*20 + 80*13) / (20+13) = 67.878 → should round to 68
    const results = [
      makeModuleResult({ moduleId: "M-05", score: 60 }),
      makeModuleResult({ moduleId: "M-07", score: 80 }),
    ];
    const score = calculateHealthScore(results, DEFAULT_CONFIG);
    expect(Number.isInteger(score)).toBe(true);
    expect(score).toBe(68); // Math.round(67.878) = 68
  });

  it("handles all 8 modules", () => {
    const results = (
      [
        "M-01",
        "M-02",
        "M-03",
        "M-04",
        "M-05",
        "M-06",
        "M-07",
        "M-08",
      ] as ModuleId[]
    ).map((id) => makeModuleResult({ moduleId: id, score: 100 }));
    const score = calculateHealthScore(results, DEFAULT_CONFIG);
    expect(score).toBe(100);
  });

  it("returns EXCELLENT band for score 90-100", () => {
    const results = [
      makeModuleResult({ moduleId: "M-05", score: 95 }),
      makeModuleResult({ moduleId: "M-07", score: 95 }),
    ];
    const score = calculateHealthScore(results, DEFAULT_CONFIG);
    expect(score).toBeGreaterThanOrEqual(90);
  });
});

describe("Scorer: generateTopActions", () => {
  it("returns top 3 findings by severity", () => {
    const findings = [
      {
        id: "1",
        moduleId: "M-07" as ModuleId,
        type: "ENV_DRIFT" as const,
        severity: "LOW" as const,
        message: "low",
        metadata: {},
      },
      {
        id: "2",
        moduleId: "M-07" as ModuleId,
        type: "SECRET_LEAK" as const,
        severity: "CRITICAL" as const,
        message: "critical",
        fix: "fix secret",
        metadata: {},
      },
      {
        id: "3",
        moduleId: "M-05" as ModuleId,
        type: "CVE" as const,
        severity: "HIGH" as const,
        message: "high",
        metadata: {},
      },
      {
        id: "4",
        moduleId: "M-05" as ModuleId,
        type: "CVE" as const,
        severity: "MEDIUM" as const,
        message: "medium",
        metadata: {},
      },
    ];
    const actions = generateTopActions(findings);
    expect(actions.length).toBe(3);
    expect(actions[0]).toBe("fix secret"); // CRITICAL with fix
  });

  it("returns empty when no findings", () => {
    const actions = generateTopActions([]);
    expect(actions.length).toBe(0);
  });
});
