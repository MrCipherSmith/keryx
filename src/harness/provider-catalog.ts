// Flow 309 — the live provider catalog: fetches each CONNECTED provider's
// real model list (and balance, where one exists) during startup loading,
// which doubles as the availability check the operator asked for. Replaces
// `detectProviders()`'s curated/static lists as the source every PICKER over
// "connected providers" should read (root cause: `src/tui/routing-inspector.
// ts`'s `defaultProviders` and `src/commands/routing.ts`'s twin used to hand
// `detectProviders()`'s result straight to the picker/CLI list — curated
// model ids, and EVERY OpenAI-compat provider offered whether or not it had a
// credential, because `detectProviders()`'s job (flow 022/085/183) is "what
// could the operator pick from", not "what is actually reachable right now").
//
// Reuses, never duplicates:
//   - `detectProviders()` (`./commands/select.ts`) for WHO is even a
//     candidate — the ollama live probe and the anthropic/openai/gemini
//     key-gate stay exactly as they are; this module only adds the missing
//     half, verifying + fetching the OpenAI-compat registry providers
//     `detectProviders()` offers unconditionally.
//   - `fetchOpenAiCompatModelsDetailed`/`fetchProviderBalance`
//     (`../commands/providers.ts`) — the SAME live `/models` and balance
//     fetch `/model`'s picker and `providers test` (flow 304) already use.
//
// Client zone (no TUI import — testable and usable without a renderer),
// mirroring `./routing/table.ts`'s own "no TUI deps" posture.

import { loadOAuthGrant } from "../lib/oauth/grants";
import { envWithSavedApiKeys } from "../lib/shell-config";
import { fetchOpenAiCodexModels } from "../commands/subscription-models";
import { detectProviders, type DetectedProvider, type DetectProvidersDeps } from "../commands/select";
import {
  balanceCapableProvider,
  fetchOpenAiCompatModelsDetailed,
  fetchProviderBalance,
  providerApiKey,
  providerByName,
  type OpenAiCompatProvider,
} from "../commands/providers";
import {
  classifyModelsStatus,
  clearProviderCatalogCache,
  isCatalogFresh,
  loadProviderCatalogCache,
  saveProviderCatalogCache,
  type ProviderCatalog,
  type ProviderCatalogEntry,
} from "./provider-catalog-cache";
import type { FlatPickerProvider } from "./routing/table";

export {
  CATALOG_CACHE_TTL_MS,
  classifyModelsStatus,
  formatCatalogAge,
  isCatalogFresh,
  loadProviderCatalogCache,
  saveProviderCatalogCache,
  updateProviderCatalogEntry,
  type ProviderCatalog,
  type ProviderCatalogEntry,
  type ProviderCatalogStatus,
} from "./provider-catalog-cache";

/** AC1: each fetch bounded by a timeout of at most 8s. Deliberately its OWN constant, separate from `MODELS_FETCH_TIMEOUT_MS`/`BALANCE_FETCH_TIMEOUT_MS` (both 8-10s already) — this module's timeout is a stated acceptance criterion, not borrowed from a shared default that another caller could change out from under it. */
export const CATALOG_FETCH_TIMEOUT_MS = 8_000;

export interface ProviderCatalogDeps {
  readonly fetch: typeof fetch;
  readonly env: Record<string, string | undefined>;
  /** Config dir scoping the custom-provider registry lookup. Default: the real one. */
  readonly dir?: string;
  readonly now?: () => number;
  /** Test seam mirroring `DetectProvidersDeps.platform`. */
  readonly platform?: string;
  /** Test seam mirroring `DetectProvidersDeps.baseUrl` (the ollama probe). */
  readonly baseUrl?: string;
  /** Test seam: overrides {@link CATALOG_FETCH_TIMEOUT_MS} so a timeout path can be exercised without a real 8s wait. Production never sets this. */
  readonly timeoutMs?: number;
  /** Live provider detection used when a caller hands over an EMPTY `detected` list (flow 468: a saved provider+model skips startup detection). Mirrors `tui-shell.ts`'s `opts.redetect`, the path `/model` uses. */
  readonly redetect?: () => Promise<readonly DetectedProvider[]>;
}

