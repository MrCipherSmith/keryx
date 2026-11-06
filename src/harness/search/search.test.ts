import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadSearchConfig, searchConfigPath } from "../../lib/search-config";
import { duckduckgoLiteUrl, resetDuckDuckGoRateLimitForTests, setDuckDuckGoTimingForTests } from "./duckduckgo";
import { setDeepSeekDnsTimeoutForTests, setDeepSeekTimingForTests } from "./registry";
import { resetSearchRefusalsForTests } from "./controller";
import {
  createSearchProviderRegistry,
  connectedProviderIds,
  SearchProviderController,
  SearchProviderRegistry,
  type SandboxedWebRequest,
  type SandboxedWebTransport,
  type SearchProviderDescriptor,
} from "./index";

const publicLookup = async () => [{ address: "93.184.216.34" }];
const liteHtml = readFileSync(path.join(import.meta.dir, "fixtures/duckduckgo-lite.html"), "utf8");
const anomalyHtml = readFileSync(path.join(import.meta.dir, "fixtures/duckduckgo-anomaly.html"), "utf8");

class FakeTransport implements SandboxedWebTransport {
  readonly requests: SandboxedWebRequest[] = [];
  duckduckgoStatus = 200;
  duckduckgoBody = liteHtml;

  /** Staged per-call answers; empty falls back to status/body above. */
  readonly duckduckgoQueue: { status: number; body: string }[] = [];

  /** Staged DeepSeek answers, in request order — no "first call is the test" sentinel. */
  readonly deepseekQueue: { status: number; body: string }[] = [];

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
      const staged = this.deepseekQueue.shift();
      if (staged !== undefined) {
        return {
          ok: staged.status >= 200 && staged.status < 300,
          status: staged.status,
          url: request.url,
          contentType: "application/json",
          text: staged.body,
        };
      }
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
  beforeEach(() => {
    setDuckDuckGoTimingForTests({ minGapMs: 0, maxGapMs: 0, backoffMs: [] });
    // No DeepSeek ladder unless a test asks for one: a 429 must not sleep here.
    setDeepSeekTimingForTests({ backoffMs: [] });
    resetSearchRefusalsForTests();
  });

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
    const registry = createSearchProviderRegistry(transport, (providerId) => providerId === "deepseek" ? "ds-secret" : undefined, publicLookup);

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
    const privateLookup = async () => [{ address: "10.0.0.5" }];
    const registry = createSearchProviderRegistry(transport, () => "key", privateLookup);
    const deepseek = registry.get("deepseek")!;
    const fetchPage = deepseek.fetchPage;
    if (fetchPage === undefined) throw new Error("deepseek must expose fetchPage");

