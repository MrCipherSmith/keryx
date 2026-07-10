import { test, expect } from "bun:test";
import { computeGate } from "./gate";
import { DEFAULT_HEALTH_CONFIG as C } from "./config";
import type { Finding, Priority, ScopeMetrics, SourceRunInfo } from "./types";

function project(over: Partial<ScopeMetrics> = {}): ScopeMetrics {
  return {
    key: "project",
    kind: "project",
    name: "project",
    loc: 1000,
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
    trend: "unknown",
    regression_score: 0,
    ...over,
  };
}

function source(over: Partial<SourceRunInfo>): SourceRunInfo {
  return {
    source: "x",
    status: "available",
    mode: "auto",
    required: false,
    imported: false,
    command: null,
    toolVersion: null,
    findings: 0,
    ...over,
  };
}

function finding(priority: Priority): Finding {
  return {
    schemaVersion: 1,
    id: "id",
    source: "s",
    severity: "error",
    priority,
    category: "c",
    message: "m",
    file: null,
    line: null,
    symbol: null,
    scope: { project: "current", module: null, file: null, entity: null, skill: null },
    suggestedAction: null,
    provenance: { command: null, toolVersion: null, rawLog: null },
  };
}

test("clean state passes", () => {
  const g = computeGate({ findings: [], projectMetrics: project(), sources: [], config: C, strict: false });
  expect(g.status).toBe("pass");
});

test("a P0 finding fails the gate", () => {
  const g = computeGate({ findings: [finding("P0")], projectMetrics: project(), sources: [], config: C, strict: false });
  expect(g.status).toBe("fail");
});

test("P1/P2 findings alone do not fail", () => {
  const g = computeGate({ findings: [finding("P1"), finding("P2")], projectMetrics: project(), sources: [], config: C, strict: false });
  expect(g.status).toBe("pass");
});

test("regression at/above fail threshold fails", () => {
  const g = computeGate({ findings: [], projectMetrics: project({ regression_score: 12 }), sources: [], config: C, strict: false });
  expect(g.status).toBe("fail");
});

test("regression in warn band warns", () => {
  const g = computeGate({ findings: [], projectMetrics: project({ regression_score: 5 }), sources: [], config: C, strict: false });
  expect(g.status).toBe("warn");
});

test("missing required source: strict fails, non-strict warns", () => {
  const sources = [source({ source: "typescript", required: true, status: "missing" })];
  expect(computeGate({ findings: [], projectMetrics: project(), sources, config: C, strict: true }).status).toBe("fail");
  expect(computeGate({ findings: [], projectMetrics: project(), sources, config: C, strict: false }).status).toBe("warn");
});

test("optional skipped source does not affect gate", () => {
  const sources = [source({ source: "coverage", required: false, status: "skipped" })];
  expect(computeGate({ findings: [], projectMetrics: project(), sources, config: C, strict: true }).status).toBe("pass");
});

test("coverage below soft floor warns", () => {
  const g = computeGate({ findings: [], projectMetrics: project({ coverage: 50 }), sources: [], config: C, strict: false });
  expect(g.status).toBe("warn");
});