async function buildCatalogEntry(
  detected: DetectedProvider,
  deps: ProviderCatalogDeps,
  fetchedAt: string,
): Promise<ProviderCatalogEntry | undefined> {
  if (detected.name === "fake") {
    // The synthetic offline test double is never part of the USER-FACING
    // catalog (flow 309 review): it has no real status/balance to report and
    // showing it in `providers status`/`/connect`/the flat `/routing` picker
    // (all readers of `catalog.providers`) would present a test fixture
    // alongside real providers. Dropping the entry here — rather than
    // filtering it out at each of those call sites — is the single point of
    // exclusion; every reader of `catalog.providers` inherits it for free.
    // `fake` stays selectable everywhere else (e.g. the per-provider
    // `/model` picker, `keryx shell --provider fake`), which never reads
    // this catalog and is unaffected.
    return undefined;
  }
  if (detected.name === "ollama") {
    // `detectProviders()` already ran ITS live probe (`GET {baseUrl}/api/tags`)
    // to decide ollama belongs in `detected` at all — that probe IS this
    // provider's availability check; re-probing here would be the exact
    // duplication AC1 asks this module to avoid.
    return {
      name: detected.name,
      status: "ok",
      models: [...detected.models],
      fallbackModels: [],
      fetchedAt,
      ...(detected.label !== undefined ? { label: detected.label } : {}),
    };
  }
  if (detected.name === "openai-codex") {
    if (loadOAuthGrant("openai-codex", deps.dir) === undefined) return undefined;
    const result = await fetchOpenAiCodexModels(deps.fetch, { ...(deps.dir !== undefined ? { configDir: deps.dir } : {}), timeoutMs: deps.timeoutMs ?? CATALOG_FETCH_TIMEOUT_MS });
    return { name: detected.name, status: classifyModelsStatus(result), models: result.models, fallbackModels: [...detected.models], fetchedAt, label: detected.label ?? "ChatGPT / Codex" };
  }
  const registry = providerByName(detected.name, deps.dir);
  if (registry === undefined) {
    // Native anthropic/gemini: `detectProviders()` includes one only
    // when its API key is present in `deps.env` (the connectedness check for
    // a provider with no live listing endpoint — `describe().modelListing`
    // is false for these providers, see `select.ts`), so `detected.models` here IS
    // the curated fallback a caller should show.
    return {
      name: detected.name,
      status: "not-supported",
      models: [],
      fallbackModels: [...detected.models],
      fetchedAt,
      ...(detected.label !== undefined ? { label: detected.label } : {}),
    };
  }
  // An OpenAI-compat registry provider — `detectProviders()` offers EVERY one
  // of these unconditionally (flow 309's root cause). Independently verify a
  // credential resolves the SAME way `configuredProviders()` does, so an
  // unconnected provider is excluded here and NEVER PROBED (AC1) rather than
  // inheriting `detected`'s "offer everything" posture.
  const requiresApiKey = registry.requiresApiKey ?? true;
  const apiKey = providerApiKey(registry, envWithSavedApiKeys(deps.env, deps.dir)) ?? registry.apiKey;
  if (requiresApiKey && (apiKey === undefined || apiKey.length === 0)) {
    return undefined;
  }
  const withBase: OpenAiCompatProvider = {
    ...registry,
    ...(detected.baseUrl !== undefined ? { baseUrl: detected.baseUrl } : {}),
    ...(detected.chatPath !== undefined ? { chatPath: detected.chatPath } : {}),
    ...(detected.modelsPath !== undefined ? { modelsPath: detected.modelsPath } : {}),
  };
  const capableOfBalance = balanceCapableProvider(detected.name) !== undefined;
  const timeoutMs = deps.timeoutMs ?? CATALOG_FETCH_TIMEOUT_MS;
  const [result, balance] = await Promise.all([
    // Flow 327 (AC16) — refresh the model-profile store from this SAME live
    // fetch (opt-in `refreshProfiles`, `../commands/providers.ts`): no second
    // request. Runs at shell startup and every `providers status --refresh`,
    // so profiles stay current without an explicit `/connect` Test.
    fetchOpenAiCompatModelsDetailed(deps.fetch, withBase, apiKey, {
      timeoutMs,
      refreshProfiles: {
        ...(deps.dir !== undefined ? { dir: deps.dir } : {}),
        ...(deps.now !== undefined ? { now: deps.now } : {}),
      },
    }),
    capableOfBalance
      ? fetchProviderBalance(deps.fetch, withBase, apiKey, { timeoutMs })
      : Promise.resolve(undefined),
  ]);
  const status = classifyModelsStatus(result);
  return {
    name: detected.name,
    status,
    models: status === "ok" ? result.models : [],
    fallbackModels: [...registry.models],
    fetchedAt,
    ...(registry.label !== undefined ? { label: registry.label } : {}),
    ...(balance !== undefined ? { balance } : {}),
  };
}

