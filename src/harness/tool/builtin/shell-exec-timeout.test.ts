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
  ENV_SHELL_TIMEOUT_MS,
  makeCommandRunner,
  resolveShellTimeoutMs,
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
