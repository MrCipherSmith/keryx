import { expect, test } from "bun:test";
import { startSessionLimits, type ModelLimits } from "./model-limits";
import { agentContextWindow } from "./agent";

const input = { provider: "openai-codex", model: "fixture" };

test("background limits yield before probing and a pending probe does not block the caller", async () => {
  let calls = 0;
  let resolve!: (limits: ModelLimits) => void;
  const pending = new Promise<ModelLimits>((done) => { resolve = done; });
  const state = startSessionLimits(input, async () => { calls++; return pending; });
  expect(calls).toBe(0);
  expect(state.getContextWindow()).toBeUndefined();
  await Bun.sleep(10);
  expect(calls).toBe(1);
  expect(state.getContextWindow()).toBeUndefined();
  const copiedDeps = { ...state };
  resolve({ contextWindow: 128000 });
  await state.ready;
  expect(agentContextWindow(copiedDeps)).toBe(128000);
});

test("a late response for an old model cannot overwrite the new selection", async () => {
  let resolve!: (limits: ModelLimits) => void;
  const pending = new Promise<ModelLimits>((done) => { resolve = done; });
  const old = startSessionLimits(input, async () => pending);
  const current = startSessionLimits({ ...input, model: "new" }, async () => ({ contextWindow: 64000 }));
  await current.ready;
  resolve({ contextWindow: 128000 });
  await old.ready;
  expect(agentContextWindow(current)).toBe(64000);
  expect(agentContextWindow(old)).toBe(128000);
});

test("failed or empty background limits stay unknown and never reject startup", async () => {
  for (const load of [async (): Promise<ModelLimits> => { throw new Error("offline"); }, async () => ({})]) {
    const state = startSessionLimits(input, load);
    await state.ready;
    expect(agentContextWindow(state)).toBeUndefined();
  }
  expect(agentContextWindow({ contextWindow: 32000 })).toBe(32000);
  expect(agentContextWindow({ contextWindow: 32000, getContextWindow: () => undefined })).toBeUndefined();
});
