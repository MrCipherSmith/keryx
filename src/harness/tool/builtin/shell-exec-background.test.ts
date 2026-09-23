// Failing test stubs (RED phase, flow 173 / T2-T3), AC1: `shell_exec({command,
// background:true})` must return WITHOUT waiting for the process to exit,
// and `DEFAULT_SHELL_TIMEOUT_MS` must never fire on it. The intended design
// (see this flow's journal.md): the background branch bypasses
// `makeCommandRunner`'s synchronous run()+deadline machinery ENTIRELY,
// delegating instead to a new sibling `JobRegistry`
// (`./background-job-registry.ts`).
//
// Proven here with an injectable fake `CommandRunner` (must NEVER be called
// when a registry is present — proves the sync deadline path is skipped, not
// merely raced) and a fake `BackgroundSpawner` (no real subprocess needed),
// mirroring `shell-exec-tool.test.ts`'s existing `recordingRunner()` pattern.
// AC3's real-subprocess process-group-kill test lives in
// `./background-job-registry.test.ts`.
//
// flow 263 (P0, RED): with a registry EVERY `shell_exec` is a supervised task.
// Without `background:true` it starts in the foreground phase and waits up to
// `yieldMs`; an exit within the yield returns the synchronous-shaped result,
// otherwise the task is promoted and a `{task_id, job_id, pid, status, output,
// notice, over_cap?}` handle is returned. See the flow-263 blocks below.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DEFAULT_SHELL_TIMEOUT_MS,
  ENV_SHELL_TIMEOUT_MS,
  shellExecTool,
} from "./shell-exec-tool";
import type { CommandRunner } from "./shell-exec-tool";
import {
  createJobRegistry,
  MAX_TASK_IDLE_TIMEOUT_MS,
  MIN_TASK_IDLE_TIMEOUT_MS,
  shellJobKillTool,
  shellJobOutputTool,
} from "./background-job-registry";
import type { BackgroundProcessHandle, BackgroundSpawner } from "./background-job-registry";

const TASK_ID_RE = /^task-[0-9]+-[0-9]+$/;

type TaskHandleJson = {
  task_id?: string;
  job_id?: string;
  pid?: number;
  status?: string;
  output?: string;
  notice?: string;
  over_cap?: string;
};

/** A fake background process that never exits on its own — the test controls its lifetime. */
function neverExitingSpawner(pid = 4242): { spawn: BackgroundSpawner } {
  const spawn: BackgroundSpawner = (): BackgroundProcessHandle => ({
    pid,
    onOutput: () => {},
    onExit: () => {}, // deliberately never invoked
    kill: () => {},
  });
  return { spawn };
}

let nextScriptedPid = 7000;

type Script =
  | { kind: "hang"; stdout?: string }
  | { kind: "exit"; stdout?: string; stderr?: string; exitCode: number; afterMs?: number };

/**
 * flow 263: a fake spawner whose per-command behaviour is scripted. `hang`
 * never exits on its own; `exit` emits its output then exits after `afterMs`.
 * Every fake honours a kill by exiting (143), like a real process, so a kill
 * reaches a terminal status without the test driving it.
 */
function scriptedSpawner(route: (command: string) => Script): {
  spawn: BackgroundSpawner;
  kills: Map<number, Array<"SIGTERM" | "SIGKILL">>;
  emitData: Map<number, (chunk: string) => void>;
} {
  const kills = new Map<number, Array<"SIGTERM" | "SIGKILL">>();
  const emitData = new Map<number, (chunk: string) => void>();
  const spawn: BackgroundSpawner = (command): BackgroundProcessHandle => {
    const pid = nextScriptedPid++;
    const script = route(command);
    let dataCb: ((chunk: string, stream: "stdout" | "stderr") => void) | undefined;
    let exitCb: ((info: { exitCode: number }) => void) | undefined;
    let exited = false;
    const exit = (exitCode: number): void => {
      if (exited) return;
      exited = true;
      exitCb?.({ exitCode });
    };
    const signals: Array<"SIGTERM" | "SIGKILL"> = [];
    kills.set(pid, signals);
    emitData.set(pid, (chunk) => dataCb?.(chunk, "stdout"));
    // Scheduled (not synchronous) so both callbacks are registered first,
    // whatever order the registry registers them in.
    setTimeout(() => {
      if (script.stdout !== undefined) dataCb?.(script.stdout, "stdout");
      if (script.kind === "exit") {
        if (script.stderr !== undefined) dataCb?.(script.stderr, "stderr");
        setTimeout(() => exit(script.exitCode), script.afterMs ?? 0);
      }
    }, 5);
    return {
      pid,
      onOutput: (cb) => {
        dataCb = cb;
      },
      onExit: (cb) => {
        exitCb = cb;
      },
      kill: (signal) => {
        signals.push(signal);
        exit(143);
      },
    };
  };
  return { spawn, kills, emitData };
}

