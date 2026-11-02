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
import { ensureKeryxConfigDir, keryxConfigDir, readConfigFile, type ConfigReadResult } from "./config-dir";
import { updateConfigFile } from "./config-update";

export interface ShellConfig {
  provider?: string;
  model?: string;
  baseUrl?: string;
  /** Per-provider endpoint overrides selected in the TUI. */
  baseUrls?: Record<string, string>;
  /**
   * Per-provider sampling/budget/timeout overrides for a BUILT-IN
   * OpenAI-compatible provider (flow 268). Keyed by provider name, same shape
   * `baseUrls` uses. A custom provider (`llm-providers.json`) carries these
   * fields on its own record instead — see `CustomCompatProvider`.
   */
  modelParams?: Record<string, { temperature?: number; maxOutputTokens?: number; timeoutMs?: number }>;
  /**
   * Legacy single OpenRouter key (flow 080). `loadShellConfig` moves it into
   * `apiKeys.OPENROUTER_API_KEY` (unless that is already set) and never returns
   * it, so every write drops it from disk and a remove of OPENROUTER_API_KEY
   * really revokes it.
   */
  openrouterKey?: string;
  /**
   * Per-provider API keys, keyed by env var name (e.g. `DEEPSEEK_API_KEY`). Each is
   * owner-only plaintext, loaded into the process env at startup. Flow 085.
   */
  apiKeys?: Record<string, string>;
  /**
   * OAuth grants from device-code / PKCE login, keyed by provider name
   * (`grok`, `openai`, `github-copilot`). Owner-only plaintext, same file as
   * `apiKeys`. Never logged.
   */
  oauthGrants?: Record<string, {
    method: "device-code" | "oauth-pkce-loopback";
    access: string;
    accountId?: string;
    refresh?: string;
    expires?: number;
    obtainedAt: string;
    lastRefreshedAt?: string;
  }>;
  /**
   * External agent runtime settings (flow 176;
   * docs/requirements/keryx-external-agent-runtime §3).
   *
   * Deliberately typed `unknown` rather than as the parsed shape: this file is
   * the raw on-disk view, the block is operator-editable, and
   * `parseExternalAgentsConfig` in `src/capability/external-agents.ts` is the one
   * validator. Typing it as the parsed interface here would both create an
   * import cycle (that module reads its config through `loadShellConfig`) and
   * make a hand-edited, half-valid block look type-safe to every reader.
   */
  externalAgents?: unknown;
  /**
   * Operator-set global override of the main agent turn's output-token
   * budget (`request.budget.maxOutputTokens`/`runReservation`). Must be a
   * positive integer when present. Consulted by
   * `resolveAgentMaxOutputTokens` (`src/commands/agent.ts`) BELOW the
   * `KERYX_MAX_OUTPUT_TOKENS` env override and a custom compat provider's own
   * `maxOutputTokens` (`CustomCompatProvider`,
   * `src/lib/provider-config.ts`), and ABOVE the built-in default — see that
   * function's precedence doc. Not validated here (this file is a raw
   * best-effort reader/writer, like every other field above); an invalid
   * hand-edited value is simply ignored by the resolver's own guard.
   */
  maxOutputTokens?: number;
  /**
   * Operator-set global reasoning effort for the main agent turn
   * (`request.options.reasoning`), persisted by the `/reasoning <level>`
   * shell command (flow 268 T16). One of `AgentDeps`'s
   * `REASONING_EFFORT_LEVELS` (`src/commands/agent.ts`) when valid. Consulted
   * by `resolveReasoningEffort` BELOW the `KERYX_REASONING_EFFORT` env
   * override and the session's own in-memory override, and ABOVE the
   * built-in default (`"off"`) — see that function's precedence doc. Not
   * validated here (this file is a raw best-effort reader/writer, like every
   * other field above); an invalid hand-edited value is simply ignored by the
   * resolver's own guard.
   */
  reasoningEffort?: string;
  /**
   * Operator-set display mode for reasoning blocks in the TUI (flow 268 T17,
   * AC16), persisted by `/think auto|expand|hide`. One of `"auto"` (default:
   * a collapsed block, expandable with bare `/think`/ctrl+o — today's
   * behaviour), `"expand"` (render the finished block already expanded), or
   * `"hide"` (no live "thinking…" preview and no retained block; see
   * `tui-shell.ts`'s `/think` handler for the exact contract). Not validated
   * here (this file is a raw best-effort reader/writer, like every other
   * field above); an invalid hand-edited value falls back to `"auto"` at the
   * read site.
   */
  thinkDisplay?: string;
  /**
   * Agent bus settings (flow 272; docs/requirements/keryx-agent-bus §7.4).
   * `enabled: false` is the persistent opt-out read by `busEnabled`
   * (`src/bus/enabled.ts`); `name` is the default instance name (P2). Not
   * validated here, like every other field above.
   */
  bus?: { enabled?: boolean; name?: string };
  /**
   * Flow 305 — the operator's PER-USER routing table (category -> model,
   * `src/harness/routing/table.ts`'s `RoutingTable`). A personal override, not
   * shared with the project (`routing.config.json` at the project root is the
   * per-project layer, which wins over this one — PRD §5). Read/written
   * through `src/harness/routing/config.ts`'s `loadRoutingConfig`/
   * `saveRoutingConfig`, never raw here, like every other structured field
   * above. Not validated at this layer (a raw best-effort reader/writer); an
   * invalid hand-edited entry is simply ignored by `resolveCategory`'s own
   * loader.
   */
  routing?: Record<string, unknown>;
  /**
   * Flow 327 — the operator's PER-USER model-profile catalogue (strength
   * tier, price, context length, priority, per-field provenance;
   * `src/harness/routing/model-profile.ts`'s `ModelProfile`), keyed by
   * `<providerId>/<modelId>`. Not validated at this layer (a raw
   * best-effort reader/writer, like every other structured field above);
   * `loadModelProfiles`/`loadStoredModelProfiles` do the validation. Read/
   * written only through `model-profile.ts`, never raw here.
   */
  modelProfiles?: Record<string, unknown>;
  /**
   * Flow 329 — the turn guard's per-user, opt-in setting: `enabled: true`
   * turns it on for every future `keryx shell` session until turned off
   * again, persisted by the `/guard on|off` command. Default off (absent or
   * `enabled !== true`) until the live check (AC8) has measured it — a
   * session-only override (`keryx shell --guard`) does NOT write here, same
   * as `--permission-mode` never persists `permissionMode`.
   */
  turnGuard?: { enabled?: boolean };
  /**
   * Flow 338 — the routing classifier's per-user, opt-in setting: `enabled:
   * true` turns automatic per-turn category classification on for every
   * future `keryx shell` session until turned off again, persisted by the
   * `/route on|off` command (mirrors `turnGuard`, above). Default off (absent
   * or `enabled !== true`) until the live check has measured accuracy.
   * `classifier: "jev"` additionally opts INTO Jev (PRD §9.2) when a
   * credential resolves — absent/anything else means "Jev not opted into",
   * so classification falls back to the main-model classifier even with a
   * valid `OPENROUTER_API_KEY` present, matching the routing PRD's "opt-in,
   * not implied by merely connecting openrouter" rule.
   */
  routingClassifier?: { enabled?: boolean; classifier?: "jev" };
  /**
   * Flow 346 — the EXTERNAL switch's per-user default: `"on"` (the
   * unset/legacy behavior) sends private work to Jev/TypeSafe and any other
   * connected provider/model as before; `"off"` blocks every destination
   * listed in `external-providers.json` (`src/lib/external-providers.ts`)
   * before any network I/O. Persisted by `/external on|off` and `keryx
   * external on|off` (without `--project`). A project's own
   * `.metaproject/tasks.config.json` `external` key wins over this one — see
   * `src/lib/external-switch.ts`'s `resolveExternalSetting`.
   */
  external?: "on" | "off";
}

