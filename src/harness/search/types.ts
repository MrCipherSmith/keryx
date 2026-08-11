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

export type SearchProviderId = "searxng" | "brave" | "tavily" | "exa";
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
  results: NormalizedSearchResult[];
}

export interface SearchConnectionResult {
  ok: boolean;
  reason?: "missing-credential" | "transport-failed" | "incompatible-response";
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
}

export type SearchCredentialResolver = (providerId: SearchProviderId) => string | undefined;
