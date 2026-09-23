import { describe, expect, test } from "bun:test";
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

// Flow 301 F5b: the REAL runner, not a fake — `makeCommandRunner`'s own process-group
// kill on abort, proven without needing bwrap (that full path is covered by the real
// integration test in `../../process/sandbox/unattended.abort-kill.test.ts`). A
// `sleep 5` aborted after ~50ms must resolve almost immediately (well under 5s) with
// a clear "aborted: run time limit" result, not run to completion.
test("F5b: makeCommandRunner kills an in-flight command on abort, quickly, with a clear result", async () => {
  const run = makeCommandRunner(process.cwd(), async (command) => ({
    ok: true,
    plan: { spawnArgs: ["/bin/sh", "-c", command], env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" }, netClose: async () => {} },
  }));
  const controller = new AbortController();
  const start = Date.now();
  setTimeout(() => controller.abort(), 50);
  const result = await run("sleep 5", { signal: controller.signal });
  const elapsedMs = Date.now() - start;
  expect(result.isError).toBe(true);
  expect(result.output).toContain("aborted: run time limit");
  expect(elapsedMs).toBeLessThan(3_000); // nowhere near the full 5s sleep
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
  // Flow 301 (F5b): the kill is now GROUP-wide (`process.kill(-proc.pid, signal)`,
  // valid because the process is spawned `detached` — its own process-group leader —
  // so one signal reaches every descendant, not only the directly-spawned process),
  // through one shared `killGroup` used for both the per-command deadline and an
  // external abort. Same fail-soft-on-already-exited property, one catch site.
  test("C-06/C-07: an already-exited process makes group-kill cleanup fail-soft, for both TERM and KILL", () => {
    const source = readFileSync(new URL("./shell-exec-tool.ts", import.meta.url), "utf8");

    expect(source).toMatch(/process\.kill\(-proc\.pid, signal\);\s*}\s*catch\s*{\s*\/\/ already gone/s);
    expect(source).toContain('killGroup("SIGTERM")');
    expect(source).toContain('killGroup("SIGKILL")');
    expect(source).toContain("detached: true");
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
