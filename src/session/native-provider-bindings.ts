import { isProviderPlatformSupported, providerApiKey, providerByName, resolveProviderBaseUrl, type OpenAiCompatProvider } from "../commands/providers";
import { isLoopbackHost, isPrivateEgressHost, isPrivateLanHost } from "../harness/mutation/guard";
import type { Control } from "../remote-control/protocol";
import { TasksIntegrationError } from "./commands/tasks-integrations";
import type { NativeModelBinding } from "./model-identity";
import type { NativeProviderServices } from "./native-services-production";

export interface NativeProviderBindingOptions {
  configDir?: string;
  /** The credential environment the native coding provider already resolves locally (saved keys merged). Never Hub data. */
  env: Readonly<Record<string, string | undefined>>;
  /** The session's current local routing candidates; only an available one is locally allowed. */
  candidates: readonly Control["RoutingCandidate"][];
  /** This runtime's wire-to-actual model bindings; a candidate without one is not locally bound and is not offered. */
  bindings: readonly NativeModelBinding[];
  /** The saved provider's own endpoint override, exactly as the native coding provider is constructed with it. */
  savedBaseUrl?: { providerId: string; baseUrl: string };
  fetch: typeof fetch;
  platform?: NodeJS.Platform;
}

/** Self-contained provider driver for the native owner: the shared OpenAI-compatible registry, credential and endpoint
 * resolution `/connect` uses, restricted to locally allowed candidates, behind the compat engine's own egress predicate.
 * It adds no credential, trust, endpoint or budget, and it carries no selection transaction: the native owner attaches that. */
export function createNativeProviderServices(options: NativeProviderBindingOptions): NativeProviderServices {
  const bindings: { candidateId: string; provider: OpenAiCompatProvider }[] = [];
  const unavailable: NonNullable<NativeProviderServices["unavailable"]>[number][] = [];
  const env = { ...options.env }; const seen = new Set<string>();
  for (const candidate of options.candidates) {
    if (!candidate.available || seen.has(candidate.candidateId)) continue;
    const local = options.bindings.find((binding) => binding.providerId === candidate.providerId && binding.modelId === candidate.modelId);
    if (local === undefined) continue;
    seen.add(candidate.candidateId);
    const compat = providerByName(local.actualProviderId, options.configDir);
    if (compat === undefined) { unavailable.push({ candidateId: candidate.candidateId, label: local.actualProviderId, state: "implementation-gap" }); continue; }
    const apiKey = providerApiKey(compat, env) ?? compat.apiKey;
    if (!isProviderPlatformSupported(compat, options.platform) || (compat.requiresApiKey !== false && apiKey === undefined)) {
      unavailable.push({ candidateId: candidate.candidateId, label: compat.label, state: "not-configured" }); continue;
    }
    const baseUrl = options.savedBaseUrl?.providerId === compat.name ? options.savedBaseUrl.baseUrl : resolveProviderBaseUrl(compat, env);
    bindings.push({ candidateId: candidate.candidateId, provider: { ...compat, baseUrl, ...(apiKey === undefined ? {} : { apiKey }) } });
  }
  const endpoints = new Map(bindings.map((binding) => [binding.candidateId, binding.provider]));
  return { bindings, unavailable, fetch: options.fetch,
    async beforeRequest(candidateId, signal) {
      signal.throwIfAborted();
      const provider = endpoints.get(candidateId); if (provider === undefined) throw new TasksIntegrationError("not-found", "No locally allowed provider candidate has this id.");
      let target: URL;
      try { target = new URL(provider.baseUrl); } catch { throw new TasksIntegrationError("policy-denied", "The provider endpoint is not a valid local configuration; nothing was sent."); }
      // The same SSRF predicate the OpenAI-compatible engine applies before its own requests: loopback and
      // private LAN only on the provider's own explicit opt-in, metadata/link-local never.
      const host = target.hostname;
      const permitted = !isPrivateEgressHost(host) || (provider.allowLoopback === true && isLoopbackHost(host)) || (provider.allowPrivateLan === true && isPrivateLanHost(host));
      if ((target.protocol !== "http:" && target.protocol !== "https:") || target.username || target.password || !permitted) throw new TasksIntegrationError("policy-denied", "Egress to this provider endpoint is not locally permitted; nothing was sent.");
    } };
}