/**
 * Env var names this process set from the saved config rather than inherited.
 *
 * keryx loads saved provider keys and grant tokens into its own `process.env` so
 * its providers can find them. That makes them indistinguishable, afterwards, from
 * a key the operator exported — and `shell_exec` used to hand the whole env to
 * every command (K-015). Recording them where they are applied is the only place
 * the difference is still known.
 */
const savedCredentialKeys = new Set<string>();

/** Record env var names that were just set from the saved config. */
export function noteSavedCredentialEnv(keys: Iterable<string>): void {
  for (const key of keys) savedCredentialKeys.add(key);
}

/** Env var names this process set from the saved config (see `noteSavedCredentialEnv`). */
export function savedCredentialEnvKeys(): ReadonlySet<string> {
  return savedCredentialKeys;
}

/** Absolute path to the `auth.json` config file. */
export function shellConfigPath(dir?: string): string {
  return path.join(keryxConfigDir(dir), "auth.json");
}

/**
 * Fold the legacy `openrouterKey` into `apiKeys.OPENROUTER_API_KEY`.
 *
 * Done on every read, not only where env vars are applied: a migration that
 * lived only in `envWithSavedApiKeys` kept loading the key on every launch
 * while `removeApiKey` and the provider classifier, which look at `apiKeys`,
 * could not see it — a stored credential nothing in the product could revoke.
 * Because every write starts from this view, the first write after an upgrade
 * persists the migration.
 */
