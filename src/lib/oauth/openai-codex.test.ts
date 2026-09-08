import { expect, test } from "bun:test";
import { pollCodexDeviceToken, requestCodexDeviceCode } from "./openai-codex";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

test("requestCodexDeviceCode returns a user_code and verification URL", async () => {
  const fetchFn = async (): Promise<Response> =>
    jsonResponse(200, { device_auth_id: "id-1", user_code: "AB12-CD", interval: "5" });
  const challenge = await requestCodexDeviceCode({ fetch: fetchFn });
  expect(challenge.userCode).toBe("AB12-CD");
  expect(challenge.verificationUri).toContain("/codex/device");
});

test("pollCodexDeviceToken exchanges an authorization_code after 403 pending", async () => {
  let n = 0;
  const fetchFn = async (input: string): Promise<Response> => {
    const url = String(input);
    if (url.includes("/deviceauth/token")) {
      n += 1;
      if (n === 1) return new Response(null, { status: 403 });
      return jsonResponse(200, { authorization_code: "ac", code_verifier: "cv" });
    }
    if (url.includes("/oauth/token")) {
      return jsonResponse(200, { access_token: "chatgpt-access", refresh_token: "chatgpt-refresh", expires_in: 10 });
    }
    return jsonResponse(500, {});
  };
  const tokens = await pollCodexDeviceToken(
    { deviceAuthId: "id-1", userCode: "AB12-CD", verificationUri: "https://auth.openai.com/codex/device", intervalMs: 1 },
    { fetch: fetchFn, sleep: async () => {} },
  );
  expect(tokens.accessToken).toBe("chatgpt-access");
  expect(tokens.refreshToken).toBe("chatgpt-refresh");
});
