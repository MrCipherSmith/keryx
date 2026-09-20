import { loadSearchConfig, readSearchCredential, saveSearchConfig, saveSearchCredential, type SearchConfig, type StoredSearchProvider } from "../../lib/search-config";
import { DEFAULT_SEARCH_PROVIDER_ID, type SearchConnectionResult, type SearchProviderDescriptor, type SearchProviderId, type SearchResponse } from "./types";
import { SearchProviderRegistry } from "./registry";

export type SearchSelectionResult = { ok: true } | { ok: false; reason: "not-configured" | "not-connected" };

/**
 * Descriptor-driven state for `/search-provider` and `/search-connect`.
 * It deliberately owns no terminal rendering: consumers can render the returned
 * descriptors and states without adding a switch whenever a provider is added.
 */
export class SearchProviderController {
  constructor(private readonly registry: SearchProviderRegistry, private readonly configDir?: string) {}

  configurable(): readonly SearchProviderDescriptor[] {
    return this.registry.descriptors;
  }

  selectable(): SearchProviderDescriptor[] {
    const config = this.config();
    return this.registry.descriptors.filter((descriptor) => (
      descriptor.id === DEFAULT_SEARCH_PROVIDER_ID
      || config.providers?.[descriptor.id]?.status === "connected"
    ));
  }

  active(): SearchProviderDescriptor | undefined {
    const active = this.config().activeProviderId as SearchProviderId | undefined;
    if (active === undefined || active === DEFAULT_SEARCH_PROVIDER_ID) {
      return this.registry.get(DEFAULT_SEARCH_PROVIDER_ID);
    }
    return this.selectable().find((descriptor) => descriptor.id === active);
  }

  configure(providerId: SearchProviderId, fields: Record<string, string>, credential?: string): void {
    const config = this.config();
    const providers = { ...(config.providers ?? {}) };
    providers[providerId] = { fields: { ...fields }, status: "disconnected" };
    const next = config.activeProviderId === providerId
      ? { providers }
      : { ...(config.activeProviderId ? { activeProviderId: config.activeProviderId } : {}), providers };
    saveSearchConfig(next, this.configDir);
    if (credential !== undefined) saveSearchCredential(providerId, credential, this.configDir);
  }

  async test(providerId: SearchProviderId): Promise<SearchConnectionResult> {
    const config = this.config();
    const stored = config.providers?.[providerId];
    const descriptor = this.registry.get(providerId);
    if (!stored || !descriptor) return { ok: false, reason: "incompatible-response" };
    const result = await descriptor.testConnection(stored.fields);
    const providers = { ...(config.providers ?? {}) };
    providers[providerId] = { ...stored, status: result.ok ? "connected" : "disconnected", lastTestedAt: new Date().toISOString() };
    saveSearchConfig({ ...config, providers }, this.configDir);
    return result;
  }

  async select(providerId: SearchProviderId): Promise<SearchSelectionResult> {
    const config = this.config();
    if (providerId === DEFAULT_SEARCH_PROVIDER_ID) {
      const stored = config.providers?.[providerId];
      const providers = {
        ...(config.providers ?? {}),
        [DEFAULT_SEARCH_PROVIDER_ID]: {
          fields: { ...(stored?.fields ?? {}) },
          status: "connected" as const,
          ...(stored?.lastTestedAt ? { lastTestedAt: stored.lastTestedAt } : {}),
        },
      };
      saveSearchConfig({ ...config, providers, activeProviderId: DEFAULT_SEARCH_PROVIDER_ID }, this.configDir);
      return { ok: true };
    }
    const stored = config.providers?.[providerId];
    if (!stored) return { ok: false, reason: "not-configured" };
    if (stored.status !== "connected") return { ok: false, reason: "not-connected" };
    saveSearchConfig({ ...config, activeProviderId: providerId }, this.configDir);
    return { ok: true };
  }

  credentialForTransport(providerId: SearchProviderId): string | undefined {
    return readSearchCredential(providerId, this.configDir);
  }

  /**
   * Run the explicitly selected, still-connected provider.
   * DuckDuckGo is the default when nothing is selected — never a fallback after
   * another provider fails.
   */
  async search(query: string, signal?: AbortSignal) {
    const config = this.config();
    const activeProviderId = config.activeProviderId as SearchProviderId | undefined;
    if (activeProviderId === undefined || activeProviderId === DEFAULT_SEARCH_PROVIDER_ID) {
      return this.runProvider(DEFAULT_SEARCH_PROVIDER_ID, config.providers?.[DEFAULT_SEARCH_PROVIDER_ID], query, signal);
    }
    const stored = config.providers?.[activeProviderId];
    if (!stored || stored.status !== "connected") {
      return { ok: false as const, reason: "provider-disconnected" as const };
    }
    return this.runProvider(activeProviderId, stored, query, signal);
  }

  private async runProvider(
    providerId: SearchProviderId,
    stored: StoredSearchProvider | undefined,
    query: string,
    signal?: AbortSignal,
  ): Promise<{ ok: true; value: SearchResponse } | { ok: false; reason: "no-active-provider" | "provider-disconnected" | "search-failed"; detail?: string }> {
    const descriptor = this.registry.get(providerId);
    if (!descriptor) return { ok: false, reason: "no-active-provider" };
    try {
      return { ok: true, value: await descriptor.search(stored?.fields ?? {}, query, signal) };
    } catch (error) {
      // The provider's own refusal is the only thing that says WHY;
      // collapsing it into a bare `search-failed` is what delivered a
      // DuckDuckGo rate limit to the agent as "search failed. Retry later"
      // - advice that cannot work, because that limit is why it failed.
      return {
        ok: false,
        reason: "search-failed",
        ...(error instanceof Error && error.message.length > 0 ? { detail: error.message } : {}),
      };
    }
  }

  private config(): SearchConfig {
    return loadSearchConfig(this.configDir);
  }
}
