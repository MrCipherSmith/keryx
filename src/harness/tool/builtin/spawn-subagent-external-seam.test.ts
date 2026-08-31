// The external-runtime seam on `spawn_subagent` (flow 176, T14).
//
// What matters here is not that an external agent works — that is covered
// offline in `src/harness/external/` — but that adding the seam changed nothing
// for anyone who does not use it, and that when it IS used the child is still
// gated by the same admission the native path goes through.
import { expect, test } from "bun:test";
import {
  createSpawnSubagentTool,
  type SpawnSubagentFleetEvent,
  type StructuredSubagentResult,
} from "./spawn-subagent-tool";
import type { NormalizedEvent, ProviderPort, StreamOptions } from "../../provider/types";

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

function makeTool(
  runExternal?: Parameters<typeof createSpawnSubagentTool>[0]["runExternal"],
  onFleetEvent?: Parameters<typeof createSpawnSubagentTool>[0]["onFleetEvent"],
) {
  return createSpawnSubagentTool({
    cwd: process.cwd(),
    getParentModel: () => ({ providerId: "ollama", modelId: "fake" }),
    makeProvider: () => stubProvider("native child answer"),
    getDetectedProviders: () => [{ name: "ollama" }],
    idSeq: (() => {
      let n = 0;
      return () => `id-${n++}`;
    })(),
    clock: () => "2020-01-01T00:00:00.000Z",
    ...(runExternal === undefined ? {} : { runExternal }),
    ...(onFleetEvent === undefined ? {} : { onFleetEvent }),
  });
}

const EXTERNAL_RESULT: StructuredSubagentResult = {
  status: "Completed",
  output: "codex says: the resume suite leaks a tmp dir",
  isError: false,
};

test("without the hook, a runtime block is ignored and the native path runs", async () => {
  // The seam must be inert for every existing call site.
  const tool = makeTool();
  const result = await tool.invoke({
    task: "Review auth module briefly",
    mode: "read_only",
    label: "auth-check",
    runtime: { kind: "external", agent: "codex-cli", sandbox: "read-only" },
  });
  expect(result.isError).toBe(false);
  expect(result.output).toMatch(/native child answer/);
});

test("with the hook but no runtime block, the native path still runs", async () => {
  let called = false;
  const tool = makeTool(async () => {
    called = true;
    return EXTERNAL_RESULT;
  });
  const result = await tool.invoke({ task: "Review auth module", mode: "read_only", label: "native" });
  expect(called).toBe(false);
  expect(result.output).toMatch(/native child answer/);
});

test("with both, the external hook runs instead and its result is returned verbatim", async () => {
  const seen: Array<{ task: string; mode: string; label: string; runtime: unknown }> = [];
  const tool = makeTool(async (request) => {
    seen.push({ task: request.task, mode: request.mode, label: request.label, runtime: request.runtime });
    return EXTERNAL_RESULT;
  });

  const result = await tool.invoke({
    task: "Find why the resume suite is flaky",
    mode: "read_only",
    label: "codex-1",
    runtime: { kind: "external", agent: "codex-cli", sandbox: "read-only" },
  });

  expect(result).toEqual(EXTERNAL_RESULT);
  expect(seen).toHaveLength(1);
  expect(seen[0]?.task).toBe("Find why the resume suite is flaky");
  expect(seen[0]?.mode).toBe("read_only");
  // The block is passed through unvalidated: the fail-closed validator lives in
  // the external runtime, and a second reader here would diverge from it.
  expect(seen[0]?.runtime).toEqual({ kind: "external", agent: "codex-cli", sandbox: "read-only" });
});

test("a runtime block that is not external falls through to the native path", async () => {
  let called = false;
  const tool = makeTool(async () => {
    called = true;
    return EXTERNAL_RESULT;
  });
  const result = await tool.invoke({
    task: "Review auth module",
    mode: "read_only",
    label: "native",
    runtime: { kind: "keryx" },
  });
  expect(called).toBe(false);
  expect(result.output).toMatch(/native child answer/);
});

test("a malformed runtime block falls through rather than throwing", async () => {
  const tool = makeTool(async () => EXTERNAL_RESULT);
  for (const runtime of ["external", null, 42, [], { agent: "codex-cli" }]) {
    const result = await tool.invoke({ task: "t", mode: "read_only", label: "n", runtime });
    expect(result.isError).toBe(false);
  }
});

test("a throwing hook becomes an Error result, not an external agent's report", async () => {
  // A broken keryx seam must not be presented as something the vendor said.
  const tool = makeTool(async () => {
    throw new Error("spawn port unavailable");
  });
  const result = await tool.invoke({
    task: "t",
    mode: "read_only",
    label: "x",
    runtime: { kind: "external", agent: "codex-cli", sandbox: "read-only" },
  });
  expect(result.status).toBe("Error");
  expect(result.isError).toBe(true);
  expect(result.output).toContain("spawn port unavailable");
});

// ---------------------------------------------------------------------------
// The parameter schema (flow 176, T15)
// ---------------------------------------------------------------------------
//
// A dispatch cannot ASK for an external child unless the tool's own schema says
// the field exists: `additionalProperties: false` means an undeclared `runtime`
// is an invalid call, and a provider that validates tool input would reject it
// before the seam above ever ran.

