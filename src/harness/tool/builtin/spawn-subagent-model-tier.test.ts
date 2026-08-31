// Flow 204 — the `model_tier` wire, driven through the REAL dispatch path.
//
// Everything here goes through `createSpawnSubagentTool(...).invoke(...)` and
// asserts on the provider the tool actually CONSTRUCTED for the child. That is
// deliberate and it is the whole point of this file: `buildTierMap` was a
// producer with no consumer, and a test written against a hand-built `tiers` map
// — which is what `model-tier.test.ts` does, correctly, for the resolution rules
// — cannot see a missing producer. It passes just as happily when nothing in
// production ever calls `buildTierMap` at all. So these tests inject only what a
// real host injects (a parent model, a detection result) and read only what a
// real child gets (`makeProvider`'s arguments).
//
// The model ids below are invented and carry SIZE WORDS on purpose. They are not
// a claim about any vendor's lineup — the resolution holds no table of models, so
// a test that used real ids would be testing the ids rather than the mechanism.
import { expect, test } from "bun:test";
import { createSpawnSubagentTool, type SpawnSubagentFleetEvent } from "./spawn-subagent-tool";
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

/** The session's own model sits in the middle, with one above and one below it. */
const SESSION_MODEL = "keryx-medium-1";
const ABOVE = "keryx-max-1";
const BELOW = "keryx-mini-1";

/** Ids that carry no size word at all — nothing can be ordered against them. */
const CODENAMES = ["keryx-quartz", "keryx-basalt", "keryx-slate"];

/**
 * A tool wired the way a real host wires it, plus a box recording the
 * provider/model the child was actually built with.
 */
function makeTool(
  detected: readonly { name: string; models?: readonly string[] }[],
  sessionModel: string = SESSION_MODEL,
) {
  const built: { providerId: string; modelId: string }[] = [];
  const fleetEvents: SpawnSubagentFleetEvent[] = [];
  const tool = createSpawnSubagentTool({
    cwd: process.cwd(),
    getParentModel: () => ({ providerId: "ollama", modelId: sessionModel }),
    makeProvider: (providerId, modelId) => {
      built.push({ providerId, modelId });
      return stubProvider("done");
    },
    getDetectedProviders: () => detected,
    idSeq: (() => {
      let n = 0;
      return () => `tier-${n++}`;
    })(),
    clock: () => "2020-01-01T00:00:00.000Z",
    onFleetEvent: (event) => fleetEvents.push(event),
  });
  return { tool, built, fleetEvents };
}

const RANKABLE = [{ name: "ollama", models: [SESSION_MODEL, ABOVE, BELOW] }];

test("model_tier deep runs the child on a DISCOVERED model ranked above the session's", async () => {
  const { tool, built } = makeTool(RANKABLE);
  const result = await tool.invoke({ task: "hard reasoning", mode: "read_only", model_tier: "deep" });

  expect(result.isError).toBe(false);
  // The assertion that only the real wire can satisfy: the child's provider was
  // constructed with a model that exists ONLY in the injected detection result.
  expect(built).toEqual([{ providerId: "ollama", modelId: ABOVE }]);
  expect(result.output).toContain(ABOVE);
  // …and the run can be explained afterwards (dispatch schema `tier_resolution`).
  expect(result.output).toMatch(/model tier deep .*\[discovered\]/);
});

test("model_tier light runs the child on a discovered model ranked below the session's", async () => {
  const { tool, built, fleetEvents } = makeTool(RANKABLE);
  const result = await tool.invoke({ task: "mechanical check", mode: "read_only", model_tier: "light" });

  expect(built).toEqual([{ providerId: "ollama", modelId: BELOW }]);
  expect(result.output).toMatch(/model tier light .*\[discovered\]/);
  const tierLog = fleetEvents.find(
    (event) => event.kind === "log" && event.entry.kind === "system" && event.entry.text.includes("model tier light"),
  );
  expect(tierLog).toBeDefined();
});

