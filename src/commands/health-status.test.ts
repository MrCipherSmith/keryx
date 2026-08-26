import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { healthCommand } from "./health";
import type { HealthReport, ScopeMetrics } from "../health/types";

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
let originalCwd = "";
let originalLog: typeof console.log;
let captured: string[] = [];

beforeEach(() => {
  cwd = mkdtempSync(path.join(tmpdir(), "keryx-health-command-"));
  mkdirSync(path.join(cwd, ".metaproject", "data", "health", "artifacts"), { recursive: true });
  writeFileSync(path.join(cwd, ".metaproject", "health.config.json"), "{}");
  writeFileSync(
    path.join(cwd, ".metaproject", "data", "health", "artifacts", "latest.json"),
    JSON.stringify(
      report([
        metric({ key: "project", regression_score: 4, trend: "stable" }),
        metric({ key: "module:a", kind: "module", name: "a", trend: "regressed" }),
        metric({ key: "module:b", kind: "module", name: "b", regression_score: 2, trend: "stable" }),
      ]),
    ),
  );
  originalCwd = process.cwd();
  process.chdir(cwd);
  captured = [];
  originalLog = console.log;
  console.log = (...parts: unknown[]) => captured.push(parts.map(String).join(" "));
});

afterEach(() => {
  console.log = originalLog;
  process.chdir(originalCwd);
  rmSync(cwd, { recursive: true, force: true });
});

describe("keryx health status", () => {
  test("prints declining and regressed scopes with their distinct meanings", async () => {
    await healthCommand(["status"]);

    const output = captured.join("\n");
    expect(output).toContain("declining scopes: 2");
    expect(output).toContain("regressed scopes: 1");
  });
});
