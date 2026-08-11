// Persisted interactive-shell config (flow 080), modelled on opencode's
// `~/.local/share/opencode/auth.json`: the last-used provider/model and an
// optional OpenRouter API key, so the user does not re-enter them every launch.
//
// Stored at `~/.local/share/keryx/auth.json` with mode 0600 (owner-only). The key
// is a plaintext secret on disk — the same tradeoff opencode makes; it is written
// owner-only, never logged, and only read to populate the process env at startup.
// All functions are best-effort and never throw; the `dir` override keeps them
// unit-testable against a temp directory.
import { existsSync } from "node:fs";
import path from "node:path";
import { ensureKeryxConfigDir, keryxConfigDir, readConfigFile, writeOwnerOnlyFile } from "./config-dir";

export interface ShellConfig {
  provider?: string;
  model?: string;
  baseUrl?: string;
  /** Per-provider endpoint overrides selected in the TUI. */
  baseUrls?: Record<string, string>;
  /** Legacy single OpenRouter key (flow 080); migrated into `apiKeys` on read. */
  openrouterKey?: string;
  /**
   * Per-provider API keys, keyed by env var name (e.g. `DEEPSEEK_API_KEY`). Each is
   * owner-only plaintext, loaded into the process env at startup. Flow 085.
   */
  apiKeys?: Record<string, string>;
}

/** Absolute path to the `auth.json` config file. */
export function shellConfigPath(dir?: string): string {
  return path.join(keryxConfigDir(dir), "auth.json");
}

/** Read the persisted config; `{}` when absent/unreadable/malformed. Never throws. */
export function loadShellConfig(dir?: string): ShellConfig {
  try {
    const file = shellConfigPath(dir);
    if (!existsSync(file)) {
      return {};
    }
    // `readConfigFile`, not `readFileSync`: an oversized file aborts the
    // process outright (SIGABRT, no output, uncatchable). See MAX_CONFIG_FILE_BYTES.
    const read = readConfigFile(file);
    if (!read.ok) {
      return {};
    }
    const raw: unknown = JSON.parse(read.text);
    return raw !== null && typeof raw === "object" ? (raw as ShellConfig) : {};
  } catch {
    return {};
  }
}

/** Merge `patch` into the persisted config (0600). Best-effort; never throws. */
export function saveShellConfig(patch: Partial<ShellConfig>, dir?: string): void {
  try {
    // `ensureKeryxConfigDir`, not `mkdirSync`: this is usually the first writer
    // to create the shared directory, and creating it mode-less under `umask
    // 002` left it 0775 — group-writable, so `auth.json` and the serve
    // credential store beside it were unlinkable and replaceable by any member
    // of the operator's primary group. See `config-dir.permissions.test.ts`.
    ensureKeryxConfigDir(dir);
    const next: ShellConfig = { ...loadShellConfig(dir), ...patch };
    // Same creation-only trap as the directory mode: an `auth.json` that already
    // exists 0664 keeps that mode through every write, and this file holds
    // plaintext provider API keys.
    writeOwnerOnlyFile(shellConfigPath(dir), `${JSON.stringify(next, null, 2)}\n`);
  } catch {
    // best-effort persistence — a failure just means the user re-enters next time
  }
}

/**
 * Persist one provider's API key under `apiKeys[envKey]` (0600). Merges with any
 * existing keys. Best-effort; never throws.
 */
export function saveApiKey(envKey: string, value: string, dir?: string): void {
  const existing = loadShellConfig(dir).apiKeys ?? {};
  saveShellConfig({ apiKeys: { ...existing, [envKey]: value } }, dir);
}

/** Persist a user-selected endpoint without overwriting other providers. */
export function saveProviderBaseUrl(provider: string, baseUrl: string, dir?: string): void {
  const existing = loadShellConfig(dir).baseUrls ?? {};
  saveShellConfig({ baseUrls: { ...existing, [provider]: baseUrl } }, dir);
}

/**
 * Merge persisted shell API keys (auth.json) into an env map without overwriting
 * non-empty existing entries. Pure relative to `process.env` mutation — returns
 * a new object. Used by model-backed CLI commands (`wiki enrich`, etc.) so a key
 * entered once in `keryx shell` is visible to a subsequent `keryx wiki enrich`
 * subprocess, not only to the long-lived shell process.
 */
export function envWithSavedApiKeys(
  env: Record<string, string | undefined> = process.env,
  dir?: string,
): Record<string, string | undefined> {
  const merged: Record<string, string | undefined> = { ...env };
  try {
    const cfg = loadShellConfig(dir);
    const keys: Record<string, string> = { ...(cfg.apiKeys ?? {}) };
    if (typeof cfg.openrouterKey === "string" && cfg.openrouterKey.length > 0 && keys.OPENROUTER_API_KEY === undefined) {
      keys.OPENROUTER_API_KEY = cfg.openrouterKey;
    }
    for (const [envKey, value] of Object.entries(keys)) {
      if (typeof value !== "string" || value.length === 0) {
        continue;
      }
      const current = merged[envKey];
      if (current === undefined || current.length === 0) {
        merged[envKey] = value;
      }
    }
  } catch {
    // best-effort
  }
  return merged;
}

/**
 * Load every persisted API key into `process.env` WITHOUT overwriting a var the
 * user already set in their environment (env wins). Migrates the legacy
 * `openrouterKey` into `apiKeys.OPENROUTER_API_KEY`. Returns the env var names
 * applied. Best-effort; never throws.
 */
export function applySavedApiKeys(dir?: string): string[] {
  const applied: string[] = [];
  try {
    const before = new Set(
      Object.entries(process.env)
        .filter(([, v]) => typeof v === "string" && v.length > 0)
        .map(([k]) => k),
    );
    const merged = envWithSavedApiKeys(process.env, dir);
    for (const [envKey, value] of Object.entries(merged)) {
      if (typeof value !== "string" || value.length === 0) {
        continue;
      }
      const current = process.env[envKey];
      if (current === undefined || current.length === 0) {
        process.env[envKey] = value;
        if (!before.has(envKey)) {
          applied.push(envKey);
        }
      }
    }
  } catch {
    // best-effort — a failure just means the user re-enters the key this session
  }
  return applied;
}
