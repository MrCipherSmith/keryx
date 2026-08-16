import { expect, test } from "bun:test";
import { createSpawnSubagentTool } from "./spawn-subagent-tool";
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