/** The `spawn_subagent` input schema, narrowed enough to assert against. */
function inputSchema(): {
  properties: Record<string, { type?: unknown; required?: unknown; properties?: Record<string, unknown> }>;
  required: string[];
  additionalProperties: boolean;
} {
  return makeTool().definition.inputSchema as ReturnType<typeof inputSchema>;
}

test("the schema declares `runtime`, so a dispatch can request an external child", () => {
  const schema = inputSchema();
  expect(schema.properties.runtime).toBeDefined();
  expect(schema.properties.runtime?.type).toBe("object");
});

test("`runtime` is optional and additive — every pre-existing call stays valid", () => {
  const schema = inputSchema();
  // `task` is still the only required field, and nothing else was removed.
  expect(schema.required).toEqual(["task"]);
  for (const field of ["task", "mode", "label", "max_tool_calls"]) {
    expect(schema.properties[field]).toBeDefined();
  }
  expect(schema.additionalProperties).toBe(false);
});

test("the runtime block requires only `kind`, and offers only the implemented sandbox", () => {
  const runtime = inputSchema().properties.runtime as {
    required: string[];
    properties: Record<string, { enum?: unknown[] }>;
  };
  expect(runtime.required).toEqual(["kind"]);
  expect(runtime.properties.kind?.enum).toEqual(["keryx", "external"]);
  // `worktree-write` is schema-valid in the dispatch contract and refused at
  // runtime by a distinct code; offering it here would spend a dispatch to
  // learn something the schema already knows.
  expect(runtime.properties.sandbox?.enum).toEqual(["read-only"]);
});

test("a dispatch that names an agent and sandbox reaches the hook unchanged", async () => {
  // The schema and the seam agree: what the schema permits is what arrives.
  const seen: unknown[] = [];
  const tool = makeTool(async (request) => {
    seen.push(request.runtime);
    return EXTERNAL_RESULT;
  });
  await tool.invoke({
    task: "t",
    mode: "read_only",
    runtime: { kind: "external", agent: "claude-cli", sandbox: "read-only", model: null, timeoutMs: 30_000 },
  });
  expect(seen[0]).toEqual({
    kind: "external",
    agent: "claude-cli",
    sandbox: "read-only",
    model: null,
    timeoutMs: 30_000,
  });
});

test("an empty task is still refused before the hook is consulted", async () => {
  // Admission ordering: local validation and MAE run first, so an external
  // dispatch cannot skip a gate the native path applies.
  let called = false;
  const tool = makeTool(async () => {
    called = true;
    return EXTERNAL_RESULT;
  });
  const result = await tool.invoke({
    task: "   ",
    mode: "read_only",
    runtime: { kind: "external", agent: "codex-cli", sandbox: "read-only" },
  });
  expect(result.status).toBe("Error");
  expect(called).toBe(false);
});

// ---------------------------------------------------------------------------
// The sidebar's runtime discriminator (flow 176, T18)
// ---------------------------------------------------------------------------
//
// Package specification §8.2: external children appear in the subagent sidebar
// "visually marked with their runtime". The mark has to be on the FIRST upsert,
// not just the terminal one — a row that starts life looking native is a row the
// operator has already read by the time it is corrected.

function captureFleet(): {
  events: SpawnSubagentFleetEvent[];
  onFleetEvent: NonNullable<Parameters<typeof createSpawnSubagentTool>[0]["onFleetEvent"]>;
} {
  const events: SpawnSubagentFleetEvent[] = [];
  return { events, onFleetEvent: (event) => events.push(event) };
}

test("an external dispatch marks every sidebar upsert with its runtime and agent", async () => {
  const captured = captureFleet();
  const tool = makeTool(async () => EXTERNAL_RESULT, captured.onFleetEvent);
  await tool.invoke({
    task: "Find why the resume suite is flaky",
    mode: "read_only",
    label: "codex-1",
    runtime: { kind: "external", agent: "codex-cli", sandbox: "read-only" },
  });
  const upserts = captured.events.filter((e) => e.kind === "upsert");
  expect(upserts.length).toBeGreaterThanOrEqual(2);
  for (const event of upserts) {
    expect(event).toMatchObject({ runtime: "external", agentId: "codex-cli" });
  }
});

test("a native dispatch carries no runtime mark at all", async () => {
  const captured = captureFleet();
  const tool = makeTool(async () => EXTERNAL_RESULT, captured.onFleetEvent);
  await tool.invoke({ task: "Review auth module", mode: "read_only", label: "native" });
  for (const event of captured.events.filter((e) => e.kind === "upsert")) {
    expect((event as { runtime?: unknown }).runtime).toBeUndefined();
  }
});

test("a dispatch with a runtime block but NO hook stays unmarked — it ran natively", async () => {
  // The mark describes what actually executed, not what was asked for.
  const captured = captureFleet();
  const tool = makeTool(undefined, captured.onFleetEvent);
  await tool.invoke({
    task: "Review auth module briefly",
    mode: "read_only",
    label: "auth-check",
    runtime: { kind: "external", agent: "codex-cli", sandbox: "read-only" },
  });
  for (const event of captured.events.filter((e) => e.kind === "upsert")) {
    expect((event as { runtime?: unknown }).runtime).toBeUndefined();
  }
});
