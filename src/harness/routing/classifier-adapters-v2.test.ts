import { expect, test } from "bun:test";
import type { ProviderFactory } from "../provider/single-turn";
import type { NormalizedEvent, ProviderPort, StreamOptions } from "../provider/types";
import { runRoutingClassifierChain } from "./classifier-chain-v2";
import { jevRoutingClassifierAdapter, mainModelRoutingClassifierAdapter } from "./classifier-adapters-v2";

function factoryReplying(reply: string): ProviderFactory {
  return (): ProviderPort => ({
    describe: () => ({ capabilities: { streaming: true, toolCalls: false, parallelToolCalls: false, structuredOutput: false, reasoningMetadata: false, promptCaching: false, vision: false, tokenCounting: false, modelListing: false }, descriptor: { providerId: "stub" } }),
    async *stream(_request, options: StreamOptions): AsyncIterable<NormalizedEvent> {
      yield { kind: "text_delta", sequence: 0, attemptId: options.attemptId, text: reply };
      yield { kind: "model_end", sequence: 1, attemptId: options.attemptId };
    },
  });
}

const fallback = { mode: "baseline" as const };

test("main-model v2 adapter returns all strict classification fields", async () => {
  const adapter = mainModelRoutingClassifierAdapter("model", { providerId: "stub", modelId: "m", env: {}, providerFactory: factoryReplying(JSON.stringify({
    category: "coding", modelClass: "expert", confidence: 0.9, reasonCode: "implementation", requiredCapabilities: ["tools"],
  })) });
  const result = await runRoutingClassifierChain("implement it", { adapters: [adapter], minConfidence: 0.7, onFailure: fallback });
  expect(result).toMatchObject({ status: "classified", classification: { category: "coding", modelClass: "expert", requiredCapabilities: ["tools"] } });
});

test("strict chain rejects extra model fields instead of accepting partial legacy output", async () => {
  const adapter = mainModelRoutingClassifierAdapter("model", { providerId: "stub", modelId: "m", env: {}, providerFactory: factoryReplying(JSON.stringify({
    category: "coding", modelClass: "expert", confidence: 0.9, reasonCode: "implementation", requiredCapabilities: [], explanation: "not allowed",
  })) });
  const result = await runRoutingClassifierChain("implement it", { adapters: [adapter], minConfidence: 0.7, onFailure: fallback });
  expect(result).toMatchObject({ status: "fallback", reason: "classifier-failed", trace: [{ adapterId: "model", outcome: "invalid" }] });
});

test("Jev v2 adapter maps category, class, confidence, and required capabilities", async () => {
  const fetchFn = (async () => new Response(JSON.stringify({ answers: {
    category: { type: "choice", choice: "review" }, modelClass: { type: "choice", choice: "frontier" }, confidence: { type: "noul", noul: 0.88 },
    tools: { type: "noul", noul: 0.8 }, vision: { type: "noul", noul: 0.1 }, structuredOutput: { type: "noul", noul: 0.6 },
  }, usage: {} }), { status: 200 })) as unknown as typeof fetch;
  const adapter = jevRoutingClassifierAdapter("jev", { fetch: fetchFn, env: { OPENROUTER_API_KEY: "sk-or-test" } });
  const result = await runRoutingClassifierChain("review it", { adapters: [adapter], minConfidence: 0.7, onFailure: fallback });
  expect(result).toMatchObject({ status: "classified", classification: {
    category: "review", modelClass: "frontier", confidence: 0.88, requiredCapabilities: ["tools", "structured-output"],
  } });
});
