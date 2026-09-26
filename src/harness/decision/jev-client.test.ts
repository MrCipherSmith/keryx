// Flow 306, Phase 0 (AC1-AC5): the Jev client, driven entirely through an
// injected fake `fetch`. No test in this file opens a real socket.

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { saveShellConfig } from "../../lib/shell-config";
import { ExternalBlockedError } from "../../lib/external-switch";
import {
  callJevSystemOne,
  DEFAULT_JEV_MODEL,
  DEFAULT_JEV_TIMEOUT_MS,
  JEV_ENDPOINT,
  JEV_MAX_ATTEMPTS,
  JEV_MODEL_1_13,
  JEV_MODEL_LATEST,
  JEV_RETRY_AFTER_CAP_MS,
  JEV_TOKEN_BUDGET,
  JevAnswerValidationError,
  JevAuthRejectedError,
  JevBudgetError,
  JevCredentialError,
  JevNetworkError,
  JevRequestError,
  JevResponseParseError,
  JevResponseShapeError,
  JevTimeoutError,
  preflightBudget,
  resolveJevApiKey,
  resolveJevApiKeyResolution,
  type JevQuestions,
} from "./jev-client";

const ENV_WITH_KEY = { OPENROUTER_API_KEY: "sk-or-test" } as const;

