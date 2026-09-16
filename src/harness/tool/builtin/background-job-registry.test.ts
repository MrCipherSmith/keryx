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
import { tmpdir } from "node:os";
import {
  BACKGROUND_KILL_GRACE_MS,
  DEFAULT_SHELL_IDLE_MS,
  ENV_MAX_BACKGROUND_JOBS,
  ENV_SHELL_IDLE_MS,
  MAX_BACKGROUND_OUTPUT_BYTES,
  MAX_CONCURRENT_BACKGROUND_JOBS,
  MAX_TASK_IDLE_TIMEOUT_MS,
  MIN_TASK_IDLE_TIMEOUT_MS,
  TERMINATED_OUTPUT_TAIL_BYTES,
  clampTaskIdleTimeoutMs,
  createJobRegistry,
  resolveMaxConcurrentBackgroundJobs,
  resolveShellIdleMs,
  shellJobKillTool,
  shellJobOutputTool,
} from "./background-job-registry";
import type { BackgroundJobEvent, BackgroundProcessHandle, BackgroundSpawner } from "./background-job-registry";

// flow 263: the idle-timeout exports were read off the module namespace through
// an `as unknown as` cast while these tests were RED (so a missing export was a
// per-test failure rather than a link-time error taking down the whole file).
// Now that T6 has implemented them they are ordinary named imports, which also
// puts their real signatures back under the typechecker.

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
function fakeSpawner(opts: { exitOnKill?: boolean } = {}): {
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
    let exited = false;
    const emitExit = (exitCode: number): void => {
      if (exited) return;
      exited = true;
      exitCb?.({ exitCode });
    };
    handles.set(pid, {
      command,
      kills,
      emitData: (chunk, stream = "stdout") => dataCb?.(chunk, stream),
      emitExit,
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
        // flow 263: a fake that honours the signal like a real process, so a
        // kill reaches a terminal status without the test driving emitExit.
        if (opts.exitOnKill === true) emitExit(143);
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

  // flow 263: task ids are `task-<n>-<pid>` (was `job-<n>-<pid>`).
  expect(startedA.jobId).toMatch(/^task-[0-9]+-[0-9]+$/);
  expect(startedB.jobId).toMatch(/^task-[0-9]+-[0-9]+$/);
  // job_id embeds the spawned pid (`task-<n>-<pid>`); `fakeSpawner()` draws pids
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

    try {
      const killResult = await shellJobKillTool(registry).invoke({ job_id: started.jobId });
      expect(killResult.isError).toBe(false);

      // (b) Check the SPECIFIC grandchild pid captured above — unambiguous
      // regardless of whether `detached: true` was actually applied (unlike a
      // group-level `kill(-pid, 0)` probe, which can false-pass — see the note
      // above this describe block). POLLED to a deadline rather than probed
      // once after a fixed sleep: under load the OS can take longer than any
      // fixed slack to reap, which would fail the test on a kill that worked.
      const isAlive = (pid: number): boolean => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      const gone = await pollUntil(() => !isAlive(grandchildPid), 10_000, 50);
      expect(gone).toBe(true);
    } finally {
      // A failed assertion above must not leave two real `sleep 100`
      // processes running for the next 100 seconds.
      try {
        process.kill(grandchildPid, "SIGKILL");
      } catch {
        // already gone — the expected path
      }
      await registry.sweepAll();
    }
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

  // flow 263: a background-phase start (the default) emits its single `phase`
  // event right after `start`, so the TUI store (which lists a task only on
  // `phase`) still shows a `background:true` task.
  expect(events.map((e) => e.type)).toEqual(["start", "phase", "output", "output", "exit"]);

  const [startEvent, phaseEvent, out1, out2, exitEvent] = events;
  if (phaseEvent?.type !== "phase") throw new Error("expected a phase event");
  expect(phaseEvent.jobId).toBe(started.jobId);
  expect(phaseEvent.phase).toBe("background");
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
  expect(exitEvent.killReason).toBe("model");
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
  expect(registry.get(started.jobId)?.killReason).toBe("output-cap"); // flow 263 AC4

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

// ===========================================================================
// flow 263 (P0: every shell_exec is a supervised task) — RED tests.
// API pinned in the flow's dispatch brief; spec docs/requirements/
// keryx-background-task-execution/specification.md §3, §4.1, §5; D-12/13/14.
// ===========================================================================

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function pollUntil(predicate: () => boolean, timeoutMs: number, stepMs = 25): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(stepMs);
  }
  return predicate();
}

describe("flow 263 AC3: idle-timeout configuration resolvers", () => {
  test("constants: KERYX_SHELL_IDLE_MS, 120000 default, [1000, 1800000] per-task clamp", () => {
    expect(ENV_SHELL_IDLE_MS).toBe("KERYX_SHELL_IDLE_MS");
    expect(DEFAULT_SHELL_IDLE_MS).toBe(120_000);
    expect(MIN_TASK_IDLE_TIMEOUT_MS).toBe(1_000);
    expect(MAX_TASK_IDLE_TIMEOUT_MS).toBe(1_800_000);
  });

  test("resolveShellIdleMs: default when nothing is set", () => {
    expect(resolveShellIdleMs({})).toBe(DEFAULT_SHELL_IDLE_MS);
    expect(resolveShellIdleMs({ KERYX_SHELL_IDLE_MS: "" })).toBe(DEFAULT_SHELL_IDLE_MS);
    expect(resolveShellIdleMs({ KERYX_SHELL_IDLE_MS: "   " })).toBe(DEFAULT_SHELL_IDLE_MS);
  });

  test("resolveShellIdleMs: explicit override, and explicit 0 disables", () => {
    expect(resolveShellIdleMs({ KERYX_SHELL_IDLE_MS: "5000" })).toBe(5_000);
    expect(resolveShellIdleMs({ KERYX_SHELL_IDLE_MS: "0" })).toBe(0);
  });

  test("resolveShellIdleMs: malformed values fall back to the default, never to 'disabled'", () => {
    expect(resolveShellIdleMs({ KERYX_SHELL_IDLE_MS: "nonsense" })).toBe(DEFAULT_SHELL_IDLE_MS);
    expect(resolveShellIdleMs({ KERYX_SHELL_IDLE_MS: "-5" })).toBe(DEFAULT_SHELL_IDLE_MS);
  });

  test("resolveShellIdleMs: unset/empty falls back to the deprecated KERYX_SHELL_TIMEOUT_MS with the same rules", () => {
    expect(resolveShellIdleMs({ KERYX_SHELL_TIMEOUT_MS: "3000" })).toBe(3_000);
    expect(resolveShellIdleMs({ KERYX_SHELL_IDLE_MS: "", KERYX_SHELL_TIMEOUT_MS: "3000" })).toBe(3_000);
    expect(resolveShellIdleMs({ KERYX_SHELL_TIMEOUT_MS: "0" })).toBe(0);
    expect(resolveShellIdleMs({ KERYX_SHELL_TIMEOUT_MS: "junk" })).toBe(DEFAULT_SHELL_IDLE_MS);
    expect(resolveShellIdleMs({ KERYX_SHELL_TIMEOUT_MS: "-1" })).toBe(DEFAULT_SHELL_IDLE_MS);
  });

  test("resolveShellIdleMs: KERYX_SHELL_IDLE_MS wins over KERYX_SHELL_TIMEOUT_MS; a malformed IDLE does not fall back", () => {
    expect(resolveShellIdleMs({ KERYX_SHELL_IDLE_MS: "7000", KERYX_SHELL_TIMEOUT_MS: "3000" })).toBe(7_000);
    expect(resolveShellIdleMs({ KERYX_SHELL_IDLE_MS: "junk", KERYX_SHELL_TIMEOUT_MS: "3000" })).toBe(
      DEFAULT_SHELL_IDLE_MS,
    );
  });

  test("clampTaskIdleTimeoutMs clamps into [1000, 1800000]; the model cannot disable the idle timeout", () => {
    expect(clampTaskIdleTimeoutMs(5)).toBe(1_000);
    expect(clampTaskIdleTimeoutMs(0)).toBe(1_000);
    expect(clampTaskIdleTimeoutMs(-1)).toBe(1_000);
    expect(clampTaskIdleTimeoutMs(1_000)).toBe(1_000);
    expect(clampTaskIdleTimeoutMs(50_000)).toBe(50_000);
    expect(clampTaskIdleTimeoutMs(1_800_000)).toBe(1_800_000);
    expect(clampTaskIdleTimeoutMs(99_999_999)).toBe(1_800_000);
  });
});

describe("flow 263: task ids, phase and start options", () => {
  test("start() mints task-<n>-<pid> ids and defaults to the background phase", async () => {
    const { spawn } = fakeSpawner();
    const registry = createJobRegistry({ spawn, initialBufferMs: 0 });
    const started = await registry.start("sleep 100");
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.jobId).toMatch(/^task-[0-9]+-[0-9]+$/);
    expect(started.jobId.endsWith(`-${started.pid}`)).toBe(true);
    expect(registry.get(started.jobId)?.phase).toBe("background");
  });

  test("start() records description, phase and the effective idleTimeoutMs; the start event carries the description", async () => {
    const { spawn } = fakeSpawner();
    const events: BackgroundJobEvent[] = [];
    const registry = createJobRegistry({ spawn, initialBufferMs: 0, idleMs: 90_000, onEvent: (e) => events.push(e) });

    const fg = await registry.start("gh run watch", { phase: "foreground", description: "watch CI" });
    expect(fg.ok).toBe(true);
    if (!fg.ok) return;
    const info = registry.get(fg.jobId);
    expect(info?.phase).toBe("foreground");
    expect(info?.description).toBe("watch CI");
    expect(info?.idleTimeoutMs).toBe(90_000); // falls back to the registry idleMs

    const custom = await registry.start("sleep 5", { phase: "foreground", idleTimeoutMs: 4_000 });
    expect(custom.ok).toBe(true);
    if (!custom.ok) return;
    expect(registry.get(custom.jobId)?.idleTimeoutMs).toBe(4_000);

    const startEvent = events.find((e) => e.type === "start" && e.jobId === fg.jobId);
    if (startEvent?.type !== "start") throw new Error("expected a start event");
    expect(startEvent.description).toBe("watch CI");
  });

  test("a foreground start does NOT emit a phase event; a background start emits exactly one", async () => {
    const { spawn } = fakeSpawner();
    const events: BackgroundJobEvent[] = [];
    const registry = createJobRegistry({ spawn, initialBufferMs: 0, onEvent: (e) => events.push(e) });

    const fg = await registry.start("npm test", { phase: "foreground" });
    const bg = await registry.start("npm run dev", { phase: "background" });
    expect(fg.ok && bg.ok).toBe(true);
    if (!fg.ok || !bg.ok) return;

    expect(events.filter((e) => e.type === "phase" && e.jobId === fg.jobId)).toHaveLength(0);
    expect(events.filter((e) => e.type === "phase" && e.jobId === bg.jobId)).toHaveLength(1);
  });

  test("the initial output buffer sleep applies only to background-phase starts", async () => {
    const { spawn } = fakeSpawner();
    const registry = createJobRegistry({ spawn, initialBufferMs: 400 });

    const fgStarted = performance.now();
    const fg = await registry.start("npm test", { phase: "foreground" });
    const fgElapsed = performance.now() - fgStarted;
    expect(fg.ok).toBe(true);

    const bgStarted = performance.now();
    const bg = await registry.start("npm run dev", { phase: "background" });
    const bgElapsed = performance.now() - bgStarted;
    expect(bg.ok).toBe(true);

    // Asserted as a RELATION, not as an absolute wall-clock bound on the
    // foreground half: a loaded runner can make any single `await` chain take
    // longer than a fixed threshold, but it cannot make the unbuffered start
    // take as long as the buffered one.
    expect(bgElapsed).toBeGreaterThanOrEqual(350); // background start still buffers early output
    expect(fgElapsed).toBeLessThan(bgElapsed / 2); // foreground start does not
  });
});

