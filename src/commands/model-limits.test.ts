import { describe, expect, test } from "bun:test";
import {
  extractContextWindow,
  extractOllamaContextWindow,
  findModelEntry,
  formatRateLimit,
  loadSessionLimits,
  parseRateLimitHeaders,
} from "./model-limits";

describe("extractContextWindow", () => {
  test("reads common `/models` keys and nested OpenRouter shapes", () => {
    expect(extractContextWindow({ context_length: 131072 })).toBe(131072);
    expect(extractContextWindow({ context_window: "32768" })).toBe(32768);
    expect(extractContextWindow({ max_model_len: 8192 })).toBe(8192);
    expect(extractContextWindow({ top_provider: { context_length: 200000 } })).toBe(200000);
    expect(extractContextWindow({ architecture: { max_input_tokens: 64000 } })).toBe(64000);
  });

  test("does not treat max_tokens or junk as a window", () => {
    expect(extractContextWindow({ max_tokens: 4096 })).toBeUndefined();
    expect(extractContextWindow({ context_length: 0 })).toBeUndefined();
    expect(extractContextWindow({ context_length: -1 })).toBeUndefined();
    expect(extractContextWindow(null)).toBeUndefined();
    expect(extractContextWindow("128000")).toBeUndefined();
  });
});

describe("findModelEntry", () => {
  const data = [{ id: "openai/gpt-4o-mini" }, { id: "deepseek-chat" }, { name: "llama3.1:latest" }];

  test("matches exact id and org/name suffix", () => {
    expect(entryId(findModelEntry(data, "deepseek-chat"))).toBe("deepseek-chat");
    expect(entryId(findModelEntry(data, "openai/gpt-4o-mini"))).toBe("openai/gpt-4o-mini");
    expect(entryId(findModelEntry(data, "gpt-4o-mini"))).toBe("openai/gpt-4o-mini");
    expect(entryId(findModelEntry(data, "llama3.1:latest"))).toBe("llama3.1:latest");
  });

  test("unknown model is absent, not the first row", () => {
    expect(findModelEntry(data, "nope")).toBeUndefined();
    expect(findModelEntry(data, "")).toBeUndefined();
  });
});

function entryId(entry: unknown): string {
  if (typeof entry !== "object" || entry === null) {
    return "";
  }
  const rec = entry as { id?: unknown; name?: unknown };
  return typeof rec.id === "string" ? rec.id : typeof rec.name === "string" ? rec.name : "";
}

describe("extractOllamaContextWindow", () => {
  test("prefers configured num_ctx over architecture context_length", () => {
    expect(
      extractOllamaContextWindow({
        parameters: "num_ctx                        8192\nstop [INST]",
        model_info: { "llama.context_length": 131072 },
      }),
    ).toBe(8192);
  });

  test("falls back to model_info *.context_length", () => {
    expect(extractOllamaContextWindow({ model_info: { "qwen2.context_length": 32768 } })).toBe(32768);
  });
});

describe("parseRateLimitHeaders", () => {
  test("reads OpenAI-style headers and ignores an empty set", () => {
    const headers = new Headers({
      "x-ratelimit-limit-requests": "60",
      "x-ratelimit-remaining-requests": "12",
      "x-ratelimit-limit-tokens": "100000",
      "x-ratelimit-remaining-tokens": "80000",
      "x-ratelimit-reset-requests": "2s",
    });
    expect(parseRateLimitHeaders(headers)).toEqual({
      requestsLimit: 60,
      requestsRemaining: 12,
      tokensLimit: 100000,
      tokensRemaining: 80000,
      reset: "2s",
    });
    expect(parseRateLimitHeaders(new Headers())).toBeUndefined();
  });

  test("formatRateLimit stays quiet when nothing was reported", () => {
    expect(formatRateLimit(undefined)).toBeUndefined();
    expect(formatRateLimit({ requestsRemaining: 12, requestsLimit: 60 })).toBe("12/60 requests");
  });
});

function jsonFetch(body: unknown, headers?: Record<string, string>, ok = true): typeof fetch {
  const fn = async (): Promise<Response> =>
    new Response(JSON.stringify(body), {
      status: ok ? 200 : 500,
      headers: { "content-type": "application/json", ...(headers ?? {}) },
    });
  return fn as unknown as typeof fetch;
}

describe("loadSessionLimits", () => {
  test("compat `/models` yields the matching window and optional rate-limit headers", async () => {
    const limits = await loadSessionLimits({
      provider: "openrouter",
      model: "gpt-4o-mini",
      fetch: jsonFetch(
        { data: [{ id: "openai/gpt-4o-mini", context_length: 128000 }, { id: "other", context_length: 4096 }] },
        { "x-ratelimit-limit-requests": "20", "x-ratelimit-remaining-requests": "19" },
      ),
      env: { OPENROUTER_API_KEY: "sk-test" },
    });
    expect(limits.contextWindow).toBe(128000);
    expect(limits.contextSource).toBe("live-models");
    expect(limits.rateLimit?.requestsRemaining).toBe(19);
  });

  test("unknown provider / failed fetch does not invent a window", async () => {
    const none = await loadSessionLimits({
      provider: "anthropic",
      model: "claude-sonnet-5",
      fetch: jsonFetch({ data: [{ id: "x", context_length: 200000 }] }),
      env: {},
    });
    expect(none.contextWindow).toBeUndefined();
    expect(none.contextSource).toBeUndefined();

    const down = await loadSessionLimits({
      provider: "groq",
      model: "llama-3.1-8b-instant",
      fetch: jsonFetch({}, undefined, false),
      env: { GROQ_API_KEY: "k" },
    });
    expect(down.contextWindow).toBeUndefined();
  });

  test("ollama `/api/show` is used and private non-loopback is skipped", async () => {
    let called = 0;
    const fetchFn = (async (url: string) => {
      called += 1;
      expect(url).toContain("/api/show");
      return new Response(JSON.stringify({ model_info: { "llama.context_length": 131072 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const limits = await loadSessionLimits({
      provider: "ollama",
      model: "llama3.1:latest",
      fetch: fetchFn,
      env: {},
    });
    expect(limits.contextWindow).toBe(131072);
    expect(limits.contextSource).toBe("ollama-show");
    expect(called).toBe(1);

    const skipped = await loadSessionLimits({
      provider: "ollama",
      model: "llama3.1:latest",
      baseUrl: "http://192.168.1.10:11434",
      fetch: fetchFn,
      env: {},
    });
    expect(skipped.contextWindow).toBeUndefined();
    expect(called).toBe(1);
  });

  test("deepseek also fetches balance when the endpoint answers", async () => {
    const fetchFn = (async (url: string) => {
      if (url.includes("/user/balance")) {
        return new Response(
          JSON.stringify({
            is_available: true,
            balance_infos: [{ currency: "USD", total_balance: "6.19" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ data: [{ id: "deepseek-chat", context_length: 64000 }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const limits = await loadSessionLimits({
      provider: "deepseek",
      model: "deepseek-chat",
      fetch: fetchFn,
      env: { DEEPSEEK_API_KEY: "sk-ds" },
    });
    expect(limits.contextWindow).toBe(64000);
    expect(limits.balance?.total).toBe(6.19);
  });
});
