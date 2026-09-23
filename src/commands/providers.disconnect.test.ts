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
import { applyOAuthAccessToEnv, saveOAuthGrant } from "../lib/oauth/grants";
import {
  applySavedApiKeys,
  loadShellConfig,
  saveApiKey,
  saveProviderBaseUrl,
  saveProviderModelParams,
  savedCredentialEnvKeys,
} from "../lib/shell-config";
import {
  type OpenAiCompatProvider,
  allOpenAiCompatProviders,
  classifyProviderConnection,
  disconnectProvider,
  providersCommand,
  providersSharingEnvKey,
  sharedCredentialWarning,
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
  expect(classifyProviderConnection("internal-qwen", {}, dir)).toEqual({ kind: "custom", sharedWith: [] });
});

test("classifyProviderConnection: an OAuth grant classifies as oauth-grant, with the env var it maps onto", () => {
  const dir = tempDir();
  saveOAuthGrant("grok", { method: "device-code", access: "tok", obtainedAt: "2026-01-01T00:00:00.000Z" }, dir);
  expect(classifyProviderConnection("grok", {}, dir)).toEqual({ kind: "oauth-grant", envKey: "XAI_API_KEY", sharedWith: [] });
});

test("classifyProviderConnection: a key keryx saved under apiKeys classifies as saved-api-key", () => {
  const dir = tempDir();
  saveApiKey("DEEPSEEK_API_KEY", "sk-ds", dir);
  expect(classifyProviderConnection("deepseek", {}, dir)).toEqual({
    kind: "saved-api-key",
    envKey: "DEEPSEEK_API_KEY",
    sharedWith: [],
  });
});

test("classifyProviderConnection: a key present only in env (never saved by keryx) classifies as env-var-only", () => {
  const dir = tempDir();
  expect(classifyProviderConnection("deepseek", { DEEPSEEK_API_KEY: "sk-operator-exported" }, dir)).toEqual({
    kind: "env-var-only",
    envKey: "DEEPSEEK_API_KEY",
    sharedWith: [],
  });
});

test("classifyProviderConnection: no credential anywhere, and a keyless local provider, both classify as no-credential", () => {
  const dir = tempDir();
  expect(classifyProviderConnection("deepseek", {}, dir)).toEqual({ kind: "no-credential", sharedWith: [] });
  expect(classifyProviderConnection("rapid-mlx", {}, dir)).toEqual({ kind: "no-credential", sharedWith: [] });
});

// flow 304 review finding #1: an OAuth grant's env var is cleared from THIS
// process too, not just auth.json — the NEXT classification must not
// misreport it as `env-var-only` (which would wrongly tell the operator to
// `unset` a variable keryx itself set).
test("classifyProviderConnection: after applyOAuthAccessToEnv + disconnect, the provider is no longer env-var-only", () => {
  const dir = tempDir();
  saveOAuthGrant("grok", { method: "device-code", access: "tok-grok", obtainedAt: "2026-01-01T00:00:00.000Z" }, dir);
  const savedBefore = { ...process.env };
  try {
    delete process.env.XAI_API_KEY;
    applyOAuthAccessToEnv(dir); // copies the grant onto process.env.XAI_API_KEY, marks it keryx-saved
    expect(readEnv("XAI_API_KEY")).toBe("tok-grok");

    const result = disconnectProvider("grok", process.env, dir);
    expect(result.ok).toBe(true);
    expect(result.kind).toBe("oauth-grant");
    expect(readEnv("XAI_API_KEY")).toBeUndefined();

    // Reclassifying now (as `/connect` would on its next open) must see a
    // clean slate, not `env-var-only` pointing at a var keryx itself unset.
    expect(classifyProviderConnection("grok", process.env, dir)).toEqual({ kind: "no-credential", sharedWith: [] });
  } finally {
    process.env = savedBefore;
  }
});

// flow 304 review finding #1, negative case: an operator's OWN env export
// must survive an OAuth disconnect untouched (same non-negotiable as the
// saved-api-key case). Uses github-copilot/GITHUB_COPILOT_TOKEN rather than
// grok/XAI_API_KEY: `savedCredentialEnvKeys()` is a process-lifetime
// singleton, and an earlier test in this file legitimately marks
// XAI_API_KEY keryx-saved via `applyOAuthAccessToEnv` — reusing that key here
// would test yesterday's test run, not this scenario.
test("classifyProviderConnection: an operator-exported GITHUB_COPILOT_TOKEN is not touched by a github-copilot OAuth disconnect", () => {
  const dir = tempDir();
  saveOAuthGrant("github-copilot", { method: "device-code", access: "tok-gh", obtainedAt: "2026-01-01T00:00:00.000Z" }, dir);
  const savedBefore = { ...process.env };
  try {
    process.env.GITHUB_COPILOT_TOKEN = "operator-exported-token"; // NOT loaded via applyOAuthAccessToEnv
    disconnectProvider("github-copilot", process.env, dir);
    expect(readEnv("GITHUB_COPILOT_TOKEN")).toBe("operator-exported-token");
  } finally {
    process.env = savedBefore;
  }
});

