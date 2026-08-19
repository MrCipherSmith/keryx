// Failing test stubs (RED phase, flow 173 / T2-T3), AC1: `shell_exec({command,
// background:true})` must return WITHOUT waiting for the process to exit,
// and `DEFAULT_SHELL_TIMEOUT_MS` must never fire on it. The intended design
// (see this flow's journal.md): the background branch bypasses
// `makeCommandRunner`'s synchronous run()+deadline machinery ENTIRELY,
// delegating instead to a new sibling `JobRegistry`
// (`./background-job-registry.ts`, does not exist yet — created by T2/T3).
//
// Proven here with an injectable fake `CommandRunner` (must NEVER be called
// for a background request — proves the sync deadline path is skipped, not
// merely raced) and a fake `BackgroundSpawner` (no real subprocess needed),
// mirroring `shell-exec-tool.test.ts`'s existing `recordingRunner()` pattern.
// AC3's real-subprocess process-group-kill test lives in
// `./background-job-registry.test.ts` (see its spike note for the Bun
// `detached: true` finding this design relies on).
//
// RED: `background-job-registry.ts`, and `shellExecTool`'s third
// `jobRegistry` param + `background` input field, do not exist yet.

import { expect, test } from "bun:test";
import { DEFAULT_SHELL_TIMEOUT_MS, ENV_SHELL_TIMEOUT_MS, shellExecTool } from "./shell-exec-tool";
import type { CommandRunner } from "./shell-exec-tool";
// RED: this module does not exist yet — T2/T3 of flow 173 creates it.
import { createJobRegistry } from "./background-job-registry";
import type { BackgroundProcessHandle, BackgroundSpawner } from "./background-job-registry";

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

  const parsed = JSON.parse(result.output) as { job_id?: string; pid?: number };
  expect(typeof parsed.job_id).toBe("string");
  expect((parsed.job_id ?? "").length).toBeGreaterThan(0);
  expect(parsed.pid).toBe(4242);
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
