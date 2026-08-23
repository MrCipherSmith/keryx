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
    expect(balanceCapableProvider("openrouter")?.balancePath).toBe("/api/v1/credits");
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

  test("openrouter balance parse (used + total -> remaining)", async () => {
    const provider = balanceCapableProvider("openrouter");
    expect(provider).toBeDefined();
    const balance = await fetchProviderBalance(
      jsonFetch({ credits: { total: 10, used: 2.5, remaining: 7.5, currency: "USD" } }),
      provider!,
      "sk-test",
    );
    expect(balance?.total).toBe(10);
    expect(balance?.used).toBe(2.5);
    expect(balance?.remaining).toBe(7.5);
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
