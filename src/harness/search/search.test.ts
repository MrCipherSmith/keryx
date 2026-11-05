import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadSearchConfig, searchConfigPath } from "../../lib/search-config";
import { duckduckgoLiteUrl, resetDuckDuckGoRateLimitForTests, setDuckDuckGoTimingForTests } from "./duckduckgo";
import {
  createSearchProviderRegistry,
  connectedProviderIds,
  SearchProviderController,
  type SandboxedWebRequest,
  type SandboxedWebTransport,
} from "./index";

const liteHtml = readFileSync(path.join(import.meta.dir, "fixtures/duckduckgo-lite.html"), "utf8");
const anomalyHtml = readFileSync(path.join(import.meta.dir, "fixtures/duckduckgo-anomaly.html"), "utf8");

class FakeTransport implements SandboxedWebTransport {
  readonly requests: SandboxedWebRequest[] = [];
  duckduckgoStatus = 200;
  duckduckgoBody = liteHtml;

  /** Staged per-call answers; empty falls back to status/body above. */
  readonly duckduckgoQueue: { status: number; body: string }[] = [];

  async request(request: SandboxedWebRequest) {
    this.requests.push(request);
    if (request.providerId === "duckduckgo") {
      const staged = this.duckduckgoQueue.shift();
      const status = staged?.status ?? this.duckduckgoStatus;
      return {
        ok: status >= 200 && status < 300,
        status,
        url: request.url,
        contentType: "text/html; charset=utf-8",
        text: staged?.body ?? this.duckduckgoBody,
      };
    }
    if (request.providerId === "searxng") {
      return {
        ok: true,
        status: 200,
        url: request.url,
        contentType: "application/json",
        text: JSON.stringify({ results: [{ title: "Local result", url: "https://example.test/local", content: "Local snippet", publishedDate: "2026-01-02" }] }),
      };
    }
    if (request.providerId === "brave") {
      return {
        ok: true,
        status: 200,
        url: request.url,
        contentType: "application/json",
        text: JSON.stringify({ web: { results: [{ title: "Brave result", url: "https://example.test/brave", description: "Brave snippet", age: "2 days ago" }] } }),
      };
    }
    if (request.providerId === "tavily") {
      return {
        ok: true,
        status: 200,
        url: request.url,
        contentType: "application/json",
        text: JSON.stringify({ results: [{ title: "Tavily result", url: "https://example.test/tavily", content: "Tavily snippet", published_date: "2026-01-03" }] }),
      };
    }
    if (request.providerId === "deepseek") {
      if (request.url.endsWith("/tools/fetch")) {
        return {
          ok: true,
          status: 200,
          url: request.url,
          contentType: "application/json",
          text: JSON.stringify({ title: "Fetched page", content: "# Fetched page\n\nThe body." }),
        };
      }
      return {
        ok: true,
        status: 200,
        url: request.url,
        contentType: "application/json",
        text: JSON.stringify({
          results: [{
            rerank_score: 2.4,
            title: "DeepSeek result",
            url: "https://example.test/deepseek",
            snippet: "UI-length snippet",
            summary: "DeepSeek summary",
            date: "2026-06-01T00:00:00+00:00",
            authority: 3,
          }],
        }),
      };
    }
    return {
      ok: true,
      status: 200,
      url: request.url,
      contentType: "application/json",
      text: JSON.stringify({ results: [{ title: "Exa result", url: "https://example.test/exa", text: "Exa snippet", publishedDate: "2026-01-04" }] }),
    };
  }
}