function withLegacyKeyMigrated(config: ShellConfig): ShellConfig {
  if (!("openrouterKey" in config)) return config;
  const { openrouterKey: legacy, ...rest } = config;
  if (typeof legacy !== "string" || legacy.length === 0 || rest.apiKeys?.OPENROUTER_API_KEY !== undefined) {
    return rest;
  }
  return { ...rest, apiKeys: { ...(rest.apiKeys ?? {}), OPENROUTER_API_KEY: legacy } };
}

function parseShellConfig(read: ConfigReadResult): ShellConfig {
  if (!read.ok) return {};
  try {
    const raw: unknown = JSON.parse(read.text);
    return raw !== null && typeof raw === "object" && !Array.isArray(raw) ? withLegacyKeyMigrated(raw as ShellConfig) : {};
  } catch {
    return {};
  }
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
    return parseShellConfig(readConfigFile(file));
  } catch {
    return {};
  }
}

/**
 * Apply `mutate` to the config as it is on disk NOW and persist the result
 * (0600). `mutate` returns the next config, or `undefined` for "nothing to
 * change". Best-effort; never throws.
 *
 * Every writer of this file goes through here, so a change is always applied
 * to the latest content and never to a snapshot read earlier: this file is
 * written by every keryx process of the user at once, and a read-modify-write
 * over an earlier read lost half of two processes' saved keys and restored a
 * spent OAuth refresh token over a just-rotated one. Serialised by
 * `updateConfigFile`, whose lock waits at most 750ms and then falls back to a
 * compare-before-rename, so a TUI path such as `/reasoning` can never hang on
 * it — the reason the earlier `Atomics.wait` lock (PR #718) was removed.
 *
 * `mutate` may run more than once; it must derive its result from its
 * argument alone.
 */
export function updateShellConfig(mutate: (current: ShellConfig) => ShellConfig | undefined, dir?: string): void {
  try {
    // `ensureKeryxConfigDir`, not `mkdirSync`: this is usually the first writer
    // to create the shared directory, and creating it mode-less under `umask
    // 002` left it 0775 — group-writable, so `auth.json` and the serve
    // credential store beside it were unlinkable and replaceable by any member
    // of the operator's primary group. See `config-dir.permissions.test.ts`.
    ensureKeryxConfigDir(dir);
    // Atomic (temp file + rename), not a direct overwrite (flow 304 review
    // finding #6): a crash or a second concurrent write mid-write must never
    // leave `auth.json` half-written — this file holds plaintext provider API
    // keys and OAuth grants, and a reader that gets a truncated/corrupt parse
    // has no recovery. Rename also sidesteps the "existing file keeps its old
    // mode" trap `writeOwnerOnlyFile` had to `chmodSync` around: the renamed-in
    // temp file's 0600 mode becomes the destination's mode outright.
    updateConfigFile(shellConfigPath(dir), (read) => {
      const next = mutate(parseShellConfig(read));
      return next === undefined ? undefined : `${JSON.stringify(withLegacyKeyMigrated(next), null, 2)}\n`;
    });
  } catch {
    // best-effort persistence — a failure just means the user re-enters next time
  }
}

