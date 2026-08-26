// Failing test stubs (RED phase, flow 173 / T2-T3) for the not-yet-created
// session-scoped `JobRegistry` and the two `risk:"read"` background-job
// tools it backs: `shell_job_output` (AC2), `shell_job_kill` (AC3/AC4). None
// of `background-job-registry.ts` exists yet — it is a proposed sibling of
// `shell-exec-tool.ts` in this same directory, chosen and documented in this
// flow's journal.md (see "T2/T3: harness-layer test file names" note).
// `task-implementer` creates the module to make these tests pass.
//
// AC1 (shell_exec background:true) lives in `./shell-exec-background.test.ts`.
// AC6 (risk:"read" budget classification) and AC10 (approval gate parity)
// live in `src/commands/agent.test.ts` / `agent-permission-mode.test.ts` —
// they extend EXISTING budget-split / permission-mode test coverage there,
// per this flow's dispatch brief, rather than duplicating it here.
//
// --- T3 test spike: process-group kill (see journal.md for the full note) ---
// Spiked empirically with a standalone Bun script before writing AC3's test
// (Bun 1.3.14, macOS): `Bun.spawn(argv, { detached: true })` makes the
// direct child its own process-group LEADER — `ps -o pid,pgid` shows
// PGID === PID for that child AND for every descendant it forks (e.g. the
// backgrounded `sleep 1` and foregrounded `sleep 100` in `sh -c 'sleep 1 &
// sleep 100'`), and that PGID assignment survives the leader itself exiting.
// `process.kill(-pid, signal)` — Node/Bun's negative-pid convention for
// "signal the whole process GROUP, not just one process" — then reaches
// every process in that group, including a grandchild the direct child is
// no longer tracking. Verified both directions:
//   - WITH `detached: true`: `process.kill(-proc.pid, "SIGKILL")` killed the
//     shell AND both `sleep` descendants; `ps -g <pid>` was empty after.
//   - WITHOUT `detached: true`: the child's real pgid is THIS process's own
//     pgid (inherited, not a fresh group) — `-proc.pid` is not even the
//     right target, and `proc.kill()` (direct-pid only) left the
//     backgrounded `sleep 100` grandchild running after the direct child
//     exited. This is the exact bug class `shell-exec-tool.ts`'s own
//     `readInto` doc comment already describes for the synchronous path.
// Conclusion for the implementer: the DEFAULT `BackgroundSpawner` this
// module's `createJobRegistry()` uses MUST pass `detached: true` to
// `Bun.spawn`, and `JobRegistry`'s kill path MUST signal `-pid` (the process
// GROUP), never bare `pid`. This is asserted end-to-end by AC3's real-
// subprocess test below, and is NOT gated behind a live/opt-in flag (unlike
// the OS-sandbox smoke tests in `shell-exec-tool.test.ts`) — it is a core
// acceptance criterion, not an optional live check.

import { describe, expect, test } from "bun:test";
// RED: this module does not exist yet — T2/T3 of flow 173 creates it.
import {
  BACKGROUND_KILL_GRACE_MS,
  ENV_MAX_BACKGROUND_JOBS,
  MAX_BACKGROUND_OUTPUT_BYTES,
  MAX_CONCURRENT_BACKGROUND_JOBS,
  TERMINATED_OUTPUT_TAIL_BYTES,
  createJobRegistry,
  resolveMaxConcurrentBackgroundJobs,
  shellJobKillTool,
  shellJobOutputTool,
} from "./background-job-registry";
import type { BackgroundJobEvent, BackgroundProcessHandle, BackgroundSpawner } from "./background-job-registry";

// F-020: a SINGLE, file-wide pid counter shared by every `fakeSpawner()`
// instance — mirrors real OS pids, which are globally unique across
// simultaneously-running processes, so two independently-created fake
// registries in the same test never mint colliding job ids (job ids embed
// the spawned pid). A per-call counter that reset to the same starting value
// for each `fakeSpawner()` call previously made a same-string `job_id`
// collision between two DIFFERENT registries look like a real possibility
// when it was purely a test-fixture artifact.
let sharedNextFakePid = 1000;