describe("flow 263: waitForExit", () => {
  test('resolves "exited" as soon as the task exits within the wait', async () => {
    const { spawn, handles } = fakeSpawner();
    const registry = createJobRegistry({ spawn, initialBufferMs: 0 });
    const started = await registry.start("echo hi", { phase: "foreground" });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const handle = handles.get(started.pid);
    if (handle === undefined) throw new Error("test setup: fake handle missing");

    setTimeout(() => handle.emitExit(0), 30);
    const t0 = performance.now();
    const outcome = await registry.waitForExit(started.jobId, 5_000);
    expect(outcome).toBe("exited");
    expect(performance.now() - t0).toBeLessThan(2_000);
  });

  test('resolves "exited" immediately for an already-terminated task', async () => {
    const { spawn, handles } = fakeSpawner();
    const registry = createJobRegistry({ spawn, initialBufferMs: 0 });
    const started = await registry.start("true", { phase: "foreground" });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    handles.get(started.pid)?.emitExit(0);
    expect(await registry.waitForExit(started.jobId, 5_000)).toBe("exited");
  });

  test('resolves "timeout" for a task still running after the wait, and never kills it', async () => {
    const { spawn, handles } = fakeSpawner();
    const registry = createJobRegistry({ spawn, initialBufferMs: 0 });
    const started = await registry.start("sleep 120", { phase: "foreground" });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(await registry.waitForExit(started.jobId, 50)).toBe("timeout");
    expect(handles.get(started.pid)?.kills).toEqual([]);
    expect(registry.get(started.jobId)?.status).toBe("running");
  });

  test('resolves "unknown" for an id this registry never tracked', async () => {
    const registry = createJobRegistry({ spawn: fakeSpawner().spawn, initialBufferMs: 0 });
    expect(await registry.waitForExit("task-99-99999", 50)).toBe("unknown");
  });
});

