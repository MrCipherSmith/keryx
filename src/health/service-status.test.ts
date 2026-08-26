import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCodeHealthService } from "./service";
import type { HealthReport, ScopeMetrics } from "./types";

function metric(overrides: Partial<ScopeMetrics>): ScopeMetrics {
  return {
    key: "project",
    kind: "project",
    name: "project",
    loc: 100,
    findingCounts: {
      total: 0,
      bySeverity: { error: 0, warning: 0, info: 0 },
      byPriority: { P0: 0, P1: 0, P2: 0, P3: 0 },
      bySource: {},
    },
    coverage: null,
    churn: null,
    complexity: null,
    health_score: 90,
    risk_score: 0,
    trend: "stable",
    regression_score: 0,
    ...overrides,
  };
}

function report(metrics: ScopeMetrics[]): HealthReport {
  return {
    schemaVersion: 1,
    generatedAt: "2026-08-26T00:00:00.000Z",
    scope: "project",
    strict: false,
    gitRef: null,
    gate: { status: "pass", reasons: [] },
    sources: [],
    metrics,
    findings: [],
  };
}

let cwd = "";

beforeEach(() => {
  cwd = mkdtempSync(path.join(tmpdir(), "keryx-health-status-"));
  mkdirSync(path.join(cwd, ".metaproject", "data", "health", "artifacts"), { recursive: true });
  writeFileSync(path.join(cwd, ".metaproject", "health.config.json"), "{}");
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe("code health service status", () => {
  test("keeps historical regressions count separate from regressed trend count", async () => {
    const metrics = [
      metric({ key: "project", regression_score: 8, trend: "stable" }),
      metric({ key: "module:a", kind: "module", name: "a", regression_score: 0, trend: "regressed" }),
      metric({ key: "module:b", kind: "module", name: "b", regression_score: 3, trend: "stable" }),
    ];
    writeFileSync(
      path.join(cwd, ".metaproject", "data", "health", "artifacts", "latest.json"),
      JSON.stringify(report(metrics)),
    );

    const status = await createCodeHealthService().status({ cwd });

    expect(status.regressions).toBe(2);
    expect(status.decliningScopes).toBe(2);
    expect(status.regressedScopes).toBe(1);
  });
});
