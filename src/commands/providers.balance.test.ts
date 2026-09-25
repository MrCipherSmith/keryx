import { describe, expect, test } from "bun:test";
import {
  balanceCapableProvider,
  fetchProviderBalance,
  providerApiKey,
} from "./providers";

function jsonFetch(body: unknown, ok = true): typeof fetch {
  const fn = async (): Promise<Response> =>
    new Response(JSON.stringify(body), {
      status: ok ? 200 : 500,
      headers: { "content-type": "application/json" },
    });
  return fn as unknown as typeof fetch;
}

describe("balance capability", () => {
  test("deepseek and openrouter expose balance endpoints", () => {
    expect(balanceCapableProvider("deepseek")?.balancePath).toBe("/user/balance");
    expect(balanceCapableProvider("openrouter")?.balancePath).toBe("/v1/key");
    expect(balanceCapableProvider("zai")).toBeUndefined();
    expect(balanceCapableProvider("groq")).toBeUndefined();
    expect(balanceCapableProvider("grok")).toBeUndefined();
  });

  test("deepseek balance parse", async () => {
    const provider = balanceCapableProvider("deepseek");
    expect(provider).toBeDefined();
    const balance = await fetchProviderBalance(
      jsonFetch({ is_available: true, balance_infos: [{ currency: "USD", total_balance: "6.19", granted_balance: "0.00", topped_up_balance: "6.19" }] }),
      provider!,
      "sk-test",
    );
    expect(balance?.currency).toBe("USD");
    expect(balance?.total).toBe(6.19);
    expect(balance?.exact).toBe(true);
  });

  test("openrouter balance parse: /v1/key with a limit -> remaining = limit_remaining", async () => {
    const provider = balanceCapableProvider("openrouter");
    expect(provider).toBeDefined();
    const balance = await fetchProviderBalance(
      jsonFetch({ data: { limit: 10, usage: 2.5, limit_remaining: 7.5 } }),
      provider!,
      "sk-test",
    );
    expect(balance?.currency).toBe("USD");
    expect(balance?.total).toBe(10);
    expect(balance?.used).toBe(2.5);
    expect(balance?.remaining).toBe(7.5);
    expect(balance?.exact).toBe(true);
  });

  test("openrouter balance parse: /v1/key with no limit (unlimited) falls back to /v1/credits -> remaining = total_credits - total_usage", async () => {
    const provider = balanceCapableProvider("openrouter");
    expect(provider).toBeDefined();
    const calls: string[] = [];
    const fetchFn = (async (url: string) => {
      calls.push(url);
      if (url.endsWith("/v1/key")) {
        return new Response(JSON.stringify({ data: { limit: null, usage: 2.5, limit_remaining: null } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ data: { total_credits: 55, total_usage: 45.19 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const balance = await fetchProviderBalance(fetchFn, provider!, "sk-test");
    expect(balance?.total).toBe(55);
    expect(balance?.used).toBe(45.19);
    expect(balance?.remaining).toBeCloseTo(9.81, 5);
    // Both endpoints were hit — the key call first, then the credits fallback.
    expect(calls.some((u) => u.endsWith("/v1/key"))).toBe(true);
    expect(calls.some((u) => u.endsWith("/v1/credits"))).toBe(true);
  });

  test("no balance endpoint -> undefined, non-2xx -> undefined", async () => {
    const zai = balanceCapableProvider("zai");
    expect(zai).toBeUndefined();
    const deepseek = balanceCapableProvider("deepseek")!;
    const bad = await fetchProviderBalance(jsonFetch({}, false), deepseek, "k");
    expect(bad).toBeUndefined();
  });

  test("providerApiKey resolves the env key", () => {
    const deepseek = balanceCapableProvider("deepseek")!;
    expect(providerApiKey(deepseek, { DEEPSEEK_API_KEY: "sk-ds" })).toBe("sk-ds");
    expect(providerApiKey(deepseek, {})).toBeUndefined();
  });
});