/**
 * A fully injectable fake `BackgroundSpawner` — no real subprocess. Tests
 * drive each fake process's output/exit explicitly via the returned
 * `handles` map (keyed by pid), mirroring `shell-exec-tool.test.ts`'s
 * `recordingRunner()` injectable-double pattern.
 */
function fakeSpawner(): {
  spawn: BackgroundSpawner;
  handles: Map<
    number,
    {
      command: string;
      kills: Array<"SIGTERM" | "SIGKILL">;
      emitData: (chunk: string, stream?: "stdout" | "stderr") => void;
      emitExit: (exitCode: number) => void;
    }
  >;
} {
  const handles = new Map<
    number,
    {
      command: string;
      kills: Array<"SIGTERM" | "SIGKILL">;
      emitData: (chunk: string, stream?: "stdout" | "stderr") => void;
      emitExit: (exitCode: number) => void;
    }
  >();
  const spawn: BackgroundSpawner = (command: string): BackgroundProcessHandle => {
    const pid = sharedNextFakePid++;
    let dataCb: ((chunk: string, stream: "stdout" | "stderr") => void) | undefined;
    let exitCb: ((info: { exitCode: number }) => void) | undefined;
    const kills: Array<"SIGTERM" | "SIGKILL"> = [];
    handles.set(pid, {
      command,
      kills,
      emitData: (chunk, stream = "stdout") => dataCb?.(chunk, stream),
      emitExit: (exitCode) => exitCb?.({ exitCode }),
    });
    return {
      pid,
      onOutput: (cb) => {
        dataCb = cb;
      },
      onExit: (cb) => {
        exitCb = cb;
      },
      kill: (signal) => {
        kills.push(signal);
      },
    };
  };
  return { spawn, handles };
}

// --- AC2: incremental, cursor-based output — never a full re-dump ---

test("AC2: shell_job_output returns only output produced since the previous call", async () => {
  const { spawn, handles } = fakeSpawner();
  const registry = createJobRegistry({ spawn, initialBufferMs: 0 });
  const started = await registry.start("tail -f /dev/null");
  expect(started.ok).toBe(true);
  if (!started.ok) return;
  const handle = handles.get(started.pid);
  if (handle === undefined) throw new Error("test setup: fake handle missing");

  handle.emitData("first burst\n");
  const tool = shellJobOutputTool(registry);
  const first = await tool.invoke({ job_id: started.jobId });
  expect(first.isError).toBe(false);
  expect(first.output).toContain("first burst");
  expect(first.output).not.toContain("second burst");

  handle.emitData("second burst\n");
  const second = await tool.invoke({ job_id: started.jobId });
  expect(second.isError).toBe(false);
  expect(second.output).toContain("second burst");
  // The defining behavior under test: NOT a full re-dump of everything so far.
  expect(second.output).not.toContain("first burst");
});

test("AC2: a call with no new output since the previous call returns empty, not stale data", async () => {
  const { spawn, handles } = fakeSpawner();
  const registry = createJobRegistry({ spawn, initialBufferMs: 0 });
  const started = await registry.start("tail -f /dev/null");
  expect(started.ok).toBe(true);
  if (!started.ok) return;
  const handle = handles.get(started.pid);
  if (handle === undefined) throw new Error("test setup: fake handle missing");

  handle.emitData("only burst\n");
  const tool = shellJobOutputTool(registry);
  await tool.invoke({ job_id: started.jobId });
  const second = await tool.invoke({ job_id: started.jobId });
  expect(second.isError).toBe(false);
  expect(second.output.trim()).toBe("");
});

// --- AC4: job_id scoping — unknown or foreign ids never touch an OS process ---

