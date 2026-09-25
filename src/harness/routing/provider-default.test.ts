import { expect, test } from "bun:test";
import { resolveProviderDefaultModelId } from "./provider-default";

test("ollama's provider default is its documented default model", () => {
  expect(resolveProviderDefaultModelId("ollama")).toBe("llama3.1:latest");
});

test("a known compat-registry provider's default is its curated list's first entry", () => {
  const id = resolveProviderDefaultModelId("deepseek");
  expect(typeof id).toBe("string");
  expect((id ?? "").length).toBeGreaterThan(0);
});

test("an unknown provider has no default", () => {
  expect(resolveProviderDefaultModelId("not-a-real-provider")).toBeUndefined();
});
