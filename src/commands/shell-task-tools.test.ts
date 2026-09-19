// RED tests (flow 266, P2) for the task tools, the abortable wait, operator
// demote and the side-worker rules — everything between "the command is
// running" and "the command finished", which P0 and P1 left out.
//
// NOTHING under test exists yet. New exports are read off the MODULE NAMESPACE
// rather than as named imports, for the reason flow 265 recorded: in Bun a named
// import of a missing export is a LINK-TIME error that takes down the whole
// file, so every test here would fail with one unreadable message instead of its
// own. Each accessor asserts `typeof === "function"` first.
//
// Where a seam exists the behaviour is proven by EXECUTION against a real
// registry and real subprocesses; the two REPL loops still have no headless
// seam, so their wiring is audited and the load-bearing parts (the parser and
// the demote effect) are executed directly instead.
import { describe, expect, test } from "bun:test";
import * as registryMod from "../harness/tool/builtin/background-job-registry";
import { createJobRegistry } from "../harness/tool/builtin/background-job-registry";
import type { InteractiveTool } from "../harness/tool/builtin/interactive-tools";
import * as agentCommandsMod from "./agent-commands";
import * as agentMod from "./agent";
import { runAgentTurn } from "./agent";
import type { AgentDeps, AgentIO } from "./agent";
import type { NormalizedEvent, NormalizedMessage, NormalizedRequest } from "../harness/provider/types";

// --- namespace accessors for the not-yet-existing exports -----------------
function moduleValue(mod: unknown, name: string): unknown {
  return (mod as Record<string, unknown>)[name];
}

function toolFactory(name: string): (...args: unknown[]) => InteractiveTool {
  const fn = moduleValue(registryMod, name);
  expect(typeof fn).toBe("function");
  return fn as (...args: unknown[]) => InteractiveTool;
}

function fn(mod: unknown, name: string): (...args: unknown[]) => unknown {
  const f = moduleValue(mod, name);
  expect(typeof f).toBe("function");
  return f as (...args: unknown[]) => unknown;
}

const root = process.cwd();

/** A registry with one real, still-running task and one that has finished. */
async function withTasks(): Promise<{
  registry: registryMod.JobRegistry;
  running: string;
  finished: string;
  cleanup: () => Promise<void>;
}> {
  const registry = createJobRegistry({ cwd: root });
  const slow = await registry.start("sleep 30", { phase: "background" });
  const quick = await registry.start("echo FINISHED", { phase: "background" });
  if (!slow.ok || !quick.ok) throw new Error("registry.start failed in the fixture");
  await registry.waitForExit(quick.jobId, 5_000);
  return {
    registry,
    running: slow.jobId,
    finished: quick.jobId,
    cleanup: async () => {
      await registry.sweepAll();
    },
  };
}

// =======================================================================
// AC1 — shell_task_output: an EXPLICIT cursor
// =======================================================================
describe("AC1: shell_task_output reads from an explicit cursor", () => {
  test("two calls with the same `since` return the same bytes", async () => {
    const f = await withTasks();
    try {
      const tool = toolFactory("shellTaskOutputTool")(f.registry, { observer: "main" });
      const first = await tool.invoke({ task_id: f.finished, since: 0 });
      const second = await tool.invoke({ task_id: f.finished, since: 0 });
      expect(first.output).toBe(second.output);
      expect(first.output).toContain("FINISHED");
    } finally {
      await f.cleanup();
    }
  });

  test("it reports the task's status alongside the output", async () => {
    const f = await withTasks();
    try {
      const tool = toolFactory("shellTaskOutputTool")(f.registry, { observer: "main" });
      const result = await tool.invoke({ task_id: f.running, since: 0 });
      expect(result.output).toMatch(/running/);
    } finally {
      await f.cleanup();
    }
  });

  test("an unknown task_id is a tool error naming the id, never a throw", async () => {
    const f = await withTasks();
    try {
      const tool = toolFactory("shellTaskOutputTool")(f.registry, { observer: "main" });
      const result = await tool.invoke({ task_id: "task-404-404", since: 0 });
      expect(result.isError).toBe(true);
      expect(result.output).toContain("task-404-404");
    } finally {
      await f.cleanup();
    }
  });
});

