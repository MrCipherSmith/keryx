import { test, expect } from "bun:test";
import { computeMetrics } from "./scopes";
import { DEFAULT_HEALTH_CONFIG } from "./config";
import type { CoverageData } from "./metrics/coverage";

// Uses real repo files so computeMetrics can read loc/complexity.
test("emits component scopes for nested directories, not for direct module files", async () => {
  const coverage: CoverageData = { status: "missing", total: null, byFile: new Map() };
  const metrics = await computeMetrics({
    cwd: process.cwd(),
    config: DEFAULT_HEALTH_CONFIG,
    findings: [],
    sourceFiles: ["src/health/metrics/churn.ts", "src/health/run.ts"],
    coverage,
    churn: new Map(),
    baseline: new Map(),
  });

  const keys = metrics.map((m) => m.key);
  expect(keys).toContain("module:src/health");
  // nested directory -> its own component scope
  expect(keys).toContain("component:src/health/metrics");
  // a file directly under the module dir does not create a redundant component
  expect(keys).not.toContain("component:src/health");
});