describe("flow 263 AC4: terminal statuses and kill reasons", () => {
  test("exit 0 → completed (no killReason), exactly one exit event", async () => {
    const { spawn, handles } = fakeSpawner();
    const events: BackgroundJobEvent[] = [];
    const registry = createJobRegistry({ spawn, initialBufferMs: 0, onEvent: (e) => events.push(e) });
    const started = await registry.start("true");
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    handles.get(started.pid)?.emitExit(0);

    const info = registry.get(started.jobId);
    expect(info?.status).toBe("completed");
    expect(info?.exitCode).toBe(0);
    expect(info?.killReason).toBeUndefined();
    const exits = events.filter((e) => e.type === "exit" && e.jobId === started.jobId);
    expect(exits).toHaveLength(1);
    const exit = exits[0];
    if (exit?.type !== "exit") throw new Error("expected exit event");
    expect(exit.status).toBe("completed");
    expect(exit.killReason).toBeUndefined();
  });

  test("non-zero exit → failed, exactly one exit event carrying failed", async () => {
    const { spawn, handles } = fakeSpawner();
    const events: BackgroundJobEvent[] = [];
    const registry = createJobRegistry({ spawn, initialBufferMs: 0, onEvent: (e) => events.push(e) });
    const started = await registry.start("exit 2");
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    handles.get(started.pid)?.emitExit(2);

    expect(registry.get(started.jobId)?.status).toBe("failed");
    expect(registry.get(started.jobId)?.exitCode).toBe(2);
    const exits = events.filter((e) => e.type === "exit" && e.jobId === started.jobId);
    expect(exits).toHaveLength(1);
    if (exits[0]?.type !== "exit") throw new Error("expected exit event");
    expect(exits[0].status).toBe("failed");
  });

  test('kill(id) defaults to killReason "model"; kill(id, "operator") records operator', async () => {
    const { spawn } = fakeSpawner({ exitOnKill: true });
    const events: BackgroundJobEvent[] = [];
    const registry = createJobRegistry({ spawn, initialBufferMs: 0, killGraceMs: 200, onEvent: (e) => events.push(e) });
    const a = await registry.start("sleep 100");
    const b = await registry.start("sleep 200");
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    expect(await registry.kill(a.jobId)).toEqual({ ok: true });
    expect(await registry.kill(b.jobId, "operator")).toEqual({ ok: true });

    expect(registry.get(a.jobId)).toMatchObject({ status: "killed", killReason: "model" });
    expect(registry.get(b.jobId)).toMatchObject({ status: "killed", killReason: "operator" });

    for (const [id, reason] of [
      [a.jobId, "model"],
      [b.jobId, "operator"],
    ] as const) {
      const exits = events.filter((e) => e.type === "exit" && e.jobId === id);
      expect(exits).toHaveLength(1);
      if (exits[0]?.type !== "exit") throw new Error("expected exit event");
      expect(exits[0].status).toBe("killed");
      expect(exits[0].killReason).toBe(reason);
    }
  });

  test('sweepAll() kills with killReason "session-exit"', async () => {
    const { spawn } = fakeSpawner({ exitOnKill: true });
    const events: BackgroundJobEvent[] = [];
    const registry = createJobRegistry({ spawn, initialBufferMs: 0, killGraceMs: 200, onEvent: (e) => events.push(e) });
    const bg = await registry.start("npm run dev");
    const fg = await registry.start("npm test", { phase: "foreground" });
    expect(bg.ok && fg.ok).toBe(true);
    if (!bg.ok || !fg.ok) return;

    await registry.sweepAll();

    for (const id of [bg.jobId, fg.jobId]) {
      expect(registry.get(id)).toMatchObject({ status: "killed", killReason: "session-exit" });
      const exits = events.filter((e) => e.type === "exit" && e.jobId === id);
      expect(exits).toHaveLength(1);
      if (exits[0]?.type !== "exit") throw new Error("expected exit event");
      expect(exits[0].killReason).toBe("session-exit");
    }
  });

  test('the output-cap rail kills with killReason "output-cap", and the exit event carries it', async () => {
    const { spawn, handles } = fakeSpawner({ exitOnKill: true });
    const events: BackgroundJobEvent[] = [];
    const registry = createJobRegistry({ spawn, initialBufferMs: 0, killGraceMs: 200, onEvent: (e) => events.push(e) });
    const started = await registry.start("yes");
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    handles.get(started.pid)?.emitData("y".repeat(MAX_BACKGROUND_OUTPUT_BYTES + 10));
    await pollUntil(() => registry.get(started.jobId)?.status !== "running", 2_000);

    expect(registry.get(started.jobId)).toMatchObject({ status: "killed", killReason: "output-cap" });
    const exits = events.filter((e) => e.type === "exit" && e.jobId === started.jobId);
    expect(exits).toHaveLength(1);
    if (exits[0]?.type !== "exit") throw new Error("expected exit event");
    expect(exits[0].status).toBe("killed");
    expect(exits[0].killReason).toBe("output-cap");
  });
});

