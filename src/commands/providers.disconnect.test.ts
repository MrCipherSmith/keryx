// flow 304: "Test connection" and "Disconnect" for a provider — the pure
// classify/probe/remove logic behind the `/connect` row buttons and
// `keryx providers test`/`keryx providers remove`. TUI mouse/keyboard
// coverage lives in `src/tui/connect-provider-buttons.test.ts`; this file
// covers the logic those buttons call, plus the CLI subcommands directly.
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadCustomCompatProviders, saveCustomCompatProvider } from "../lib/provider-config";
import { saveOAuthGrant } from "../lib/oauth/grants";
import {
  applySavedApiKeys,
  loadShellConfig,
  saveApiKey,
  saveProviderBaseUrl,
  saveProviderModelParams,
  savedCredentialEnvKeys,
} from "../lib/shell-config";
import {
  classifyProviderConnection,
  disconnectProvider,
  providersCommand,
  testProviderConnection,
  providerByName,
} from "./providers";

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "keryx-providers-disconnect-"));
}

// --- classifyProviderConnection --------------------------------------------

test("classifyProviderConnection: a custom provider's llm-providers.json entry outranks everything else", () => {
  const dir = tempDir();
  saveCustomCompatProvider({ name: "internal-qwen", baseUrl: "http://10.0.0.1:8080", models: [] }, dir);
  expect(classifyProviderConnection("internal-qwen", {}, dir)).toEqual({ kind: "custom" });
});

test("classifyProviderConnection: an OAuth grant classifies as oauth-grant", () => {
  const dir = tempDir();
  saveOAuthGrant("grok", { method: "device-code", access: "tok", obtainedAt: "2026-01-01T00:00:00.000Z" }, dir);
  expect(classifyProviderConnection("grok", {}, dir)).toEqual({ kind: "oauth-grant" });
});

test("classifyProviderConnection: a key keryx saved under apiKeys classifies as saved-api-key", () => {
  const dir = tempDir();
  saveApiKey("DEEPSEEK_API_KEY", "sk-ds", dir);
  expect(classifyProviderConnection("deepseek", {}, dir)).toEqual({ kind: "saved-api-key", envKey: "DEEPSEEK_API_KEY" });
});

test("classifyProviderConnection: a key present only in env (never saved by keryx) classifies as env-var-only", () => {
  const dir = tempDir();
  expect(classifyProviderConnection("deepseek", { DEEPSEEK_API_KEY: "sk-operator-exported" }, dir)).toEqual({
    kind: "env-var-only",
    envKey: "DEEPSEEK_API_KEY",
  });
});

test("classifyProviderConnection: no credential anywhere, and a keyless local provider, both classify as no-credential", () => {
  const dir = tempDir();
  expect(classifyProviderConnection("deepseek", {}, dir)).toEqual({ kind: "no-credential" });
  expect(classifyProviderConnection("rapid-mlx", {}, dir)).toEqual({ kind: "no-credential" });
});

// --- disconnectProvider (AC5, AC6, AC7) -------------------------------------

test("disconnectProvider: removes a custom provider's entry AND its saved base URL / model params (AC5)", () => {
  const dir = tempDir();
  saveCustomCompatProvider({ name: "internal-qwen", baseUrl: "http://10.0.0.1:8080", models: [] }, dir);
  // Simulate an operator who also edited the endpoint / model params in-TUI.
  saveProviderBaseUrl("internal-qwen", "http://10.0.0.2:9090", dir);
  saveProviderModelParams("internal-qwen", { temperature: 0.5 }, dir);
  // A sibling, to prove only "internal-qwen" is touched.
  saveCustomCompatProvider({ name: "other", baseUrl: "http://10.0.0.3:8080", models: [] }, dir);
  saveProviderBaseUrl("other", "http://10.0.0.4:8080", dir);

  const result = disconnectProvider("internal-qwen", {}, dir);
  expect(result).toEqual({ ok: true, kind: "custom" });

  const cfg = loadShellConfig(dir);
  expect(cfg.baseUrls).toEqual({ other: "http://10.0.0.4:8080" });
  expect(cfg.modelParams ?? {}).toEqual({});
  expect(loadCustomCompatProviders(dir).map((p) => p.name)).toEqual(["other"]);
});

test("disconnectProvider: removes an OAuth grant via logoutProvider, leaving a sibling grant intact", () => {
  const dir = tempDir();
  saveOAuthGrant("grok", { method: "device-code", access: "tok-grok", obtainedAt: "2026-01-01T00:00:00.000Z" }, dir);
  saveOAuthGrant("github-copilot", { method: "device-code", access: "tok-gh", obtainedAt: "2026-01-01T00:00:00.000Z" }, dir);

  const result = disconnectProvider("grok", {}, dir);
  expect(result).toEqual({ ok: true, kind: "oauth-grant" });
  expect(Object.keys(loadShellConfig(dir).oauthGrants ?? {})).toEqual(["github-copilot"]);
});