    // Syntactic rejections, then names that only DNS can catch — the exact gap
    // `parsePublicHttpsUrl` alone left open.
    for (const url of ["http://example.com", "https://user:pass@example.com/a", "https://127.0.0.1/admin", "https://localhost/admin", "https://internal.example/"]) {
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
    const deepseek = createSearchProviderRegistry(transport, () => "key", publicLookup).get("deepseek")!;
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
      const controller = new SearchProviderController(createSearchProviderRegistry(new FakeTransport(), () => "key", publicLookup), dir);
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
    expect(await deepseek.testConnection({})).toEqual({ ok: false, reason: "invalid-credential" });
    expect(await deepseek.testConnection({})).toEqual({ ok: false, reason: "insufficient-balance" });
    expect(await deepseek.testConnection({})).toEqual({ ok: false, reason: "rate-limited" });
    expect(await deepseek.testConnection({})).toEqual({ ok: true });
  });

  test("a missing DeepSeek key refuses search and leaves fetch on the transport", async () => {
    const transport = new FakeTransport();
    const registry = createSearchProviderRegistry(transport, () => undefined, publicLookup);
    const deepseek = registry.get("deepseek")!;
    const fetchPage = deepseek.fetchPage;
    if (fetchPage === undefined) throw new Error("deepseek must expose fetchPage");

    // The borrow path makes "connected" independent of the credential, so an
    // absent key must refuse — an empty SERP would read as "nothing found".
    await expect(deepseek.search({}, "keryx sandbox")).rejects.toThrow(/no API key/);
    expect(await fetchPage.call(deepseek, "https://example.com/a")).toEqual({ ok: false, reason: "no-fetch-provider" });
    // The same rule closes the class for the keyed remotes.
    await expect(registry.get("brave")!.search({}, "keryx sandbox")).rejects.toThrow(/no API key/);
    expect(transport.requests).toHaveLength(0);
  });

  test("DeepSeek absorbs a 429 with a bounded ladder, then refuses without inviting a retry", async () => {
    setDeepSeekTimingForTests({ backoffMs: [0, 0] });
    const running = [429, 429, 200];
    const answers: SandboxedWebTransport = {
      async request(request) {
        const status = running.shift() ?? 429;
        return {
          ok: status === 200,
          status,
          url: request.url,
          contentType: "application/json",
          text: status === 200
            ? JSON.stringify({ results: [{ title: "t", url: "https://example.test/ok", summary: "s" }] })
            : JSON.stringify({ error: { message: "rate limited" } }),
        };
      },
    };
    const registry = createSearchProviderRegistry(answers, () => "key", publicLookup);
    expect((await registry.get("deepseek")!.search({}, "keryx sandbox")).results).toHaveLength(1);

    let calls = 0;
    const exhausted: SandboxedWebTransport = {
      async request(request) {
        calls += 1;
        return { ok: false, status: 429, url: request.url, contentType: "application/json", text: JSON.stringify({ error: { message: "rate limited" } }) };
      },
    };
    const blocked = createSearchProviderRegistry(exhausted, () => "key", publicLookup);
    await expect(blocked.get("deepseek")!.search({}, "keryx sandbox")).rejects.toThrow(/rate limited/);
    // One attempt plus the ladder's two rungs — not an unbounded retry loop.
    expect(calls).toBe(3);
  });

  test("DeepSeek names every Fetch failure the provider documents, and which ones are retryable", async () => {
    const table: [number, RegExp, boolean][] = [
      [401, /rejected the API key/, false],
      [402, /insufficient balance/, false],
      [403, /security policy/, false],
      [404, /usable page content/, true],
      [408, /provider unavailable or rate limited/, true],
      [429, /provider unavailable or rate limited/, true],
      [500, /HTTP 500/, true],
      [0, /before a response/, true],
      [400, /HTTP 400/, false],
      [413, /HTTP 413/, false],
    ];
    for (const [status, pattern, retryable] of table) {
      const transport: SandboxedWebTransport = {
        async request(request) {
          return { ok: false, status, url: request.url, contentType: "application/json", text: JSON.stringify({ error: { message: "x" } }) };
        },
      };
      const deepseek = createSearchProviderRegistry(transport, () => "key", publicLookup).get("deepseek")!;
      const fetchPage = deepseek.fetchPage;
      if (fetchPage === undefined) throw new Error("deepseek must expose fetchPage");
      const result = await fetchPage.call(deepseek, "https://example.com/a");
      expect(result.ok).toBe(false);
      if (!result.ok && result.reason === "fetch-failed") {
        expect(result.detail ?? "").toMatch(pattern);
        expect(result.retryable).toBe(retryable);
      }
    }
  });

  test("the controller turns a throwing provider into a reported failure", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "keryx-search-throwing-fetcher-"));
    try {
      const descriptor: SearchProviderDescriptor = {
        id: "deepseek",
        displayName: "DeepSeek Search",
        kind: "remote",
        fields: [],
        defaults: {},
        credentialSchema: { required: true, secret: true },
        documentationUrl: "https://api-docs.deepseek.com/guides/search/",
        capabilities: { localLoopback: false, supportsPublicationDate: false },
        testConnection: async () => ({ ok: true }),
        search: async (fields, query) => ({ query, providerId: descriptor.id, results: [] }),
        fetchPage: async () => { throw new Error("provider exploded"); },
      };
      writeFileSync(searchConfigPath(dir), `${JSON.stringify({
        schemaVersion: 2,
        activeProviderId: "deepseek",
        providers: { deepseek: { fields: {}, status: "connected" } },
      })}\n`);
      const controller = new SearchProviderController(new SearchProviderRegistry([descriptor]), dir);
      // A throw is a provider that never produced a page: the tool may fall back.
      expect(await controller.fetchPage("https://example.com/a")).toEqual({ ok: false, reason: "fetch-failed", detail: "provider exploded", retryable: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a refused DeepSeek search reaches the caller as a refusal, never as zero results", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "keryx-search-deepseek-refused-"));
    try {
      const transport = new FakeTransport();
      // Explicit order: the connection test answers 200, the search answers 402.
      transport.deepseekQueue.push(
        { status: 200, body: JSON.stringify({ results: [{ title: "t", url: "https://example.test/ok", summary: "s" }] }) },
        { status: 402, body: JSON.stringify({ error: { message: "insufficient balance", param: null, code: "invalid_request_error" } }) },
      );
      const controller = new SearchProviderController(createSearchProviderRegistry(transport, () => "key", publicLookup), dir);
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
      // An exported key is borrowed without any config at all, and it wins over
      // a saved chat key (envWithSavedApiKeys fills only what env lacks).
      expect(searchCredentialResolver(dir, { DEEPSEEK_API_KEY: "env-key" })("deepseek")).toBe("env-key");
      saveApiKey("DEEPSEEK_API_KEY", "chat-key", dir);
      expect(resolver("deepseek")).toBe("chat-key");
      expect(searchCredentialResolver(dir, { DEEPSEEK_API_KEY: "env-key" })("deepseek")).toBe("env-key");
      // Borrowing is DeepSeek-only: a chat key never becomes another
      // provider's search credential.
      expect(resolver("brave")).toBeUndefined();
      saveSearchCredential("deepseek", "search-key", dir);
      expect(resolver("deepseek")).toBe("search-key");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("connect is one controller operation: configure, test, activate", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "keryx-search-connect-"));
    try {
      const controller = new SearchProviderController(createSearchProviderRegistry(new FakeTransport(), () => "key", publicLookup), dir);
      expect(await controller.connect("deepseek", {})).toEqual({ ok: true, active: true, servesPages: true });
      expect(controller.active()?.id).toBe("deepseek");
      expect(loadSearchConfig(dir).activeProviderId).toBe("deepseek");

      // A failed test never activates, and says why.
      const failingDir = mkdtempSync(path.join(os.tmpdir(), "keryx-search-connect-fail-"));
      try {
        const failing = new SearchProviderController(createSearchProviderRegistry(new FakeTransport(), () => undefined, publicLookup), failingDir);
        expect(await failing.connect("deepseek", {})).toEqual({ ok: false, reason: "missing-credential" });
        expect(failing.active()?.id).toBe("duckduckgo");
        expect(loadSearchConfig(failingDir).activeProviderId).toBeUndefined();
      } finally {
        rmSync(failingDir, { recursive: true, force: true });
      }

      // `activate: false` connects without taking the engine over.
      const keepDir = mkdtempSync(path.join(os.tmpdir(), "keryx-search-connect-keep-"));
      try {
        const keep = new SearchProviderController(createSearchProviderRegistry(new FakeTransport(), () => "key", publicLookup), keepDir);
        expect(await keep.connect("deepseek", {}, undefined, { activate: false })).toEqual({ ok: true, active: false, servesPages: true });
        expect(keep.active()?.id).toBe("duckduckgo");
      } finally {
        rmSync(keepDir, { recursive: true, force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a permanent refusal is not re-requested on every later call", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "keryx-search-breaker-"));
    try {
      const transport = new FakeTransport();
      transport.deepseekQueue.push(
        { status: 200, body: JSON.stringify({ results: [{ title: "t", url: "https://example.test/ok", summary: "s" }] }) },
        { status: 402, body: JSON.stringify({ error: { message: "insufficient balance" } }) },
        { status: 200, body: JSON.stringify({ results: [] }) },
      );
      const controller = new SearchProviderController(createSearchProviderRegistry(transport, () => "key", publicLookup), dir);
      controller.configure("deepseek", {});
      expect(await controller.test("deepseek")).toEqual({ ok: true });
      expect(await controller.select("deepseek")).toEqual({ ok: true });

      const first = await controller.search("keryx sandbox");
      expect(first.ok).toBe(false);
      expect(first.ok ? "" : first.detail).toContain("insufficient balance");
      const callsAfterFirst = transport.requests.length;

      const second = await controller.search("keryx sandbox again");
      expect(second.ok).toBe(false);
      expect(second.ok ? "" : second.detail).toContain("not retried");
      // The dead account is not asked again — the operator's re-test is the fix.
      expect(transport.requests.length).toBe(callsAfterFirst);

      // Re-configuring clears the record, so a fixed account works immediately.
      controller.configure("deepseek", {});
      expect(await controller.test("deepseek")).toEqual({ ok: true });
      expect(await controller.search("after reconnect")).toMatchObject({ ok: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a refusal recorded by the tools is cleared by the command that re-tests", async () => {
    // The two surfaces hold different controller instances, so the breaker must
    // be shared or the operator's documented recovery does nothing.
    const dir = mkdtempSync(path.join(os.tmpdir(), "keryx-search-shared-breaker-"));
    try {
      const transport = new FakeTransport();
      transport.deepseekQueue.push(
        { status: 200, body: JSON.stringify({ results: [] }) },
        { status: 402, body: JSON.stringify({ error: { message: "insufficient balance" } }) },
        { status: 200, body: JSON.stringify({ results: [{ title: "t", url: "https://example.test/ok", summary: "s" }] }) },
        { status: 200, body: JSON.stringify({ results: [{ title: "t", url: "https://example.test/ok", summary: "s" }] }) },
      );
      const tools = new SearchProviderController(createSearchProviderRegistry(transport, () => "key", publicLookup), dir);
      const commands = new SearchProviderController(createSearchProviderRegistry(transport, () => "key", publicLookup), dir);
      commands.configure("deepseek", {});
      expect(await commands.test("deepseek")).toEqual({ ok: true });
      expect(await commands.select("deepseek")).toEqual({ ok: true });

      expect(await tools.search("first")).toMatchObject({ ok: false, reason: "search-failed" });
      const refused = await tools.search("second");
      expect(refused.ok ? "" : refused.detail).toContain("not retried");

      // The operator re-tests on the COMMAND instance; the tool instance must see it.
      expect(await commands.connect("deepseek", {})).toMatchObject({ ok: true, active: true });
      expect(await tools.search("after reconnect")).toMatchObject({ ok: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the refusal breaker also guards web_fetch, and a 429 is never remembered", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "keryx-search-fetch-breaker-"));
    try {
      const transport = new FakeTransport();
      transport.deepseekQueue.push(
        { status: 200, body: JSON.stringify({ results: [] }) },
        { status: 402, body: JSON.stringify({ error: { message: "insufficient balance" } }) },
        { status: 200, body: JSON.stringify({ title: "t", content: "body" }) },
      );
      const controller = new SearchProviderController(createSearchProviderRegistry(transport, () => "key", publicLookup), dir);
      controller.configure("deepseek", {});
      expect(await controller.test("deepseek")).toEqual({ ok: true });
      expect(await controller.select("deepseek")).toEqual({ ok: true });

      const first = await controller.fetchPage("https://example.com/a");
      expect(first).toMatchObject({ ok: false, reason: "fetch-failed" });
      const requestsAfterFirst = transport.requests.length;
      const second = await controller.fetchPage("https://example.com/b");
      expect(second.ok ? "" : second.reason === "fetch-failed" ? second.detail : "").toContain("not retried");
      expect(transport.requests.length).toBe(requestsAfterFirst);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a rate limit is not remembered as a permanent refusal", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "keryx-search-429-not-remembered-"));
    try {
      const transport = new FakeTransport();
      transport.deepseekQueue.push(
        { status: 200, body: JSON.stringify({ results: [] }) },
        { status: 429, body: JSON.stringify({ error: { message: "rate limited" } }) },
        { status: 200, body: JSON.stringify({ results: [{ title: "t", url: "https://example.test/ok", summary: "s" }] }) },
      );
      const controller = new SearchProviderController(createSearchProviderRegistry(transport, () => "key", publicLookup), dir);
      controller.configure("deepseek", {});
      expect(await controller.test("deepseek")).toEqual({ ok: true });
      expect(await controller.select("deepseek")).toEqual({ ok: true });

      expect(await controller.search("first")).toMatchObject({ ok: false, reason: "search-failed" });
      // A 429 clears by waiting, so the next call must reach the provider.
      expect(await controller.search("second")).toMatchObject({ ok: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an empty extraction is retryable, so the transport can serve the page", async () => {
    const transport: SandboxedWebTransport = {
      async request(request) {
        return { ok: true, status: 200, url: request.url, contentType: "application/json", text: JSON.stringify({ title: "x" }) };
      },
    };
    const deepseek = createSearchProviderRegistry(transport, () => "key", publicLookup).get("deepseek")!;
    const result = await deepseek.fetchPage!.call(deepseek, "https://example.com/a");
    expect(result).toMatchObject({ ok: false, reason: "fetch-failed", retryable: true });
  });

  test("a request-scoped refusal is not remembered: the corrected query reaches the provider", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "keryx-search-request-scope-"));
    try {
      const transport = new FakeTransport();
      transport.deepseekQueue.push(
        { status: 200, body: JSON.stringify({ results: [] }) },
        { status: 400, body: JSON.stringify({ error: { message: "query too long" } }) },
        { status: 200, body: JSON.stringify({ results: [{ title: "t", url: "https://example.test/ok", summary: "s" }] }) },
      );
      const controller = new SearchProviderController(createSearchProviderRegistry(transport, () => "key", publicLookup), dir);
      controller.configure("deepseek", {});
      expect(await controller.test("deepseek")).toEqual({ ok: true });
      expect(await controller.select("deepseek")).toEqual({ ok: true });

      const tooLong = await controller.search("x".repeat(200));
      expect(tooLong.ok).toBe(false);
      expect(tooLong.ok ? "" : tooLong.scope).toBe("request");

      // A corrected request must not be answered from a cache.
      const corrected = await controller.search("short");
      expect(corrected).toMatchObject({ ok: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an account refusal is cached per operation, so a search refusal never gates web_fetch", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "keryx-search-operation-scope-"));
    try {
      const transport = new FakeTransport();
      transport.deepseekQueue.push(
        { status: 200, body: JSON.stringify({ results: [] }) },
        { status: 402, body: JSON.stringify({ error: { message: "insufficient balance" } }) },
        { status: 200, body: JSON.stringify({ title: "t", content: "page body" }) },
      );
      const controller = new SearchProviderController(createSearchProviderRegistry(transport, () => "key", publicLookup), dir);
      controller.configure("deepseek", {});
      expect(await controller.test("deepseek")).toEqual({ ok: true });
      expect(await controller.select("deepseek")).toEqual({ ok: true });

      const refused = await controller.search("first");
      expect(refused.ok).toBe(false);
      expect(refused.ok ? "" : refused.permanent).toBe(true);

      // Same provider, different operation: the page still comes from it.
      expect(await controller.fetchPage("https://example.com/a")).toMatchObject({ ok: true, value: { text: "page body" } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a missing-key search refusal does not take web_fetch's fallback away", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "keryx-search-missing-key-scope-"));
    try {
      const registry = createSearchProviderRegistry(new FakeTransport(), () => undefined, publicLookup);
      const controller = new SearchProviderController(registry, dir);
      // A stored active+connected provider whose credential is absent.
      writeFileSync(searchConfigPath(dir), `${JSON.stringify({
        schemaVersion: 2,
        activeProviderId: "deepseek",
        providers: { deepseek: { fields: {}, status: "connected" } },
      })}\n`);
      expect(await controller.search("anything")).toMatchObject({ ok: false });
      expect(await controller.fetchPage("https://example.com/a")).toEqual({ ok: false, reason: "no-fetch-provider" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the cached refusal keeps permanence instead of falling back to prose advice", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "keryx-search-cached-flag-"));
    try {
      const transport = new FakeTransport();
      transport.deepseekQueue.push(
        { status: 200, body: JSON.stringify({ results: [] }) },
        { status: 402, body: JSON.stringify({ error: { message: "insufficient balance" } }) },
      );
      const controller = new SearchProviderController(createSearchProviderRegistry(transport, () => "key", publicLookup), dir);
      controller.configure("deepseek", {});
      expect(await controller.test("deepseek")).toEqual({ ok: true });
      expect(await controller.select("deepseek")).toEqual({ ok: true });
      await controller.search("first");
      const cached = await controller.search("second");
      expect(cached.ok ? "" : cached.detail).toContain("not retried");
      expect(cached.ok ? "" : cached.permanent).toBe(true);
      expect(cached.ok ? "" : cached.scope).toBe("account");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a refusal expires: an injected clock proves the five-minute TTL", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "keryx-search-ttl-"));
    try {
      let now = 1_000;
      const transport = new FakeTransport();
      transport.deepseekQueue.push(
        { status: 200, body: JSON.stringify({ results: [] }) },
        { status: 402, body: JSON.stringify({ error: { message: "insufficient balance" } }) },
        { status: 200, body: JSON.stringify({ results: [{ title: "t", url: "https://example.test/ok", summary: "s" }] }) },
      );
      const controller = new SearchProviderController(createSearchProviderRegistry(transport, () => "key", publicLookup), dir, () => now);
      controller.configure("deepseek", {});
      expect(await controller.test("deepseek")).toEqual({ ok: true });
      expect(await controller.select("deepseek")).toEqual({ ok: true });
      await controller.search("first");
      expect(await controller.search("second")).toMatchObject({ ok: false });

      now += 6 * 60_000;
      expect(await controller.search("after the window")).toMatchObject({ ok: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a fetch rate limit is not remembered (only account refusals are)", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "keryx-search-fetch-429-"));
    try {
      const transport = new FakeTransport();
      transport.deepseekQueue.push(
        { status: 200, body: JSON.stringify({ results: [] }) },
        { status: 429, body: JSON.stringify({ error: { message: "rate limited" } }) },
        { status: 200, body: JSON.stringify({ title: "t", content: "served after the limit" }) },
      );
      const controller = new SearchProviderController(createSearchProviderRegistry(transport, () => "key", publicLookup), dir);
      controller.configure("deepseek", {});
      expect(await controller.test("deepseek")).toEqual({ ok: true });
      expect(await controller.select("deepseek")).toEqual({ ok: true });

      expect(await controller.fetchPage("https://example.com/a")).toMatchObject({ ok: false, reason: "fetch-failed", retryable: true });
      expect(await controller.fetchPage("https://example.com/b")).toMatchObject({ ok: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a cancelled search is a cancellation, not a search failure with advice", async () => {
    const transport: SandboxedWebTransport = {
      async request(request) {
        return { ok: false, status: 0, url: request.url, contentType: "", text: "", error: "cancelled" as const };
      },
    };
    const dir = mkdtempSync(path.join(os.tmpdir(), "keryx-search-cancelled-"));
    try {
      writeFileSync(searchConfigPath(dir), `${JSON.stringify({ schemaVersion: 2, activeProviderId: "deepseek", providers: { deepseek: { fields: {}, status: "connected" } } })}\n`);
      const controller = new SearchProviderController(createSearchProviderRegistry(transport, () => "key", publicLookup), dir);
      const aborted = new AbortController();
      aborted.abort();
      const result = await controller.search("anything", aborted.signal);
      expect(result.ok).toBe(false);
      expect(result.ok ? "" : result.cancelled).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("connect reports cancellation separately from a failed activation", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "keryx-search-connect-cancel-"));
    try {
      const controller = new SearchProviderController(createSearchProviderRegistry(new FakeTransport(), () => "key", publicLookup), dir);
      expect(await controller.connect("deepseek", {}, undefined, { isCancelled: () => true })).toMatchObject({ ok: true, active: false });
      expect(controller.active()?.id).toBe("duckduckgo");
      expect(await controller.connect("deepseek", {}, undefined, { activate: false })).toMatchObject({ ok: true, active: false, servesPages: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the keyless fetch path spends no DNS lookup", async () => {
    let lookups = 0;
    const counting = async () => { lookups += 1; return [{ address: "93.184.216.34" }]; };
    const registry = createSearchProviderRegistry(new FakeTransport(), () => undefined, counting);
    const deepseek = registry.get("deepseek")!;
    expect(await deepseek.fetchPage!.call(deepseek, "https://example.com/a")).toEqual({ ok: false, reason: "no-fetch-provider" });
    expect(lookups).toBe(0);
  });

  test("a search-only provider never takes web_fetch away, whatever its status", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "keryx-search-searxng-fetch-"));
    try {
      writeFileSync(searchConfigPath(dir), `${JSON.stringify({
        schemaVersion: 2,
        activeProviderId: "searxng",
        providers: { searxng: { fields: { baseUrl: "http://localhost", port: "8080" }, status: "disconnected" } },
      })}\n`);
      const controller = new SearchProviderController(createSearchProviderRegistry(new FakeTransport(), () => "key", publicLookup), dir);
      // SearXNG has no fetchPage, so "the selected provider is not connected"
      // is not a statement about pages: the tool keeps the transport.
      expect(await controller.fetchPage("https://example.com/a")).toEqual({ ok: false, reason: "no-fetch-provider" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a page-capable provider that is not connected is reported, and the tool still fetches", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "keryx-search-deepseek-disconnected-"));
    try {
      writeFileSync(searchConfigPath(dir), `${JSON.stringify({
        schemaVersion: 2,
        activeProviderId: "deepseek",
        providers: { deepseek: { fields: {}, status: "disconnected" } },
      })}\n`);
      const controller = new SearchProviderController(createSearchProviderRegistry(new FakeTransport(), () => "key", publicLookup), dir);
      expect(await controller.fetchPage("https://example.com/a")).toEqual({ ok: false, reason: "provider-disconnected" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a target lookup that never answers settles, and is retryable", async () => {
    setDeepSeekDnsTimeoutForTests(20);
    try {
      const transport = new FakeTransport();
      const deepseek = createSearchProviderRegistry(transport, () => "key", () => new Promise(() => {})).get("deepseek")!;
      const fetchPage = deepseek.fetchPage;
      if (fetchPage === undefined) throw new Error("deepseek must expose fetchPage");
      const started = Date.now();
      const result = await fetchPage.call(deepseek, "https://example.com/a");
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(result).toMatchObject({ ok: false, reason: "fetch-failed", retryable: true });
      expect(transport.requests).toHaveLength(0);
    } finally {
      setDeepSeekDnsTimeoutForTests(5_000);
    }
  });

  test("an operator interrupt is not a provider outage", async () => {
    const transport = new FakeTransport();
    const deepseek = createSearchProviderRegistry(transport, () => "key", publicLookup).get("deepseek")!;
    const fetchPage = deepseek.fetchPage;
    if (fetchPage === undefined) throw new Error("deepseek must expose fetchPage");
    const aborted = new AbortController();
    aborted.abort();
    const transportWithCancel = createSearchProviderRegistry(
      { async request(request) { return { ok: false, status: 0, url: request.url, contentType: "", text: "", error: "cancelled" as const }; } },
      () => "key",
      publicLookup,
    );
    const cancelled = transportWithCancel.get("deepseek")!;
    const cancelledFetch = cancelled.fetchPage!;
    const result = await cancelledFetch.call(cancelled, "https://example.com/a", aborted.signal);
    expect(result).toMatchObject({ ok: false, reason: "fetch-failed", retryable: false });
    expect(!result.ok && result.reason === "fetch-failed" ? result.detail : "").toContain("cancelled");
  });

  test("a 429 on fetch is not laddered: it falls back on the first answer", async () => {
    // Non-empty rungs: with the suite's default [] a restored ladder would be
    // a no-op, so the assertion would pass for the wrong reason.
    setDeepSeekTimingForTests({ backoffMs: [0, 0] });
    let calls = 0;
    const transport: SandboxedWebTransport = {
      async request(request) {
        calls += 1;
        return { ok: false, status: 429, url: request.url, contentType: "application/json", text: JSON.stringify({ error: { message: "rate limited" } }) };
      },
    };
    const deepseek = createSearchProviderRegistry(transport, () => "key", publicLookup).get("deepseek")!;
    const result = await deepseek.fetchPage!.call(deepseek, "https://example.com/a");
    expect(result).toMatchObject({ ok: false, reason: "fetch-failed", retryable: true });
    expect(calls).toBe(1);
  });

  test("a DeepSeek 429 speaks about DeepSeek, never about DuckDuckGo", async () => {
    const transport: SandboxedWebTransport = {
      async request(request) {
        return { ok: false, status: 429, url: request.url, contentType: "application/json", text: JSON.stringify({ error: { message: "rate limited" } }) };
      },
    };
    const dir = mkdtempSync(path.join(os.tmpdir(), "keryx-search-429-word-"));
    try {
      writeFileSync(searchConfigPath(dir), `${JSON.stringify({ schemaVersion: 2, activeProviderId: "deepseek", providers: { deepseek: { fields: {}, status: "connected" } } })}\n`);
      const controller = new SearchProviderController(createSearchProviderRegistry(transport, () => "key", publicLookup), dir);
      const result = await controller.search("keryx sandbox");
      expect(result.ok).toBe(false);
      const detail = result.ok ? "" : (result.detail ?? "");
      expect(detail).toContain("DeepSeek");
      expect(detail).not.toContain("DuckDuckGo");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a permanent 4xx is told not to retry, not to wait", async () => {
    const transport: SandboxedWebTransport = {
      async request(request) {
        return { ok: false, status: 400, url: request.url, contentType: "application/json", text: JSON.stringify({ error: { message: "query must be at most 128 characters" } }) };
      },
    };
    const dir = mkdtempSync(path.join(os.tmpdir(), "keryx-search-permanent-4xx-"));
    try {
      writeFileSync(searchConfigPath(dir), `${JSON.stringify({ schemaVersion: 2, activeProviderId: "deepseek", providers: { deepseek: { fields: {}, status: "connected" } } })}\n`);
      const controller = new SearchProviderController(createSearchProviderRegistry(transport, () => "key", publicLookup), dir);
      const result = await controller.search("x".repeat(200));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.permanent).toBe(true);
        expect(result.detail ?? "").toContain("HTTP 400");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the controller seam refuses a non-public URL before any provider sees it", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "keryx-search-seam-"));
    try {
      const controller = new SearchProviderController(createSearchProviderRegistry(new FakeTransport(), () => "key", publicLookup), dir);
      expect(await controller.fetchPage("http://example.com/a")).toEqual({
        ok: false,
        reason: "fetch-failed",
        detail: "url must be absolute HTTPS without credentials",
      });
      expect(await controller.fetchPage("https://user:pass@example.com/a")).toMatchObject({ ok: false, reason: "fetch-failed" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a selected but disconnected provider is reported, not silently swapped for the transport", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "keryx-search-disconnected-fetch-"));
    try {
      writeFileSync(searchConfigPath(dir), `${JSON.stringify({
        schemaVersion: 2,
        activeProviderId: "deepseek",
        providers: { deepseek: { fields: {}, status: "disconnected" } },
      })}\n`);
      const controller = new SearchProviderController(createSearchProviderRegistry(new FakeTransport(), () => "key", publicLookup), dir);
      expect(await controller.fetchPage("https://example.com/a")).toEqual({ ok: false, reason: "provider-disconnected" });
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
    const registry = createSearchProviderRegistry(transport, () => "key", publicLookup);
    for (const id of ["brave", "tavily", "exa"] as const) {
      expect(await registry.get(id)!.testConnection({})).toEqual({ ok: false, reason: "transport-failed" });
    }
    // DeepSeek distinguishes "answered, but not with search results" from a
    // transport fault, so it is pinned separately rather than in the loop.
    expect(await registry.get("deepseek")!.testConnection({})).toEqual({ ok: false, reason: "incompatible-response" });
  });
});
