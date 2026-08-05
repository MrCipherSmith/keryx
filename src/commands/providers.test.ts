import { expect, test } from "bun:test";
import {
  NON_REGISTRY_PROVIDERS,
  OPENAI_COMPAT_PROVIDERS,
  credentialEnvKeyFor,
  fetchOpenAiCompatModels,
  fetchOpenAiCompatModelsDetailed,
  isKnownProvider,
  knownProviderNames,
  providerByName,
  registryDefaultModel,
  resolveModelsForPicker,
} from "./providers";

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

// --- flow 135 / AC5: declared model ids only ---------------------------------

test("AC5: no registry entry defaults to a model id its own declared set omits", () => {
  for (const provider of OPENAI_COMPAT_PROVIDERS) {
    const fallback = registryDefaultModel(provider);
    expect(fallback.length).toBeGreaterThan(0);
    // `models[0]` is what `defaultModelFor` hands a caller who named no model.
    // If a `defaultModel` field is ever added, this is the line that catches it
    // naming something the entry does not list.
    expect(provider.models).toContain(fallback);
    // No empty or duplicated ids: both make "the provider declares this" false
    // for at least one entry in the list.
    expect(new Set(provider.models).size).toBe(provider.models.length);
    expect(provider.models.every((id) => id.trim().length > 0)).toBe(true);
  }
});

test("AC5: every entry says what its model list was checked against, because offline cannot", () => {
  // The honest half of the criterion. A local test can prove the default is in
  // this entry's list; it cannot prove the list matches what the gateway
  // publishes today — that needs a credential and a network call. So each entry
  // states its source and date, and a missing statement fails here rather than
  // passing as if it had been verified.
  for (const provider of OPENAI_COMPAT_PROVIDERS) {
    expect(provider.modelsVerified.trim().length).toBeGreaterThan(0);
    expect(/\d{4}-\d{2}-\d{2}/.test(provider.modelsVerified)).toBe(true);
  }
});

test("AC5: DeepSeek names the ids the API lists, not the alias it merely answers on", () => {
  // D5, pinned. `deepseek-chat` still responds and is not in the API's model
  // list, which is exactly why it survived as keryx's default for this provider.
  const deepseek = providerByName("deepseek");
  expect(deepseek?.models).toEqual(["deepseek-v4-flash", "deepseek-v4-pro"]);
  expect(deepseek?.models).not.toContain("deepseek-chat");
  expect(registryDefaultModel(deepseek!)).toBe("deepseek-v4-flash");
});

// --- flow 135 / AC2: one source of truth for which providers exist -----------

test("knownProviderNames is the built-ins plus every registry entry, with no duplicates", () => {
  const names = knownProviderNames();
  expect(names.slice(0, NON_REGISTRY_PROVIDERS.length)).toEqual([...NON_REGISTRY_PROVIDERS]);
  for (const provider of OPENAI_COMPAT_PROVIDERS) {
    expect(names).toContain(provider.name);
    expect(isKnownProvider(provider.name)).toBe(true);
  }
  expect(new Set(names).size).toBe(names.length);
  expect(isKnownProvider("nope")).toBe(false);
  expect(isKnownProvider("")).toBe(false);
});

test("credentialEnvKeyFor names a key for every provider that needs one and none for the rest", () => {
  expect(credentialEnvKeyFor("anthropic")).toBe("ANTHROPIC_API_KEY");
  expect(credentialEnvKeyFor("fake")).toBeUndefined();
  expect(credentialEnvKeyFor("ollama")).toBeUndefined();
  for (const provider of OPENAI_COMPAT_PROVIDERS) {
    expect(credentialEnvKeyFor(provider.name)).toBe(provider.envKey);
  }
  // An unknown name gets no key, so a caller cannot read a credential decision
  // out of a provider that was never accepted in the first place.
  expect(credentialEnvKeyFor("nope")).toBeUndefined();
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