test("disconnectProvider: removes a saved API key, leaving a sibling key intact", () => {
  const dir = tempDir();
  saveApiKey("DEEPSEEK_API_KEY", "sk-ds", dir);
  saveApiKey("GROQ_API_KEY", "gsk-x", dir);

  const result = disconnectProvider("deepseek", {}, dir);
  expect(result).toEqual({ ok: true, kind: "saved-api-key" });
  expect(loadShellConfig(dir).apiKeys).toEqual({ GROQ_API_KEY: "gsk-x" });
});

test("disconnectProvider: an env-var-only credential is refused, names the variable, and writes nothing (AC6)", () => {
  const dir = tempDir();
  const before = loadShellConfig(dir);
  const result = disconnectProvider("deepseek", { DEEPSEEK_API_KEY: "sk-operator-exported" }, dir);
  expect(result.ok).toBe(false);
  expect(result.kind).toBe("env-var-only");
  expect(result.reason).toContain("DEEPSEEK_API_KEY");
  expect(result.reason).toContain("unset DEEPSEEK_API_KEY");
  // Hermetic proof of "writes nothing": the config file state is unchanged
  // (still whatever `loadShellConfig` returned for an untouched temp dir).
  expect(loadShellConfig(dir)).toEqual(before);
});

test("disconnectProvider: a provider with nothing saved is a no-op that still reports ok (defensive; the UI never offers this)", () => {
  const dir = tempDir();
  const result = disconnectProvider("rapid-mlx", {}, dir);
  expect(result).toEqual({ ok: true, kind: "no-credential", reason: "no saved credential for this provider — nothing to remove" });
});

function readEnv(key: string): string | undefined {
  // A helper, not an inline `process.env.X` read: TS narrows a property
  // access on `process.env` to `undefined` for the rest of a block after a
  // `delete` of that same property, which a same-block re-read can't widen
  // back out of even with an explicit annotation. A function boundary resets
  // that narrowing.
  return process.env[key];
}

test("disconnectProvider: a keryx-saved key is cleared from THIS process's env (AC7)", () => {
  const dir = tempDir();
  saveApiKey("DEEPSEEK_API_KEY", "sk-ds", dir);
  const savedBefore = { ...process.env };
  try {
    delete process.env.DEEPSEEK_API_KEY;
    applySavedApiKeys(dir); // loads it into process.env AND records it as keryx-saved
    expect(readEnv("DEEPSEEK_API_KEY")).toBe("sk-ds");
    expect(savedCredentialEnvKeys().has("DEEPSEEK_API_KEY")).toBe(true);

    disconnectProvider("deepseek", process.env, dir);
    expect(readEnv("DEEPSEEK_API_KEY")).toBeUndefined();
  } finally {
    process.env = savedBefore;
  }
});

test("disconnectProvider: an operator-exported env var is NEVER cleared from process.env, even for a different provider's disconnect", () => {
  const dir = tempDir();
  saveApiKey("GROQ_API_KEY", "gsk-saved", dir);
  const savedBefore = { ...process.env };
  try {
    process.env.DEEPSEEK_API_KEY = "sk-operator-exported"; // never saved by keryx
    disconnectProvider("groq", process.env, dir); // unrelated provider
    expect(process.env.DEEPSEEK_API_KEY).toBe("sk-operator-exported");
  } finally {
    process.env = savedBefore;
  }
});

// --- testProviderConnection (AC2's underlying probe) ------------------------

test("testProviderConnection: reuses the live model-list probe and reports ok/count", async () => {
  const provider = providerByName("deepseek");
  expect(provider).toBeDefined();
  const fetchFn = (async () => ({
    ok: true,
    json: async () => ({ data: [{ id: "deepseek-chat" }, { id: "deepseek-reasoner" }] }),
  }) as Response) as unknown as typeof fetch;
  const result = await testProviderConnection(provider!, fetchFn, { DEEPSEEK_API_KEY: "sk-test" });
  expect(result.source).toBe("live");
  expect(result.models).toEqual(["deepseek-chat", "deepseek-reasoner"]);
});

