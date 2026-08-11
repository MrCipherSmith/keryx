import { describe, expect, test } from "bun:test";
import {
  createSearchProviderRegistry,
  connectedProviderIds,
  SearchProviderController,
  type SandboxedWebRequest,
  type SandboxedWebTransport,
} from "./index";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

class FakeTransport implements SandboxedWebTransport {
  readonly requests: SandboxedWebRequest[] = [];

  async request(request: SandboxedWebRequest) {
    this.requests.push(request);
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
  test("describes SearXNG, Brave, Tavily and Exa without provider-specific TUI logic", () => {
    const registry = createSearchProviderRegistry(new FakeTransport());

    expect(registry.descriptors.map((descriptor) => descriptor.id)).toEqual(["searxng", "brave", "tavily", "exa"]);
    const searxng = registry.get("searxng");
    expect(searxng?.kind).toBe("local");
    expect(searxng?.defaults).toEqual({ baseUrl: "http://localhost", port: "8080" });
    expect(searxng?.documentationUrl).toContain("docs.searxng.org");
    expect(registry.get("brave")?.credentialSchema.required).toBe(true);
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

      expect(controller.configurable().map((provider) => provider.id)).toEqual(["searxng", "brave", "tavily", "exa"]);
      expect(await controller.select("searxng")).toEqual({ ok: false, reason: "not-connected" });
      expect(await controller.test("searxng")).toEqual({ ok: true });
      expect(controller.selectable().map((provider) => provider.id)).toEqual(["searxng"]);
      expect(await controller.select("searxng")).toEqual({ ok: true });
      expect(controller.active()?.id).toBe("searxng");
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
