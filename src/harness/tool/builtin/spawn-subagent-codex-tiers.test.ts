// The codex tier wire, through the real `spawn_subagent` dispatch path: the live
// model list reaches tier resolution and routing, and Astra is never chosen.
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSpawnSubagentTool } from "./spawn-subagent-tool";
import { loadRoutingConfigRaw } from "../../routing/config";
import { approveProjectRouting } from "../../routing/trust";
import type { ModelRankHint } from "../../../gdskills/model-tier";
import { pinHintsFor, TIER_RANK_HINTS } from "../../../gdskills/model-tier";
import type { NormalizedEvent, ProviderPort, StreamOptions } from "../../provider/types";

function stubProvider(): ProviderPort {
  return {
    describe() {
      return {
        capabilities: {
          streaming: true, toolCalls: false, parallelToolCalls: false, structuredOutput: false,
          reasoningMetadata: false, promptCaching: false, vision: false, tokenCounting: false, modelListing: false,
        },
        descriptor: { providerId: "stub" },
      };
    },
    async *stream(_req, opts: StreamOptions): AsyncIterable<NormalizedEvent> {
      yield { kind: "text_delta", sequence: 0, attemptId: opts.attemptId, text: "done" };
      yield { kind: "model_end", sequence: 1, attemptId: opts.attemptId };
    },
  };
}

const LIVE = ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna"];
const STALE = ["gpt-5.3-codex"];
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function makeTool(opts: { cwd?: string; session?: string; models: readonly string[]; getRankHints?: (p: string) => readonly ModelRankHint[] }) {
  const built: { providerId: string; modelId: string }[] = [];
  const tool = createSpawnSubagentTool({
    cwd: opts.cwd ?? process.cwd(),
    getParentModel: () => ({ providerId: "openai-codex", modelId: opts.session ?? "gpt-6.1-sol" }),
    makeProvider: (providerId, modelId) => {
      built.push({ providerId, modelId });
      return stubProvider();
    },
    getDetectedProviders: () => [{ name: "openai-codex", models: opts.models }],
    ...(opts.getRankHints !== undefined ? { getRankHints: opts.getRankHints } : {}),
    idSeq: (() => { let n = 0; return () => `codex-${n++}`; })(),
    clock: () => "2020-01-01T00:00:00.000Z",
  });
  return { tool, built };
}

async function projectRouting(assignment: unknown): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-codex-tiers-"));
  roots.push(root);
  await writeFile(path.join(root, "routing.config.json"), JSON.stringify({ categories: { subagents: assignment } }), "utf8");
  const raw = await loadRoutingConfigRaw("project", { cwd: root });
  const approved = await approveProjectRouting(root, raw.table);
  if (!approved.ok) throw new Error(approved.error);
  return root;
}

test("with the live list, model_tier light runs on luna and deep on sol — never Astra", async () => {
  const light = makeTool({ models: LIVE });
  expect((await light.tool.invoke({ task: "t", mode: "read_only", model_tier: "light" })).isError).toBe(false);
  expect(light.built).toEqual([{ providerId: "openai-codex", modelId: "gpt-6-luna" }]);

  const deep = makeTool({ models: LIVE, session: "gpt-6-luna" });
  await deep.tool.invoke({ task: "t", mode: "read_only", model_tier: "deep" });
  expect(deep.built).toEqual([{ providerId: "openai-codex", modelId: "gpt-6.1-sol" }]);
});

test("with the stale stub list the tier stays on the session model (the failure this fixes)", async () => {
  const stale = makeTool({ models: STALE });
  await stale.tool.invoke({ task: "t", mode: "read_only", model_tier: "light" });
  expect(stale.built).toEqual([{ providerId: "openai-codex", modelId: "gpt-6.1-sol" }]);
});

test("an operator pin passed through getRankHints decides the tier", async () => {
  const { tool, built } = makeTool({
    models: LIVE,
    getRankHints: () => [...TIER_RANK_HINTS, ...pinHintsFor([{ modelId: "gpt-6-luna", tier: "deep" }, { modelId: "gpt-6.1-sol", tier: "light" }])],
  });
  await tool.invoke({ task: "t", mode: "read_only", model_tier: "light" });
  expect(built).toEqual([{ providerId: "openai-codex", modelId: "gpt-6.1-sol" }]);
});

test("without model_tier the subagents routing assignment still decides the model", async () => {
  const cwd = await projectRouting({ kind: "model", providerId: "openai-codex", modelId: "gpt-6-luna" });
  const { tool, built } = makeTool({ cwd, models: LIVE });
  await tool.invoke({ task: "t", mode: "read_only" });
  expect(built).toEqual([{ providerId: "openai-codex", modelId: "gpt-6-luna" }]);
});

test("a subagents routing assignment naming Astra is dropped: the child inherits the session model", async () => {
  const cwd = await projectRouting({ kind: "model", providerId: "openai-codex", modelId: "gpt-6-astra" });
  const { tool, built } = makeTool({ cwd, models: LIVE });
  await tool.invoke({ task: "t", mode: "read_only" });
  expect(built).toEqual([{ providerId: "openai-codex", modelId: "gpt-6.1-sol" }]);
});