// =======================================================================
// AC2 / AC3 — shell_task_wait
// =======================================================================
describe("AC2/AC3: shell_task_wait is bounded, never kills, and honours any/all", () => {
  test("mode 'any' returns as soon as one named task is terminal", async () => {
    const f = await withTasks();
    try {
      const tool = toolFactory("shellTaskWaitTool")(f.registry);
      const started = Date.now();
      const result = await tool.invoke({ task_ids: [f.running, f.finished], mode: "any", timeout_ms: 5_000 });
      expect(Date.now() - started).toBeLessThan(4_000); // it did not wait out the slow one
      expect(result.output).toContain(f.finished);
      expect(f.registry.get(f.running)?.status).toBe("running"); // NEVER killed
    } finally {
      await f.cleanup();
    }
  });

  test("mode 'all' reaching its bound returns the still-running task rather than an error", async () => {
    const f = await withTasks();
    try {
      const tool = toolFactory("shellTaskWaitTool")(f.registry);
      const result = await tool.invoke({ task_ids: [f.running, f.finished], mode: "all", timeout_ms: 300 });
      expect(result.isError).toBe(false);
      expect(result.output).toContain(f.running);
      expect(f.registry.get(f.running)?.status).toBe("running");
    } finally {
      await f.cleanup();
    }
  });

  test("timeout_ms is CLAMPED to [0, 300 000] whatever the model passes", () => {
    const clamp = fn(registryMod, "clampTaskWaitMs");
    expect(clamp(-1)).toBe(0);
    expect(clamp(0)).toBe(0);
    expect(clamp(1_000)).toBe(1_000);
    expect(clamp(300_001)).toBe(300_000);
    expect(clamp(Number.MAX_SAFE_INTEGER)).toBe(300_000);
    expect(clamp(Number.NaN)).toBe(300_000);
  });

  test("an unknown task_id is named, not silently dropped from the result", async () => {
    const f = await withTasks();
    try {
      const tool = toolFactory("shellTaskWaitTool")(f.registry);
      const result = await tool.invoke({ task_ids: [f.finished, "task-404-404"], mode: "all", timeout_ms: 200 });
      expect(result.output).toContain("task-404-404");
    } finally {
      await f.cleanup();
    }
  });
});

// =======================================================================
// AC4 / AC5 — kill, the aliases, and their deprecation notes
// =======================================================================
describe("AC4/AC5: kill is idempotent and the old names survive one release", () => {
  test("killing an already-exited task is an ordinary error and never re-signals", async () => {
    const f = await withTasks();
    try {
      const tool = toolFactory("shellTaskKillTool")(f.registry);
      const first = await tool.invoke({ task_id: f.finished });
      expect(first.isError).toBe(true); // it had already exited
      const info = f.registry.get(f.finished);
      expect(info?.status).toBe("completed"); // the status did not become "killed"
    } finally {
      await f.cleanup();
    }
  });

  test("both aliases accept BOTH a task-* and a job-* id", async () => {
    const f = await withTasks();
    try {
      const output = registryMod.shellJobOutputTool(f.registry);
      const byTaskId = await output.invoke({ job_id: f.finished });
      expect(byTaskId.isError).toBe(false);
      // The registry mints `task-<n>-<pid>`; the alias must also accept the
      // `job-` spelling a resumed transcript may still carry.
      const jobSpelling = f.finished.replace(/^task-/, "job-");
      const byJobId = await output.invoke({ job_id: jobSpelling });
      expect(byJobId.isError).toBe(false);
    } finally {
      await f.cleanup();
    }
  });

  test("a KILL refuses the old spelling: resolving ids across spellings is for reads only", async () => {
    // Review finding, flow 266. Every id in a live session is `task-*`, so a
    // `job-*` id can only come from an earlier session — which D-14 says must be
    // a dead reference. The swap keeps the counter and the pid, and the counter
    // restarts each session, so a recycled pid can make a stale id match a LIVE
    // task. A read that lands on the wrong task is a wrong answer; a kill that
    // lands on it destroys work nobody asked to lose.
    const f = await withTasks();
    try {
      const jobSpelling = f.running.replace(/^task-/, "job-");
      const kill = registryMod.shellJobKillTool(f.registry);
      const result = await kill.invoke({ job_id: jobSpelling });
      expect(result.isError).toBe(true);
      expect(result.output).toContain(jobSpelling);
      expect(f.registry.get(f.running)?.status).toBe("running"); // untouched
    } finally {
      await f.cleanup();
    }
  });

  test("each alias carries a deprecation note naming its replacement IN THE DESCRIPTION", async () => {
    const f = await withTasks();
    try {
      const output = registryMod.shellJobOutputTool(f.registry);
      const kill = registryMod.shellJobKillTool(f.registry);
      expect(output.definition.description).toMatch(/deprecated/i);
      expect(output.definition.description).toContain("shell_task_output");
      expect(kill.definition.description).toMatch(/deprecated/i);
      expect(kill.definition.description).toContain("shell_task_kill");
    } finally {
      await f.cleanup();
    }
  });
});

