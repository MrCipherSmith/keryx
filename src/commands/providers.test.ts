import { expect, test } from "bun:test";
import type { CustomCompatProvider } from "../lib/provider-config";
import {
  OPENAI_COMPAT_PROVIDERS,
  fetchOpenAiCompatModels,
  fetchOpenAiCompatModelsDetailed,
  isProviderPlatformSupported,
  providerByName,
  providerBaseUrlEnvKey,
  resolveProviderBaseUrl,
  resolveModelsForPicker,
  resolveProviderModelParams,
  resolveProviderModelParamsByName,
} from "./providers";

test("registry lists the flow-085 providers with sensible metadata", () => {
  const names = OPENAI_COMPAT_PROVIDERS.map((p) => p.name);
  expect(names).toContain("openrouter");
  expect(names).toContain("deepseek");
  expect(names).toContain("zai");
  expect(names).toContain("cerebras");
  expect(names).toContain("groq");
  expect(names).toContain("moonshot");
  expect(names).toContain("rapid-mlx");
  expect(names).toContain("zai-coding");
  expect(names).toContain("github-copilot");
  for (const p of OPENAI_COMPAT_PROVIDERS) {
    if (p.name !== "rapid-mlx") {
      expect(p.baseUrl.startsWith("https://")).toBe(true);
    }
    if (p.requiresApiKey === false) {
      expect(p.envKey).toBeUndefined();
    } else {
      expect(p.envKey).toBeDefined();
      expect(p.envKey!.length).toBeGreaterThan(0);
    }
    if (p.name !== "rapid-mlx") {
      expect(p.models.length).toBeGreaterThan(0);
    }
  }
});

test("rapid-mlx is local/macOS-only and keyless", () => {
  const rapid = providerByName("rapid-mlx");
  expect(rapid).toBeDefined();
  expect(rapid?.baseUrl).toBe("http://127.0.0.1:8010");
  expect(rapid?.models).toEqual([]);
  expect(rapid?.requiresApiKey).toBe(false);
  expect(rapid?.platforms).toEqual(["darwin"]);
});

test("provider endpoint override uses a per-provider environment variable", () => {
  const rapid = providerByName("rapid-mlx");
  expect(rapid).toBeDefined();
  expect(providerBaseUrlEnvKey("rapid-mlx")).toBe("KERYX_RAPID_MLX_BASE_URL");
  expect(resolveProviderBaseUrl(rapid!, { KERYX_RAPID_MLX_BASE_URL: "http://127.0.0.1:8000/" })).toBe(
    "http://127.0.0.1:8000",
  );
});

test("provider endpoint override rejects malformed and credential-bearing URLs", () => {
  const rapid = providerByName("rapid-mlx");
  expect(rapid).toBeDefined();
  expect(resolveProviderBaseUrl(rapid!, { KERYX_RAPID_MLX_BASE_URL: "not-a-url" })).toBe(rapid!.baseUrl);
  expect(resolveProviderBaseUrl(rapid!, { KERYX_RAPID_MLX_BASE_URL: "https://user:secret@example.test" })).toBe(
    rapid!.baseUrl,
  );
});

// flow 268 (AC3, AC4 precedence)
test("resolveProviderModelParams: absent config -> every field undefined", () => {
  const rapid = providerByName("rapid-mlx");
  expect(rapid).toBeDefined();
  expect(resolveProviderModelParams(rapid!, {})).toEqual({});
});

test("resolveProviderModelParams: a built-in provider's ShellConfig.modelParams override flows through", () => {
  const rapid = providerByName("rapid-mlx");
  expect(rapid).toBeDefined();
  expect(
    resolveProviderModelParams(rapid!, { modelParams: { "rapid-mlx": { temperature: 0.2, maxOutputTokens: 4096 } } }),
  ).toEqual({ temperature: 0.2, maxOutputTokens: 4096 });
});

test("resolveProviderModelParams: a custom provider's own fields flow through when unconfigured in ShellConfig", () => {
  const custom: CustomCompatProvider & { name: string } = {
    name: "internal-qwen",
    baseUrl: "http://10.110.43.19:8080",
    models: ["Qwen/Qwen3.5-122B-A10B-FP8"],
    temperature: 0.3,
    maxOutputTokens: 2048,
    timeoutMs: 90_000,
  };
  expect(resolveProviderModelParams(custom, {})).toEqual({
    temperature: 0.3,
    maxOutputTokens: 2048,
    timeoutMs: 90_000,
  });
});