const unusedRun: CommandRunner = async () => {
  throw new Error("the synchronous runner must not be used when a task registry is present");
};

test("AC1: shell_exec({command, background:true}) resolves without waiting for exit and carries a job_id", async () => {
  let syncRunnerCalled = false;
  const syncRun: CommandRunner = async () => {
    syncRunnerCalled = true;
    return { output: "should never run", isError: false };
  };
  const { spawn } = neverExitingSpawner();
  const registry = createJobRegistry({ spawn, initialBufferMs: 0 });
  const tool = shellExecTool("/proj", syncRun, registry);

  const started = performance.now();
  const result = await tool.invoke({ command: "sleep 999", background: true });
  const elapsed = performance.now() - started;

  expect(syncRunnerCalled).toBe(false); // background path never touches the synchronous runner
  expect(result.isError).toBe(false);
  expect(elapsed).toBeLessThan(2_000); // nowhere near the command's own (simulated) runtime

  const parsed = JSON.parse(result.output) as TaskHandleJson;
  expect(typeof parsed.job_id).toBe("string");
  expect((parsed.job_id ?? "").length).toBeGreaterThan(0);
  expect(parsed.pid).toBe(4242);
  // flow 263: `task_id` is the primary key; `job_id` is kept as an alias.
  expect(parsed.task_id).toMatch(TASK_ID_RE);
  expect(parsed.job_id).toBe(parsed.task_id);
});

test("AC1: DEFAULT_SHELL_TIMEOUT_MS does not fire on a background command even when it outlives 120s", async () => {
  expect(DEFAULT_SHELL_TIMEOUT_MS).toBeGreaterThan(0); // sanity: the deadline this AC must NOT apply to
  const prevTimeout = process.env[ENV_SHELL_TIMEOUT_MS];
  // Shrink the deadline so this test would fail FAST (not after a real
  // 120s wait) if the background branch incorrectly ran through the
  // synchronous timeout path.
  process.env[ENV_SHELL_TIMEOUT_MS] = "50";
  try {
    const { spawn } = neverExitingSpawner();
    const registry = createJobRegistry({ spawn, initialBufferMs: 0 });
    const tool = shellExecTool("/proj", async () => ({ output: "unused", isError: false }), registry);

    // Outlives the shrunk 50ms deadline by a wide margin without the test
    // itself waiting anywhere near the real 120s default.
    await new Promise<void>((resolve) => setTimeout(resolve, 300));
    const result = await tool.invoke({ command: "sleep 999", background: true });

    expect(result.isError).toBe(false);
    expect(result.output).not.toMatch(/timed out/i);
  } finally {
    if (prevTimeout === undefined) delete process.env[ENV_SHELL_TIMEOUT_MS];
    else process.env[ENV_SHELL_TIMEOUT_MS] = prevTimeout;
  }
});

test("AC5 (surfaced through shell_exec): starting a background job beyond the concurrency cap is a tool error, not a hang", async () => {
  const { spawn } = neverExitingSpawner();
  const registry = createJobRegistry({ spawn, initialBufferMs: 0, maxConcurrent: 1 });
  const tool = shellExecTool("/proj", async () => ({ output: "unused", isError: false }), registry);

  const first = await tool.invoke({ command: "sleep 999", background: true });
  expect(first.isError).toBe(false);

  const second = await tool.invoke({ command: "sleep 999", background: true });
  expect(second.isError).toBe(true);
  expect(second.output).toMatch(/sleep 999/); // names the currently running job, per AC5
});

test("shell_exec without background:true is completely unaffected — still synchronous, still uses the injected runner", async () => {
  let syncRunnerCalled = false;
  const syncRun: CommandRunner = async () => {
    syncRunnerCalled = true;
    return { output: "sync result", isError: false };
  };
  const tool = shellExecTool("/proj", syncRun);
  const result = await tool.invoke({ command: "echo hi" });
  expect(syncRunnerCalled).toBe(true);
  expect(result.output).toBe("sync result");
});