test("AC4: an unknown job_id returns a tool error from both shell_job_output and shell_job_kill", async () => {
  const { spawn } = fakeSpawner();
  const registry = createJobRegistry({ spawn, initialBufferMs: 0 });

  const outputResult = await shellJobOutputTool(registry).invoke({ job_id: "does-not-exist" });
  expect(outputResult.isError).toBe(true);

  const killResult = await shellJobKillTool(registry).invoke({ job_id: "does-not-exist" });
  expect(killResult.isError).toBe(true);
});

test("AC4: a job_id from a DIFFERENT session's registry cannot be killed or read — the job keeps running", async () => {
  const { spawn: spawnA, handles: handlesA } = fakeSpawner();
  const registryA = createJobRegistry({ spawn: spawnA, initialBufferMs: 0 });
  // registryB simulates a completely separate session's own JobRegistry.
  // F-020: registryB must ALSO track a real job of its own — the original
  // version of this test left registryB empty, so it never actually proved
  // two live registries can each track their own job without cross-registry
  // job_id collision/confusion (only that a foreign lookup is denied).
  const { spawn: spawnB, handles: handlesB } = fakeSpawner();
  const registryB = createJobRegistry({ spawn: spawnB, initialBufferMs: 0 });

  const startedA = await registryA.start("sleep 100");
  expect(startedA.ok).toBe(true);
  if (!startedA.ok) return;
  const handleA = handlesA.get(startedA.pid);
  if (handleA === undefined) throw new Error("test setup: fake handle missing");

  const startedB = await registryB.start("sleep 200");
  expect(startedB.ok).toBe(true);
  if (!startedB.ok) return;
  const handleB = handlesB.get(startedB.pid);
  if (handleB === undefined) throw new Error("test setup: fake handle missing");

  // job_id embeds the spawned pid (`job-<n>-<pid>`); `fakeSpawner()` draws pids
  // from a MODULE-LEVEL counter shared across every fake spawner instance in
  // this file (mirrors real OS pids, which are globally unique across
  // simultaneously-running processes) — so registryA's and registryB's job
  // ids never collide, exactly as two real, concurrently-running `keryx`
  // sessions never would.
  expect(startedA.jobId).not.toBe(startedB.jobId); // no cross-registry job_id collision

  const foreignOutput = await shellJobOutputTool(registryB).invoke({ job_id: startedA.jobId });
  expect(foreignOutput.isError).toBe(true);

  const foreignKill = await shellJobKillTool(registryB).invoke({ job_id: startedA.jobId });
  expect(foreignKill.isError).toBe(true);
  expect(handleA.kills).toEqual([]); // registry B's (denied) kill never reached A's OS process
  expect(registryA.get(startedA.jobId)?.status).toBe("running");

  // Symmetric direction: A cannot reach B's job either.
  const foreignOutputReverse = await shellJobOutputTool(registryA).invoke({ job_id: startedB.jobId });
  expect(foreignOutputReverse.isError).toBe(true);
  const foreignKillReverse = await shellJobKillTool(registryA).invoke({ job_id: startedB.jobId });
  expect(foreignKillReverse.isError).toBe(true);
  expect(handleB.kills).toEqual([]);
  expect(registryB.get(startedB.jobId)?.status).toBe("running");

  // Each registry still correctly resolves its OWN job — proves no
  // collision/confusion, not just denial of the foreign one.
  expect(registryA.get(startedA.jobId)?.pid).toBe(startedA.pid);
  expect(registryB.get(startedB.jobId)?.pid).toBe(startedB.pid);
});

// --- AC5: hard concurrency cap — a visible error naming running jobs, never a silent queue/eviction ---