test("resolveProviderModelParams: a ShellConfig override wins over the custom provider's own fields", () => {
  const custom: CustomCompatProvider = {
    name: "internal-qwen",
    baseUrl: "http://10.110.43.19:8080",
    models: [],
    temperature: 0.3,
  };
  expect(
    resolveProviderModelParams(custom, { modelParams: { "internal-qwen": { temperature: 0.9 } } }),
  ).toEqual({ temperature: 0.9 });
});

test("resolveProviderModelParamsByName: a name with no OpenAI-compatible registry entry resolves to {} (scope discipline)", () => {
  expect(resolveProviderModelParamsByName("anthropic", {})).toEqual({});
  expect(resolveProviderModelParamsByName("fake", {})).toEqual({});
});

test("resolveProviderModelParamsByName: resolves through for a registered provider name", () => {
  expect(
    resolveProviderModelParamsByName("rapid-mlx", { modelParams: { "rapid-mlx": { timeoutMs: 30_000 } } }),
  ).toEqual({ timeoutMs: 30_000 });
});

test("rapid-mlx is only available on darwin when platform filtering is applied", () => {
  const rapid = providerByName("rapid-mlx");
  expect(rapid).toBeDefined();
  expect(isProviderPlatformSupported(rapid!, "darwin")).toBe(true);
  expect(isProviderPlatformSupported(rapid!, "linux")).toBe(false);
  expect(isProviderPlatformSupported(rapid!, "win32")).toBe(false);
});

test("Z.AI GLM uses versioned paas/v4 endpoints (no /v1) via path overrides", () => {
  const zai = providerByName("zai");
  expect(zai?.baseUrl).toBe("https://api.z.ai/api/paas/v4");
  expect(zai?.chatPath).toBe("/chat/completions");
  expect(zai?.modelsPath).toBe("/models");
  const coding = providerByName("zai-coding");
  expect(coding?.baseUrl).toBe("https://api.z.ai/api/coding/paas/v4");
});

test("Z.AI curated fallbacks include current GLM-5.x / Coding Plan models", () => {
  const zai = providerByName("zai");
  const coding = providerByName("zai-coding");
  expect(zai?.models).toContain("glm-5.2");
  expect(zai?.models).toContain("glm-5.1");
  expect(coding?.models).toContain("glm-5.2");
  expect(coding?.models).toContain("glm-5-turbo");
  expect(coding?.models).toContain("glm-4.7");
  // Newest first so a fallback-only picker surfaces 5.2 without scrolling.
  expect(coding?.models[0]).toBe("glm-5.2");
});

test("providerByName returns undefined for a non-registry name", () => {
  expect(providerByName("ollama")).toBeUndefined();
  expect(providerByName("nope")).toBeUndefined();
});

test("fetchOpenAiCompatModels: parses data[].id deduped + sorted, honours modelsPath", async () => {
  let calledUrl = "";
  let auth: string | undefined;
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calledUrl = url;
    auth = (init?.headers as Record<string, string> | undefined)?.authorization;
    return { ok: true, json: async () => ({ data: [{ id: "z/m" }, { id: "a/m" }, { id: "a/m" }] }) } as Response;
  }) as unknown as typeof fetch;
  const zai = providerByName("zai");
  expect(zai).toBeDefined();
  const models = await fetchOpenAiCompatModels(fetchFn, zai!, "sk-test");
  expect(models).toEqual(["a/m", "z/m"]);
  // base + modelsPath, no extra /v1; Bearer sent when a key is provided.
  expect(calledUrl).toBe("https://api.z.ai/api/paas/v4/models");
  expect(auth).toBe("Bearer sk-test");
});

test("fetchOpenAiCompatModels: github-copilot sends Copilot identity headers with the bearer", async () => {
  let calledUrl = "";
  let headers: Record<string, string> | undefined;
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calledUrl = url;
    headers = init?.headers as Record<string, string> | undefined;
    return { ok: true, json: async () => ({ data: [{ id: "gpt-4o" }] }) } as Response;
  }) as unknown as typeof fetch;
  const copilot = providerByName("github-copilot");
  expect(copilot).toBeDefined();
  expect(copilot?.modelsPath).toBe("/models");
  expect(copilot?.chatPath).toBe("/chat/completions");
  const models = await fetchOpenAiCompatModels(fetchFn, copilot!, "tid-copilot");
  expect(models).toEqual(["gpt-4o"]);
  expect(calledUrl).toBe("https://api.githubcopilot.com/models");
  expect(headers?.authorization).toBe("Bearer tid-copilot");
  expect(headers?.["Editor-Version"]).toBe("vscode/1.99.3");
  expect(headers?.["Copilot-Integration-Id"]).toBe("vscode-chat");
});

