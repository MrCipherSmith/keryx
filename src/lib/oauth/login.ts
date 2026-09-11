import { catalogRefusal, deviceCodeMethodLabel, GITHUB_COPILOT_DEVICE, XAI_GROK_DEVICE, authCatalogEntry } from "./catalog";
import { exchangeGithubTokenForCopilot } from "./copilot";
import {
  DeviceCodeError,
  pollDeviceCodeToken,
  refreshAccessToken,
  requestDeviceCode,
  type DeviceCodeChallenge,
  type DeviceCodeHttp,
  type DeviceTokenSet,
} from "./device-code";
import {
  deleteOAuthGrant,
  grantFromTokens,
  grantNeedsRefresh,
  loadOAuthGrant,
  saveOAuthGrant,
  type OAuthGrant,
} from "./grants";
import { pollCodexDeviceToken, requestCodexDeviceCode } from "./openai-codex";

export interface LoginChallenge {
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  instructions: string;
}

export interface DeviceLoginInput {
  provider: string;
  fetch: import("./device-code").OAuthFetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  signal?: AbortSignal;
  dir?: string;
  onChallenge: (challenge: LoginChallenge) => void;
}

export type DeviceLoginResult = { ok: true; provider: string } | { ok: false; error: string; refused?: true };

function httpOf(input: DeviceLoginInput): DeviceCodeHttp {
  return {
    fetch: input.fetch,
    ...(input.sleep !== undefined ? { sleep: input.sleep } : {}),
    ...(input.now !== undefined ? { now: input.now } : {}),
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  };
}

function present(challenge: Pick<DeviceCodeChallenge, "userCode" | "verificationUri" | "verificationUriComplete">, provider: string): LoginChallenge {
  return {
    userCode: challenge.userCode,
    verificationUri: challenge.verificationUri,
    ...(challenge.verificationUriComplete !== undefined
      ? { verificationUriComplete: challenge.verificationUriComplete }
      : {}),
    instructions: `Open ${challenge.verificationUri} and enter code: ${challenge.userCode} (${deviceCodeMethodLabel(provider)})`,
  };
}

async function loginRfc8628(input: DeviceLoginInput): Promise<DeviceTokenSet> {
  const endpoints = input.provider === "github-copilot" ? GITHUB_COPILOT_DEVICE : XAI_GROK_DEVICE;
  const http = httpOf(input);
  const challenge = await requestDeviceCode(
    {
      deviceAuthorizationEndpoint: endpoints.deviceAuthorizationEndpoint,
      clientId: endpoints.clientId,
      scope: endpoints.scope,
      ...(endpoints.extraForm !== undefined ? { extraForm: endpoints.extraForm } : {}),
      ...(endpoints.headers !== undefined ? { headers: endpoints.headers } : {}),
    },
    http,
  );
  input.onChallenge(present(challenge, input.provider));
  const tokens = await pollDeviceCodeToken(
    challenge,
    {
      tokenEndpoint: endpoints.tokenEndpoint,
      clientId: endpoints.clientId,
      ...(endpoints.headers !== undefined ? { headers: endpoints.headers } : {}),
    },
    http,
  );
  if (endpoints.afterToken === "github-copilot") {
    const copilot = await exchangeGithubTokenForCopilot(tokens.accessToken, http);
    return {
      accessToken: copilot.accessToken,
      refreshToken: tokens.accessToken,
      ...(copilot.expiresInSeconds !== undefined ? { expiresInSeconds: copilot.expiresInSeconds } : {}),
    };
  }
  return tokens;
}

export async function loginDeviceCode(input: DeviceLoginInput): Promise<DeviceLoginResult> {
  const entry = authCatalogEntry(input.provider);
  if (entry === undefined) {
    return { ok: false, error: `unknown provider: ${input.provider}` };
  }
  if (!entry.methods.includes("device-code")) {
    const refusal = catalogRefusal(input.provider);
    if (refusal !== undefined) {
      return { ok: false, error: refusal, refused: true };
    }
    return { ok: false, error: `${input.provider} does not support device authorization` };
  }
  try {
    const tokens =
      input.provider === "openai"
        ? await loginCodex(input)
        : await loginRfc8628(input);
    saveOAuthGrant(input.provider, grantFromTokens("device-code", tokens, input.now), input.dir);
    return { ok: true, provider: input.provider };
  } catch (err) {
    const message =
      err instanceof DeviceCodeError
        ? err.message
        : err instanceof Error
          ? err.message
          : "device authorization failed";
    return { ok: false, error: message };
  }
}

