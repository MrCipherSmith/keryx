import { test, expect } from "bun:test";
import { eslintAdapter } from "./sources/eslint";
import { typescriptAdapter } from "./sources/typescript";
import { dependencyAuditAdapter } from "./sources/dependency-audit";
import { loadHealthConfig } from "./config";
import type { HealthContext, RawSourceResult } from "./types";

const ctx = { cwd: "/repo" } as unknown as HealthContext;

function raw(source: string, content: string): RawSourceResult {
  return {
    source,
    command: null,
    toolVersion: null,
    exitCode: 1,
    rawPath: "",
    content,
    imported: false,
  };
}

test("eslint parser maps severity to priority and relativizes paths", () => {
  const findings = eslintAdapter.parse(
    raw(
      "eslint",
      JSON.stringify([
        {
          filePath: "/repo/src/x.ts",
          messages: [
            { ruleId: "no-any", severity: 2, message: "e", line: 3 },
            { ruleId: "semi", severity: 1, message: "w", line: 5 },
          ],
        },
      ]),
    ),
    ctx,
  );
  expect(findings.map((f) => f.priority)).toEqual(["P1", "P2"]);
  expect(findings[0]?.file).toBe("src/x.ts");
  expect(findings[0]?.category).toBe("lint");
});

test("eslint parser tolerates non-JSON output", () => {
  expect(eslintAdapter.parse(raw("eslint", "not json"), ctx)).toEqual([]);
});

test("typescript parser maps error->P0 and warning->P2", () => {
  const findings = typescriptAdapter.parse(
    raw(
      "typescript",
      "src/a.ts(10,5): error TS2322: type mismatch\nsrc/b.ts(1,1): warning TS6133: unused",
    ),
    ctx,
  );
  expect(findings.map((f) => f.priority)).toEqual(["P0", "P2"]);
  expect(findings[0]?.line).toBe(10);
});

test("dependency audit maps severities and tolerates junk", () => {
  const findings = dependencyAuditAdapter.parse(
    raw(
      "dependencyAudit",
      JSON.stringify({
        vulnerabilities: {
          left: { severity: "critical" },
          right: { severity: "moderate" },
          low: { severity: "low" },
        },
      }),
    ),
    ctx,
  );
  const priorities = findings.map((f) => f.priority).sort();
  expect(priorities).toEqual(["P0", "P1", "P2"]);
  expect(dependencyAuditAdapter.parse(raw("dependencyAudit", "junk"), ctx)).toEqual([]);
});

test("config falls back to defaults when file is absent", async () => {
  const config = await loadHealthConfig("/nonexistent-project-xyz");
  expect(config.sources.eslint?.required).toBe(true);
  expect(config.sources.typescript?.required).toBe(true);
  expect(config.gate.failOnPriorities).toContain("P0");
  expect(config.metrics.complexityThreshold).toBe(10);
});
