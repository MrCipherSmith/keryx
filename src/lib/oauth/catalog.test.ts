import { expect, test } from "bun:test";
import { catalogAllows, catalogRefusal, PROVIDER_AUTH_CATALOG } from "./catalog";

test("grok, openai and github-copilot declare sanctioned subscription methods", () => {
  expect(catalogAllows("grok", "device-code")).toBe(true);
  expect(catalogAllows("grok", "api-key")).toBe(true);
  expect(catalogAllows("openai", "device-code")).toBe(true);
  expect(catalogAllows("openai", "api-key")).toBe(true);
  expect(catalogAllows("github-copilot", "device-code")).toBe(true);
});

test("anthropic, gemini and deepseek do not declare subscription OAuth", () => {
  expect(catalogAllows("anthropic", "device-code")).toBe(false);
  expect(catalogAllows("gemini", "device-code")).toBe(false);
  expect(catalogAllows("deepseek", "device-code")).toBe(false);
  expect(catalogRefusal("anthropic")).toBeDefined();
  expect(catalogRefusal("gemini")).toBeDefined();
  expect(catalogRefusal("deepseek")).toBeDefined();
});

test("every catalog entry has at least one method", () => {
  for (const entry of PROVIDER_AUTH_CATALOG) {
    expect(entry.methods.length).toBeGreaterThan(0);
  }
});
