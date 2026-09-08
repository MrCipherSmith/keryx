// OAuth 2.0 device authorization grant (RFC 8628).
//
// No loopback listener and no browser on this machine: the operator opens a
// public verification URL, types a short user_code, and this module polls the
// token endpoint. The device_code never leaves this process.

export const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

const DEFAULT_INTERVAL_MS = 5_000;
const MIN_INTERVAL_MS = 1_000;
const SLOW_DOWN_INCREMENT_MS = 5_000;
const DEFAULT_EXPIRES_MS = 5 * 60 * 1000;
const POLL_SAFETY_MARGIN_MS = 3_000;

export interface DeviceCodeRequest {
  deviceAuthorizationEndpoint: string;
  clientId: string;
  scope: string;
  extraForm?: Record<string, string>;
  headers?: Record<string, string>;
}

export interface DeviceCodeChallenge {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresInSeconds?: number;
  intervalSeconds?: number;
}

export interface DeviceTokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresInSeconds?: number;
  scope?: string;
  idToken?: string;
}

export type OAuthFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface DeviceCodeHttp {
  fetch: OAuthFetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  signal?: AbortSignal;
}

function requestInit(base: RequestInit, signal?: AbortSignal): RequestInit {
  return signal === undefined ? base : { ...base, signal };
}

export type DevicePollError =
  | "authorization_pending"
  | "slow_down"
  | "access_denied"
  | "expired_token"
  | "cancelled"
  | "timeout"
  | "failed";

export class DeviceCodeError extends Error {
  readonly kind: Exclude<DevicePollError, "authorization_pending" | "slow_down">;
  constructor(kind: Exclude<DevicePollError, "authorization_pending" | "slow_down">, message: string) {
    super(message);
    this.name = "DeviceCodeError";
    this.kind = kind;
  }
}

function formHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
    ...extra,
  };
}

function positiveSecondsToMs(value: unknown, defaultMs: number): number {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : defaultMs;
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function aborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

function readJsonError(body: unknown): { error?: string; error_description?: string } {
  if (typeof body !== "object" || body === null) {
    return {};
  }
  const rec = body as { error?: unknown; error_description?: unknown };
  return {
    ...(typeof rec.error === "string" ? { error: rec.error } : {}),
    ...(typeof rec.error_description === "string" ? { error_description: rec.error_description } : {}),
  };
}

export async function requestDeviceCode(
  request: DeviceCodeRequest,
  http: DeviceCodeHttp,
): Promise<DeviceCodeChallenge> {
  if (aborted(http.signal)) {
    throw new DeviceCodeError("cancelled", "device authorization was cancelled");
  }
  const body = new URLSearchParams({
    client_id: request.clientId,
    scope: request.scope,
    ...request.extraForm,
  });
  const response = await http.fetch(
    request.deviceAuthorizationEndpoint,
    requestInit(
      {
        method: "POST",
        headers: formHeaders(request.headers),
        body: body.toString(),
      },
      http.signal,
    ),
  );
  const json: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = readJsonError(json).error_description ?? `HTTP ${response.status}`;
    throw new DeviceCodeError("failed", `device code request failed: ${detail}`);
  }
  if (typeof json !== "object" || json === null) {
    throw new DeviceCodeError("failed", "device code response is not an object");
  }
  const rec = json as Record<string, unknown>;
  const deviceCode = typeof rec.device_code === "string" ? rec.device_code : "";
  const userCode = typeof rec.user_code === "string" ? rec.user_code : "";
  const verificationUri = typeof rec.verification_uri === "string" ? rec.verification_uri : "";
  if (deviceCode.length === 0 || userCode.length === 0 || verificationUri.length === 0) {
    throw new DeviceCodeError("failed", "device code response is missing device_code / user_code / verification_uri");
  }
  if (![...userCode].every((c) => /[A-Za-z0-9-]/.test(c))) {
    throw new DeviceCodeError("failed", "device code response has an invalid user_code");
  }
  const complete =
    typeof rec.verification_uri_complete === "string" && rec.verification_uri_complete.length > 0
      ? rec.verification_uri_complete
      : undefined;
  return {
    deviceCode,
    userCode,
    verificationUri,
    ...(complete !== undefined ? { verificationUriComplete: complete } : {}),
    ...(typeof rec.expires_in === "number" ? { expiresInSeconds: rec.expires_in } : {}),
    ...(typeof rec.interval === "number" ? { intervalSeconds: rec.interval } : {}),
  };
}