/**
 * Merge `patch` into the persisted config (0600). Best-effort; never throws.
 *
 * A top-level shallow merge applied to the file as it is at write time (see
 * {@link updateShellConfig}). A caller that changes ONE entry of a nested map
 * must use `updateShellConfig` instead of reading the map, editing it and
 * passing the whole map here: the map it read may already be stale.
 *
 * `model-profile.ts`'s one-time `modelProfiles` migration strip still writes
 * this file on its own lock-free read/verify/write
 * (`stripModelProfilesFromAuthJsonUnlocked`); see that function's doc.
 */
export function saveShellConfig(patch: Partial<ShellConfig>, dir?: string): void {
  updateShellConfig((current) => ({ ...current, ...patch }), dir);
}

/**
 * Persist one provider's API key under `apiKeys[envKey]` (0600). Merges with any
 * existing keys. Best-effort; never throws.
 */
export function saveApiKey(envKey: string, value: string, dir?: string): void {
  updateShellConfig((current) => ({ ...current, apiKeys: { ...(current.apiKeys ?? {}), [envKey]: value } }), dir);
}

/** Persist a user-selected endpoint without overwriting other providers. */
export function saveProviderBaseUrl(provider: string, baseUrl: string, dir?: string): void {
  updateShellConfig((current) => ({ ...current, baseUrls: { ...(current.baseUrls ?? {}), [provider]: baseUrl } }), dir);
}

/**
 * Merge a `{temperature?, maxOutputTokens?, timeoutMs?}` patch into `provider`'s
 * entry under `modelParams`, WITHOUT overwriting other providers' entries or
 * the rest of this provider's own patch history (flow 268, mirrors
 * `saveProviderBaseUrl`). Best-effort; never throws.
 */
export function saveProviderModelParams(
  provider: string,
  patch: { temperature?: number; maxOutputTokens?: number; timeoutMs?: number },
  dir?: string,
): void {
  updateShellConfig((current) => {
    const existing = current.modelParams ?? {};
    return { ...current, modelParams: { ...existing, [provider]: { ...(existing[provider] ?? {}), ...patch } } };
  }, dir);
}

/** Drop `key` from the `field` map of the config on disk; `undefined` (no write) when it is not there. */
function withoutEntry(
  current: ShellConfig,
  field: "apiKeys" | "baseUrls" | "modelParams",
  key: string,
): ShellConfig | undefined {
  const existing: Record<string, unknown> = current[field] ?? {};
  if (!(key in existing)) return undefined;
  const { [key]: _removed, ...rest } = existing;
  return { ...current, [field]: rest };
}

/**
 * Remove one provider's saved API key (flow 304, the `/connect` Disconnect
 * button + `keryx providers remove`). Siblings under `apiKeys` are left
 * untouched. A no-op (not an error) when `envKey` was never saved: disconnect
 * is idempotent, and a caller that already classified the credential as
 * "saved" before calling this never hits the absent case in practice.
 * `OPENROUTER_API_KEY` also covers the legacy `openrouterKey` field, which
 * `loadShellConfig` presents under that name. Best-effort; never throws.
 */
export function removeApiKey(envKey: string, dir?: string): void {
  updateShellConfig((current) => withoutEntry(current, "apiKeys", envKey), dir);
}