test("shell_exec background:false behaves exactly like an absent background field (synchronous)", async () => {
  let syncRunnerCalled = false;
  const syncRun: CommandRunner = async () => {
    syncRunnerCalled = true;
    return { output: "sync result", isError: false };
  };
  const tool = shellExecTool("/proj", syncRun);
  const result = await tool.invoke({ command: "echo hi", background: false });
  expect(syncRunnerCalled).toBe(true);
  expect(result.output).toBe("sync result");
});

// Flow 301 (F5b, security review): WITH a registry, an abort must still only end the
// WAIT, never the task — flow 266 (D-15, AC7)'s rule, untouched by F5b's fix (that
// fix lives entirely in the `jobRegistry === undefined` branch this suite's own
// header calls out — "must NEVER be called when a registry is present"). Confirms
// no regression rather than a new behaviour: this exact shape (an abort racing
// `jobRegistry.waitForExit`, promoting rather than killing) already existed and is
// provably unchanged by this file's line-for-line-identical source.
test("F5b regression guard: WITH a registry, an abort promotes the task (still running) instead of killing it — the synchronous runner is still never touched", async () => {
  let syncRunnerCalled = false;
  const syncRun: CommandRunner = async () => {
    syncRunnerCalled = true;
    return { output: "should never run", isError: false };
  };
  const { spawn, kills } = scriptedSpawner(() => ({ kind: "hang" }));
  const registry = createJobRegistry({ spawn, initialBufferMs: 0 });
  const tool = shellExecTool("/proj", syncRun, registry, { yieldMs: 5_000 }); // long yield the abort must cut short

  const controller = new AbortController();
  const invokePromise = tool.invoke({ command: "sleep 999" }, { signal: controller.signal });
  await new Promise((r) => setTimeout(r, 20));
  const started = performance.now();
  controller.abort();
  const result = await invokePromise;
  const elapsed = performance.now() - started;

  expect(syncRunnerCalled).toBe(false); // the registry branch never falls through to it
  expect(elapsed).toBeLessThan(1_000); // the abort ended the wait — nowhere near the 5s yieldMs
  expect(result.isError).toBe(false); // NOT an error — the task is still running, not failed
  const parsed = JSON.parse(result.output) as TaskHandleJson;
  expect(parsed.status).toBe("running");
  expect(parsed.notice).toContain("STILL RUNNING");
  expect(parsed.notice).toContain("it was not killed");
  // The fake spawner's `kill` was never invoked for any pid — the process was
  // promoted, not stopped (`scriptedSpawner` registers an empty signal list per
  // pid at spawn time, so the check is "no signals recorded", not "no entry").
  expect([...kills.values()].every((signals) => signals.length === 0)).toBe(true);
});

// ===========================================================================
// flow 263 — every shell_exec is a supervised task (RED)
// ===========================================================================