export async function pollDeviceCodeToken(
  challenge: DeviceCodeChallenge,
  request: { tokenEndpoint: string; clientId: string; extraForm?: Record<string, string>; headers?: Record<string, string> },
  http: DeviceCodeHttp,
): Promise<DeviceTokenSet> {
  const sleep = http.sleep ?? defaultSleep;
  const now = http.now ?? Date.now;
  const expiresInMs = positiveSecondsToMs(challenge.expiresInSeconds, DEFAULT_EXPIRES_MS);
  const deadline = now() + expiresInMs;
  let intervalMs = Math.max(positiveSecondsToMs(challenge.intervalSeconds, DEFAULT_INTERVAL_MS), MIN_INTERVAL_MS);

  while (now() < deadline) {
    if (aborted(http.signal)) {
      throw new DeviceCodeError("cancelled", "device authorization was cancelled");
    }
    const response = await http.fetch(
      request.tokenEndpoint,
      requestInit(
        {
          method: "POST",
          headers: formHeaders(request.headers),
          body: new URLSearchParams({
            grant_type: DEVICE_CODE_GRANT_TYPE,
            client_id: request.clientId,
            device_code: challenge.deviceCode,
            ...request.extraForm,
          }).toString(),
        },
        http.signal,
      ),
    );
    const json: unknown = await response.json().catch(() => ({}));
    if (typeof json === "object" && json !== null && typeof (json as { access_token?: unknown }).access_token === "string") {
      const rec = json as {
        access_token: string;
        refresh_token?: unknown;
        expires_in?: unknown;
        scope?: unknown;
        id_token?: unknown;
      };
      return {
        accessToken: rec.access_token,
        ...(typeof rec.refresh_token === "string" && rec.refresh_token.length > 0
          ? { refreshToken: rec.refresh_token }
          : {}),
        ...(typeof rec.expires_in === "number" ? { expiresInSeconds: rec.expires_in } : {}),
        ...(typeof rec.scope === "string" ? { scope: rec.scope } : {}),
        ...(typeof rec.id_token === "string" ? { idToken: rec.id_token } : {}),
      };
    }

    const { error, error_description } = readJsonError(json);
    const remaining = Math.max(0, deadline - now());
    if (error === "authorization_pending") {
      await sleep(Math.min(intervalMs + POLL_SAFETY_MARGIN_MS, remaining));
      continue;
    }
    if (error === "slow_down") {
      intervalMs += SLOW_DOWN_INCREMENT_MS;
      await sleep(Math.min(intervalMs + POLL_SAFETY_MARGIN_MS, remaining));
      continue;
    }
    if (error === "access_denied" || error === "authorization_denied") {
      throw new DeviceCodeError("access_denied", "device authorization was denied");
    }
    if (error === "expired_token") {
      throw new DeviceCodeError("expired_token", "device code expired");
    }
    if (!response.ok) {
      throw new DeviceCodeError("failed", `device token exchange failed (${response.status})${error_description ? `: ${error_description}` : ""}`);
    }
    throw new DeviceCodeError("failed", `device token exchange failed${error_description ? `: ${error_description}` : ""}`);
  }
  throw new DeviceCodeError("timeout", "device authorization timed out");
}

export async function refreshAccessToken(
  request: { tokenEndpoint: string; clientId: string; refreshToken: string; extraForm?: Record<string, string>; headers?: Record<string, string> },
  http: Pick<DeviceCodeHttp, "fetch" | "signal">,
): Promise<DeviceTokenSet> {
  const response = await http.fetch(
    request.tokenEndpoint,
    requestInit(
      {
        method: "POST",
        headers: formHeaders(request.headers),
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: request.refreshToken,
          client_id: request.clientId,
          ...request.extraForm,
        }).toString(),
      },
      http.signal,
    ),
  );
  const json: unknown = await response.json().catch(() => ({}));
  if (!response.ok || typeof json !== "object" || json === null || typeof (json as { access_token?: unknown }).access_token !== "string") {
    const detail = readJsonError(json).error_description ?? `HTTP ${response.status}`;
    throw new DeviceCodeError("failed", `token refresh failed: ${detail}`);
  }
  const rec = json as {
    access_token: string;
    refresh_token?: unknown;
    expires_in?: unknown;
    scope?: unknown;
    id_token?: unknown;
  };
  return {
    accessToken: rec.access_token,
    refreshToken:
      typeof rec.refresh_token === "string" && rec.refresh_token.length > 0 ? rec.refresh_token : request.refreshToken,
    ...(typeof rec.expires_in === "number" ? { expiresInSeconds: rec.expires_in } : {}),
    ...(typeof rec.scope === "string" ? { scope: rec.scope } : {}),
    ...(typeof rec.id_token === "string" ? { idToken: rec.id_token } : {}),
  };
}
