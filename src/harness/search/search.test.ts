import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadSearchConfig } from "../../lib/search-config";
import { duckduckgoLiteUrl, resetDuckDuckGoRateLimitForTests } from "./duckduckgo";
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

  async request(request: SandboxedWebRequest) {
    this.requests.push(request);
    if (request.providerId === "duckduckgo") {
      return {
        ok: this.duckduckgoStatus >= 200 && this.duckduckgoStatus < 300,
        status: this.duckduckgoStatus,
        url: request.url,
        contentType: "text/html; charset=utf-8",
        text: this.duckduckgoBody,
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
  test("describes DuckDuckGo first, then SearXNG, Brave, Tavily and Exa", () => {
    const registry = createSearchProviderRegistry(new FakeTransport());

    expect(registry.descriptors.map((descriptor) => descriptor.id)).toEqual(["duckduckgo", "searxng", "brave", "tavily", "exa"]);
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

  test("treats DuckDuckGo anomaly pages as a failed connection, not an empty SERP", async () => {
    const transport = new FakeTransport();
    transport.duckduckgoStatus = 202;
    transport.duckduckgoBody = anomalyHtml;
    const registry = createSearchProviderRegistry(transport);
    expect(await registry.get("duckduckgo")!.testConnection({})).toEqual({ ok: false, reason: "transport-failed" });

    transport.duckduckgoStatus = 200;
    expect(await registry.get("duckduckgo")!.testConnection({})).toEqual({ ok: false, reason: "transport-failed" });
  });

  test("uses only the injected sandboxed transport and returns the common normalized result", async () => {
    const transport = new FakeTransport();
    const registry = createSearchProviderRegistry(transport);

    const result = await registry.get("searxng")!.search({ baseUrl: "http://localhost", port: "9090" }, "keryx sandbox");

    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]).toMatchObject({ providerId: "searxng", capability: "local-search", url: "http://localhost:9090/search?q=keryx%20sandbox&format=json" });
    expect(result).toEqual({
      query: "keryx sandbox",
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

      expect(controller.configurable().map((provider) => provider.id)).toEqual(["duckduckgo", "searxng", "brave", "tavily", "exa"]);
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

  test("DuckDuckGo search anomalies surface as search-failed, not empty hits", async () => {
    resetDuckDuckGoRateLimitForTests();
    const dir = mkdtempSync(path.join(os.tmpdir(), "keryx-search-anomaly-"));
    try {
      const transport = new FakeTransport();
      transport.duckduckgoBody = anomalyHtml;
      const controller = new SearchProviderController(createSearchProviderRegistry(transport), dir);
      expect(await controller.search("keryx sandbox")).toEqual({ ok: false, reason: "search-failed" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
