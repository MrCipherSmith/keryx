import type {
  CredentialInjection,
  NormalizedSearchResult,
  SandboxedWebRequest,
  SandboxedWebResponse,
  SandboxedWebTransport,
  SearchConnectionResult,
  SearchCredentialResolver,
  SearchProviderConnectionState,
  SearchProviderDescriptor,
  SearchProviderId,
  SearchResponse,
} from "./types";

const SEARXNG_DOCS_URL = "https://docs.searxng.org/admin/installation.html";
const MAX_RESULTS = 10;

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function resultsFrom(value: unknown): unknown[] {
  if (typeof value !== "object" || value === null) return [];
  const results = (value as Record<string, unknown>).results;
  return Array.isArray(results) ? results : [];
}

function parseResponse(response: SandboxedWebResponse): unknown | undefined {
  if (!response.ok || response.status < 200 || response.status >= 300 || !response.contentType.toLowerCase().includes("json")) return undefined;
  try {
    return JSON.parse(response.text) as unknown;
  } catch {
    return undefined;
  }
}

function isUsableConnectionPayload(providerId: SearchProviderId, parsed: unknown): boolean {
  if (typeof parsed !== "object" || parsed === null) return false;
  if (providerId === "brave") {
    const web = (parsed as { web?: unknown }).web;
    return typeof web === "object" && web !== null && Array.isArray((web as { results?: unknown }).results);
  }
  return Array.isArray((parsed as { results?: unknown }).results);
}

function toNormalized(providerId: SearchProviderId, raw: unknown, mapping: { title: string; url: string; snippet: string; date?: string }, rawResultCount: number): NormalizedSearchResult | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  const title = nonEmpty(record[mapping.title]);
  const canonicalUrl = nonEmpty(record[mapping.url]);
  if (!title || !canonicalUrl) return undefined;
  const publicationDate = mapping.date ? nonEmpty(record[mapping.date]) : undefined;
  return {
    title,
    canonicalUrl,
    snippet: nonEmpty(record[mapping.snippet]) ?? "",
    ...(publicationDate ? { publicationDate } : {}),
    providerId,
    provenance: { source: "search-provider", providerId, rawResultCount },
  };
}

function normalize(providerId: SearchProviderId, query: string, rawResults: unknown[], mapping: { title: string; url: string; snippet: string; date?: string }): SearchResponse {
  return {
    query,
    results: rawResults
      .map((result) => toNormalized(providerId, result, mapping, rawResults.length))
      .filter((result): result is NormalizedSearchResult => result !== undefined)
      .slice(0, MAX_RESULTS),
  };
}

function credential(providerId: SearchProviderId, resolver: SearchCredentialResolver, injection: CredentialInjection["injection"], name: string): CredentialInjection | undefined {
  const value = resolver(providerId);
  return value ? { injection, name, value } : undefined;
}

function baseUrl(fields: Record<string, string>): string {
  return (fields.baseUrl || "http://localhost").replace(/\/+$/, "");
}

function searxngUrl(fields: Record<string, string>, query: string): string {
  const port = fields.port || "8080";
  return `${baseUrl(fields)}:${encodeURIComponent(port)}/search?q=${encodeURIComponent(query)}&format=json`;
}

function requestFailure(response: SandboxedWebResponse): SearchConnectionResult {
  return { ok: false, reason: response.error === "malformed-response" ? "incompatible-response" : "transport-failed" };
}

export class SearchProviderRegistry {
  readonly descriptors: readonly SearchProviderDescriptor[];

  constructor(descriptors: readonly SearchProviderDescriptor[]) {
    this.descriptors = descriptors;
  }

  get(id: SearchProviderId): SearchProviderDescriptor | undefined {
    return this.descriptors.find((descriptor) => descriptor.id === id);
  }

  async testConfigured(configs: readonly { providerId: SearchProviderId; fields: Record<string, string> }[]): Promise<SearchProviderConnectionState[]> {
    return Promise.all(configs.map(async (config) => {
      const descriptor = this.get(config.providerId);
      if (!descriptor) return { providerId: config.providerId, status: "disconnected" as const, reason: "incompatible-response" as const };
      const result = await descriptor.testConnection(config.fields);
      return result.ok
        ? { providerId: config.providerId, status: "connected" as const }
        : { providerId: config.providerId, status: "disconnected" as const, reason: result.reason };
    }));
  }
}

