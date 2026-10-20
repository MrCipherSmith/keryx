// Flow 309 — the live provider catalog module: AC1 (fetch only connected
// providers, in parallel, status classification incl. auth-failed/timeout),
// AC3 (cache freshness), AC4 (the flat-picker mapping, incl. AC8's
// revert-check against the OLD hardcoded source), AC5 (balance never
// guessed). Every fetch here is injected — no real network.
// Tests under the flow 468 banners are titled "flow 468 AC<n>:" so `-t "flow 468 AC1"` selects exactly them, never flow 309's AC labels above.

import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { detectProviders } from "../commands/select";
import { resolveTuiStartup } from "../commands/shell";
import { keryxConfigDir } from "../lib/config-dir";
import { envWithSavedApiKeys, saveApiKey, saveShellConfig } from "../lib/shell-config";
import { isCatalogFresh, loadProviderCatalogCache, saveProviderCatalogCache } from "./provider-catalog-cache";
import {
  catalogToFlatPickerProviders,
  loadOrRefreshProviderCatalog,
  loadOrRefreshProviderCatalogFromDetected,
  loadOrRefreshProviderCatalogLive,
  refreshProviderCatalog,
} from "./provider-catalog";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "keryx-provider-catalog-"));
  roots.push(dir);
  return dir;
}

/**
 * A fresh, empty config dir — every `refreshProviderCatalog`/
 * `loadOrRefreshProviderCatalog` call below MUST pass one. Without it,
 * `providerByName`/`allOpenAiCompatProviders` (`../commands/providers.ts`)
 * fall back to `loadCustomCompatProviders()`'s DEFAULT directory, which is
 * this MACHINE's real `~/.local/share/keryx/llm-providers.json` — an
 * operator's real custom provider (confirmed while writing this file: a
 * "MiniMax" entry) then joins `detected`, gets probed by a `fetchFn` that
 * does not expect it, and either pollutes an assertion or — for a mock that
 * only answers a signal's `abort` event — hangs the test on a call nothing
 * here is driving.
 */
function emptyCustomProvidersDir(): string {
  return tempDir();
}

/** Fail the ollama probe (not-ok) so `detected` never contains it — keeps every test's provider set to exactly what it configures via `env`. */
function ollamaRefused(url: string): boolean {
  return url.includes("/api/tags");
}

