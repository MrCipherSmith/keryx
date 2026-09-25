import { ensureOpenAiCodexGrant } from "../lib/oauth/openai-subscription";
import type { ModelsResolveResult, OpenAiCompatProvider } from "./providers";

/** Connection/picker metadata only: this provider uses native Responses, never Chat Completions. */
export const OPENAI_CODEX_PICKER: OpenAiCompatProvider = {
  name: "openai-codex",
  label: "ChatGPT / Codex",
  baseUrl: "https://chatgpt.com/backend-api/codex",
  models: ["gpt-5.3-codex"],
};

// Catalog compatibility version verified against OpenAI Codex rust-v0.157.0.
const CODEX_CATALOG_CLIENT_VERSION = "0.157.0";

export async function fetchOpenAiCodexModels(
  fetchFn: typeof fetch,
  opts: { configDir?: string; timeoutMs?: number } = {},
): Promise<ModelsResolveResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 8_000);
  let authenticated = false;
  try {
    const grant = await ensureOpenAiCodexGrant({ fetch: fetchFn, signal: controller.signal, ...(opts.configDir !== undefined ? { configDir: opts.configDir } : {}) });
    authenticated = true;
    const response = await fetchFn(`${OPENAI_CODEX_PICKER.baseUrl}/models?client_version=${CODEX_CATALOG_CLIENT_VERSION}`, {
      headers: { Authorization: `Bearer ${grant.access}`, "ChatGPT-Account-ID": grant.accountId, originator: "keryx", Accept: "application/json" },
      signal: controller.signal,
      redirect: "error",
    });
    if (!response.ok) {
      return { models: [], source: "fallback", failure: { kind: response.status === 401 || response.status === 403 ? "rejected" : "http", status: response.status } };
    }
    const body: unknown = await response.json();
    const entries = typeof body === "object" && body !== null && "models" in body && Array.isArray(body.models) ? body.models : [];
    const models = [...new Set(entries.flatMap((entry: unknown) => {
      if (typeof entry !== "object" || entry === null || !("slug" in entry) || typeof entry.slug !== "string" || entry.slug.length === 0) return [];
      if (!("visibility" in entry) || entry.visibility !== "list") return [];
      return [entry.slug];
    }))];
    return models.length > 0 ? { models, source: "live" } : { models: [], source: "fallback", failure: { kind: "empty" } };
  } catch {
    return { models: [], source: "fallback", failure: controller.signal.aborted || authenticated
      ? { kind: "unreachable", detail: controller.signal.aborted ? "model listing timed out" : "subscription model listing failed" }
      : { kind: "rejected", status: 401, detail: "Run `keryx auth login openai-codex` to connect your ChatGPT subscription." } };
  } finally {
    clearTimeout(timer);
  }
}