describe("flow 263 AC1: the release-watch incident — a long foreground command yields a task handle", () => {
  test("`sleep 120 && gh run list …` returns a task handle well under 2 s, readable and killable (killReason model)", async () => {
    const { spawn, emitData } = scriptedSpawner(() => ({ kind: "hang" }));
    const registry = createJobRegistry({ spawn, initialBufferMs: 0, killGraceMs: 200 });
    const tool = shellExecTool("/proj", unusedRun, registry, { yieldMs: 50 });

    const t0 = performance.now();
    const result = await tool.invoke({ command: "sleep 120 && gh run list --workflow=release.yml" });
    const elapsed = performance.now() - t0;

    expect(elapsed).toBeLessThan(2_000);
    expect(result.isError).toBe(false);
    const handle = JSON.parse(result.output) as TaskHandleJson;
    expect(handle.task_id).toMatch(TASK_ID_RE);
    expect(handle.job_id).toBe(handle.task_id);
    expect(typeof handle.pid).toBe("number");
    expect(handle.status).toBe("running");
    expect(typeof handle.output).toBe("string");
    expect(typeof handle.notice).toBe("string");
    expect((handle.notice ?? "").length).toBeGreaterThan(0);
    expect(handle.over_cap).toBeUndefined();

    const taskId = handle.task_id as string;
    expect(registry.get(taskId)).toMatchObject({ status: "running", phase: "background" });

    emitData.get(handle.pid as number)?.("run 42 queued\n");
    const read = await shellJobOutputTool(registry).invoke({ job_id: taskId });
    expect(read.isError).toBe(false);
    expect(read.output).toContain("run 42 queued");

    const killed = await shellJobKillTool(registry).invoke({ job_id: taskId });
    expect(killed.isError).toBe(false);
    expect(registry.get(taskId)).toMatchObject({ status: "killed", killReason: "model" });
  });

  test("output produced before the yield is carried in the handle", async () => {
    const { spawn } = scriptedSpawner(() => ({ kind: "hang", stdout: "waiting for CI…\n" }));
    const registry = createJobRegistry({ spawn, initialBufferMs: 0, killGraceMs: 200 });
    const tool = shellExecTool("/proj", unusedRun, registry, { yieldMs: 150 });

    const result = await tool.invoke({ command: "gh run watch" });
    const handle = JSON.parse(result.output) as TaskHandleJson;
    expect(handle.task_id).toMatch(TASK_ID_RE);
    expect(handle.output).toContain("waiting for CI");
    await registry.sweepAll();
  });

  test("description and a clamped idle_timeout_ms reach the task; a foreground call starts in the foreground phase", async () => {
    const { spawn } = scriptedSpawner(() => ({ kind: "hang" }));
    const registry = createJobRegistry({ spawn, initialBufferMs: 0, killGraceMs: 200 });
    const tool = shellExecTool("/proj", unusedRun, registry, { yieldMs: 30 });

    const low = JSON.parse(
      (await tool.invoke({ command: "sleep 60", description: "wait for deploy", idle_timeout_ms: 5 })).output,
    ) as TaskHandleJson;
    expect(registry.get(low.task_id as string)).toMatchObject({
      description: "wait for deploy",
      idleTimeoutMs: MIN_TASK_IDLE_TIMEOUT_MS,
    });

    const high = JSON.parse(
      (await tool.invoke({ command: "sleep 61", idle_timeout_ms: 99_999_999 })).output,
    ) as TaskHandleJson;
    expect(registry.get(high.task_id as string)?.idleTimeoutMs).toBe(MAX_TASK_IDLE_TIMEOUT_MS);

    await registry.sweepAll();
  });

  test("background:true starts a background-phase task and returns the same handle keys", async () => {
    const { spawn } = scriptedSpawner(() => ({ kind: "hang" }));
    const registry = createJobRegistry({ spawn, initialBufferMs: 0, killGraceMs: 200 });
    const tool = shellExecTool("/proj", unusedRun, registry, { yieldMs: 5_000 });

    const t0 = performance.now();
    const result = await tool.invoke({ command: "npm run dev", background: true, description: "dev server" });
    expect(performance.now() - t0).toBeLessThan(2_000); // does not wait the yield
    expect(result.isError).toBe(false);
    const handle = JSON.parse(result.output) as TaskHandleJson;
    expect(handle.task_id).toMatch(TASK_ID_RE);
    expect(handle.job_id).toBe(handle.task_id);
    expect(registry.get(handle.task_id as string)).toMatchObject({ phase: "background", description: "dev server" });
    await registry.sweepAll();
  });
});

describe("flow 263 AC2: a command that exits within the yield returns the synchronous-shaped result", () => {
  test("trimmed combined output, no task handle, isError false for exit 0", async () => {
    const { spawn } = scriptedSpawner(() => ({ kind: "exit", stdout: "  hello from git\n\n", exitCode: 0 }));
    const registry = createJobRegistry({ spawn, initialBufferMs: 0 });
    const tool = shellExecTool("/proj", unusedRun, registry, { yieldMs: 5_000 });

    const t0 = performance.now();
    const result = await tool.invoke({ command: "git status" });
    expect(performance.now() - t0).toBeLessThan(2_000); // returned on exit, not at the yield

    expect(result.isError).toBe(false);
    expect(result.output).toBe("hello from git");
    expect(result.output).not.toContain("task_id");
  });

  test("stderr is included in the combined output", async () => {
    const { spawn } = scriptedSpawner(() => ({ kind: "exit", stdout: "out-line\n", stderr: "err-line\n", exitCode: 0 }));
    const registry = createJobRegistry({ spawn, initialBufferMs: 0 });
    const tool = shellExecTool("/proj", unusedRun, registry, { yieldMs: 5_000 });
    const result = await tool.invoke({ command: "build" });
    expect(result.output).toContain("out-line");
    expect(result.output).toContain("err-line");
  });

  test("empty output renders as `(no output; exit 0)`", async () => {
    const { spawn } = scriptedSpawner(() => ({ kind: "exit", exitCode: 0 }));
    const registry = createJobRegistry({ spawn, initialBufferMs: 0 });
    const tool = shellExecTool("/proj", unusedRun, registry, { yieldMs: 5_000 });
    const result = await tool.invoke({ command: "true" });
    expect(result).toEqual({ output: "(no output; exit 0)", isError: false });
  });

  test("a non-zero exit is isError true, with the exit code when there is no output", async () => {
    const { spawn } = scriptedSpawner(() => ({ kind: "exit", exitCode: 3 }));
    const registry = createJobRegistry({ spawn, initialBufferMs: 0 });
    const tool = shellExecTool("/proj", unusedRun, registry, { yieldMs: 5_000 });
    const result = await tool.invoke({ command: "exit 3" });
    expect(result.isError).toBe(true);
    expect(result.output).toBe("(no output; exit 3)");
  });

  test("output over 20 000 bytes is capped from the start and marked truncated", async () => {
    const big = `HEAD${"x".repeat(30_000)}TAIL`;
    const { spawn } = scriptedSpawner(() => ({ kind: "exit", stdout: big, exitCode: 0 }));
    const registry = createJobRegistry({ spawn, initialBufferMs: 0 });
    const tool = shellExecTool("/proj", unusedRun, registry, { yieldMs: 5_000 });
    const result = await tool.invoke({ command: "cat big.log" });
    expect(result.isError).toBe(false);
    expect(result.output.startsWith("HEAD")).toBe(true);
    expect(result.output).not.toContain("TAIL");
    expect(result.output.endsWith("\n…(truncated)")).toBe(true);
    expect(result.output.length).toBe(20_000 + "\n…(truncated)".length);
  });
});

