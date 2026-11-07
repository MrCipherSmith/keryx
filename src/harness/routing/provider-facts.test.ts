import { expect, test } from "bun:test";
import { inspectProviderRoutingFacts, routingPolicyRevision } from "./provider-facts";

test("provider routing facts expose only explicitly reported capabilities", () => {
  const target = { providerId: "demo", modelId: "model" };
  const facts = inspectProviderRoutingFacts([target], () => ({
    descriptor: { providerId: "demo", providerRevision: "r1" },
    capabilities: {
      streaming: true, toolCalls: true, parallelToolCalls: false, structuredOutput: false,
      reasoningMetadata: false, promptCaching: false, vision: true, tokenCounting: false, modelListing: false,
    },
  }));

  expect(facts.capabilities(target)).toEqual(["tools", "vision"]);
  expect(facts.capabilityRevision).toHaveLength(64);
});

test("provider routing facts fail closed and policy revisions ignore target order", () => {
  const left = { providerId: "a", modelId: "m" };
  const right = { providerId: "b", modelId: "m" };
  const facts = inspectProviderRoutingFacts([left], () => undefined);
  expect(facts.capabilities(left)).toEqual([]);
  expect(routingPolicyRevision([left, right], (target) => target.providerId === "a"))
    .toBe(routingPolicyRevision([right, left], (target) => target.providerId === "a"));
});
