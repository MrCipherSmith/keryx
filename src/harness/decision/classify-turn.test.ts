// Flow 338, AC5. Hermetic: fake `fetch` for Jev, injected `providerFactory`
// for the main-model classifier, zero real network calls.
import { expect, test } from "bun:test";
import { classifyTurn } from "./classify-turn";
import type { ProviderFactory } from "../provider/single-turn";
import type { NormalizedEvent, ProviderPort, StreamOptions } from "../provider/types";

const CATEGORIES = ["default", "review", "subagents", "quick", "coding", "planning", "docs", "unattended"] as const;
const ENV_WITH_KEY = { OPENROUTER_API_KEY: "sk-or-test" } as const;

function fakeFetch(body: unknown, status = 200): typeof fetch {
  return (async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
}

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

test("classifyTurn: a slash command is never classified", async () => {
  const outcome = await classifyTurn("/route on", [...CATEGORIES]);
  expect(outcome).toBeUndefined();
});

test("classifyTurn: an empty category list is never classified", async () => {
  const outcome = await classifyTurn("do the thing", []);
  expect(outcome).toBeUndefined();
});

test("classifyTurn: a deterministic shortcut short-circuits — no classifier stage is tried", async () => {
  const outcome = await classifyTurn("hi", [...CATEGORIES], {
    jevEnabled: true,
    env: ENV_WITH_KEY,
    fetch: (() => {
      throw new Error("must not be called — deterministic shortcut should short-circuit");
    }) as unknown as typeof fetch,
  });
  expect(outcome?.result).toMatchObject({ ok: true, category: "quick", source: "deterministic" });
  expect(outcome?.trace.map((t) => t.source)).toEqual(["deterministic"]);
});

test("classifyTurn: Jev enabled and credentialed decides the category", async () => {
  const fetchFn = fakeFetch({
    answers: { category: { type: "choice", choice: "coding" }, confidence: { type: "noul", noul: 0.85 } },
    usage: {},
  });
  const outcome = await classifyTurn("add a retry loop to the fetch call", [...CATEGORIES], { jevEnabled: true, env: ENV_WITH_KEY, fetch: fetchFn });
  expect(outcome?.result).toMatchObject({ ok: true, category: "coding", source: "jev" });
  expect(outcome?.trace.map((t) => t.source)).toEqual(["jev"]);
});

test("classifyTurn: Jev disabled (opt-out) skips straight to the main-model classifier", async () => {
  const outcome = await classifyTurn("add a retry loop to the fetch call", [...CATEGORIES], {
    jevEnabled: false,
    env: {},
    sessionProvider: "anthropic",
    sessionModel: "claude-x",
    providerFactory: factoryReplying("coding"),
  });
  expect(outcome?.result).toMatchObject({ ok: true, category: "coding", source: "main-model" });
  expect(outcome?.trace.map((t) => t.source)).toEqual(["main-model"]);
});

test("classifyTurn: a Jev failure falls through to the main-model classifier", async () => {
  const fetchFn = fakeFetch({}, 500);
  const outcome = await classifyTurn("add a retry loop to the fetch call", [...CATEGORIES], {
    jevEnabled: true,
    env: ENV_WITH_KEY,
    fetch: fetchFn,
    sessionProvider: "anthropic",
    sessionModel: "claude-x",
    providerFactory: factoryReplying("coding"),
  });
  expect(outcome?.result).toMatchObject({ ok: true, category: "coding", source: "main-model" });
  expect(outcome?.trace.map((t) => t.source)).toEqual(["jev", "main-model"]);
});

test("classifyTurn: every stage failing falls through to no classification", async () => {
  const fetchFn = fakeFetch({}, 500);
  const outcome = await classifyTurn("add a retry loop to the fetch call", [...CATEGORIES], {
    jevEnabled: true,
    env: ENV_WITH_KEY,
    fetch: fetchFn,
    sessionProvider: "anthropic",
    sessionModel: "claude-x",
    providerFactory: factoryReplying(""),
  });
  expect(outcome?.result).toEqual({ ok: false, reason: "no classifier configured" });
  expect(outcome?.trace.map((t) => t.source)).toEqual(["jev", "main-model"]);
});

test("classifyTurn: a hanging classifier stage times out and falls through, never hanging the caller", async () => {
  const hangingFetch = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
  const start = Date.now();
  const outcome = await classifyTurn("add a retry loop to the fetch call", [...CATEGORIES], {
    jevEnabled: true,
    env: ENV_WITH_KEY,
    fetch: hangingFetch,
    timeoutMs: 50,
    sessionProvider: "anthropic",
    sessionModel: "claude-x",
    providerFactory: factoryReplying("coding"),
  });
  expect(Date.now() - start).toBeLessThan(2000);
  expect(outcome?.trace[0]).toMatchObject({ source: "jev", result: { ok: false } });
  if (outcome?.trace[0]?.result.ok === false) expect(outcome.trace[0].result.reason).toContain("timed out");
  expect(outcome?.result).toMatchObject({ ok: true, category: "coding", source: "main-model" });
});

test("classifyTurn: no Jev credential skips Jev even when jevEnabled is true", async () => {
  const outcome = await classifyTurn("add a retry loop to the fetch call", [...CATEGORIES], {
    jevEnabled: true,
    env: {},
    sessionProvider: "anthropic",
    sessionModel: "claude-x",
    providerFactory: factoryReplying("coding"),
  });
  expect(outcome?.trace.map((t) => t.source)).toEqual(["main-model"]);
});
