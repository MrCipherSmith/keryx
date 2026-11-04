import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { NormalizedEvent, ProviderPort, StreamOptions } from "../../provider/types";
import type { RoutingV2ConfigLayer } from "../../routing/config-v2";
import { applyRoutingV2Migration, createRoutingV2MigrationPlan } from "../../routing/migration-v2";
import { createSpawnSubagentTool, type SpawnSubagentFleetEvent } from "./spawn-subagent-tool";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function stubProvider(): ProviderPort {
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
    async *stream(_request, options: StreamOptions): AsyncIterable<NormalizedEvent> {
      yield { kind: "text_delta", sequence: 0, attemptId: options.attemptId, text: "done" };
      yield { kind: "model_end", sequence: 1, attemptId: options.attemptId };
    },
  };
}

async function activeTool(user: RoutingV2ConfigLayer) {
  const cwd = await mkdtemp(path.join(tmpdir(), "keryx-spawn-v2-project-"));
  const configDir = await mkdtemp(path.join(tmpdir(), "keryx-spawn-v2-config-"));
  roots.push(cwd, configDir);
  await mkdir(path.join(cwd, ".metaproject"), { recursive: true });
  const plan = await createRoutingV2MigrationPlan({ cwd, configDir, user });
  await applyRoutingV2Migration(plan, { confirmed: true, cwd, configDir });

  const built: Array<{ providerId: string; modelId: string }> = [];
  const events: SpawnSubagentFleetEvent[] = [];
  const tool = createSpawnSubagentTool({
    cwd,
    routingConfigDir: configDir,
    getParentModel: () => ({ providerId: "ollama", modelId: "medium" }),
    getDetectedProviders: () => [{ name: "ollama", models: ["medium", "max"] }],
    makeProvider: (providerId, modelId) => {
      built.push({ providerId, modelId });
      return stubProvider();
    },
    idSeq: (() => {
      let value = 0;
      return () => `v2-${value++}`;
    })(),
    clock: () => "2026-11-04T00:00:00.000Z",
    onFleetEvent: (event) => events.push(event),
  });
  return { tool, built, events };
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

test("routing v2 never translates legacy model_tier into an absolute class", async () => {
  const { tool, built } = await activeTool({ schemaVersion: 2 });
  const result = await tool.invoke({ task: "legacy input", mode: "read_only", model_tier: "deep" });

  expect(result).toMatchObject({ status: "Error", isError: true });
  expect(result.output).toContain("model_tier is legacy-only");
  expect(built).toEqual([]);
});
