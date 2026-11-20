// Desktop and its detached watcher read the same user credentials and trusted project settings.
// Selection never requires a terminal, nor does constructing an adapter send a model request.
import { connectionProviderByName, customCompatProviders, isProviderPlatformSupported, providerByName } from "./providers";
import { loadRouting } from "../harness/routing/settings";
import { FakeProvider } from "../harness/provider/fake-provider";
import { makeProvider } from "../harness/provider/make-provider";
import { defaultModelFor, hasCredential, keyedProviderCandidates } from "../harness/provider/single-turn";
import { externalBlockReason, loadExternalProvidersConfig } from "../lib/external-providers";
import { resolveExternalSetting } from "../lib/external-switch";
import { envWithOAuthAccess, loadOAuthGrant } from "../lib/oauth/grants";
import { envWithSavedApiKeys, loadShellConfig } from "../lib/shell-config";

export function makeDeskReviewProvider(provider: string, model: string, configDir?: string, sourceEnv = process.env) {
  const saved = loadShellConfig(configDir);
  const baseUrl = saved.baseUrls?.[provider] ?? (saved.provider === provider ? saved.baseUrl : undefined);
  const env = envWithOAuthAccess(envWithSavedApiKeys(sourceEnv, configDir), configDir);
  const compat = providerByName(provider, configDir);
  const adapter = makeProvider(provider, model, {
    env, fetch: globalThis.fetch, ...(configDir ? { configDir } : {}), ...(baseUrl ? { baseUrl } : {}),
  });
  if (adapter instanceof FakeProvider || (compat && !isProviderPlatformSupported(compat)) ||
      (provider === "openai-codex" && !loadOAuthGrant(provider, configDir))) {
    throw new Error("The selected review provider is unavailable. Connect it in Keryx Settings and select a model before retrying.");
  }
  return adapter;
}

export async function resolveDeskReviewModel(cwd: string, configDir?: string, env = process.env) {
  const saved = loadShellConfig(configDir);
  const routing = loadRouting(cwd, configDir);
  const assignment = routing.categories.review;
  if (assignment.mode !== "baseline" && assignment.mode !== "model") {
    throw new Error("Select a specific model or the session baseline for Review in Keryx routing settings before starting an unattended review.");
  }
  let provider = assignment.mode === "model" ? assignment.target.providerId : saved.provider;
  let model = assignment.mode === "model" ? assignment.target.modelId : saved.model;
  if (!provider && !model) {
    const credentials = envWithOAuthAccess(envWithSavedApiKeys(env, configDir), configDir);
    const connected = new Set([...keyedProviderCandidates(), "openai-codex"].filter(name => hasCredential(name, credentials, configDir)));
    for (const custom of customCompatProviders(configDir)) {
      if (custom.apiKey || custom.requiresApiKey === false || (custom.envKey && credentials[custom.envKey])) connected.add(custom.name);
    }
    if (connected.size === 1) provider = [...connected][0];
  }
  if (provider && !model) model = connectionProviderByName(provider, configDir)?.models[0] ?? defaultModelFor(provider);
  if (!provider?.trim() || !model?.trim() || provider.startsWith("-") || model.startsWith("-") || model === "unknown" || model === "fake-echo") {
    throw new Error("Choose a connected provider and model with /model in Keryx shell, then retry the review.");
  }
  const sessionProvider = saved.provider ?? (assignment.mode === "baseline" ? provider : undefined);
  if ((routing.providers.scope === "session-only" && provider !== sessionProvider) ||
      (routing.providers.scope === "allowlist" && !routing.providers.allowlist.includes(provider))) {
    throw new Error("The selected review provider is outside the project's routing scope. Check Keryx routing settings and retry.");
  }
  const external = await resolveExternalSetting({ cwd, ...(configDir ? { dir: configDir } : {}) });
  if (external.value === "off" && externalBlockReason(provider, model, loadExternalProvidersConfig(configDir).config) !== undefined) {
    throw new Error("The selected review model is blocked by this project's external provider settings. Choose an allowed review model and retry.");
  }
  const reviewer = routing.categories.subagents;
  if (reviewer.mode === "model" && (reviewer.target.providerId !== provider || reviewer.target.modelId !== model)) {
    throw new Error(`Review requires ${provider}/${model}, but Subagents is set to ${reviewer.target.providerId}/${reviewer.target.modelId} in ${routing.categorySources.subagents} routing settings. Align the Review and Subagents assignments for this project before retrying.`);
  }
  makeDeskReviewProvider(provider, model, configDir, env);
  return { provider, model };
}
