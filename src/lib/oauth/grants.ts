// OAuth grants in the existing user-global auth.json (mode 0600).
// Secrets live only in this file. Status/list surfaces never copy them.

import { loadShellConfig, saveShellConfig } from "../shell-config";

export type OAuthGrantMethod = "device-code" | "oauth-pkce-loopback";

export interface OAuthGrant {
  method: OAuthGrantMethod;
  access: string;
  refresh?: string;
  /** Epoch milliseconds. Absent when the issuer did not return expires_in. */
  expires?: number;
  obtainedAt: string;
  lastRefreshedAt?: string;
}

const ACCESS_TOKEN_REFRESH_SKEW_MS = 120_000;

export function loadOAuthGrant(provider: string, dir?: string): OAuthGrant | undefined {
  const grants = loadShellConfig(dir).oauthGrants;
  if (grants === undefined) {
    return undefined;
  }
  const grant = grants[provider];
  if (grant === undefined || typeof grant.access !== "string" || grant.access.length === 0) {
    return undefined;
  }
  if (grant.method !== "device-code" && grant.method !== "oauth-pkce-loopback") {
    return undefined;
  }
  return grant;
}

export function saveOAuthGrant(provider: string, grant: OAuthGrant, dir?: string): void {
  const existing = loadShellConfig(dir).oauthGrants ?? {};
  saveShellConfig({ oauthGrants: { ...existing, [provider]: grant } }, dir);
}

export function deleteOAuthGrant(provider: string, dir?: string): void {
  const existing = { ...(loadShellConfig(dir).oauthGrants ?? {}) };
  if (existing[provider] === undefined) {
    return;
  }
  delete existing[provider];
  saveShellConfig({ oauthGrants: existing }, dir);
}

export function listOAuthGrantProviders(dir?: string): string[] {
  const grants = loadShellConfig(dir).oauthGrants ?? {};
  return Object.keys(grants).filter((name) => loadOAuthGrant(name, dir) !== undefined).sort();
}

/** Public metadata for `keryx auth status`. Never includes token values. */
export function oauthGrantStatus(
  provider: string,
  dir?: string,
  now: () => number = Date.now,
): { provider: string; method: OAuthGrantMethod; state: "active" | "expired"; expiresAt?: string; refreshable: boolean } | undefined {
  const grant = loadOAuthGrant(provider, dir);
  if (grant === undefined) {
    return undefined;
  }
  const expired = grant.expires !== undefined && grant.expires - now() <= 0;
  return {
    provider,
    method: grant.method,
    state: expired ? "expired" : "active",
    ...(grant.expires !== undefined ? { expiresAt: new Date(grant.expires).toISOString() } : {}),
    refreshable: typeof grant.refresh === "string" && grant.refresh.length > 0,
  };
}

export function oauthAccessToken(provider: string, dir?: string): string | undefined {
  const grant = loadOAuthGrant(provider, dir);
  return grant?.access;
}

export function grantNeedsRefresh(grant: OAuthGrant, now: () => number = Date.now): boolean {
  if (grant.refresh === undefined || grant.refresh.length === 0) {
    return false;
  }
  if (grant.expires === undefined) {
    return false;
  }
  return grant.expires - now() <= ACCESS_TOKEN_REFRESH_SKEW_MS;
}

const OAUTH_ENV_KEYS: ReadonlyArray<{ provider: string; envKey: string }> = [
  { provider: "grok", envKey: "XAI_API_KEY" },
  { provider: "github-copilot", envKey: "GITHUB_COPILOT_TOKEN" },
];

/**
 * Copy OAuth access tokens into an env map under the provider's API-key name
 * so existing Bearer construction works. Does not overwrite a non-empty env
 * var. Does not copy ChatGPT OAuth onto OPENAI_API_KEY (that token is not a
 * platform key).
 */
export function envWithOAuthAccess(
  env: Record<string, string | undefined> = process.env,
  dir?: string,
): Record<string, string | undefined> {
  const merged: Record<string, string | undefined> = { ...env };
  for (const { provider, envKey } of OAUTH_ENV_KEYS) {
    const current = merged[envKey];
    if (typeof current === "string" && current.length > 0) {
      continue;
    }
    const access = oauthAccessToken(provider, dir);
    if (access !== undefined) {
      merged[envKey] = access;
    }
  }
  return merged;
}

/** Load OAuth access tokens into `process.env` without overwriting existing vars. */
export function applyOAuthAccessToEnv(dir?: string): string[] {
  const applied: string[] = [];
  const merged = envWithOAuthAccess(process.env, dir);
  for (const { envKey } of OAUTH_ENV_KEYS) {
    const value = merged[envKey];
    const current = process.env[envKey];
    if (typeof value === "string" && value.length > 0 && (current === undefined || current.length === 0)) {
      process.env[envKey] = value;
      applied.push(envKey);
    }
  }
  return applied;
}

export function grantFromTokens(
  method: OAuthGrantMethod,
  tokens: { accessToken: string; refreshToken?: string; expiresInSeconds?: number },
  now: () => number = Date.now,
): OAuthGrant {
  const obtainedAt = new Date(now()).toISOString();
  return {
    method,
    access: tokens.accessToken,
    ...(tokens.refreshToken !== undefined ? { refresh: tokens.refreshToken } : {}),
    ...(tokens.expiresInSeconds !== undefined ? { expires: now() + tokens.expiresInSeconds * 1000 } : {}),
    obtainedAt,
  };
}