/** Remove a provider's saved endpoint override, if any. Best-effort; never throws. Mirrors {@link removeApiKey}. */
export function removeProviderBaseUrl(provider: string, dir?: string): void {
  updateShellConfig((current) => withoutEntry(current, "baseUrls", provider), dir);
}

/** Remove a provider's saved sampling/budget/timeout overrides, if any. Best-effort; never throws. Mirrors {@link removeApiKey}. */
export function removeProviderModelParams(provider: string, dir?: string): void {
  updateShellConfig((current) => withoutEntry(current, "modelParams", provider), dir);
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
    // The legacy `openrouterKey` arrives here already as OPENROUTER_API_KEY (`loadShellConfig`).
    const keys: Record<string, string> = { ...(cfg.apiKeys ?? {}) };
    for (const [envKey, value] of Object.entries(keys)) {
      if (typeof value !== "string" || value.length === 0) {
        continue;
      }
      const current = merged[envKey];
      if (current === undefined || current.length === 0) {
        merged[envKey] = value;
      }
    }
    const grants = cfg.oauthGrants ?? {};
    const grokAccess = grants.grok?.access;
    if (typeof grokAccess === "string" && grokAccess.length > 0 && (merged.XAI_API_KEY === undefined || merged.XAI_API_KEY.length === 0)) {
      merged.XAI_API_KEY = grokAccess;
    }
    const copilotAccess = grants["github-copilot"]?.access;
    if (
      typeof copilotAccess === "string" &&
      copilotAccess.length > 0 &&
      (merged.GITHUB_COPILOT_TOKEN === undefined || merged.GITHUB_COPILOT_TOKEN.length === 0)
    ) {
      merged.GITHUB_COPILOT_TOKEN = copilotAccess;
    }
  } catch {
    // best-effort
  }
  return merged;
}

/**
 * The env var names the saved configuration DECLARES it would load — without
 * requiring that anything has actually been loaded into `process.env` yet
 * this run.
 *
 * `savedCredentialEnvKeys()` only knows what THIS process has already
 * applied (`applySavedApiKeys`, called from TUI startup, `serve-runner.ts`
 * and `keryx acp`; `envWithOAuthAccess`'s own env-mutating sibling). A
 * surface that resolves its provider a different way — the `keryx shell`
 * READLINE path (`--no-tui`/`--print`/non-TTY), which never calls
 * `applySavedApiKeys` at all — or one that resolves no provider in the first
 * place (`keryx mcp doctor`) leaves that singleton empty, even though the
 * SAME `auth.json` on disk would still hand an unrecognised custom name to
 * every MCP child were it ever loaded. `buildMcpChildEnv`
 * (`../mcp-servers/spawn-env.ts`) unions this with the runtime singleton so
 * the strip does not depend on which code path happened to run first —
 * flow 296's follow-up finding.
 *
 * Reuses `envWithSavedApiKeys` — the EXACT function `applySavedApiKeys`
 * calls to decide what to apply — read-only and value-free: called against
 * an empty parent env, so every key in the result is one the saved config
 * itself declares (`apiKeys`, the legacy `openrouterKey` migration target,
 * and the OAuth-derived `XAI_API_KEY`/`GITHUB_COPILOT_TOKEN`), never one
 * merely passed through. Never throws — `envWithSavedApiKeys` already
 * catches internally and a malformed/unreadable file yields an empty
 * result, the same fail-closed contract `loadShellConfig` gives everything
 * else here.
 */
export function declaredCredentialEnvKeys(dir?: string): ReadonlySet<string> {
  try {
    return new Set(Object.keys(envWithSavedApiKeys({}, dir)));
  } catch {
    return new Set();
  }
}

/**
 * Load every persisted API key into `process.env` WITHOUT overwriting a var the
 * user already set in their environment (env wins). Includes the legacy
 * `openrouterKey`, which `loadShellConfig` presents as `apiKeys.OPENROUTER_API_KEY`. Returns the env var names
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
  noteSavedCredentialEnv(applied);
  return applied;
}