test("AC5: starting a job beyond MAX_CONCURRENT_BACKGROUND_JOBS errors and names the currently running jobs", async () => {
  const { spawn } = fakeSpawner();
  const registry = createJobRegistry({ spawn, maxConcurrent: 2, initialBufferMs: 0 });
  const first = await registry.start("sleep 100");
  const second = await registry.start("sleep 200");
  expect(first.ok).toBe(true);
  expect(second.ok).toBe(true);

  const third = await registry.start("sleep 300");
  expect(third.ok).toBe(false);
  if (third.ok) return;
  expect(third.error).toMatch(/sleep 100/);
  expect(third.error).toMatch(/sleep 200/);
  // Never a silent queue: the third job was never registered.
  expect(registry.list()).toHaveLength(2);
  // Never a silent eviction: both original jobs are still tracked as running.
  expect(registry.list().every((j) => j.status === "running")).toBe(true);
});

test("resolveMaxConcurrentBackgroundJobs: default 3, KERYX_MAX_BACKGROUND_JOBS override, malformed falls back", () => {
  expect(MAX_CONCURRENT_BACKGROUND_JOBS).toBe(3);
  expect(resolveMaxConcurrentBackgroundJobs({})).toBe(MAX_CONCURRENT_BACKGROUND_JOBS);
  expect(resolveMaxConcurrentBackgroundJobs({ [ENV_MAX_BACKGROUND_JOBS]: "5" })).toBe(5);
  expect(resolveMaxConcurrentBackgroundJobs({ [ENV_MAX_BACKGROUND_JOBS]: "0" })).toBe(
    MAX_CONCURRENT_BACKGROUND_JOBS,
  );
  expect(resolveMaxConcurrentBackgroundJobs({ [ENV_MAX_BACKGROUND_JOBS]: "-1" })).toBe(
    MAX_CONCURRENT_BACKGROUND_JOBS,
  );
  expect(resolveMaxConcurrentBackgroundJobs({ [ENV_MAX_BACKGROUND_JOBS]: "nonsense" })).toBe(
    MAX_CONCURRENT_BACKGROUND_JOBS,
  );
});

// --- AC7: session-exit sweep — every tracked job SIGTERM→SIGKILL'd by process group ---

test("AC7: sweepAll SIGTERMs then SIGKILLs every tracked job that ignores the first signal", async () => {
  const { spawn, handles } = fakeSpawner();
  const registry = createJobRegistry({ spawn, initialBufferMs: 0, killGraceMs: 15 });
  const j1 = await registry.start("sleep 100");
  const j2 = await registry.start("sleep 200");
  expect(j1.ok && j2.ok).toBe(true);
  if (!j1.ok || !j2.ok) return;

  // Neither fake process ever calls its onExit callback — simulates a
  // process that ignores SIGTERM, so the SIGKILL escalation must fire too.
  await registry.sweepAll();

  const h1 = handles.get(j1.pid);
  const h2 = handles.get(j2.pid);
  expect(h1?.kills).toEqual(["SIGTERM", "SIGKILL"]);
  expect(h2?.kills).toEqual(["SIGTERM", "SIGKILL"]);
});

test("AC7: sweepAll does NOT SIGKILL a job that exits cleanly after SIGTERM", async () => {
  const { spawn, handles } = fakeSpawner();
  const registry = createJobRegistry({ spawn, initialBufferMs: 0, killGraceMs: 200 });
  const started = await registry.start("sleep 100");
  expect(started.ok).toBe(true);
  if (!started.ok) return;
  const handle = handles.get(started.pid);
  if (handle === undefined) throw new Error("test setup: fake handle missing");

  const sweep = registry.sweepAll();
  // Simulate the process honoring SIGTERM immediately.
  handle.emitExit(143);
  await sweep;

  expect(handle.kills).toEqual(["SIGTERM"]); // no SIGKILL needed
});

test("BACKGROUND_KILL_GRACE_MS: a positive, bounded default grace period between SIGTERM and SIGKILL", () => {
  expect(BACKGROUND_KILL_GRACE_MS).toBeGreaterThan(0);
  expect(BACKGROUND_KILL_GRACE_MS).toBeLessThanOrEqual(5_000);
});

