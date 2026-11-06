import {
  DUCKDUCKGO_HEALTHCHECK_QUERY,
  duckduckgoLiteUrl,
  duckduckgoSearchResponse,
  isDuckDuckGoAnomaly,
  maybeDelayDuckDuckGoSearch,
  waitDuckDuckGoBackoff,
} from "./duckduckgo";
import { RATE_LIMITED_SEARCH_ERROR } from "./connection-message";
import { lookup as systemLookup } from "node:dns/promises";
import { parsePublicHttpsUrl, validatePublicTarget, type HostLookup } from "../web/web-policy";
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
const DEEPSEEK_DOCS_URL = "https://api-docs.deepseek.com/guides/search/";
const DEEPSEEK_SEARCH_URL = "https://api.deepseek.com/v1/tools/search";
const DEEPSEEK_FETCH_URL = "https://api.deepseek.com/v1/tools/fetch";
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
    providerId,
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

/**
 * DeepSeek answers with OpenAI-compatible statuses, so the status names the
 * fix. 402 is the one the generic `requestFailure` cannot express: a paid
 * search API with an empty balance accepts the key and refuses every request,
 * and reporting that as a transport fault sends the operator to retry a dead
 * account instead of topping it up. `search` throws the message, so the
 * provider's own words reach the agent as the `search-failed` detail.
 */
function deepseekFailure(response: SandboxedWebResponse): { reason: NonNullable<SearchConnectionResult["reason"]>; message: string } | undefined {
  if (response.ok && response.status >= 200 && response.status < 300) return undefined;
  const status = response.status;
  if (status === 401) return { reason: "invalid-credential", message: "DeepSeek rejected the API key (HTTP 401): replace it with a valid key" };
  if (status === 402) return { reason: "insufficient-balance", message: "DeepSeek refused the search for insufficient balance (HTTP 402): top up the account, then retry" };
  if (status === 429) return { reason: "rate-limited", message: "rate limited by DeepSeek (HTTP 429): wait a few minutes before retrying" };
  if (status === 0) return { reason: "transport-failed", message: `DeepSeek request failed before a response (${response.error ?? "transport-failed"})` };
  return { reason: "transport-failed", message: `DeepSeek request failed (HTTP ${status})` };
}

/**
 * DeepSeek authenticates with `Authorization: Bearer <key>`, and the worker
 * sends a header credential verbatim — so the scheme is added here, at the one
 * place that knows this provider's header format.
 */
function bearer(key: CredentialInjection | undefined): CredentialInjection | undefined {
  return key === undefined ? undefined : { ...key, value: `Bearer ${key.value}` };
}

function deepseekSearchRequest(query: string, key: CredentialInjection): SandboxedWebRequest {
  return {
    providerId: "deepseek",
    capability: "public-search",
    url: DEEPSEEK_SEARCH_URL,
    method: "POST",
    query,
    body: { query, count: MAX_RESULTS },
    credential: key,
  };
}

/**
 * The Fetch API's own failures, worded for an agent that must not retry a
 * permanent one: 403 is the provider's security policy, 404 is "no usable page
 * content" (deepseek.com documents both as the target's fault, not the key's).
 */
function deepseekFetchFailure(response: SandboxedWebResponse): { detail: string; retryable: boolean } | undefined {
  if (response.ok && response.status >= 200 && response.status < 300) return undefined;
  const status = response.status;
  if (status === 401) return { detail: "DeepSeek rejected the API key (HTTP 401): replace it with a valid key", retryable: false };
  if (status === 402) return { detail: "DeepSeek refused the fetch for insufficient balance (HTTP 402): top up the account, then retry", retryable: false };
  if (status === 403) return { detail: "the provider's security policy rejected this URL (HTTP 403)", retryable: false };
  // "No usable page content" is the extractor giving up, not a page refusal,
  // and deepseek.com does not bill it: the transport may still read the page.
  if (status === 404) return { detail: "the provider could not retrieve usable page content (HTTP 404)", retryable: true };
  // Timeouts, rate limits and 5xx are the provider being unavailable, not the
  // page being refused: the sandbox transport can still serve this URL, so the
  // caller is allowed to fall back instead of failing the tool.
  if (status === 0) return { detail: `DeepSeek request failed before a response (${response.error ?? "transport-failed"}); the request may already have been billed`, retryable: true };
  if (status === 408 || status === 429 || status >= 500) return { detail: `DeepSeek fetch failed (HTTP ${status}): provider unavailable or rate limited`, retryable: true };
  return { detail: `DeepSeek fetch failed (HTTP ${status})`, retryable: false };
}

