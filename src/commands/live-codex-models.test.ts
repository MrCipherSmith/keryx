import { expect, test } from "bun:test";
import { createLiveCodexModels, mergeLiveCodexModels } from "./live-codex-models";

const STUB = [{ name: "openai-codex", models: ["gpt-5.3-codex"] }, { name: "anthropic" }];

test("the live list replaces the stale curated codex list and leaves other providers alone", () => {
  const merged = mergeLiveCodexModels(STUB, ["gpt-6.1-sol", "gpt-6-luna"]);
  expect(merged).toEqual([
    { name: "openai-codex", models: ["gpt-6.1-sol", "gpt-6-luna"] },
    { name: "anthropic", models: [] },
  ]);
});

test("without a live list the detected catalogue is unchanged, and the provider set is never widened", () => {
  expect(mergeLiveCodexModels(STUB, undefined)[0]?.models).toEqual(["gpt-5.3-codex"]);
  expect(mergeLiveCodexModels([{ name: "anthropic" }], ["gpt-6-luna"])).toEqual([{ name: "anthropic", models: [] }]);
});

test("a live fetch is cached; a failed or non-live one keeps the curated list", async () => {
  const live = createLiveCodexModels(undefined, {
    hasGrant: () => true,
    fetchModels: async () => ({ models: ["gpt-6.1-sol", "gpt-6-luna"], source: "live" }),
  });
  expect(live.models()).toBeUndefined();
  await live.start();
  expect(live.models()).toEqual(["gpt-6.1-sol", "gpt-6-luna"]);

  const failing = createLiveCodexModels(undefined, { hasGrant: () => true, fetchModels: async () => { throw new Error("offline"); } });
  await failing.start();
  expect(failing.models()).toBeUndefined();

  const fallback = createLiveCodexModels(undefined, { hasGrant: () => true, fetchModels: async () => ({ models: [], source: "fallback" }) });
  await fallback.start();
  expect(fallback.models()).toBeUndefined();

  let fetched = false;
  const noGrant = createLiveCodexModels(undefined, { hasGrant: () => false, fetchModels: async () => { fetched = true; return { models: ["x"], source: "live" }; } });
  await noGrant.start();
  expect(fetched).toBe(false);
});
