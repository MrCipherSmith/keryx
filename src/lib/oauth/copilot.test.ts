import { expect, test } from "bun:test";
import { COPILOT_TOKEN_URL, copilotApiBaseFromExchange, exchangeGithubTokenForCopilot } from "./copilot";
import { DeviceCodeError } from "./device-code";

test("exchangeGithubTokenForCopilot reads token and expiry", async () => {
  const fetchFn = async (input: string, init?: RequestInit): Promise<Response> => {
    expect(String(input)).toBe(COPILOT_TOKEN_URL);
    const headers = new Headers(init?.headers);
    expect(headers.get("Authorization")).toBe("token github-oauth");
    expect(headers.get("User-Agent")).toBe("GitHubCopilotChat/0.26.7");
    expect(headers.get("Editor-Version")).toBe("vscode/1.99.3");
    expect(headers.get("Copilot-Integration-Id")).toBe("vscode-chat");
    return new Response(JSON.stringify({ token: "copilot-access", expires_at: new Date(Date.now() + 60_000).toISOString() }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const got = await exchangeGithubTokenForCopilot("github-oauth", { fetch: fetchFn });
  expect(got.accessToken).toBe("copilot-access");
  expect(got.expiresInSeconds).toBeGreaterThan(0);
});

test("exchangeGithubTokenForCopilot reads unix expires_at", async () => {
  const fetchFn = async (): Promise<Response> =>
    new Response(JSON.stringify({ token: "tid", expires_at: Math.floor(Date.now() / 1000) + 90 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  const got = await exchangeGithubTokenForCopilot("github-oauth", { fetch: fetchFn });
  expect(got.accessToken).toBe("tid");
  expect(got.expiresInSeconds).toBeGreaterThan(0);
  expect(got.expiresInSeconds).toBeLessThanOrEqual(90);
});

test("exchangeGithubTokenForCopilot surfaces GitHub's 403 message", async () => {
  const fetchFn = async (): Promise<Response> =>
    new Response(JSON.stringify({ message: "Must have Copilot access" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  try {
    await exchangeGithubTokenForCopilot("gho_token", { fetch: fetchFn });
    throw new Error("expected DeviceCodeError");
  } catch (err) {
    expect(err).toBeInstanceOf(DeviceCodeError);
    expect((err as DeviceCodeError).message).toContain("HTTP 403");
    expect((err as DeviceCodeError).message).toContain("Must have Copilot access");
  }
});

test("exchangeGithubTokenForCopilot reads endpoints.api", async () => {
  const fetchFn = async (): Promise<Response> =>
    new Response(
      JSON.stringify({
        token: "tid",
        expires_at: Math.floor(Date.now() / 1000) + 60,
        endpoints: { api: "https://api.individual.githubcopilot.com/" },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  const got = await exchangeGithubTokenForCopilot("github-oauth", { fetch: fetchFn });
  expect(got.apiBaseUrl).toBe("https://api.individual.githubcopilot.com");
});

test("copilotApiBaseFromExchange rejects non-Copilot origins", () => {
  expect(copilotApiBaseFromExchange("https://api.individual.githubcopilot.com")).toBe(
    "https://api.individual.githubcopilot.com",
  );
  expect(copilotApiBaseFromExchange("https://api.business.githubcopilot.com")).toBe(
    "https://api.business.githubcopilot.com",
  );
  expect(copilotApiBaseFromExchange("https://evil.example/steal")).toBeUndefined();
  expect(copilotApiBaseFromExchange("http://api.githubcopilot.com")).toBeUndefined();
});

test("exchangeGithubTokenForCopilot names a gateway HTML 403", async () => {
  const fetchFn = async (): Promise<Response> =>
    new Response("<html>Zscaler makes the internet safe</html>", {
      status: 403,
      headers: { "Content-Type": "text/html" },
    });
  try {
    await exchangeGithubTokenForCopilot("gho_token", { fetch: fetchFn });
    throw new Error("expected DeviceCodeError");
  } catch (err) {
    expect(err).toBeInstanceOf(DeviceCodeError);
    expect((err as DeviceCodeError).message).toContain("blocked by a gateway or proxy");
  }
});
