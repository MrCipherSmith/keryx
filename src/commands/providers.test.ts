import { expect, test } from "bun:test";
import { OPENAI_COMPAT_PROVIDERS, fetchOpenAiCompatModels, providerByName } from "./providers";

test("registry lists the flow-085 providers with base URL + env key", () => {
  const names = OPENAI_COMPAT_PROVIDERS.map((p) => p.name);
  expect(names).toContain("openrouter");
  expect(names).toContain("deepseek");
  expect(names).toContain("zai");
  expect(names).toContain("cerebras");
  expect(names).toContain("groq");
  expect(names).toContain("moonshot");
  for (const p of OPENAI_COMPAT_PROVIDERS) {
    expect(p.baseUrl.startsWith("https://")).toBe(true);
    expect(p.envKey.length).toBeGreaterThan(0);
    expect(p.models.length).toBeGreaterThan(0);
  }
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