test("model_tier standard is the session's own model, recorded as ranked rather than fallen back to", async () => {
  const { tool, built } = makeTool(RANKABLE);
  const result = await tool.invoke({ task: "ordinary work", mode: "read_only", model_tier: "standard" });

  expect(built).toEqual([{ providerId: "ollama", modelId: SESSION_MODEL }]);
  // "we placed it here" and "we could not work it out" are different facts.
  expect(result.output).toMatch(/model tier standard .*\[session-ranked\]/);
});

test("the frozen `cheap` spelling still resolves, to the same model as light", async () => {
  const { tool, built } = makeTool(RANKABLE);
  await tool.invoke({ task: "legacy dispatch", mode: "read_only", model_tier: "cheap" });
  expect(built).toEqual([{ providerId: "ollama", modelId: BELOW }]);
});

test("an omitted model_tier inherits the parent verbatim and records no resolution", async () => {
  const { tool, built } = makeTool(RANKABLE);
  const result = await tool.invoke({ task: "unchanged behaviour", mode: "read_only" });

  expect(built).toEqual([{ providerId: "ollama", modelId: SESSION_MODEL }]);
  expect(result.output).not.toContain("model tier");
});

test("an unrankable environment keeps the session model: no downgrade, no dispatch failure", async () => {
  // Codenames all the way down, session included — so there is no anchor and
  // nothing can be called above or below anything. The failure this guards is
  // `light` silently becoming something cheaper, or the dispatch being DENIED
  // outright by `resolveChildModel`'s fail-closed `unknown model tier` rung.
  const session = CODENAMES[0]!;
  const { tool, built } = makeTool([{ name: "ollama", models: CODENAMES }], session);
  const result = await tool.invoke({ task: "still has to run", mode: "read_only", model_tier: "light" });

  expect(result.isError).toBe(false);
  expect(result.output).not.toMatch(/denied by MAE/);
  expect(built).toEqual([{ providerId: "ollama", modelId: session }]);
  expect(result.output).toMatch(/model tier light .*\[session-fallback\]/);
});

test("a tier with nothing discovered in its direction is session-RANKED, not a fallback", async () => {
  // Ranking WORKED and placed `light` at the session's own model, which is a
  // different fact from "we could not work it out" — and the reason
  // `tier_resolution` has three values rather than two.
  const { tool, built } = makeTool([{ name: "ollama", models: [SESSION_MODEL, ABOVE] }]);
  const result = await tool.invoke({ task: "nothing below", mode: "read_only", model_tier: "light" });

  expect(built).toEqual([{ providerId: "ollama", modelId: SESSION_MODEL }]);
  expect(result.output).toMatch(/model tier light .*\[session-ranked\]/);
});

test("a host that reports provider names without models still dispatches, on the session model", async () => {
  // The readline REPL call site's shape. Degraded, not broken: nothing to rank,
  // so every tier is the session's model.
  const { tool, built } = makeTool([{ name: "ollama" }]);
  const result = await tool.invoke({ task: "names only", mode: "read_only", model_tier: "deep" });

  expect(result.isError).toBe(false);
  expect(built).toEqual([{ providerId: "ollama", modelId: SESSION_MODEL }]);
  expect(result.output).toMatch(/model tier deep .*\[session-fallback\]/);
});

test("a model NAME in model_tier is not a tier — it inherits instead of being obeyed", async () => {
  // `model_tier` is an enum in the tool's input schema, but the runtime must not
  // rely on the model honouring it: an unreadable value falls through to
  // inheritance, never to a guess and never to a downgrade.
  const { tool, built } = makeTool(RANKABLE);
  const result = await tool.invoke({ task: "smuggled model id", mode: "read_only", model_tier: BELOW });

  expect(built).toEqual([{ providerId: "ollama", modelId: SESSION_MODEL }]);
  expect(result.output).not.toContain("model tier");
});
