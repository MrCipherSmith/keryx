import { resolve, join } from "node:path";
import { keryxConfigDir } from "../config-dir";
import { withFileLock } from "../fs";
import type { OAuthFetch } from "./device-code";
import { loadOAuthGrant, saveOAuthGrant, type OAuthGrant } from "./grants";
import { OPENAI_CODEX_CLIENT_ID, OPENAI_CODEX_ISSUER } from "./openai-codex";
import { codexTokenMetadata } from "./openai-token";
export interface OpenAiCodexGrantInput {
  configDir?: string;
  fetch: OAuthFetch;
  signal?: AbortSignal;
  now?: () => number;
  forceRefresh?: boolean;
}
const refreshes = new Map<string, Promise<OAuthGrant>>();
const LOGIN = "Run `keryx auth login openai-codex`.";
class SubscriptionAuthError extends Error {
}
function failure(detail: string): Error { return new SubscriptionAuthError(`ChatGPT subscription: ${detail}. ${LOGIN}`); }
function enrich(grant: OAuthGrant): OAuthGrant {
  const metadata = codexTokenMetadata(grant.access);
  return { ...grant, ...(grant.accountId === undefined && metadata.accountId !== undefined ? { accountId: metadata.accountId } : {}),
    ...(grant.expires === undefined && metadata.expiresAt !== undefined ? { expires: metadata.expiresAt } : {}) };
}
function cancelled(signal?: AbortSignal): void { if (signal?.aborted)
  throw failure("authorization cancelled"); }
/** Refresh metadata independently of account validation, for startup/status compatibility. */
export async function refreshOpenAiCodexGrant(input: OpenAiCodexGrantInput): Promise<OAuthGrant> {
  cancelled(input.signal);
  const loaded = loadOAuthGrant("openai-codex", input.configDir);
  if (loaded === undefined)
    throw failure("not signed in");
  const grant = enrich(loaded);
  const now = input.now ?? Date.now;
  if (!input.forceRefresh && grant.expires !== undefined && grant.expires > now() + 120000)
    return grant;
  if (!grant.refresh) {
    if (input.forceRefresh || (grant.expires !== undefined && grant.expires <= now()))
      throw failure("login expired and cannot be refreshed");
    return grant;
  }
  const key = resolve(input.configDir ?? keryxConfigDir());
  let pending = refreshes.get(key);
  if (pending === undefined) {
    pending = refreshWithLock(grant, input, key);
    refreshes.set(key, pending);
    void pending.finally(() => { if (refreshes.get(key) === pending)
      refreshes.delete(key); }).catch(() => { });
  }
  // A cancelled waiter must not cancel another request's token rotation.
  if (input.signal === undefined)
    return pending;
  return new Promise((resolveGrant, reject) => {
    const abort = () => { cleanup(); reject(failure("authorization cancelled")); };
    const cleanup = () => input.signal?.removeEventListener("abort", abort);
    input.signal?.addEventListener("abort", abort, { once: true });
    if (input.signal?.aborted) {
      abort();
      return;
    }
    void pending!.then((result) => { cleanup(); resolveGrant(result); }, (error: unknown) => { cleanup(); reject(error); });
  });
}
async function refreshWithLock(initial: OAuthGrant, input: OpenAiCodexGrantInput, configDir: string): Promise<OAuthGrant> {
  try {
    return await withFileLock(join(configDir, ".openai-codex-refresh.lock"), async () => {
      const current = loadOAuthGrant("openai-codex", input.configDir);
      if (current === undefined || current.obtainedAt !== initial.obtainedAt || (initial.accountId !== undefined && current.accountId !== initial.accountId)) {
        throw failure("login changed while waiting for token refresh");
      }
      // Another process already rotated this token while we were waiting. Do not spend it twice.
      if (current.access !== initial.access || current.refresh !== initial.refresh)
        return enrich(current);
      return refreshGrant(current, input);
    }, { timeoutMs: 35000, retryMs: 50, staleMs: 30000, heartbeatMs: 1000 });
  }
  catch (error) {
    if (error instanceof SubscriptionAuthError)
      throw error;
    throw failure("could not acquire or release the token refresh lock");
  }
}
async function refreshGrant(grant: OAuthGrant, input: OpenAiCodexGrantInput): Promise<OAuthGrant> {
  const now = input.now ?? Date.now;
  try {
    const response = await input.fetch(`${OPENAI_CODEX_ISSUER}/oauth/token`, {
      method: "POST", signal: AbortSignal.timeout(30000),
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ grant_type: "refresh_token", client_id: OPENAI_CODEX_CLIENT_ID, refresh_token: grant.refresh }),
    });
    if (!response.ok)
      throw failure(`token refresh failed (HTTP ${response.status})`);
    const json: unknown = await response.json();
    if (typeof json !== "object" || json === null)
      throw failure("invalid token refresh response");
    const rec = json as Record<string, unknown>;
    if (typeof rec.access_token !== "string" || rec.access_token.length === 0)
      throw failure("token refresh returned no access token");
    const id = codexTokenMetadata(rec.id_token);
    const access = codexTokenMetadata(rec.access_token);
    const expires = typeof rec.expires_in === "number" && Number.isFinite(rec.expires_in) && rec.expires_in > 0
      ? now() + rec.expires_in * 1000 : access.expiresAt;
    const accountId = id.accountId ?? access.accountId ?? grant.accountId;
    if (grant.accountId !== undefined && accountId !== grant.accountId)
      throw failure("refreshed account does not match saved login");
    const next: OAuthGrant = { ...grant, access: rec.access_token,
      ...(typeof rec.refresh_token === "string" && rec.refresh_token.length > 0 ? { refresh: rec.refresh_token } : {}),
      ...(accountId !== undefined ? { accountId } : {}), lastRefreshedAt: new Date(now()).toISOString() };
    if (expires !== undefined)
      next.expires = expires;
    else
      delete next.expires;
    // Do not resurrect a grant after logout or replace a newer login while refresh was in flight.
    const current = loadOAuthGrant("openai-codex", input.configDir);
    if (current?.access !== grant.access || current.refresh !== grant.refresh)
      throw failure("login changed during token refresh");
    saveOAuthGrant("openai-codex", next, input.configDir);
    const persisted = loadOAuthGrant("openai-codex", input.configDir);
    if (persisted?.access !== next.access || persisted.refresh !== next.refresh)
      throw failure("could not save refreshed login");
    return next;
  }
  catch (error) {
    // Never echo remote response bodies, transport errors, tokens, or authorization headers.
    if (error instanceof SubscriptionAuthError)
      throw error;
    throw failure("token refresh failed");
  }
}
export async function ensureOpenAiCodexGrant(input: OpenAiCodexGrantInput): Promise<OAuthGrant & {
  accountId: string;
}> {
  const grant = await refreshOpenAiCodexGrant(input);
  cancelled(input.signal);
  if (grant.accountId === undefined || grant.accountId.length === 0 || /[\r\n]/.test(grant.accountId))
    throw failure("saved login has no account identity");
  if (grant.expires !== undefined && grant.expires <= (input.now ?? Date.now)())
    throw failure("login has expired");
  return { ...grant, accountId: grant.accountId };
}
