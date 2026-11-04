import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { NormalizedEvent, ProviderPort, StreamOptions } from "../../provider/types";
import type { RoutingV2ConfigLayer } from "../../routing/config-v2";
import { applyRoutingV2Migration, createRoutingV2MigrationPlan } from "../../routing/migration-v2";
import { setModelProfileField } from "../../routing/model-profile";
import { createSpawnSubagentTool, type SpawnSubagentFleetEvent } from "./spawn-subagent-tool";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function stubProvider(text = "done", onStream?: () => void): ProviderPort {
  return {
    describe() {
      return {
        capabilities: {
          streaming: true,
          toolCalls: true,
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
    async *stream(_request, options: StreamOptions): AsyncIterable<NormalizedEvent> {
      onStream?.();
      yield { kind: "text_delta", sequence: 0, attemptId: options.attemptId, text };
      yield { kind: "model_end", sequence: 1, attemptId: options.attemptId };
    },
  };
}

async function activeTool(
  user: RoutingV2ConfigLayer,
  detected: readonly { name: string; models?: readonly string[] }[] = [{ name: "ollama", models: ["medium", "max"] }],
  providerText = "done",
) {
  const cwd = await mkdtemp(path.join(tmpdir(), "keryx-spawn-v2-project-"));
  const configDir = await mkdtemp(path.join(tmpdir(), "keryx-spawn-v2-config-"));
  roots.push(cwd, configDir);
  await mkdir(path.join(cwd, ".metaproject"), { recursive: true });
  for (const provider of detected) {
    for (const modelId of provider.models ?? []) {
      await setModelProfileField(provider.name, modelId, { field: "contextLength", value: 100_000 }, configDir);
    }
  }
  const plan = await createRoutingV2MigrationPlan({ cwd, configDir, user });
  await applyRoutingV2Migration(plan, { confirmed: true, cwd, configDir });

  const built: Array<{ providerId: string; modelId: string }> = [];
  const streamed: Array<{ providerId: string; modelId: string }> = [];
  const events: SpawnSubagentFleetEvent[] = [];
  const tool = createSpawnSubagentTool({
    cwd,
    routingConfigDir: configDir,
    getParentModel: () => ({ providerId: "ollama", modelId: "medium" }),
    getDetectedProviders: () => detected,
    makeProvider: (providerId, modelId) => {
      built.push({ providerId, modelId });
      return stubProvider(providerText, () => streamed.push({ providerId, modelId }));
    },
    describeProvider: () => stubProvider().describe(),
    idSeq: (() => {
      let value = 0;
      return () => `v2-${value++}`;
    })(),
    clock: () => "2026-11-04T00:00:00.000Z",
    onFleetEvent: (event) => events.push(event),
  });
  return { tool, built, streamed, events };
}

const classConfig = {
  standard: {
    candidates: [{ target: { providerId: "ollama", modelId: "medium" }, enabled: true, priority: 1 }],
    selection: "priority" as const,
    fallbackClasses: [],
  },
  frontier: {
    candidates: [{ target: { providerId: "ollama", modelId: "max" }, enabled: true, priority: 1 }],
    selection: "priority" as const,
    fallbackClasses: [],
  },
};

test("routing v2 category outranks an agent model_class recommendation and keeps child authorization gates", async () => {
  const { tool, built, events } = await activeTool({
    schemaVersion: 2,
    classes: classConfig,
    categories: { subagents: { mode: "class", modelClass: "standard" } },
  });
  const result = await tool.invoke({ task: "hard task", mode: "read_only", model_class: "frontier" });

  expect(result.isError).toBe(false);
  expect(built).toEqual([{ providerId: "ollama", modelId: "medium" }]);
  expect(result.output).toMatch(/routing v2 [a-f0-9]{64} → ollama\/medium \[user\/none\]/);
  const routingLog = events.find(
    (event) => event.kind === "log" && event.entry.kind === "system" && event.entry.text.startsWith("routing v2 "),
  );
  expect(routingLog).toMatchObject({ kind: "log", entry: { kind: "system" } });
  if (routingLog?.kind === "log") {
    expect(routingLog.entry.text).toContain("user/none -> ollama/medium");
  }
});

test("routing v2 auto may use model_class as an agent recommendation without making it a user override", async () => {
  const { tool, built, events } = await activeTool({
    schemaVersion: 2,
    classes: classConfig,
    categories: { subagents: { mode: "auto" } },
  });
  const result = await tool.invoke({ task: "hard task", mode: "read_only", model_class: "frontier" });

  expect(result.isError).toBe(false);
  expect(built).toEqual([{ providerId: "ollama", modelId: "max" }]);
  const logText = events.flatMap((event) => event.kind === "log" ? [event.entry.text] : []).join("\n");
  expect(logText).toContain("user/agent -> ollama/max");
  expect(logText).not.toContain("user-override");
});

test("routing v2 auto uses the shared production classifier path", async () => {
  const classifierReply = JSON.stringify({
    category: "subagents",
    modelClass: "frontier",
    confidence: 0.95,
    reasonCode: "hard-subtask",
    requiredCapabilities: ["tools"],
  });
  const { tool, built, events } = await activeTool({
    schemaVersion: 2,
    classes: classConfig,
    categories: { subagents: { mode: "auto" } },
    classifier: {
      chain: [{ adapterId: "model", target: { providerId: "ollama", modelId: "medium" } }],
      timeoutMs: 3_000,
      minConfidence: 0.7,
      onFailure: { mode: "baseline" },
    },
  }, undefined, classifierReply);
  const result = await tool.invoke({ task: "classify this hard task", mode: "read_only" });

  expect(result.isError).toBe(false);
  expect(built).toEqual([
    { providerId: "ollama", modelId: "medium" },
    { providerId: "ollama", modelId: "max" },
  ]);
  expect(events.flatMap((event) => event.kind === "log" ? [event.entry.text] : []).join("\n"))
    .toContain("user/classifier -> ollama/max");
});

test("routing v2 blocks an unverified subagent target before provider construction", async () => {
  const { tool, built } = await activeTool({
    schemaVersion: 2,
    categories: { subagents: { mode: "model", target: { providerId: "ollama", modelId: "missing" } } },
  });
  const result = await tool.invoke({ task: "must not run", mode: "read_only" });

  expect(result).toMatchObject({ status: "Denied", isError: true });
  expect(result.output).toContain("candidate-unverified");
  expect(built).toEqual([]);
});

test("routing v2 finite execution budget blocks unknown child cost before provider I/O", async () => {
  const { tool, built, streamed, events } = await activeTool({
    schemaVersion: 2,
    classes: classConfig,
    categories: { subagents: { mode: "class", modelClass: "standard" } },
    execution: {
      maxAttempts: 3,
      selectionTimeoutMs: 3_000,
      maxEstimatedCostUsd: 1,
      unknownCost: "allow",
    },
  });
  const result = await tool.invoke({ task: "must be budgeted", mode: "read_only" });

  expect(result).toMatchObject({ status: "Denied", isError: true });
  expect(result.output).toContain("execution budget: cost-unknown");
  expect(built).toEqual([{ providerId: "ollama", modelId: "medium" }]);
  expect(streamed).toEqual([]);
  expect(events.flatMap((event) => event.kind === "log" ? [event.entry.text] : []).join("\n"))
    .toContain("execution denied before provider I/O (cost-unknown)");
});

test("routing v2 snapshot preserves the child provider authorization gate", async () => {
  const { tool, built } = await activeTool({
    schemaVersion: 2,
    categories: { subagents: { mode: "model", target: { providerId: "mystery", modelId: "x" } } },
  }, [
    { name: "ollama", models: ["medium"] },
    { name: "mystery", models: ["x"] },
  ]);
  const result = await tool.invoke({ task: "must stay authorized", mode: "read_only" });

  expect(result).toMatchObject({ status: "Denied", isError: true });
  expect(result.output).toContain("policy-denied");
  expect(built).toEqual([]);
});

test("routing v2 never translates legacy model_tier into an absolute class", async () => {
  const { tool, built } = await activeTool({ schemaVersion: 2 });
  const result = await tool.invoke({ task: "legacy input", mode: "read_only", model_tier: "deep" });

  expect(result).toMatchObject({ status: "Error", isError: true });
  expect(result.output).toContain("model_tier is legacy-only");
  expect(built).toEqual([]);
});