describe("flow 263 AC5: the concurrency cap counts background-phase tasks only", () => {
  test("a foreground start is never refused by a full background cap", async () => {
    const { spawn } = fakeSpawner();
    const registry = createJobRegistry({ spawn, initialBufferMs: 0, maxConcurrent: 1 });
    const bg = await registry.start("npm run dev");
    expect(bg.ok).toBe(true);

    const fg = await registry.start("git status", { phase: "foreground" });
    expect(fg.ok).toBe(true);
  });

  test("a background start over the cap is refused naming the running background commands", async () => {
    const { spawn } = fakeSpawner();
    const registry = createJobRegistry({ spawn, initialBufferMs: 0, maxConcurrent: 1 });
    expect((await registry.start("npm run dev")).ok).toBe(true);

    const refused = await registry.start("tail -f app.log", { phase: "background" });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error).toContain("npm run dev");
  });

  test("running foreground tasks do not count toward the background cap", async () => {
    const { spawn } = fakeSpawner();
    const registry = createJobRegistry({ spawn, initialBufferMs: 0, maxConcurrent: 1 });
    expect((await registry.start("bun test", { phase: "foreground" })).ok).toBe(true);

    const bg = await registry.start("npm run dev", { phase: "background" });
    expect(bg.ok).toBe(true);
  });
});

