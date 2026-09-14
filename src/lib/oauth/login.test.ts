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

test("loginDeviceCode for github-copilot exchanges the GitHub token with Copilot identity headers", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-oauth-copilot");
  const seen: Array<{ url: string; authorization?: string; userAgent?: string; editor?: string; body?: string }> = [];
  const fetchFn: import("./device-code").OAuthFetch = async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const row: { url: string; authorization?: string; userAgent?: string; editor?: string; body?: string } = { url };
    const authorization = headers.get("Authorization");
    if (authorization !== null) row.authorization = authorization;
    const userAgent = headers.get("User-Agent");
    if (userAgent !== null) row.userAgent = userAgent;
    const editor = headers.get("Editor-Version");
    if (editor !== null) row.editor = editor;
    if (typeof init?.body === "string") row.body = init.body;
    seen.push(row);
    if (url.includes("/login/device/code")) {
      return jsonResponse(200, {
        device_code: "dev",
        user_code: "WXYZ-9",
        verification_uri: "https://github.com/login/device",
        interval: 1,
        expires_in: 60,
      });
    }
    if (url.includes("/login/oauth/access_token")) {
      return jsonResponse(200, { access_token: "ghu_github" });
    }
    if (url.includes("/copilot_internal/v2/token")) {
      return jsonResponse(200, { token: "tid-copilot", expires_at: Math.floor(Date.now() / 1000) + 120 });
    }
    return jsonResponse(500, { error: "unexpected" });
  };
  const result = await loginDeviceCode({
    provider: "github-copilot",
    fetch: fetchFn,
    dir: root,
    sleep: async () => {},
    onChallenge: (c) => {
      expect(c.userCode).toBe("WXYZ-9");
    },
  });
  expect(result).toEqual({ ok: true, provider: "github-copilot" });
  expect(loadOAuthGrant("github-copilot", root)?.access).toBe("tid-copilot");
  expect(loadOAuthGrant("github-copilot", root)?.refresh).toBe("ghu_github");
  const device = seen.find((row) => row.url.includes("/login/device/code"));
  expect(device?.body).toContain("Iv1.b507a08c87ecfe98");
  expect(device?.editor).toBe("vscode/1.99.3");
  const exchange = seen.find((row) => row.url.includes("/copilot_internal/v2/token"));
  expect(exchange?.authorization).toBe("token ghu_github");
  expect(exchange?.userAgent).toContain("GitHubCopilotChat");
  expect(exchange?.editor).toBe("vscode/1.99.3");
});
