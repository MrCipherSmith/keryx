import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import http from "node:http";
import path from "node:path";
import { saveSandboxDefaults } from "../../../lib/sandbox-config";
import {
  type CommandRunner,
  DEFAULT_SHELL_YIELD_MS,
  ENV_SHELL_YIELD_MS,
  extraReadDenyRoots,
  makeCommandRunner,
  resolveShellRestrictedMasks,
  resolveShellSandboxMode,
  resolveShellYieldMs,
  shellExecTool,
} from "./shell-exec-tool";

function recordingRunner(result = { output: "done", isError: false }): {
  run: CommandRunner;
  calls: string[];
  signals: (AbortSignal | undefined)[];
} {
  const calls: string[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  return {
    calls,
    signals,
    run: async (command, options) => {
      calls.push(command);
      signals.push(options?.signal);
      return result;
    },
  };
}

test("F2: extraReadDenyRoots parses KERYX_SANDBOX_READ_DENY and expands ~/", () => {
  expect(extraReadDenyRoots({})).toEqual([]);
  const home = homedir();
  const roots = extraReadDenyRoots({ KERYX_SANDBOX_READ_DENY: "~/.secretcfg, /etc/keys ,, " });
  // `~/` expands to the home dir; empty entries are dropped.
  expect(roots).toContain(path.join(home, ".secretcfg"));
  expect(roots).toContain("/etc/keys");
  expect(roots.length).toBe(2);
});

test("shell_exec is risk shell with a command input schema", () => {
  const { run } = recordingRunner();
  const tool = shellExecTool("/proj", run);
  expect(tool.definition.name).toBe("shell_exec");
  expect(tool.definition.risk).toBe("shell");
  expect(tool.definition.inputSchema.required).toEqual(["command"]);
});

// flow 263: task-supervisor inputs (spec §4.1) and the yield resolver (§3).
test("shell_exec input schema: command, background, description, idle_timeout_ms; no additional properties", () => {
  const { run } = recordingRunner();
  const schema = shellExecTool("/proj", run).definition.inputSchema as {
    properties: Record<string, { type: string }>;
    additionalProperties: unknown;
  };
  expect(Object.keys(schema.properties).sort()).toEqual(["background", "command", "description", "idle_timeout_ms"]);
  expect(schema.properties.command?.type).toBe("string");
  expect(schema.properties.background?.type).toBe("boolean");
  expect(schema.properties.description?.type).toBe("string");
  expect(schema.properties.idle_timeout_ms?.type).toBe("integer");
  expect(schema.additionalProperties).toBe(false);
});

test("resolveShellYieldMs: KERYX_SHELL_YIELD_MS, default 10000, malformed falls back, explicit 0 allowed", () => {
  expect(ENV_SHELL_YIELD_MS).toBe("KERYX_SHELL_YIELD_MS");
  expect(DEFAULT_SHELL_YIELD_MS).toBe(10_000);
  expect(resolveShellYieldMs({})).toBe(10_000);
  expect(resolveShellYieldMs({ KERYX_SHELL_YIELD_MS: "" })).toBe(10_000);
  expect(resolveShellYieldMs({ KERYX_SHELL_YIELD_MS: "nonsense" })).toBe(10_000);
  expect(resolveShellYieldMs({ KERYX_SHELL_YIELD_MS: "-1" })).toBe(10_000);
  expect(resolveShellYieldMs({ KERYX_SHELL_YIELD_MS: "2500" })).toBe(2_500);
  expect(resolveShellYieldMs({ KERYX_SHELL_YIELD_MS: "0" })).toBe(0);
});

test("AC7: without a registry, a long command still goes through the injected synchronous runner unchanged", async () => {
  const { run, calls } = recordingRunner({ output: "sync-only", isError: false });
  const tool = shellExecTool("/proj", run, undefined, { yieldMs: 1 });
  const result = await tool.invoke({ command: "sleep 120 && gh run list --workflow=release.yml" });
  expect(calls).toEqual(["sleep 120 && gh run list --workflow=release.yml"]);
  expect(result).toEqual({ output: "sync-only", isError: false });
});

// Flow 301 F5b: the no-`jobRegistry` shape `trigger-agent-task.ts`/
// `trigger-dispatch.ts` build their unattended roster with (`buildUnattendedRoster`,
// `sandboxedRunner`) is exactly the path a run's `maxSeconds` abort needs to reach.
// Fixed by threading `ctx.signal` through to the runner here — a runner built to
// honour it (`makeCommandRunner`, tested separately below with a real process) kills
// the command's whole process group instead of leaving it orphaned. This test proves
// the WIRING: the exact signal `invoke` received is the one `run` is called with —
// previously it was dropped on the floor (this test used to assert the opposite,
// that an aborted signal changed nothing; reverting the fix turns it back red).
test("F5b: the no-registry branch passes ctx.signal through to the runner unchanged", async () => {
  const { run, calls, signals } = recordingRunner({ output: "done", isError: false });
  const tool = shellExecTool("/proj", run);
  const controller = new AbortController();
  const result = await tool.invoke({ command: "echo hi" }, { signal: controller.signal });
  expect(calls).toEqual(["echo hi"]);
  expect(signals).toEqual([controller.signal]);
  expect(result).toEqual({ output: "done", isError: false });
});

test("F5b: with no ctx at all, the runner is still called (signal simply undefined)", async () => {
  const { run, calls, signals } = recordingRunner();
  const tool = shellExecTool("/proj", run);
  await tool.invoke({ command: "echo hi" });
  expect(calls).toEqual(["echo hi"]);
  expect(signals).toEqual([undefined]);
});

// Flow 301 F5b/F5c: the REAL runner, not a fake — `makeCommandRunner`'s own
// process-GROUP kill on abort (`{ processGroup: true }`, matching how the two
// unattended dispatchers build it — see `sandboxedRunner`/`unattendedRunner`),
// proven without needing bwrap (that full path is covered by the real integration
// test in `../../process/sandbox/unattended.abort-kill.test.ts`). A `sleep 5`
// aborted after ~50ms must resolve almost immediately (well under 5s) with a clear
// "aborted: run time limit" result, not run to completion.
test("F5b/F5c: makeCommandRunner({processGroup:true}) kills an in-flight command on abort, quickly, with a clear result", async () => {
  const run = makeCommandRunner(
    process.cwd(),
    async (command) => ({
      ok: true,
      plan: { spawnArgs: ["/bin/sh", "-c", command], env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" }, netClose: async () => {} },
    }),
    { processGroup: true },
  );
  const controller = new AbortController();
  const start = Date.now();
  setTimeout(() => controller.abort(), 50);
  const result = await run("sleep 5", { signal: controller.signal });
  const elapsedMs = Date.now() - start;
  expect(result.isError).toBe(true);
  expect(result.output).toContain("aborted: run time limit");
  expect(elapsedMs).toBeLessThan(3_000); // nowhere near the full 5s sleep
});

/** `true` iff a process with this pid currently exists (`ps -p`, exit 0 = found). */
function isAlive(pid: number): boolean {
  const out = Bun.spawnSync(["ps", "-p", String(pid)], { stdout: "pipe", stderr: "pipe" });
  return out.exitCode === 0;
}

// Flow 301 (F5c): the discriminating case the abort MESSAGE tests above cannot
// show — `sleep 5` alone execs straight into the shell's own pid (no grandchild),
// so a plain `proc.kill()` looks just as effective as a group kill for it. A
// BACKGROUNDED grandchild (`sleep & wait`, the same shape `unattended.abort-
// kill.test.ts` uses under real bwrap) is the shape that actually needs the
// process-GROUP kill: only `processGroup: true` reaches it. Without bwrap's own
// `--unshare-pid` namespace collapse to fall back on (that integration test
// cannot tell group-kill and direct-kill apart — killing bwrap's own pid, PID 1
// in its namespace, already tears the whole namespace down either way), this is
// the one place group-kill's actual effect is provable.
//
// The grandchild's OWN cmdline never carries a marker (`sleep 5` has no argument
// to smuggle one into), so it is identified by pid, echoed by the shell before it
// backgrounds it and captured from the collected output the runner still returns
// on an aborted run.
test("F5c: only the opt-in (processGroup:true) runner kills a backgrounded grandchild on abort", async () => {
  const run = makeCommandRunner(
    process.cwd(),
    async (command) => ({
      ok: true,
      plan: { spawnArgs: ["/bin/sh", "-c", command], env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" }, netClose: async () => {} },
    }),
    { processGroup: true },
  );
  const controller = new AbortController();
  const resultPromise = run("sleep 5 & echo GRANDCHILD:$!; wait $!", { signal: controller.signal });

  await new Promise((r) => setTimeout(r, 200));
  controller.abort();
  const result = await resultPromise;
  expect(result.isError).toBe(true);
  expect(result.output).toContain("aborted: run time limit");

  const m = /GRANDCHILD:(\d+)/.exec(result.output);
  expect(m).not.toBeNull();
  const grandchildPid = Number(m?.[1]);

  // The group signal reaches sh AND the grandchild together, so by the time
  // `run()` has already resolved the grandchild may well be gone already; a
  // short settle is still worth giving SIGKILL (if TERM was ignored) a moment.
  await new Promise((r) => setTimeout(r, 300));
  expect(isAlive(grandchildPid)).toBe(false);
});

// Flow 301 (F5c): the mirror case — the DEFAULT runner's direct-pid kill reaches
// only the shell it spawned, exactly as before F5b, so a backgrounded grandchild
// OUTLIVES the abort (it is reparented, not killed). This is the precise, provable
// shape of the SIGHUP/orphan regression the review flagged: a caller with no
// terminal to hang the tree up on (the two unattended dispatchers) needs
// `processGroup: true`; a caller that still has one relies on this default NOT
// reaching past the direct child, or a terminal hangup would be swallowed here
// the same way F5b's unconditional `detached: true` swallowed it.
test("F5c: the default runner (no processGroup) does NOT reach a backgrounded grandchild on abort", async () => {
  const run = makeCommandRunner(process.cwd(), async (command) => ({
    ok: true,
    plan: { spawnArgs: ["/bin/sh", "-c", command], env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" }, netClose: async () => {} },
  })); // no processGroup — the default
  const controller = new AbortController();
  const resultPromise = run("sleep 5 & echo GRANDCHILD:$!; wait $!", { signal: controller.signal });

  await new Promise((r) => setTimeout(r, 200));
  controller.abort();
  const result = await resultPromise;
  expect(result.isError).toBe(true);
  expect(result.output).toContain("aborted: run time limit");

  const m = /GRANDCHILD:(\d+)/.exec(result.output);
  expect(m).not.toBeNull();
  const grandchildPid = Number(m?.[1]);

  try {
    await new Promise((r) => setTimeout(r, 2_500));
    expect(isAlive(grandchildPid)).toBe(true); // orphaned, but still running
  } finally {
    // Clean up after ourselves — this is the one process in this test file that
    // the runner does NOT kill by design.
    try {
      process.kill(grandchildPid, "SIGKILL");
    } catch {
      // already gone
    }
  }
});

// Flow 301 F5c: same abort, same wording, but the DEFAULT runner (no
// `processGroup`) — the message must not depend on which kill mechanism fired.
test("F5c: the default runner (no processGroup) still kills a simple in-flight command on abort, with the SAME message", async () => {
  const run = makeCommandRunner(process.cwd(), async (command) => ({
    ok: true,
    plan: { spawnArgs: ["/bin/sh", "-c", command], env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" }, netClose: async () => {} },
  })); // no third argument — the default
  const controller = new AbortController();
  const start = Date.now();
  setTimeout(() => controller.abort(), 50);
  const result = await run("sleep 5", { signal: controller.signal });
  const elapsedMs = Date.now() - start;
  expect(result.isError).toBe(true);
  expect(result.output).toContain("aborted: run time limit");
  expect(elapsedMs).toBeLessThan(3_000);
});

/** One `ps -eo pid,pgid,cmd` row, parsed. */
interface PsRow {
  pid: number;
  pgid: number;
  cmd: string;
}

function psRows(): PsRow[] {
  const out = Bun.spawnSync(["ps", "-eo", "pid,pgid,cmd"], { stdout: "pipe" });
  const text = new TextDecoder().decode(out.stdout);
  const rows: PsRow[] = [];
  for (const line of text.split("\n").slice(1)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m === null) continue;
    rows.push({ pid: Number(m[1]), pgid: Number(m[2]), cmd: m[3] ?? "" });
  }
  return rows;
}

// Flow 301 (F5c, security review): the real regression this flow fixes — F5b made
// `detached: true` UNCONDITIONAL, which orphan-proofed every `makeCommandRunner`
// caller, not only the two unattended dispatchers that need it. `src/acp/
// roster.ts`'s `shellExecTool(root)` (no registry, no `processGroup`) and any other
// interactive, no-registry caller must spawn EXACTLY as before F5b: a plain child
// in the CALLER's own process group, so a terminal hangup (SIGHUP to the foreground
// group) still takes it down. Checked the way the reviewer did: comparing the real
// child's pgid (via `ps`, since Node/Bun expose no `getpgid`) to the caller's own —
// equal means "not detached"; F5b's unconditional `detached: true` would make them
// different (the child becomes its own group leader, `pgid === pid`).
test("F5c: the default runner does NOT put the child in its own process group (pgid matches the caller's, not its own pid)", async () => {
  const marker = `keryx-pgid-check-${randomUUID()}`;
  const run = makeCommandRunner(process.cwd(), async (command) => ({
    ok: true,
    plan: { spawnArgs: ["/bin/sh", "-c", command], env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" }, netClose: async () => {} },
  })); // no processGroup — the default
  const resultPromise = run(`: ${marker}; sleep 2`);
  try {
    await new Promise((r) => setTimeout(r, 300));

    const rows = psRows();
    const parentRow = rows.find((r) => r.pid === process.pid);
    const childRow = rows.find((r) => r.cmd.includes(marker));
    expect(parentRow).toBeDefined();
    expect(childRow).toBeDefined();

    // NOT its own group (that would be F5b's regression: `pgid === pid`) — the
    // SAME group as the process that spawned it.
    expect(childRow!.pgid).not.toBe(childRow!.pid);
    expect(childRow!.pgid).toBe(parentRow!.pgid);
  } finally {
    // Let the command finish (it is short) rather than leaving a dangling process
    // behind for the next test — no abort needed, `sleep 2` is nearly done already.
    await resultPromise;
  }
});

test("shell_exec passes the command through to the runner", async () => {
  const { run, calls } = recordingRunner();
  const tool = shellExecTool("/proj", run);
  const result = await tool.invoke({ command: "git status" });
  expect(calls).toEqual(["git status"]);
  expect(result.isError).toBe(false);
});

test("shell_exec errors on a missing command WITHOUT invoking the runner", async () => {
  const { run, calls } = recordingRunner();
  const tool = shellExecTool("/proj", run);
  const result = await tool.invoke({});
  expect(result.isError).toBe(true);
  expect(calls).toHaveLength(0);
});

test("shell_exec propagates a runner failure", async () => {
  const { run } = recordingRunner({ output: "boom", isError: true });
  const tool = shellExecTool("/proj", run);
  const result = await tool.invoke({ command: "false" });
  expect(result.isError).toBe(true);
  expect(result.output).toBe("boom");
});

describe("C-06 through C-08: timeout cleanup dispositions", () => {
  // Flow 301 (F5b, then F5c): the kill mechanism now has TWO shapes behind one
  // shared `kill`/`killWithGrace`, used for both the per-command deadline and an
  // external abort — same fail-soft-on-already-exited property, one catch site,
  // for either shape:
  //   - opt-in (`processGroup: true`, the two unattended dispatchers): GROUP-wide
  //     (`process.kill(-proc.pid, signal)`), valid because `detached` made the
  //     process its own group leader — one signal reaches every descendant.
  //   - default (every other caller, e.g. `src/acp/roster.ts`): just the one
  //     directly-spawned process (`proc.kill(signal)`), `detached` left off, so a
  //     terminal hangup can still take it down — F5c's fix for the F5b regression.
  // `detached` itself is conditional on `processGroup`, never a bare `true`.
  test("C-06/C-07: an already-exited process makes kill cleanup fail-soft, for both TERM and KILL, in both shapes", () => {
    const source = readFileSync(new URL("./shell-exec-tool.ts", import.meta.url), "utf8");

    // Group-kill shape, reachable only when `processGroup` is true.
    expect(source).toMatch(/if \(processGroup\) process\.kill\(-proc\.pid, signal\);/);
    // Default shape, reachable only when `processGroup` is false.
    expect(source).toMatch(/else proc\.kill\(signal\);/);
    // Both share the one fail-soft catch site.
    expect(source).toMatch(/proc\.kill\(signal\);\s*}\s*catch\s*{\s*\/\/ already gone/s);
    expect(source).toContain('kill("SIGTERM")');
    expect(source).toContain('kill("SIGKILL")');
    // `detached` is conditional on the opt-in, never an unconditional literal.
    expect(source).toContain("detached: processGroup,");
    expect(source).not.toMatch(/detached:\s*true\s*[,}]/);
    expect(source).toContain("shell_exec: timed out after ${timeoutMs}ms and was killed");
  });

  test("C-08: a torn-down output reader preserves already-collected bytes", () => {
    const source = readFileSync(new URL("./shell-exec-tool.ts", import.meta.url), "utf8");

    expect(source).toMatch(/sink\.text \+= decoder\.decode\(chunk\.value, \{ stream: true \}\)/);
    expect(source).toMatch(/catch\s*{\s*\/\/ stream torn down by the kill — keep what we have/s);
    expect(source).toMatch(/Promise\.race\(\[drained, new Promise\(\(r\) => setTimeout\(r, 200\)\)\]\)/);
  });
});

describe("resolveShellSandboxMode", () => {
  test("default off; workspace/strict opt-in; danger forces off", () => {
    // Isolate from the developer's real sandbox.json
    const emptyDir = mkdtempSync(path.join(tmpdir(), "keryx-sbx-empty-"));
    expect(resolveShellSandboxMode({}, emptyDir)).toBe("off");
    expect(resolveShellSandboxMode({ KERYX_SANDBOX_SHELL: "workspace" }, emptyDir)).toBe("workspace");
    expect(resolveShellSandboxMode({ KERYX_SANDBOX_SHELL: "1" }, emptyDir)).toBe("workspace");
    expect(resolveShellSandboxMode({ KERYX_SANDBOX_SHELL: "strict" }, emptyDir)).toBe("strict");
    expect(resolveShellSandboxMode({ KERYX_SANDBOX_SHELL: "off" }, emptyDir)).toBe("off");
    expect(
      resolveShellSandboxMode(
        { KERYX_SANDBOX_SHELL: "strict", KERYX_DANGEROUSLY_DISABLE_SANDBOX: "1" },
        emptyDir,
      ),
    ).toBe("off");
  });

  test("P1: sandbox.json shell used when env unset; env wins", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "keryx-sbx-shell-"));
    saveSandboxDefaults({ shell: "workspace" }, dir);
    expect(resolveShellSandboxMode({}, dir)).toBe("workspace");
    expect(resolveShellSandboxMode({ KERYX_SANDBOX_SHELL: "strict" }, dir)).toBe("strict");
  });
});

const FIXTURE_KEY = "sk-test-fixture-not-real";

describe("resolveShellRestrictedMasks (AC7)", () => {
  test("P0.b default auto: key present without MASK_ENV → masks + auto TLS", () => {
    // Empty config dir so developer sandbox.json cannot affect unit test.
    const emptyDir = mkdtempSync(path.join(tmpdir(), "keryx-shell-p0b-"));
    const r = resolveShellRestrictedMasks({ DEEPSEEK_API_KEY: FIXTURE_KEY }, emptyDir);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.masks).toEqual([
      {
        name: "DEEPSEEK_API_KEY",
        realValue: FIXTURE_KEY,
        injectHosts: ["api.deepseek.com"],
      },
    ]);
    expect(r.tlsTerminate).toBe(true);
  });

  test("explicit manual: key present without MASK_ENV → no masks", () => {
    const emptyDir = mkdtempSync(path.join(tmpdir(), "keryx-shell-man-"));
    const r = resolveShellRestrictedMasks(
      { KERYX_SANDBOX_MASK_MODE: "manual", DEEPSEEK_API_KEY: FIXTURE_KEY },
      emptyDir,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.masks).toEqual([]);
    expect(r.tlsTerminate).toBe(false);
  });

  test("auto mode derives deepseek mask and auto TLS", () => {
    const emptyDir = mkdtempSync(path.join(tmpdir(), "keryx-shell-auto-"));
    const r = resolveShellRestrictedMasks(
      {
        KERYX_SANDBOX_MASK_MODE: "auto",
        DEEPSEEK_API_KEY: FIXTURE_KEY,
      },
      emptyDir,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.masks).toEqual([
      {
        name: "DEEPSEEK_API_KEY",
        realValue: FIXTURE_KEY,
        injectHosts: ["api.deepseek.com"],
      },
    ]);
    expect(r.tlsTerminate).toBe(true);
  });

  test("manual MASK_ENV without TLS fails closed", () => {
    const emptyDir = mkdtempSync(path.join(tmpdir(), "keryx-shell-tls-"));
    const r = resolveShellRestrictedMasks(
      {
        KERYX_SANDBOX_MASK_MODE: "manual",
        KERYX_SANDBOX_MASK_ENV: "DEEPSEEK_API_KEY@api.deepseek.com",
        DEEPSEEK_API_KEY: FIXTURE_KEY,
      },
      emptyDir,
    );
    expect(r.ok).toBe(false);
  });

  test("manual MASK_ENV with TLS=1 wires masks", () => {
    const emptyDir = mkdtempSync(path.join(tmpdir(), "keryx-shell-tls1-"));
    const r = resolveShellRestrictedMasks(
      {
        KERYX_SANDBOX_MASK_MODE: "manual",
        KERYX_SANDBOX_MASK_ENV: "DEEPSEEK_API_KEY@api.deepseek.com",
        KERYX_SANDBOX_TLS_TERMINATE: "1",
        DEEPSEEK_API_KEY: FIXTURE_KEY,
      },
      emptyDir,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.masks[0]?.name).toBe("DEEPSEEK_API_KEY");
    expect(r.tlsTerminate).toBe(true);
  });

  test("invalid MASK_ENV fails closed", () => {
    const emptyDir = mkdtempSync(path.join(tmpdir(), "keryx-shell-bad-"));
    const r = resolveShellRestrictedMasks(
      {
        KERYX_SANDBOX_MASK_ENV: "NOHOST",
        KERYX_SANDBOX_TLS_TERMINATE: "1",
      },
      emptyDir,
    );
    expect(r.ok).toBe(false);
  });
});

// Live FS-containment smoke — gated on KERYX_ALLOW_REAL_SUBPROCESS=1 + macOS.
const liveFlag = process.env.KERYX_ALLOW_REAL_SUBPROCESS === "1" && process.platform === "darwin";
describe.skipIf(!liveFlag)("makeCommandRunner OS sandbox (macOS live)", () => {
  test("strict mode: write inside workspace succeeds, write outside is denied", async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "keryx-shell-sbx-")));
    const outside = path.join(homedir(), `keryx_shell_FORBIDDEN_${process.pid}.txt`);
    const prev = process.env.KERYX_SANDBOX_SHELL;
    process.env.KERYX_SANDBOX_SHELL = "strict";
    try {
      const run = makeCommandRunner(root);
      await run("echo ok > ./inside.txt");
      expect(existsSync(path.join(root, "inside.txt"))).toBe(true);

      await run(`echo bad > ${outside}`);
      expect(existsSync(outside)).toBe(false); // sandbox denied the outside write
    } finally {
      if (prev === undefined) delete process.env.KERYX_SANDBOX_SHELL;
      else process.env.KERYX_SANDBOX_SHELL = prev;
      if (existsSync(outside)) rmSync(outside);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("restricted network: allowlisted host reachable via proxy, others blocked", async () => {
    const upstream = http.createServer((_q, r) => {
      r.writeHead(200);
      r.end("OK-UP");
    });
    const upPort: number = await new Promise((res) =>
      upstream.listen(0, "127.0.0.1", () => res((upstream.address() as { port: number }).port)),
    );
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "keryx-shell-net-")));
    const prevMode = process.env.KERYX_SANDBOX_SHELL;
    const prevDomains = process.env.KERYX_SANDBOX_ALLOWED_DOMAINS;
    process.env.KERYX_SANDBOX_SHELL = "strict";
    process.env.KERYX_SANDBOX_ALLOWED_DOMAINS = "localhost";
    try {
      const run = makeCommandRunner(root);
      await run(`/usr/bin/curl -sS -m 5 -o ./allowed.txt http://localhost:${upPort}/`);
      expect(readFileSync(path.join(root, "allowed.txt"), "utf8")).toContain("OK-UP");

      await run("/usr/bin/curl -sS -m 5 -o ./blocked.txt http://blocked.invalid/");
      expect(readFileSync(path.join(root, "blocked.txt"), "utf8")).toContain(
        "blocked by keryx sandbox network allowlist",
      );
    } finally {
      if (prevMode === undefined) delete process.env.KERYX_SANDBOX_SHELL;
      else process.env.KERYX_SANDBOX_SHELL = prevMode;
      if (prevDomains === undefined) delete process.env.KERYX_SANDBOX_ALLOWED_DOMAINS;
      else process.env.KERYX_SANDBOX_ALLOWED_DOMAINS = prevDomains;
      await new Promise<void>((r) => upstream.close(() => r()));
      rmSync(root, { recursive: true, force: true });
    }
  });
});