// --- providersSharingEnvKey / sharedCredentialWarning (flow 304 review #2) --
// "Built-in zai and zai-coding share ZAI_API_KEY, so removing one silently
// removes the other's credential." Fix: name every affected provider,
// generically over the registry + custom providers — never special-cased.

test("providersSharingEnvKey: the real zai/zai-coding pair share ZAI_API_KEY, found generically from the registry", () => {
  const dir = tempDir();
  const all = allOpenAiCompatProviders(dir);
  expect(providersSharingEnvKey("ZAI_API_KEY", "zai", all)).toEqual(["zai-coding"]);
  expect(providersSharingEnvKey("ZAI_API_KEY", "zai-coding", all)).toEqual(["zai"]);
});

test("providersSharingEnvKey: generic over ANY provider list — not special-cased to zai's names", () => {
  // Real custom providers (`llm-providers.json`) always store their credential
  // INLINE (`CustomCompatProvider.apiKey`) and never carry an `envKey`, so this
  // exact collision cannot happen through today's "add custom provider"
  // wizard. `providersSharingEnvKey` does not know or care where a provider
  // came from, though: it scans whatever `OpenAiCompatProvider[]` it is
  // given, matching on `.envKey` alone — proven here with a hand-built list
  // (shaped the way a custom-provider entry would be: `requiresApiKey:
  // false`, no registry `note`) rather than a real save/load round-trip.
  const providers: OpenAiCompatProvider[] = [
    { name: "openai-gateway-a", label: "Gateway A", baseUrl: "http://10.0.0.9:8080", envKey: "OPENAI_API_KEY", requiresApiKey: false, models: [] },
    { name: "openai-gateway-b", label: "Gateway B", baseUrl: "http://10.0.0.10:8080", envKey: "OPENAI_API_KEY", requiresApiKey: false, models: [] },
    { name: "unrelated", label: "Unrelated", baseUrl: "http://10.0.0.11:8080", envKey: "SOME_OTHER_KEY", models: [] },
  ];
  expect(providersSharingEnvKey("OPENAI_API_KEY", "openai-gateway-a", providers)).toEqual(["openai-gateway-b"]);
  expect(providersSharingEnvKey("OPENAI_API_KEY", "openai-gateway-b", providers)).toEqual(["openai-gateway-a"]);
  expect(providersSharingEnvKey("SOME_OTHER_KEY", "unrelated", providers)).toEqual([]);
});

test("sharedCredentialWarning: names every sibling and the shared env var; undefined when there is nothing to warn about", () => {
  expect(sharedCredentialWarning(["zai-coding"], "ZAI_API_KEY")).toBe("this also disconnects zai-coding (same ZAI_API_KEY)");
  expect(sharedCredentialWarning(["a", "b"], "OPENAI_API_KEY")).toBe("this also disconnects a, b (same OPENAI_API_KEY)");
  expect(sharedCredentialWarning([], "ZAI_API_KEY")).toBeUndefined();
  expect(sharedCredentialWarning(["zai-coding"], undefined)).toBeUndefined();
});

test("classifyProviderConnection: zai's sharedWith names zai-coding (real registry pair)", () => {
  const dir = tempDir();
  saveApiKey("ZAI_API_KEY", "sk-zai", dir);
  const classification = classifyProviderConnection("zai", {}, dir);
  expect(classification.kind).toBe("saved-api-key");
  expect(classification.sharedWith).toEqual(["zai-coding"]);
});

