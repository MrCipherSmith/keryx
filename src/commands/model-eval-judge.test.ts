// Flow 316, T6 — `buildEvalJudge` (`./model-eval-judge.ts`). Offline/
// deterministic only: every case injects a `providerFactory` (no network) or
// exercises the fail-closed "no credential"/"unknown provider" paths, which
// never construct a real provider at all.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { JudgeRequest } from "../gdskills/governance/judge";
import type { ProviderFactory } from "../harness/provider/single-turn";
import type { NormalizedEvent, ProviderPort, StreamOptions } from "../harness/provider/types";
import { saveApiKey } from "../lib/shell-config";
import { buildEvalJudge, JudgeBuildError } from "./model-eval-judge";
import { RunnerBuildError } from "./model-eval-runner";

function stubProvider(reply: string | (() => string), capture?: { system?: string; user?: string; requestId?: string }): ProviderPort {
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
        capture.requestId = request.requestId;
      }
      const text = typeof reply === "function" ? reply() : reply;
      yield { kind: "text_delta", sequence: 0, attemptId: opts.attemptId, text };
      yield { kind: "model_end", sequence: 1, attemptId: opts.attemptId };
    },
  };
}

const REQUEST: JudgeRequest = {
  scenarioId: "s1",
  prompt: "Explain how to safely delete a git branch that has unmerged work.",
  answer: "Run `git branch -d feature-x`. If it has unmerged commits git refuses.",
  expectation: {
    grader: "judge",
    rubric: "A correct answer uses a safe (non-force) delete.",
    pass_criteria: ["Uses git branch -d, not -D"],
  },
};

