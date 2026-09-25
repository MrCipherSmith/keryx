// Persisted interactive-shell config (flow 080), modelled on opencode's
// `~/.local/share/opencode/auth.json`: the last-used provider/model and an
// optional OpenRouter API key, so the user does not re-enter them every launch.
//
// Stored at `~/.local/share/keryx/auth.json` with mode 0600 (owner-only). The key
// is a plaintext secret on disk — the same tradeoff opencode makes; it is written
// owner-only, never logged, and only read to populate the process env at startup.
// All functions are best-effort and never throw; the `dir` override keeps them
// unit-testable against a temp directory.
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { ensureKeryxConfigDir, keryxConfigDir, readConfigFile, writeOwnerOnlyFileAtomic } from "./config-dir";

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
  /** Legacy single OpenRouter key (flow 080); migrated into `apiKeys` on read. */
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

// ---------------------------------------------------------------------------
// `auth.json`'s own lock (flow 327, round 2 item 2 — review of PR #718:
// `saveShellConfig`'s read-merge-write and `model-profile.ts`'s one-time
// `modelProfiles` migration strip both touch this file, and neither excluded
// the other — two `saveShellConfig` callers racing, or a save landing
// between the strip's own read and write, could each silently lose the
// other's change).
//
// `withFileLock` (`./fs.ts`) is the codebase's one general-purpose file
// lock, but it is `Promise`-returning (mkdir + heartbeat + pid-liveness
// stale reclaim) — there is no sync variant. `saveShellConfig` is called
// synchronously from a large number of hot, non-async call sites
// (`saveApiKey`, `saveProviderBaseUrl`, `/reasoning`, `/think`, every
// routing-config save, ...); converting all of them to async to adopt
// `withFileLock` is a change far larger than this lock fix, so it is out of
// scope here — the smallest safe change is a SEPARATE, smaller sync
// primitive for `auth.json` alone, not a rewrite of every caller.
//
// `withAuthFileLockSync` is that primitive: the same directory-mutex trick
// `withFileLock` uses (`mkdirSync` is atomic — the first caller to create
// the directory holds the lock), WITHOUT its heartbeat or pid-liveness
// reclaim — just an mtime-age stale check and a bounded busy-retry
// (`Atomics.wait`, the one way a sync function can actually block).
// RESIDUAL RISK, stated rather than hidden: a process that crashes mid-write
// leaves the lock directory behind, and a waiter only reclaims it once its
// mtime exceeds `AUTH_LOCK_STALE_MS` — there is no pid-liveness check (a
// sync function cannot `await` one). Accepted because the critical section
// here is always a microseconds-scale read + `JSON.stringify` + atomic
// rename, never a long-running operation, so a stale lock is a rare crash
// artifact, not a normal occurrence — and a lock that cannot be acquired
// within `AUTH_LOCK_TIMEOUT_MS` is skipped rather than hung on forever,
// matching every other writer in this module's best-effort contract.
//
// Acquisition order (fixed, documented once here rather than at each call
// site): `model-profile.ts`'s OWN `model-profiles.json` lock first, THEN
// this auth lock — never the reverse, to rule out a lock-ordering deadlock.
// `saveShellConfig` itself only ever takes this lock alone, never nested
// with the profiles lock; the ONE nesting that exists anywhere is
// `model-profile.ts`'s migration strip, which is already inside the
// profiles lock when it takes this one — see that module's own comment.
const AUTH_LOCK_TIMEOUT_MS = 2_000;
const AUTH_LOCK_RETRY_MS = 10;
const AUTH_LOCK_STALE_MS = 5_000;

function authLockPath(dir?: string): string {
  return `${shellConfigPath(dir)}.lock`;
}

function isEexistError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === "EEXIST";
}

/** Block the current thread for `ms` — the one way a SYNC function can actually wait, unlike a `setTimeout` promise. */
function sleepSyncMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Best-effort sync mutual exclusion around `fn` for `auth.json`'s own
 * read-modify-write — see the block comment above for what this is (and is
 * not) a substitute for. Never throws: a lock that cannot be acquired within
 * `AUTH_LOCK_TIMEOUT_MS` is skipped and `fn` still runs, unlocked, the same
 * best-effort posture `saveShellConfig` already had before this existed,
 * rather than hanging a caller forever.
 */