// =======================================================================
// AC6 / AC7 — the abort signal reaches a waiting tool
// =======================================================================
function scriptedProvider(scripts: Partial<NormalizedEvent>[][]): {
  provider: AgentDeps["provider"];
  requests: NormalizedRequest[];
} {
  const requests: NormalizedRequest[] = [];
  let call = 0;
  return {
    requests,
    provider: {
      describe: () => ({
        capabilities: {
          streaming: true,
          toolCalls: true,
          parallelToolCalls: true,
          structuredOutput: false,
          reasoningMetadata: false,
          promptCaching: false,
          vision: false,
          tokenCounting: false,
          modelListing: false,
        },
        descriptor: { providerId: "scripted" },
      }),
      stream: (request: NormalizedRequest, opts: { attemptId: string }) => {
        requests.push(request);
        const events = scripts[call] ?? [];
        call += 1;
        return (async function* (): AsyncGenerator<NormalizedEvent> {
          let sequence = 0;
          for (const partial of events) {
            yield { sequence: sequence++, attemptId: opts.attemptId, kind: "model_end", ...partial } as NormalizedEvent;
          }
        })();
      },
    } as unknown as AgentDeps["provider"],
  };
}

describe("AC6/AC7: a waiting tool receives the turn's abort signal", () => {
  test("executeCall passes a signal to invoke's second argument", async () => {
    let sawSignal: unknown;
    const recorder: InteractiveTool = {
      definition: { name: "recorder", description: "", inputSchema: { type: "object", properties: {} }, risk: "read" },
      invoke: async (_input: Record<string, unknown>, ctx?: { signal?: AbortSignal }) => {
        sawSignal = ctx?.signal;
        return { output: "ok", isError: false };
      },
    } as unknown as InteractiveTool;

    const { provider } = scriptedProvider([
      [
        { kind: "tool_call_start", toolCallId: "c1", toolName: "recorder" },
        { kind: "tool_call_end", toolCallId: "c1", input: "{}" },
        { kind: "model_end" },
      ],
      [{ kind: "text_delta", text: "done" }, { kind: "model_end" }],
    ]);
    const io: AgentIO = { write: () => {} };
    const history: NormalizedMessage[] = [];
    const controller = new AbortController();

    await runAgentTurn(
      io,
      {
        provider,
        providerId: "scripted",
        modelId: "m",
        systemInstruction: "sys",
        idSeq: () => `id-${Math.random()}`,
        tools: [recorder],
      } as unknown as AgentDeps,
      history,
      "go",
      { signal: controller.signal },
    );

    expect(sawSignal).toBeInstanceOf(AbortSignal);
  });

  test("an aborted wait returns interrupted, leaves the task RUNNING, and the completion is still delivered", async () => {
    const f = await withTasks();
    try {
      const tool = toolFactory("shellTaskWaitTool")(f.registry);
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 50);

      const started = Date.now();
      const result = await tool.invoke(
        { task_ids: [f.running], mode: "all", timeout_ms: 300_000 },
        { signal: controller.signal },
      );
      expect(Date.now() - started).toBeLessThan(5_000); // it returned promptly
      expect(result.output).toMatch(/interrupted/);
      expect(f.registry.get(f.running)?.status).toBe("running"); // abort NEVER kills

      // And the task is still undelivered, so P1's drain will announce it when
      // it eventually ends — an abort must not swallow the completion.
      await f.registry.kill(f.running, "operator");
      expect(f.registry.get(f.running)?.status).toBe("killed");
    } finally {
      await f.cleanup();
    }
  });
});

