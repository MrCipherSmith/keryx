export { connectedProviderIds, createSearchProviderRegistry, SearchProviderRegistry } from "./registry";
export { SearchProviderController } from "./controller";
export { createDefaultSearchProviderController, searchCredentialResolver } from "./default-controller";
export { connectedMessage, type ConnectOutcome } from "./connect-message";
export { describeConnectionFailure } from "./connection-message";
export type {
  CredentialInjection,
  ProviderPage,
  ProviderPageResult,
  NormalizedSearchResult,
  SandboxedWebRequest,
  SandboxedWebResponse,
  SandboxedWebTransport,
  SearchConnectionResult,
  SearchCredentialResolver,
  SearchProviderConfig,
  SearchProviderConnectionState,
  SearchProviderDescriptor,
  SearchProviderId,
  SearchResponse,
} from "./types";
export { DEFAULT_SEARCH_PROVIDER_ID, SearchRefusalError, type SearchRefusalScope } from "./types";
export type { SearchSelectionResult } from "./controller";