export function withAuthFileLockSync<T>(dir: string | undefined, fn: () => T): T {
  const lockPath = authLockPath(dir);
  const deadline = Date.now() + AUTH_LOCK_TIMEOUT_MS;
  let acquired = false;
  while (!acquired && Date.now() < deadline) {
    try {
      mkdirSync(lockPath);
      acquired = true;
    } catch (error) {
      if (!isEexistError(error)) break; // unexpected error — proceed unlocked rather than throw from a best-effort primitive
      let stale = false;
      try {
        stale = Date.now() - statSync(lockPath).mtimeMs > AUTH_LOCK_STALE_MS;
      } catch {
        // The lock vanished between the EEXIST and the stat (the holder
        // released it) — `stale` stays `false`, the loop just retries mkdir.
      }
      if (stale) {
        try {
          rmSync(lockPath, { recursive: true, force: true });
        } catch {
          // A rival waiter may have reclaimed it first — fine, the loop retries mkdir either way.
        }
      } else {
        sleepSyncMs(AUTH_LOCK_RETRY_MS);
      }
    }
  }
  try {
    return fn();
  } finally {
    if (acquired) {
      try {
        rmSync(lockPath, { recursive: true, force: true });
      } catch {
        // Best-effort release, like every other write in this module.
      }
    }
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

/**
 * Merge `patch` into the persisted config (0600). Best-effort; never throws.
 *
 * The read-modify-write runs under `withAuthFileLockSync` (round 2 item 2 —
 * see that function's own doc): two callers racing this same function, or
 * one landing between `model-profile.ts`'s migration strip's own read and
 * write, now serialize on `auth.json`'s lock rather than one silently
 * clobbering the other's change.
 */
export function saveShellConfig(patch: Partial<ShellConfig>, dir?: string): void {
  try {
    // `ensureKeryxConfigDir`, not `mkdirSync`: this is usually the first writer
    // to create the shared directory, and creating it mode-less under `umask
    // 002` left it 0775 — group-writable, so `auth.json` and the serve
    // credential store beside it were unlinkable and replaceable by any member
    // of the operator's primary group. See `config-dir.permissions.test.ts`.
    ensureKeryxConfigDir(dir);
    withAuthFileLockSync(dir, () => {
      const next: ShellConfig = { ...loadShellConfig(dir), ...patch };
      // Atomic (temp file + rename), not a direct overwrite (flow 304 review
      // finding #6): a crash or a second concurrent write mid-write must never
      // leave `auth.json` half-written — this file holds plaintext provider API
      // keys and OAuth grants, and a reader that gets a truncated/corrupt parse
      // has no recovery. Rename also sidesteps the "existing file keeps its old
      // mode" trap `writeOwnerOnlyFile` had to `chmodSync` around: the renamed-in
      // temp file's 0600 mode becomes the destination's mode outright.
      writeOwnerOnlyFileAtomic(shellConfigPath(dir), `${JSON.stringify(next, null, 2)}\n`);
    });
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
  const existing = loadShellConfig(dir).modelParams ?? {};
  const merged = { ...(existing[provider] ?? {}), ...patch };
  saveShellConfig({ modelParams: { ...existing, [provider]: merged } }, dir);
}

/**
 * Remove one provider's saved API key (flow 304, the `/connect` Disconnect
 * button + `keryx providers remove`). Merge-and-rewrite, same shape as
 * `saveApiKey`'s own read-modify-write — siblings under `apiKeys` are left
 * untouched. A no-op (not an error) when `envKey` was never saved: disconnect
 * is idempotent, and a caller that already classified the credential as
 * "saved" before calling this never hits the absent case in practice.
 * Best-effort; never throws.
 */
export function removeApiKey(envKey: string, dir?: string): void {
  const existing = loadShellConfig(dir).apiKeys ?? {};
  if (!(envKey in existing)) return;
  const { [envKey]: _removed, ...rest } = existing;
  saveShellConfig({ apiKeys: rest }, dir);
}

/** Remove a provider's saved endpoint override, if any. Best-effort; never throws. Mirrors {@link removeApiKey}. */
export function removeProviderBaseUrl(provider: string, dir?: string): void {
  const existing = loadShellConfig(dir).baseUrls ?? {};
  if (!(provider in existing)) return;
  const { [provider]: _removed, ...rest } = existing;
  saveShellConfig({ baseUrls: rest }, dir);
}

/** Remove a provider's saved sampling/budget/timeout overrides, if any. Best-effort; never throws. Mirrors {@link removeApiKey}. */
export function removeProviderModelParams(provider: string, dir?: string): void {
  const existing = loadShellConfig(dir).modelParams ?? {};
  if (!(provider in existing)) return;
  const { [provider]: _removed, ...rest } = existing;
  saveShellConfig({ modelParams: rest }, dir);
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
  noteSavedCredentialEnv(applied);
  return applied;
}
