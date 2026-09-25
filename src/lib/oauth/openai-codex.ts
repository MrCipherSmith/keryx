// ChatGPT Plus/Pro headless login (Codex device-auth). Not RFC 8628: OpenAI
// uses device_auth_id + user_code, then an authorization_code + PKCE verifier
// against auth.openai.com. Remote-capable (no loopback).

import { DeviceCodeError } from "./device-code";
import type { DeviceTokenSet } from "./device-code";
import { codexTokenMetadata } from "./openai-token";

export interface CodexTokenSet extends DeviceTokenSet { accountId?: string; expiresAt?: number }

export const OPENAI_CODEX_ISSUER = "https://auth.openai.com";
export const OPENAI_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

const DEVICE_LOGIN_TIMEOUT_MS = 15 * 60 * 1000;

export interface CodexDeviceChallenge {
  deviceAuthId: string;
  userCode: string;
  verificationUri: string;
  intervalMs: number;
}

type OAuthFetch = (input: string, init?: RequestInit) => Promise<Response>;

function withSignal(base: RequestInit, signal?: AbortSignal): RequestInit {
  if (signal?.aborted === true) throw new DeviceCodeError("cancelled", "device authorization was cancelled");
  const timeout = AbortSignal.timeout(30_000);
  return { ...base, signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]) };
}

export async function requestCodexDeviceCode(
  http: { fetch: OAuthFetch; signal?: AbortSignal },
): Promise<CodexDeviceChallenge> {
  const response = await http.fetch(
    `${OPENAI_CODEX_ISSUER}/api/accounts/deviceauth/usercode`,
    withSignal(
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": "keryx" },
        body: JSON.stringify({ client_id: OPENAI_CODEX_CLIENT_ID }),
      },
      http.signal,
    ),
  );
  const json: unknown = await response.json().catch(() => ({}));
  if (!response.ok || typeof json !== "object" || json === null) {
    throw new DeviceCodeError("failed", `ChatGPT device authorization failed (HTTP ${response.status})`);
  }
  const rec = json as { device_auth_id?: unknown; user_code?: unknown; usercode?: unknown; interval?: unknown };
  rec.user_code ??= rec.usercode;
  if (typeof rec.device_auth_id !== "string" || rec.device_auth_id.length === 0 || typeof rec.user_code !== "string" || rec.user_code.length === 0 || [...rec.user_code].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
    throw new DeviceCodeError("failed", "ChatGPT device authorization is missing device_auth_id / user_code");
  }
  const intervalSeconds = Number(rec.interval);
  return {
    deviceAuthId: rec.device_auth_id,
    userCode: rec.user_code,
    verificationUri: `${OPENAI_CODEX_ISSUER}/codex/device`,
    intervalMs: Number.isFinite(intervalSeconds) && intervalSeconds > 0 ? intervalSeconds * 1000 : 5_000,
  };
}

export async function pollCodexDeviceToken(
  challenge: CodexDeviceChallenge,
  http: { fetch: OAuthFetch; sleep?: (ms: number) => Promise<void>; now?: () => number; signal?: AbortSignal },
): Promise<CodexTokenSet> {
  const sleep = http.sleep;
  const now = http.now ?? Date.now;
  const deadline = now() + DEVICE_LOGIN_TIMEOUT_MS;
  while (now() < deadline) {
    if (http.signal?.aborted === true) {
      throw new DeviceCodeError("cancelled", "device authorization was cancelled");
    }
    const response = await http.fetch(
      `${OPENAI_CODEX_ISSUER}/api/accounts/deviceauth/token`,
      withSignal(
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": "keryx" },
          body: JSON.stringify({ device_auth_id: challenge.deviceAuthId, user_code: challenge.userCode }),
        },
        http.signal,
      ),
    );
    if (response.ok) {
      const data = (await response.json()) as { authorization_code?: unknown; code_verifier?: unknown };
      if (typeof data.authorization_code !== "string" || typeof data.code_verifier !== "string") {
        throw new DeviceCodeError("failed", "ChatGPT device token is missing authorization_code");
      }
      return exchangeCodexAuthorizationCode(data.authorization_code, data.code_verifier, http);
    }
    if (response.status !== 403 && response.status !== 404) {
      throw new DeviceCodeError("failed", `ChatGPT device token poll failed (HTTP ${response.status})`);
    }
    await abortableSleep(Math.min(challenge.intervalMs, Math.max(0, deadline - now())), sleep, http.signal);
  }
  throw new DeviceCodeError("timeout", "ChatGPT device authorization timed out");
}

async function exchangeCodexAuthorizationCode(
  code: string,
  codeVerifier: string,
  http: { fetch: OAuthFetch; signal?: AbortSignal },
): Promise<CodexTokenSet> {
  const response = await http.fetch(
    `${OPENAI_CODEX_ISSUER}/oauth/token`,
    withSignal(
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: `${OPENAI_CODEX_ISSUER}/deviceauth/callback`,
          client_id: OPENAI_CODEX_CLIENT_ID,
          code_verifier: codeVerifier,
        }).toString(),
      },
      http.signal,
    ),
  );
  const json: unknown = await response.json().catch(() => ({}));
  if (!response.ok || typeof json !== "object" || json === null || typeof (json as { access_token?: unknown }).access_token !== "string") {
    throw new DeviceCodeError("failed", `ChatGPT token exchange failed (HTTP ${response.status})`);
  }
  const rec = json as { access_token: string; refresh_token?: unknown; expires_in?: unknown; id_token?: unknown };
  const access = codexTokenMetadata(rec.access_token);
  const accountId = codexTokenMetadata(rec.id_token).accountId ?? access.accountId;
  return {
    accessToken: rec.access_token,
    ...(accountId !== undefined ? { accountId } : {}),
    ...(access.expiresAt !== undefined ? { expiresAt: access.expiresAt } : {}),
    ...(typeof rec.refresh_token === "string" ? { refreshToken: rec.refresh_token } : {}),
    ...(typeof rec.expires_in === "number" && Number.isFinite(rec.expires_in) && rec.expires_in > 0 ? { expiresInSeconds: rec.expires_in } : {}),
  };
}

async function abortableSleep(ms: number, sleep?: (ms: number) => Promise<void>, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) throw new DeviceCodeError("cancelled", "device authorization was cancelled");
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => { cleanup(); reject(new DeviceCodeError("cancelled", "device authorization was cancelled")); };
    const done = () => { cleanup(); resolve(); };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (sleep === undefined) timer = setTimeout(done, ms);
    else void sleep(ms).then(done, () => { cleanup(); reject(new DeviceCodeError("failed", "device authorization wait failed")); });
  });
}
