/**
 * The only network boundary available to search adapters. The web-transport
 * flow supplies the implementation; adapters must never call fetch or a SDK.
 */
export interface SandboxedWebTransport {
  request(request: SandboxedWebRequest): Promise<SandboxedWebResponse>;
}

export interface SandboxedWebRequest {
  providerId: SearchProviderId;
  /** A capability-scoped local exception; remote adapters always use public-search. */
  capability: "local-search" | "public-search";
  url: string;
  method: "GET" | "POST";
  query?: string;
  body?: Record<string, unknown>;
  /** One credential is delivered to the final transport boundary, never via env or URL. */
  credential?: CredentialInjection;
  signal?: AbortSignal;
}

export interface CredentialInjection {
  injection: "header" | "json-body";
  name: string;
  value: string;
}

export interface SandboxedWebResponse {
  ok: boolean;
  status: number;
  url: string;
  contentType: string;
  /** Bounded raw provider payload for a trusted adapter only; never agent-visible. */
  text: string;
  error?: "cancelled" | "timeout" | "policy-denied" | "transport-failed" | "malformed-response";
}

export type SearchProviderId = "duckduckgo" | "searxng" | "brave" | "tavily" | "exa" | "deepseek";
export const DEFAULT_SEARCH_PROVIDER_ID: SearchProviderId = "duckduckgo";
export type SearchProviderKind = "local" | "remote";

export interface SearchFieldDescriptor {
  id: string;
  label: string;
  required: boolean;
  defaultValue?: string;
  secret?: false;
}

export interface SearchCredentialSchema {
  required: boolean;
  label?: string;
  secret: true;
}

export interface SearchProviderCapabilities {
  localLoopback: boolean;
  supportsPublicationDate: boolean;
}

export interface SearchProviderConfig {
  providerId: SearchProviderId;
  fields: Record<string, string>;
}

export interface SearchProvenance {
  source: "search-provider";
  providerId: SearchProviderId;
  rawResultCount: number;
}

export interface NormalizedSearchResult {
  title: string;
  canonicalUrl: string;
  snippet: string;
  publicationDate?: string;
  providerId: SearchProviderId;
  provenance: SearchProvenance;
}

export interface SearchResponse {
  query: string;
  providerId: SearchProviderId;
  results: NormalizedSearchResult[];
}

export interface SearchConnectionResult {
  ok: boolean;
  /**
   * `insufficient-balance` exists because a paid search API can accept the key
   * and still refuse every request (DeepSeek answers HTTP 402). Reported as a
   * transport fault it sends the operator to retry a dead account.
   */
  reason?: "missing-credential" | "invalid-credential" | "transport-failed" | "incompatible-response" | "rate-limited" | "insufficient-balance";
}

export interface SearchProviderConnectionState {
  providerId: SearchProviderId;
  status: "connected" | "disconnected";
  reason?: SearchConnectionResult["reason"];
}

export interface SearchProviderDescriptor {
  id: SearchProviderId;
  displayName: string;
  kind: SearchProviderKind;
  fields: readonly SearchFieldDescriptor[];
  defaults: Readonly<Record<string, string>>;
  credentialSchema: SearchCredentialSchema;
  documentationUrl: string;
  capabilities: SearchProviderCapabilities;
  testConnection(fields: Record<string, string>): Promise<SearchConnectionResult>;
  search(fields: Record<string, string>, query: string, signal?: AbortSignal): Promise<SearchResponse>;
  /**
   * Optional: a provider that retrieves a page itself, as Markdown (DeepSeek's
   * Fetch API). Absent — every provider but DeepSeek — `web_fetch` keeps using
   * the sandbox transport, which is what it did before this capability existed.
   */
  fetchPage?(url: string, signal?: AbortSignal): Promise<ProviderPageResult>;
  /*
   * An implementation MUST validate the TARGET before spending a request: the
   * sandbox transport validates the host it connects to, which on this path is
   * the provider, not the page. `parsePublicHttpsUrl` + `validatePublicTarget`
   * is the same policy the transport applies.
   */
}

/** A page a provider retrieved for `web_fetch`, before the caller sanitizes it. */
export interface ProviderPage {
  providerId: SearchProviderId;
  url: string;
  title: string;
  text: string;
}

export type ProviderPageResult =
  | { ok: true; value: ProviderPage }
  /**
   * No usable page provider: either the active provider has no such capability,
   * or a fetch-capable provider's credential is gone. Both mean "the caller
   * keeps the sandbox transport", which is what `web_fetch` did before this
   * capability existed.
   */
  | { ok: false; reason: "no-fetch-provider" }
  /** The operator selected a provider that is not connected: report it, never silently switch egress. */
  | { ok: false; reason: "provider-disconnected" }
  /**
   * `retryable` marks a page the provider could not serve for a reason that is
   * not about the page: a timeout, 408, 429 or 5xx, an empty extraction, or a
   * 404 whose meaning is "no usable content". The caller may serve it from the
   * sandbox transport instead. 402 and 403 stay terminal — swapping the egress
   * there would hide what the operator chose.
   */
  | {
      ok: false;
      reason: "fetch-failed";
      detail?: string;
      retryable?: boolean;
      /** The account (balance, key) is refused, not this page: every URL will fail until it is fixed. */
      permanent?: boolean;
    };

export type SearchCredentialResolver = (providerId: SearchProviderId) => string | undefined;

/**
 * A refusal that carries WHY waiting cannot help, as data rather than prose.
 *
 * - `account`: the account is refused (empty balance, rejected key, missing
 *   credential) — every later call fails the same way, so it is worth caching.
 * - `request`: this request was rejected (a 400/413, a malformed body) — the
 *   next, corrected request may succeed, so it is NEVER cached.
 * - `transient`: rate limit or timeout — wait, then retry.
 */
export type SearchRefusalScope = "account" | "request" | "transient";

export class SearchRefusalError extends Error {
  constructor(message: string, readonly scope: SearchRefusalScope = "transient") {
    super(message);
    this.name = "SearchRefusalError";
  }

  /** Only an account-scoped refusal means "every later call will fail too". */
  get permanent(): boolean {
    return this.scope !== "transient";
  }
}
