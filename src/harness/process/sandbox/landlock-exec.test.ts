import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  LANDLOCK_APPLY_FAILED,
  NEWEST_KNOWN_ABI,
  applyRuleset,
  buildKernelRuleset,
  createLibcKernel,
  fsMaskForAbi,
  parseLandlockExecArgv,
  resolveProgram,
  runLandlockExec,
} from "./landlock-exec";
import type { KernelRuleset, LandlockExecDeps, LandlockKernel, ProgramResolverDeps } from "./landlock-exec";
import { buildLandlockRuleset, landlockFsMask } from "./landlock";
import type { LandlockRuleset } from "./landlock";
import type { SandboxProfile } from "./profile";

const LAUNCHER = path.join(import.meta.dir, "landlock-exec.ts");

/** A ruleset description of the shape `landlock.ts` produces. */
function rulesetFor(workspace: string, extraReadRoots: string[] = []): LandlockRuleset {
  const profile: SandboxProfile = {
    mode: "workspace-write",
    network: "on",
    writableRoots: [workspace],
    readDenyList: [],
    allowedDomains: [],
    required: true,
  };
  const result = buildLandlockRuleset(profile, 4, {
    workspace,
    home: process.env.HOME as string,
    extraReadRoots: [path.dirname(process.execPath), ...extraReadRoots],
  });
  if (!result.ok) {
    throw new Error(`fixture profile is inexpressible: ${result.failures.map((f) => f.code).join(", ")}`);
  }
  return result.ruleset;
}

// ---------------------------------------------------------------------------
// argv — one shape, strictly
// ---------------------------------------------------------------------------

