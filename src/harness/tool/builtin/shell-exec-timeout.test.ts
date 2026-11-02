// Flow 115 follow-up / stress finding C3b: `shell_exec` had no deadline and no
// cancellation. `await proc.exited` waits forever, so one hanging approved
// command blocks the turn permanently — measured: `sleep 6` ran the full 6 s,
// and nothing in the driver could interrupt it.
//
// These tests spawn REAL subprocesses (that is the thing under test), but keep
// every deadline in the hundreds of milliseconds.

import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import {
  DEFAULT_SHELL_TIMEOUT_MS,
  DEFAULT_SHELL_YIELD_MS,
  ENV_SHELL_TIMEOUT_MS,
  ENV_SHELL_YIELD_MS,
  makeCommandRunner,
  resolveShellTimeoutMs,
  resolveShellYieldMs,
} from "./shell-exec-tool";

test("resolveShellTimeoutMs: default, override, disable, and junk", () => {
  expect(resolveShellTimeoutMs({})).toBe(DEFAULT_SHELL_TIMEOUT_MS);
  expect(resolveShellTimeoutMs({ [ENV_SHELL_TIMEOUT_MS]: "" })).toBe(DEFAULT_SHELL_TIMEOUT_MS);
  expect(resolveShellTimeoutMs({ [ENV_SHELL_TIMEOUT_MS]: "nonsense" })).toBe(DEFAULT_SHELL_TIMEOUT_MS);
  expect(resolveShellTimeoutMs({ [ENV_SHELL_TIMEOUT_MS]: "-5" })).toBe(DEFAULT_SHELL_TIMEOUT_MS);
  expect(resolveShellTimeoutMs({ [ENV_SHELL_TIMEOUT_MS]: "2500" })).toBe(2500);
  // An explicit 0 disables the deadline — an operator escape hatch for a
  // legitimately long build. It must be explicit, never the default.
  expect(resolveShellTimeoutMs({ [ENV_SHELL_TIMEOUT_MS]: "0" })).toBe(0);
});

test("a hanging command is killed at the deadline instead of blocking forever", async () => {
  const prev = process.env[ENV_SHELL_TIMEOUT_MS];
  process.env[ENV_SHELL_TIMEOUT_MS] = "300";
  try {
    const run = makeCommandRunner(tmpdir());
    const started = performance.now();
    const result = await run("sleep 30");
    const elapsed = performance.now() - started;

    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/timed out/i);
    expect(result.output).toMatch(new RegExp(ENV_SHELL_TIMEOUT_MS));
    // Killed near the deadline, nowhere near the command's own 30 s.
    expect(elapsed).toBeLessThan(5_000);
  } finally {
    if (prev === undefined) delete process.env[ENV_SHELL_TIMEOUT_MS];
    else process.env[ENV_SHELL_TIMEOUT_MS] = prev;
  }
});

test("output produced before the deadline is still reported", async () => {
  const prev = process.env[ENV_SHELL_TIMEOUT_MS];
  process.env[ENV_SHELL_TIMEOUT_MS] = "400";
  try {
    const run = makeCommandRunner(tmpdir());
    const result = await run("echo partial-output; sleep 30");
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/partial-output/);
    expect(result.output).toMatch(/timed out/i);
  } finally {
    if (prev === undefined) delete process.env[ENV_SHELL_TIMEOUT_MS];
    else process.env[ENV_SHELL_TIMEOUT_MS] = prev;
  }
});

test("a fast command is unaffected by the deadline", async () => {
  const prev = process.env[ENV_SHELL_TIMEOUT_MS];
  process.env[ENV_SHELL_TIMEOUT_MS] = "5000";
  try {
    const run = makeCommandRunner(tmpdir());
    const result = await run("echo quick");
    expect(result.isError).toBe(false);
    expect(result.output).toBe("quick");
  } finally {
    if (prev === undefined) delete process.env[ENV_SHELL_TIMEOUT_MS];
    else process.env[ENV_SHELL_TIMEOUT_MS] = prev;
  }
});

