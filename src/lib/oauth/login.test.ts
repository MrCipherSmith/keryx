import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { uniqueTestRoot } from "../test-tmp";
import { loadOAuthGrant } from "./grants";
import { loginDeviceCode } from "./login";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

test("loginDeviceCode for grok stores the grant after a pending poll", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-oauth-login");
  let n = 0;
  const fetchFn: import("./device-code").OAuthFetch = async (input) => {
    const url = String(input);
    if (url.includes("/device/code")) {
      return jsonResponse(200, {
        device_code: "dev",
        user_code: "WXYZ-9",
        verification_uri: "https://auth.x.ai/verify",
        interval: 1,
        expires_in: 60,
      });
    }
    n += 1;
    if (n === 1) return jsonResponse(400, { error: "authorization_pending" });
    return jsonResponse(200, { access_token: "grok-access", refresh_token: "grok-refresh", expires_in: 3600 });
  };
  const presented: string[] = [];
  const result = await loginDeviceCode({
    provider: "grok",
    fetch: fetchFn,
    dir: root,
    sleep: async () => {},
    onChallenge: (c) => {
      presented.push(c.userCode);
      expect(c.instructions).toContain("WXYZ-9");
      expect(c.instructions).not.toContain("dev");
    },
  });
  expect(result).toEqual({ ok: true, provider: "grok" });
  expect(presented).toEqual(["WXYZ-9"]);
  expect(loadOAuthGrant("grok", root)?.access).toBe("grok-access");
});

test("loginDeviceCode refuses Claude Pro subscription login", async () => {
  const result = await loginDeviceCode({
    provider: "anthropic",
    fetch: async () => new Response(null, { status: 500 }),
    onChallenge: () => {
      throw new Error("must not present a challenge");
    },
  });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.refused).toBe(true);
  expect(result.error).toContain("Claude Pro/Max");
});

test("loginDeviceCode refuses Gemini Google-account login", async () => {
  const result = await loginDeviceCode({
    provider: "gemini",
    fetch: async () => new Response(null, { status: 500 }),
    onChallenge: () => {
      throw new Error("must not present a challenge");
    },
  });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.refused).toBe(true);
  expect(result.error).toContain("GEMINI_API_KEY");
});

test("loginDeviceCode refuses a DeepSeek subscription grant that does not exist", async () => {
  const result = await loginDeviceCode({
    provider: "deepseek",
    fetch: async () => new Response(null, { status: 500 }),
    onChallenge: () => {
      throw new Error("must not present a challenge");
    },
  });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.refused).toBe(true);
  expect(result.error).toContain("DEEPSEEK_API_KEY");
});
