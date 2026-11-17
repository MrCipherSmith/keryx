// `_keryx/providers/*` and `_keryx/search_providers/*` (Keryx Desktop Client M2a,
// specification §3.9.3, decision D-11): the `/connect` and `/search-provider`
// dialogs as requests, so a desktop client needs no terminal to connect a model
// provider.
//
// Nothing here is a second implementation. Every step is a function the TUI's
// `/connect` already calls — `detectProviders`, `PROVIDER_AUTH_CATALOG`,
// `resolveModelsForPicker`, `testProviderConnection`, `disconnectProvider`,
// `saveApiKey` (+ `noteSavedCredentialEnv`), `saveProviderBaseUrl`,
// `loginDeviceCode`/`applyOAuthAccessToEnv`, `saveCustomCompatProvider`, the
// search-provider controller. Only `runProviderConnectSequence`'s orchestration
// is re-expressed: the prompts become request parameters, the live `/models`
// check after the credential is the verdict, and a rejected credential or a
// wrong endpoint is answered with `retry` instead of re-asking.
//
// THE API KEY. It arrives once, inside `connect`'s params, over the private
// stdio pipe. It is written to `auth.json` (0600) by `saveApiKey` and nowhere
// else: never echoed, never logged, never part of a reply. Everything that
// leaves this module — an `error` string, a provider's own error body — passes
// `redactSecrets` first, because a gateway may repeat the credential it was sent.
//
// The server owns what the model list is: after a connect or a disconnect it is
// told (`onProvidersChanged`) and sends `config_option_update` to every held
// session.

import { randomUUID } from "node:crypto";
import { detectProviders, type DetectedProvider } from "../commands/select";
import {
  ANTHROPIC_PICKER,
  connectionProviderByName,
  customCompatProviders,
  disconnectProvider,
  modelsFailureLine,
  providerByName,
  resolveModelsForPicker,
  resolveProviderBaseUrl,
  testProviderConnection,
  type ModelsFailure,
  type ModelsResolveResult,
} from "../commands/providers";
import type { SearchProviderController } from "../harness/search";
import { removeCustomCompatProvider, saveCustomCompatProvider } from "../lib/provider-config";
import { authCatalogEntry, catalogMethods, type AuthMethodKind } from "../lib/oauth/catalog";
import type { OAuthFetch } from "../lib/oauth/device-code";
import { applyOAuthAccessToEnv, envWithOAuthAccess, oauthAccessToken } from "../lib/oauth/grants";
import { loginDeviceCode } from "../lib/oauth/login";
import {
  envWithSavedApiKeys,
  loadShellConfig,
  noteSavedCredentialEnv,
  removeApiKey,
  removeProviderBaseUrl,
  saveApiKey,
  saveProviderBaseUrl,
} from "../lib/shell-config";
import { AcpError, invalidParams } from "./jsonrpc";
import { requireObjectParams, requireStringField } from "./protocol";
import { KERYX_ACP_EXTENSION_METHODS } from "./profile";

export type ProviderAuthMethod = "api-key" | "device-code" | "none";

/** One row of `_keryx/providers/list`. */
export interface ProviderRow {
  readonly id: string;
  readonly label: string;
  readonly connected: boolean;
  readonly authMethods: readonly ProviderAuthMethod[];
  readonly needsBaseUrl: boolean;
  readonly baseUrl?: string;
  readonly refusal?: string;
}

/** One row of `_keryx/search_providers/list`. */
export interface SearchProviderRow {
  readonly id: string;
  readonly label: string;
  readonly connected: boolean;
  readonly selected?: boolean;
  readonly needsKey?: boolean;
  readonly refusal?: string;
}