test("refreshProviderCatalog (AC1): an unconnected OpenAI-compat provider (no key) is EXCLUDED and NEVER PROBED", async () => {
  const calledUrls: string[] = [];
  const fetchFn = (async (url: string) => {
    calledUrls.push(url);
    if (ollamaRefused(url)) return { ok: false } as Response;
    if (url.includes("deepseek")) {
      return { ok: true, json: async () => ({ data: [{ id: "deepseek-chat" }] }) } as Response;
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;

  const catalog = await refreshProviderCatalog({
    fetch: fetchFn,
    env: { DEEPSEEK_API_KEY: "sk-test" }, // ONLY deepseek is connected
    platform: "linux",
    dir: emptyCustomProvidersDir(),
  });

  expect(catalog.providers.deepseek?.status).toBe("ok");
  // openrouter/groq/zai/etc. require a key none of which is set — never in the catalog, and never fetched.
  expect(catalog.providers.openrouter).toBeUndefined();
  expect(catalog.providers.groq).toBeUndefined();
  expect(calledUrls.some((u) => u.includes("openrouter"))).toBe(false);
  expect(calledUrls.some((u) => u.includes("groq"))).toBe(false);
});

test("refreshProviderCatalog (AC1): a 401 classifies as auth-failed, with an ISO fetchedAt and zero models", async () => {
  const fetchFn = (async (url: string) => {
    if (ollamaRefused(url)) return { ok: false } as Response;
    return { ok: false, status: 401, text: async () => "" } as Response;
  }) as unknown as typeof fetch;

  const catalog = await refreshProviderCatalog({ fetch: fetchFn, env: { DEEPSEEK_API_KEY: "sk-bad" }, platform: "linux", dir: emptyCustomProvidersDir() });
  const entry = catalog.providers.deepseek;
  expect(entry?.status).toBe("auth-failed");
  expect(entry?.models).toEqual([]);
  expect(Number.isFinite(Date.parse(entry!.fetchedAt))).toBe(true);
  // The curated fallback is still carried, for a caller that wants to show it
  // — but AC4's picker mapping (tested below) deliberately does not.
  expect(entry?.fallbackModels.length).toBeGreaterThan(0);
});

// AC2's "hanging fake provider": this fetch never resolves on its own —
// only the internal abort timer settles it — so this is the unit-level proof
// that a genuinely hanging provider does not hang the whole refresh past its
// own bound. `provider-catalog-startup.test.ts` (`src/tui/`) is the
// integration half: `tui-shell.ts` never `await`s this promise inline, so
// even an un-injected real hang could not delay the composer either way.
test("refreshProviderCatalog (AC1/AC2): a hanging fake provider times out rather than hanging the refresh — classified as timeout, distinct from a plain network failure — via an injected fetch, no real 8s wait", async () => {
  const fetchFn = (async (url: string, init?: RequestInit) => {
    // The ollama probe (`select.ts`'s `probeOllamaModels`) calls `deps.fetch`
    // with NO `init`/signal at all — an abort-only mock must still answer it,
    // or `detectProviders()` (and this whole refresh) hangs on THAT call
    // forever rather than exercising the timeout path this test is about.
    if (ollamaRefused(url)) return { ok: false } as Response;
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    });
  }) as unknown as typeof fetch;

  const catalog = await refreshProviderCatalog({
    fetch: fetchFn,
    env: { DEEPSEEK_API_KEY: "sk-test" },
    platform: "linux",
    dir: emptyCustomProvidersDir(),
    // Test seam: the catalog's own 8s bound, shortened so this test is fast
    // while still exercising the SAME abort path production uses.
    timeoutMs: 20,
  });
  expect(catalog.providers.deepseek?.status).toBe("timeout");
});

test("refreshProviderCatalog (AC1): every connected provider is fetched IN PARALLEL, not one after another", async () => {
  // groq/cerebras: neither has a balance endpoint, so each contributes
  // EXACTLY one fetch call — keeps this test's start/release bookkeeping
  // one-to-one per provider instead of per (provider, models|balance) pair.
  const started = new Set<string>();
  const release: Record<string, () => void> = {};
  let resolveBothStarted: () => void = () => {};
  const bothStarted = new Promise<void>((resolve) => {
    resolveBothStarted = resolve;
  });
  const fetchFn = (async (url: string) => {
    if (ollamaRefused(url)) return { ok: false } as Response;
    const name = url.includes("groq") ? "groq" : "cerebras";
    started.add(name);
    if (started.size === 2) resolveBothStarted();
    return new Promise<Response>((resolve) => {
      release[name] = () => resolve({ ok: true, json: async () => ({ data: [{ id: `${name}-m` }] }) } as Response);
    });
  }) as unknown as typeof fetch;

  const catalogPromise = refreshProviderCatalog({
    fetch: fetchFn,
    env: { GROQ_API_KEY: "sk-groq", CEREBRAS_API_KEY: "sk-cerebras" },
    platform: "linux",
    dir: emptyCustomProvidersDir(),
  });
  // Resolves only once BOTH fetches have been DISPATCHED. A sequential
  // implementation (await groq fully, then start cerebras) would never reach
  // this point — cerebras's `fetchFn` call would never run before groq's
  // promise resolves, which it cannot without `release.groq()`, called only
  // below — so a regression to sequential fetching times this test out
  // instead of silently passing.
  await bothStarted;
  release.groq?.();
  release.cerebras?.();
  const catalog = await catalogPromise;
  expect(catalog.providers.groq?.status).toBe("ok");
  expect(catalog.providers.cerebras?.status).toBe("ok");
});

test("refreshProviderCatalog (AC5): a documented balance endpoint is read and never guessed when absent", async () => {
  const fetchFn = (async (url: string) => {
    if (ollamaRefused(url)) return { ok: false } as Response;
    if (url.includes("/user/balance")) {
      return { ok: true, json: async () => ({ is_available: true, balance_infos: [{ currency: "USD", total_balance: "6.19" }] }) } as Response;
    }
    if (url.includes("deepseek")) {
      return { ok: true, json: async () => ({ data: [{ id: "deepseek-chat" }] }) } as Response;
    }
    if (url.includes("groq")) {
      return { ok: true, json: async () => ({ data: [{ id: "llama-3.3-70b-versatile" }] }) } as Response;
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;

  const catalog = await refreshProviderCatalog({
    fetch: fetchFn,
    env: { DEEPSEEK_API_KEY: "sk-test", GROQ_API_KEY: "sk-groq" },
    platform: "linux",
    dir: emptyCustomProvidersDir(),
  });
  expect(catalog.providers.deepseek?.balance).toEqual({ currency: "USD", total: 6.19, exact: true });
  // groq has no documented balance endpoint in the registry — never a guessed number.
  expect(catalog.providers.groq?.balance).toBeUndefined();
});

test("refreshProviderCatalog: a native provider with no live listing endpoint (anthropic) is not-supported, key presence alone gates it", async () => {
  const fetchFn = (async (url: string) => {
    if (ollamaRefused(url)) return { ok: false } as Response;
    throw new Error(`unexpected fetch: ${url}`); // never probed — no endpoint exists
  }) as unknown as typeof fetch;

  const catalog = await refreshProviderCatalog({ fetch: fetchFn, env: { ANTHROPIC_API_KEY: "sk-ant" }, platform: "linux", dir: emptyCustomProvidersDir() });
  const entry = catalog.providers.anthropic;
  expect(entry?.status).toBe("not-supported");
  expect(entry?.models).toEqual([]);
  expect(entry?.fallbackModels.length).toBeGreaterThan(0);
});

test("refreshProviderCatalog: the synthetic fake provider is excluded from the user-facing catalog", async () => {
  const fetchFn = (async (url: string) => {
    if (ollamaRefused(url)) return { ok: false } as Response;
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
  const catalog = await refreshProviderCatalog({ fetch: fetchFn, env: {}, platform: "linux", dir: emptyCustomProvidersDir() });
  expect(catalog.providers.fake).toBeUndefined();
});

// --- catalogToFlatPickerProviders (AC4) -------------------------------------

test("catalogToFlatPickerProviders: ok providers pass their live models through unmarked", () => {
  const flat = catalogToFlatPickerProviders({
    fetchedAt: "now",
    providers: { deepseek: { name: "deepseek", status: "ok", models: ["deepseek-chat"], fallbackModels: ["deepseek-chat"], fetchedAt: "now" } },
  });
  expect(flat).toEqual([{ name: "deepseek", models: ["deepseek-chat"] }]);
});

test("catalogToFlatPickerProviders: auth-failed is EXCLUDED entirely — never pretends curated models are available", () => {
  const flat = catalogToFlatPickerProviders({
    fetchedAt: "now",
    providers: { deepseek: { name: "deepseek", status: "auth-failed", models: [], fallbackModels: ["deepseek-chat"], fetchedAt: "now" } },
  });
  expect(flat).toEqual([]);
});

test("catalogToFlatPickerProviders: unreachable/timeout/not-supported fall back to the curated list, marked offline", () => {
  const flat = catalogToFlatPickerProviders({
    fetchedAt: "now",
    providers: {
      groq: { name: "groq", status: "unreachable", models: [], fallbackModels: ["llama-3.3-70b-versatile"], fetchedAt: "now" },
      anthropic: { name: "anthropic", status: "not-supported", models: [], fallbackModels: ["claude-sonnet-5"], fetchedAt: "now" },
    },
  });
  expect(flat).toEqual([
    { name: "groq", models: ["llama-3.3-70b-versatile"], offline: true },
    { name: "anthropic", models: ["claude-sonnet-5"], offline: true },
  ]);
});

test("catalogToFlatPickerProviders: unreachable with NO curated fallback (e.g. rapid-mlx) contributes nothing", () => {
  const flat = catalogToFlatPickerProviders({
    fetchedAt: "now",
    providers: { "rapid-mlx": { name: "rapid-mlx", status: "unreachable", models: [], fallbackModels: [], fetchedAt: "now" } },
  });
  expect(flat).toEqual([]);
});

// --- AC8 revert-check: this default source must differ from the OLD one ----

test("AC4/AC8 revert-check: the catalog excludes an unconnected compat provider that detectProviders() (the pre-flow-309 source) always included", async () => {
  const fetchFn = (async (url: string) => {
    if (ollamaRefused(url)) return { ok: false } as Response;
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
  const env = {}; // no credential anywhere
  const dir = emptyCustomProvidersDir();

  const oldSource = await detectProviders({ fetch: fetchFn, env, platform: "linux" });
  // The bug this flow fixes: `detectProviders()` offers EVERY OpenAI-compat
  // registry provider unconditionally, key or not.
  expect(oldSource.some((p) => p.name === "openrouter")).toBe(true);
  expect(oldSource.some((p) => p.name === "deepseek")).toBe(true);

  const catalog = await refreshProviderCatalog({ fetch: fetchFn, env, platform: "linux", dir });
  const flat = catalogToFlatPickerProviders(catalog);
  // The new source excludes both — neither has a credential, so neither was
  // probed and neither is "connected". A test on the OLD source alone would
  // have passed with `openrouter`/`deepseek` still offered; this fails
  // against that source, which is the point of a revert-check (AC8).
  expect(flat.some((p) => p.name === "openrouter")).toBe(false);
  expect(flat.some((p) => p.name === "deepseek")).toBe(false);
});

// --- loadOrRefreshProviderCatalog (AC3) -------------------------------------

test("loadOrRefreshProviderCatalog: a FRESH cache is used immediately — no fetch at all", async () => {
  const dir = tempDir();
  await saveProviderCatalogCache(
    { fetchedAt: new Date().toISOString(), providers: { deepseek: { name: "deepseek", status: "ok", models: ["deepseek-chat"], fallbackModels: [], fetchedAt: new Date().toISOString() } } },
    dir,
  );
  let called = false;
  const fetchFn = (async () => {
    called = true;
    throw new Error("should not be called");
  }) as unknown as typeof fetch;

  const catalog = await loadOrRefreshProviderCatalog({ fetch: fetchFn, env: {}, dir, platform: "linux" });
  expect(called).toBe(false);
  expect(catalog.providers.deepseek?.status).toBe("ok");
});

test("loadOrRefreshProviderCatalog: a STALE or missing cache triggers exactly one refresh, which is then saved", async () => {
  const dir = tempDir();
  await saveProviderCatalogCache(
    { fetchedAt: "2020-01-01T00:00:00.000Z", providers: {} }, // ancient — stale under any TTL
    dir,
  );
  const fetchFn = (async (url: string) => {
    if (ollamaRefused(url)) return { ok: false } as Response;
    if (url.includes("deepseek")) return { ok: true, json: async () => ({ data: [{ id: "deepseek-chat" }] }) } as Response;
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;

  const catalog = await loadOrRefreshProviderCatalog({ fetch: fetchFn, env: { DEEPSEEK_API_KEY: "sk-test" }, dir, platform: "linux" });
  expect(catalog.providers.deepseek?.status).toBe("ok");
  // Saved — a subsequent load sees the SAME fresh result without refreshing again.
  const persisted = loadProviderCatalogCache(dir);
  expect(persisted?.providers.deepseek?.status).toBe("ok");
});

test("loadOrRefreshProviderCatalog: --refresh (force: true) bypasses a fresh cache", async () => {
  const dir = tempDir();
  await saveProviderCatalogCache(
    { fetchedAt: new Date().toISOString(), providers: { deepseek: { name: "deepseek", status: "ok", models: ["stale-model"], fallbackModels: [], fetchedAt: new Date().toISOString() } } },
    dir,
  );
  const fetchFn = (async (url: string) => {
    if (ollamaRefused(url)) return { ok: false } as Response;
    return { ok: true, json: async () => ({ data: [{ id: "fresh-model" }] }) } as Response;
  }) as unknown as typeof fetch;

  const catalog = await loadOrRefreshProviderCatalog({ fetch: fetchFn, env: { DEEPSEEK_API_KEY: "sk-test" }, dir, platform: "linux" }, { force: true });
  expect(catalog.providers.deepseek?.models).toEqual(["fresh-model"]);
});

// --- flow 468 AC1: the startup catalog never derives from an empty `detected` ---

/** A fetch that answers the models endpoint of deepseek and groq and refuses the ollama probe and balance lookups. */
function twoProviderFetch(calledUrls: string[] = []): typeof fetch {
  return (async (url: string) => {
    calledUrls.push(url);
    if (ollamaRefused(url) || url.includes("/user/balance")) return { ok: false } as Response;
    if (url.includes("deepseek")) return { ok: true, json: async () => ({ data: [{ id: "deepseek-chat" }] }) } as Response;
    if (url.includes("groq")) return { ok: true, json: async () => ({ data: [{ id: "llama-fake" }] }) } as Response;
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
}

test("flow 468 AC1: a shell that starts with a saved provider+model (startup detected is empty) still saves a catalog holding every provider with a stored key", async () => {
  const dir = tempDir();
  saveShellConfig({ provider: "deepseek", model: "deepseek-chat" }, dir);
  saveApiKey("DEEPSEEK_API_KEY", "sk-fake-deepseek", dir);
  saveApiKey("GROQ_API_KEY", "sk-fake-groq", dir);
  const fetchFn = twoProviderFetch();

  // `resolveTuiStartup` applies the saved keys to `process.env`; undo exactly what it applied.
  const startup = await resolveTuiStartup({
    detect: async () => {
      throw new Error("a saved provider+model must skip detection");
    },
    configDir: dir,
  });
  try {
    // The reproduction: the saved selection makes startup hand over NO detection.
    expect(startup.detected).toEqual([]);

    const env = envWithSavedApiKeys({}, dir);
    // Test seam `redetect` (mirrors `tui-shell.ts`'s `opts.redetect`): the live detection the startup refresh falls back to when `detected` is empty.
    const redetect = () => detectProviders({ fetch: fetchFn, env, configDir: dir, platform: "linux" });
    const catalog = await loadOrRefreshProviderCatalogFromDetected(startup.detected, { fetch: fetchFn, env, dir, platform: "linux", redetect });

    expect(Object.keys(catalog.providers).sort()).toEqual(["deepseek", "groq"]);
    expect(catalog.providers.deepseek?.models).toEqual(["deepseek-chat"]);
    // And what the next reader (`/routing`) loads from disk is that same non-empty catalog, not `{providers: {}}`.
    expect(Object.keys(loadProviderCatalogCache(dir)?.providers ?? {}).sort()).toEqual(["deepseek", "groq"]);
  } finally {
    for (const key of startup.appliedKeys) delete process.env[key];
  }
});

test("flow 468 AC1: a non-empty detected list is used as given — redetect is never called", async () => {
  const dir = tempDir();
  const fetchFn = twoProviderFetch();
  const env = { GROQ_API_KEY: "sk-fake-groq" };
  const detected = await detectProviders({ fetch: fetchFn, env, configDir: dir, platform: "linux" });
  expect(detected.length).toBeGreaterThan(0);
  let redetections = 0;
  const redetect = async () => {
    redetections += 1;
    return [];
  };

  const catalog = await loadOrRefreshProviderCatalogFromDetected(detected, { fetch: fetchFn, env, dir, platform: "linux", redetect });

  expect(redetections).toBe(0);
  expect(catalog.providers.groq?.status).toBe("ok");
});

test("flow 468 AC1: loadOrRefreshProviderCatalogLive detects live once on an empty cache, saves the result, and does not detect again on the next read", async () => {
  const dir = tempDir();
  const fetchFn = twoProviderFetch();
  const env = { DEEPSEEK_API_KEY: "sk-fake-deepseek" };
  let detections = 0;
  const redetect = async () => {
    detections += 1;
    return detectProviders({ fetch: fetchFn, env, configDir: dir, platform: "linux" });
  };

  const first = await loadOrRefreshProviderCatalogLive({ fetch: fetchFn, env, dir, platform: "linux", redetect });
  const second = await loadOrRefreshProviderCatalogLive({ fetch: fetchFn, env, dir, platform: "linux", redetect });

  expect(first.providers.deepseek?.models).toEqual(["deepseek-chat"]);
  expect(second.providers.deepseek?.models).toEqual(["deepseek-chat"]);
  expect(detections).toBe(1);
});

test("flow 468 AC1: loadOrRefreshProviderCatalogLive does not detect twice when the live detection finds nothing", async () => {
  const dir = tempDir();
  let detections = 0;

  const catalog = await loadOrRefreshProviderCatalogLive({
    fetch: twoProviderFetch(),
    env: {},
    dir,
    platform: "linux",
    redetect: async () => {
      detections += 1;
      return [];
    },
  });

  expect(Object.keys(catalog.providers)).toEqual([]);
  expect(detections).toBe(1);
});

// --- flow 468 AC2: an empty catalog is never served or saved as fresh -------

function writeCacheFile(dir: string, body: unknown): void {
  // Written by hand, not through `saveProviderCatalogCache`: this is the poisoned file an older build left on disk.
  const configDir = keryxConfigDir(dir);
  mkdirSync(configDir, { recursive: true });
  writeFileSync(path.join(configDir, "provider-catalog.json"), `${JSON.stringify(body)}\n`, "utf8");
}

test("flow 468 AC2: a fresh-by-age cache file with zero providers is not served — loadOrRefreshProviderCatalog refreshes instead", async () => {
  const dir = tempDir();
  writeCacheFile(dir, { fetchedAt: new Date().toISOString(), providers: {} });
  const calledUrls: string[] = [];

  const catalog = await loadOrRefreshProviderCatalog({
    fetch: twoProviderFetch(calledUrls),
    env: { DEEPSEEK_API_KEY: "sk-fake-deepseek" },
    dir,
    platform: "linux",
  });

  expect(calledUrls.length).toBeGreaterThan(0);
  expect(catalog.providers.deepseek?.status).toBe("ok");
});

test("flow 468 AC2: a fresh-by-age cache file with zero providers is not served — loadOrRefreshProviderCatalogFromDetected refreshes instead", async () => {
  const dir = tempDir();
  writeCacheFile(dir, { fetchedAt: new Date().toISOString(), providers: {} });
  const calledUrls: string[] = [];
  const fetchFn = twoProviderFetch(calledUrls);
  const env = { GROQ_API_KEY: "sk-fake-groq" };
  const detected = await detectProviders({ fetch: fetchFn, env, configDir: dir, platform: "linux" });

  const catalog = await loadOrRefreshProviderCatalogFromDetected(detected, { fetch: fetchFn, env, dir, platform: "linux" });

  expect(catalog.providers.groq?.status).toBe("ok");
});

test("flow 468 AC2: a refresh that yields zero providers is not saved as fresh (loadOrRefreshProviderCatalog)", async () => {
  const dir = tempDir();

  const catalog = await loadOrRefreshProviderCatalog({ fetch: twoProviderFetch(), env: {}, dir, platform: "linux" });

  expect(Object.keys(catalog.providers)).toEqual([]);
  // Absent or stale are both fine; what must not exist is an empty cache that a reader treats as fresh for the next TTL.
  expect(isCatalogFresh(loadProviderCatalogCache(dir))).toBe(false);
});

test("flow 468 AC2: a refresh that yields zero providers is not saved as fresh (loadOrRefreshProviderCatalogFromDetected)", async () => {
  const dir = tempDir();
  const fetchFn = twoProviderFetch();
  const detected = await detectProviders({ fetch: fetchFn, env: {}, configDir: dir, platform: "linux" });

  const catalog = await loadOrRefreshProviderCatalogFromDetected(detected, { fetch: fetchFn, env: {}, dir, platform: "linux" });

  expect(Object.keys(catalog.providers)).toEqual([]);
  expect(isCatalogFresh(loadProviderCatalogCache(dir))).toBe(false);
});

test("flow 468 AC2: a forced refresh that yields zero providers drops the older non-empty cache file (loadOrRefreshProviderCatalog)", async () => {
  const dir = tempDir();
  const now = new Date().toISOString();
  await saveProviderCatalogCache(
    { fetchedAt: now, providers: { deepseek: { name: "deepseek", status: "ok", models: ["stale-model"], fallbackModels: [], fetchedAt: now } } },
    dir,
  );
  expect(loadProviderCatalogCache(dir)?.providers.deepseek).toBeDefined();

  const catalog = await loadOrRefreshProviderCatalog({ fetch: twoProviderFetch(), env: {}, dir, platform: "linux" }, { force: true });

  expect(Object.keys(catalog.providers)).toEqual([]);
  // Not served on the next read: the file is gone, so the next reader detects again.
  expect(loadProviderCatalogCache(dir)).toBeUndefined();
});

test("flow 468 AC2: a forced refresh that yields zero providers drops the older non-empty cache file (loadOrRefreshProviderCatalogFromDetected)", async () => {
  const dir = tempDir();
  const now = new Date().toISOString();
  await saveProviderCatalogCache(
    { fetchedAt: now, providers: { deepseek: { name: "deepseek", status: "ok", models: ["stale-model"], fallbackModels: [], fetchedAt: now } } },
    dir,
  );

  const catalog = await loadOrRefreshProviderCatalogFromDetected([], { fetch: twoProviderFetch(), env: {}, dir, platform: "linux" }, { force: true });

  expect(Object.keys(catalog.providers)).toEqual([]);
  expect(loadProviderCatalogCache(dir)).toBeUndefined();
});

// --- flow 468 AC4: the catalog as the Model tab's provider rows --------------

test("flow 468 AC4: withStatusRows returns an auth-failed provider as a display-only row; the default still excludes it", () => {
  const catalog = {
    fetchedAt: "now",
    providers: { deepseek: { name: "deepseek", status: "auth-failed" as const, models: [], fallbackModels: ["deepseek-chat"], fetchedAt: "now" } },
  };
  expect(catalogToFlatPickerProviders(catalog, { withStatusRows: true })).toEqual([{ name: "deepseek", models: [], authFailed: true }]);
  expect(catalogToFlatPickerProviders(catalog)).toEqual([]);
});

test("flow 468 AC4: withStatusRows keeps an unreachable, timed-out or unsupported provider with no curated list, with its reason", () => {
  const catalog = {
    fetchedAt: "now",
    providers: {
      "rapid-mlx": { name: "rapid-mlx", status: "unreachable" as const, models: [], fallbackModels: [], fetchedAt: "now" },
      slow: { name: "slow", status: "timeout" as const, models: [], fallbackModels: [], fetchedAt: "now" },
      custom: { name: "custom", status: "not-supported" as const, models: [], fallbackModels: [], fetchedAt: "now" },
      groq: { name: "groq", status: "unreachable" as const, models: [], fallbackModels: ["llama-fake"], fetchedAt: "now" },
    },
  };
  expect(catalogToFlatPickerProviders(catalog, { withStatusRows: true })).toEqual([
    { name: "rapid-mlx", models: [], listUnavailable: "unreachable" },
    { name: "slow", models: [], listUnavailable: "timed out" },
    { name: "custom", models: [], listUnavailable: "no live listing" },
    // A curated fallback list still wins: shown as the offline list, not as a status row.
    { name: "groq", models: ["llama-fake"], offline: true },
  ]);
  // Without the opt-in the old behaviour holds: nothing to show, nothing returned.
  expect(catalogToFlatPickerProviders(catalog)).toEqual([{ name: "groq", models: ["llama-fake"], offline: true }]);
});
