import { providerApiKey, providerByName } from "../../commands/providers";
import { readSearchCredential } from "../../lib/search-config";
import { envWithSavedApiKeys } from "../../lib/shell-config";
import { SandboxedWebTransport } from "../web/sandboxed-web-transport";
import { createSystemWebWorkerRunner } from "../web/web-worker-runner";
import { SearchProviderController } from "./controller";
import { createSearchProviderRegistry } from "./registry";
import type { SearchProviderId, SearchCredentialResolver } from "./types";

/**
 * Search providers whose credential may be borrowed from a chat-model
 * provider. DeepSeek bills its Search API to the same account and the same
 * API key as its chat models, so an operator who already connected `deepseek`
 * for models does not paste a second copy of that key just to search.
 */
const SEARCH_KEY_BORROWED_FROM: Partial<Record<SearchProviderId, string>> = { deepseek: "deepseek" };

/**
 * The key a chat-model provider was connected with, resolved exactly as the
 * model catalog resolves it: an (exported or saved) `DEEPSEEK_API_KEY` from
 * `src/commands/providers.ts`'s registry entry. Keeping that registry as the
 * one source of the env-var name is what stops this fallback from drifting
 * away from the key the operator actually uses.
 */
function savedModelApiKey(providerName: string, env: Record<string, string | undefined>, dir?: string): string | undefined {
  const provider = providerByName(providerName, dir);
  return provider === undefined ? undefined : providerApiKey(provider, envWithSavedApiKeys(env, dir));
}

/**
 * Where a provider's credential comes from, in order: a credential saved for
 * search by `/search-provider`, then — for DeepSeek only — the chat-model key.
 * Reading `process.env` is deliberately confined to this composition root; no
 * adapter sees it. `env` is a test seam, defaulted exactly like `providerApiKey`'s.
 */
export function searchCredentialResolver(
  configDir?: string,
  env: Record<string, string | undefined> = process.env,
): SearchCredentialResolver {
  return (providerId) => {
    const stored = readSearchCredential(providerId, configDir);
    if (stored !== undefined) return stored;
    const modelProvider = SEARCH_KEY_BORROWED_FROM[providerId];
    return modelProvider === undefined ? undefined : savedModelApiKey(modelProvider, env, configDir);
  };
}

/** Trusted composition root for the agent search tool; no adapter sees process.env. */
export function createDefaultSearchProviderController(configDir?: string): SearchProviderController {
  const transport = new SandboxedWebTransport({ runner: createSystemWebWorkerRunner() });
  const registry = createSearchProviderRegistry(transport, searchCredentialResolver(configDir));
  return new SearchProviderController(registry, configDir);
}
