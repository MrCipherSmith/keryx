// File-backed custom LLM provider registry (operator-defined; persisted by the
// in-TUI "add custom provider" wizard). Mirrors search-config.ts: best-effort,
// never throws, owner-only 0600 file in the keryx config dir.
//
// Custom providers are an EXPLICIT OPERATOR TRUST BOUNDARY: a URL the operator
// typed into their own config file is operator intent, so the egress gate
// re-permits RFC1918 private-LAN + loopback for them (see
// `customCompatProviders` in src/commands/providers.ts). Built-in providers
// stay denied on both.
import { existsSync } from "node:fs";
import path from "node:path";
import { ensureKeryxConfigDir, keryxConfigDir, readConfigFile, writeOwnerOnlyFile } from "./config-dir";

/** One operator-defined OpenAI-compatible provider, as persisted on disk. */
export interface CustomCompatProvider {
  /** Unique id used as the provider name (e.g. `internal-qwen`). */
  name: string;
  /** Human label shown in the picker; defaults to `name`. */
  label?: string;
  /** API base URL (before the chat/models path). */
  baseUrl: string;
  /** Optional bearer credential, stored in the same 0600 file. */
  apiKey?: string;
  /** False for keyless endpoints; defaults to true. */
  requiresApiKey?: boolean;
  /** Chat path appended to `baseUrl`; defaults to `/v1/chat/completions`. */
  chatPath?: string;
  /** Model-list path appended to `baseUrl`; defaults to `/v1/models`. */
  modelsPath?: string;
  /** Curated model ids (used when the live `/models` fetch fails). */
  models: string[];
  /** Short picker note. */
  note?: string;
}

interface LlmProvidersConfig {
  schemaVersion: 1;
  providers?: Record<string, CustomCompatProvider>;
}

/** Absolute path to the custom-provider registry file. */
export function llmProvidersConfigPath(dir?: string): string {
  return path.join(keryxConfigDir(dir), "llm-providers.json");
}

function readJson(file: string): unknown | undefined {
  try {
    if (!existsSync(file)) return undefined;
    const read = readConfigFile(file);
    return read.ok ? JSON.parse(read.text) : undefined;
  } catch {
    return undefined;
  }
}

/** Loose runtime shape guard for hand-edited files (never throws). */
export function isCustomCompatProvider(value: unknown): value is CustomCompatProvider {
  if (value === null || typeof value !== "object") return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p.name === "string" &&
    p.name.length > 0 &&
    typeof p.baseUrl === "string" &&
    p.baseUrl.length > 0 &&
    Array.isArray(p.models) &&
    p.models.every((m) => typeof m === "string")
  );
}

/**
 * Load every operator-defined custom provider. Returns `[]` for an absent,
 * malformed, or wrong-schema file — never throws, never surfaces an error.
 */
export function loadCustomCompatProviders(dir?: string): CustomCompatProvider[] {
  const value = readJson(llmProvidersConfigPath(dir));
  if (value === null || typeof value !== "object") return [];
  const record = value as Partial<LlmProvidersConfig>;
  if (record.schemaVersion !== 1 || record.providers === undefined || typeof record.providers !== "object") {
    return [];
  }
  return Object.values(record.providers)
    .filter(isCustomCompatProvider)
    .map((p) => ({
      ...p,
      name: p.name.trim(),
      baseUrl: p.baseUrl.replace(/\/+$/, ""),
      ...(typeof p.apiKey === "string" && p.apiKey.length > 0 ? { apiKey: p.apiKey } : {}),
    }));
}

/** Merge `provider` into the persisted registry (0600). Best-effort; never throws. */
export function saveCustomCompatProvider(provider: CustomCompatProvider, dir?: string): void {
  try {
    ensureKeryxConfigDir(dir);
    const current = loadCustomCompatProviders(dir).reduce<Record<string, CustomCompatProvider>>((acc, p) => {
      acc[p.name] = p;
      return acc;
    }, {});
    current[provider.name] = provider;
    writeOwnerOnlyFile(
      llmProvidersConfigPath(dir),
      `${JSON.stringify({ schemaVersion: 1, providers: current }, null, 2)}\n`,
    );
  } catch {
    // best-effort persistence — a failure just means the provider is re-entered
  }
}
