import { describe, expect, test } from "bun:test";
import {
  defaultModelFor,
  hasCredential,
  keyedProviderCandidates,
  resolveAutoProvider,
  runModelTurn,
  type ProviderFactory,
} from "./single-turn";
import type { NormalizedEvent, ProviderPort, StreamOptions } from "./types";

function stubProvider(reply: string): ProviderPort {
  return {
    describe() {
      return {
        capabilities: {
          streaming: true,
          toolCalls: false,
          parallelToolCalls: false,
          structuredOutput: false,
          reasoningMetadata: false,
          promptCaching: false,
          vision: false,
          tokenCounting: false,
          modelListing: false,
        },
        descriptor: { providerId: "stub" },
      };
    },
    async *stream(_request, opts: StreamOptions): AsyncIterable<NormalizedEvent> {
      yield { kind: "text_delta", sequence: 0, attemptId: opts.attemptId, text: reply };
      yield { kind: "model_end", sequence: 1, attemptId: opts.attemptId };
    },
  };
}

describe("runModelTurn", () => {
  test("assembles text from an injected provider", async () => {
    const factory: ProviderFactory = () => stubProvider("hello world");
    const result = await runModelTurn({
      system: "s",
      user: "u",
      provider: "anthropic",
      env: {}, // no keys — factory still runs when injected
      preferSavedShell: false,
      providerFactory: factory,
      requestId: "t1",
    });
    expect(result.credentialAvailable).toBe(false); // injected, no real key
    expect(result.text).toBe("hello world");
    expect(result.error).toBeUndefined();
  });

  test("fail-closed without credential and without factory", async () => {
    const result = await runModelTurn({
      provider: "anthropic",
      system: "s",
      user: "u",
      env: {},
      requestId: "t2",
    });
    expect(result.credentialAvailable).toBe(false);
    expect(result.text).toBe("");
    expect(result.error).toBeUndefined();
  });

  test("surfaces a provider error", async () => {
    const factory: ProviderFactory = () => ({
      describe: stubProvider("x").describe,
      async *stream(_request, opts: StreamOptions): AsyncIterable<NormalizedEvent> {
        yield {
          kind: "provider_error",
          sequence: 0,
          attemptId: opts.attemptId,
          error: { kind: "overloaded", retryable: true, message: "busy" },
        };
      },
    });
    const result = await runModelTurn({
      system: "s",
      user: "u",
      provider: "anthropic",
      env: {},
      preferSavedShell: false,
      providerFactory: factory,
      requestId: "t3",
    });
    expect(result.error?.kind).toBe("overloaded");
    expect(result.text).toBe("");
  });

  test("defaultModelFor + hasCredential", () => {
    expect(defaultModelFor("anthropic")).toContain("claude");
    expect(defaultModelFor("grok")).toBe("grok-2-latest");
    expect(hasCredential("ollama", {})).toBe(true);
    expect(hasCredential("anthropic", {})).toBe(false);
    expect(hasCredential("openrouter", { OPENROUTER_API_KEY: "k" })).toBe(true);
  });

  // flow 183: openai/gemini must be recognised the same way anthropic is —
  // review found this was silently missing (auto-detection dead for both).
  test("defaultModelFor + hasCredential recognise openai/gemini", () => {
    expect(defaultModelFor("openai")).toContain("gpt-5.6");
    expect(defaultModelFor("gemini")).toContain("gemini-2.5");
    expect(hasCredential("openai", {})).toBe(false);
    expect(hasCredential("openai", { OPENAI_API_KEY: "sk-test" })).toBe(true);
    expect(hasCredential("gemini", {})).toBe(false);
    expect(hasCredential("gemini", { GEMINI_API_KEY: "k" })).toBe(true);
    // GOOGLE_API_KEY fallback when GEMINI_API_KEY is absent.
    expect(hasCredential("gemini", { GOOGLE_API_KEY: "k" })).toBe(true);
  });

  test("keyedProviderCandidates includes openai and gemini", () => {
    const candidates = keyedProviderCandidates();
    expect(candidates).toContain("openai");
    expect(candidates).toContain("gemini");
  });

  test("resolveAutoProvider prefers keyed credentials, not ollama-by-default", () => {
    // No keys → legacy fallback name (fail-closed later).
    expect(resolveAutoProvider({}, { preferSavedShell: false }).provider).toBe("anthropic");
    // DeepSeek key wins over anthropic default.
    expect(
      resolveAutoProvider({ DEEPSEEK_API_KEY: "sk-ds" }, { preferSavedShell: false }).provider,
    ).toBe("deepseek");
    // Anthropic key when present.
    expect(
      resolveAutoProvider({ ANTHROPIC_API_KEY: "sk-ant" }, { preferSavedShell: false }).provider,
    ).toBe("anthropic");
  });

  test("C-02: saved-shell resolution failure falls through to deterministic candidates", () => {
    expect(resolveAutoProvider({}, { preferSavedShell: false })).toEqual({ provider: "anthropic" });
    expect(resolveAutoProvider({ OPENAI_API_KEY: "fixture-key" }, { preferSavedShell: false }).provider).toBe("openai");
  });

  test("runModelTurn without --provider uses auto provider from env keys", async () => {
    const seen: string[] = [];
    const factory: ProviderFactory = (name) => {
      seen.push(name);
      return stubProvider(`via ${name}`);
    };
    const result = await runModelTurn({
      system: "s",
      user: "u",
      env: { DEEPSEEK_API_KEY: "sk-test" },
      preferSavedShell: false,
      providerFactory: factory,
      requestId: "t-auto",
    });
    expect(result.provider).toBe("deepseek");
    expect(seen[0]).toBe("deepseek");
    expect(result.text).toBe("via deepseek");
  });
});

describe("runModelTurn instrumentation", () => {
  test("collects usage, reasoning flag and first-byte latency", async () => {
    const factory: ProviderFactory = () => ({
      describe: stubProvider("x").describe,
      async *stream(_request, opts: StreamOptions): AsyncIterable<NormalizedEvent> {
        yield { kind: "reasoning_delta", sequence: 0, attemptId: opts.attemptId, text: "think" };
        yield { kind: "usage_update", sequence: 1, attemptId: opts.attemptId, usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12, exact: true } };
        yield { kind: "text_delta", sequence: 2, attemptId: opts.attemptId, text: "4" };
        yield { kind: "model_end", sequence: 3, attemptId: opts.attemptId };
      },
    });
    const result = await runModelTurn({
      system: "s",
      user: "u",
      provider: "anthropic",
      env: {},
      preferSavedShell: false,
      providerFactory: factory,
      requestId: "t-usage",
    });
    expect(result.text).toBe("4");
    expect(result.reasoning).toBe(true);
    expect(result.usage?.inputTokens).toBe(10);
    expect(result.usage?.outputTokens).toBe(2);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });
});
