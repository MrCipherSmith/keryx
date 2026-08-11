import { expect, test } from "bun:test";
import {
  OPENAI_COMPAT_PROVIDERS,
  fetchOpenAiCompatModels,
  fetchOpenAiCompatModelsDetailed,
  isProviderPlatformSupported,
  providerByName,
  resolveModelsForPicker,
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
  for (const p of OPENAI_COMPAT_PROVIDERS) {
    if (p.name !== "rapid-mlx") {
      expect(p.baseUrl.startsWith("https://")).toBe(true);
    }
    if (p.requiresApiKey === false) {
      expect(p.envKey).toBeUndefined();
    } else {
      expect(p.envKey).toBeDefined();
      expect(p.envKey.length).toBeGreaterThan(0);
    }
    expect(p.models.length).toBeGreaterThan(0);
  }
});

test("rapid-mlx is local/macOS-only and keyless", () => {
  const rapid = providerByName("rapid-mlx");
  expect(rapid).toBeDefined();
  expect(rapid?.baseUrl).toBe("http://127.0.0.1:8010");
  expect(rapid?.models).toContain("qwen3.5-9b-4bit");
  expect(rapid?.requiresApiKey).toBe(false);
  expect(rapid?.platforms).toEqual(["darwin"]);
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

test("fetchOpenAiCompatModels: falls back to curated models on non-2xx / throw / empty", async () => {
  const groq = providerByName("groq");
  expect(groq).toBeDefined();
  const bad = (async () => ({ ok: false, json: async () => ({}) }) as Response) as unknown as typeof fetch;
  expect(await fetchOpenAiCompatModels(bad, groq!)).toEqual([...groq!.models]);
  const boom = (async () => {
    throw new Error("offline");
  }) as unknown as typeof fetch;
  expect(await fetchOpenAiCompatModels(boom, groq!)).toEqual([...groq!.models]);
  const empty = (async () => ({ ok: true, json: async () => ({ data: [] }) }) as Response) as unknown as typeof fetch;
  expect(await fetchOpenAiCompatModels(empty, groq!)).toEqual([...groq!.models]);
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
  expect(offlineResult.models).toEqual([...groq!.models]);
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
