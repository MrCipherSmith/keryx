import { expect, test } from "bun:test";
import { selectClassifierModel } from "./classifier-model";
import { curatedSeedProfiles, type ModelProfile } from "./model-profile";
const seeds = () => curatedSeedProfiles("2026-10-06T00:00:00Z");
const providers = [{ name: "anthropic", models: ["claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5"] }];
test("standard wins over light and deep", () => {
  expect(selectClassifierModel(providers, seeds(), () => true)?.modelId).toBe("claude-sonnet-5");
});
test("deep wins when standard unavailable or denied", () => {
  const profiles = seeds();
  profiles["anthropic/claude-sonnet-5"] = { ...profiles["anthropic/claude-sonnet-5"]!, available: false };
  expect(selectClassifierModel(providers, profiles, () => true)?.modelId).toBe("claude-opus-4-8");
  expect(selectClassifierModel(providers, seeds(), (_, id) => id !== "claude-sonnet-5")?.modelId).toBe("claude-opus-4-8");
});
test("disconnected, denied, light, unknown, guessed and non-chat are excluded", () => {
  expect(selectClassifierModel([], seeds(), () => true)).toBeUndefined();
  expect(selectClassifierModel(providers, seeds(), () => false)).toBeUndefined();
  expect(selectClassifierModel([{ name: "anthropic", models: ["claude-haiku-4-5", "unknown"] }], seeds(), () => true)).toBeUndefined();
  for (const change of [{ strengthTier: { value: "standard", source: "guessed" } }, { chatCapable: false }]) {
    const profiles = seeds();
    profiles["anthropic/claude-sonnet-5"] = { ...profiles["anthropic/claude-sonnet-5"]!, ...change } as ModelProfile;
    expect(selectClassifierModel([{ name: "anthropic", models: ["claude-sonnet-5"] }], profiles, () => true)).toBeUndefined();
  }
});
test("priority and stable IDs break ties", () => {
  const profiles = seeds();
  const detected = [{ name: "anthropic", models: ["claude-sonnet-5-5", "claude-sonnet-5"] }];
  expect(selectClassifierModel(detected, profiles, () => true)?.modelId).toBe("claude-sonnet-5");
  profiles["anthropic/claude-sonnet-5-5"] = { ...profiles["anthropic/claude-sonnet-5-5"]!, priority: { value: 100, source: "operator" } };
  expect(selectClassifierModel(detected, profiles, () => true)?.modelId).toBe("claude-sonnet-5-5");
});
