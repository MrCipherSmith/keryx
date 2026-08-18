import { expect, test } from "bun:test";
import {
  createSpawnSubagentTool,
  ENV_SUBAGENT_LEDGER_MAX_TOOL_CALLS,
  ENV_SUBAGENT_TIMEOUT_MS,
} from "./spawn-subagent-tool";
import type { NormalizedEvent, ProviderPort, StreamOptions } from "../../provider/types";
import { setSubagentFleetListener, type SubagentFleetEvent } from "../../../tui/subagent-bridge";

function stubProvider(text: string): ProviderPort {
  return {
    describe() {
      return {
        capabilities: {
          streaming: true,
          toolCalls: false,
          parallelToolCalls: false,
          structuredOutput: false,
          reasoningMetadata: false,
          promptCaching: false,
          vision: false,
          tokenCounting: false,
          modelListing: false,
        },
        descriptor: { providerId: "stub" },
      };
    },
    async *stream(_req, opts: StreamOptions): AsyncIterable<NormalizedEvent> {
      yield { kind: "text_delta", sequence: 0, attemptId: opts.attemptId, text };
      yield { kind: "model_end", sequence: 1, attemptId: opts.attemptId };
    },
  };
}

test("spawn_subagent runs a child turn and returns a summary", async () => {
  const tool = createSpawnSubagentTool({
    cwd: process.cwd(),
    getParentModel: () => ({ providerId: "ollama", modelId: "fake" }),
    makeProvider: () => stubProvider("Child found 2 issues in auth."),
    getDetectedProviders: () => [{ name: "ollama" }],
    idSeq: (() => {
      let n = 0;
      return () => `id-${n++}`;
    })(),
    clock: () => "2020-01-01T00:00:00.000Z",
  });
  expect(tool.definition.name).toBe("spawn_subagent");
  expect(tool.definition.risk).toBe("delegate");

  const result = await tool.invoke({
    task: "Review auth module briefly",
    mode: "read_only",
    label: "auth-check",
  });
  expect(result.isError).toBe(false);
  expect(result.output).toMatch(/subagent auth-check/);
  expect(result.output).toMatch(/Child found 2 issues/);
  expect(result.output).toMatch(/MAE reservation/);
});

test("default per-child tool-call budget is 10 (was 6) when max_tool_calls is omitted", async () => {
  const tool = createSpawnSubagentTool({
    cwd: process.cwd(),
    getParentModel: () => ({ providerId: "ollama", modelId: "fake" }),
    makeProvider: () => stubProvider("ok"),
    getDetectedProviders: () => [{ name: "ollama" }],
    idSeq: (() => {
      let n = 0;
      return () => `id-${n++}`;
    })(),
    clock: () => "2020-01-01T00:00:00.000Z",
  });
  const result = await tool.invoke({ task: "investigate", mode: "read_only" });
  expect(result.output).toMatch(/tools≤10\b/);
});

test("per-child tool-call cap is 24 (was 16) even when the model asks for more", async () => {
  const tool = createSpawnSubagentTool({
    cwd: process.cwd(),
    getParentModel: () => ({ providerId: "ollama", modelId: "fake" }),
    makeProvider: () => stubProvider("ok"),
    getDetectedProviders: () => [{ name: "ollama" }],
    idSeq: (() => {
      let n = 0;
      return () => `id-${n++}`;
    })(),
    clock: () => "2020-01-01T00:00:00.000Z",
  });
  const result = await tool.invoke({ task: "investigate", mode: "read_only", max_tool_calls: 999 });
  expect(result.output).toMatch(/tools≤24\b/);
});

test("onLedgerReady hands back a working resetBudget the tool keeps functioning after", async () => {
  let resetBudget: (() => void) | undefined;
  const tool = createSpawnSubagentTool({
    cwd: process.cwd(),
    getParentModel: () => ({ providerId: "ollama", modelId: "fake" }),
    makeProvider: () => stubProvider("ok"),
    getDetectedProviders: () => [{ name: "ollama" }],
    idSeq: (() => {
      let n = 0;
      return () => `id-${n++}`;
    })(),
    clock: () => "2020-01-01T00:00:00.000Z",
    onLedgerReady: (controls) => {
      resetBudget = controls.resetBudget;
    },
  });
  expect(resetBudget).toBeDefined();
  resetBudget?.();
  const result = await tool.invoke({ task: "investigate after reset", mode: "read_only" });
  expect(result.isError).toBe(false);
  expect(result.output).toMatch(/tools≤10\b/);
});

