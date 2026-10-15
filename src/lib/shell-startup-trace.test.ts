import { expect, test, spyOn } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startShellStartupTrace } from "./shell-startup-trace";
import { buildShellHookRuntime } from "../commands/agent-hooks";

test("startup trace is opt-in and does not even read the clock when disabled", () => {
  const trace = startShellStartupTrace("test", {}, () => { throw new Error("disabled clock"); });
  trace.mark("ignored");
  trace.finish();
});

test("startup trace records stages and a synchronous stall before the timer can fire", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "keryx-startup-"));
  try {
    const file = path.join(dir, "trace.jsonl");
    let now = 0;
    const trace = startShellStartupTrace("test", { KERYX_SHELL_STARTUP_TRACE: file }, () => now);
    now = 5;
    trace.mark("config");
    now = 205;
    trace.mark("tools");
    trace.finish();
    trace.finish(); // idempotent; no leaked monitor or duplicate record
    const lines = (await readFile(file, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]!);
    expect(record.scope).toBe("test");
    expect(record.durationMs).toBe(205);
    expect(record.stages).toEqual([
      { stage: "config", durationMs: 5, elapsedMs: 5 },
      { stage: "tools", durationMs: 200, elapsedMs: 205 },
    ]);
    expect(record.eventLoop.maxLagMs).toBe(180);
    expect(record.eventLoop.samples).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("startup trace clears its monitor once and ignores marks after finish", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "keryx-startup-"));
  const intervals = spyOn(globalThis, "setInterval");
  const clears = spyOn(globalThis, "clearInterval");
  let clockReads = 0;
  try {
    const trace = startShellStartupTrace("lifecycle", {
      KERYX_SHELL_STARTUP_TRACE: path.join(dir, "trace.jsonl"),
    }, () => ++clockReads);
    expect(intervals).toHaveBeenCalledTimes(1);
    const timer = intervals.mock.results[0]!.value;
    trace.finish();
    expect(clears).toHaveBeenCalledTimes(1);
    expect(clears).toHaveBeenCalledWith(timer);
    const finishedReads = clockReads;
    trace.mark("too-late");
    trace.finish();
    expect(clockReads).toBe(finishedReads);
    expect(clears).toHaveBeenCalledTimes(1);
  } finally {
    for (const result of intervals.mock.results) {
      if (result.type === "return") clearInterval(result.value);
    }
    intervals.mockRestore();
    clears.mockRestore();
    await rm(dir, { recursive: true, force: true });
  }
});

test("startup trace samples asynchronous waits and reports write failures without throwing", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "keryx-startup-"));
  const warning = spyOn(process, "emitWarning").mockImplementation(() => {});
  try {
    const file = path.join(dir, "trace.jsonl");
    const trace = startShellStartupTrace("async", { KERYX_SHELL_STARTUP_TRACE: file });
    await new Promise((resolve) => setTimeout(resolve, 80));
    trace.finish();
    const record = JSON.parse(await readFile(file, "utf8"));
    expect(record.eventLoop.samples).toBeGreaterThan(0);
    expect(record.eventLoop.maxLagMs).toBeGreaterThanOrEqual(0);
    const broken = startShellStartupTrace("broken", { KERYX_SHELL_STARTUP_TRACE: dir });
    expect(() => broken.finish()).not.toThrow();
    expect(warning).toHaveBeenCalledTimes(1);
  } finally {
    warning.mockRestore();
    await rm(dir, { recursive: true, force: true });
  }
});

test("hook runtime emits startup stages, including the hooks-off early return", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "keryx-startup-"));
  try {
    const file = path.join(dir, "trace.jsonl");
    const opts = { projectRoot: dir, homeDir: dir, configDir: dir, sessionId: "s", runId: "r",
      interactive: true, profileId: "monitored-trusted-local" as const };
    expect(buildShellHookRuntime({ ...opts, env: { KERYX_SHELL_STARTUP_TRACE: file } })).toBeDefined();
    expect(buildShellHookRuntime({ ...opts, env: { KERYX_SHELL_STARTUP_TRACE: file, KERYX_HOOKS: "off" } })).toBeUndefined();
    const records = (await readFile(file, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(records).toHaveLength(2);
    expect(records[0].scope).toBe("hooks.build");
    expect(records[0].stages.map((s: { stage: string }) => s.stage)).toEqual([
      "home", "config", "notices", "runner", "impact-evidence", "learning-sink", "runtime",
    ]);
    expect(records[1].stages[0].stage).toBe("hooks-disabled");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