describe("flow 263 AC5: the cap counts background-phase tasks only (through shell_exec)", () => {
  function route(command: string): Script {
    return command.startsWith("fast") ? { kind: "exit", stdout: "fast done\n", exitCode: 0 } : { kind: "hang" };
  }

  test("with the cap full, a foreground shell_exec still starts and returns its result", async () => {
    const { spawn } = scriptedSpawner(route);
    const registry = createJobRegistry({ spawn, initialBufferMs: 0, maxConcurrent: 1, killGraceMs: 200 });
    const tool = shellExecTool("/proj", unusedRun, registry, { yieldMs: 5_000 });

    expect((await tool.invoke({ command: "npm run dev", background: true })).isError).toBe(false);
    const fast = await tool.invoke({ command: "fast git status" });
    expect(fast).toEqual({ output: "fast done", isError: false });
    await registry.sweepAll();
  });

  test("with the cap full, background:true is refused naming the running command", async () => {
    const { spawn } = scriptedSpawner(route);
    const registry = createJobRegistry({ spawn, initialBufferMs: 0, maxConcurrent: 1, killGraceMs: 200 });
    const tool = shellExecTool("/proj", unusedRun, registry, { yieldMs: 5_000 });

    expect((await tool.invoke({ command: "npm run dev", background: true })).isError).toBe(false);
    const refused = await tool.invoke({ command: "tail -f app.log", background: true });
    expect(refused.isError).toBe(true);
    expect(refused.output).toContain("npm run dev");
    await registry.sweepAll();
  });

  test("a foreground task outliving its yield with the cap full is promoted, not killed; the handle reports over_cap", async () => {
    const { spawn, kills } = scriptedSpawner(route);
    const registry = createJobRegistry({ spawn, initialBufferMs: 0, maxConcurrent: 1, killGraceMs: 200 });
    const tool = shellExecTool("/proj", unusedRun, registry, { yieldMs: 50 });

    expect((await tool.invoke({ command: "npm run dev", background: true })).isError).toBe(false);
    const result = await tool.invoke({ command: "bun test --watch" });
    expect(result.isError).toBe(false);
    const handle = JSON.parse(result.output) as TaskHandleJson;
    expect(handle.task_id).toMatch(TASK_ID_RE);
    expect(typeof handle.over_cap).toBe("string");
    expect(handle.over_cap).toContain("npm run dev");
    expect(kills.get(handle.pid as number)).toEqual([]);
    expect(registry.get(handle.task_id as string)).toMatchObject({ status: "running", phase: "background" });

    // Hard bound: running tasks never exceed maxConcurrent + 1.
    await tool.invoke({ command: "another server", background: true });
    expect(registry.list().filter((t) => t.status === "running").length).toBeLessThanOrEqual(2);
    await registry.sweepAll();
  });
});

