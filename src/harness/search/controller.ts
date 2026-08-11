import { loadSearchConfig, readSearchCredential, saveSearchConfig, saveSearchCredential, type SearchConfig, type StoredSearchProvider } from "../../lib/search-config";
import type { SearchConnectionResult, SearchProviderDescriptor, SearchProviderId } from "./types";
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
    return this.registry.descriptors.filter((descriptor) => config.providers?.[descriptor.id]?.status === "connected");
  }

  active(): SearchProviderDescriptor | undefined {
    const active = this.config().activeProviderId;
    return active ? this.selectable().find((descriptor) => descriptor.id === active) : undefined;
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
    const stored = config.providers?.[providerId];
    if (!stored) return { ok: false, reason: "not-configured" };
    if (stored.status !== "connected") return { ok: false, reason: "not-connected" };
    saveSearchConfig({ ...config, activeProviderId: providerId }, this.configDir);
    return { ok: true };
  }

  credentialForTransport(providerId: SearchProviderId): string | undefined {
    return readSearchCredential(providerId, this.configDir);
  }

  private config(): SearchConfig {
    return loadSearchConfig(this.configDir);
  }
}
