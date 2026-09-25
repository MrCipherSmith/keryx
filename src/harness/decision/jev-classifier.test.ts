// Flow 338, AC4. Hermetic: every case uses an injected fake `fetch`, zero
// real network calls (mirrors `jev-client.test.ts`'s own fake-fetch shape).
import { expect, test } from "bun:test";
import { JevTaskClassifier } from "./jev-classifier";

const ENV_WITH_KEY = { OPENROUTER_API_KEY: "sk-or-test" } as const;
const CATEGORIES = ["default", "review", "subagents", "quick", "coding", "planning", "docs", "unattended"] as const;

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

test("JevTaskClassifier: a high-confidence choice resolves the category, and usage is carried through", async () => {
  const fetchFn = fakeFetch({
    id: "r1",
    answers: { category: { type: "choice", choice: "quick" }, confidence: { type: "noul", noul: 0.92 } },
    usage: { input_tokens: 50, output_tokens: 0, cost: 0.000002 },
  });
  const classifier = new JevTaskClassifier({ fetch: fetchFn, env: ENV_WITH_KEY });
  const result = await classifier.classify("hi", [...CATEGORIES]);
  expect(result).toMatchObject({ ok: true, category: "quick", confidence: 0.92, source: "jev" });
  if (result.ok) expect(result.usage).toEqual({ inputTokens: 50, outputTokens: 0, cost: 0.000002 });
});

test("JevTaskClassifier: sends exactly one choice question with criteria over the wired categories", async () => {
  const fetchFn = fakeFetch({
    answers: { category: { type: "choice", choice: "review" }, confidence: { type: "noul", noul: 0.8 } },
    usage: {},
  });
  const classifier = new JevTaskClassifier({ fetch: fetchFn, env: ENV_WITH_KEY });
  await classifier.classify("please review this PR", ["review", "subagents"]);
  const calls = (fetchFn as unknown as { calls: { url: string; init: RequestInit }[] }).calls;
  expect(calls).toHaveLength(1);
  const body = JSON.parse(calls[0]!.init.body as string) as { questions: Record<string, unknown> };
  expect(body.questions.category).toMatchObject({ type: "choice", criteria: { review: expect.any(String), subagents: expect.any(String) } });
  expect(body.questions.confidence).toMatchObject({ type: "noul" });
});

test("JevTaskClassifier: below-threshold confidence is refused, not a returned category", async () => {
  const fetchFn = fakeFetch({
    answers: { category: { type: "choice", choice: "quick" }, confidence: { type: "noul", noul: 0.3 } },
    usage: {},
  });
  const classifier = new JevTaskClassifier({ fetch: fetchFn, env: ENV_WITH_KEY });
  const result = await classifier.classify("something ambiguous", [...CATEGORIES]);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toContain("low confidence");
});

test("JevTaskClassifier: no credential refuses without a network call", async () => {
  const fetchFn = fakeFetch({});
  const classifier = new JevTaskClassifier({ fetch: fetchFn, env: {} });
  const result = await classifier.classify("task", [...CATEGORIES]);
  expect(result).toEqual({ ok: false, reason: "no OpenRouter credential for Jev" });
  const calls = (fetchFn as unknown as { calls: unknown[] }).calls;
  expect(calls).toHaveLength(0);
});

test("JevTaskClassifier: a malformed response (missing answers) is refused, not a guessed category", async () => {
  const fetchFn = fakeFetch({ answers: { category: { type: "choice", choice: "quick" } }, usage: {} });
  const classifier = new JevTaskClassifier({ fetch: fetchFn, env: ENV_WITH_KEY });
  const result = await classifier.classify("task", [...CATEGORIES]);
  expect(result.ok).toBe(false);
});

test("JevTaskClassifier: an out-of-vocabulary choice is refused", async () => {
  const fetchFn = fakeFetch({
    answers: { category: { type: "choice", choice: "not-a-real-category" }, confidence: { type: "noul", noul: 0.9 } },
    usage: {},
  });
  const classifier = new JevTaskClassifier({ fetch: fetchFn, env: ENV_WITH_KEY });
  const result = await classifier.classify("task", [...CATEGORIES]);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toContain("out-of-vocabulary");
});