describe("flow 263: idle kill and lost-task results (fakes, every platform)", () => {
  test("an idle kill inside the yield returns isError and names both escapes", async () => {
    // The REAL-process sibling below skips on win32, which would leave this
    // user-facing message with zero coverage there. A scripted fake proves the
    // same wording without a subprocess.
    const { spawn } = scriptedSpawner(() => ({ kind: "hang" }));
    const registry = createJobRegistry({ spawn, initialBufferMs: 0, killGraceMs: 50, idleMs: 60 });
    const tool = shellExecTool("/proj", unusedRun, registry, { yieldMs: 5_000 });

    const result = await tool.invoke({ command: "sleep 30" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("KERYX_SHELL_IDLE_MS"); // the operator's knob
    expect(result.output).toContain("idle_timeout_ms"); // the model's own escape
    expect(result.output).not.toContain("task_id"); // it ended; there is nothing to come back to
  });

  test("a task that vanishes before its status can be read reports unknown, never success", async () => {
    // The entry can be LRU-evicted between start and the post-wait read. That
    // branch must not fall through to "exit 0".
    const { spawn } = scriptedSpawner(() => ({ kind: "exit", stdout: "partial\n", exitCode: 0 }));
    const real = createJobRegistry({ spawn, initialBufferMs: 0 });
    const vanishing = { ...real, get: () => undefined };
    const tool = shellExecTool("/proj", unusedRun, vanishing, { yieldMs: 5_000 });

    const result = await tool.invoke({ command: "echo partial" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("no longer tracked");
    expect(result.output).toContain("partial"); // what it did produce is still reported
  });
});

describe.skipIf(process.platform === "win32")("flow 263 AC3: idle kill through shell_exec (REAL process)", () => {
  test(
    "a silent `sleep 30` with a yield longer than the idle timeout returns isError naming KERYX_SHELL_IDLE_MS",
    async () => {
      const cwd = tmpdir();
      const registry = createJobRegistry({ cwd, idleMs: 400, initialBufferMs: 0, killGraceMs: 500 });
      const tool = shellExecTool(cwd, unusedRun, registry, { yieldMs: 8_000 });
      try {
        const t0 = performance.now();
        const result = await tool.invoke({ command: "sleep 30" });
        expect(performance.now() - t0).toBeLessThan(7_000);
        expect(result.isError).toBe(true);
        expect(result.output).toContain("KERYX_SHELL_IDLE_MS");
        expect(result.output).not.toContain("task_id");
      } finally {
        await registry.sweepAll();
      }
    },
    30_000,
  );
});

describe.skipIf(process.platform === "win32")("flow 263 AC6: killing a shell_exec task kills its backgrounded grandchild", () => {
  test(
    "`sleep 300 &` grandchild is gone after shell_job_kill (process-group kill)",
    async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "keryx-ac6-"));
      const pidFile = path.join(dir, "grandchild.pid");
      const registry = createJobRegistry({ cwd: dir, initialBufferMs: 0, killGraceMs: 300, idleMs: 0 });
      const tool = shellExecTool(dir, unusedRun, registry, { yieldMs: 300 });
      let grandchildPid: number | undefined;
      try {
        const result = await tool.invoke({ command: `sleep 300 & echo $! > '${pidFile}'; wait` });
        expect(result.isError).toBe(false);
        const handle = JSON.parse(result.output) as TaskHandleJson;
        expect(handle.task_id).toMatch(TASK_ID_RE);

        const deadline = Date.now() + 3_000;
        while (Date.now() < deadline) {
          if (existsSync(pidFile)) {
            const text = readFileSync(pidFile, "utf8").trim();
            if (text.length > 0) {
              grandchildPid = Number.parseInt(text, 10);
              break;
            }
          }
          await new Promise<void>((r) => setTimeout(r, 25));
        }
        if (grandchildPid === undefined || !Number.isFinite(grandchildPid)) {
          throw new Error("test setup: grandchild pid was never written");
        }
        const isAlive = (pid: number): boolean => {
          try {
            process.kill(pid, 0);
            return true;
          } catch {
            return false;
          }
        };
        expect(isAlive(grandchildPid)).toBe(true);

        const killed = await shellJobKillTool(registry).invoke({ job_id: handle.task_id as string });
        expect(killed.isError).toBe(false);

        let gone = false;
        const reapDeadline = Date.now() + 3_000;
        while (Date.now() < reapDeadline) {
          if (!isAlive(grandchildPid)) {
            gone = true;
            break;
          }
          await new Promise<void>((r) => setTimeout(r, 50));
        }
        expect(gone).toBe(true);
      } finally {
        if (grandchildPid !== undefined) {
          try {
            process.kill(grandchildPid, "SIGKILL");
          } catch {
            // already gone
          }
        }
        await registry.sweepAll();
        rmSync(dir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