test("disconnectProvider: disconnecting zai reports zai-coding in sharedWith, and ACTUALLY also disconnects it (one shared ZAI_API_KEY entry)", () => {
  const dir = tempDir();
  saveApiKey("ZAI_API_KEY", "sk-zai", dir);
  const result = disconnectProvider("zai", {}, dir);
  expect(result).toEqual({ ok: true, kind: "saved-api-key", sharedWith: ["zai-coding"] });
  // The one shared `apiKeys.ZAI_API_KEY` entry is gone, so zai-coding's OWN
  // credential is gone too — this is the fact #2 asks to be NAMED, not a
  // fresh bug this test introduces.
  expect(classifyProviderConnection("zai-coding", {}, dir).kind).toBe("no-credential");
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
  expect(result).toEqual({ ok: true, kind: "custom", sharedWith: [] });

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
  expect(result).toEqual({ ok: true, kind: "oauth-grant", sharedWith: [] });
  expect(Object.keys(loadShellConfig(dir).oauthGrants ?? {})).toEqual(["github-copilot"]);
});

test("disconnectProvider: removes a saved API key, leaving a sibling key intact", () => {
  const dir = tempDir();
  saveApiKey("DEEPSEEK_API_KEY", "sk-ds", dir);
  saveApiKey("GROQ_API_KEY", "gsk-x", dir);

  const result = disconnectProvider("deepseek", {}, dir);
  expect(result).toEqual({ ok: true, kind: "saved-api-key", sharedWith: [] });
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
  expect(result).toEqual({
    ok: true,
    kind: "no-credential",
    reason: "no saved credential for this provider — nothing to remove",
    sharedWith: [],
  });
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

// flow 304 review finding #3: an unknown name used to report success and exit 0.
test("keryx providers remove: an unknown provider name errors, exits 1, and never asks to confirm", async () => {
  const dir = tempDir();
  let confirmCalled = false;
  const before = process.exitCode;
  const errors: string[] = [];
  const orig = console.error;
  console.error = (line: string) => errors.push(line);
  try {
    await providersCommand(["remove", "not-a-real-provider", "--yes"], {
      dir,
      env: {},
      confirm: async () => {
        confirmCalled = true;
        return true;
      },
    });
  } finally {
    console.error = orig;
    expect(process.exitCode).toBe(1);
    process.exitCode = before;
  }
  expect(errors.join("\n")).toContain("Unknown provider: not-a-real-provider");
  expect(confirmCalled).toBe(false);
});

test("keryx providers remove --json: an unknown provider name reports ok:false, exit 1", async () => {
  const dir = tempDir();
  const logs: string[] = [];
  const orig = console.log;
  console.log = (line: string) => logs.push(line);
  const before = process.exitCode;
  try {
    await providersCommand(["remove", "not-a-real-provider", "--yes", "--json"], { dir, env: {} });
  } finally {
    console.log = orig;
    expect(process.exitCode).toBe(1);
    process.exitCode = before;
  }
  const parsed = JSON.parse(logs.join("\n")) as { provider: string; ok: boolean; reason: string };
  expect(parsed).toEqual({ provider: "not-a-real-provider", ok: false, reason: "unknown provider" });
});

// flow 304 review finding #2: the confirmation and the result must name every
// OTHER provider a shared env var also disconnects.
test("keryx providers remove: the confirmation prompt names zai-coding when disconnecting zai (same ZAI_API_KEY)", async () => {
  const dir = tempDir();
  saveApiKey("ZAI_API_KEY", "sk-zai", dir);
  let question = "";
  await providersCommand(["remove", "zai"], {
    dir,
    env: {},
    confirm: async (q: string) => {
      question = q;
      return true;
    },
  });
  expect(question).toContain("zai-coding");
  expect(question).toContain("ZAI_API_KEY");
});

test("keryx providers remove --yes: the result message and --json BOTH name zai-coding for a zai disconnect", async () => {
  const dir = tempDir();
  saveApiKey("ZAI_API_KEY", "sk-zai", dir);
  const textLogs: string[] = [];
  const orig = console.log;
  console.log = (line: string) => textLogs.push(line);
  try {
    await providersCommand(["remove", "zai", "--yes"], { dir, env: {} });
  } finally {
    console.log = orig;
  }
  expect(textLogs.join("\n")).toContain("zai-coding");
  expect(textLogs.join("\n")).toContain("ZAI_API_KEY");

  // Fresh saved key for the --json run (the text run above already removed it).
  saveApiKey("ZAI_API_KEY", "sk-zai-2", dir);
  const jsonLogs: string[] = [];
  console.log = (line: string) => jsonLogs.push(line);
  try {
    await providersCommand(["remove", "zai", "--yes", "--json"], { dir, env: {} });
  } finally {
    console.log = orig;
  }
  const parsed = JSON.parse(jsonLogs.join("\n")) as { ok: boolean; sharedWith: string[] };
  expect(parsed.ok).toBe(true);
  expect(parsed.sharedWith).toEqual(["zai-coding"]);
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