/**
 * 429s are the one DeepSeek answer worth waiting out. The ladder is bounded and
 * the delays are injectable, so a test can run it in zero time — the same shape
 * the DuckDuckGo adapter already uses.
 */
const DEEPSEEK_BACKOFF_MS = [2_000, 8_000];
let deepseekBackoffMs: number[] = DEEPSEEK_BACKOFF_MS;

/** Test-only: collapse the ladder so a suite does not sleep. */
export function setDeepSeekTimingForTests(next: { backoffMs: number[] }): void {
  deepseekBackoffMs = next.backoffMs;
}

/** A function, so the check is not narrowed away across the await. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

async function waitDeepSeekBackoff(attempt: number, signal?: AbortSignal): Promise<boolean> {
  const delay = deepseekBackoffMs[attempt];
  if (delay === undefined || isAborted(signal)) return false;
  await new Promise<void>((resolve) => setTimeout(resolve, delay));
  return !isAborted(signal);
}

/** The same public-HTTPS policy the transport applies to the host it connects to. */
function defaultLookup(hostname: string): Promise<readonly { address: string }[]> {
  return systemLookup(hostname, { all: true }).then((answers) => answers.map(({ address }) => ({ address })));
}

function deepseekFetchRequest(url: string, key: CredentialInjection): SandboxedWebRequest {
  return {
    providerId: "deepseek",
    capability: "public-search",
    url: DEEPSEEK_FETCH_URL,
    method: "POST",
    body: { url },
    credential: key,
  };
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

export function createSearchProviderRegistry(
  transport: SandboxedWebTransport,
  resolveCredential: SearchCredentialResolver = () => undefined,
  lookup: HostLookup = defaultLookup,
): SearchProviderRegistry {
  const duckduckgo: SearchProviderDescriptor = {
    id: "duckduckgo",
    displayName: "DuckDuckGo",
    kind: "remote",
    fields: [],
    defaults: {},
    credentialSchema: { required: false, secret: true },
    documentationUrl: "https://duckduckgo.com/duckduckgo-help-pages/",
    capabilities: { localLoopback: false, supportsPublicationDate: false },
    async testConnection() {
      const response = await transport.request({
        providerId: "duckduckgo",
        capability: "public-search",
        url: duckduckgoLiteUrl(DUCKDUCKGO_HEALTHCHECK_QUERY),
        method: "GET",
        query: DUCKDUCKGO_HEALTHCHECK_QUERY,
      });
      // An anomaly page (HTTP 202, or a 200 carrying the anomaly markers) is
      // DuckDuckGo REFUSING this machine, not a broken transport: the request
      // arrived and was answered. It gets its own reason so the operator
      // surfaces can say "rate limited" instead of recommending a retry that a
      // flagged egress address makes useless.
      if (isDuckDuckGoAnomaly(response.status, response.text)) return { ok: false, reason: "rate-limited" };
      if (!response.ok || response.status < 200 || response.status >= 300) return requestFailure(response);
      const parsed = duckduckgoSearchResponse(DUCKDUCKGO_HEALTHCHECK_QUERY, response.text);
      // `duckduckgoSearchResponse` fails ONLY on those same anomaly markers, so
      // this branch is that same refusal, never a transport fault.
      return parsed.ok ? { ok: true } : { ok: false, reason: "rate-limited" };
    },
    async search(_fields, query, signal) {
      for (let attempt = 0; ; attempt += 1) {
        await maybeDelayDuckDuckGoSearch(signal);
        const response = await transport.request({
          providerId: "duckduckgo",
          capability: "public-search",
          url: duckduckgoLiteUrl(query),
          method: "GET",
          query,
          ...(signal ? { signal } : {}),
        });
        const parsed = duckduckgoSearchResponse(query, response.text);
        // An anomaly page is a REFUSAL (rate limit or bot page), never an empty
        // SERP, and it is the one failure worth waiting out: a lone request
        // after a quiet period is answered normally.
        if (!isDuckDuckGoAnomaly(response.status, response.text) && parsed.ok) {
          return parsed.value;
        }
        // Out of ladder: report what happened. "search failed" alone sent the
        // operator and this agent to retry a rate limit immediately, which is
        // the one response that cannot clear it.
        if (!(await waitDuckDuckGoBackoff(attempt, signal))) {
          throw new Error(RATE_LIMITED_SEARCH_ERROR);
        }
      }
    },
  };

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

  // "Brave Search API" already names the API: appending " API key" printed
  // "Paste your Brave Search API API key" in the /search-provider wizard.
  const apiKeyLabel = (displayName: string): string =>
    /\bAPI$/.test(displayName) ? `${displayName} key` : `${displayName} API key`;

  const remote = (id: Exclude<SearchProviderId, "searxng" | "duckduckgo" | "deepseek">, displayName: string, endpoint: string, injection: CredentialInjection["injection"], name: string, mapping: { title: string; url: string; snippet: string; date?: string }): SearchProviderDescriptor => ({
    id,
    displayName,
    kind: "remote",
    fields: [],
    defaults: {},
    credentialSchema: { required: true, label: apiKeyLabel(displayName), secret: true },
    documentationUrl: id === "brave" ? "https://api.search.brave.com/app/documentation" : id === "tavily" ? "https://docs.tavily.com/" : "https://docs.exa.ai/",
    capabilities: { localLoopback: false, supportsPublicationDate: Boolean(mapping.date) },
    async testConnection(_fields) {
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
      // A missing key is a refusal, never an empty SERP: the agent reads zero
      // results as "the web has nothing", and the operator is never told.
      if (!key) throw new Error(`${displayName} has no API key — run /search-provider ${id} key=<value> to connect it`);
      const response = await transport.request({ ...remoteRequest(id, endpoint, query, key), ...(signal ? { signal } : {}) });
      const parsed = parseResponse(response);
      const results = id === "brave" && parsed && typeof parsed === "object" ? resultsFrom((parsed as { web?: unknown }).web) : resultsFrom(parsed);
      return normalize(id, query, results, mapping);
    },
  });

  // DeepSeek is hand-written rather than a `remote(...)` call: three things
  // differ. The credential crosses as a Bearer header, a non-2xx status has to
  // name the fix (402 = top up), and the model gets `summary` — the 600-800
  // character field documented "for a model" — rather than `snippet`, which
  // DeepSeek defines as 100-200 characters "for display in a UI".
  const deepseek: SearchProviderDescriptor = {
    id: "deepseek",
    displayName: "DeepSeek Search",
    kind: "remote",
    fields: [],
    defaults: {},
    credentialSchema: { required: true, label: "DeepSeek API key", secret: true },
    documentationUrl: DEEPSEEK_DOCS_URL,
    capabilities: { localLoopback: false, supportsPublicationDate: true },
    async testConnection(_fields) {
      const key = bearer(credential("deepseek", resolveCredential, "header", "Authorization"));
      if (key === undefined) return { ok: false, reason: "missing-credential" };
      const response = await transport.request(deepseekSearchRequest("keryx healthcheck", key));
      const failed = deepseekFailure(response);
      if (failed !== undefined) return { ok: false, reason: failed.reason };
      const parsed = parseResponse(response);
      return parsed !== undefined && isUsableConnectionPayload("deepseek", parsed)
        ? { ok: true }
        : { ok: false, reason: "incompatible-response" };
    },
    async search(_fields, query, signal) {
      const key = bearer(credential("deepseek", resolveCredential, "header", "Authorization"));
      // `connected` is persisted by the connection TEST, but a borrowed key can
      // disappear afterwards. Answering that with an empty SERP is a silent
      // wrong result, so it refuses like any other missing credential.
      if (key === undefined) throw new Error("DeepSeek has no API key — run /search-provider deepseek key=<value> to reconnect it");
      for (let attempt = 0; ; attempt += 1) {
        const response = await transport.request({ ...deepseekSearchRequest(query, key), ...(signal ? { signal } : {}) });
        // A 429 is the one answer worth waiting out; the ladder is bounded and
        // then the refusal says not to retry, because a model cannot wait.
        if (response.status === 429 && (await waitDeepSeekBackoff(attempt, signal))) continue;
        // A refusal is not an empty SERP: thrown, the provider's own words reach
        // the caller as the `search-failed` detail, so 402 and 429 stop reading
        // like "nothing found".
        const failed = deepseekFailure(response);
        if (failed !== undefined) throw new Error(failed.message);
        const parsed = parseResponse(response);
        return normalize("deepseek", query, parsed === undefined ? [] : resultsFrom(parsed), { title: "title", url: "url", snippet: "summary", date: "date" });
      }
    },
    async fetchPage(url, signal) {
      // The sandbox transport validates the host it actually connects to; on
      // this path that host is DeepSeek's, so the TARGET is validated here with
      // the SAME policy the transport applies: absolute public HTTPS, no
      // credentials, and every resolved address public.
      const target = parsePublicHttpsUrl(url);
      if (!target.ok) return { ok: false, reason: "fetch-failed", detail: target.reason };
      const resolved = await validatePublicTarget(target.value, lookup);
      if (!resolved.ok) return { ok: false, reason: "fetch-failed", detail: resolved.reason };
      const key = bearer(credential("deepseek", resolveCredential, "header", "Authorization"));
      // No key means this provider cannot serve pages at all: report
      // `no-fetch-provider` so `web_fetch` keeps the transport behaviour it had
      // before DeepSeek was connected, instead of refusing every URL.
      if (key === undefined) return { ok: false, reason: "no-fetch-provider" };
      for (let attempt = 0; ; attempt += 1) {
        const response = await transport.request({ ...deepseekFetchRequest(target.value.toString(), key), ...(signal ? { signal } : {}) });
        if (response.status === 429 && (await waitDeepSeekBackoff(attempt, signal))) continue;
        const failure = deepseekFetchFailure(response);
        if (failure !== undefined) return { ok: false, reason: "fetch-failed", detail: failure.detail, retryable: failure.retryable };
        const parsed = parseResponse(response);
        const record = typeof parsed === "object" && parsed !== null ? parsed as { title?: unknown; content?: unknown } : undefined;
        if (typeof record?.content !== "string" || record.content.length === 0) {
          // The provider answered but extracted nothing, and the docs say an
          // empty extraction is not billed: the transport may still have the page.
          return { ok: false, reason: "fetch-failed", detail: "the provider returned no page content", retryable: true };
        }
        return {
          ok: true,
          value: {
            providerId: "deepseek",
            url: target.value.toString(),
            title: typeof record.title === "string" ? record.title : "",
            text: record.content,
          },
        };
      }
    },
  };

  return new SearchProviderRegistry([
    duckduckgo,
    searxng,
    remote("brave", "Brave Search API", "https://api.search.brave.com/res/v1/web/search", "header", "X-Subscription-Token", { title: "title", url: "url", snippet: "description" }),
    remote("tavily", "Tavily", "https://api.tavily.com/search", "json-body", "api_key", { title: "title", url: "url", snippet: "content", date: "published_date" }),
    remote("exa", "Exa", "https://api.exa.ai/search", "header", "x-api-key", { title: "title", url: "url", snippet: "text", date: "publishedDate" }),
    deepseek,
  ]);
}

function remoteRequest(providerId: Exclude<SearchProviderId, "searxng" | "duckduckgo" | "deepseek">, endpoint: string, query: string, key: CredentialInjection): SandboxedWebRequest {
  if (providerId === "brave") {
    return { providerId, capability: "public-search", url: `${endpoint}?q=${encodeURIComponent(query)}`, method: "GET", query, credential: key };
  }
  return { providerId, capability: "public-search", url: endpoint, method: "POST", query, body: { query, numResults: MAX_RESULTS }, credential: key };
}
