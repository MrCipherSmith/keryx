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
import { mkdir, writeFile } from "node:fs/promises";
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

/** The five checks that run regardless of whether `cwd` is a keryx project. */
const GLOBAL_CHECK_IDS = ["version", "bun", "ripgrep", "sandbox", "providers"];

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

  // Backlog item 12 (flow 356): a directory with no `.metaproject/` used to
  // run every project-scoped check anyway — `standard` alone produced seven
  // "Required file … is missing" `fail` lines, and the whole command exited
  // 1, which reads as "keryx is broken" rather than "this directory has
  // never been `keryx init`'d". Now it is ONE `warn` line, the five global
  // checks still run, and nothing here is `fail`.
  test("a directory with nothing initialized at all (no .metaproject, no git): one warn line replaces every project-scoped check, nothing is fail, never throws", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "keryx-doctor-bare-"));
    try {
      const report = await buildDoctorReport(root, {});
      const ids = report.checks.map((c) => c.id).sort();
      expect(ids).toEqual([...GLOBAL_CHECK_IDS, "project"].sort());
      const project = report.checks.find((c) => c.id === "project");
      expect(project?.status).toBe("warn");
      expect(project?.detail).toBe("not a keryx project — run `keryx init`");
      expect(project?.fix).toBe("keryx init");
      expect(doctorFailed(report)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a directory inside a real keryx project (has .metaproject) runs every project-scoped check as usual", async () => {
    const report = await buildDoctorReport(process.cwd(), {});
    expect(report.checks.map((c) => c.id).sort()).toEqual([...EXPECTED_CHECK_IDS].sort());
    expect(report.checks.some((c) => c.id === "project")).toBe(false);
  });

  test("a plain git repo with no .metaproject at all is STILL 'not a keryx project' — a git boundary alone does not count", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "keryx-doctor-plain-git-"));
    try {
      const proc = Bun.spawn(["git", "init", "-q"], { cwd: root, stdout: "ignore", stderr: "ignore" });
      await proc.exited;
      const report = await buildDoctorReport(root, {});
      const project = report.checks.find((c) => c.id === "project");
      expect(project?.status).toBe("warn");
      expect(project?.detail).toBe("not a keryx project — run `keryx init`");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // Backlog item 13 (flow 356): run from inside a LINKED worktree, the
  // `worktrees` check used to look beside the WORKTREE's own cwd
  // (`<worktree>/.claude/worktrees`, which never exists) instead of beside
  // the MAIN checkout — "no .claude/worktrees directory" even when the main
  // checkout has many. It must give the SAME answer from either place.
  describe("worktrees check: resolves .claude/worktrees beside the MAIN checkout, not cwd (backlog item 13)", () => {
    async function git(cwd: string, args: string[]): Promise<void> {
      const proc = Bun.spawn(["git", ...args], { cwd, stdout: "ignore", stderr: "ignore" });
      if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")} failed`);
    }

    test("the main checkout and a linked worktree agree on the SAME .claude/worktrees entries", async () => {
      const mainRoot = await mkdtemp(path.join(tmpdir(), "keryx-doctor-worktree-main-"));
      try {
        await git(mainRoot, ["init", "-q", "-b", "main"]);
        await git(mainRoot, ["config", "user.email", "test@example.com"]);
        await git(mainRoot, ["config", "user.name", "Test"]);
        await writeFile(path.join(mainRoot, "README.md"), "root\n", "utf8");
        await git(mainRoot, ["add", "."]);
        await git(mainRoot, ["commit", "-q", "-m", "initial"]);

        await mkdir(path.join(mainRoot, ".metaproject"), { recursive: true });

        const worktreesDir = path.join(mainRoot, ".claude", "worktrees");
        await mkdir(worktreesDir, { recursive: true });
        const linkedPath = path.join(worktreesDir, "agent-1");
        await git(mainRoot, ["worktree", "add", "-q", "-b", "agent/agent-1", linkedPath, "main"]);

        const fromMain = await buildDoctorReport(mainRoot, {});
        const fromLinked = await buildDoctorReport(linkedPath, {});

        const worktreesFromMain = fromMain.checks.find((c) => c.id === "worktrees");
        const worktreesFromLinked = fromLinked.checks.find((c) => c.id === "worktrees");
        expect(worktreesFromLinked).toEqual(worktreesFromMain);
        // Both see the ONE registered worktree, not "no .claude/worktrees directory".
        expect(worktreesFromMain?.detail).toContain("1 worktree(s)");
      } finally {
        await rm(mainRoot, { recursive: true, force: true });
      }
    });
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

  // Flow 353 review round 1 (blocker T1): every test above drives ONLY the
  // exit-code arithmetic (`doctorFailed`) against a synthetic report — none
  // of them proves `doctorCommand` itself ever actually SETS
  // `process.exitCode` to 1 for a genuine failing check. This drives the
  // real command end to end: `bunFloor` (`DoctorTestOverrides`, a seam that
  // exists ONLY for this test — see its doc comment in `doctor.ts`) is set
  // above the real, running Bun version, which fails ONLY the `bun` check
  // (`meetsBunFloor` is a pure function of the two version strings and
  // touches nothing else) while every other check still reads the real
  // environment.
  test("a real failing check (bun below an injected floor) sets `status: \"fail\"` in --json AND exits 1", async () => {
    const impossibleFloor = ">=999.0.0";
    const { out, code } = await runCaptured(() =>
      doctorCommand(["--json"], process.cwd(), { bunFloor: impossibleFloor }),
    );
    const parsed = JSON.parse(out) as DoctorReport;
    const bun = parsed.checks.find((c) => c.id === "bun");
    expect(bun?.status).toBe("fail");
    expect(bun?.detail).toContain(impossibleFloor);
    expect(bun?.fix).toBeDefined();
    expect(code).toBe(1);
  });

  test("the same injected failure sets exit 1 on the human-readable path too", async () => {
    const { out, code } = await runCaptured(() =>
      doctorCommand([], process.cwd(), { bunFloor: ">=999.0.0" }),
    );
    expect(out).toContain("✗ bun:");
    expect(code).toBe(1);
  });
});