test("testProviderConnection: a rejected credential reports the humanizable failure", async () => {
  const provider = providerByName("deepseek");
  expect(provider).toBeDefined();
  const fetchFn = (async () => ({ ok: false, status: 401, text: async () => "" }) as Response) as unknown as typeof fetch;
  const result = await testProviderConnection(provider!, fetchFn, { DEEPSEEK_API_KEY: "sk-bad" });
  expect(result.source).toBe("fallback");
  expect(result.failure).toEqual({ kind: "rejected", status: 401 });
});

// --- CLI parity: `keryx providers test` / `keryx providers remove` (AC8) ---

test("keryx providers test: prints ok + model count on a live probe, --json included", async () => {
  const dir = tempDir();
  const logs: string[] = [];
  const orig = console.log;
  console.log = (line: string) => logs.push(line);
  try {
    const fetchFn = (async () => ({ ok: true, json: async () => ({ data: [{ id: "m1" }] }) }) as Response) as unknown as typeof fetch;
    await providersCommand(["test", "deepseek", "--json"], { fetch: fetchFn, env: { DEEPSEEK_API_KEY: "sk-test" }, dir });
  } finally {
    console.log = orig;
  }
  const parsed = JSON.parse(logs.join("\n")) as { ok: boolean; models: number };
  expect(parsed.ok).toBe(true);
  expect(parsed.models).toBe(1);
});

test("keryx providers test: an unknown provider name exits non-zero without a network call", async () => {
  let called = false;
  const fetchFn = (async () => {
    called = true;
    return { ok: true, json: async () => ({ data: [] }) } as Response;
  }) as unknown as typeof fetch;
  const before = process.exitCode;
  try {
    await providersCommand(["test", "not-a-real-provider"], { fetch: fetchFn });
  } finally {
    expect(process.exitCode).toBe(1);
    process.exitCode = before;
  }
  expect(called).toBe(false);
});

test("keryx providers remove --yes: removes a saved key without prompting", async () => {
  const dir = tempDir();
  saveApiKey("DEEPSEEK_API_KEY", "sk-ds", dir);
  const logs: string[] = [];
  const orig = console.log;
  console.log = (line: string) => logs.push(line);
  try {
    await providersCommand(["remove", "deepseek", "--yes"], { dir, env: {} });
  } finally {
    console.log = orig;
  }
  expect(loadShellConfig(dir).apiKeys ?? {}).toEqual({});
  expect(logs.join("\n")).toContain("disconnected");
});

test("keryx providers remove: declining the confirmation writes nothing (AC4 CLI parity)", async () => {
  const dir = tempDir();
  saveApiKey("DEEPSEEK_API_KEY", "sk-ds", dir);
  const before = loadShellConfig(dir);
  await providersCommand(["remove", "deepseek"], { dir, env: {}, confirm: async () => false });
  expect(loadShellConfig(dir)).toEqual(before);
});

test("keryx providers remove: without --yes and without a confirm seam, refuses non-interactively rather than guessing", async () => {
  const dir = tempDir();
  saveApiKey("DEEPSEEK_API_KEY", "sk-ds", dir);
  const before = process.exitCode;
  try {
    // No `confirm` deps: falls through to the real TTY prompt, which
    // `../lib/prompt`'s `confirm()` itself resolves to `false` off a TTY —
    // so this exercises the REAL refusal path, not a mock of it.
    await providersCommand(["remove", "deepseek"], { dir, env: {} });
  } finally {
    if (!process.stdin.isTTY) expect(process.exitCode).toBe(1);
    process.exitCode = before;
  }
  expect(loadShellConfig(dir).apiKeys).toEqual({ DEEPSEEK_API_KEY: "sk-ds" }); // untouched
});

test("keryx providers remove: an env-var-only provider is refused even with --yes", async () => {
  const dir = tempDir();
  const logs: string[] = [];
  const orig = console.log;
  console.log = (line: string) => logs.push(line);
  const before = process.exitCode;
  try {
    await providersCommand(["remove", "deepseek", "--yes"], { dir, env: { DEEPSEEK_API_KEY: "sk-exported" } });
  } finally {
    console.log = orig;
    expect(process.exitCode).toBe(1);
    process.exitCode = before;
  }
  expect(logs.join("\n")).toContain("DEEPSEEK_API_KEY");
});

test("keryx providers list stays network-free (AC8): no fetch call", async () => {
  let called = false;
  const originalFetch = globalThis.fetch;
  // @ts-expect-error -- test-only stub to prove `list` never reaches for the network
  globalThis.fetch = async () => {
    called = true;
    throw new Error("keryx providers list must never call fetch");
  };
  try {
    const logs: string[] = [];
    const orig = console.log;
    console.log = (line: string) => logs.push(line);
    try {
      await providersCommand(["list"]);
    } finally {
      console.log = orig;
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
  expect(called).toBe(false);
});
