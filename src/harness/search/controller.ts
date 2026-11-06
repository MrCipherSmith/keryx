import { loadSearchConfig, readSearchCredential, saveSearchConfig, saveSearchCredential, type SearchConfig, type StoredSearchProvider } from "../../lib/search-config";
import { parsePublicHttpsUrl } from "../web/web-policy";
import { DEFAULT_SEARCH_PROVIDER_ID, type ProviderPageResult, type SearchConnectionResult, type SearchProviderDescriptor, type SearchProviderId, type SearchResponse } from "./types";
import { SearchProviderRegistry, SearchRefusalError } from "./registry";

/**
 * Last permanent refusal per provider, shared by every controller in this
 * process and keyed by config dir. `/search-provider` runs on a different
 * `SearchProviderController` instance than the agent tools do, so an
 * instance-local cache would suppress a recovered provider for five minutes
 * after the operator's own reconnect said it worked.
 */
const refusalStore = new Map<string, Map<SearchProviderId, { detail: string; at: number }>>();

function refusalsFor(configDir: string | undefined): Map<SearchProviderId, { detail: string; at: number }> {
  const key = configDir ?? "";
  let store = refusalStore.get(key);
  if (store === undefined) {
    store = new Map();
    refusalStore.set(key, store);
  }
  return store;
}

export type SearchSelectionResult = { ok: true } | { ok: false; reason: "not-configured" | "not-connected" };

/**
 * Descriptor-driven state for `/search-provider` and `/search-connect`.
 * It deliberately owns no terminal rendering: consumers can render the returned
 * descriptors and states without adding a switch whenever a provider is added.
 */
export class SearchProviderController {
  /**
   * Last permanent refusal per provider. A 402 or a rejected key will refuse
   * every later call identically, so re-asking turns one operator fix into N
   * wasted round trips. Cleared by `configure`/`connect` — the operator's
   * re-test is the action that may have fixed it.
   */
  private static readonly REFUSAL_TTL_MS = 5 * 60_000;

  constructor(private readonly registry: SearchProviderRegistry, private readonly configDir?: string) {}

  private get refusals(): Map<SearchProviderId, { detail: string; at: number }> {
    return refusalsFor(this.configDir);
  }

  configurable(): readonly SearchProviderDescriptor[] {
    return this.registry.descriptors;
  }

  selectable(): SearchProviderDescriptor[] {
    const config = this.config();
    return this.registry.descriptors.filter((descriptor) => (
      descriptor.id === DEFAULT_SEARCH_PROVIDER_ID || this.isConnected(config, descriptor.id)
    ));
  }

  /** One definition of "this provider may be used right now". */
  private isConnected(config: SearchConfig, providerId: SearchProviderId): boolean {
    return config.providers?.[providerId]?.status === "connected";
  }

  active(): SearchProviderDescriptor | undefined {
    return this.activeFrom(this.config());
  }

  /** One config read per call: `active()` and `selectable()` used to read it twice. */
  private activeFrom(config: SearchConfig): SearchProviderDescriptor | undefined {
    const active = config.activeProviderId as SearchProviderId | undefined;
    if (active === undefined || active === DEFAULT_SEARCH_PROVIDER_ID) {
      return this.registry.get(DEFAULT_SEARCH_PROVIDER_ID);
    }
    return this.isConnected(config, active) ? this.registry.get(active) : undefined;
  }

  /**
   * Connect in one operation: configure, test, and — unless the caller says
   * otherwise — activate. The policy lives here rather than in each command
   * surface, so `/search-provider <id>`, the TUI argument path and the wizard
   * cannot drift apart.
   */
  async connect(
    providerId: SearchProviderId,
    fields: Record<string, string>,
    credential?: string,
    options: { activate?: boolean; shouldActivate?: () => boolean } = {},
  ): Promise<{ ok: true; active: boolean; servesPages: boolean } | { ok: false; reason: NonNullable<SearchConnectionResult["reason"]> | "not-configurable" }> {
    const descriptor = this.registry.get(providerId);
    if (descriptor === undefined) return { ok: false, reason: "not-configurable" };
    this.configure(providerId, { ...descriptor.defaults, ...fields }, credential);
    const tested = await this.test(providerId);
    if (!tested.ok) return { ok: false, reason: tested.reason ?? "transport-failed" };
    // A surface that was dismissed mid-test (the wizard's Esc) must not
    // activate behind the operator's back: the predicate is read AFTER the test.
    const activate = options.activate !== false && (options.shouldActivate?.() ?? true);
    const selected = activate ? await this.select(providerId) : ({ ok: true } as const);
    return { ok: true, active: activate && selected.ok, servesPages: descriptor.fetchPage !== undefined };
  }