function fakeFetch(body: unknown, status = 200): typeof fetch {
  const fn = async (url: string, init?: RequestInit): Promise<Response> => {
    (fn as unknown as { calls: unknown[] }).calls.push({ url, init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  (fn as unknown as { calls: unknown[] }).calls = [];
  return fn as unknown as typeof fetch;
}

const ONE_QUESTION: JevQuestions = { warranted: { type: "noul", instructions: "is this warranted?" } };

describe("AC1/AC4: shape and model constants", () => {
  test("JEV_MODEL_1_13 and JEV_MODEL_LATEST are named constants; DEFAULT_JEV_MODEL is one of them", () => {
    expect(JEV_MODEL_1_13).toBe("jev-1.13");
    expect(JEV_MODEL_LATEST).toBe("jev-latest");
    expect([JEV_MODEL_1_13, JEV_MODEL_LATEST]).toContain(DEFAULT_JEV_MODEL);
  });

  test("success: posts to the systemone endpoint and returns {answers, usage}", async () => {
    const fetchFn = fakeFetch({
      id: "r1",
      model: DEFAULT_JEV_MODEL,
      provider: "typesafe",
      answers: { warranted: { type: "noul", noul: 0.87 } },
      usage: { input_tokens: 120, output_tokens: 0, cost: 0.000005 },
    });
    const result = await callJevSystemOne(fetchFn, { state: "some state", questions: ONE_QUESTION }, { env: ENV_WITH_KEY });
    expect(result.answers.warranted).toEqual({ type: "noul", noul: 0.87 });
    expect(result.usage).toEqual({ input_tokens: 120, output_tokens: 0, cost: 0.000005 });
    const calls = (fetchFn as unknown as { calls: { url: string; init: RequestInit }[] }).calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(JEV_ENDPOINT);
    expect(calls[0]?.init.method).toBe("POST");
    const sentHeaders = calls[0]?.init.headers as Record<string, string>;
    expect(sentHeaders.authorization).toBe("Bearer sk-or-test");
    const sentBody = JSON.parse(calls[0]?.init.body as string) as { model: string; state: string; questions: unknown };
    expect(sentBody.model).toBe(DEFAULT_JEV_MODEL);
    expect(sentBody.state).toBe("some state");
  });

  test("a caller-named model is sent verbatim", async () => {
    const fetchFn = fakeFetch({ id: "r1", answers: { warranted: { type: "noul", noul: 0.1 } }, usage: {} });
    await callJevSystemOne(fetchFn, { model: JEV_MODEL_LATEST, state: "s", questions: ONE_QUESTION }, { env: ENV_WITH_KEY });
    const calls = (fetchFn as unknown as { calls: { init: RequestInit }[] }).calls;
    const sentBody = JSON.parse(calls[0]?.init.body as string) as { model: string };
    expect(sentBody.model).toBe(JEV_MODEL_LATEST);
  });
});

describe("AC2: credential resolution and refusal", () => {
  test("resolveJevApiKey reads OPENROUTER_API_KEY", () => {
    expect(resolveJevApiKey({ OPENROUTER_API_KEY: "sk-or-env" })).toBe("sk-or-env");
  });

  test("no key anywhere -> JevCredentialError, and the fake fetch is never called", async () => {
    const fetchFn = fakeFetch({});
    await expect(callJevSystemOne(fetchFn, { state: "s", questions: ONE_QUESTION }, { env: {} })).rejects.toBeInstanceOf(
      JevCredentialError,
    );
    expect((fetchFn as unknown as { calls: unknown[] }).calls).toHaveLength(0);
  });
});

describe("AC3: 64k token pre-flight budget", () => {
  test("under budget does not throw", () => {
    expect(() => preflightBudget("short state", ONE_QUESTION)).not.toThrow();
  });

  test("state over budget names the state side", () => {
    const hugeState = "x".repeat(JEV_TOKEN_BUDGET * 4 + 40);
    try {
      preflightBudget(hugeState, ONE_QUESTION);
      throw new Error("expected preflightBudget to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(JevBudgetError);
      expect((error as JevBudgetError).side).toBe("state");
    }
  });

  test("questions over budget names the questions side", () => {
    const hugeQuestions: JevQuestions = { q: { type: "noul", instructions: "x".repeat(JEV_TOKEN_BUDGET * 4 + 40) } };
    try {
      preflightBudget("short", hugeQuestions);
      throw new Error("expected preflightBudget to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(JevBudgetError);
      expect((error as JevBudgetError).side).toBe("questions");
    }
  });

  test("an over-budget request is refused before any network call", async () => {
    const fetchFn = fakeFetch({});
    const hugeState = "x".repeat(JEV_TOKEN_BUDGET * 4 + 40);
    await expect(
      callJevSystemOne(fetchFn, { state: hugeState, questions: ONE_QUESTION }, { env: ENV_WITH_KEY }),
    ).rejects.toBeInstanceOf(JevBudgetError);
    expect((fetchFn as unknown as { calls: unknown[] }).calls).toHaveLength(0);
  });
});

describe("flow 307 AC7: a rejected credential names its source and checks the sk-or- prefix", () => {
  test("resolveJevApiKeyResolution reports source 'env' for OPENROUTER_API_KEY", () => {
    expect(resolveJevApiKeyResolution({ OPENROUTER_API_KEY: "sk-or-env" })).toEqual({ key: "sk-or-env", source: "env" });
  });

  test("resolveJevApiKeyResolution reports source 'none' when nothing is set", () => {
    expect(resolveJevApiKeyResolution({})).toEqual({ key: undefined, source: "none" });
  });

  test("a 401 from an env-sourced key names the environment variable, without printing the key", async () => {
    const fetchFn = fakeFetch({ error: "invalid credentials" }, 401);
    let caught: unknown;
    try {
      await callJevSystemOne(fetchFn, { state: "s", questions: ONE_QUESTION }, { env: { OPENROUTER_API_KEY: "sk-or-real-looking" } });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(JevAuthRejectedError);
    expect(caught).toBeInstanceOf(JevRequestError);
    const err = caught as JevAuthRejectedError;
    expect(err.source).toBe("env");
    expect(err.message).toContain("OPENROUTER_API_KEY environment variable");
    expect(err.message).not.toContain("sk-or-real-looking");
  });

  test("a 401 from an env-sourced key that does not start with sk-or- flags the missing prefix", async () => {
    const fetchFn = fakeFetch({ error: "invalid credentials" }, 401);
    let caught: unknown;
    try {
      await callJevSystemOne(fetchFn, { state: "s", questions: ONE_QUESTION }, { env: { OPENROUTER_API_KEY: "not-an-openrouter-key" } });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(JevAuthRejectedError);
    const err = caught as JevAuthRejectedError;
    expect(err.message).toContain("does not look like an OpenRouter key");
    expect(err.message).toContain('"sk-or-"');
    expect(err.message).not.toContain("not-an-openrouter-key");
  });

  test("a 401 from a SAVED key (no env var; keryx shell config) names the saved source", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "keryx-jev-cfg-"));
    saveShellConfig({ openrouterKey: "sk-or-saved" }, dir);
    const fetchFn = fakeFetch({ error: "invalid credentials" }, 401);
    let caught: unknown;
    try {
      await callJevSystemOne(fetchFn, { state: "s", questions: ONE_QUESTION }, { env: {}, dir });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(JevAuthRejectedError);
    const err = caught as JevAuthRejectedError;
    expect(err.source).toBe("saved");
    expect(err.message).toContain("saved OpenRouter key");
    expect(err.message).not.toContain("sk-or-saved");
  });

  test("a non-401 non-2xx response stays a plain JevRequestError, not JevAuthRejectedError", async () => {
    const fetchFn = fakeFetch({ error: "server error" }, 500);
    let caught: unknown;
    try {
      await callJevSystemOne(fetchFn, { state: "s", questions: ONE_QUESTION }, { env: ENV_WITH_KEY });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(JevRequestError);
    expect(caught).not.toBeInstanceOf(JevAuthRejectedError);
  });

  test("flow 307 review item 4: a 401 body that echoes the submitted key never carries it into the error message", async () => {
    const submittedKey = "sk-or-v1-abcdef1234567890abcdef1234567890";
    // Some gateways echo the offending credential back in an "invalid key" body.
    const fetchFn = fakeFetch({ error: "invalid api key", key: submittedKey }, 401);
    let caught: unknown;
    try {
      await callJevSystemOne(fetchFn, { state: "s", questions: ONE_QUESTION }, { env: { OPENROUTER_API_KEY: submittedKey } });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(JevAuthRejectedError);
    const err = caught as JevAuthRejectedError;
    expect(err.message).not.toContain(submittedKey);
    expect(err.message).toContain("[REDACTED:secret]");
  });

  test("flow 307 review item 4: a non-401 error body that echoes a key is also redacted", async () => {
    const submittedKey = "sk-or-v1-abcdef1234567890abcdef1234567890";
    const fetchFn = fakeFetch({ error: "server error", echoedKey: submittedKey }, 500);
    let caught: unknown;
    try {
      await callJevSystemOne(fetchFn, { state: "s", questions: ONE_QUESTION }, { env: ENV_WITH_KEY });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(JevRequestError);
    const err = caught as JevRequestError;
    expect(err.message).not.toContain(submittedKey);
    expect(err.message).toContain("[REDACTED:secret]");
  });
});

describe("AC5: one test per fixture shape", () => {
  test("success response", async () => {
    const fetchFn = fakeFetch({ answers: { warranted: { type: "noul", noul: 0.5 } }, usage: { input_tokens: 10 } });
    const result = await callJevSystemOne(fetchFn, { state: "s", questions: ONE_QUESTION }, { env: ENV_WITH_KEY });
    expect(result.answers.warranted).toEqual({ type: "noul", noul: 0.5 });
  });

  test("malformed-JSON response", async () => {
    const fetchFn = fakeFetch("{not json", 200);
    await expect(callJevSystemOne(fetchFn, { state: "s", questions: ONE_QUESTION }, { env: ENV_WITH_KEY })).rejects.toBeInstanceOf(
      JevResponseParseError,
    );
  });

  test("non-200 response", async () => {
    const fetchFn = fakeFetch({ error: "bad request" }, 400);
    await expect(callJevSystemOne(fetchFn, { state: "s", questions: ONE_QUESTION }, { env: ENV_WITH_KEY })).rejects.toBeInstanceOf(
      JevRequestError,
    );
  });

  test("response missing usage", async () => {
    const fetchFn = fakeFetch({ answers: { warranted: { type: "noul", noul: 0.5 } } });
    await expect(callJevSystemOne(fetchFn, { state: "s", questions: ONE_QUESTION }, { env: ENV_WITH_KEY })).rejects.toBeInstanceOf(
      JevResponseShapeError,
    );
  });

  test("response missing answers", async () => {
    const fetchFn = fakeFetch({ usage: {} });
    await expect(callJevSystemOne(fetchFn, { state: "s", questions: ONE_QUESTION }, { env: ENV_WITH_KEY })).rejects.toBeInstanceOf(
      JevResponseShapeError,
    );
  });
});

/**
 * A `fetch` stand-in that never settles on its own, exactly like a real
 * `fetch` against a hung connection — it only rejects when its `init.signal`
 * fires, the same contract the real WHATWG `fetch` honours. Without that
 * listener this fake would hang the test forever regardless of what
 * `callJevSystemOne` does; WITH it, the test proves `callJevSystemOne`
 * actually wires the signal through, not merely that some promise resolved.
 */
function hangingFetch(): typeof fetch & { calls: { init?: RequestInit }[] } {
  const fn = (async (_url: string, init?: RequestInit) => {
    (fn as unknown as { calls: unknown[] }).calls.push({ init });
    return new Promise<Response>((_resolve, reject) => {
      // A real `fetch` checks an ALREADY-aborted signal synchronously and
      // rejects immediately rather than waiting for an "abort" event that
      // already fired in the past — `addEventListener` on a signal that is
      // already aborted never sees that event again. Matching that here is
      // what makes the "already-aborted signal" test below resolve at all
      // instead of hanging.
      if (init?.signal?.aborted === true) {
        reject(new DOMException("The operation was aborted.", "AbortError"));
        return;
      }
      init?.signal?.addEventListener("abort", () => {
        reject(new DOMException("The operation was aborted.", "AbortError"));
      });
    });
  }) as unknown as typeof fetch & { calls: { init?: RequestInit }[] };
  (fn as unknown as { calls: unknown[] }).calls = [];
  return fn;
}

describe("timeout / abort (flow 306 review item 1)", () => {
  test("DEFAULT_JEV_TIMEOUT_MS is a sane, named default", () => {
    expect(DEFAULT_JEV_TIMEOUT_MS).toBeGreaterThan(1000);
  });

  test("a request that never resolves times out with JevTimeoutError, not a hang", async () => {
    const fetchFn = hangingFetch();
    await expect(
      callJevSystemOne(fetchFn, { state: "s", questions: ONE_QUESTION }, { env: ENV_WITH_KEY, timeoutMs: 20 }),
    ).rejects.toBeInstanceOf(JevTimeoutError);
    // The fetch really was asked to carry a signal — a reverted fix (no
    // `signal` in the request init) would leave this fake hanging forever
    // and the assertion above would never be reached in the first place,
    // but this also pins the WIRING, not just the outcome.
    expect(fetchFn.calls[0]?.init?.signal).toBeDefined();
  });

  test("the reported timeoutMs matches what was asked for", async () => {
    const fetchFn = hangingFetch();
    try {
      await callJevSystemOne(fetchFn, { state: "s", questions: ONE_QUESTION }, { env: ENV_WITH_KEY, timeoutMs: 15 });
      throw new Error("expected a timeout");
    } catch (error) {
      expect(error).toBeInstanceOf(JevTimeoutError);
      expect((error as JevTimeoutError).timeoutMs).toBe(15);
    }
  });

  test("a caller-supplied signal aborts the request before the timeout, with the same error", async () => {
    const fetchFn = hangingFetch();
    const controller = new AbortController();
    const call = callJevSystemOne(fetchFn, { state: "s", questions: ONE_QUESTION }, { env: ENV_WITH_KEY, timeoutMs: 60_000, signal: controller.signal });
    controller.abort();
    await expect(call).rejects.toBeInstanceOf(JevTimeoutError);
  });

  test("an already-aborted signal refuses immediately", async () => {
    const fetchFn = hangingFetch();
    const controller = new AbortController();
    controller.abort();
    await expect(
      callJevSystemOne(fetchFn, { state: "s", questions: ONE_QUESTION }, { env: ENV_WITH_KEY, timeoutMs: 60_000, signal: controller.signal }),
    ).rejects.toBeInstanceOf(JevTimeoutError);
  });

  test("a normal, fast response is unaffected by the timeout wiring", async () => {
    const fetchFn = fakeFetch({ answers: { warranted: { type: "noul", noul: 0.4 } }, usage: {} });
    const result = await callJevSystemOne(fetchFn, { state: "s", questions: ONE_QUESTION }, { env: ENV_WITH_KEY, timeoutMs: 20 });
    expect(result.answers.warranted).toEqual({ type: "noul", noul: 0.4 });
  });
});

describe("answer validation (flow 306 review item 4)", () => {
  test("every requested key must be present", async () => {
    const fetchFn = fakeFetch({ answers: {}, usage: {} });
    await expect(callJevSystemOne(fetchFn, { state: "s", questions: ONE_QUESTION }, { env: ENV_WITH_KEY })).rejects.toBeInstanceOf(
      JevAnswerValidationError,
    );
  });

  test("a noul answer whose type does not match the question is rejected", async () => {
    const fetchFn = fakeFetch({ answers: { warranted: { type: "choice", choice: "yes" } }, usage: {} });
    await expect(callJevSystemOne(fetchFn, { state: "s", questions: ONE_QUESTION }, { env: ENV_WITH_KEY })).rejects.toBeInstanceOf(
      JevAnswerValidationError,
    );
  });

  test("a non-finite noul is rejected, not silently clamped to 0", async () => {
    const fetchFn = fakeFetch({ answers: { warranted: { type: "noul", noul: Number.NaN } }, usage: {} });
    const call = callJevSystemOne(fetchFn, { state: "s", questions: ONE_QUESTION }, { env: ENV_WITH_KEY });
    await expect(call).rejects.toBeInstanceOf(JevAnswerValidationError);
  });

  test("a noul outside 0..1 is rejected", async () => {
    const overOne = fakeFetch({ answers: { warranted: { type: "noul", noul: 1.5 } }, usage: {} });
    await expect(callJevSystemOne(overOne, { state: "s", questions: ONE_QUESTION }, { env: ENV_WITH_KEY })).rejects.toBeInstanceOf(
      JevAnswerValidationError,
    );
    const negative = fakeFetch({ answers: { warranted: { type: "noul", noul: -0.1 } }, usage: {} });
    await expect(callJevSystemOne(negative, { state: "s", questions: ONE_QUESTION }, { env: ENV_WITH_KEY })).rejects.toBeInstanceOf(
      JevAnswerValidationError,
    );
  });

  test("the 0..1 boundary values are valid", async () => {
    const zero = fakeFetch({ answers: { warranted: { type: "noul", noul: 0 } }, usage: {} });
    expect((await callJevSystemOne(zero, { state: "s", questions: ONE_QUESTION }, { env: ENV_WITH_KEY })).answers.warranted).toEqual({
      type: "noul",
      noul: 0,
    });
    const one = fakeFetch({ answers: { warranted: { type: "noul", noul: 1 } }, usage: {} });
    expect((await callJevSystemOne(one, { state: "s", questions: ONE_QUESTION }, { env: ENV_WITH_KEY })).answers.warranted).toEqual({
      type: "noul",
      noul: 1,
    });
  });

  test("a choice answer with an empty/non-string choice is rejected", async () => {
    const choiceQuestion: JevQuestions = { pick: { type: "choice", instructions: "pick one", criteria: { a: "a", b: "b" } } };
    const empty = fakeFetch({ answers: { pick: { type: "choice", choice: "" } }, usage: {} });
    await expect(callJevSystemOne(empty, { state: "s", questions: choiceQuestion }, { env: ENV_WITH_KEY })).rejects.toBeInstanceOf(
      JevAnswerValidationError,
    );
  });

  test("a well-formed choice answer is accepted", async () => {
    const choiceQuestion: JevQuestions = { pick: { type: "choice", instructions: "pick one", criteria: { a: "a", b: "b" } } };
    const fetchFn = fakeFetch({ answers: { pick: { type: "choice", choice: "a" } }, usage: {} });
    const result = await callJevSystemOne(fetchFn, { state: "s", questions: choiceQuestion }, { env: ENV_WITH_KEY });
    expect(result.answers.pick).toEqual({ type: "choice", choice: "a" });
  });

  test("an extra answer key the caller never asked about is dropped, not trusted", async () => {
    const fetchFn = fakeFetch({
      answers: { warranted: { type: "noul", noul: 0.5 }, unrequested: { type: "noul", noul: 0.9 } },
      usage: {},
    });
    const result = await callJevSystemOne(fetchFn, { state: "s", questions: ONE_QUESTION }, { env: ENV_WITH_KEY });
    expect(Object.keys(result.answers)).toEqual(["warranted"]);
  });
});

/**
 * A `fetch` stand-in that plays back one step per call — a status/body pair,
 * or a thrown error (a real `fetch` rejecting: connection refused, reset,
 * DNS) — so a test can script exactly "fails transiently, then succeeds" or
 * "fails every attempt" without a real socket. Never checks `init.signal`:
 * none of the retry tests below exercise the timeout/abort path, which the
 * "timeout / abort" describe block above already covers on its own.
 */
function queuedFetch(
  steps: ReadonlyArray<{ readonly status: number; readonly body: unknown; readonly headers?: Record<string, string> } | { readonly throwError: unknown }>,
): typeof fetch & { calls: { url: string; init?: RequestInit }[] } {
  let i = 0;
  const fn = (async (url: string, init?: RequestInit): Promise<Response> => {
    (fn as unknown as { calls: unknown[] }).calls.push({ url, init });
    const step = steps[i];
    i += 1;
    if (step === undefined) {
      throw new Error(`queuedFetch: no step queued for call #${i}`);
    }
    if ("throwError" in step) {
      throw step.throwError;
    }
    return new Response(typeof step.body === "string" ? step.body : JSON.stringify(step.body), {
      status: step.status,
      headers: { "content-type": "application/json", ...(step.headers ?? {}) },
    });
  }) as unknown as typeof fetch & { calls: { url: string; init?: RequestInit }[] };
  (fn as unknown as { calls: unknown[] }).calls = [];
  return fn;
}

/** Records every requested backoff instead of actually waiting it out. */
function recordingSleep(): { sleepFn: (ms: number) => Promise<void>; delays: number[] } {
  const delays: number[] = [];
  const sleepFn = async (ms: number): Promise<void> => {
    delays.push(ms);
  };
  return { sleepFn, delays };
}

describe("bounded retry for transient failures (the live keryx review jev-rules 503)", () => {
  test("MAX_ATTEMPTS is 3 (one try plus up to two retries)", () => {
    expect(JEV_MAX_ATTEMPTS).toBe(3);
  });

  test("503 then success: one result, exactly the successful attempt's usage, one backoff wait", async () => {
    const fetchFn = queuedFetch([
      { status: 503, body: { error: "upstream connect error or disconnect/reset before headers. reset reason: connection failure" } },
      { status: 200, body: { answers: { warranted: { type: "noul", noul: 0.72 } }, usage: { input_tokens: 50, cost: 0.00001 } } },
    ]);
    const { sleepFn, delays } = recordingSleep();
    const result = await callJevSystemOne(fetchFn, { state: "s", questions: ONE_QUESTION }, { env: ENV_WITH_KEY, sleepFn });
    expect(result.answers.warranted).toEqual({ type: "noul", noul: 0.72 });
    // Only the successful call's usage — never a merge of a failed attempt's (absent) usage.
    expect(result.usage).toEqual({ input_tokens: 50, cost: 0.00001 });
    expect(fetchFn.calls).toHaveLength(2);
    expect(delays).toEqual([500]);
  });

  test("503 three times in a row: gives up, names the endpoint, and says how many attempts were made", async () => {
    const body503 = { error: "upstream connect error or disconnect/reset before headers. reset reason: connection failure" };
    const fetchFn = queuedFetch([
      { status: 503, body: body503 },
      { status: 503, body: body503 },
      { status: 503, body: body503 },
    ]);
    const { sleepFn, delays } = recordingSleep();
    let caught: unknown;
    try {
      await callJevSystemOne(fetchFn, { state: "s", questions: ONE_QUESTION }, { env: ENV_WITH_KEY, sleepFn });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(JevRequestError);
    const err = caught as JevRequestError;
    expect(err.status).toBe(503);
    expect(err.attempts).toBe(3);
    expect(err.message).toContain(JEV_ENDPOINT);
    expect(err.message).toContain("HTTP 503");
    expect(err.message).toContain("3 attempts");
    expect(fetchFn.calls).toHaveLength(3);
    expect(delays).toEqual([500, 1500]);
  });

  test("400 is never retried — one call, the same JevRequestError shape as before this feature", async () => {
    const fetchFn = queuedFetch([{ status: 400, body: { error: "max_tokens_exceeded" } }]);
    const { sleepFn, delays } = recordingSleep();
    let caught: unknown;
    try {
      await callJevSystemOne(fetchFn, { state: "s", questions: ONE_QUESTION }, { env: ENV_WITH_KEY, sleepFn });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(JevRequestError);
    const err = caught as JevRequestError;
    expect(err.status).toBe(400);
    expect(err.attempts).toBe(1);
    expect(err.message).not.toContain("attempts");
    expect(fetchFn.calls).toHaveLength(1);
    expect(delays).toEqual([]);
  });

  test("a network error (connection refused) then success: one result, one call retried", async () => {
    const fetchFn = queuedFetch([
      { throwError: new TypeError("fetch failed: connect ECONNREFUSED 127.0.0.1:443") },
      { status: 200, body: { answers: { warranted: { type: "noul", noul: 0.3 } }, usage: { input_tokens: 5 } } },
    ]);
    const { sleepFn, delays } = recordingSleep();
    const result = await callJevSystemOne(fetchFn, { state: "s", questions: ONE_QUESTION }, { env: ENV_WITH_KEY, sleepFn });
    expect(result.answers.warranted).toEqual({ type: "noul", noul: 0.3 });
    expect(fetchFn.calls).toHaveLength(2);
    expect(delays).toEqual([500]);
  });

  test("a network error on every attempt gives up as JevNetworkError naming the attempt count", async () => {
    const cause = new TypeError("fetch failed: connect ECONNREFUSED 127.0.0.1:443");
    const fetchFn = queuedFetch([{ throwError: cause }, { throwError: cause }, { throwError: cause }]);
    const { sleepFn } = recordingSleep();
    let caught: unknown;
    try {
      await callJevSystemOne(fetchFn, { state: "s", questions: ONE_QUESTION }, { env: ENV_WITH_KEY, sleepFn });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(JevNetworkError);
    const err = caught as JevNetworkError;
    expect(err.attempts).toBe(3);
    expect(err.message).toContain("3 attempt(s)");
    expect(err.message).toContain("ECONNREFUSED");
    expect(fetchFn.calls).toHaveLength(3);
  });

  test("429 with Retry-After is honoured but capped, not trusted verbatim", async () => {
    const fetchFn = queuedFetch([
      { status: 429, body: { error: "rate limited" }, headers: { "retry-after": "30" } },
      { status: 200, body: { answers: { warranted: { type: "noul", noul: 0.6 } }, usage: {} } },
    ]);
    const { sleepFn, delays } = recordingSleep();
    const result = await callJevSystemOne(fetchFn, { state: "s", questions: ONE_QUESTION }, { env: ENV_WITH_KEY, sleepFn });
    expect(result.answers.warranted).toEqual({ type: "noul", noul: 0.6 });
    // The vendor asked for 30s; the client waits at most JEV_RETRY_AFTER_CAP_MS.
    expect(delays).toEqual([JEV_RETRY_AFTER_CAP_MS]);
    expect(JEV_RETRY_AFTER_CAP_MS).toBeLessThan(30_000);
  });

  test("a 401 is never retried, even though it is a non-2xx status", async () => {
    const fetchFn = queuedFetch([{ status: 401, body: { error: "invalid credentials" } }]);
    const { sleepFn, delays } = recordingSleep();
    await expect(
      callJevSystemOne(fetchFn, { state: "s", questions: ONE_QUESTION }, { env: ENV_WITH_KEY, sleepFn }),
    ).rejects.toBeInstanceOf(JevAuthRejectedError);
    expect(fetchFn.calls).toHaveLength(1);
    expect(delays).toEqual([]);
  });
});

describe("Flow 346: the EXTERNAL switch's choke point (AC1) — checked before anything else, including credential resolution", () => {
  test("external off (user-level, via injected dir) -> ExternalBlockedError, and the fake fetch is never called", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "keryx-jev-external-off-"));
    saveShellConfig({ external: "off" }, dir);
    const fetchFn = fakeFetch({});
    let caught: unknown;
    try {
      await callJevSystemOne(fetchFn, { state: "s", questions: ONE_QUESTION }, { env: ENV_WITH_KEY, dir });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ExternalBlockedError);
    expect((fetchFn as unknown as { calls: unknown[] }).calls).toHaveLength(0);
    const err = caught as ExternalBlockedError;
    // AC2: no stack-trace noise — a plain, readable "skipped: blocked by
    // /external" message every existing fail-open caller already surfaces
    // via `error.message`.
    expect(err.message).toContain("skipped: blocked by /external off");
    expect(err.message).toContain("Jev/TypeSafe System One");
    expect(err.message).toContain("/external on");
  });

  test("checked BEFORE the credential check — off with NO credential at all still raises ExternalBlockedError, not JevCredentialError", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "keryx-jev-external-off-nokey-"));
    saveShellConfig({ external: "off" }, dir);
    const fetchFn = fakeFetch({});
    await expect(callJevSystemOne(fetchFn, { state: "s", questions: ONE_QUESTION }, { env: {}, dir })).rejects.toBeInstanceOf(
      ExternalBlockedError,
    );
    expect((fetchFn as unknown as { calls: unknown[] }).calls).toHaveLength(0);
  });

  test("external on (the default) -> the call proceeds exactly as before flow 346", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "keryx-jev-external-on-"));
    const fetchFn = fakeFetch({ answers: { warranted: { type: "noul", noul: 0.4 } }, usage: {} });
    const result = await callJevSystemOne(fetchFn, { state: "s", questions: ONE_QUESTION }, { env: ENV_WITH_KEY, dir });
    expect(result.answers.warranted).toEqual({ type: "noul", noul: 0.4 });
    expect((fetchFn as unknown as { calls: unknown[] }).calls).toHaveLength(1);
  });

  test("an operator who removes \"jev\" from external-providers.json is not blocked, even with external off", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "keryx-jev-external-off-no-jev-entry-"));
    saveShellConfig({ external: "off" }, dir);
    await Bun.write(path.join(dir, "external-providers.json"), JSON.stringify({ version: 1, providers: [], modelPatterns: [], notes: "" }));
    const fetchFn = fakeFetch({ answers: { warranted: { type: "noul", noul: 0.4 } }, usage: {} });
    const result = await callJevSystemOne(fetchFn, { state: "s", questions: ONE_QUESTION }, { env: ENV_WITH_KEY, dir });
    expect(result.answers.warranted).toEqual({ type: "noul", noul: 0.4 });
  });

  test("a project's own external override (via opts.cwd) is checked, not only the user-level setting", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "keryx-jev-external-project-cfg-"));
    const cwd = mkdtempSync(path.join(tmpdir(), "keryx-jev-external-project-cwd-"));
    // User-level says "on"; the project's own tasks.config.json says "off" and must win.
    saveShellConfig({ external: "on" }, dir);
    await mkdir(path.join(cwd, ".metaproject"), { recursive: true });
    await writeFile(path.join(cwd, ".metaproject", "tasks.config.json"), JSON.stringify({ external: "off" }), "utf8");
    const fetchFn = fakeFetch({});
    await expect(
      callJevSystemOne(fetchFn, { state: "s", questions: ONE_QUESTION }, { env: ENV_WITH_KEY, dir, cwd }),
    ).rejects.toBeInstanceOf(ExternalBlockedError);
    expect((fetchFn as unknown as { calls: unknown[] }).calls).toHaveLength(0);
  });
});
