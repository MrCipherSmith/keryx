// Flow 314, W4 Wave 4 — `buildEvalRunner` (`./model-eval-runner.ts`).
// Offline/deterministic only: every case either injects a `providerFactory`
// (no network) or exercises the fail-closed "no credential"/"unknown
// provider" paths, which never construct a real provider at all.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CatalogEntry } from "../gdskills/governance/catalog-index";
import type { ProviderFactory } from "../harness/provider/single-turn";
import type { NormalizedEvent, ProviderPort, StreamOptions } from "../harness/provider/types";
import { saveApiKey } from "../lib/shell-config";
import { buildEvalRunner, RunnerBuildError, splitRunnerSpec } from "./model-eval-runner";

function stubProvider(reply: string, capture?: { system?: string; user?: string }): ProviderPort {
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
    async *stream(request, opts: StreamOptions): AsyncIterable<NormalizedEvent> {
      if (capture !== undefined) {
        capture.system = request.systemInstruction;
        capture.user = request.messages[0]?.content ?? "";
      }
      yield { kind: "text_delta", sequence: 0, attemptId: opts.attemptId, text: reply };
      yield { kind: "model_end", sequence: 1, attemptId: opts.attemptId };
    },
  };
}

const SKILL: CatalogEntry = {
  id: "python/python-testing",
  category: "python",
  name: "python-testing",
  description: "Use when testing.",
  triggers: ["write pytest tests"],
  body: "---\nname: python-testing\n---\n\nFull SKILL.md body.\n",
  bodyLines: 4,
  sha256: "deadbeef",
  path: "/tmp/SKILL.md",
};

describe("splitRunnerSpec", () => {
  test("provider only, no colon", () => {
    expect(splitRunnerSpec("openai")).toEqual({ provider: "openai" });
  });

  test("provider:model splits at the FIRST colon", () => {
    expect(splitRunnerSpec("ollama:llama3.1:latest")).toEqual({ provider: "ollama", model: "llama3.1:latest" });
  });

  test("trailing colon with no model is treated as provider-only", () => {
    expect(splitRunnerSpec("openai:")).toEqual({ provider: "openai" });
  });
});

describe("buildEvalRunner: fail-closed construction", () => {
  test("an unknown provider name is refused before any provider is constructed", () => {
    expect(() => buildEvalRunner("not-a-real-provider")).toThrow(RunnerBuildError);
    expect(() => buildEvalRunner("not-a-real-provider")).toThrow(/unknown provider/);
  });

  test("a known provider with no credential in env is refused, not silently run against a fake provider", () => {
    expect(() => buildEvalRunner("anthropic", { env: {} })).toThrow(RunnerBuildError);
    expect(() => buildEvalRunner("anthropic", { env: {} })).toThrow(/no credential/);
  });

  test("ollama never requires a credential (local loopback)", () => {
    expect(() => buildEvalRunner("ollama", { env: {} })).not.toThrow();
  });

  test("a known provider WITH a credential in env builds without throwing", () => {
    expect(() => buildEvalRunner("anthropic", { env: { ANTHROPIC_API_KEY: "sk-test" } })).not.toThrow();
  });

  test("an injected providerFactory bypasses the credential check (test-only path)", () => {
    const factory: ProviderFactory = () => stubProvider("ok");
    expect(() => buildEvalRunner("not-a-real-provider", { env: {}, providerFactory: factory })).not.toThrow();
  });
});