export function connectedProviderIds(states: readonly SearchProviderConnectionState[]): SearchProviderId[] {
  return states.filter((state) => state.status === "connected").map((state) => state.providerId);
}

export function createSearchProviderRegistry(transport: SandboxedWebTransport, resolveCredential: SearchCredentialResolver = () => undefined): SearchProviderRegistry {
  const searxng: SearchProviderDescriptor = {
    id: "searxng",
    displayName: "SearXNG",
    kind: "local",
    fields: [
      { id: "baseUrl", label: "Base URL", required: true, defaultValue: "http://localhost" },
      { id: "port", label: "Port", required: true, defaultValue: "8080" },
    ],
    defaults: { baseUrl: "http://localhost", port: "8080" },
    credentialSchema: { required: false, secret: true },
    documentationUrl: SEARXNG_DOCS_URL,
    capabilities: { localLoopback: true, supportsPublicationDate: true },
    async testConnection(fields) {
      const response = await transport.request({ providerId: "searxng", capability: "local-search", url: searxngUrl(fields, "keryx healthcheck"), method: "GET", query: "keryx healthcheck" });
      const parsed = parseResponse(response);
      return parsed !== undefined && Array.isArray((parsed as Record<string, unknown>).results) ? { ok: true } : requestFailure(response);
    },
    async search(fields, query, signal) {
      const response = await transport.request({ providerId: "searxng", capability: "local-search", url: searxngUrl(fields, query), method: "GET", query, ...(signal ? { signal } : {}) });
      const parsed = parseResponse(response);
      return normalize("searxng", query, parsed === undefined ? [] : resultsFrom(parsed), { title: "title", url: "url", snippet: "content", date: "publishedDate" });
    },
  };

  const remote = (id: Exclude<SearchProviderId, "searxng">, displayName: string, endpoint: string, injection: CredentialInjection["injection"], name: string, mapping: { title: string; url: string; snippet: string; date?: string }): SearchProviderDescriptor => ({
    id,
    displayName,
    kind: "remote",
    fields: [],
    defaults: {},
    credentialSchema: { required: true, label: `${displayName} API key`, secret: true },
    documentationUrl: id === "brave" ? "https://api.search.brave.com/app/documentation" : id === "tavily" ? "https://docs.tavily.com/" : "https://docs.exa.ai/",
    capabilities: { localLoopback: false, supportsPublicationDate: Boolean(mapping.date) },
    async testConnection(fields) {
      const key = credential(id, resolveCredential, injection, name);
      if (!key) return { ok: false, reason: "missing-credential" };
      const response = await transport.request(remoteRequest(id, endpoint, "keryx healthcheck", key));
      const parsed = parseResponse(response);
      return parsed === undefined || !isUsableConnectionPayload(id, parsed)
        ? requestFailure(response)
        : { ok: true };
    },
    async search(_fields, query, signal) {
      const key = credential(id, resolveCredential, injection, name);
      if (!key) return { query, results: [] };
      const response = await transport.request({ ...remoteRequest(id, endpoint, query, key), ...(signal ? { signal } : {}) });
      const parsed = parseResponse(response);
      const results = id === "brave" && parsed && typeof parsed === "object" ? resultsFrom((parsed as { web?: unknown }).web) : resultsFrom(parsed);
      return normalize(id, query, results, mapping);
    },
  });

  return new SearchProviderRegistry([
    searxng,
    remote("brave", "Brave Search API", "https://api.search.brave.com/res/v1/web/search", "header", "X-Subscription-Token", { title: "title", url: "url", snippet: "description" }),
    remote("tavily", "Tavily", "https://api.tavily.com/search", "json-body", "api_key", { title: "title", url: "url", snippet: "content", date: "published_date" }),
    remote("exa", "Exa", "https://api.exa.ai/search", "header", "x-api-key", { title: "title", url: "url", snippet: "text", date: "publishedDate" }),
  ]);
}

function remoteRequest(providerId: Exclude<SearchProviderId, "searxng">, endpoint: string, query: string, key: CredentialInjection): SandboxedWebRequest {
  if (providerId === "brave") {
    return { providerId, capability: "public-search", url: `${endpoint}?q=${encodeURIComponent(query)}`, method: "GET", query, credential: key };
  }
  return { providerId, capability: "public-search", url: endpoint, method: "POST", query, body: { query, numResults: MAX_RESULTS }, credential: key };
}