describe("parseLandlockExecArgv", () => {
  const ruleset = rulesetFor("/work/repo");
  const json = JSON.stringify(ruleset);

  test("accepts the one shape wrap.ts produces", () => {
    const parsed = parseLandlockExecArgv(["--ruleset", json, "--", "/bin/echo", "hi"]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.invocation.command).toEqual(["/bin/echo", "hi"]);
    expect(parsed.invocation.ruleset.handledFs).toEqual(ruleset.handledFs);
    expect(parsed.invocation.ruleset.pathRules.map((r) => r.path)).toEqual(
      ruleset.pathRules.map((r) => r.path),
    );
  });

  test.each([
    [[], "no flag at all"],
    [["--rules", "{}", "--", "/bin/echo"], "a flag that is nearly right"],
    [["--ruleset"], "a flag with no value"],
    [["--ruleset", "{}", "/bin/echo"], "a missing --"],
    [["--ruleset", "not json", "--", "/bin/echo"], "a ruleset that is not JSON"],
    [["--ruleset", '"a string"', "--", "/bin/echo"], "a ruleset that is not an object"],
  ])("refuses %p (%s)", (argv) => {
    expect(parseLandlockExecArgv(argv as string[]).ok).toBe(false);
  });

  test("refuses an empty command, which would otherwise exec nothing", () => {
    expect(parseLandlockExecArgv(["--ruleset", json, "--"]).ok).toBe(false);
    expect(parseLandlockExecArgv(["--ruleset", json, "--", ""]).ok).toBe(false);
  });

  test("refuses a rule granting more than the ruleset handles", () => {
    // Not hostile input — it means the two processes disagree about the
    // boundary, and applying the half that parsed is the approximation the
    // specification forbids.
    const widened = {
      ...ruleset,
      pathRules: [{ path: "/work/repo", allow: [...ruleset.handledFs, "ioctl_dev"], onMissing: "fail" }],
    };
    const parsed = parseLandlockExecArgv(["--ruleset", JSON.stringify(widened), "--", "/bin/echo"]);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toContain("ioctl_dev");
  });

  test.each([
    [{ minimumAbi: 0 }, "a zero minimumAbi"],
    [{ handledFs: [] }, "an empty handled set"],
    [{ handledFs: ["not_a_right"] }, "an unknown access right"],
    [{ pathRules: "nope" }, "path rules that are not an array"],
    [{ pathRules: [{ path: "relative", allow: ["read_file"], onMissing: "fail" }] }, "a relative rule path"],
    [{ pathRules: [{ path: "/x", allow: [], onMissing: "fail" }] }, "an empty allow set"],
    [{ pathRules: [{ path: "/x", allow: ["read_file"], onMissing: "maybe" }] }, "an unknown disposition"],
  ])("refuses a ruleset with %p (%s)", (patch) => {
    const parsed = parseLandlockExecArgv([
      "--ruleset",
      JSON.stringify({ ...ruleset, ...patch }),
      "--",
      "/bin/echo",
    ]);
    expect(parsed.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PATH resolution — AC5
// ---------------------------------------------------------------------------

describe("resolveProgram refuses rather than falling back", () => {
  const present = new Set(["/usr/bin/git", "/bin/sh"]);
  const deps: ProgramResolverDeps = {
    isFile: (p) => present.has(p),
    isExecutable: (p) => present.has(p),
  };
  const env = { PATH: "/usr/bin:/bin" };

  test("a name on PATH resolves to the first directory that has it", () => {
    expect(resolveProgram("git", env, deps)).toEqual({ ok: true, path: "/usr/bin/git" });
  });

  test("a path containing a slash is used as given", () => {
    expect(resolveProgram("./tool", env, deps)).toEqual({ ok: true, path: "./tool" });
  });

  test("a miss is a refusal, never the bare name", () => {
    // The whole point: raw execve resolves a slash-free name against the CURRENT
    // DIRECTORY, so returning `program` here would run a file planted in the
    // workspace exactly when the real tool is missing.
    const result = resolveProgram("nosuchtool", env, deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("not found on PATH");
  });

  test("an empty PATH element is not the current directory", () => {
    // execvp treats "" as `.`; this deliberately does not.
    const cwdTool: ProgramResolverDeps = {
      isFile: (p) => p === "/tool",
      isExecutable: (p) => p === "/tool",
    };
    expect(resolveProgram("tool", { PATH: ":" }, cwdTool).ok).toBe(false);
  });

  test("a directory that satisfies X_OK is skipped, as execvp skips it", () => {
    // /usr/bin/X11 is a real example, and returning it would hand execve an
    // EACCES that reads like a policy denial.
    const dirDeps: ProgramResolverDeps = {
      isFile: (p) => p === "/bin/X11",
      isExecutable: () => true,
    };
    expect(resolveProgram("X11", { PATH: "/usr/bin:/bin" }, dirDeps)).toEqual({
      ok: true,
      path: "/bin/X11",
    });
    const notAFile: ProgramResolverDeps = { isFile: () => false, isExecutable: () => true };
    expect(resolveProgram("X11", { PATH: "/usr/bin" }, notAFile).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// masks and the ABI clamp
// ---------------------------------------------------------------------------

describe("buildKernelRuleset", () => {
  const ruleset = rulesetFor("/work/repo");

  test("refuses a kernel below the ruleset's own minimum rather than dropping rights", () => {
    const result = buildKernelRuleset(ruleset, 2);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("ABI 3");
  });

  test("refuses a kernel with no Landlock at all", () => {
    expect(buildKernelRuleset(ruleset, 0).ok).toBe(false);
  });

  test("clamps the handled mask to the kernel's ABI", () => {
    // An unknown bit yields EINVAL, so the mask follows the measured ABI and not
    // the table this file was written against.
    const result = buildKernelRuleset(ruleset, 3);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ruleset.handledFs).toBe(landlockFsMask(ruleset.handledFs) & fsMaskForAbi(3));
  });

  test("no rule ever grants more than the ruleset handles", () => {
    const result = buildKernelRuleset(ruleset, 4);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const rule of result.ruleset.rules) {
      expect(rule.allowed & ~result.ruleset.handledFs).toBe(0n);
      expect(rule.allowed).not.toBe(0n);
    }
  });

  test("a kernel newer than the table is reported, because the clamp under-restricts there", () => {
    // The dangerous direction: too-old is refused, but too-new silently leaves
    // whatever access classes the kernel added unhandled and unrestricted.
    expect(buildKernelRuleset(ruleset, NEWEST_KNOWN_ABI)).toMatchObject({
      ok: true,
      ruleset: { abiClamped: false },
    });
    expect(buildKernelRuleset(ruleset, NEWEST_KNOWN_ABI + 1)).toMatchObject({
      ok: true,
      ruleset: { abiClamped: true },
    });
  });
});

// ---------------------------------------------------------------------------
// apply — order, and what a missing path means
// ---------------------------------------------------------------------------

describe("applyRuleset", () => {
  function fakeKernel(overrides: Partial<LandlockKernel> = {}): LandlockKernel & { calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      abiVersion: () => 4,
      createRuleset: () => {
        calls.push("create");
        return { ok: true, fd: 7 };
      },
      addPathRule: (_fd, p) => {
        calls.push(`add:${p}`);
        return { ok: true };
      },
      setNoNewPrivs: () => {
        calls.push("no_new_privs");
        return { ok: true };
      },
      restrictSelf: () => {
        calls.push("restrict");
        return { ok: true };
      },
      closeRuleset: () => {
        calls.push("close");
      },
      ...overrides,
    };
  }

  const kernelRuleset: KernelRuleset = {
    handledFs: 0b111n,
    rules: [
      { path: "/work", allowed: 0b111n, onMissing: "fail" },
      { path: "/dev/tty", allowed: 0b1n, onMissing: "skip" },
    ],
    abiClamped: false,
  };

  test("no_new_privs precedes restrict_self, which is EPERM when reversed", () => {
    const kernel = fakeKernel();
    expect(applyRuleset(kernelRuleset, kernel).ok).toBe(true);
    expect(kernel.calls).toEqual([
      "create",
      "add:/work",
      "add:/dev/tty",
      "no_new_privs",
      "restrict",
      "close",
    ]);
  });

  test("a missing skippable path is dropped and the rest still applies", () => {
    const kernel = fakeKernel({
      addPathRule: (_fd, p) =>
        p === "/dev/tty" ? { ok: false, missing: true, reason: "ENOENT" } : { ok: true },
    });
    expect(applyRuleset(kernelRuleset, kernel)).toEqual({
      ok: true,
      applied: ["/work"],
      skipped: ["/dev/tty"],
    });
  });

  test("a missing REQUIRED path fails closed", () => {
    const kernel = fakeKernel({
      addPathRule: (_fd, p) =>
        p === "/work" ? { ok: false, missing: true, reason: "ENOENT" } : { ok: true },
    });
    const result = applyRuleset(kernelRuleset, kernel);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("/work");
  });

  test("a non-ENOENT failure on a skippable path is still fatal", () => {
    // The distinction `missing` carries: a permissions error on /dev/tty is not
    // an absent device, and treating it as one would carry on with a boundary
    // nobody described.
    const kernel = fakeKernel({
      addPathRule: (_fd, p) =>
        p === "/dev/tty" ? { ok: false, missing: false, reason: "EACCES" } : { ok: true },
    });
    expect(applyRuleset(kernelRuleset, kernel).ok).toBe(false);
  });

  test("the ruleset fd is closed even when restrict_self fails", () => {
    const kernel = fakeKernel({ restrictSelf: () => ({ ok: false, reason: "EPERM" }) });
    expect(applyRuleset(kernelRuleset, kernel).ok).toBe(false);
    expect(kernel.calls).toContain("close");
  });
});

// ---------------------------------------------------------------------------
// the run, wired end to end against fakes
// ---------------------------------------------------------------------------

describe("runLandlockExec", () => {
  const ruleset = rulesetFor("/work/repo");
  const argv = ["--ruleset", JSON.stringify(ruleset), "--", "/bin/echo", "hi"];

  function deps(overrides: Partial<LandlockExecDeps> = {}): LandlockExecDeps & { execCalls: string[]; warnings: string[] } {
    const execCalls: string[] = [];
    const warnings: string[] = [];
    return {
      execCalls,
      warnings,
      kernel: {
        abiVersion: () => 4,
        createRuleset: () => ({ ok: true, fd: 3 }),
        addPathRule: () => ({ ok: true }),
        setNoNewPrivs: () => ({ ok: true }),
        restrictSelf: () => ({ ok: true }),
        closeRuleset: () => {},
      },
      resolver: { isFile: () => true, isExecutable: () => true },
      exec: (p) => {
        execCalls.push(p);
        return "errno 2";
      },
      warn: (line) => {
        warnings.push(line);
      },
      ...overrides,
    };
  }

  test("applies the boundary before it executes anything", () => {
    const order: string[] = [];
    const d = deps({
      kernel: {
        abiVersion: () => 4,
        createRuleset: () => ({ ok: true, fd: 3 }),
        addPathRule: () => ({ ok: true }),
        setNoNewPrivs: () => ({ ok: true }),
        restrictSelf: () => {
          order.push("restrict");
          return { ok: true };
        },
        closeRuleset: () => {},
      },
      exec: () => {
        order.push("exec");
        return "errno 2";
      },
    });
    runLandlockExec(argv, { PATH: "/bin" }, d);
    expect(order).toEqual(["restrict", "exec"]);
  });

  test("a malformed invocation exits 125 without executing", () => {
    const d = deps();
    expect(runLandlockExec(["--ruleset", "{"], { PATH: "/bin" }, d).code).toBe(LANDLOCK_APPLY_FAILED);
    expect(d.execCalls).toEqual([]);
  });

  test("a program that cannot be resolved exits 125 without executing", () => {
    // A bare name, because a path containing a slash is used as given and never
    // reaches the resolver — the first version of this test asserted nothing.
    const bare = ["--ruleset", JSON.stringify(ruleset), "--", "nosuchtool"];
    const d = deps({ resolver: { isFile: () => false, isExecutable: () => false } });
    expect(runLandlockExec(bare, { PATH: "/bin" }, d).code).toBe(LANDLOCK_APPLY_FAILED);
    expect(d.execCalls).toEqual([]);
  });

  test("a kernel that refuses the ruleset exits 125 without executing", () => {
    const d = deps({
      kernel: {
        abiVersion: () => 4,
        createRuleset: () => ({ ok: false, reason: "EINVAL" }),
        addPathRule: () => ({ ok: true }),
        setNoNewPrivs: () => ({ ok: true }),
        restrictSelf: () => ({ ok: true }),
        closeRuleset: () => {},
      },
    });
    expect(runLandlockExec(argv, { PATH: "/bin" }, d).code).toBe(LANDLOCK_APPLY_FAILED);
    expect(d.execCalls).toEqual([]);
  });

  test("an ABI below the ruleset's minimum exits 125 without executing", () => {
    const d = deps({
      kernel: { ...deps().kernel, abiVersion: () => 2 },
    });
    expect(runLandlockExec(argv, { PATH: "/bin" }, d).code).toBe(LANDLOCK_APPLY_FAILED);
    expect(d.execCalls).toEqual([]);
  });

  test("a newer kernel warns, and still runs — refusing would break every future kernel", () => {
    const d = deps({ kernel: { ...deps().kernel, abiVersion: () => NEWEST_KNOWN_ABI + 1 } });
    runLandlockExec(argv, { PATH: "/bin" }, d);
    expect(d.warnings.join(" ")).toContain("unrestricted");
    expect(d.execCalls).toEqual(["/bin/echo"]);
  });

  test("a failed exec is still reported as an apply failure, not as success", () => {
    const d = deps();
    const result = runLandlockExec(argv, { PATH: "/bin" }, d);
    expect(result.code).toBe(LANDLOCK_APPLY_FAILED);
    expect(result.reason).toContain("/bin/echo");
  });
});

// ---------------------------------------------------------------------------
// Live — AC4, AC5, AC6, AC7. Every denial has a control that succeeds without
// the boundary, because an assertion that is green when the command never ran
// proves nothing (the lesson the step-2 spike learned three times).
// ---------------------------------------------------------------------------

const liveAbi = await (async () => {
  if (process.platform !== "linux") return 0;
  try {
    return (await createLibcKernel()).abiVersion();
  } catch {
    return 0;
  }
})();
const liveReason = `kernel Landlock ABI ${liveAbi} < 3; the write boundary cannot be enforced here`;

describe.skipIf(liveAbi < 3)(`live enforcement (Landlock ABI ${liveAbi})`, () => {
  function workspace(): { dir: string; cleanup: () => void } {
    const dir = mkdtempSync(path.join(tmpdir(), "keryx-landlock-"));
    return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  /** Run a command under the launcher; `contained: false` runs it as the control. */
  function run(
    ws: string,
    command: string[],
    { contained = true, cwd = ws }: { contained?: boolean; cwd?: string } = {},
  ) {
    const argv = contained
      ? [process.execPath, LAUNCHER, "--ruleset", JSON.stringify(rulesetFor(ws)), "--", ...command]
      : command;
    const result = Bun.spawnSync(argv, { cwd, env: process.env, stdout: "pipe", stderr: "pipe" });
    return {
      code: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    };
  }

  test("a write inside the workspace succeeds", () => {
    const ws = workspace();
    try {
      const out = path.join(ws.dir, "inside.txt");
      expect(run(ws.dir, ["/bin/sh", "-c", `echo hello > ${out}`]).code).toBe(0);
      expect(existsSync(out)).toBe(true);
    } finally {
      ws.cleanup();
    }
  });

  test("a write outside every writable root is refused, and the control succeeds", () => {
    const ws = workspace();
    const outside = mkdtempSync(path.join(tmpdir(), "keryx-outside-"));
    try {
      const target = path.join(outside, "escaped.txt");
      const contained = run(ws.dir, ["/bin/sh", "-c", `echo nope > ${target}`]);
      expect(contained.code).not.toBe(0);
      expect(existsSync(target)).toBe(false);
      // The control: without the boundary the very same command works, so the
      // assertion above is about Landlock and not about a broken path.
      expect(run(ws.dir, ["/bin/sh", "-c", `echo nope > ${target}`], { contained: false }).code).toBe(0);
      expect(existsSync(target)).toBe(true);
    } finally {
      ws.cleanup();
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("a read under $HOME is refused, and the control succeeds", () => {
    const ws = workspace();
    const home = process.env.HOME as string;
    const secret = path.join(home, ".keryx-landlock-live-fixture");
    try {
      writeFileSync(secret, "s3cret\n");
      const contained = run(ws.dir, ["/bin/sh", "-c", `cat ${secret}`]);
      expect(contained.code).not.toBe(0);
      expect(contained.stdout).not.toContain("s3cret");
      const control = run(ws.dir, ["/bin/sh", "-c", `cat ${secret}`], { contained: false });
      expect(control.code).toBe(0);
      expect(control.stdout).toContain("s3cret");
    } finally {
      rmSync(secret, { force: true });
      ws.cleanup();
    }
  });

  test("the restriction is inherited by a grandchild", () => {
    const ws = workspace();
    const outside = mkdtempSync(path.join(tmpdir(), "keryx-outside-"));
    try {
      const target = path.join(outside, "grandchild.txt");
      const contained = run(ws.dir, ["/bin/sh", "-c", `/bin/sh -c 'echo deep > ${target}'`]);
      expect(contained.code).not.toBe(0);
      expect(existsSync(target)).toBe(false);
      expect(
        run(ws.dir, ["/bin/sh", "-c", `/bin/sh -c 'echo deep > ${target}'`], { contained: false }).code,
      ).toBe(0);
      expect(existsSync(target)).toBe(true);
    } finally {
      ws.cleanup();
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("a planted executable is not run in place of a missing tool (AC5)", () => {
    const ws = workspace();
    try {
      const planted = path.join(ws.dir, "keryxplantedtool");
      writeFileSync(planted, "#!/bin/sh\necho PLANTED RAN\n");
      chmodSync(planted, 0o755);

      const bare = run(ws.dir, ["keryxplantedtool"]);
      expect(bare.code).toBe(LANDLOCK_APPLY_FAILED);
      expect(bare.stdout).not.toContain("PLANTED RAN");
      // The control proves the file really was executable from that cwd, so the
      // refusal above is the resolver's and not the filesystem's.
      const explicit = run(ws.dir, ["./keryxplantedtool"]);
      expect(explicit.code).toBe(0);
      expect(explicit.stdout).toContain("PLANTED RAN");
    } finally {
      ws.cleanup();
    }
  });

  test("an unopenable required rule path exits 125 and the command never runs (AC6)", () => {
    const ws = workspace();
    try {
      const marker = path.join(ws.dir, "ran.txt");
      const broken = rulesetFor(ws.dir);
      const withMissing: LandlockRuleset = {
        ...broken,
        pathRules: [
          { path: "/nonexistent-keryx-root", allow: broken.handledFs, onMissing: "fail" },
          ...broken.pathRules,
        ],
      };
      const failed = Bun.spawnSync(
        [
          process.execPath,
          LAUNCHER,
          "--ruleset",
          JSON.stringify(withMissing),
          "--",
          "/bin/sh",
          "-c",
          `echo ran > ${marker}`,
        ],
        { cwd: ws.dir, env: process.env, stdout: "pipe", stderr: "pipe" },
      );
      expect(failed.exitCode).toBe(LANDLOCK_APPLY_FAILED);
      expect(existsSync(marker)).toBe(false);
      // Positive control: the same command under the same launcher with an
      // applicable ruleset does run, so the absence above is the refusal.
      expect(run(ws.dir, ["/bin/sh", "-c", `echo ran > ${marker}`]).code).toBe(0);
      expect(existsSync(marker)).toBe(true);
    } finally {
      ws.cleanup();
    }
  });

  test("the command's own exit status arrives unmodified (AC7)", () => {
    const ws = workspace();
    try {
      expect(run(ws.dir, ["/bin/sh", "-c", "exit 42"]).code).toBe(42);
    } finally {
      ws.cleanup();
    }
  });

  test("a signalled command is reported as signalled, never as success (AC7)", () => {
    // The spike's warning applies to the *spawn* shape it first used:
    // `Bun.spawnSync` returns `exitCode: null` for a signalled child and
    // `process.exit(null)` exits 0, so a SIGKILLed command reports success
    // unless the caller maps the signal itself.
    //
    // `execve` removes that seam rather than mapping around it — the launcher is
    // gone by the time the command runs, so the wait status is the kernel's. The
    // assertion is therefore that nothing interposes: the signal arrives as a
    // signal, and a POSIX waiter renders it as 128+N without help from us.
    const ws = workspace();
    try {
      const ruleset = JSON.stringify(rulesetFor(ws.dir));
      const direct = Bun.spawnSync(
        [process.execPath, LAUNCHER, "--ruleset", ruleset, "--", "/bin/sh", "-c", "kill -9 $$"],
        { cwd: ws.dir, env: process.env, stdout: "pipe", stderr: "pipe" },
      );
      expect(direct.signalCode).toBe("SIGKILL");
      expect(direct.exitCode).not.toBe(0);

      // …and the 128+N a shell computes from that same status, so the claim is
      // not just about Bun's own reporting shape.
      const viaShell = Bun.spawnSync(
        [
          "/bin/sh",
          "-c",
          `${process.execPath} ${LAUNCHER} --ruleset '${ruleset}' -- /bin/sh -c 'kill -9 $$'; echo $?`,
        ],
        { cwd: ws.dir, env: process.env, stdout: "pipe", stderr: "pipe" },
      );
      expect(viaShell.stdout.toString().trim()).toBe("137");
    } finally {
      ws.cleanup();
    }
  });
});

if (liveAbi < 3) {
  test.skip(`live enforcement skipped: ${liveReason}`, () => {});
}