/**
 * Fetch every connected provider's live model list (and balance, where one
 * exists) in parallel. Never throws — a single provider's fetch failing
 * yields that provider's status, not a rejection of the whole catalog.
 */
export async function refreshProviderCatalog(deps: ProviderCatalogDeps): Promise<ProviderCatalog> {
  const detectDeps: DetectProvidersDeps = {
    fetch: deps.fetch,
    env: deps.env,
    ...(deps.dir !== undefined ? { configDir: deps.dir } : {}),
    ...(deps.baseUrl !== undefined ? { baseUrl: deps.baseUrl } : {}),
    ...(deps.platform !== undefined ? { platform: deps.platform } : {}),
  };
  const detected = await detectProviders(detectDeps);
  return refreshProviderCatalogFromDetected(detected, deps);
}

/**
 * Same as {@link refreshProviderCatalog}, given an ALREADY-detected provider
 * list rather than running `detectProviders()` itself.
 *
 * Two callers need this split:
 *   - `keryx shell`'s TUI startup (`tui-shell.ts`) already ran
 *     `detectProviders()` once, at provider-selection time, before the
 *     catalog refresh even starts — a second call would re-run the SAME
 *     ollama `/api/tags` probe for no reason, and its `detected` is the one
 *     surface a TUI test already controls (`launchTuiAgentShell(opts)`'s
 *     `opts.detected`), so routing the catalog refresh through it keeps this
 *     module's SOLE network surface test-injectable there too, rather than
 *     opening a second, independent path to `globalThis.fetch` a test cannot
 *     see or bound. The exception is a startup that SKIPPED detection (a saved
 *     provider+model): it hands over `[]`, and `deps.redetect` then runs the
 *     one live detection (see {@link detectedOrRedetected}); a non-empty
 *     list is never re-detected.
 *   - Any caller that already has a `detected` list for another reason.
 */
export async function refreshProviderCatalogFromDetected(
  detected: readonly DetectedProvider[],
  deps: ProviderCatalogDeps,
): Promise<ProviderCatalog> {
  const now = deps.now ?? Date.now;
  const fetchedAt = new Date(now()).toISOString();
  const list = await detectedOrRedetected(detected, deps);
  const entries = await Promise.all(list.map((d) => buildCatalogEntry(d, deps, fetchedAt)));
  const providers: Record<string, ProviderCatalogEntry> = {};
  for (const entry of entries) {
    if (entry !== undefined) providers[entry.name] = entry;
  }
  return { fetchedAt, providers };
}

/**
 * An empty `detected` is "startup skipped detection" (flow 468: a saved
 * provider+model), not "nothing is connected": with `deps.redetect` the live
 * detection replaces it, otherwise it is used as given. A non-empty list is
 * always used as is.
 */
async function detectedOrRedetected(detected: readonly DetectedProvider[], deps: ProviderCatalogDeps): Promise<readonly DetectedProvider[]> {
  return detected.length === 0 && deps.redetect !== undefined ? deps.redetect() : detected;
}

/**
 * The cache-or-refresh policy shared by every `loadOrRefresh*` entry point:
 * serve a fresh non-empty cache unless `force`, otherwise run `refresh` and
 * save a non-empty result. A refresh that found nothing is never saved, and
 * it also drops an older non-empty file, so the next reader detects again
 * instead of being served a catalog the operator has since emptied (flow 468).
 */
async function loadOrRefreshWith(
  deps: ProviderCatalogDeps,
  opts: { force?: boolean; ttlMs?: number },
  refresh: () => Promise<ProviderCatalog>,
): Promise<ProviderCatalog> {
  if (opts.force !== true) {
    const cached = loadProviderCatalogCache(deps.dir);
    if (isServableCatalog(cached, deps.now ?? Date.now, opts.ttlMs)) {
      return cached as ProviderCatalog;
    }
  }
  const fresh = await refresh();
  if (hasProviders(fresh)) await saveProviderCatalogCache(fresh, deps.dir);
  else await clearProviderCatalogCache(deps.dir);
  return fresh;
}

