// Flow 306, Phase 0 (AC1-AC5): the Jev client, driven entirely through an
// injected fake `fetch`. No test in this file opens a real socket.

import { describe, expect, test } from "bun:test";
import {
  callJevSystemOne,
  DEFAULT_JEV_MODEL,
  JEV_ENDPOINT,
  JEV_MODEL_1_13,
  JEV_MODEL_LATEST,
  JEV_TOKEN_BUDGET,
  JevBudgetError,
  JevCredentialError,
  JevRequestError,
  JevResponseParseError,
  JevResponseShapeError,
  preflightBudget,
  resolveJevApiKey,
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
