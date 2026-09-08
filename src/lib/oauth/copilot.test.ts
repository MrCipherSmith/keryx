import { expect, test } from "bun:test";
import { COPILOT_TOKEN_URL, exchangeGithubTokenForCopilot } from "./copilot";

test("exchangeGithubTokenForCopilot reads token and expiry", async () => {
  const fetchFn = async (input: string): Promise<Response> => {
    expect(String(input)).toBe(COPILOT_TOKEN_URL);
    return new Response(JSON.stringify({ token: "copilot-access", expires_at: new Date(Date.now() + 60_000).toISOString() }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const got = await exchangeGithubTokenForCopilot("github-oauth", { fetch: fetchFn });
  expect(got.accessToken).toBe("copilot-access");
  expect(got.expiresInSeconds).toBeGreaterThan(0);
});