/** Test seams: production passes none and gets the real network, environment and config directory. */
export interface AcpProvidersSeams {
  /** The user-global config directory (`auth.json`, `llm-providers.json`). The default one otherwise. */
  readonly configDir?: string;
  /** The environment credentials are read from and written to. `process.env` otherwise. */
  readonly env?: Record<string, string | undefined>;
  /** `/models` and `/api/tags` probes. `globalThis.fetch` otherwise. */
  readonly fetch?: typeof fetch;
  /** The device-code endpoints' transport. `globalThis.fetch` otherwise. */
  readonly oauthFetch?: OAuthFetch;
  /** The device-code poll's wait. Real time otherwise. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface AcpProvidersHost extends AcpProvidersSeams {
  readonly searchController: () => SearchProviderController;
  readonly requireInitialized: (method: string) => void;
  /** Sends one JSON-RPC notification to the client. */
  readonly notify: (method: string, params: unknown) => void;
  /** After a connect, a login or a disconnect: the server refreshes its model list and tells every held session. */
  readonly onProvidersChanged: () => void;
  readonly newId?: () => string;
}

export type AcpExtensionHandler = (params: unknown) => Promise<unknown>;

export interface AcpProvidersHandlers {
  readonly requests: Readonly<Record<string, AcpExtensionHandler>>;
  /** Aborts every device login still polling (the connection ended). */
  readonly close: () => void;
}

const DEFAULT_OLLAMA_URL = "http://localhost:11434";
/** Hosts whose API endpoint comes from a token exchange or is fixed: the endpoint is never edited. */
const LOCKED_ENDPOINT_PROVIDERS: readonly string[] = ["github-copilot", "openai", "openai-codex"];
/** How long one provider's reachability probe may take while listing. */
const LIST_PROBE_TIMEOUT_MS = 3_000;
const REDACTED = "[redacted]";

/** `text` with every secret removed, longest first so a secret that contains another goes whole. */
export function redactSecrets(text: string, secrets: readonly (string | undefined)[]): string {
  let out = text;
  const ordered = secrets.filter((s): s is string => typeof s === "string" && s.length > 0).sort((a, b) => b.length - a.length);
  for (const secret of ordered) out = out.split(secret).join(REDACTED);
  return out;
}

function refuse(message: string, data?: unknown): never {
  const error = invalidParams(message, data);
  throw new AcpError(error.code, error.message, error.data);
}

function optionalString(obj: Record<string, unknown>, field: string, method: string): string | undefined {
  const value = obj[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") refuse(`${method}: ${field} must be a string`, { field });
  return value;
}

/** An `http`/`https` URL, as typed; `undefined` for anything else. */
function httpUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? raw : undefined;
  } catch {
    return undefined;
  }
}

function methodsOf(provider: string, fallback: readonly ProviderAuthMethod[]): ProviderAuthMethod[] {
  if (authCatalogEntry(provider) === undefined) return [...fallback];
  const kinds: readonly AuthMethodKind[] = catalogMethods(provider);
  return kinds.filter((kind): kind is ProviderAuthMethod => kind === "api-key" || kind === "device-code" || kind === "none");
}

/** Gemini is only "detected" once its key is set; the Add tab must offer it before that. */
const GEMINI_ENTRY: DetectedProvider = { name: "gemini", models: [], label: "Google Gemini", envKey: "GEMINI_API_KEY" };

const CUSTOM_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Names a custom provider may not take: built-ins win over a custom entry of the same name, so it would never be used. */
const RESERVED_NAMES: readonly string[] = ["fake", "ollama", "anthropic", "gemini", "openai", "openai-codex"];

interface LoginRun {
  readonly providerId: string;
  readonly controller: AbortController;
}

