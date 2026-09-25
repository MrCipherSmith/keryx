// Flow 338, AC3. Hermetic: every case uses an injected `providerFactory`,
// zero real network calls.
import { expect, test } from "bun:test";
import { MainModelTaskClassifier } from "./main-model-classifier";
import type { ProviderFactory } from "../provider/single-turn";
import type { NormalizedEvent, ProviderPort, StreamOptions } from "../provider/types";

const CATEGORIES = ["default", "review", "subagents", "quick", "coding", "planning", "docs", "unattended"] as const;

function factoryReplying(reply: string): ProviderFactory {
  return (): ProviderPort => ({
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
  });
}

test("MainModelTaskClassifier: an exact single-token reply resolves the category", async () => {
  const classifier = new MainModelTaskClassifier({ provider: "anthropic", model: "claude-x", env: {}, providerFactory: factoryReplying("quick") });
  const result = await classifier.classify("hi there, quick question", [...CATEGORIES]);
  expect(result).toMatchObject({ ok: true, category: "quick", source: "main-model" });
});

test("MainModelTaskClassifier: whitespace/casing/punctuation noise around the label is tolerated", async () => {
  const classifier = new MainModelTaskClassifier({ provider: "anthropic", model: "claude-x", env: {}, providerFactory: factoryReplying("  Review.\n") });
  const result = await classifier.classify("please review this", [...CATEGORIES]);
  expect(result).toMatchObject({ ok: true, category: "review" });
});

test("MainModelTaskClassifier: an out-of-vocabulary reply is unparseable, never a guessed category", async () => {
  const classifier = new MainModelTaskClassifier({ provider: "anthropic", model: "claude-x", env: {}, providerFactory: factoryReplying("urgent") });
  const result = await classifier.classify("task", [...CATEGORIES]);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toContain("unparseable");
});

test("MainModelTaskClassifier: an empty reply is unparseable", async () => {
  const classifier = new MainModelTaskClassifier({ provider: "anthropic", model: "claude-x", env: {}, providerFactory: factoryReplying("") });
  const result = await classifier.classify("task", [...CATEGORIES]);
  expect(result.ok).toBe(false);
});

test("MainModelTaskClassifier: no candidate categories refuses without a request", async () => {
  const classifier = new MainModelTaskClassifier({ provider: "anthropic", model: "claude-x", env: {}, providerFactory: factoryReplying("quick") });
  const result = await classifier.classify("task", []);
  expect(result).toEqual({ ok: false, reason: "no candidate categories" });
});

test("MainModelTaskClassifier: a provider error is surfaced, never a guessed category", async () => {
  const factory: ProviderFactory = () => ({
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
      yield { kind: "provider_error", sequence: 0, attemptId: opts.attemptId, error: { kind: "unknown", retryable: false, message: "boom" } };
    },
  });
  const classifier = new MainModelTaskClassifier({ provider: "anthropic", model: "claude-x", env: {}, providerFactory: factory });
  const result = await classifier.classify("task", [...CATEGORIES]);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toContain("provider error");
});
