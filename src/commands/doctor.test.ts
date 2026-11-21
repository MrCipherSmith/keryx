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
import { chmod, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { readCheckout } from "../worktree/checkout";
import { createWorktree } from "../worktree/create";
import { createProjectFixture, everyPortFree } from "../worktree/project-fixture";
import { addWorktree, createFixture } from "../worktree/test-support";
import { COMMIT_MSG_FIX_LINE, installCommitMsgHookOrWarn } from "../lib/managed-git-hook";
import {
  buildDoctorReport,
  checkCommitMsgHook,
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
  "entrypoints",
  "commit-msg-hook",
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
      // Review round 1 (L2/TEST-1): hermetic against ambient filesystem
      // state. Before the fix, `isKeryxProject` delegated to
      // `resolveProjectRoot`'s unceilinged upward walk, so a `.metaproject`
      // living anywhere above this mkdtemp() fixture — directly in `/tmp`
      // itself was the exact reproduction on the review machine — flipped
      // this to "is a keryx project" and the test failed. Injecting the
      // ceiling at `root` proves the result no longer depends on anything
      // above it, ambient or not.
      const report = await buildDoctorReport(root, {}, { homeDir: root });
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

  test("review round 1 (L2/TEST-1): a decoy .metaproject in the fixture's PARENT is never reached once the ceiling is injected at the fixture itself", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "keryx-doctor-decoy-"));
    try {
      // The decoy sits in `base` — the fixture's parent, one level ABOVE
      // where the check runs from — never inside `root` itself. Without a
      // bounded, injectable ceiling this is indistinguishable from the real
      // ancestor-pollution bug the sibling "nothing initialized" test pins:
      // an unceilinged upward walk from `root` would climb straight into
      // `base` and wrongly report a keryx project.
      await mkdir(path.join(base, ".metaproject"), { recursive: true });
      const root = path.join(base, "project");
      await mkdir(root, { recursive: true });
      const report = await buildDoctorReport(root, {}, { homeDir: root });
      const project = report.checks.find((c) => c.id === "project");
      expect(project?.status).toBe("warn");
      expect(project?.detail).toBe("not a keryx project — run `keryx init`");
    } finally {
      await rm(base, { recursive: true, force: true });
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
        // Same verdict and same stale-entry answer; from a linked worktree the detail
        // additionally describes that checkout (worktree readiness, spec §8).
        expect(worktreesFromLinked?.status).toBe(worktreesFromMain?.status);
        expect(worktreesFromLinked?.detail.startsWith(worktreesFromMain?.detail ?? "?")).toBe(true);
        // Both see the ONE registered worktree, not "no .claude/worktrees directory".
        expect(worktreesFromMain?.detail).toContain("1 worktree(s)");
      } finally {
        await rm(mainRoot, { recursive: true, force: true });
      }
    });

    test("a main checkout reached through a symlinked path does not report its registered worktree stale", async () => {
      const mainRoot = await mkdtemp(path.join(tmpdir(), "keryx-doctor-worktree-link-main-"));
      const linkDir = await mkdtemp(path.join(tmpdir(), "keryx-doctor-worktree-link-"));
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
        await git(mainRoot, ["worktree", "add", "-q", "-b", "agent/agent-1", path.join(worktreesDir, "agent-1"), "main"]);

        const link = path.join(linkDir, "main-link");
        await symlink(mainRoot, link, "dir");
        const check = (await buildDoctorReport(link, {})).checks.find((c) => c.id === "worktrees");
        expect(check?.status).toBe("ok");
        expect(check?.detail).toContain("all registered");
      } finally {
        await rm(linkDir, { recursive: true, force: true });
        await rm(mainRoot, { recursive: true, force: true });
      }
    });
  });

  describe("worktrees check: readiness of a linked worktree (spec §8)", () => {
    test("a prepared worktree reports its label, ports, prepare state and unpromoted count; the main checkout adds nothing", async () => {
      const project = await createProjectFixture();
      try {
        const created = await createWorktree({
          cwd: project.main,
          name: "wt-doctor",
          base: "main",
          runInstall: project.runInstall,
          isPortFree: everyPortFree,
        });
        const label = await readCheckout(created.path);
        expect(label).toBeDefined();

        const linked = (await buildDoctorReport(created.path, {})).checks.find((c) => c.id === "worktrees");
        expect(linked?.status).toBe("ok");
        expect(linked?.detail).toContain(`checkoutId ${label?.checkoutId}`);
        expect(linked?.detail).toContain("ports PORT=5200");
        expect(linked?.detail).toContain("prepared ");
        expect(linked?.detail).toContain("0 unpromoted entries");

        const main = (await buildDoctorReport(project.main, {})).checks.find((c) => c.id === "worktrees");
        expect(main?.detail).not.toContain("checkoutId");
      } finally {
        project.cleanup();
      }
    });

    test("an unlabelled linked worktree says it is not prepared, without failing", async () => {
      const fixture = createFixture();
      try {
        const worktree = addWorktree(fixture, "wt-bare");
        await mkdir(path.join(worktree, ".metaproject"), { recursive: true }); // project-scoped checks run only in a keryx project
        const check = (await buildDoctorReport(worktree, {})).checks.find((c) => c.id === "worktrees");
        expect(check?.status).not.toBe("fail");
        expect(check?.detail).toContain("checkoutId none");
        expect(check?.detail).toContain("not prepared");
      } finally {
        fixture.cleanup();
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

describe("checkCommitMsgHook", () => {
  async function gitRepo(): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), "keryx-doctor-commit-msg-"));
    const proc = Bun.spawn(["git", "init", "-q"], { cwd: root, stdout: "ignore", stderr: "ignore" });
    await proc.exited;
    return root;
  }

  test("a foreign commit-msg hook: warn, inactive, and the fix is the exact line to add", async () => {
    const root = await gitRepo();
    try {
      const hookPath = path.join(root, ".git", "hooks", "commit-msg");
      const foreign = '#!/usr/bin/env bash\nif [ -x "$INSTALL_PYTHON" ]; then exec "$INSTALL_PYTHON" -mpre_commit "$@"; else echo missing >&2; exit 1; fi\n';
      await writeFile(hookPath, foreign, "utf8");
      await chmod(hookPath, 0o755);
      expect(await installCommitMsgHookOrWarn(root)).toContain(COMMIT_MSG_FIX_LINE);
      const check = await checkCommitMsgHook(root);
      expect(check.status).toBe("warn");
      expect(check.detail).toContain("inactive: foreign commit-msg hook");
      expect(check.fix).toBe(`add this line to '${await realpath(hookPath)}', before any exec or exit: ${COMMIT_MSG_FIX_LINE}`);
      expect(COMMIT_MSG_FIX_LINE).toBe('"$(git rev-parse --git-path hooks)/keryx-commit-msg" "$1" || exit 1');

      // Appended after the `if … exec … fi`: unverified, a warning.
      await writeFile(hookPath, `${foreign}${COMMIT_MSG_FIX_LINE}\n`, "utf8");
      const unverified = await checkCommitMsgHook(root);
      expect(unverified.status).toBe("warn");
      expect(unverified.detail).toContain("unverified — check that this line runs before any exec");
      expect(unverified.fix).toContain(COMMIT_MSG_FIX_LINE);

      // Right after the shebang: active.
      const [shebang, ...rest] = foreign.split("\n");
      await writeFile(hookPath, `${shebang}\n${COMMIT_MSG_FIX_LINE}\n${rest.join("\n")}`, "utf8");
      const active = await checkCommitMsgHook(root);
      expect(active.status).toBe("ok");
      expect(active.fix).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("ok when installed and active; warn with `keryx update` as the fix when missing", async () => {
    const root = await gitRepo();
    try {
      const missing = await checkCommitMsgHook(root);
      expect(missing.status).toBe("warn");
      expect(missing.fix).toBe("keryx update");
      expect(await installCommitMsgHookOrWarn(root)).toBeNull();
      expect((await checkCommitMsgHook(root)).status).toBe("ok");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a foreign core.hooksPath: warn, with a fix naming that hook and core.hooksPath", async () => {
    const root = await gitRepo();
    try {
      expect(await installCommitMsgHookOrWarn(root)).toBeNull();
      await mkdir(path.join(root, ".githooks"), { recursive: true });
      await Bun.spawn(["git", "config", "core.hooksPath", ".githooks"], { cwd: root }).exited;
      const check = await checkCommitMsgHook(root);
      expect(check.status).toBe("warn");
      expect(check.detail).toContain("core.hooksPath");
      expect(check.fix).toContain(path.join(".githooks", "commit-msg"));
      expect(check.fix).toContain("unset core.hooksPath");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("hooks.commitMsg: false reports ok with the disabled detail, not a warning", async () => {
    const root = await gitRepo();
    try {
      await mkdir(path.join(root, ".metaproject"), { recursive: true });
      await writeFile(path.join(root, ".metaproject", "metaproject.json"), JSON.stringify({ hooks: { commitMsg: false } }), "utf8");
      const check = await checkCommitMsgHook(root);
      expect(check).toEqual({
        id: "commit-msg-hook",
        status: "ok",
        detail: "disabled by config (hooks.commitMsg: false in .metaproject/metaproject.json)",
      });
      // A non-boolean value is not read as either: warn, setting invalid.
      await writeFile(path.join(root, ".metaproject", "metaproject.json"), JSON.stringify({ hooks: { commitMsg: "false" } }), "utf8");
      const invalid = await checkCommitMsgHook(root);
      expect(invalid.status).toBe("warn");
      expect(invalid.detail).toContain("hooks.commitMsg");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fix commands quote paths with spaces", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "keryx doctor spaced "));
    const root = path.join(parent, "my project");
    try {
      await mkdir(root, { recursive: true });
      await Bun.spawn(["git", "init", "-q"], { cwd: root, stdout: "ignore", stderr: "ignore" }).exited;
      expect(await installCommitMsgHookOrWarn(root)).toBeNull();
      const scriptPath = path.join(root, ".git", "hooks", "keryx-commit-msg");
      await chmod(scriptPath, 0o644);
      const check = await checkCommitMsgHook(root);
      expect(check.status).toBe("warn");
      expect(check.fix).toBe(`chmod +x '${scriptPath}'`);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  test("an unreadable hooks setting warns and says how to fix it", async () => {
    const root = await gitRepo();
    try {
      await mkdir(path.join(root, ".metaproject"), { recursive: true });
      await writeFile(path.join(root, ".metaproject", "metaproject.json"), "{ broken", "utf8");
      const check = await checkCommitMsgHook(root);
      expect(check.status).toBe("warn");
      expect(check.detail).toContain("is not valid JSON");
      expect(check.fix).toContain("hooks.commitMsg must be true or false");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("ok outside a git repository", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "keryx-doctor-commit-msg-nogit-"));
    try {
      const check = await checkCommitMsgHook(root);
      expect(check.status).toBe("ok");
      expect(check.detail).toContain("not a git repository");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("warn, never ok, when git cannot report its hooks directory", async () => {
    // A .git directory that is not a repository: the hooks root resolves, `git rev-parse` fails.
    const root = await mkdtemp(path.join(tmpdir(), "keryx-doctor-commit-msg-revparse-"));
    try {
      await mkdir(path.join(root, ".git", "hooks"), { recursive: true });
      expect(await installCommitMsgHookOrWarn(root)).toBeNull();
      const check = await checkCommitMsgHook(root);
      expect(check.status).toBe("warn");
      expect(check.detail).toContain("effective hooks directory");
      expect(check.fix).toBe("keryx update");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