// R1-9 (flow 314 review round 1): `runModelTurn` merges `envWithSavedApiKeys`
// (a key saved via `keryx shell`, `~/.local/share/keryx/auth.json`) before it
// checks credentials — the build-time check in `buildEvalRunner` used to look
// at raw `env` only, so a provider whose key was saved (not exported) was
// refused here even though the actual call would have succeeded. Every case
// injects `shellConfigDir` at a fixture directory — never the real
// `~/.local/share/keryx`.
describe("buildEvalRunner: build-time credential check honors saved auth.json keys (R1-9)", () => {
  function fixtureShellConfigDir(): string {
    return mkdtempSync(path.join(tmpdir(), "model-eval-runner-shellcfg-"));
  }

  test("a provider with no env var but a saved auth.json key is accepted, not refused", () => {
    const dir = fixtureShellConfigDir();
    try {
      saveApiKey("ANTHROPIC_API_KEY", "sk-saved-only", dir);
      expect(() => buildEvalRunner("anthropic", { env: {}, shellConfigDir: dir })).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no env var and no saved key is still refused", () => {
    const dir = fixtureShellConfigDir();
    try {
      expect(() => buildEvalRunner("anthropic", { env: {}, shellConfigDir: dir })).toThrow(RunnerBuildError);
      expect(() => buildEvalRunner("anthropic", { env: {}, shellConfigDir: dir })).toThrow(/no credential/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("buildEvalRunner: the built Runner", () => {
  test("runs one single-turn completion with the skill's full SKILL.md as system and the scenario prompt as user", async () => {
    const capture: { system?: string; user?: string } = {};
    const factory: ProviderFactory = () => stubProvider("the model said this", capture);
    const runner = buildEvalRunner("anthropic", { env: {}, providerFactory: factory });

    const result = await runner("does this handle empty input?", SKILL);

    expect(result).toEqual({ output: "the model said this" });
    expect(capture.system).toBe(SKILL.body);
    expect(capture.user).toBe("does this handle empty input?");
  });

  test("splits provider:model and passes the model through to the provider turn", async () => {
    let seenModel: string | undefined;
    const factory: ProviderFactory = (_name, model) => {
      seenModel = model;
      return stubProvider("ok");
    };
    const runner = buildEvalRunner("ollama:llama3.1:latest", { env: {}, providerFactory: factory });
    await runner("prompt", SKILL);
    expect(seenModel).toBe("llama3.1:latest");
  });

  // R1-8 (flow 314 review round 1): a stream that yields only `model_end`
  // (no `text_delta` at all — a reasoning-only or truncated stream) assembles
  // to an empty string with no `error` set. That used to return `{ output:
  // "" }` as if the model genuinely answered with nothing, which a weak
  // `not-contains` grader could misread as a real pass (R1-2).
  test("a stub provider yielding only model_end (empty completion) throws RunnerBuildError, not a fabricated empty pass", async () => {
    const factory: ProviderFactory = () => ({
      describe: stubProvider("").describe,
      async *stream(_request, opts: StreamOptions): AsyncIterable<NormalizedEvent> {
        yield { kind: "model_end", sequence: 0, attemptId: opts.attemptId };
      },
    });
    const runner = buildEvalRunner("anthropic", { env: {}, providerFactory: factory });
    await expect(runner("prompt", SKILL)).rejects.toThrow(RunnerBuildError);
    await expect(runner("prompt", SKILL)).rejects.toThrow(/empty completion/);
  });

  // Whitespace-only output is the same failure mode as a genuinely empty
  // string — a `not-contains` grader would pass it too.
  test("whitespace-only output is treated the same as empty (throws, not a fabricated pass)", async () => {
    const factory: ProviderFactory = () => stubProvider("   \n\t  ");
    const runner = buildEvalRunner("anthropic", { env: {}, providerFactory: factory });
    await expect(runner("prompt", SKILL)).rejects.toThrow(/empty completion/);
  });

  test("a provider_error event surfaces as a thrown RunnerBuildError, not a fabricated pass", async () => {
    const factory: ProviderFactory = () => ({
      describe: stubProvider("").describe,
      async *stream(_request, opts: StreamOptions): AsyncIterable<NormalizedEvent> {
        yield {
          kind: "provider_error",
          sequence: 0,
          attemptId: opts.attemptId,
          error: { kind: "unknown", retryable: false, message: "boom" },
        };
      },
    });
    const runner = buildEvalRunner("anthropic", { env: {}, providerFactory: factory });
    await expect(runner("prompt", SKILL)).rejects.toThrow(/boom/);
  });
});
