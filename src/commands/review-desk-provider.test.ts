import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ROUTING_SCHEMA_VERSION } from "../harness/routing/config";
import { approveProjectRouting, replaceRoutingLayer, setRoutingCategory } from "../harness/routing/settings";
import { externalProvidersConfigPath } from "../lib/external-providers";
import { writeProjectExternalSetting } from "../lib/external-switch";
import { saveShellConfig } from "../lib/shell-config";
import { makeDeskReviewProvider, resolveDeskReviewModel } from "./review-desk-provider";

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "desk-provider-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("watcher resolves the saved model and credential in a fresh process with no terminal environment", async () => {
  saveShellConfig({ provider: "anthropic", model: "selected-model", apiKeys: { ANTHROPIC_API_KEY: "fixture" } }, path.join(dir, "keryx"));
  const modulePath = path.join(import.meta.dir, "review-desk-provider.ts");
  const probe = `
    import { resolveDeskReviewModel, makeDeskReviewProvider } from ${JSON.stringify(modulePath)};
    globalThis.fetch = () => { throw new Error("Provider selection must stay offline"); };
    const { provider, model } = await resolveDeskReviewModel(process.cwd());
    const adapter = makeDeskReviewProvider(provider, model);
    console.log(JSON.stringify({ provider, model, adapter: adapter.describe().descriptor.providerId }));
  `;
  const result = execFileSync(process.execPath, ["--no-env-file", "-e", probe], {
    cwd: dir, env: { HOME: dir, XDG_DATA_HOME: dir, APPDATA: dir }, encoding: "utf8", timeout: 10_000,
  });
  expect(JSON.parse(result)).toEqual({ provider: "anthropic", model: "selected-model", adapter: "anthropic" });
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

test("a uniquely inferred baseline satisfies session-only but a separate assignment needs a saved session", async () => {
  const location = { cwd: dir, configDir: dir };
  await replaceRoutingLayer("user", location, {
    schemaVersion: ROUTING_SCHEMA_VERSION,
    providers: { scope: "session-only", allowlist: [], preferSessionProvider: true },
  });
  expect((await resolveDeskReviewModel(dir, dir, { OPENAI_API_KEY: "fixture" })).provider).toBe("openai");
  await setRoutingCategory("user", location, "review", { mode: "model", target: { providerId: "openai", modelId: "review-model" } });
  await expect(resolveDeskReviewModel(dir, dir, { OPENAI_API_KEY: "fixture" })).rejects.toThrow("outside the project's routing scope");
});

test("the project external policy applies to the provider before model work begins", async () => {
  saveShellConfig({ provider: "deepseek", model: "review-model", external: "on" }, dir);
  await writeProjectExternalSetting(dir, "off");
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

test("an external policy entry remains binding without a display reason", async () => {
  saveShellConfig({ provider: "openai", model: "review-model", external: "off" }, dir);
  for (const block of [
    { providers: [{ id: "openai" }], modelPatterns: [] },
    { providers: [], modelPatterns: [{ pattern: "review-*", reason: "" }] },
  ]) {
    writeFileSync(externalProvidersConfigPath(dir), JSON.stringify({ version: 1, notes: "", ...block }));
    await expect(resolveDeskReviewModel(dir, dir, { OPENAI_API_KEY: "fixture" })).rejects.toThrow("blocked");
  }
});
