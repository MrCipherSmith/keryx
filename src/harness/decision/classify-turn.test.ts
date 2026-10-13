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

test("flow 411: null fallback never reverts to session model", async () => {
  const result = await classifyTurn("add a retry loop to the fetch call", [...CATEGORIES], {
    fallbackModel: null, sessionProvider: "anthropic", sessionModel: "claude-x",
    providerFactory: () => { throw new Error("baseline must not be called"); },
  });
  expect(result?.result.ok).toBe(false);
  expect(result?.trace).toEqual([]);
});


test("flow411: one deadline bounds two non-cooperative stages and aborts both", async () => {
  const signals: AbortSignal[] = [];
  const started = performance.now();
  const outcome = await classifyTurn("implement a retry loop", [...CATEGORIES], {
    jevEnabled: true, env: ENV_WITH_KEY, timeoutMs: 160,
    fetch: ((_: unknown, init?: RequestInit) => {
      signals.push(init!.signal!);
      return new Promise<Response>(() => {});
    }) as typeof fetch,
    fallbackModel: { providerId: "anthropic", modelId: "claude-x" },
    providerFactory: () => ({ ...factoryReplying("coding")("anthropic", "claude-x", { fetch: globalThis.fetch }),
      async *stream(_request, opts) {
        signals.push(opts.signal!);
        await new Promise<void>(() => {});
      },
    }),
  });
  expect(performance.now() - started).toBeLessThan(260);
  expect(outcome?.result.ok).toBe(false);
  expect(outcome?.trace.map(t => t.source)).toEqual(["jev", "main-model"]);
  expect(signals).toHaveLength(2);
  expect(signals.every(s => s.aborted)).toBe(true);
});

test("flow411: cancellation during JEV prevents fallback and ignores late success", async () => {
  const controller = new AbortController();
  let finish!: (response: Response) => void;
  let observed!: AbortSignal;
  const promise = classifyTurn("implement a retry loop", [...CATEGORIES], {
    jevEnabled: true, env: ENV_WITH_KEY, timeoutMs: 1000, signal: controller.signal,
    fetch: ((_: unknown, init?: RequestInit) => {
      observed = init!.signal!;
      controller.abort();
      return new Promise<Response>(resolve => { finish = resolve; });
    }) as typeof fetch,
    fallbackModel: { providerId: "anthropic", modelId: "claude-x" },
    providerFactory: () => { throw new Error("cancelled chain must not call fallback"); },
  });
  const outcome = await promise;
  expect(outcome?.result).toEqual({ ok: false, reason: "classification cancelled" });
  expect(observed.aborted).toBe(true);
  expect(outcome?.trace.map(t => t.source)).toEqual(["jev"]);
  finish(new Response(JSON.stringify({ answers: { category: { type: "choice", choice: "coding" }, confidence: { type: "noul", noul: 0.85 } }, usage: {} })));
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(outcome?.result.ok).toBe(false);
});

test("flow411: pre-cancel and zero budget start no classifier", async () => {
  const controller = new AbortController(); controller.abort();
  for (const options of [{ signal: controller.signal }, { timeoutMs: 0 }]) {
    const outcome = await classifyTurn("implement a retry loop", [...CATEGORIES], {
      ...options, fallbackModel: { providerId: "anthropic", modelId: "claude-x" },
      providerFactory: () => { throw new Error("must not start"); },
    });
    expect(outcome?.result.ok).toBe(false);
    expect(outcome?.trace).toEqual([]);
  }
});

test("flow411: cancel a hanging fallback stream promptly", async () => {
  const controller = new AbortController();
  let observed!: AbortSignal;
  const outcome = await classifyTurn("implement a retry loop", [...CATEGORIES], {
    signal: controller.signal, timeoutMs: 1000,
    fallbackModel: { providerId: "anthropic", modelId: "claude-x" },
    providerFactory: () => ({ ...factoryReplying("coding")("anthropic", "claude-x", { fetch: globalThis.fetch }),
      async *stream(_request, opts) {
        observed = opts.signal!;
        controller.abort();
        await new Promise<void>(() => {});
      },
    }),
  });
  expect(outcome?.result).toEqual({ ok: false, reason: "classification cancelled" });
  expect(observed.aborted).toBe(true);
});
