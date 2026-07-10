import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, expect } from "bun:test";
import { DEFAULT_HEALTH_CONFIG } from "./config";
import { computeMetrics } from "./scopes";

test("file scope reports metrics even when the file has no findings", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "gd-health-scope-"));
  try {
    await writeFile(
      path.join(cwd, "init.ts"),
      "export function init(): void {\n  return;\n}\n",
      "utf8",
    );

    const metrics = await computeMetrics({
      cwd,
      config: DEFAULT_HEALTH_CONFIG,
      findings: [],
      sourceFiles: ["init.ts"],
      coverage: { status: "missing", total: null, byFile: new Map() },
      churn: new Map(),
      baseline: new Map(),
      scopeSelector: { kind: "file", path: "init.ts" },
    });

    const fileMetric = metrics.find((metric) => metric.key === "file:init.ts");
    expect(fileMetric?.kind).toBe("file");
    expect(fileMetric?.findingCounts.total).toBe(0);
    expect(fileMetric?.health_score).toBe(100);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