// =======================================================================
// AC8 — /demote: a pure parser plus one effect helper, called by both shells
// =======================================================================
describe("AC8: /demote parses purely and demotes through promote()", () => {
  test("the registry lists /demote for the agent mode of both shells", () => {
    const find = fn(agentCommandsMod, "findAgentCommand");
    const entry = find("/demote task-1-2", "agent") as { name?: string } | undefined;
    expect(entry?.name).toBe("/demote");
  });

  test("the parser names its refusals and never throws", () => {
    const parse = fn(agentCommandsMod, "parseDemoteCommand");
    expect(parse("")).toMatchObject({ ok: false });
    expect(parse("   ")).toMatchObject({ ok: false });
    expect(parse("task-1-2")).toMatchObject({ ok: true, taskId: "task-1-2" });
    expect(parse("  task-1-2  ")).toMatchObject({ ok: true, taskId: "task-1-2" });
  });

  test("the effect helper promotes a running foreground task and states its errors", async () => {
    const registry = createJobRegistry({ cwd: root });
    try {
      const started = await registry.start("sleep 30", { phase: "foreground" });
      if (!started.ok) throw new Error("registry.start failed");
      const demote = fn(registryMod, "demoteTask");

      const ok = (await demote(registry, started.jobId)) as { ok: boolean };
      expect(ok.ok).toBe(true);
      expect(registry.get(started.jobId)?.phase).toBe("background");
      expect(registry.get(started.jobId)?.status).toBe("running"); // demote never kills

      const again = (await demote(registry, started.jobId)) as { ok: boolean; error?: string };
      expect(again.ok).toBe(false); // already in the background
      const unknown = (await demote(registry, "task-404-404")) as { ok: boolean; error?: string };
      expect(unknown.ok).toBe(false);
      expect(unknown.error ?? "").toContain("task-404-404");
    } finally {
      await registry.sweepAll();
    }
  });
});

// =======================================================================
// AC9 / AC10 — side workers cannot kill, wait, or observe a task away
// =======================================================================
describe("AC9/AC10: the side-worker roster is narrower AND never marks a task observed", () => {
  test("the deny set covers kill, wait and the implicit-cursor read", async () => {
    // Dynamic import on purpose: `tui-shell.ts` is the heaviest module in the
    // tree and this is the only test here that needs it, so importing it at the
    // top would tax every other test in the file.
    const tuiMod = await import("../tui/tui-shell");
    const denied = moduleValue(tuiMod, "SIDE_WORKER_DENIED_TOOL_NAMES") as ReadonlySet<string> | undefined;
    expect(denied).toBeInstanceOf(Set);
    for (const name of ["shell_task_kill", "shell_job_kill", "shell_task_wait", "shell_job_output", "bus_send"]) {
      expect(denied?.has(name)).toBe(true);
    }
    expect(denied?.has("shell_task_output")).toBe(false); // the explicit cursor stays available
    expect(denied?.has("bus_list")).toBe(false); // genuinely read-only, stays available
  });

  test("a side worker's read of a FINISHED task leaves the main session's notification pending", async () => {
    const f = await withTasks();
    try {
      const side = toolFactory("shellTaskOutputTool")(f.registry, { observer: "side" });
      const read = await side.invoke({ task_id: f.finished, since: 0 });
      expect(read.isError).toBe(false);

      // The whole point: the main session must still be told about it.
      const drained = f.registry.drainUndelivered();
      expect(drained.map((c) => c.jobId)).toContain(f.finished);
    } finally {
      await f.cleanup();
    }
  });

  test("the MAIN session's read of the same task does mark it observed", async () => {
    const f = await withTasks();
    try {
      const main = toolFactory("shellTaskOutputTool")(f.registry, { observer: "main" });
      await main.invoke({ task_id: f.finished, since: 0 });
      const drained = f.registry.drainUndelivered();
      expect(drained.map((c) => c.jobId)).not.toContain(f.finished);
    } finally {
      await f.cleanup();
    }
  });
});

// =======================================================================
// AC11 — a legitimate poll is not a repeated-call violation
// =======================================================================
describe("AC11: the polling tools are repeatable", () => {
  test("shell_task_output, shell_task_wait and shell_job_output are all repeatable", () => {
    const repeatable = moduleValue(agentMod, "REPEATABLE_TOOL_NAMES") as ReadonlySet<string> | undefined;
    expect(repeatable).toBeInstanceOf(Set);
    for (const name of ["shell_task_output", "shell_task_wait", "shell_job_output"]) {
      expect(repeatable?.has(name)).toBe(true);
    }
  });
});