  configure(providerId: SearchProviderId, fields: Record<string, string>, credential?: string): void {
    this.refusals.delete(providerId);
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
    if (result.ok) this.refusals.delete(providerId);
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
    this.refusals.delete(providerId);
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

  /** A refusal this provider gave moments ago, if it is still fresh. */
  private freshRefusal(providerId: SearchProviderId): string | undefined {
    const refused = this.refusals.get(providerId);
    if (refused === undefined) return undefined;
    if (Date.now() - refused.at > SearchProviderController.REFUSAL_TTL_MS) {
      this.refusals.delete(providerId);
      return undefined;
    }
    return refused.detail;
  }

  /** Record a refusal the provider itself declared permanent. */
  private rememberPermanentRefusal(providerId: SearchProviderId, detail: string | undefined): void {
    if (detail !== undefined) this.refusals.set(providerId, { detail, at: Date.now() });
  }

  private async runProvider(
    providerId: SearchProviderId,
    stored: StoredSearchProvider | undefined,
    query: string,
    signal?: AbortSignal,
  ): Promise<
    | { ok: true; value: SearchResponse }
    | { ok: false; reason: "no-active-provider" | "provider-disconnected" | "search-failed"; detail?: string; permanent?: boolean }
  > {
    const descriptor = this.registry.get(providerId);
    if (!descriptor) return { ok: false, reason: "no-active-provider" };
    const refused = this.freshRefusal(providerId);
    if (refused !== undefined) {
      return { ok: false, reason: "search-failed", detail: `${refused} (not retried: this provider refused moments ago; fix it, then /search-provider ${providerId} to re-test)` };
    }
    try {
      return { ok: true, value: await descriptor.search(stored?.fields ?? {}, query, signal) };
    } catch (error) {
      // The provider's own refusal is the only thing that says WHY;
      // collapsing it into a bare `search-failed` is what delivered a
      // DuckDuckGo rate limit to the agent as "search failed. Retry later"
      // - advice that cannot work, because that limit is why it failed.
      const detail = error instanceof Error && error.message.length > 0 ? error.message : undefined;
      const permanent = error instanceof SearchRefusalError ? error.permanent : undefined;
      if (permanent === true) this.rememberPermanentRefusal(providerId, detail);
      return { ok: false, reason: "search-failed", ...(detail !== undefined ? { detail } : {}), ...(permanent !== undefined ? { permanent } : {}) };
    }
  }

  /**
   * `web_fetch` through the active provider, when that provider retrieves pages
   * itself (DeepSeek's Fetch API returns Markdown, which beats scraping HTML).
   *
   * `no-fetch-provider` is not a failure: it means "keep using the sandbox
   * transport", so DuckDuckGo or any other keyless/search-only selection leaves
   * `web_fetch` byte-identical to what it was before this capability existed.
   * A provider that IS active and DOES support fetching never falls back — its
   * refusal (a 402, a 404) is reported, for the same reason search never
   * silently switches engines.
   */
  async fetchPage(url: string, signal?: AbortSignal): Promise<ProviderPageResult> {
    // The seam owns the promise every implementation must keep: `web_fetch`
    // only ever retrieves an absolute public HTTPS URL without credentials.
    const target = parsePublicHttpsUrl(url);
    if (!target.ok) return { ok: false, reason: "fetch-failed", detail: target.reason };
    const config = this.config();
    const activeProviderId = config.activeProviderId as SearchProviderId | undefined;
    // Capability first: a search-only provider (Brave, Tavily, Exa, SearXNG)
    // never served pages, so its connection state must not take web_fetch away.
    const selected = activeProviderId !== undefined && activeProviderId !== DEFAULT_SEARCH_PROVIDER_ID
      ? this.registry.get(activeProviderId)
      : this.registry.get(DEFAULT_SEARCH_PROVIDER_ID);
    const fetchPage = selected?.fetchPage;
    if (selected === undefined || fetchPage === undefined) return { ok: false, reason: "no-fetch-provider" };
    // A page-capable provider that is selected but not connected is reported —
    // the tool still falls back, with a note, instead of failing the page.
    if (activeProviderId !== undefined && activeProviderId !== DEFAULT_SEARCH_PROVIDER_ID && !this.isConnected(config, activeProviderId)) {
      return { ok: false, reason: "provider-disconnected" };
    }
    const descriptor = selected;
    const refused = this.freshRefusal(descriptor.id);
    if (refused !== undefined) {
      return { ok: false, reason: "fetch-failed", detail: `${refused} (not retried: this provider refused moments ago; fix it, then /search-provider ${descriptor.id} to re-test)` };
    }
    try {
      const result = await fetchPage.call(descriptor, url, signal);
      if (!result.ok && result.reason === "fetch-failed" && result.permanent === true) this.rememberPermanentRefusal(descriptor.id, result.detail);
      return result;
    } catch (error) {
      const detail = error instanceof Error && error.message.length > 0 ? error.message : undefined;
      // A throw is a provider that never produced a page: the transport may.
      return { ok: false, reason: "fetch-failed", ...(detail !== undefined ? { detail } : {}), retryable: true };
    }
  }

  private config(): SearchConfig {
    return loadSearchConfig(this.configDir);
  }
}
