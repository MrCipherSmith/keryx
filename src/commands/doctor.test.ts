// Flow 353 (P0 W5), AC1 — `keryx doctor [--json]`.
//
// AC1's own bar: "exit 0 when nothing is fail"; "--json emits
// {checks:[{id,status,detail,fix?}]}"; "runs on a fresh clone in under 3s";
// "a test covers the JSON shape and the exit codes". Real environment data
// (this repo's own Bun/rg/providers/etc.) drives the integration-level
// assertions below rather than a fully mocked fixture, matching
// `sandbox.test.ts`'s own pattern for this same style of aggregate report —
// the exit-code PREDICATE is tested separately, against a synthetic report,
// so a genuine "fail" does not have to be reproduced in a real environment
// just to prove the arithmetic.

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildDoctorReport,
  doctorCommand,
  doctorFailed,
  formatDoctorReport,
  meetsBunFloor,
  type DoctorCheck,
  type DoctorReport,
} from "./doctor";

const EXPECTED_CHECK_IDS = [
  "version",
  "bun",
  "ripgrep",
  "sandbox",
  "providers",
  "mcp",
  "integrations",
  "standard",
  "worktrees",
  "graph-freshness",
  "wiki-freshness",
];

describe("meetsBunFloor", () => {
  test("above, at, and below the floor", () => {
    expect(meetsBunFloor("1.4.2", ">=1.3.14")).toBe(true);
    expect(meetsBunFloor("1.3.14", ">=1.3.14")).toBe(true);
    expect(meetsBunFloor("1.3.13", ">=1.3.14")).toBe(false);
    expect(meetsBunFloor("1.2.99", ">=1.3.14")).toBe(false);
    expect(meetsBunFloor("2.0.0", ">=1.3.14")).toBe(true);
  });

  test("an unparseable floor or current version never fails the check", () => {
    expect(meetsBunFloor("1.0.0", "not-a-semver")).toBe(true);
    expect(meetsBunFloor("not-a-version", ">=1.3.14")).toBe(true);
  });
});

describe("doctorFailed (exit-code predicate)", () => {
  function reportWith(statuses: DoctorCheck["status"][]): DoctorReport {
    return { checks: statuses.map((status, i) => ({ id: `c${i}`, status, detail: "x" })) };
  }

  test("no fail: false (exit 0)", () => {
    expect(doctorFailed(reportWith(["ok", "warn", "ok"]))).toBe(false);
  });

  test("any fail: true (exit 1), regardless of position", () => {
    expect(doctorFailed(reportWith(["ok", "fail", "warn"]))).toBe(true);
    expect(doctorFailed(reportWith(["fail"]))).toBe(true);
  });

  test("empty checks: false", () => {
    expect(doctorFailed({ checks: [] })).toBe(false);
  });
});

describe("buildDoctorReport — shape (AC1: {checks:[{id,status,detail,fix?}]})", () => {
  test("every AC1 check id is present, exactly once, each with a valid status and a non-empty detail", async () => {
    const report = await buildDoctorReport(process.cwd());
    const ids = report.checks.map((c) => c.id);
    expect(ids.sort()).toEqual([...EXPECTED_CHECK_IDS].sort());
    expect(new Set(ids).size).toBe(ids.length);
    for (const check of report.checks) {
      expect(["ok", "warn", "fail"]).toContain(check.status);
      expect(check.detail.length).toBeGreaterThan(0);
      if (check.status !== "ok") {
        // AC1: "each as ok/warn/fail with a fix hint" — warn/fail carry one.
        expect(typeof check.fix === "string" && check.fix.length > 0).toBe(true);
      }
    }
  });

  test("on this repository (a real, already-cloned project) nothing is fail", async () => {
    const report = await buildDoctorReport(process.cwd());
    expect(doctorFailed(report)).toBe(false);
  });

  test("runs in well under 3s on this repository", async () => {
    const start = performance.now();
    await buildDoctorReport(process.cwd());
    expect(performance.now() - start).toBeLessThan(3000);
  });

  test("a directory with nothing initialized at all (no .metaproject, no git) still returns every check id, never throws", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "keryx-doctor-bare-"));
    try {
      const report = await buildDoctorReport(root, {});
      expect(report.checks.map((c) => c.id).sort()).toEqual([...EXPECTED_CHECK_IDS].sort());
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("providers: names only, never a credential value", async () => {
    const report = await buildDoctorReport(process.cwd(), { DEEPSEEK_API_KEY: "sk-live-should-never-appear" });
    const providers = report.checks.find((c) => c.id === "providers");
    expect(providers?.detail).not.toContain("sk-live-should-never-appear");
  });
});

describe("formatDoctorReport — human rendering", () => {
  test("renders one line per check, with a fix line under warn/fail", () => {
    const report: DoctorReport = {
      checks: [
        { id: "a", status: "ok", detail: "fine" },
        { id: "b", status: "warn", detail: "needs a look", fix: "keryx b fix" },
        { id: "c", status: "fail", detail: "broken", fix: "keryx c fix" },
      ],
    };
    const text = formatDoctorReport(report);
    expect(text).toContain("a: fine");
    expect(text).toContain("b: needs a look");
    expect(text).toContain("fix: keryx b fix");
    expect(text).toContain("c: broken");
    expect(text).toContain("fix: keryx c fix");
  });
});

describe("keryx doctor (CLI) — --json shape and exit codes", () => {
  async function runCaptured(fn: () => Promise<void>): Promise<{ out: string; code: number }> {
    const originalLog = console.log;
    const lines: string[] = [];
    console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
    process.exitCode = 0;
    try {
      await fn();
      return { out: lines.join("\n"), code: process.exitCode ?? 0 };
    } finally {
      console.log = originalLog;
      process.exitCode = 0;
    }
  }

  test("--json prints valid JSON of the exact {checks:[...]} shape", async () => {
    const { out, code } = await runCaptured(() => doctorCommand(["--json"], process.cwd()));
    const parsed = JSON.parse(out) as DoctorReport;
    expect(Array.isArray(parsed.checks)).toBe(true);
    expect(parsed.checks.length).toBe(EXPECTED_CHECK_IDS.length);
    expect(code).toBe(0);
  });

  test("no --json: human-readable output, exit 0 on this repository", async () => {
    const { out, code } = await runCaptured(() => doctorCommand([], process.cwd()));
    expect(out).toContain("keryx doctor");
    for (const id of EXPECTED_CHECK_IDS) {
      expect(out).toContain(`${id}:`);
    }
    expect(code).toBe(0);
  });

  test("--help prints usage and does not run the checks", async () => {
    const { out } = await runCaptured(() => doctorCommand(["--help"], process.cwd()));
    expect(out).toContain("keryx doctor");
    expect(out).not.toContain("version:");
  });
});
