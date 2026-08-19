import { afterEach, describe, expect, test } from "bun:test";
import { setJobFleetListener, type JobFleetEvent } from "../../../tui/job-bridge";
import {
  backgroundJobTools,
  JobRegistry,
  MAX_CONCURRENT_JOBS,
  MAX_LINE_LEN,
  type JobProcess,
  type JobSpawnFn,
} from "./background-job-tool";

/** A stream + a way to push text into it / close it, for a controllable fake process. */
function fakeStream(): { stream: ReadableStream<Uint8Array>; push: (s: string) => void; close: () => void } {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const enc = new TextEncoder();
  return {
    stream,
    push: (s: string) => controller.enqueue(enc.encode(s)),
    close: () => controller.close(),
  };
}

function fakeProcess(pid = 4242): {
  proc: JobProcess;
  stdout: ReturnType<typeof fakeStream>;
  stderr: ReturnType<typeof fakeStream>;
  resolveExit: (code: number) => void;
  killed: Array<NodeJS.Signals | number | undefined>;
} {
  const stdout = fakeStream();
  const stderr = fakeStream();
  const killed: Array<NodeJS.Signals | number | undefined> = [];
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  const proc: JobProcess = {
    pid,
    stdout: stdout.stream,
    stderr: stderr.stream,
    exited,
    kill: (signal) => {
      killed.push(signal);
    },
  };
  return { proc, stdout, stderr, resolveExit, killed };
}

function toolByName(tools: ReturnType<typeof backgroundJobTools>, name: string) {
  const t = tools.find((tool) => tool.definition.name === name);
  if (t === undefined) throw new Error(`missing tool ${name}`);
  return t;
}

const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));