// review-logic-w17:F-001: a delay above 2^31-1 ms makes setTimeout fire after 1 ms, killing every command.
const MAX_TIMER_DELAY_MS = 2_147_483_647;

test("env millisecond values above the largest timer delay are clamped, not passed to setTimeout", () => {
  expect(resolveShellTimeoutMs({ [ENV_SHELL_TIMEOUT_MS]: "3000000000" })).toBe(MAX_TIMER_DELAY_MS);
  expect(resolveShellTimeoutMs({ [ENV_SHELL_TIMEOUT_MS]: String(MAX_TIMER_DELAY_MS) })).toBe(MAX_TIMER_DELAY_MS);
  expect(resolveShellYieldMs({ [ENV_SHELL_YIELD_MS]: "9999999999999" })).toBe(MAX_TIMER_DELAY_MS);
  expect(resolveShellYieldMs({ [ENV_SHELL_YIELD_MS]: "" })).toBe(DEFAULT_SHELL_YIELD_MS);
  expect(resolveShellYieldMs({ [ENV_SHELL_YIELD_MS]: "-1" })).toBe(DEFAULT_SHELL_YIELD_MS);
  expect(resolveShellYieldMs({ [ENV_SHELL_YIELD_MS]: "0" })).toBe(0);
});

test("an oversized KERYX_SHELL_TIMEOUT_MS does not kill a short command", async () => {
  const prev = process.env[ENV_SHELL_TIMEOUT_MS];
  process.env[ENV_SHELL_TIMEOUT_MS] = "3000000000";
  try {
    const result = await makeCommandRunner(tmpdir())("sleep 0.2; echo survived");
    expect(result.isError).toBe(false);
    expect(result.output).toBe("survived");
  } finally {
    if (prev === undefined) delete process.env[ENV_SHELL_TIMEOUT_MS];
    else process.env[ENV_SHELL_TIMEOUT_MS] = prev;
  }
});

// review-logic-w17:F-002: the group SIGKILL must still fire when the direct child died on SIGTERM
// but a grandchild in the group ignores it.
test("with processGroup, a TERM-ignoring grandchild does not outlive the deadline", async () => {
  const prev = process.env[ENV_SHELL_TIMEOUT_MS];
  process.env[ENV_SHELL_TIMEOUT_MS] = "300";
  let pid = 0;
  try {
    const run = makeCommandRunner(tmpdir(), undefined, { processGroup: true });
    const result = await run('(trap "" TERM; exec sleep 30) & echo $!; wait');
    pid = Number.parseInt(result.output.split("\n")[0] ?? "", 10);
    expect(Number.isInteger(pid) && pid > 0).toBe(true);
    const alive = (): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (let i = 0; i < 20 && alive(); i++) await new Promise((r) => setTimeout(r, 50));
    expect(alive()).toBe(false);
  } finally {
    if (pid > 0) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    if (prev === undefined) delete process.env[ENV_SHELL_TIMEOUT_MS];
    else process.env[ENV_SHELL_TIMEOUT_MS] = prev;
  }
});

// review-highload-w7:F-001 / review-performance-w6:F-001: the runner must not buffer all of a
// chatty command's output before the transcript cap applies.
test("a command printing far more than the transcript cap neither balloons memory nor blocks, and is counted", async () => {
  const total = 200_000_000;
  const run = makeCommandRunner(tmpdir());
  const baseline = process.memoryUsage().rss;
  let peak = baseline;
  const sampler = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().rss);
  }, 20);
  try {
    const result = await run(`head -c ${total} /dev/zero | tr '\\0' a`);
    expect(result.isError).toBe(false);
    expect(result.spill).toBeDefined();
    expect(result.spill?.full.length).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(result.output).toContain(`stdout`);
    expect(result.output).toContain(`${total} bytes`);
    expect(result.output).toContain("longer than the shell keeps");
  } finally {
    clearInterval(sampler);
  }
  expect(peak - baseline).toBeLessThan(120 * 1024 * 1024);
}, 60_000);
