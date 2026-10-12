// summary.json is a contract another program reads; report.md is the same facts for a person.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { countFindings, renderReport, validateSummary, writeSummary, type AutonomousSummary } from "./autonomous-summary";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sample(overrides: Partial<AutonomousSummary> = {}): AutonomousSummary {
  return {
    schemaVersion: 1,
    profile: "review-autonomous",
    target: { kind: "pr", ref: "https://github.com/o/r/pull/7", repository: "o/r", number: 7, head: "abc123" },
    status: "complete",
    exitCode: 0,
    reason: "package closed",
    phase: "review complete",
    startedAt: "2026-10-11T10:00:00.000Z",
    finishedAt: "2026-10-11T10:30:00.000Z",
    durationSeconds: 1800,
    attempts: 1,
    rounds: 2,
    tokens: 12345,
    package: { id: "rv-1", status: "closed", path: ".metaproject/reviews/rv-1" },
    findings: { blocker: 0, major: 5, minor: 3, info: 1 },
    floorRefusals: 0,
    autoAnswers: { count: 2, last: { question: "Which plan?", answer: "a", basis: "recommended" } },
    ...overrides,
  };
}

describe("validateSummary", () => {
  test("accepts a complete summary", () => {
    expect(validateSummary(sample())).toEqual([]);
  });

  test("accepts a run that never opened a package", () => {
    expect(validateSummary(sample({ status: "stalled", exitCode: 5, package: null }))).toEqual([]);
  });

  test("names every missing or wrong field", () => {
    const bad = { ...sample(), status: "maybe", exitCode: "0", tokens: -1 } as unknown;
    const problems = validateSummary(bad);
    expect(problems.some((p) => p.includes("status"))).toBe(true);
    expect(problems.some((p) => p.includes("exitCode"))).toBe(true);
    expect(problems.some((p) => p.includes("tokens"))).toBe(true);
  });

  test("the exit code must agree with the status", () => {
    expect(validateSummary(sample({ status: "budget", exitCode: 0 })).some((p) => p.includes("exitCode"))).toBe(true);
  });

  test("a non-object is refused", () => {
    expect(validateSummary(null)).not.toEqual([]);
    expect(validateSummary("x")).not.toEqual([]);
  });
});

describe("countFindings", () => {
  test("counts by severity and ignores what it does not know", () => {
    expect(
      countFindings([{ severity: "major" }, { severity: "major" }, { severity: "minor" }, { severity: "weird" }, null, {}]),
    ).toEqual({ blocker: 0, major: 2, minor: 1, info: 0 });
  });

  test("a value that is not a list counts as none", () => {
    expect(countFindings({})).toEqual({ blocker: 0, major: 0, minor: 0, info: 0 });
  });
});

describe("report", () => {
  test("states the verdict, the reason and the numbers", () => {
    const text = renderReport(sample());
    expect(text).toContain("https://github.com/o/r/pull/7");
    expect(text).toContain("complete");
    expect(text).toContain("package closed");
    expect(text).toContain("5 major");
    expect(text).toContain("12345");
    expect(text).toContain("rv-1");
  });

  test("an incomplete run says why and where it stopped", () => {
    const text = renderReport(sample({ status: "budget", exitCode: 4, reason: "token budget 1000 exceeded", phase: "review ingest" }));
    expect(text).toContain("token budget 1000 exceeded");
    expect(text).toContain("review ingest");
    expect(text).toMatch(/resume|again/i);
  });
});

describe("writeSummary", () => {
  test("writes summary.json that validates and report.md", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "autonomous-summary-"));
    dirs.push(dir);
    writeSummary(dir, sample());
    expect(validateSummary(JSON.parse(readFileSync(path.join(dir, "summary.json"), "utf8")))).toEqual([]);
    expect(readFileSync(path.join(dir, "report.md"), "utf8")).toContain("rv-1");
  });
});