describe("buildEvalJudge: fail-closed construction", () => {
  test("an unknown provider name is refused before any provider is constructed", () => {
    expect(() => buildEvalJudge("not-a-real-provider")).toThrow(JudgeBuildError);
    expect(() => buildEvalJudge("not-a-real-provider")).toThrow(/unknown provider/);
  });

  test("JudgeBuildError is a RunnerBuildError (existing --runner catch handling also catches --judge failures)", () => {
    try {
      buildEvalJudge("not-a-real-provider");
      throw new Error("expected buildEvalJudge to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(RunnerBuildError);
      expect(error).toBeInstanceOf(JudgeBuildError);
    }
  });

  test("a known provider with no credential in env is refused, not silently run against a fake provider", () => {
    expect(() => buildEvalJudge("deepseek", { env: {} })).toThrow(JudgeBuildError);
    expect(() => buildEvalJudge("deepseek", { env: {} })).toThrow(/no credential/);
  });

  test("ollama never requires a credential (local loopback)", () => {
    expect(() => buildEvalJudge("ollama", { env: {} })).not.toThrow();
  });

  test("a known provider WITH a credential in env builds without throwing", () => {
    expect(() => buildEvalJudge("anthropic", { env: { ANTHROPIC_API_KEY: "sk-test" } })).not.toThrow();
  });

  test("an injected providerFactory bypasses the credential check (test-only path)", () => {
    const factory: ProviderFactory = () => stubProvider('{"verdict":"pass","reason":"ok"}');
    expect(() => buildEvalJudge("not-a-real-provider", { env: {}, providerFactory: factory })).not.toThrow();
  });

  test("build-time credential check honors saved auth.json keys, mirroring buildEvalRunner's own R1-9 fix", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "model-eval-judge-shellcfg-"));
    try {
      saveApiKey("ANTHROPIC_API_KEY", "sk-saved-only", dir);
      expect(() => buildEvalJudge("anthropic", { env: {}, shellConfigDir: dir })).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("buildEvalJudge: the built Judge", () => {
  test("builds the system/user prompt from buildJudgePrompt and returns the parsed verdict", async () => {
    const capture: { system?: string; user?: string; requestId?: string } = {};
    const factory: ProviderFactory = () => stubProvider('{"verdict":"pass","reason":"uses -d, warns about unmerged"}', capture);
    const judge = buildEvalJudge("anthropic", { env: {}, providerFactory: factory, skillId: "core/git-branches" });

    const verdict = await judge(REQUEST);

    expect(verdict).toEqual({ verdict: "pass", reason: "uses -d, warns about unmerged" });
    expect(capture.system).toContain("grading judge");
    expect(capture.user).toContain(REQUEST.prompt);
    expect(capture.user).toContain(REQUEST.answer);
  });

  test("stamps requestId as skills-eval-judge-<skillId>, distinct from the runner's own stem", async () => {
    const capture: { requestId?: string } = {};
    const factory: ProviderFactory = () => stubProvider('{"verdict":"fail","reason":"nope"}', capture);
    const judge = buildEvalJudge("anthropic", { env: {}, providerFactory: factory, skillId: "core/git-branches" });
    await judge(REQUEST);
    expect(capture.requestId).toBe("skills-eval-judge-core/git-branches");
  });

  test("an unparseable reply is retried once, and the retry's good verdict is used", async () => {
    let calls = 0;
    const factory: ProviderFactory = () =>
      stubProvider(() => {
        calls += 1;
        return calls === 1 ? "not json at all" : '{"verdict":"pass","reason":"second try"}';
      });
    const judge = buildEvalJudge("anthropic", { env: {}, providerFactory: factory });

    const verdict = await judge(REQUEST);

    expect(calls).toBe(2);
    expect(verdict).toEqual({ verdict: "pass", reason: "second try" });
  });

  test("an empty completion is retried once, and the retry's good verdict is used", async () => {
    let calls = 0;
    const factory: ProviderFactory = () =>
      stubProvider(() => {
        calls += 1;
        return calls === 1 ? "   " : '{"verdict":"fail","reason":"empty then real"}';
      });
    const judge = buildEvalJudge("anthropic", { env: {}, providerFactory: factory });

    const verdict = await judge(REQUEST);

    expect(calls).toBe(2);
    expect(verdict).toEqual({ verdict: "fail", reason: "empty then real" });
  });

  test("two unparseable replies in a row report fail with error set, never a fabricated pass", async () => {
    let calls = 0;
    const factory: ProviderFactory = () =>
      stubProvider(() => {
        calls += 1;
        return "still not json";
      });
    const judge = buildEvalJudge("anthropic", { env: {}, providerFactory: factory });

    const verdict = await judge(REQUEST);

    expect(calls).toBe(2);
    expect(verdict.verdict).toBe("fail");
    expect(verdict.reason).toBe("judge returned an unparseable verdict");
    expect(verdict.error).toBeDefined();
  });

  test("two empty completions in a row report fail with error set", async () => {
    const factory: ProviderFactory = () => stubProvider("");
    const judge = buildEvalJudge("anthropic", { env: {}, providerFactory: factory });

    const verdict = await judge(REQUEST);

    expect(verdict.verdict).toBe("fail");
    expect(verdict.reason).toBe("judge returned an unparseable verdict");
    expect(verdict.error).toBe("judge returned an empty completion");
  });

  test("a provider_error event throws immediately, not retried, not folded into a fabricated fail verdict", async () => {
    let calls = 0;
    const factory: ProviderFactory = () => ({
      describe: stubProvider("").describe,
      async *stream(_request, opts: StreamOptions): AsyncIterable<NormalizedEvent> {
        calls += 1;
        yield {
          kind: "provider_error",
          sequence: 0,
          attemptId: opts.attemptId,
          error: { kind: "unknown", retryable: false, message: "boom" },
        };
      },
    });
    const judge = buildEvalJudge("anthropic", { env: {}, providerFactory: factory });

    await expect(judge(REQUEST)).rejects.toThrow(JudgeBuildError);
    await expect(judge(REQUEST)).rejects.toThrow(/boom/);
    expect(calls).toBe(2); // one stream() per rejects.toThrow() assertion above, no internal retry either time
  });

  test("splits provider:model and passes the model through to the provider turn", async () => {
    let seenModel: string | undefined;
    const factory: ProviderFactory = (_name, model) => {
      seenModel = model;
      return stubProvider('{"verdict":"pass","reason":"ok"}');
    };
    const judge = buildEvalJudge("deepseek:deepseek-chat", { env: {}, providerFactory: factory });
    await judge(REQUEST);
    expect(seenModel).toBe("deepseek-chat");
  });
});
