import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { approveProjectRouting, setRoutingCategory } from "../harness/routing/settings";
import { saveShellConfig } from "../lib/shell-config";
import { makeDeskReviewProvider, resolveDeskReviewModel } from "./review-desk-provider";

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "desk-provider-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("watcher resolves the saved model and credential in a fresh process with no terminal environment", async () => {
  saveShellConfig({ provider: "anthropic", model: "selected-model", apiKeys: { ANTHROPIC_API_KEY: "fixture" } }, dir);
  expect(await resolveDeskReviewModel(dir, dir, {})).toEqual({ provider: "anthropic", model: "selected-model" });
  expect(makeDeskReviewProvider("anthropic", "selected-model", dir, {}).describe().descriptor.providerId).toBe("anthropic");
});

test("a concrete review routing assignment wins over the persisted shell selection", async () => {
  saveShellConfig({ provider: "ollama", model: "other-model" }, dir);
  await setRoutingCategory("user", { cwd: dir, configDir: dir }, "review", { mode: "model", target: { providerId: "openai", modelId: "review-model" } });
  expect(await resolveDeskReviewModel(dir, dir, { OPENAI_API_KEY: "fixture" })).toEqual({ provider: "openai", model: "review-model" });
});

test("missing credentials do not silently switch provider or execute a fake adapter", async () => {
  saveShellConfig({ provider: "anthropic", model: "chosen" }, dir);
  await expect(resolveDeskReviewModel(dir, dir, { OPENAI_API_KEY: "fixture" })).rejects.toThrow("selected review provider is unavailable");
  expect(() => makeDeskReviewProvider("fake", "fake-echo", dir, {})).toThrow("selected review provider is unavailable");
});

test("no saved selection uses one credentialed provider and refuses an ambiguous choice", async () => {
  expect((await resolveDeskReviewModel(dir, dir, { OPENAI_API_KEY: "fixture" })).provider).toBe("openai");
  await expect(resolveDeskReviewModel(dir, dir, { OPENAI_API_KEY: "fixture", ANTHROPIC_API_KEY: "fixture" })).rejects.toThrow("Choose a connected provider");
  await expect(resolveDeskReviewModel(dir, dir, {})).rejects.toThrow("Choose a connected provider");
});

test("the project external policy applies to the provider before model work begins", async () => {
  saveShellConfig({ provider: "deepseek", model: "review-model", external: "off" }, dir);
  await expect(resolveDeskReviewModel(dir, dir, { DEEPSEEK_API_KEY: "fixture" })).rejects.toThrow("blocked");
});

test("a mismatched reviewer route is named before a model call, and only an approved project route overrides it", async () => {
  const location = { cwd: dir, configDir: dir };
  saveShellConfig({ provider: "anthropic", model: "review-model", apiKeys: { ANTHROPIC_API_KEY: "fixture" } }, dir);
  await setRoutingCategory("user", location, "subagents", { mode: "model", target: { providerId: "openrouter", modelId: "different" } });
  await setRoutingCategory("project", location, "subagents", { mode: "model", target: { providerId: "anthropic", modelId: "review-model" } });
  await expect(resolveDeskReviewModel(dir, dir, {})).rejects.toThrow("Review requires anthropic/review-model, but Subagents is set to openrouter/different in user routing settings");
  expect(approveProjectRouting(location).ok).toBe(true);
  expect(await resolveDeskReviewModel(dir, dir, {})).toEqual({ provider: "anthropic", model: "review-model" });
});