test("spawn_subagent inherits network LLM parent (deepseek) under tools-readonly policy", async () => {
  let seenProvider = "";
  const tool = createSpawnSubagentTool({
    cwd: process.cwd(),
    getParentModel: () => ({ providerId: "deepseek", modelId: "deepseek-v4-flash" }),
    makeProvider: (providerId) => {
      seenProvider = providerId;
      return stubProvider(`ok via ${providerId}`);
    },
    getDetectedProviders: () => [{ name: "deepseek" }, { name: "ollama" }],
    idSeq: (() => {
      let n = 0;
      return () => `ds-${n++}`;
    })(),
    clock: () => "2020-01-01T00:00:00.000Z",
  });
  const result = await tool.invoke({
    task: "List three risks in side-worker.ts",
    mode: "read_only",
  });
  expect(result.isError).toBe(false);
  expect(result.output).not.toMatch(/model resolution denied|forbidden by child policy/);
  expect(seenProvider).toBe("deepseek");
  expect(result.output).toMatch(/ok via deepseek/);
});

test("spawn_subagent rejects empty task", async () => {
  const tool = createSpawnSubagentTool({
    cwd: process.cwd(),
    getParentModel: () => ({ providerId: "ollama", modelId: "fake" }),
    makeProvider: () => stubProvider("x"),
    getDetectedProviders: () => [{ name: "ollama" }],
  });
  const result = await tool.invoke({ task: "  " });
  expect(result.isError).toBe(true);
});

test("AC3/AC5: spawn_subagent emits task + text log and does not auto-remove", async () => {
  const events: SubagentFleetEvent[] = [];
  setSubagentFleetListener((event) => {
    events.push(event);
  });
  try {
    const tool = createSpawnSubagentTool({
      cwd: process.cwd(),
      getParentModel: () => ({ providerId: "ollama", modelId: "fake" }),
      makeProvider: () => stubProvider("Child found 2 issues in auth."),
      getDetectedProviders: () => [{ name: "ollama" }],
      idSeq: (() => {
        let n = 0;
        return () => `id-${n++}`;
      })(),
      clock: () => "2020-01-01T00:00:00.000Z",
    });
    const result = await tool.invoke({
      task: "Review auth module briefly",
      mode: "read_only",
      label: "auth-check",
    });
    expect(result.isError).toBe(false);
    expect(events.some((event) => event.kind === "remove")).toBe(false);
    const upsert = events.find((event) => event.kind === "upsert" && event.status === "running");
    expect(upsert?.kind === "upsert" ? upsert.task : undefined).toBe("Review auth module briefly");
    const textLog = events.find((event) => event.kind === "log" && event.entry.kind === "text");
    expect(textLog?.kind === "log" ? textLog.entry.text : "").toContain("Child found 2 issues");
    const done = events.find((event) => event.kind === "upsert" && event.status === "done");
    expect(done).toBeDefined();
  } finally {
    setSubagentFleetListener(undefined);
  }
});

// --- D2 (flow 171, Phase D): SubagentCompletionStatus per-status coverage ---
//
// AC5/AC6/AC7/AC8. Each test drives one `SubagentCompletionStatus` value
// deterministically (no real sleeps, no flaky timing beyond the existing
// `ENV_SUBAGENT_TIMEOUT_MS`-driven timeout test already established by
// `spawn-subagent-lifecycle.test.ts`).

const PROBE_CAPABILITIES = {
  streaming: true,
  toolCalls: true,
  parallelToolCalls: false,
  structuredOutput: false,
  reasoningMetadata: false,
  promptCaching: false,
  vision: false,
  tokenCounting: false,
  modelListing: false,
};

/** A provider that never yields and never returns — mirrors `spawn-subagent-lifecycle.test.ts`. */
function hangingProvider(): ProviderPort {
  return {
    describe: () => ({ capabilities: PROBE_CAPABILITIES, descriptor: { providerId: "hanging" } }),
    stream: () =>
      (async function* (): AsyncGenerator<NormalizedEvent> {
        await new Promise(() => {});
      })(),
  };
}

/**
 * Issues a NEW, distinct tool-call signature every round (`probe_1`,
 * `probe_2`, …) — with a tiny `max_tool_calls` budget this exhausts the
 * child's own total unique-signature budget (`kind: "total_budget"` in
 * `reserveToolAttempt`, `commands/agent.ts`) on the SECOND round, driving
 * `runAgentTurnCore`'s `finishWithBudgetSummary` path (D2a `finishReason:
 * "budget"`).
 */
