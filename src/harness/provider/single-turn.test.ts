import { describe, expect, test } from "bun:test";
import {
  defaultModelFor,
  hasCredential,
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
});