async function loginCodex(input: DeviceLoginInput): Promise<DeviceTokenSet> {
  const http = httpOf(input);
  const challenge = await requestCodexDeviceCode(http);
  input.onChallenge(
    present(
      {
        userCode: challenge.userCode,
        verificationUri: challenge.verificationUri,
      },
      "openai",
    ),
  );
  return pollCodexDeviceToken(challenge, http);
}

export async function refreshProviderGrant(
  provider: string,
  http: { fetch: import("./device-code").OAuthFetch; signal?: AbortSignal; now?: () => number },
  dir?: string,
): Promise<OAuthGrant | undefined> {
  const grant = loadOAuthGrant(provider, dir);
  if (grant === undefined || !grantNeedsRefresh(grant, http.now)) {
    return grant;
  }
  if (grant.refresh === undefined) {
    return grant;
  }
  const endpoints = provider === "github-copilot" ? GITHUB_COPILOT_DEVICE : XAI_GROK_DEVICE;
  if (provider === "github-copilot") {
    const copilot = await exchangeGithubTokenForCopilot(grant.refresh, http);
    const next = grantFromTokens("device-code", {
      accessToken: copilot.accessToken,
      refreshToken: grant.refresh,
      ...(copilot.expiresInSeconds !== undefined ? { expiresInSeconds: copilot.expiresInSeconds } : {}),
    }, http.now);
    next.lastRefreshedAt = new Date((http.now ?? Date.now)()).toISOString();
    saveOAuthGrant(provider, next, dir);
    return next;
  }
  if (provider === "openai") {
    return grant;
  }
  const tokens = await refreshAccessToken(
    {
      tokenEndpoint: endpoints.tokenEndpoint,
      clientId: endpoints.clientId,
      refreshToken: grant.refresh,
      ...(endpoints.headers !== undefined ? { headers: endpoints.headers } : {}),
    },
    http,
  );
  const next = grantFromTokens("device-code", tokens, http.now);
  next.lastRefreshedAt = new Date((http.now ?? Date.now)()).toISOString();
  saveOAuthGrant(provider, next, dir);
  return next;
}

/** Providers whose stored grant a session refreshes before building a provider from it. */
const SESSION_REFRESHED_GRANTS = ["grok", "github-copilot"] as const;

/**
 * Refresh every stored grant that has expired or is about to, before any surface
 * builds a provider from one (K-013).
 *
 * This used to run only in the TUI's start-up, with each failure swallowed. The
 * readline surface — `--no-tui`, `--print`, every scripted run — then sent an
 * access token hours past its expiry, and the 403 it got back ("could not be
 * validated") read as a revoked login, not an expired one. Returns one line per
 * grant that needed a refresh and could not get one, for the caller to show.
 */
export async function refreshSavedGrants(
  http: { fetch: import("./device-code").OAuthFetch; signal?: AbortSignal; now?: () => number },
  dir?: string,
  providers: readonly string[] = SESSION_REFRESHED_GRANTS,
): Promise<string[]> {
  const warnings: string[] = [];
  const now = http.now ?? Date.now;
  // One after the other, not in parallel: each refresh rewrites the whole
  // `auth.json`, and two concurrent read-modify-writes would lose one grant.
  // The caller bounds the total with `http.signal`.
  for (const provider of providers) {
    if (!(SESSION_REFRESHED_GRANTS as readonly string[]).includes(provider)) continue;
    const grant = loadOAuthGrant(provider, dir);
    if (grant === undefined) continue;
    if (grant.refresh === undefined || grant.refresh.length === 0) {
      // Not refreshable, so `grantNeedsRefresh` says no — and the same opaque 403
      // follows unless someone says why first.
      if (grant.expires !== undefined && grant.expires <= now()) {
        warnings.push(
          `${provider}: the saved login has expired and holds no refresh token. Run \`keryx auth login ${provider}\`.`,
        );
      }
      continue;
    }
    if (!grantNeedsRefresh(grant, http.now)) continue;
    try {
      await refreshProviderGrant(provider, http, dir);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      warnings.push(
        `${provider}: the saved login is expiring or expired and could not be refreshed (${reason}). ` +
          `Run \`keryx auth login ${provider}\`.`,
      );
    }
  }
  return warnings;
}

export function logoutProvider(provider: string, dir?: string): void {
  deleteOAuthGrant(provider, dir);
}
