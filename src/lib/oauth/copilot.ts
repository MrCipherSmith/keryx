// GitHub Copilot: after RFC 8628 yields a GitHub OAuth token, exchange it
// for a short-lived Copilot API token.

import { GITHUB_COPILOT_REQUEST_HEADERS } from "./catalog";
import { DeviceCodeError } from "./device-code";

export const COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";

export interface CopilotToken {
  accessToken: string;
  expiresInSeconds?: number;
  /** Plan-specific API origin from the token exchange (`endpoints.api`). */
  apiBaseUrl?: string;
}

/** Accept only https Copilot API origins from the exchange payload. */
export function copilotApiBaseFromExchange(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.length === 0) {
    return undefined;
  }
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username.length > 0 || url.password.length > 0) {
      return undefined;
    }
    const host = url.hostname;
    if (host !== "api.githubcopilot.com" && !host.endsWith(".githubcopilot.com")) {
      return undefined;
    }
    return `https://${host}${url.port.length > 0 ? `:${url.port}` : ""}`;
  } catch {
    return undefined;
  }
}

function expiresInSecondsFrom(rec: { expires_at?: unknown; refresh_in?: unknown }, now: number): number | undefined {
  if (typeof rec.expires_at === "string") {
    const expires = Date.parse(rec.expires_at);
    if (Number.isFinite(expires)) {
      return Math.max(1, Math.floor((expires - now) / 1000));
    }
  }
  if (typeof rec.expires_at === "number" && Number.isFinite(rec.expires_at)) {
    const expiresMs = rec.expires_at < 1_000_000_000_000 ? rec.expires_at * 1000 : rec.expires_at;
    return Math.max(1, Math.floor((expiresMs - now) / 1000));
  }
  if (typeof rec.refresh_in === "number" && Number.isFinite(rec.refresh_in) && rec.refresh_in > 0) {
    return Math.floor(rec.refresh_in);
  }
  return undefined;
}

function describeExchangeFailure(status: number, json: unknown, body: string): string {
  if (typeof json === "object" && json !== null) {
    const rec = json as { message?: unknown; error_details?: { copilot_access_denied?: unknown } };
    if (rec.error_details?.copilot_access_denied === true) {
      return `GitHub Copilot token exchange failed (HTTP ${status}): Copilot access denied — check the GitHub Copilot subscription on this account`;
    }
    if (typeof rec.message === "string" && rec.message.length > 0) {
      return `GitHub Copilot token exchange failed (HTTP ${status}): ${rec.message}`;
    }
  }
  if (/zscaler|blocked because it does not comply/i.test(body)) {
    return `GitHub Copilot token exchange failed (HTTP ${status}): request was blocked by a gateway or proxy`;
  }
  return `GitHub Copilot token exchange failed (HTTP ${status})`;
}

export async function exchangeGithubTokenForCopilot(
  githubToken: string,
  http: { fetch: (input: string, init?: RequestInit) => Promise<Response>; signal?: AbortSignal },
): Promise<CopilotToken> {
  const init: RequestInit = {
    method: "GET",
    headers: {
      ...GITHUB_COPILOT_REQUEST_HEADERS,
      Authorization: `token ${githubToken}`,
    },
  };
  if (http.signal !== undefined) {
    init.signal = http.signal;
  }
  const response = await http.fetch(COPILOT_TOKEN_URL, init);
  const body = await response.text().catch(() => "");
  let json: unknown = {};
  if (body.length > 0) {
    try {
      json = JSON.parse(body) as unknown;
    } catch {
      json = {};
    }
  }
  if (!response.ok || typeof json !== "object" || json === null) {
    throw new DeviceCodeError("failed", describeExchangeFailure(response.status, json, body));
  }
  const rec = json as { token?: unknown; expires_at?: unknown; refresh_in?: unknown; endpoints?: { api?: unknown } };
  if (typeof rec.token !== "string" || rec.token.length === 0) {
    throw new DeviceCodeError("failed", "GitHub Copilot token exchange returned no token");
  }
  const expiresInSeconds = expiresInSecondsFrom(rec, Date.now());
  const apiBaseUrl = copilotApiBaseFromExchange(rec.endpoints?.api);
  return {
    accessToken: rec.token,
    ...(expiresInSeconds !== undefined ? { expiresInSeconds } : {}),
    ...(apiBaseUrl !== undefined ? { apiBaseUrl } : {}),
  };
}
