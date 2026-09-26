// Flow 346 — the EXTERNAL switch's editable block list. Every test injects
// its own config dir (temp directories) — no real `~/.local/share/keryx`
// and no network are ever touched, and this file runs green with
// `OPENROUTER_API_KEY` unset.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveCategoryDetailed, type ConnectedPredicate, type RoutingTable } from "../harness/routing/table";
import {
  DEFAULT_EXTERNAL_PROVIDERS_CONFIG,
  externalAllowedConnectedPredicate,
  externalBlockReason,
  externalProvidersConfigPath,
  isModelIdExternal,
  isProviderIdExternal,
  loadExternalProvidersConfig,
  validateExternalProvidersConfig,
} from "./external-providers";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

describe("DEFAULT_EXTERNAL_PROVIDERS_CONFIG", () => {
  test("jev is on the list — every entry carries a non-empty reason", () => {
    expect(isProviderIdExternal("jev", DEFAULT_EXTERNAL_PROVIDERS_CONFIG)).toBe(true);
    for (const entry of DEFAULT_EXTERNAL_PROVIDERS_CONFIG.providers) {
      expect(entry.reason.length).toBeGreaterThan(0);
    }
    for (const entry of DEFAULT_EXTERNAL_PROVIDERS_CONFIG.modelPatterns) {
      expect(entry.reason.length).toBeGreaterThan(0);
    }
  });

  test("the mainstream paid US providers the operator connects directly stay OFF the default list", () => {
    for (const id of ["anthropic", "openai", "google", "gemini", "github-copilot", "grok", "xai", "groq"]) {
      expect(isProviderIdExternal(id, DEFAULT_EXTERNAL_PROVIDERS_CONFIG)).toBe(false);
    }
  });

  test("vendor prefixes and free-tier/muse model patterns match", () => {
    for (const modelId of [
      "deepseek/deepseek-chat",
      "minimax/minimax-01",
      "z-ai/glm-4.6",
      "zhipu/glm-4",
      "moonshotai/kimi-k2",
      "qwen/qwen3-235b",
      "alibaba/qwen-max",
      "baidu/ernie-4.5",
      "tencent/hunyuan-turbo",
      "bytedance/doubao-pro",
      "01-ai/yi-large",
      "some-provider/some-model:free",
      "some-provider/museified-model",
    ]) {
      expect(isModelIdExternal(modelId, DEFAULT_EXTERNAL_PROVIDERS_CONFIG)).toBe(true);
    }
    for (const modelId of ["anthropic/claude-x", "openai/gpt-4o", "google/gemini-2.0-flash"]) {
      expect(isModelIdExternal(modelId, DEFAULT_EXTERNAL_PROVIDERS_CONFIG)).toBe(false);
    }
  });
});

test("loadExternalProvidersConfig: creates the file with the built-in defaults on first use", async () => {
  const dir = await tempDir("keryx-external-providers-create-");
  const loaded = loadExternalProvidersConfig(dir);
  expect(loaded.origin).toBe("default-created");
  expect(loaded.config).toEqual(DEFAULT_EXTERNAL_PROVIDERS_CONFIG);
  const onDisk = JSON.parse(await readFile(externalProvidersConfigPath(dir), "utf8"));
  expect(onDisk).toEqual(DEFAULT_EXTERNAL_PROVIDERS_CONFIG);

  // Second call reads the just-created file back (`origin: "user-file"`), not
  // re-created — an operator's edit is never silently reverted on next read.
  const second = loadExternalProvidersConfig(dir);
  expect(second.origin).toBe("user-file");
  expect(second.config).toEqual(DEFAULT_EXTERNAL_PROVIDERS_CONFIG);
});

test("loadExternalProvidersConfig: an operator-edited file is read as-is, including an intentionally EMPTY list", async () => {
  const dir = await tempDir("keryx-external-providers-edited-");
  await writeFile(externalProvidersConfigPath(dir), JSON.stringify({ version: 1, providers: [], modelPatterns: [], notes: "cleared" }), "utf8");
  const loaded = loadExternalProvidersConfig(dir);
  expect(loaded.origin).toBe("user-file");
  expect(loaded.config.providers).toEqual([]);
  expect(loaded.config.modelPatterns).toEqual([]);
  expect(isProviderIdExternal("jev", loaded.config)).toBe(false);
});

test("loadExternalProvidersConfig: malformed JSON falls back to the built-in defaults with a warning, and never overwrites the file", async () => {
  const dir = await tempDir("keryx-external-providers-malformed-");
  const file = externalProvidersConfigPath(dir);
  await writeFile(file, "{not json at all", "utf8");
  const loaded = loadExternalProvidersConfig(dir);
  expect(loaded.origin).toBe("default-fallback-malformed");
  expect(loaded.config).toEqual(DEFAULT_EXTERNAL_PROVIDERS_CONFIG);
  expect(loaded.warning).toBeDefined();
  expect(loaded.warning).toContain("not valid JSON");
  // Never overwritten — the operator's broken-but-present file is untouched,
  // so a later manual fix is not clobbered by keryx's own fallback.
  expect(await readFile(file, "utf8")).toBe("{not json at all");
});