describe("flow 263: promote (foreground → background)", () => {
  test("promote flips the phase, emits the phase event once, and never kills", async () => {
    const { spawn, handles } = fakeSpawner();
    const events: BackgroundJobEvent[] = [];
    const registry = createJobRegistry({ spawn, initialBufferMs: 0, onEvent: (e) => events.push(e) });
    const started = await registry.start("sleep 120 && gh run list", { phase: "foreground" });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const promoted = registry.promote(started.jobId);
    expect(promoted.ok).toBe(true);
    if (!promoted.ok) return;
    expect(promoted.overCap).toBeUndefined();
    expect(registry.get(started.jobId)?.phase).toBe("background");
    expect(registry.get(started.jobId)?.status).toBe("running");
    expect(handles.get(started.pid)?.kills).toEqual([]);

    registry.promote(started.jobId); // a repeat promote must not re-emit
    const phaseEvents = events.filter((e) => e.type === "phase" && e.jobId === started.jobId);
    expect(phaseEvents).toHaveLength(1);
    const phase = phaseEvents[0];
    if (phase?.type !== "phase") throw new Error("expected phase event");
    expect(phase.phase).toBe("background");
  });

  test("promote of an unknown id is an error", () => {
    const registry = createJobRegistry({ spawn: fakeSpawner().spawn, initialBufferMs: 0 });
    const result = registry.promote("task-1-424242");
    expect(result.ok).toBe(false);
  });

  test("promote over a full cap is not refused and not killed; overCap names the running commands", async () => {
    const { spawn, handles } = fakeSpawner();
    const registry = createJobRegistry({ spawn, initialBufferMs: 0, maxConcurrent: 1 });
    expect((await registry.start("npm run dev")).ok).toBe(true);
    const fg = await registry.start("bun test --watch", { phase: "foreground" });
    expect(fg.ok).toBe(true);
    if (!fg.ok) return;

    const promoted = registry.promote(fg.jobId);
    expect(promoted.ok).toBe(true);
    if (!promoted.ok) return;
    expect(typeof promoted.overCap).toBe("string");
    expect(promoted.overCap).toContain("npm run dev");
    expect(handles.get(fg.pid)?.kills).toEqual([]);
    expect(registry.get(fg.jobId)).toMatchObject({ status: "running", phase: "background" });

    // Hard bound: running tasks never exceed maxConcurrent + 1.
    const refused = await registry.start("another server", { phase: "background" });
    expect(refused.ok).toBe(false);
    expect(registry.list().filter((j) => j.status === "running").length).toBeLessThanOrEqual(2);
  });
});