/**
 * AC3: a fresh cache is used immediately; a stale or missing one triggers a
 * refresh (which is then saved, becoming the next reader's fresh cache).
 * `force: true` bypasses the TTL (`keryx providers status --refresh`).
 */
export async function loadOrRefreshProviderCatalog(
  deps: ProviderCatalogDeps,
  opts: { force?: boolean; ttlMs?: number } = {},
): Promise<ProviderCatalog> {
  return loadOrRefreshWith(deps, opts, () => refreshProviderCatalog(deps));
}

function hasProviders(catalog: ProviderCatalog | undefined): boolean {
  return catalog !== undefined && Object.keys(catalog.providers).length > 0;
}

/** Fresh by age AND non-empty: a zero-provider catalog is never served as fresh (flow 468). `isCatalogFresh` stays age-only. */
function isServableCatalog(catalog: ProviderCatalog | undefined, now: () => number, ttlMs?: number): boolean {
  return hasProviders(catalog) && isCatalogFresh(catalog, now, ttlMs);
}

/** Same as {@link loadOrRefreshProviderCatalog}, given an already-detected provider list — see {@link refreshProviderCatalogFromDetected}. */
export async function loadOrRefreshProviderCatalogFromDetected(
  detected: readonly DetectedProvider[],
  deps: ProviderCatalogDeps,
  opts: { force?: boolean; ttlMs?: number } = {},
): Promise<ProviderCatalog> {
  return loadOrRefreshWith(deps, opts, () => refreshProviderCatalogFromDetected(detected, deps));
}

/**
 * Cache-or-refresh for a caller with no detection of its own (`/routing`'s
 * loader, flow 468): a fresh non-empty cache is served; otherwise `redetect`
 * (the live detection `/model` uses) supplies the providers, once. Its result
 * is final, so the refresh runs without `redetect` and an empty detection is
 * not detected a second time.
 */
export async function loadOrRefreshProviderCatalogLive(
  deps: ProviderCatalogDeps & { readonly redetect: () => Promise<readonly DetectedProvider[]> },
  opts: { force?: boolean; ttlMs?: number } = {},
): Promise<ProviderCatalog> {
  const { redetect, ...rest } = deps;
  return loadOrRefreshWith(rest, opts, async () => refreshProviderCatalogFromDetected(await redetect(), rest));
}

/**
 * AC4: the catalog as the flat picker's provider list — ONLY connected
 * providers, live model ids when the fetch succeeded, the curated list
 * clearly marked `offline: true` (rendered "(offline list)" by
 * `flatModelOptions`) when the fetch failed or the provider has no live
 * endpoint. A provider with no list to show is excluded by default (an
 * `auth-failed` one rather than shown with models that are not actually
 * available). With `withStatusRows` (flow 468, `/routing`'s Model tab) it is
 * returned instead as a display-only row with no models: `authFailed: true`
 * for an `auth-failed` provider, `listUnavailable: <reason>` for an
 * unreachable, timed-out or unsupported one with no curated fallback list.
 * Such a row is never selectable.
 */
export function catalogToFlatPickerProviders(catalog: ProviderCatalog, opts: { withStatusRows?: boolean } = {}): FlatPickerProvider[] {
  const out: FlatPickerProvider[] = [];
  for (const entry of Object.values(catalog.providers)) {
    if (entry.status === "ok") {
      out.push({ name: entry.name, models: entry.models });
      continue;
    }
    if (entry.status === "auth-failed") {
      if (opts.withStatusRows === true) out.push({ name: entry.name, models: [], authFailed: true });
      continue;
    }
    // unreachable | timeout | not-supported
    if (entry.fallbackModels.length > 0) {
      out.push({ name: entry.name, models: entry.fallbackModels, offline: true });
    } else if (opts.withStatusRows === true) {
      out.push({ name: entry.name, models: [], listUnavailable: describeCatalogStatus(entry.status) });
    }
  }
  return out;
}

/** One short phrase for a catalog status, for a notice/status line. */
export function describeCatalogStatus(status: ProviderCatalogEntry["status"]): string {
  switch (status) {
    case "ok":
      return "ok";
    case "auth-failed":
      return "auth failed";
    case "unreachable":
      return "unreachable";
    case "timeout":
      return "timed out";
    case "not-supported":
      return "no live listing";
  }
}