test("loadExternalProvidersConfig: a valid JSON document that is not the right shape also falls back, with a warning", async () => {
  const dir = await tempDir("keryx-external-providers-wrong-shape-");
  await writeFile(externalProvidersConfigPath(dir), JSON.stringify({ providers: "not an array" }), "utf8");
  const loaded = loadExternalProvidersConfig(dir);
  expect(loaded.origin).toBe("default-fallback-malformed");
  expect(loaded.config).toEqual(DEFAULT_EXTERNAL_PROVIDERS_CONFIG);
});

test("validateExternalProvidersConfig: a hand-edited entry missing `reason` reads as an empty string, not a rejection", () => {
  const parsed = validateExternalProvidersConfig({ providers: [{ id: "jev" }], modelPatterns: [] });
  expect(parsed).toBeDefined();
  expect(parsed?.providers).toEqual([{ id: "jev", reason: "" }]);
});

test("validateExternalProvidersConfig: not an object at all is rejected outright", () => {
  expect(validateExternalProvidersConfig("nope")).toBeUndefined();
  expect(validateExternalProvidersConfig(null)).toBeUndefined();
  expect(validateExternalProvidersConfig(42)).toBeUndefined();
});

test("externalBlockReason: provider match checked before model-pattern match; undefined when neither matches", () => {
  expect(externalBlockReason("jev", undefined, DEFAULT_EXTERNAL_PROVIDERS_CONFIG)).toBeDefined();
  expect(externalBlockReason(undefined, "deepseek/deepseek-chat", DEFAULT_EXTERNAL_PROVIDERS_CONFIG)).toBeDefined();
  expect(externalBlockReason("anthropic", "anthropic/claude-x", DEFAULT_EXTERNAL_PROVIDERS_CONFIG)).toBeUndefined();
});

describe("externalAllowedConnectedPredicate (AC3 — the routing choke point)", () => {
  const alwaysConnected: ConnectedPredicate = () => true;

  test("a no-op when external is on — identical to the base predicate", () => {
    const wrapped = externalAllowedConnectedPredicate(alwaysConnected, true, DEFAULT_EXTERNAL_PROVIDERS_CONFIG);
    expect(wrapped("deepseek", "deepseek-chat")).toBe(true);
  });

  test("rejects a listed provider id when external is off, keeps an unlisted one", () => {
    const wrapped = externalAllowedConnectedPredicate(alwaysConnected, false, DEFAULT_EXTERNAL_PROVIDERS_CONFIG);
    expect(wrapped("deepseek")).toBe(false);
    expect(wrapped("anthropic")).toBe(true);
  });

  test("rejects a listed model id when external is off, keeps an unlisted one", () => {
    const wrapped = externalAllowedConnectedPredicate(alwaysConnected, false, DEFAULT_EXTERNAL_PROVIDERS_CONFIG);
    expect(wrapped("openrouter", "deepseek/deepseek-chat")).toBe(false);
    expect(wrapped("openrouter", "anthropic/claude-x")).toBe(true);
  });

  test("integration: resolveCategoryDetailed falls through a blocked project assignment to the next layer, with a notice, never silently accepting it", () => {
    const table: RoutingTable = { review: { kind: "model", providerId: "openrouter", modelId: "deepseek/deepseek-chat" } };
    const userTable: RoutingTable = { review: { kind: "model", providerId: "anthropic", modelId: "claude-x" } };
    const connected = externalAllowedConnectedPredicate(alwaysConnected, false, DEFAULT_EXTERNAL_PROVIDERS_CONFIG);
    const resolved = resolveCategoryDetailed("review", { project: table, user: userTable }, connected);
    // The blocked project assignment is skipped; the next layer (user) answers.
    expect(resolved.assignment).toEqual({ kind: "model", providerId: "anthropic", modelId: "claude-x" });
    expect(resolved.source).toBe("user");
    expect(resolved.rejected?.assignment).toEqual(table.review!);
  });

  test("integration: with external on, the SAME blocked-looking assignment resolves normally (no rejection)", () => {
    const table: RoutingTable = { review: { kind: "model", providerId: "openrouter", modelId: "deepseek/deepseek-chat" } };
    const connected = externalAllowedConnectedPredicate(alwaysConnected, true, DEFAULT_EXTERNAL_PROVIDERS_CONFIG);
    const resolved = resolveCategoryDetailed("review", { project: table }, connected);
    expect(resolved.assignment).toEqual(table.review!);
    expect(resolved.rejected).toBeUndefined();
  });
});