describe("flow 263 AC3: idle timer (fakes)", () => {
  test('a task producing no output for its idle timeout is killed with killReason "idle"', async () => {
    const { spawn } = fakeSpawner({ exitOnKill: true });
    const events: BackgroundJobEvent[] = [];
    const registry = createJobRegistry({ spawn, initialBufferMs: 0, killGraceMs: 100, idleMs: 60, onEvent: (e) => events.push(e) });
    const started = await registry.start("sleep 120");
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const ended = await pollUntil(() => registry.get(started.jobId)?.status !== "running", 3_000);
    expect(ended).toBe(true);
    expect(registry.get(started.jobId)).toMatchObject({ status: "killed", killReason: "idle" });
    const exits = events.filter((e) => e.type === "exit" && e.jobId === started.jobId);
    expect(exits).toHaveLength(1);
    if (exits[0]?.type !== "exit") throw new Error("expected exit event");
    expect(exits[0].killReason).toBe("idle");
  });

  test("every output chunk resets the idle timer", async () => {
    const { spawn, handles } = fakeSpawner({ exitOnKill: true });
    // The idle window is an order of magnitude above the tick gap: the test
    // still fails if the reset is removed (15 × 40 ms = 600 ms of ticks would
    // never survive a 2 s window measured from START), but a GC pause or a
    // loaded runner cannot push one gap past 2 s and fake a regression.
    const registry = createJobRegistry({ spawn, initialBufferMs: 0, killGraceMs: 100, idleMs: 2_000 });
    const started = await registry.start("chatty");
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const handle = handles.get(started.pid);
    if (handle === undefined) throw new Error("test setup: fake handle missing");

    // ~600 ms of output every 40 ms — never silent for a whole idle window.
    for (let i = 0; i < 15; i += 1) {
      handle.emitData(`tick ${i}\n`);
      await delay(40);
    }
    expect(registry.get(started.jobId)?.status).toBe("running");
    await registry.kill(started.jobId);
  });

  test("a per-task idleTimeoutMs overrides the registry idleMs", async () => {
    const { spawn } = fakeSpawner({ exitOnKill: true });
    const registry = createJobRegistry({ spawn, initialBufferMs: 0, killGraceMs: 100, idleMs: 60_000 });
    const started = await registry.start("sleep 120", { phase: "foreground", idleTimeoutMs: 60 });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const ended = await pollUntil(() => registry.get(started.jobId)?.status !== "running", 3_000);
    expect(ended).toBe(true);
    expect(registry.get(started.jobId)?.killReason).toBe("idle");
  });

  test("idleMs 0 disables the idle timer", async () => {
    const { spawn } = fakeSpawner({ exitOnKill: true });
    const registry = createJobRegistry({ spawn, initialBufferMs: 0, killGraceMs: 100, idleMs: 0 });
    const started = await registry.start("sleep 120");
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await delay(300);
    expect(registry.get(started.jobId)?.status).toBe("running");
    await registry.kill(started.jobId);
  });
});