export function createProvidersHandlers(host: AcpProvidersHost): AcpProvidersHandlers {
  const env = host.env ?? process.env;
  const dir = host.configDir;
  const fetchImpl: typeof fetch = host.fetch ?? globalThis.fetch;
  const newId = host.newId ?? (() => randomUUID());
  const logins = new Map<string, LoginRun>();

  /** Env with saved keys and grants merged in, the way the shell reads credentials. */
  const credentialEnv = (): Record<string, string | undefined> => envWithOAuthAccess(envWithSavedApiKeys(env, dir), dir);
  const timeoutFetch =
    (ms: number): typeof fetch =>
    ((input: string | URL | Request, init?: RequestInit) =>
      fetchImpl(input, { ...init, signal: AbortSignal.timeout(ms) })) as typeof fetch;

  const savedBaseUrl = (name: string): string | undefined => {
    const saved = loadShellConfig(dir).baseUrls?.[name];
    return typeof saved === "string" && saved.length > 0 ? saved : undefined;
  };

  /** The provider as the picker would list it, with the endpoint the shell saved for it. */
  function lookup(id: string): DetectedProvider | undefined {
    let found: DetectedProvider | undefined;
    if (id === "ollama") {
      found = { name: "ollama", models: [], label: "Ollama", baseUrl: DEFAULT_OLLAMA_URL };
    } else if (id === "gemini") {
      found = GEMINI_ENTRY;
    } else {
      const registry = connectionProviderByName(id, dir) ?? (id === "anthropic" ? ANTHROPIC_PICKER : undefined);
      if (registry === undefined) return undefined;
      found = {
        name: registry.name,
        models: [...registry.models],
        label: registry.label,
        baseUrl: resolveProviderBaseUrl(registry, env),
        ...(registry.chatPath !== undefined ? { chatPath: registry.chatPath } : {}),
        ...(registry.modelsPath !== undefined ? { modelsPath: registry.modelsPath } : {}),
        ...(registry.note !== undefined ? { note: registry.note } : {}),
        ...(registry.envKey !== undefined ? { envKey: registry.envKey } : {}),
      };
    }
    const saved = savedBaseUrl(id);
    return saved === undefined || LOCKED_ENDPOINT_PROVIDERS.includes(id) ? found : { ...found, baseUrl: saved };
  }

  function requireProvider(method: string, id: string): DetectedProvider {
    const provider = lookup(id);
    if (provider === undefined) refuse(`${method}: keryx does not know a provider "${id}"`, { providerId: id });
    return provider;
  }

  const labelOf = (provider: DetectedProvider): string => provider.label ?? provider.name;

  /** Secrets a provider's reply could repeat: the key the shell holds for it, and an in-file custom key. */
  function secretsFor(provider: DetectedProvider, extra: readonly (string | undefined)[] = []): (string | undefined)[] {
    const registry = providerByName(provider.name, dir);
    const held = provider.envKey === undefined ? undefined : credentialEnv()[provider.envKey];
    return [...extra, held, registry?.apiKey];
  }

  // ---- list ----------------------------------------------------------------

  async function rowFor(provider: DetectedProvider, probed: boolean): Promise<ProviderRow> {
    const registry = providerByName(provider.name, dir);
    const custom = customCompatProviders(dir).some((entry) => entry.name === provider.name);
    const keyless = provider.name === "ollama" || registry?.requiresApiKey === false;
    const fallback: readonly ProviderAuthMethod[] = keyless ? ["none"] : provider.envKey !== undefined ? ["api-key"] : [];
    const authMethods = custom ? (["none"] as ProviderAuthMethod[]) : methodsOf(provider.name, fallback);
    let connected: boolean;
    if (provider.name === "ollama") {
      connected = probed; // detected = it answered on `/api/tags`
    } else if (provider.name === "openai-codex") {
      connected = oauthAccessToken("openai-codex", dir) !== undefined;
    } else if (custom) {
      connected = true; // writing it into `llm-providers.json` was the operator's act
    } else if (registry?.requiresApiKey === false) {
      connected = await probeKeyless(provider);
    } else {
      const key = provider.envKey === undefined ? undefined : credentialEnv()[provider.envKey];
      connected = (typeof key === "string" && key.length > 0) || (provider.name === "gemini" && hasGeminiKey());
    }
    const needsBaseUrl = authMethods.includes("none") && !authMethods.includes("api-key") && !custom;
    return {
      id: provider.name,
      label: labelOf(provider),
      connected,
      authMethods,
      needsBaseUrl,
      ...(provider.baseUrl !== undefined ? { baseUrl: provider.baseUrl } : {}),
      ...(authMethods.length === 0
        ? { refusal: authCatalogEntry(provider.name)?.refusal ?? "keryx has no way to connect this provider from the app" }
        : {}),
    };
  }

  const hasGeminiKey = (): boolean => {
    const merged = credentialEnv();
    return [merged["GEMINI_API_KEY"], merged["GOOGLE_API_KEY"]].some((v) => typeof v === "string" && v.length > 0);
  };

  /** A keyless local provider (Rapid-MLX) is connected when its live model list answers. */
  async function probeKeyless(provider: DetectedProvider): Promise<boolean> {
    try {
      const result = await resolveModelsForPicker(timeoutFetch(LIST_PROBE_TIMEOUT_MS), provider, credentialEnv(), {
        timeoutMs: LIST_PROBE_TIMEOUT_MS,
        ...(dir !== undefined ? { configDir: dir } : {}),
      });
      return result.failure === undefined && result.models.length > 0;
    } catch {
      return false;
    }
  }

  async function handleList(params: unknown): Promise<{ providers: ProviderRow[] }> {
    const method = KERYX_ACP_EXTENSION_METHODS.providersList;
    host.requireInitialized(method);
    void params;
    const detected = await detectProviders({
      fetch: timeoutFetch(LIST_PROBE_TIMEOUT_MS),
      env: credentialEnv(),
      platform: process.platform,
      ...(dir !== undefined ? { configDir: dir } : {}),
      ...(savedBaseUrl("ollama") !== undefined ? { baseUrl: savedBaseUrl("ollama") as string } : {}),
    });
    const ollamaAnswered = detected.some((entry) => entry.name === "ollama");
    const entries = detected.filter((entry) => entry.name !== "fake");
    if (!entries.some((entry) => entry.name === "gemini")) entries.push(GEMINI_ENTRY);
    if (!entries.some((entry) => entry.name === "ollama")) {
      // Not running now: still offered, so its endpoint can be set.
      entries.unshift({ name: "ollama", models: [], label: "Ollama", baseUrl: savedBaseUrl("ollama") ?? DEFAULT_OLLAMA_URL });
    }
    const rows = await Promise.all(
      entries.map((entry) => {
        const saved = savedBaseUrl(entry.name);
        const withSaved = saved === undefined || LOCKED_ENDPOINT_PROVIDERS.includes(entry.name) ? entry : { ...entry, baseUrl: saved };
        return rowFor(withSaved, entry.name === "ollama" && ollamaAnswered);
      }),
    );
    return { providers: rows };
  }

  // ---- test / disconnect ---------------------------------------------------

  async function handleTest(params: unknown): Promise<{ ok: boolean; models?: number; error?: string }> {
    const method = KERYX_ACP_EXTENSION_METHODS.providersTest;
    host.requireInitialized(method);
    const obj = requireObjectParams(params, method);
    const providerId = requireStringField(obj, "providerId", method);
    const provider = requireProvider(method, providerId);
    const label = labelOf(provider);
    try {
      if (provider.name === "ollama") {
        const detected = await detectProviders({
          fetch: timeoutFetch(LIST_PROBE_TIMEOUT_MS),
          env: credentialEnv(),
          platform: process.platform,
          ...(dir !== undefined ? { configDir: dir } : {}),
          baseUrl: provider.baseUrl ?? DEFAULT_OLLAMA_URL,
        });
        const found = detected.find((entry) => entry.name === "ollama");
        return found === undefined
          ? { ok: false, error: `${label} could not be reached` }
          : { ok: true, models: found.models.length };
      }
      const registry = connectionProviderByName(provider.name, dir);
      if (registry === undefined) return { ok: false, error: `${label} has no model list to test` };
      const result = await testProviderConnection(registry, fetchImpl, credentialEnv(), dir !== undefined ? { dir } : undefined);
      return verdict(label, result, secretsFor(provider));
    } catch (error) {
      return { ok: false, error: redactSecrets(error instanceof Error ? error.message : "the connection test failed", secretsFor(provider)) };
    }
  }

  function verdict(label: string, result: ModelsResolveResult, secrets: readonly (string | undefined)[]): { ok: boolean; models?: number; error?: string } {
    if (result.failure === undefined && result.models.length > 0) return { ok: true, models: result.models.length };
    const text = result.failure !== undefined ? modelsFailureLine(label, result.failure) : `${label}: no models returned`;
    return { ok: false, error: redactSecrets(text, secrets) };
  }

  async function handleDisconnect(params: unknown): Promise<{ sharedEnvWith: string[] }> {
    const method = KERYX_ACP_EXTENSION_METHODS.providersDisconnect;
    host.requireInitialized(method);
    const obj = requireObjectParams(params, method);
    const providerId = requireStringField(obj, "providerId", method);
    requireProvider(method, providerId);
    const result = disconnectProvider(providerId, env, dir);
    if (!result.ok) {
      refuse(`${method}: ${result.reason ?? "this provider cannot be disconnected from here"}`, { providerId, kind: result.kind });
    }
    host.onProvidersChanged();
    return { sharedEnvWith: result.sharedWith };
  }

  // ---- connect -------------------------------------------------------------

  type ConnectResult = { ok: boolean; error?: string; retry?: "credential" | "base-url"; models?: number };

  /** What a failed live check says to do next. `locked` endpoints are never the user's to fix. */
  function failureOutcome(label: string, failure: ModelsFailure | undefined, locked: boolean, secrets: readonly (string | undefined)[]): ConnectResult {
    const error = redactSecrets(failure !== undefined ? modelsFailureLine(label, failure) : `${label}: no models returned`, secrets);
    if (failure?.kind === "rejected") return { ok: false, error, retry: "credential" };
    if ((failure?.kind === "unreachable" || failure?.kind === "http") && !locked) return { ok: false, error, retry: "base-url" };
    return { ok: false, error };
  }

  async function connectApiKey(provider: DetectedProvider, apiKey: string, baseUrlRaw: string | undefined): Promise<ConnectResult> {
    const label = labelOf(provider);
    const envKey = provider.envKey;
    if (!catalogMethods(provider.name).includes("api-key") || envKey === undefined) {
      return { ok: false, error: `${label} does not take an API key` };
    }
    if (apiKey.length === 0) return { ok: false, error: "An API key is required.", retry: "credential" };
    const locked = LOCKED_ENDPOINT_PROVIDERS.includes(provider.name);
    let baseUrl = provider.baseUrl;
    if (baseUrlRaw !== undefined && baseUrlRaw.trim().length > 0 && !locked) {
      baseUrl = httpUrl(baseUrlRaw.trim());
      if (baseUrl === undefined) return { ok: false, error: "The base URL must start with http:// or https://", retry: "base-url" };
    }
    const secrets = [apiKey, ...secretsFor(provider)];
    // What to put back if the live check refuses it: a credential that does not work is not "connected".
    const previous = { saved: loadShellConfig(dir).apiKeys?.[envKey], env: env[envKey], baseUrl: loadShellConfig(dir).baseUrls?.[provider.name] };
    const restore = (): void => {
      if (previous.saved === undefined) removeApiKey(envKey, dir);
      else saveApiKey(envKey, previous.saved, dir);
      if (previous.env === undefined) delete env[envKey];
      else env[envKey] = previous.env;
      if (baseUrl !== provider.baseUrl || previous.baseUrl !== undefined) {
        if (previous.baseUrl === undefined) removeProviderBaseUrl(provider.name, dir);
        else saveProviderBaseUrl(provider.name, previous.baseUrl, dir);
      }
    };
    try {
      if (baseUrl !== undefined && baseUrl !== provider.baseUrl) saveProviderBaseUrl(provider.name, baseUrl, dir);
      // Set here, not exported by the operator: `shell_exec` withholds it (K-015).
      env[envKey] = apiKey;
      noteSavedCredentialEnv([envKey]);
      saveApiKey(envKey, apiKey, dir);
      // The key first, THEN `/models`: most gateways answer 401 without a Bearer key.
      const probe = baseUrl === undefined ? provider : { ...provider, baseUrl };
      const models = await resolveModelsForPicker(fetchImpl, probe, env, { ...(dir !== undefined ? { configDir: dir } : {}) });
      if (models.failure !== undefined || models.models.length === 0) {
        restore();
        return failureOutcome(label, models.failure, locked, secrets);
      }
      host.onProvidersChanged();
      return { ok: true, models: models.models.length };
    } catch (error) {
      restore();
      return { ok: false, error: redactSecrets(error instanceof Error ? error.message : `${label} could not be connected`, secrets) };
    }
  }

  async function connectKeyless(provider: DetectedProvider, baseUrlRaw: string | undefined): Promise<ConnectResult> {
    const label = labelOf(provider);
    if (!catalogMethods(provider.name).includes("none")) return { ok: false, error: `${label} needs a credential` };
    let baseUrl = provider.baseUrl;
    if (baseUrlRaw !== undefined && baseUrlRaw.trim().length > 0) {
      baseUrl = httpUrl(baseUrlRaw.trim());
      if (baseUrl === undefined) return { ok: false, error: "The base URL must start with http:// or https://", retry: "base-url" };
    }
    const previous = loadShellConfig(dir).baseUrls?.[provider.name];
    const restore = (): void => {
      if (previous === undefined) removeProviderBaseUrl(provider.name, dir);
      else saveProviderBaseUrl(provider.name, previous, dir);
    };
    try {
      if (baseUrl !== undefined) saveProviderBaseUrl(provider.name, baseUrl, dir);
      let failure: ModelsFailure | undefined;
      let count = 0;
      if (provider.name === "ollama") {
        const detected = await detectProviders({
          fetch: timeoutFetch(LIST_PROBE_TIMEOUT_MS),
          env: credentialEnv(),
          platform: process.platform,
          ...(dir !== undefined ? { configDir: dir } : {}),
          baseUrl: baseUrl ?? DEFAULT_OLLAMA_URL,
        });
        const found = detected.find((entry) => entry.name === "ollama");
        if (found === undefined) failure = { kind: "unreachable" };
        else count = found.models.length;
      } else {
        const probe = baseUrl === undefined ? provider : { ...provider, baseUrl };
        const models = await resolveModelsForPicker(fetchImpl, probe, credentialEnv(), { ...(dir !== undefined ? { configDir: dir } : {}) });
        failure = models.failure ?? (models.models.length === 0 ? { kind: "empty" } : undefined);
        count = models.models.length;
      }
      if (failure !== undefined) {
        restore();
        return failureOutcome(label, failure, false, []);
      }
      host.onProvidersChanged();
      return { ok: true, models: count };
    } catch (error) {
      restore();
      return { ok: false, error: error instanceof Error ? error.message : `${label} could not be connected` };
    }
  }

  async function connectCustom(custom: Record<string, unknown>): Promise<ConnectResult> {
    const name = typeof custom["name"] === "string" ? custom["name"].trim() : "";
    const baseUrlRaw = typeof custom["baseUrl"] === "string" ? custom["baseUrl"].trim() : "";
    const apiKey = typeof custom["apiKey"] === "string" && custom["apiKey"].length > 0 ? custom["apiKey"] : undefined;
    if (!CUSTOM_NAME.test(name)) {
      return { ok: false, error: "A provider name is letters, digits, '.', '_' or '-' (up to 64, starting with a letter or digit)." };
    }
    if (RESERVED_NAMES.includes(name) || providerByName(name, dir) !== undefined) {
      return { ok: false, error: `"${name}" is already a provider; choose another name` };
    }
    const baseUrl = httpUrl(baseUrlRaw);
    if (baseUrl === undefined) return { ok: false, error: "The base URL must start with http:// or https://", retry: "base-url" };
    const secrets = [apiKey];
    try {
      saveCustomCompatProvider({ name, label: name, baseUrl, ...(apiKey !== undefined ? { apiKey } : {}), models: [], requiresApiKey: false }, dir);
      const entry = providerByName(name, dir);
      if (entry === undefined) return { ok: false, error: "keryx could not save the provider" };
      const probed = await resolveModelsForPicker(
        fetchImpl,
        { name, models: [], baseUrl },
        credentialEnv(),
        { ...(dir !== undefined ? { configDir: dir } : {}) },
      );
      if (probed.failure !== undefined || probed.models.length === 0) {
        removeCustomCompatProvider(name, dir);
        return failureOutcome(name, probed.failure, false, secrets);
      }
      // The live list becomes the provider's offline fallback, as the TUI wizard's model list does.
      saveCustomCompatProvider(
        { name, label: name, baseUrl, ...(apiKey !== undefined ? { apiKey } : {}), models: probed.models, requiresApiKey: false },
        dir,
      );
      host.onProvidersChanged();
      return { ok: true, models: probed.models.length };
    } catch (error) {
      removeCustomCompatProvider(name, dir);
      return { ok: false, error: redactSecrets(error instanceof Error ? error.message : "the provider could not be connected", secrets) };
    }
  }

  async function handleConnect(params: unknown): Promise<ConnectResult> {
    const method = KERYX_ACP_EXTENSION_METHODS.providersConnect;
    host.requireInitialized(method);
    const obj = requireObjectParams(params, method);
    const custom = obj["custom"];
    if (custom !== undefined) {
      if (typeof custom !== "object" || custom === null || Array.isArray(custom)) refuse(`${method}: custom must be an object`, { field: "custom" });
      return connectCustom(custom as Record<string, unknown>);
    }
    const providerId = requireStringField(obj, "providerId", method);
    const provider = requireProvider(method, providerId);
    const how = requireStringField(obj, "method", method);
    const baseUrl = optionalString(obj, "baseUrl", method);
    if (how === "api-key") {
      const apiKey = optionalString(obj, "apiKey", method) ?? "";
      return connectApiKey(provider, apiKey.trim(), baseUrl);
    }
    if (how === "none") return connectKeyless(provider, baseUrl);
    refuse(`${method}: method must be "api-key" or "none" (device-code providers use ${KERYX_ACP_EXTENSION_METHODS.providersLogin})`, { method: how });
  }

  // ---- device login --------------------------------------------------------

  async function handleLogin(params: unknown): Promise<{ outcome: "connected" | "cancelled" | "failed"; error?: string }> {
    const method = KERYX_ACP_EXTENSION_METHODS.providersLogin;
    host.requireInitialized(method);
    const obj = requireObjectParams(params, method);
    const providerId = requireStringField(obj, "providerId", method);
    requireProvider(method, providerId);
    if ([...logins.values()].some((run) => run.providerId === providerId)) {
      return { outcome: "failed", error: "A login for this provider is already in progress." };
    }
    const loginId = newId();
    const controller = new AbortController();
    logins.set(loginId, { providerId, controller });
    try {
      const result = await loginDeviceCode({
        provider: providerId,
        fetch: host.oauthFetch ?? ((input, init) => globalThis.fetch(input, init)),
        signal: controller.signal,
        ...(host.sleep !== undefined ? { sleep: host.sleep } : {}),
        ...(dir !== undefined ? { dir } : {}),
        onChallenge: (challenge) => {
          host.notify(KERYX_ACP_EXTENSION_METHODS.providersLoginChallenge, {
            loginId,
            providerId,
            userCode: challenge.userCode,
            verificationUri: challenge.verificationUri,
            ...(challenge.verificationUriComplete !== undefined ? { verificationUriComplete: challenge.verificationUriComplete } : {}),
            instructions: challenge.instructions,
          });
        },
      });
      if (controller.signal.aborted) return { outcome: "cancelled" };
      if (!result.ok) return { outcome: "failed", error: result.error };
      applyOAuthAccessToEnv(dir);
      host.onProvidersChanged();
      return { outcome: "connected" };
    } catch (error) {
      if (controller.signal.aborted) return { outcome: "cancelled" };
      return { outcome: "failed", error: error instanceof Error ? error.message : "device authorization failed" };
    } finally {
      logins.delete(loginId);
    }
  }

  async function handleLoginCancel(params: unknown): Promise<Record<string, never>> {
    const method = KERYX_ACP_EXTENSION_METHODS.providersLoginCancel;
    host.requireInitialized(method);
    const obj = requireObjectParams(params, method);
    const loginId = requireStringField(obj, "loginId", method);
    // An unknown id is a login that already ended: cancelling it is a no-op, not an error.
    logins.get(loginId)?.controller.abort();
    return {};
  }

  // ---- search providers ----------------------------------------------------

  const SEARCH_REASONS: Readonly<Record<string, string>> = {
    "missing-credential": "This search provider needs an API key.",
    "invalid-credential": "The search provider rejected the API key.",
    "transport-failed": "The search provider could not be reached.",
    "incompatible-response": "The search provider answered something keryx does not understand.",
    "rate-limited": "The search provider is rate limiting this key; try again later.",
    "insufficient-balance": "The search provider accepted the key but the account has no balance.",
    "not-configurable": "keryx does not know this search provider.",
    "not-configured": "This search provider is not configured yet; connect it first.",
    "not-connected": "This search provider is not connected; connect it first.",
  };
  const searchReason = (reason: string): string => SEARCH_REASONS[reason] ?? "The search provider could not be used.";

  async function handleSearchList(params: unknown): Promise<{ providers: SearchProviderRow[] }> {
    host.requireInitialized(KERYX_ACP_EXTENSION_METHODS.searchProvidersList);
    void params;
    const controller = host.searchController();
    const selectable = new Set<string>(controller.selectable().map((descriptor) => descriptor.id));
    const active = controller.active()?.id;
    return {
      providers: controller.configurable().map((descriptor) => ({
        id: descriptor.id,
        label: descriptor.displayName,
        connected: selectable.has(descriptor.id),
        selected: active === descriptor.id,
        needsKey: descriptor.credentialSchema.required,
      })),
    };
  }

  async function handleSearchConnect(params: unknown): Promise<{ ok: boolean; error?: string }> {
    const method = KERYX_ACP_EXTENSION_METHODS.searchProvidersConnect;
    host.requireInitialized(method);
    const obj = requireObjectParams(params, method);
    const providerId = requireStringField(obj, "providerId", method);
    const apiKey = optionalString(obj, "apiKey", method);
    const controller = host.searchController();
    const descriptor = controller.configurable().find((entry) => entry.id === providerId);
    if (descriptor === undefined) refuse(`${method}: keryx does not know a search provider "${providerId}"`, { providerId });
    const secret = apiKey !== undefined && apiKey.trim().length > 0 ? apiKey.trim() : undefined;
    if (descriptor.credentialSchema.required && secret === undefined) {
      return { ok: false, error: searchReason("missing-credential") };
    }
    const fieldsRaw = obj["fields"];
    const fields: Record<string, string> = {};
    if (typeof fieldsRaw === "object" && fieldsRaw !== null && !Array.isArray(fieldsRaw)) {
      for (const [key, value] of Object.entries(fieldsRaw)) if (typeof value === "string") fields[key] = value;
    }
    try {
      // `/search-provider` makes a connect the active provider; here Select is its own request.
      const result = await controller.connect(descriptor.id, fields, secret, { activate: false });
      return result.ok ? { ok: true } : { ok: false, error: searchReason(result.reason) };
    } catch (error) {
      return { ok: false, error: redactSecrets(error instanceof Error ? error.message : "the search provider could not be connected", [secret]) };
    }
  }

  async function handleSearchSelect(params: unknown): Promise<{ ok: boolean; error?: string }> {
    const method = KERYX_ACP_EXTENSION_METHODS.searchProvidersSelect;
    host.requireInitialized(method);
    const obj = requireObjectParams(params, method);
    const providerId = requireStringField(obj, "providerId", method);
    const controller = host.searchController();
    if (!controller.configurable().some((entry) => entry.id === providerId)) {
      refuse(`${method}: keryx does not know a search provider "${providerId}"`, { providerId });
    }
    const result = await controller.select(providerId as Parameters<SearchProviderController["select"]>[0]);
    return result.ok ? { ok: true } : { ok: false, error: searchReason(result.reason) };
  }

  return {
    requests: {
      [KERYX_ACP_EXTENSION_METHODS.providersList]: handleList,
      [KERYX_ACP_EXTENSION_METHODS.providersTest]: handleTest,
      [KERYX_ACP_EXTENSION_METHODS.providersDisconnect]: handleDisconnect,
      [KERYX_ACP_EXTENSION_METHODS.providersConnect]: handleConnect,
      [KERYX_ACP_EXTENSION_METHODS.providersLogin]: handleLogin,
      [KERYX_ACP_EXTENSION_METHODS.providersLoginCancel]: handleLoginCancel,
      [KERYX_ACP_EXTENSION_METHODS.searchProvidersList]: handleSearchList,
      [KERYX_ACP_EXTENSION_METHODS.searchProvidersConnect]: handleSearchConnect,
      [KERYX_ACP_EXTENSION_METHODS.searchProvidersSelect]: handleSearchSelect,
    },
    close: () => {
      for (const run of logins.values()) run.controller.abort();
    },
  };
}
