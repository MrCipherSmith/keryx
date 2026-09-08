// GitHub Copilot: after RFC 8628 yields a GitHub OAuth token, exchange it
// for a short-lived Copilot API token.

import { DeviceCodeError } from "./device-code";

export const COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";

export interface CopilotToken {
  accessToken: string;
  expiresInSeconds?: number;
}

export async function exchangeGithubTokenForCopilot(
  githubToken: string,
  http: { fetch: (input: string, init?: RequestInit) => Promise<Response>; signal?: AbortSignal },
): Promise<CopilotToken> {
  const init: RequestInit = {
    method: "GET",
    headers: {
      Authorization: `token ${githubToken}`,
      Accept: "application/json",
      "User-Agent": "keryx",
    },
  };
  if (http.signal !== undefined) {
    init.signal = http.signal;
  }
  const response = await http.fetch(COPILOT_TOKEN_URL, init);
  const json: unknown = await response.json().catch(() => ({}));
  if (!response.ok || typeof json !== "object" || json === null) {
    throw new DeviceCodeError("failed", `GitHub Copilot token exchange failed (HTTP ${response.status})`);
  }
  const rec = json as { token?: unknown; expires_at?: unknown };
  if (typeof rec.token !== "string" || rec.token.length === 0) {
    throw new DeviceCodeError("failed", "GitHub Copilot token exchange returned no token");
  }
  let expiresInSeconds: number | undefined;
  if (typeof rec.expires_at === "string") {
    const expires = Date.parse(rec.expires_at);
    if (Number.isFinite(expires)) {
      expiresInSeconds = Math.max(1, Math.floor((expires - Date.now()) / 1000));
    }
  }
  return { accessToken: rec.token, ...(expiresInSeconds !== undefined ? { expiresInSeconds } : {}) };
}
