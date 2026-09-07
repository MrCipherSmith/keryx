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

// F-018 (flow 234 T27, minor): `parse()` above tolerates malformed input by
// returning zero findings - on its own, that made a corrupt sonar-issues.json
// indistinguishable from a real clean scan (`run.ts` records
// `status: available, parse: parsed, findings: 0` unless `adapter.validate`
// says otherwise). This adapter must declare `validate` the same way the
// eslint and dependency-audit adapters already do, so `run.ts` records
// `parse: failed` instead.
test("validate flags a corrupt (unparseable) sonar report as invalid", () => {
  expect(sonarqubeAdapter.validate?.(raw("not json"))).toEqual({
    valid: false,
    error: "Sonar issues JSON parse failed",
  });
});

test("validate flags well-formed JSON that is not sonar-issues-shaped as invalid", () => {
  expect(sonarqubeAdapter.validate?.(raw("{}"))).toEqual({
    valid: false,
    error: "Sonar issues JSON format was not recognized",
  });
  expect(sonarqubeAdapter.validate?.(raw(JSON.stringify({ issues: "nope" })))).toEqual({
    valid: false,
    error: "Sonar issues JSON format was not recognized",
  });
});

test("validate accepts a well-formed sonar-issues.json, including an empty issues list", () => {
  expect(sonarqubeAdapter.validate?.(raw(JSON.stringify({ issues: [] })))).toEqual({
    valid: true,
    format: "sonar-issues-json",
  });
  expect(
    sonarqubeAdapter.validate?.(
      raw(JSON.stringify({ issues: [{ rule: "S1", severity: "MAJOR", message: "x" }] })),
    ),
  ).toEqual({ valid: true, format: "sonar-issues-json" });
});