function distinctToolCallProvider(): ProviderPort {
  let round = 0;
  return {
    describe: () => ({ capabilities: PROBE_CAPABILITIES, descriptor: { providerId: "distinct-calls" } }),
    async *stream(_req, opts: StreamOptions): AsyncGenerator<NormalizedEvent> {
      round += 1;
      const id = `t${round}`;
      yield { kind: "tool_call_start", sequence: 0, attemptId: opts.attemptId, toolCallId: id, toolName: `probe_${round}` };
      yield { kind: "tool_call_end", sequence: 1, attemptId: opts.attemptId, toolCallId: id, input: "{}" };
      yield { kind: "model_end", sequence: 2, attemptId: opts.attemptId };
    },
  };
}

/**
 * Issues the SAME tool-call signature every round. `reserveToolAttempt`
 * allows up to `MAX_ATTEMPTS_PER_HASH` (3) attempts of one signature before
 * denying it (`kind: "repeat"` — deliberately NOT one of the
 * `total_budget`/`read_budget`/`non_read_budget` kinds), so the 4th round's
 * call is denied without ever touching `exhaustedBudget`. Since that round's
 * only call was denied, `executedAny` stays `false` — `runAgentTurnCore`'s
 * `noProgress` detector fires with `exhaustedBudget === undefined`, giving
 * D2a's `finishReason: "no-progress"`, distinct from budget exhaustion.
 */
function repeatedToolCallProvider(): ProviderPort {
  return {
    describe: () => ({ capabilities: PROBE_CAPABILITIES, descriptor: { providerId: "repeated-call" } }),
    async *stream(_req, opts: StreamOptions): AsyncGenerator<NormalizedEvent> {
      yield { kind: "tool_call_start", sequence: 0, attemptId: opts.attemptId, toolCallId: "t1", toolName: "same_probe" };
      yield { kind: "tool_call_end", sequence: 1, attemptId: opts.attemptId, toolCallId: "t1", input: "{}" };
      yield { kind: "model_end", sequence: 2, attemptId: opts.attemptId };
    },
  };
}

/** Immediate clean text finish — the baseline "Completed" shape. */
function textProvider(text: string): ProviderPort {
  return {
    describe: () => ({ capabilities: PROBE_CAPABILITIES, descriptor: { providerId: "text" } }),
    async *stream(_req, opts: StreamOptions): AsyncGenerator<NormalizedEvent> {
      yield { kind: "text_delta", sequence: 0, attemptId: opts.attemptId, text };
      yield { kind: "model_end", sequence: 1, attemptId: opts.attemptId };
    },
  };
}

test("status: Completed on a clean model finish", async () => {
  const tool = createSpawnSubagentTool({
    cwd: process.cwd(),
    getParentModel: () => ({ providerId: "ollama", modelId: "fake" }),
    makeProvider: () => textProvider("clean finish"),
    getDetectedProviders: () => [{ name: "ollama" }],
    idSeq: (() => {
      let n = 0;
      return () => `id-${n++}`;
    })(),
    clock: () => "2020-01-01T00:00:00.000Z",
  });
  const result = await tool.invoke({ task: "finish cleanly", mode: "read_only" });
  expect(result.status).toBe("Completed");
  expect(result.isError).toBe(false);
  expect(result.partial).toBeUndefined();
});

test("status: BudgetExhausted when the child's own tool-call budget exhausts before a clean finish (AC5)", async () => {
  const tool = createSpawnSubagentTool({
    cwd: process.cwd(),
    getParentModel: () => ({ providerId: "ollama", modelId: "fake" }),
    makeProvider: () => distinctToolCallProvider(),
    getDetectedProviders: () => [{ name: "ollama" }],
    idSeq: (() => {
      let n = 0;
      return () => `id-${n++}`;
    })(),
    clock: () => "2020-01-01T00:00:00.000Z",
  });
  // A budget of 1 unique signature: the first `probe_1` call executes; the
  // SECOND round's distinct `probe_2` call is denied on `total_budget`.
  const result = await tool.invoke({ task: "exhaust the child's own tool budget", mode: "read_only", max_tool_calls: 1 });
  expect(result.status).toBe("BudgetExhausted");
  expect(result.isError).toBe(true);
  expect(result.status).not.toBe("Completed");
});

test("status: NoProgress when the child hits the existing no-progress detector, distinct from BudgetExhausted (AC6)", async () => {
  const tool = createSpawnSubagentTool({
    cwd: process.cwd(),
    getParentModel: () => ({ providerId: "ollama", modelId: "fake" }),
    makeProvider: () => repeatedToolCallProvider(),
    getDetectedProviders: () => [{ name: "ollama" }],
    idSeq: (() => {
      let n = 0;
      return () => `id-${n++}`;
    })(),
    clock: () => "2020-01-01T00:00:00.000Z",
  });
  const result = await tool.invoke({ task: "repeat the same call past its attempt cap", mode: "read_only" });
  expect(result.status).toBe("NoProgress");
  expect(result.isError).toBe(true);
  expect(result.status).not.toBe("BudgetExhausted");
  expect(result.status).not.toBe("Completed");
});