describe("background-job-tool", () => {
  afterEach(() => {
    setJobFleetListener(undefined);
  });

  test("start_job/watch_job/stop_job are risk shell; job_output/list_jobs are risk read", () => {
    const tools = backgroundJobTools("/proj", new JobRegistry(), () => fakeProcess().proc);
    expect(toolByName(tools, "start_job").definition.risk).toBe("shell");
    expect(toolByName(tools, "watch_job").definition.risk).toBe("shell");
    expect(toolByName(tools, "stop_job").definition.risk).toBe("shell");
    expect(toolByName(tools, "job_output").definition.risk).toBe("read");
    expect(toolByName(tools, "list_jobs").definition.risk).toBe("read");
  });

  test("start_job rejects a missing command WITHOUT spawning", async () => {
    let spawned = false;
    const tools = backgroundJobTools("/proj", new JobRegistry(), () => {
      spawned = true;
      return fakeProcess().proc;
    });
    const result = await toolByName(tools, "start_job").invoke({});
    expect(result.isError).toBe(true);
    expect(spawned).toBe(false);
  });

  test("start_job returns immediately and spawns via the SAME argv prepareCommandSpawn resolves as shell_exec (sandbox off)", async () => {
    const prev = process.env.KERYX_SANDBOX_SHELL;
    delete process.env.KERYX_SANDBOX_SHELL;
    try {
      let capturedArgs: string[] | undefined;
      const spawn: JobSpawnFn = (spawnArgs) => {
        capturedArgs = spawnArgs;
        return fakeProcess().proc;
      };
      const tools = backgroundJobTools("/proj", new JobRegistry(), spawn);
      const result = await toolByName(tools, "start_job").invoke({ command: "echo hi" });
      expect(result.isError).toBe(false);
      expect(result.output).toContain("job:1");
      // Same argv shape shell-exec-tool.ts's own default (unsandboxed) path uses.
      expect(capturedArgs).toEqual(["/bin/sh", "-c", "echo hi"]);
    } finally {
      if (prev !== undefined) process.env.KERYX_SANDBOX_SHELL = prev;
    }
  });

  test("start_job: sidebar sees running then done, with the last output line as detail", async () => {
    const events: JobFleetEvent[] = [];
    setJobFleetListener((e) => events.push(e));
    const fp = fakeProcess();
    const tools = backgroundJobTools("/proj", new JobRegistry(), () => fp.proc);
    const result = await toolByName(tools, "start_job").invoke({ command: "echo hi", label: "t1" });
    expect(result.isError).toBe(false);
    await tick();
    expect(events.some((e) => e.kind === "upsert" && e.status === "running")).toBe(true);

    fp.stdout.push("building…\n");
    await tick();
    fp.stdout.close();
    fp.stderr.close();
    fp.resolveExit(0);
    await tick();

    const last = events[events.length - 1];
    expect(last).toMatchObject({ kind: "upsert", status: "done" });
  });

  test("start_job: non-zero exit is reported as failed", async () => {
    const events: JobFleetEvent[] = [];
    setJobFleetListener((e) => events.push(e));
    const fp = fakeProcess();
    const tools = backgroundJobTools("/proj", new JobRegistry(), () => fp.proc);
    await toolByName(tools, "start_job").invoke({ command: "false" });
    fp.stdout.close();
    fp.stderr.close();
    fp.resolveExit(1);
    await tick();
    const last = events[events.length - 1];
    expect(last).toMatchObject({ kind: "upsert", status: "failed" });
  });

  test("watch_job counts one event per completed stdout line and never emits to the transcript (sidebar-only)", async () => {
    const registry = new JobRegistry();
    const fp = fakeProcess();
    const tools = backgroundJobTools("/proj", registry, () => fp.proc);
    const result = await toolByName(tools, "watch_job").invoke({ command: "tail -f x", persistent: true });
    expect(result.isError).toBe(false);
    const id = result.output.split(" ").pop() as string;

    fp.stdout.push("FAIL test/a.ts\n");
    fp.stdout.push("FAIL test/b.ts\n");
    await tick();

    const output = await toolByName(tools, "job_output").invoke({ id });
    expect(output.output).toContain("watch");
    expect(output.output).toContain("FAIL test/a.ts");
    expect(output.output).toContain("FAIL test/b.ts");

    // persistent: true — no timeout fired, job is still running.
    expect(output.output).toContain("running");
  });

  test("watch_job without persistent is killed after timeout_ms (floor is 1000ms, matching Monitor's own contract)", async () => {
    const fp = fakeProcess();
    const tools = backgroundJobTools("/proj", new JobRegistry(), () => fp.proc);
    await toolByName(tools, "watch_job").invoke({ command: "tail -f x", timeout_ms: 1_000 });
    await tick(1_100);
    expect(fp.killed).toContain("SIGTERM");
  }, 5_000);

  test("a below-floor timeout_ms is clamped up to the 1000ms floor, not fired early", async () => {
    const fp = fakeProcess();
    const tools = backgroundJobTools("/proj", new JobRegistry(), () => fp.proc);
    await toolByName(tools, "watch_job").invoke({ command: "tail -f x", timeout_ms: 100 });
    await tick(300);
    // 300ms after a 100ms request: still nothing killed if the clamp raised
    // it to the 1000ms floor rather than firing at the requested 100ms.
    expect(fp.killed).toHaveLength(0);
    await tick(900); // total ~1200ms — past the 1000ms floor
    expect(fp.killed).toContain("SIGTERM");
  }, 5_000);

  test("F-101 regression: stopping a watch_job just before its timeout fires leaves it 'stopped', not overwritten to 'timeout'", async () => {
    const events: JobFleetEvent[] = [];
    setJobFleetListener((e) => events.push(e));
    const fp = fakeProcess();
    const tools = backgroundJobTools("/proj", new JobRegistry(), () => fp.proc);
    const started = await toolByName(tools, "watch_job").invoke({ command: "tail -f x", timeout_ms: 1_000 });
    const id = started.output.split(" ").pop() as string;

    const stopPromise = toolByName(tools, "stop_job").invoke({ id });
    await tick(); // let stop()'s synchronous prefix (status="done", before any await) run
    fp.stdout.close();
    fp.stderr.close();
    fp.resolveExit(143);
    await stopPromise;

    // Long enough for the 1000ms watch-timeout to have fired too, if its
    // `status !== "running"` race guard failed to see the stop.
    await tick(1_100);

    const output = await toolByName(tools, "job_output").invoke({ id });
    expect(output.output).toContain("status: done");
    const last = events[events.length - 1];
    expect(last).toMatchObject({ kind: "upsert", status: "done", detail: "stopped" });
    // Exactly one SIGTERM: the watch-timeout handler must have skipped its
    // own kill once it saw the job was no longer "running".
    expect(fp.killed.filter((s) => s === "SIGTERM")).toHaveLength(1);
  }, 5_000);

  test("job_output reports an unknown id as an error", async () => {
    const tools = backgroundJobTools("/proj", new JobRegistry(), () => fakeProcess().proc);
    const result = await toolByName(tools, "job_output").invoke({ id: "job:999" });
    expect(result.isError).toBe(true);
  });

  test("list_jobs lists every job still tracked, by id/label/kind/status", async () => {
    const fp = fakeProcess();
    const tools = backgroundJobTools("/proj", new JobRegistry(), () => fp.proc);
    await toolByName(tools, "start_job").invoke({ command: "sleep 1", label: "sleeper" });
    const result = await toolByName(tools, "list_jobs").invoke({});
    expect(result.output).toContain("job:1");
    expect(result.output).toContain("sleeper");
    expect(result.output).toContain("running");
  });

  test("stop_job SIGTERMs a running job and updates status", async () => {
    const events: JobFleetEvent[] = [];
    setJobFleetListener((e) => events.push(e));
    const fp = fakeProcess();
    const tools = backgroundJobTools("/proj", new JobRegistry(), () => fp.proc);
    const started = await toolByName(tools, "start_job").invoke({ command: "sleep 100" });
    const id = started.output.split(" ").pop() as string;

    const stopPromise = toolByName(tools, "stop_job").invoke({ id });
    await tick();
    expect(fp.killed).toContain("SIGTERM");
    fp.stdout.close();
    fp.stderr.close();
    fp.resolveExit(143);
    const stopResult = await stopPromise;
    expect(stopResult.isError).toBe(false);

    // F-106: the test's own name claims "updates status" — actually check it
    // (this is exactly how F-101, status stuck at "running" forever after a
    // stop, shipped undetected).
    const output = await toolByName(tools, "job_output").invoke({ id });
    expect(output.output).toContain("status: done");
    const listed = await toolByName(tools, "list_jobs").invoke({});
    expect(listed.output).not.toContain("running");
  });

  test("stop_job on an unknown id is an error", async () => {
    const tools = backgroundJobTools("/proj", new JobRegistry(), () => fakeProcess().proc);
    const result = await toolByName(tools, "stop_job").invoke({ id: "job:404" });
    expect(result.isError).toBe(true);
  });

  test("a concurrency cap refuses further start_job calls without spawning", async () => {
    let spawnCount = 0;
    const registry = new JobRegistry();
    const procs: ReturnType<typeof fakeProcess>[] = [];
    const tools = backgroundJobTools("/proj", registry, () => {
      spawnCount += 1;
      const fp = fakeProcess();
      procs.push(fp);
      return fp.proc;
    });
    for (let i = 0; i < MAX_CONCURRENT_JOBS; i++) {
      const result = await toolByName(tools, "start_job").invoke({ command: `sleep ${i}` });
      expect(result.isError).toBe(false);
    }
    expect(spawnCount).toBe(MAX_CONCURRENT_JOBS);
    const refused = await toolByName(tools, "start_job").invoke({ command: "sleep 999" });
    expect(refused.isError).toBe(true);
    expect(refused.output).toContain("too many concurrent jobs");
    expect(spawnCount).toBe(MAX_CONCURRENT_JOBS); // the refused call never spawned
  });

  test("F-001 regression: newline-sparse output (a \\r-only progress meter, or one giant unterminated line) never grows the buffer unbounded", async () => {
    const fp = fakeProcess();
    const tools = backgroundJobTools("/proj", new JobRegistry(), () => fp.proc);
    const started = await toolByName(tools, "start_job").invoke({ command: "progress" });
    const id = started.output.split(" ").pop() as string;

    // No "\n" anywhere in this push — exactly what a `\r`-only progress meter,
    // or a build tool emitting one very large stats line, looks like.
    const chunk = "x".repeat(MAX_LINE_LEN * 5);
    fp.stdout.push(chunk);
    await tick();

    const output = await toolByName(tools, "job_output").invoke({ id, tail: 100 });
    // The stream is still open (never closed/exited) — this MUST already have
    // flushed mid-stream, proving the bound applies to the live accumulator,
    // not just to whatever gets pushed once the stream eventually ends.
    expect(output.output).not.toContain("no output yet");
    for (const line of output.output.split("\n")) {
      // +1 for the clip()'s trailing "…" ellipsis character.
      expect(line.length).toBeLessThanOrEqual(MAX_LINE_LEN + 1);
    }
  });

  test("F-102 regression: a burst of many short newline-terminated lines in ONE chunk is split, not collapsed into one clipped blob", async () => {
    const fp = fakeProcess();
    const tools = backgroundJobTools("/proj", new JobRegistry(), () => fp.proc);
    const started = await toolByName(tools, "start_job").invoke({ command: "chatty" });
    const id = started.output.split(" ").pop() as string;

    // 100 short, complete, newline-terminated lines delivered in ONE pipe
    // read — combined length is well past MAX_LINE_LEN, but every line is
    // short and properly terminated. This must NOT be flushed as one blob.
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`);
    fp.stdout.push(`${lines.join("\n")}\n`);
    await tick();

    const output = await toolByName(tools, "job_output").invoke({ id, tail: 200 });
    expect(output.output).toContain("line 0");
    expect(output.output).toContain("line 50");
    expect(output.output).toContain("line 99");
    // Every real line intact, not merged/truncated into one clipped chunk.
    for (const l of lines) {
      expect(output.output).toContain(l);
    }
  });

  test("killAll terminates every job still running and resolves once they exit", async () => {
    const registry = new JobRegistry();
    const fps = [fakeProcess(), fakeProcess()];
    let n = 0;
    const tools = backgroundJobTools("/proj", registry, () => fps[n++]!.proc);
    await toolByName(tools, "start_job").invoke({ command: "sleep 1" });
    await toolByName(tools, "start_job").invoke({ command: "sleep 1" });

    const killAllPromise = registry.killAll();
    await tick();
    expect(fps[0]!.killed).toContain("SIGTERM");
    expect(fps[1]!.killed).toContain("SIGTERM");
    fps[0]!.stdout.close();
    fps[0]!.stderr.close();
    fps[0]!.resolveExit(143);
    fps[1]!.stdout.close();
    fps[1]!.stderr.close();
    fps[1]!.resolveExit(143);
    await killAllPromise; // must resolve, not hang
  });
});
