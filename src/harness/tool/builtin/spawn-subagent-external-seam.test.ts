// The external-runtime seam on `spawn_subagent` (flow 176, T14).
//
// What matters here is not that an external agent works — that is covered
// offline in `src/harness/external/` — but that adding the seam changed nothing
// for anyone who does not use it, and that when it IS used the child is still
// gated by the same admission the native path goes through.
import { expect, test } from "bun:test";
import { createSpawnSubagentTool, type StructuredSubagentResult } from "./spawn-subagent-tool";
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

function makeTool(runExternal?: Parameters<typeof createSpawnSubagentTool>[0]["runExternal"]) {
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