test("status: Timeout keeps the existing isError:true behavior and gains the matching status (AC7)", async () => {
  const prev = process.env[ENV_SUBAGENT_TIMEOUT_MS];
  process.env[ENV_SUBAGENT_TIMEOUT_MS] = "250";
  try {
    const tool = createSpawnSubagentTool({
      cwd: process.cwd(),
      getParentModel: () => ({ providerId: "ollama", modelId: "fake" }),
      makeProvider: () => hangingProvider(),
      getDetectedProviders: () => [{ name: "ollama" }],
      idSeq: (() => {
        let n = 0;
        return () => `id-${n++}`;
      })(),
      clock: () => "2020-01-01T00:00:00.000Z",
    });
    const result = await tool.invoke({ task: "hang forever", label: "hung" });
    expect(result.status).toBe("Timeout");
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/timed out/i);
  } finally {
    if (prev === undefined) delete process.env[ENV_SUBAGENT_TIMEOUT_MS];
    else process.env[ENV_SUBAGENT_TIMEOUT_MS] = prev;
  }
});

test("status: Denied keeps the existing isError:true behavior and gains the matching status (AC7)", async () => {
  const prev = process.env[ENV_SUBAGENT_LEDGER_MAX_TOOL_CALLS];
  // Shrink the per-turn child ledger pool below the default per-child request
  // (`DEFAULT_SUBAGENT_MAX_TOOL_CALLS = 10`) so MAE's admission check denies
  // the spawn outright — the child never starts.
  process.env[ENV_SUBAGENT_LEDGER_MAX_TOOL_CALLS] = "1";
  try {
    const tool = createSpawnSubagentTool({
      cwd: process.cwd(),
      getParentModel: () => ({ providerId: "ollama", modelId: "fake" }),
      makeProvider: () => textProvider("never reached"),
      getDetectedProviders: () => [{ name: "ollama" }],
      idSeq: (() => {
        let n = 0;
        return () => `id-${n++}`;
      })(),
      clock: () => "2020-01-01T00:00:00.000Z",
    });
    const result = await tool.invoke({ task: "denied before it ever starts", mode: "read_only" });
    expect(result.status).toBe("Denied");
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/denied by MAE/);
  } finally {
    if (prev === undefined) delete process.env[ENV_SUBAGENT_LEDGER_MAX_TOOL_CALLS];
    else process.env[ENV_SUBAGENT_LEDGER_MAX_TOOL_CALLS] = prev;
  }
});

test("status: Error keeps the existing isError:true behavior and gains the matching status (AC7)", async () => {
  // A thrown/internal error inside the child's own turn (rather than a
  // provider-reported error, which `runAgentTurnCore` already swallows by
  // design) is what reaches `invoke()`'s outer `catch`. `deps.idSeq` is the
  // one dependency threaded all the way into `runAgentTurn` without any
  // defensive try/catch around its call sites, so making it throw exercises
  // this path deterministically. Empirically verified (see this task's own
  // investigation notes): with ONE tool instance and ONE `invoke()` call, the
  // first 9 `idSeq()` calls are spent on setup BEFORE the child's turn ever
  // starts — 3 once at `createSpawnSubagentTool()` construction time
  // (`parentRunId`/`parentSessionId`/`provenanceId`), then per-`invoke()`:
  // `workerId`, `attemptId`, `branchId`, `reservationId`, `artifactId`, and
  // one internal to `spawnSubagent`. The 10th+ call lands inside
  // `runAgentTurnCore` itself (`parentRunId`, then `requestId` per round).
  // Throwing from the 10th call onward reliably lands inside the turn, not
  // during setup — if this drifts with a future refactor, this assertion
  // fails loudly rather than silently, and the fix is to adjust the
  // threshold below.
  let calls = 0;
  const throwFromCall = 10;
  const tool = createSpawnSubagentTool({
    cwd: process.cwd(),
    getParentModel: () => ({ providerId: "ollama", modelId: "fake" }),
    makeProvider: () => textProvider("never reached"),
    getDetectedProviders: () => [{ name: "ollama" }],
    idSeq: () => {
      calls += 1;
      if (calls >= throwFromCall) {
        throw new Error("idSeq boom");
      }
      return `id-${calls}`;
    },
    clock: () => "2020-01-01T00:00:00.000Z",
  });
  const result = await tool.invoke({ task: "trigger a thrown internal error", mode: "read_only" });
  expect(result.status).toBe("Error");
  expect(result.isError).toBe(true);
  expect(result.output).toMatch(/subagent .* failed: idSeq boom/);
});