test("fetchOpenAiCompatModels: default /v1/models path; no auth header without a key", async () => {
  let calledUrl = "";
  let hadAuth = true;
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calledUrl = url;
    hadAuth = (init?.headers as Record<string, string> | undefined)?.authorization !== undefined;
    return { ok: true, json: async () => ({ data: [{ id: "deepseek-chat" }] }) } as Response;
  }) as unknown as typeof fetch;
  const deepseek = providerByName("deepseek");
  const models = await fetchOpenAiCompatModels(fetchFn, deepseek!);
  expect(models).toEqual(["deepseek-chat"]);
  expect(calledUrl).toBe("https://api.deepseek.com/v1/models");
  expect(hadAuth).toBe(false);
});

test("fetchOpenAiCompatModels: local keyless provider can be probed without auth", async () => {
  const rapid = providerByName("rapid-mlx");
  expect(rapid).toBeDefined();
  let calledWithAuth: string | undefined;
  const fetchFn = (async (_url: string, init?: RequestInit) => {
    calledWithAuth = (init?.headers as Record<string, string> | undefined)?.authorization;
    return { ok: true, json: async () => ({ data: [{ id: "qwen3.5-9b-4bit" }] }) } as Response;
  }) as unknown as typeof fetch;
  const models = await fetchOpenAiCompatModels(fetchFn, rapid!);
  expect(models).toEqual(["qwen3.5-9b-4bit"]);
  expect(calledWithAuth).toBeUndefined();
});

test("fetchOpenAiCompatModels: returns no models on non-2xx / throw / empty", async () => {
  const groq = providerByName("groq");
  expect(groq).toBeDefined();
  const bad = (async () => ({ ok: false, json: async () => ({}) }) as Response) as unknown as typeof fetch;
  expect(await fetchOpenAiCompatModels(bad, groq!)).toEqual([]);
  const boom = (async () => {
    throw new Error("offline");
  }) as unknown as typeof fetch;
  expect(await fetchOpenAiCompatModels(boom, groq!)).toEqual([]);
  const empty = (async () => ({ ok: true, json: async () => ({ data: [] }) }) as Response) as unknown as typeof fetch;
  expect(await fetchOpenAiCompatModels(empty, groq!)).toEqual([]);
});

test("fetchOpenAiCompatModelsDetailed: reports live vs fallback source", async () => {
  const groq = providerByName("groq");
  expect(groq).toBeDefined();
  const live = (async () =>
    ({
      ok: true,
      json: async () => ({ data: [{ id: "live-a" }, { name: "live-b" }] }),
    }) as Response) as unknown as typeof fetch;
  const liveResult = await fetchOpenAiCompatModelsDetailed(live, groq!);
  expect(liveResult.source).toBe("live");
  expect(liveResult.models).toEqual(["live-a", "live-b"]);

  const offline = (async () => {
    throw new Error("offline");
  }) as unknown as typeof fetch;
  const offlineResult = await fetchOpenAiCompatModelsDetailed(offline, groq!);
  expect(offlineResult.source).toBe("fallback");
  expect(offlineResult.models).toEqual([]);
});

test("resolveModelsForPicker: always probes live for registry providers when online", async () => {
  let called = false;
  const fetchFn = (async () => {
    called = true;
    return {
      ok: true,
      json: async () => ({ data: [{ id: "glm-5.2" }, { id: "glm-4.7" }] }),
    } as Response;
  }) as unknown as typeof fetch;
  const result = await resolveModelsForPicker(
    fetchFn,
    { name: "zai-coding", models: ["glm-4.5"], envKey: "ZAI_API_KEY" },
    { ZAI_API_KEY: "sk-test" },
  );
  expect(called).toBe(true);
  expect(result.source).toBe("live");
  expect(result.models).toContain("glm-5.2");
  expect(result.models).toContain("glm-4.7");
});

test("resolveModelsForPicker: non-registry providers keep detected models without network", async () => {
  let called = false;
  const fetchFn = (async () => {
    called = true;
    return { ok: true, json: async () => ({ data: [] }) } as Response;
  }) as unknown as typeof fetch;
  const result = await resolveModelsForPicker(fetchFn, { name: "fake", models: ["fake-echo"] }, {});
  expect(called).toBe(false);
  expect(result.models).toEqual(["fake-echo"]);
  expect(result.source).toBe("fallback");
});