describe("search provider registry", () => {
  // The measured DuckDuckGo timings (4-8 s between searches, a 5 s + 20 s retry
  // ladder) would otherwise be spent asleep; the tests that exercise the ladder
  // set their own (zero-length) rungs below.
  beforeEach(() => setDuckDuckGoTimingForTests({ minGapMs: 0, maxGapMs: 0, backoffMs: [] }));

  test("describes DuckDuckGo first, then SearXNG, Brave, Tavily, Exa and DeepSeek", () => {
    const registry = createSearchProviderRegistry(new FakeTransport());

    expect(registry.descriptors.map((descriptor) => descriptor.id)).toEqual(["duckduckgo", "searxng", "brave", "tavily", "exa", "deepseek"]);
    const duckduckgo = registry.get("duckduckgo");
    expect(duckduckgo?.kind).toBe("remote");
    expect(duckduckgo?.fields).toEqual([]);
    expect(duckduckgo?.credentialSchema.required).toBe(false);
    const searxng = registry.get("searxng");
    expect(searxng?.kind).toBe("local");
    expect(searxng?.defaults).toEqual({ baseUrl: "http://localhost", port: "8080" });
    expect(searxng?.documentationUrl).toContain("docs.searxng.org");
    expect(registry.get("brave")?.credentialSchema.required).toBe(true);
  });

  // The /search-provider wizard prints "Paste your <label>"; "Brave Search
  // API" + " API key" read "Brave Search API API key".
  test("credential labels name the key once, whatever the display name ends with", () => {
    const registry = createSearchProviderRegistry(new FakeTransport());
    expect(registry.get("brave")?.credentialSchema.label).toBe("Brave Search API key");
    expect(registry.get("tavily")?.credentialSchema.label).toBe("Tavily API key");
    expect(registry.get("exa")?.credentialSchema.label).toBe("Exa API key");
  });

  test("searches DuckDuckGo through the sandbox transport with no credential", async () => {
    resetDuckDuckGoRateLimitForTests();
    const transport = new FakeTransport();
    const registry = createSearchProviderRegistry(transport);

    const result = await registry.get("duckduckgo")!.search({}, "keryx sandbox");

    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]).toMatchObject({
      providerId: "duckduckgo",
      capability: "public-search",
      url: duckduckgoLiteUrl("keryx sandbox"),
    });
    expect(transport.requests[0]?.credential).toBeUndefined();
    expect(result.results[0]).toMatchObject({
      title: "Keryx Docs",
      canonicalUrl: "https://example.com/docs",
      providerId: "duckduckgo",
    });
  });

  test("treats DuckDuckGo anomaly pages as rate limiting, not a transport failure or an empty SERP", async () => {
    const transport = new FakeTransport();
    transport.duckduckgoStatus = 202;
    transport.duckduckgoBody = anomalyHtml;
    const registry = createSearchProviderRegistry(transport);
    expect(await registry.get("duckduckgo")!.testConnection({})).toEqual({ ok: false, reason: "rate-limited" });

    transport.duckduckgoStatus = 200;
    expect(await registry.get("duckduckgo")!.testConnection({})).toEqual({ ok: false, reason: "rate-limited" });
  });

  test("uses only the injected sandboxed transport and returns the common normalized result", async () => {
    const transport = new FakeTransport();
    const registry = createSearchProviderRegistry(transport);

    const result = await registry.get("searxng")!.search({ baseUrl: "http://localhost", port: "9090" }, "keryx sandbox");

    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]).toMatchObject({ providerId: "searxng", capability: "local-search", url: "http://localhost:9090/search?q=keryx%20sandbox&format=json" });
    expect(result).toEqual({
      query: "keryx sandbox",
      providerId: "searxng",
      results: [{
        title: "Local result",
        canonicalUrl: "https://example.test/local",
        snippet: "Local snippet",
        publicationDate: "2026-01-02",
        providerId: "searxng",
        provenance: { source: "search-provider", providerId: "searxng", rawResultCount: 1 },
      }],
    });
  });

  test("keeps provider credentials as one-time transport injections and never puts them in URLs", async () => {
    const transport = new FakeTransport();
    const registry = createSearchProviderRegistry(transport, (providerId) => providerId === "brave" ? "brave-secret" : undefined);

    const result = await registry.get("brave")!.search({}, "private query");

    expect(result.results[0]?.providerId).toBe("brave");
    expect(transport.requests[0]?.url).not.toContain("brave-secret");
    expect(transport.requests[0]?.credential).toEqual({ injection: "header", name: "X-Subscription-Token", value: "brave-secret" });
  });

  test("searches DeepSeek with a POST body and a Bearer header, and gives the model the summary", async () => {
    const transport = new FakeTransport();
    const registry = createSearchProviderRegistry(transport, (providerId) => providerId === "deepseek" ? "ds-secret" : undefined);

    const result = await registry.get("deepseek")!.search({}, "keryx sandbox");

    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]).toMatchObject({
      providerId: "deepseek",
      capability: "public-search",
      url: "https://api.deepseek.com/v1/tools/search",
      method: "POST",
      body: { query: "keryx sandbox", count: 10 },
      // The worker sends a header credential verbatim, so the scheme is part
      // of the value; a bare key would be rejected with HTTP 401.
      credential: { injection: "header", name: "Authorization", value: "Bearer ds-secret" },
    });
    expect(transport.requests[0]?.url).not.toContain("ds-secret");
    expect(result.results[0]).toMatchObject({
      title: "DeepSeek result",
      canonicalUrl: "https://example.test/deepseek",
      // `summary` (600-800 chars, "intended to be read by a model"), not the
      // UI-length `snippet`.
      snippet: "DeepSeek summary",
      publicationDate: "2026-06-01T00:00:00+00:00",
      providerId: "deepseek",
    });
    const deepseek = registry.get("deepseek");
    expect(deepseek?.credentialSchema).toEqual({ required: true, label: "DeepSeek API key", secret: true });
    expect(deepseek?.capabilities.supportsPublicationDate).toBe(true);
    expect(deepseek?.documentationUrl).toContain("api-docs.deepseek.com/guides/search");
  });

  test("DeepSeek fetches a known URL through its Fetch API and returns Markdown", async () => {
    const transport = new FakeTransport();
    const registry = createSearchProviderRegistry(transport, (providerId) => providerId === "deepseek" ? "ds-secret" : undefined);

    const deepseek = registry.get("deepseek")!;
    const fetchPage = deepseek.fetchPage;
    if (fetchPage === undefined) throw new Error("deepseek must expose fetchPage");
    const result = await fetchPage.call(deepseek, "https://example.com/article");

    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]).toMatchObject({
      providerId: "deepseek",
      url: "https://api.deepseek.com/v1/tools/fetch",
      method: "POST",
      body: { url: "https://example.com/article" },
      credential: { injection: "header", name: "Authorization", value: "Bearer ds-secret" },
    });
    expect(result).toEqual({
      ok: true,
      value: { providerId: "deepseek", url: "https://example.com/article", title: "Fetched page", text: "# Fetched page\n\nThe body." },
    });
  });

  test("DeepSeek fetch validates the TARGET before spending a request on it", async () => {
    // On this path the transport connects to api.deepseek.com, so nothing else
    // validates the page URL: `web_fetch`'s public-HTTPS promise must hold here.
    const transport = new FakeTransport();
    const registry = createSearchProviderRegistry(transport, () => "key");
    const deepseek = registry.get("deepseek")!;
    const fetchPage = deepseek.fetchPage;
    if (fetchPage === undefined) throw new Error("deepseek must expose fetchPage");

    for (const url of ["http://example.com", "https://user:pass@example.com/a", "https://127.0.0.1/admin"]) {
      expect(await fetchPage.call(deepseek, url)).toMatchObject({ ok: false, reason: "fetch-failed" });
    }
    expect(transport.requests).toHaveLength(0);
  });

  test("a DeepSeek fetch refusal says which one it was", async () => {
    const staged = [404, 403, 402];
    const transport: SandboxedWebTransport = {
      async request(request) {
        const status = staged.shift() ?? 200;
        return { ok: false, status, url: request.url, contentType: "application/json", text: JSON.stringify({ error: { message: "refused" } }) };
      },
    };
    const deepseek = createSearchProviderRegistry(transport, () => "key").get("deepseek")!;
    const fetchPage = deepseek.fetchPage;
    if (fetchPage === undefined) throw new Error("deepseek must expose fetchPage");
    const detail = async (url: string): Promise<string> => {
      const result = await fetchPage.call(deepseek, url);
      return !result.ok && result.reason === "fetch-failed" ? (result.detail ?? "") : "";
    };

    expect(await detail("https://example.com/a")).toContain("usable page content");
    expect(await detail("https://example.com/b")).toContain("security policy");
    expect(await detail("https://example.com/c")).toContain("insufficient balance");
  });

  test("web_fetch uses the active provider only when it retrieves pages itself", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "keryx-search-fetch-controller-"));
    try {
      const controller = new SearchProviderController(createSearchProviderRegistry(new FakeTransport(), () => "key"), dir);
      // Default engine: no page retrieval, so the call reports "keep using the
      // sandbox transport" rather than an error.
      expect(await controller.fetchPage("https://example.com/article")).toEqual({ ok: false, reason: "no-fetch-provider" });

      controller.configure("deepseek", {});
      expect(await controller.test("deepseek")).toEqual({ ok: true });
      expect(await controller.select("deepseek")).toEqual({ ok: true });
      expect(await controller.fetchPage("https://example.com/article")).toMatchObject({ ok: true, value: { providerId: "deepseek" } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("DeepSeek names the fix for a rejected key, an empty balance and a rate limit", async () => {
    // Every status DeepSeek documents as recoverable in a DIFFERENT way: a
    // generic "connection validation failed" would send the operator to retry
    // a dead account, or to top up a rate-limited one.
    const staged: { status: number; body: string }[] = [];
    const transport: SandboxedWebTransport = {
      async request(request) {
        const next = staged.shift() ?? { status: 200, body: JSON.stringify({ results: [{ title: "t", url: "https://example.test/ok", summary: "s" }] }) };
        return { ok: next.status >= 200 && next.status < 300, status: next.status, url: request.url, contentType: "application/json", text: next.body };
      },
    };
    const registry = createSearchProviderRegistry(transport, () => "key");
    const deepseek = registry.get("deepseek")!;
    const error = (status: number): { status: number; body: string } => ({ status, body: JSON.stringify({ error: { message: "refused", param: null, code: "invalid_request_error" } }) });

    staged.push(error(401), error(402), error(429));
    expect(await deepseek.testConnection({})).toEqual({ ok: false, reason: "missing-credential" });
    expect(await deepseek.testConnection({})).toEqual({ ok: false, reason: "insufficient-balance" });
    expect(await deepseek.testConnection({})).toEqual({ ok: false, reason: "rate-limited" });
    expect(await deepseek.testConnection({})).toEqual({ ok: true });
  });

  test("a refused DeepSeek search reaches the caller as a refusal, never as zero results", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "keryx-search-deepseek-refused-"));
    try {
      let calls = 0;
      const transport: SandboxedWebTransport = {
        async request(request) {
          calls += 1;
          // First call is the connection test; every later one is the search.
          const status = calls === 1 ? 200 : 402;
          return {
            ok: status === 200,
            status,
            url: request.url,
            contentType: "application/json",
            text: status === 200
              ? JSON.stringify({ results: [{ title: "t", url: "https://example.test/ok", summary: "s" }] })
              : JSON.stringify({ error: { message: "insufficient balance", param: null, code: "invalid_request_error" } }),
          };
        },
      };
      const controller = new SearchProviderController(createSearchProviderRegistry(transport, () => "key"), dir);
      controller.configure("deepseek", {});
      expect(await controller.test("deepseek")).toEqual({ ok: true });
      expect(await controller.select("deepseek")).toEqual({ ok: true });

      const result = await controller.search("keryx sandbox");
      expect(result).toMatchObject({ ok: false, reason: "search-failed" });
      expect(result.ok ? "" : result.detail).toContain("insufficient balance");
      expect(result.ok ? "" : result.detail).toContain("402");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("DeepSeek borrows the saved chat-model key, and a search credential overrides it", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "keryx-search-deepseek-key-"));
    try {
      const { searchCredentialResolver } = await import("./default-controller");
      const { saveApiKey } = await import("../../lib/shell-config");
      const { saveSearchCredential } = await import("../../lib/search-config");
      // An explicit empty env keeps a developer's own DEEPSEEK_API_KEY out of
      // the assertion about "nothing saved yet".
      const resolver = searchCredentialResolver(dir, {});

      expect(resolver("deepseek")).toBeUndefined();
      saveApiKey("DEEPSEEK_API_KEY", "chat-key", dir);
      expect(resolver("deepseek")).toBe("chat-key");
      // Borrowing is DeepSeek-only: a chat key never becomes another
      // provider's search credential.
      expect(resolver("brave")).toBeUndefined();
      saveSearchCredential("deepseek", "search-key", dir);
      expect(resolver("deepseek")).toBe("search-key");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reports only successfully tested providers as connected/selectable", async () => {
    const transport = new FakeTransport();
    const registry = createSearchProviderRegistry(transport, (id) => id === "brave" ? "key" : undefined);
    const states = await registry.testConfigured([
      { providerId: "searxng", fields: { baseUrl: "http://localhost", port: "8080" } },
      { providerId: "brave", fields: {} },
      { providerId: "tavily", fields: {} },
    ]);

    expect(connectedProviderIds(states)).toEqual(["searxng", "brave"]);
    expect(states.find((state) => state.providerId === "tavily")).toMatchObject({ status: "disconnected", reason: "missing-credential" });
  });

  test("configuration controller exposes all descriptors but selects only connected providers", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "keryx-search-controller-"));
    try {
      const controller = new SearchProviderController(createSearchProviderRegistry(new FakeTransport()), dir);
      controller.configure("searxng", { baseUrl: "http://localhost", port: "8080" });
      controller.configure("tavily", {});

      expect(controller.configurable().map((provider) => provider.id)).toEqual(["duckduckgo", "searxng", "brave", "tavily", "exa", "deepseek"]);
      expect(await controller.select("searxng")).toEqual({ ok: false, reason: "not-connected" });
      expect(await controller.test("searxng")).toEqual({ ok: true });
      expect(controller.selectable().map((provider) => provider.id)).toEqual(["duckduckgo", "searxng"]);
      expect(await controller.select("searxng")).toEqual({ ok: true });
      expect(controller.active()?.id).toBe("searxng");
      const searched = await controller.search("after-select");
      expect(searched.ok).toBe(true);
      if (searched.ok) expect(searched.value.results[0]?.providerId).toBe("searxng");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("uses DuckDuckGo when a leftover searxng selection is in the on-disk config", async () => {
    resetDuckDuckGoRateLimitForTests();
    const dir = mkdtempSync(path.join(os.tmpdir(), "keryx-search-stale-searxng-"));
    try {
      writeFileSync(searchConfigPath(dir), `${JSON.stringify({
        activeProviderId: "searxng",
        providers: { searxng: { fields: { baseUrl: "http://localhost", port: "8080" }, status: "connected", lastTestedAt: "2026-08-22T23:50:00.000Z" } },
      })}\n`);
      const transport = new FakeTransport();
      const controller = new SearchProviderController(createSearchProviderRegistry(transport), dir);
      expect(controller.active()?.id).toBe("duckduckgo");
      const result = await controller.search("TypeScript 7 release");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.providerId).toBe("duckduckgo");
      expect(transport.requests[0]?.providerId).toBe("duckduckgo");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("uses DuckDuckGo when nothing is selected and does not persist that default", async () => {
    resetDuckDuckGoRateLimitForTests();
    const dir = mkdtempSync(path.join(os.tmpdir(), "keryx-search-default-"));
    try {
      const transport = new FakeTransport();
      const controller = new SearchProviderController(createSearchProviderRegistry(transport), dir);
      expect(controller.active()?.id).toBe("duckduckgo");
      expect(controller.selectable().map((provider) => provider.id)).toEqual(["duckduckgo"]);

      const result = await controller.search("keryx sandbox");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.results[0]?.providerId).toBe("duckduckgo");
      expect(transport.requests[0]?.url).toBe(duckduckgoLiteUrl("keryx sandbox"));
      expect(controller.active()?.id).toBe("duckduckgo");
      expect(loadSearchConfig(dir).activeProviderId).toBeUndefined();
      expect(await controller.select("duckduckgo")).toEqual({ ok: true });
      expect(loadSearchConfig(dir).activeProviderId).toBe("duckduckgo");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("does not fall back to DuckDuckGo when a selected provider is disconnected", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "keryx-search-nofallback-"));
    try {
      const transport = new FakeTransport();
      const controller = new SearchProviderController(createSearchProviderRegistry(transport, () => "key"), dir);
      controller.configure("brave", {});
      expect(await controller.test("brave")).toEqual({ ok: true });
      expect(await controller.select("brave")).toEqual({ ok: true });
      controller.configure("brave", {});
      expect(await controller.search("keryx sandbox")).toEqual({ ok: false, reason: "provider-disconnected" });
      expect(transport.requests.some((request) => request.providerId === "duckduckgo")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("DuckDuckGo anomalies exhaust the retry ladder, then say what happened", async () => {
    setDuckDuckGoTimingForTests({ minGapMs: 0, maxGapMs: 0, backoffMs: [0, 0] });
    const dir = mkdtempSync(path.join(os.tmpdir(), "keryx-search-anomaly-"));
    try {
      const transport = new FakeTransport();
      transport.duckduckgoBody = anomalyHtml;
      const controller = new SearchProviderController(createSearchProviderRegistry(transport), dir);
      const result = await controller.search("keryx sandbox");
      expect(result).toMatchObject({ ok: false, reason: "search-failed" });
      // The provider's own refusal reaches the caller: "search failed" alone is
      // what sent an operator (and an agent) to retry a rate limit immediately.
      expect(result.ok ? undefined : result.detail).toContain("rate limited");
      expect(transport.requests).toHaveLength(3); // one attempt + two rungs
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("DuckDuckGo retries an anomaly and returns the results once it answers", async () => {
    setDuckDuckGoTimingForTests({ minGapMs: 0, maxGapMs: 0, backoffMs: [0, 0] });
    const transport = new FakeTransport();
    transport.duckduckgoQueue.push({ status: 202, body: anomalyHtml }, { status: 202, body: anomalyHtml });
    const registry = createSearchProviderRegistry(transport);
    const result = await registry.get("duckduckgo")!.search({}, "keryx sandbox");
    expect(transport.requests).toHaveLength(3);
    expect(result.results[0]).toMatchObject({ providerId: "duckduckgo" });
  });

  test("remote providers reject successful JSON error payloads during connection tests", async () => {
    const transport: SandboxedWebTransport = {
      async request(request) {
        return { ok: true, status: 200, url: request.url, contentType: "application/json", text: JSON.stringify({ error: "invalid API key" }) };
      },
    };
    const registry = createSearchProviderRegistry(transport, () => "key");
    for (const id of ["brave", "tavily", "exa"] as const) {
      expect(await registry.get(id)!.testConnection({})).toEqual({ ok: false, reason: "transport-failed" });
    }
  });
});
