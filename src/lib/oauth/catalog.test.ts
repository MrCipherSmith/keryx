import { expect, test } from "bun:test";
import {
  catalogAllows,
  catalogRefusal,
  extraRequestHeaders,
  GITHUB_COPILOT_DEVICE,
  GITHUB_COPILOT_OAUTH_CLIENT_ID,
  PROVIDER_AUTH_CATALOG,
} from "./catalog";

test("grok, openai-codex and github-copilot declare sanctioned subscription methods", () => {
  expect(catalogAllows("grok", "device-code")).toBe(true);
  expect(catalogAllows("grok", "api-key")).toBe(true);
  expect(catalogAllows("openai", "device-code")).toBe(false);
  expect(catalogAllows("openai-codex", "device-code")).toBe(true);
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

test("github-copilot uses the Copilot GitHub App client, not OpenCode's OAuth App", () => {
  expect(GITHUB_COPILOT_OAUTH_CLIENT_ID).toBe("Iv1.b507a08c87ecfe98");
  expect(GITHUB_COPILOT_DEVICE.clientId).toBe(GITHUB_COPILOT_OAUTH_CLIENT_ID);
  expect(GITHUB_COPILOT_DEVICE.clientId).not.toMatch(/^Ov23li/);
  expect(GITHUB_COPILOT_DEVICE.headers?.["Editor-Version"]).toBe("vscode/1.99.3");
  expect(extraRequestHeaders("github-copilot")?.["Copilot-Integration-Id"]).toBe("vscode-chat");
  expect(extraRequestHeaders("grok")).toBeUndefined();
});