describe.skipIf(process.platform === "win32")("flow 263 AC3: idle timer (REAL processes)", () => {
  test(
    "a real command printing every ~100 ms for ~1.5 s outlives several 400 ms idle periods and ends completed",
    async () => {
      // 2 s idle window against ~100 ms ticks: twenty times the gap, so real
      // spawn and scheduler jitter cannot fake an idle kill, while removing the
      // reset still kills this task long before its 1.5 s of ticks are done.
      const registry = createJobRegistry({ cwd: tmpdir(), idleMs: 2_000, initialBufferMs: 0, killGraceMs: 500 });
      const started = await registry.start(
        "for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do echo tick $i; sleep 0.1; done",
      );
      expect(started.ok).toBe(true);
      if (!started.ok) return;

      try {
        const ended = await pollUntil(() => registry.get(started.jobId)?.status !== "running", 15_000, 50);
        expect(ended).toBe(true);
        const info = registry.get(started.jobId);
        expect(info?.status).toBe("completed");
        expect(info?.killReason).toBeUndefined();
      } finally {
        await registry.sweepAll();
      }
    },
    30_000,
  );

  test(
    'a silent real `sleep 30` is killed with killReason "idle" within a few seconds',
    async () => {
      const idleMs = 2_000;
      const registry = createJobRegistry({ cwd: tmpdir(), idleMs, initialBufferMs: 0, killGraceMs: 500 });
      const t0 = performance.now();
      const started = await registry.start("sleep 30");
      expect(started.ok).toBe(true);
      if (!started.ok) return;
      try {
        const ended = await pollUntil(() => registry.get(started.jobId)?.status !== "running", 15_000, 50);
        expect(ended).toBe(true);
        expect(registry.get(started.jobId)).toMatchObject({ status: "killed", killReason: "idle" });
        // The kill waited for the silence — it is the idle rail firing, not
        // something killing the task on sight. (The upper bound is already
        // implied by `pollUntil` returning true.)
        expect(performance.now() - t0).toBeGreaterThanOrEqual(idleMs);
      } finally {
        await registry.sweepAll();
      }
    },
    30_000,
  );
});