// --- AC3: shell_job_kill terminates the ENTIRE process group (REAL subprocess) ---
//
// This is the one test in this file that spawns a real subprocess — the
// process-group-kill mechanism itself is what's under test (see the spike
// note at the top of this file). Not gated behind a live/opt-in env flag:
// this is a core acceptance criterion, always run, same convention as
// `shell-exec-timeout.test.ts`'s real-subprocess deadline tests.
// --- T4 review fix (finding F-004) --------------------------------------
//
// The original version of this test (`sh -c 'sleep 1 & sleep 100'`, kill,
// then `process.kill(-pid, 0)`) had a timing bug that let it false-pass on
// the exact regression it exists to catch:
//   (a) by the time the group-level probe ran, the backgrounded `sleep 1`
//       had ALREADY exited on its own regardless of whether kill worked —
//       it never actually proved the kill reached anything;
//   (b) `process.kill(-pid, 0)` returns "gone" identically whether the kill
//       genuinely worked OR `detached: true` was silently never applied (in
//       which case `-pid` is not even a real process-group id and the probe
//       is meaningless either way).
// Fixed per this flow's T4 dispatch brief: (a) capture/assert BEFORE killing
// that the group actually has multiple members sharing the parent's pid as
// pgid — proving detachment really happened — and (b) use a long-lived
// grandchild whose SPECIFIC pid is captured and checked afterward, not a
// group-level probe.
describe("AC3: shell_job_kill kills the entire process group, including an outliving grandchild", () => {
  test("a grandchild the direct child spawned is actually gone after kill, not just the direct child", async () => {
    const registry = createJobRegistry({ killGraceMs: 100, initialBufferMs: 0 });
    // `sleep 100 &` backgrounds a long-lived GRANDCHILD (relative to the
    // registry's own tracked pid) and echoes its pid via `$!`; the trailing
    // `sleep 100` keeps the direct child (the shell) alive for the duration
    // of the test too.
    const started = await registry.start("sh -c 'sleep 100 & echo GRANDCHILD_PID:$!; sleep 100'");
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    // Poll for the echoed grandchild pid (bounded wait) rather than a fixed
    // sleep — deterministic regardless of scheduler jitter, and fails fast
    // with a clear error if the shell never got to fork/echo at all.
    let grandchildPid: number | undefined;
    let buffered = "";
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const read = registry.readOutput(started.jobId);
      if (read.ok) buffered += read.output;
      const match = /GRANDCHILD_PID:(\d+)/.exec(buffered);
      if (match?.[1] !== undefined) {
        grandchildPid = Number.parseInt(match[1], 10);
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
    if (grandchildPid === undefined) {
      throw new Error(`test setup: never observed the grandchild pid in output: ${JSON.stringify(buffered)}`);
    }

    // (a) Prove detachment ACTUALLY happened before killing: both the direct
    // child (started.pid) and the grandchild share started.pid as their
    // process-group id — i.e. the direct child really is a fresh group
    // LEADER (`detached: true`), not silently inheriting this test runner's
    // own pgid. If detach silently failed, this assertion catches it here,
    // before the kill-based assertion below could otherwise false-pass.
    const pgidOf = (pid: number): number => {
      const out = Bun.spawnSync(["ps", "-o", "pgid=", "-p", String(pid)]).stdout.toString().trim();
      return Number.parseInt(out, 10);
    };
    expect(pgidOf(started.pid)).toBe(started.pid);
    expect(pgidOf(grandchildPid)).toBe(started.pid);

    const killResult = await shellJobKillTool(registry).invoke({ job_id: started.jobId });
    expect(killResult.isError).toBe(false);

    // Grace period (SIGTERM→SIGKILL) plus a little slack for the OS to reap.
    await new Promise<void>((resolve) => setTimeout(resolve, 500));

    // (b) Check the SPECIFIC grandchild pid captured above — unambiguous
    // regardless of whether `detached: true` was actually applied (unlike a
    // group-level `kill(-pid, 0)` probe, which can false-pass — see the note
    // above this describe block).
    let grandchildAlive = true;
    try {
      process.kill(grandchildPid, 0);
    } catch {
      grandchildAlive = false;
    }
    expect(grandchildAlive).toBe(false);
  });
});

// --- T4 review fix (finding F-005): output-cap truncation must not corrupt readOutput's cursor ---

test("F-005: readCursor is re-based (not left stale) when the output cap truncates the buffer", async () => {
  const { spawn, handles } = fakeSpawner();
  const registry = createJobRegistry({ spawn, initialBufferMs: 0 });
  const started = await registry.start("chatty");
  expect(started.ok).toBe(true);
  if (!started.ok) return;
  const handle = handles.get(started.pid);
  if (handle === undefined) throw new Error("test setup: fake handle missing");

  // Read a small amount first, advancing readCursor to a real (non-zero,
  // non-full-buffer) position — the exact case the old code corrupted.
  handle.emitData("first small burst\n");
  const first = await shellJobOutputTool(registry).invoke({ job_id: started.jobId });
  expect(first.output).toContain("first small burst");

  // Now push the buffer over the cap in one chunk. The truncation must drop
  // the SAME amount from readCursor as it drops from the buffer itself.
  const overflow = "y".repeat(MAX_BACKGROUND_OUTPUT_BYTES + 500);
  handle.emitData(overflow);

  const after = registry.readOutput(started.jobId);
  expect(after.ok).toBe(true);
  if (!after.ok) return;
  // The tail of the overflow chunk must still be readable — a stale,
  // un-rebased cursor would silently skip or blank this.
  expect(after.output.length).toBeGreaterThan(0);
  expect(after.output.endsWith("y")).toBe(true);

  // A THIRD call must return empty (not stale data), proving the cursor
  // correctly landed at the end of the (now-truncated) buffer, not past it
  // or short of it.
  const third = registry.readOutput(started.jobId);
  expect(third.ok).toBe(true);
  if (!third.ok) return;
  expect(third.output).toBe("");
});

// --- T4 review fix (finding F-007): a successful kill reports "killed", never "exited" ---

test('F-007: a kill where SIGTERM alone succeeds (the common case) reports status "killed", not "exited", and exit fires exactly once', async () => {
  const { spawn, handles } = fakeSpawner();
  const events: BackgroundJobEvent[] = [];
  const registry = createJobRegistry({
    spawn,
    initialBufferMs: 0,
    killGraceMs: 200,
    onEvent: (e) => events.push(e),
  });
  const started = await registry.start("sleep 100");
  expect(started.ok).toBe(true);
  if (!started.ok) return;
  const handle = handles.get(started.pid);
  if (handle === undefined) throw new Error("test setup: fake handle missing");

  const killPromise = registry.kill(started.jobId);
  // Simulate the process responding to SIGTERM immediately — the common
  // case this finding is about (previously mis-reported as "exited").
  handle.emitExit(143);
  const killResult = await killPromise;
  expect(killResult.ok).toBe(true);

  expect(handle.kills).toEqual(["SIGTERM"]); // no SIGKILL needed
  expect(registry.get(started.jobId)?.status).toBe("killed");

  const exitEvents = events.filter((e) => e.type === "exit" && e.jobId === started.jobId);
  expect(exitEvents).toHaveLength(1); // never double-emitted
});

// --- T4 review fix (finding F-012): the onEvent bridge contract, exercised end-to-end ---

test("F-012: onEvent emits the real start -> output -> output -> exit sequence a TUI bridge would observe", async () => {
  const { spawn, handles } = fakeSpawner();
  const events: BackgroundJobEvent[] = [];
  const registry = createJobRegistry({
    spawn,
    initialBufferMs: 0,
    killGraceMs: 200,
    onEvent: (e) => events.push(e),
  });

  const started = await registry.start("tail -f /dev/null");
  expect(started.ok).toBe(true);
  if (!started.ok) return;
  const handle = handles.get(started.pid);
  if (handle === undefined) throw new Error("test setup: fake handle missing");

  handle.emitData("first burst\n", "stdout");
  handle.emitData("second burst\n", "stderr");

  const killPromise = registry.kill(started.jobId);
  handle.emitExit(0);
  await killPromise;

  expect(events.map((e) => e.type)).toEqual(["start", "output", "output", "exit"]);

  const [startEvent, out1, out2, exitEvent] = events;
  if (startEvent?.type !== "start") throw new Error("expected a start event");
  expect(startEvent.pid).toBe(started.pid);
  expect(startEvent.command).toBe("tail -f /dev/null");
  expect(startEvent.jobId).toBe(started.jobId);

  if (out1?.type !== "output" || out2?.type !== "output") throw new Error("expected two output events");
  expect(out1.chunk).toBe("first burst\n");
  expect(out1.stream).toBe("stdout");
  expect(out2.chunk).toBe("second burst\n");
  expect(out2.stream).toBe("stderr");

  if (exitEvent?.type !== "exit") throw new Error("expected an exit event");
  expect(exitEvent.jobId).toBe(started.jobId);
  expect(exitEvent.status).toBe("killed");
  expect(exitEvent.exitCode).toBe(0);
  expect(typeof exitEvent.endedAt).toBe("string");
});

// --- T4 review fix (finding F-013): the 2MB output auto-kill rail ---

test("F-013: exceeding MAX_BACKGROUND_OUTPUT_BYTES auto-kills exactly once (not once per over-cap chunk during the grace window), ends status \"killed\", and readOutput returns a bounded tail", async () => {
  const { spawn, handles } = fakeSpawner();
  const registry = createJobRegistry({ spawn, initialBufferMs: 0, killGraceMs: 300 });
  const started = await registry.start("chatty-build-watcher");
  expect(started.ok).toBe(true);
  if (!started.ok) return;
  const handle = handles.get(started.pid);
  if (handle === undefined) throw new Error("test setup: fake handle missing");

  const big = "x".repeat(MAX_BACKGROUND_OUTPUT_BYTES + 100);
  handle.emitData(big);
  // A second over-cap chunk arriving DURING the grace window must NOT
  // re-trigger the auto-kill — the related bug this finding also flags: the
  // old guard only checked `status !== "running"`, which does not flip until
  // the kill actually lands, so every over-cap chunk during the grace period
  // re-fired terminateJob.
  handle.emitData("more overflow arriving after the cap was already hit");

  // Simulate the process actually dying in response to the auto-issued
  // SIGTERM, before the grace period elapses.
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  handle.emitExit(143);
  await new Promise<void>((resolve) => setTimeout(resolve, 20));

  expect(handle.kills).toEqual(["SIGTERM"]); // exactly one SIGTERM; no SIGKILL needed, no duplicate
  expect(registry.get(started.jobId)?.status).toBe("killed"); // F-007 tie-in

  const tail = registry.readOutput(started.jobId);
  expect(tail.ok).toBe(true);
  if (!tail.ok) return;
  // Only whatever remains after the terminal shrink (F-009) — never the full
  // multi-megabyte buffer.
  expect(tail.output.length).toBeLessThanOrEqual(TERMINATED_OUTPUT_TAIL_BYTES);
});

// --- T4 review fix (finding F-009): registry entries are bounded, not tracked forever ---

test("F-009: total tracked jobs are capped — the oldest TERMINATED entries are evicted, a running job is never evicted", async () => {
  const { spawn, handles } = fakeSpawner();
  const registry = createJobRegistry({ spawn, initialBufferMs: 0, maxTrackedJobs: 3, killGraceMs: 50 });

  // Start and immediately finish 4 jobs — one more than maxTrackedJobs.
  const finishedIds: string[] = [];
  for (let i = 0; i < 4; i += 1) {
    const started = await registry.start(`echo job-${i}`);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const handle = handles.get(started.pid);
    if (handle === undefined) throw new Error("test setup: fake handle missing");
    handle.emitExit(0);
    finishedIds.push(started.jobId);
  }

  expect(registry.list().length).toBeLessThanOrEqual(3);
  // The OLDEST (first-started) terminated job is the one evicted.
  expect(registry.get(finishedIds[0] as string)).toBeUndefined();
  // The most recent ones survive.
  expect(registry.get(finishedIds[finishedIds.length - 1] as string)).toBeDefined();

  // A running job must never be evicted even when the cap is exceeded by
  // terminated jobs.
  const runningStarted = await registry.start("sleep 100");
  expect(runningStarted.ok).toBe(true);
  if (!runningStarted.ok) return;
  for (let i = 0; i < 4; i += 1) {
    const started = await registry.start(`echo more-${i}`);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const handle = handles.get(started.pid);
    if (handle === undefined) throw new Error("test setup: fake handle missing");
    handle.emitExit(0);
  }
  expect(registry.get(runningStarted.jobId)?.status).toBe("running");
});

test("F-009: a terminated job's outputBuffer is shrunk to a small tail once its final exit event has been delivered", async () => {
  const { spawn, handles } = fakeSpawner();
  const registry = createJobRegistry({ spawn, initialBufferMs: 0 });
  const started = await registry.start("chatty-but-not-over-cap");
  expect(started.ok).toBe(true);
  if (!started.ok) return;
  const handle = handles.get(started.pid);
  if (handle === undefined) throw new Error("test setup: fake handle missing");

  const modestButOverTail = "z".repeat(TERMINATED_OUTPUT_TAIL_BYTES + 500);
  handle.emitData(modestButOverTail);
  handle.emitExit(0);

  // readOutput after exit still returns whatever was unread (bounded by the
  // shrink), never throws, never reports stale/negative-cursor garbage.
  const after = registry.readOutput(started.jobId);
  expect(after.ok).toBe(true);
  if (!after.ok) return;
  expect(after.output.length).toBeLessThanOrEqual(TERMINATED_OUTPUT_TAIL_BYTES);
});

describe("C-09/C-10: background teardown dispositions", () => {
  test("C-09: a killed job keeps pre-teardown output and reaches a terminal state", async () => {
    const { spawn, handles } = fakeSpawner();
    const registry = createJobRegistry({ spawn, initialBufferMs: 0, killGraceMs: 1 });
    const started = await registry.start("long-running-command");
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const handle = handles.get(started.pid);
    if (handle === undefined) throw new Error("test setup: fake handle missing");

    handle.emitData("before teardown");
    await expect(registry.kill(started.jobId)).resolves.toEqual({ ok: true });
    handle.emitExit(143);

    const output = registry.readOutput(started.jobId);
    expect(output).toEqual({ ok: true, output: "before teardown" });
    expect(registry.get(started.jobId)?.status).toBe("killed");
  });

  test("C-10: killing after exit is an ordinary tool error and never re-signals the process", async () => {
    const { spawn, handles } = fakeSpawner();
    const registry = createJobRegistry({ spawn, initialBufferMs: 0, killGraceMs: 1 });
    const started = await registry.start("already-exited-command");
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const handle = handles.get(started.pid);
    if (handle === undefined) throw new Error("test setup: fake handle missing");
    handle.emitExit(0);

    const result = await shellJobKillTool(registry).invoke({ job_id: started.jobId });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("is not running");
    expect(handle.kills).toEqual([]);
  });
});
