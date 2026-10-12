import { ensureOpenAiCodexGrant } from "../lib/oauth/openai-subscription";
import { resolveCodexCatalogVersion } from "../lib/oauth/codex-catalog-version";
import type { ModelsResolveResult, OpenAiCompatProvider } from "./providers";

/** Connection/picker metadata only: this provider uses native Responses, never Chat Completions. */
export const OPENAI_CODEX_PICKER: OpenAiCompatProvider = {
  name: "openai-codex",
  label: "ChatGPT / Codex",
  baseUrl: "https://chatgpt.com/backend-api/codex",
  models: ["gpt-5.3-codex"],
};

/**
 * The `/models` probe plus the per-slug context windows the same response
 * carries (flow 387 T6). `contextWindows` only holds slugs whose entry reported
 * `context_window` (else `max_context_window`) as a positive integer — the same
 * fields codex-rs reads into `ModelInfo.context_window`. Never defaulted.
 */
export interface OpenAiCodexCatalog extends ModelsResolveResult {
  contextWindows: Record<string, number>;
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

export async function fetchOpenAiCodexModels(
  fetchFn: typeof fetch,
  opts: { configDir?: string; timeoutMs?: number; refreshCatalogVersion?: boolean } = {},
): Promise<ModelsResolveResult> {
  // Window map is for loadSessionLimits only; picker/catalog/tui keep the old shape.
  const { contextWindows: _windows, ...result } = await fetchOpenAiCodexCatalog(fetchFn, opts);
  return result;
}

export async function fetchOpenAiCodexCatalog(
  fetchFn: typeof fetch,
  opts: { configDir?: string; timeoutMs?: number; refreshCatalogVersion?: boolean } = {},
): Promise<OpenAiCodexCatalog> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 8_000);
  let authenticated = false;
  try {
    const grant = await ensureOpenAiCodexGrant({ fetch: fetchFn, signal: controller.signal, ...(opts.configDir !== undefined ? { configDir: opts.configDir } : {}) });
    authenticated = true;
    const clientVersion = await resolveCodexCatalogVersion(fetchFn, { signal: controller.signal,
      ...(opts.refreshCatalogVersion !== undefined ? { forceRefresh: opts.refreshCatalogVersion } : {}),
      ...(opts.configDir !== undefined ? { configDir: opts.configDir } : {}) });
    if (clientVersion === undefined) return { models: [], source: "fallback", contextWindows: {}, failure: {
      kind: "unreachable", detail: "could not discover the Codex catalog version from npm; no cached version is available",
    } };
    const response = await fetchFn(`${OPENAI_CODEX_PICKER.baseUrl}/models?client_version=${clientVersion}`, {
      headers: { Authorization: `Bearer ${grant.access}`, "ChatGPT-Account-ID": grant.accountId, originator: "keryx", Accept: "application/json" },
      signal: controller.signal,
      redirect: "error",
    });
    if (!response.ok) {
      return { models: [], source: "fallback", contextWindows: {}, failure: { kind: response.status === 401 || response.status === 403 ? "rejected" : "http", status: response.status } };
    }
    const body: unknown = await response.json();
    const entries = typeof body === "object" && body !== null && "models" in body && Array.isArray(body.models) ? body.models : [];
    const models = [...new Set(entries.flatMap((entry: unknown) => {
      if (typeof entry !== "object" || entry === null || !("slug" in entry) || typeof entry.slug !== "string" || entry.slug.length === 0) return [];
      if (!("visibility" in entry) || entry.visibility !== "list") return [];
      return [entry.slug];
    }))];
    const contextWindows: Record<string, number> = {};
    for (const entry of entries) {
      if (typeof entry !== "object" || entry === null || !("slug" in entry) || typeof entry.slug !== "string" || entry.slug.length === 0) continue;
      const rec = entry as Record<string, unknown>;
      const window = positiveInt(rec.context_window) ?? positiveInt(rec.max_context_window);
      if (window !== undefined) contextWindows[entry.slug] = window;
    }
    return models.length > 0 ? { models, source: "live", contextWindows } : { models: [], source: "fallback", contextWindows, failure: { kind: "empty" } };
  } catch {
    return { models: [], source: "fallback", contextWindows: {}, failure: controller.signal.aborted || authenticated
      ? { kind: "unreachable", detail: controller.signal.aborted ? "model listing timed out" : "subscription model listing failed" }
      : { kind: "rejected", status: 401, detail: "Run `keryx auth login openai-codex` to connect your ChatGPT subscription." } };
  } finally {
    clearTimeout(timer);
  }
}
