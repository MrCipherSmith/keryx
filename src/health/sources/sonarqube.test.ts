import { test, expect } from "bun:test";
import { sonarqubeAdapter } from "./sonarqube";
import type { HealthContext, RawSourceResult } from "../types";

const ctx = { cwd: "/repo" } as unknown as HealthContext;

function raw(content: string): RawSourceResult {
  return {
    source: "sonarqube",
    command: null,
    toolVersion: null,
    exitCode: 0,
    rawPath: "",
    content,
    imported: true,
  };
}

test("maps sonar severities to priorities and strips the component key", () => {
  const findings = sonarqubeAdapter.parse(
    raw(
      JSON.stringify({
        issues: [
          { rule: "S1", severity: "BLOCKER", message: "bug", component: "proj:src/a.ts", line: 3, type: "BUG" },
          { rule: "S2", severity: "MAJOR", message: "smell", component: "proj:src/b.ts", type: "CODE_SMELL" },
          { rule: "S3", severity: "MINOR", message: "minor", component: "proj:src/c.ts" },
          { rule: "S4", severity: "INFO", message: "info", component: "proj:src/d.ts" },
        ],
      }),
    ),
    ctx,
  );
  expect(findings.map((f) => f.priority)).toEqual(["P0", "P1", "P2", "P3"]);
  expect(findings[0]?.file).toBe("src/a.ts");
  expect(findings[0]?.line).toBe(3);
  expect(findings[1]?.category).toBe("code_smell");
});

test("tolerates malformed sonar output", () => {
  expect(sonarqubeAdapter.parse(raw("not json"), ctx)).toEqual([]);
  expect(sonarqubeAdapter.parse(raw("{}"), ctx)).toEqual([]);
});