test("AC8: a caller reading only {output, isError} sees pre-Phase-D behavior on every existing path", async () => {
  /** Strips `status`/`partial` — mirrors a caller that predates D2 entirely. */
  const legacyView = (r: { output: string; isError: boolean }): { output: string; isError: boolean } => ({
    output: r.output,
    isError: r.isError,
  });

  // Completed (pre-existing "clean finish" path).
  {
    const tool = createSpawnSubagentTool({
      cwd: process.cwd(),
      getParentModel: () => ({ providerId: "ollama", modelId: "fake" }),
      makeProvider: () => textProvider("Child found 2 issues in auth."),
      getDetectedProviders: () => [{ name: "ollama" }],
      idSeq: (() => {
        let n = 0;
        return () => `id-${n++}`;
      })(),
      clock: () => "2020-01-01T00:00:00.000Z",
    });
    const legacy = legacyView(await tool.invoke({ task: "Review auth module briefly", mode: "read_only", label: "auth-check" }));
    expect(legacy.isError).toBe(false);
    expect(legacy.output).toMatch(/subagent auth-check/);
    expect(legacy.output).toMatch(/Child found 2 issues/);
  }

  // Timeout (pre-existing path, `spawn-subagent-lifecycle.test.ts`'s own assertions).
  {
    const prev = process.env[ENV_SUBAGENT_TIMEOUT_MS];
    process.env[ENV_SUBAGENT_TIMEOUT_MS] = "250";
    try {
      const tool = createSpawnSubagentTool({
        cwd: process.cwd(),
        getParentModel: () => ({ providerId: "ollama", modelId: "fake" }),
        makeProvider: () => hangingProvider(),
        getDetectedProviders: () => [{ name: "ollama" }],
        idSeq: (() => {
          let n = 0;
          return () => `id-${n++}`;
        })(),
        clock: () => "2020-01-01T00:00:00.000Z",
      });
      const legacy = legacyView(await tool.invoke({ task: "hang forever", label: "hung" }));
      expect(legacy.isError).toBe(true);
      expect(legacy.output).toMatch(/timed out/i);
    } finally {
      if (prev === undefined) delete process.env[ENV_SUBAGENT_TIMEOUT_MS];
      else process.env[ENV_SUBAGENT_TIMEOUT_MS] = prev;
    }
  }

  // Denied (pre-existing MAE admission path).
  {
    const prev = process.env[ENV_SUBAGENT_LEDGER_MAX_TOOL_CALLS];
    process.env[ENV_SUBAGENT_LEDGER_MAX_TOOL_CALLS] = "1";
    try {
      const tool = createSpawnSubagentTool({
        cwd: process.cwd(),
        getParentModel: () => ({ providerId: "ollama", modelId: "fake" }),
        makeProvider: () => textProvider("never reached"),
        getDetectedProviders: () => [{ name: "ollama" }],
        idSeq: (() => {
          let n = 0;
          return () => `id-${n++}`;
        })(),
        clock: () => "2020-01-01T00:00:00.000Z",
      });
      const legacy = legacyView(await tool.invoke({ task: "denied before it ever starts", mode: "read_only" }));
      expect(legacy.isError).toBe(true);
      expect(legacy.output).toMatch(/denied by MAE/);
    } finally {
      if (prev === undefined) delete process.env[ENV_SUBAGENT_LEDGER_MAX_TOOL_CALLS];
      else process.env[ENV_SUBAGENT_LEDGER_MAX_TOOL_CALLS] = prev;
    }
  }

  // Error (pre-existing thrown/internal error path — same idSeq seam as the AC7 Error test above).
  {
    let calls = 0;
    const throwFromCall = 10;
    const tool = createSpawnSubagentTool({
      cwd: process.cwd(),
      getParentModel: () => ({ providerId: "ollama", modelId: "fake" }),
      makeProvider: () => textProvider("never reached"),
      getDetectedProviders: () => [{ name: "ollama" }],
      idSeq: () => {
        calls += 1;
        if (calls >= throwFromCall) {
          throw new Error("idSeq boom");
        }
        return `id-${calls}`;
      },
      clock: () => "2020-01-01T00:00:00.000Z",
    });
    const legacy = legacyView(await tool.invoke({ task: "trigger a thrown internal error", mode: "read_only" }));
    expect(legacy.isError).toBe(true);
    expect(legacy.output).toMatch(/failed: idSeq boom/);
  }
});
