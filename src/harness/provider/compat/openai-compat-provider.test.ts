import { expect, test } from "bun:test";
import { OpenAiCompatEngine, type OpenAiCompatCapabilityGrant, type OpenAiCompatIdentity } from "./openai-compat-provider";
import type { NormalizedEvent, NormalizedRequest } from "../types";

const identity: OpenAiCompatIdentity = {
  providerId: "compat-fixture",
  providerRevision: "test",
  defaultBaseUrl: "http://localhost:43123",
  defaultModel: { modelId: "fixture-model", revision: "test" },
  providerLabel: "Compat fixture",
};

const grant: OpenAiCompatCapabilityGrant = {
  network: true,
  baseUrl: identity.defaultBaseUrl,
  allowLoopback: true,
};

const request: NormalizedRequest = {
  providerId: identity.providerId,
  modelId: identity.defaultModel.modelId,
  systemInstruction: "fixture",
  messages: [{ role: "user", content: "hello" }],
  budget: { maxOutputTokens: 32, runReservation: 32 },
  stream: true,
  requestId: "catch-c01",
  parentRunId: "catch-c01",
};

test("C-01: non-JSON HTTP errors keep the typed status fallback", async () => {
  const fetchMock = Object.assign(
    (async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response("opaque upstream body", { status: 503 })) as typeof fetch,
    { preconnect: (_input: string | URL) => {} },
  );
  const provider = new OpenAiCompatEngine({ grant, fetch: fetchMock }, identity);
  const events: NormalizedEvent[] = [];
  for await (const event of provider.stream(request, { attemptId: "catch-c01" })) events.push(event);

  expect(events).toHaveLength(1);
  expect(events[0]?.kind).toBe("provider_error");
  expect(events[0]?.error?.kind).toBe("unavailable");
  expect(events[0]?.error?.message).toBe("Compat fixture API returned HTTP 503");
  expect(JSON.stringify(events)).not.toContain("opaque upstream body");
});

async function errorFor(response: Response): Promise<NonNullable<NormalizedEvent["error"]>> {
  const fetchMock = Object.assign((async () => response.clone()) as unknown as typeof fetch, {
    preconnect: (_input: string | URL) => {},
  });
  const provider = new OpenAiCompatEngine({ grant, fetch: fetchMock }, identity);
  const events: NormalizedEvent[] = [];
  for await (const event of provider.stream(request, { attemptId: "catch-c01" })) events.push(event);
  expect(events).toHaveLength(1);
  expect(events[0]?.kind).toBe("provider_error");
  const error = events[0]?.error;
  if (error === undefined) throw new Error("provider_error without an error");
  return error;
}

const json = (body: unknown, status: number, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

test("K-005: the server's reason is kept beside the status, from every JSON shape gateways use", async () => {
  // `error.message` was the only shape read; the others lost their reason and the
  // operator got a bare status.
  expect((await errorFor(json({ error: { message: "balance exhausted" } }, 402))).message).toBe(
    "Compat fixture API returned HTTP 402: balance exhausted",
  );
  expect((await errorFor(json({ error: "model not permitted for this key" }, 403))).message).toBe(
    "Compat fixture API returned HTTP 403: model not permitted for this key",
  );
  expect((await errorFor(json({ message: "slow down" }, 429))).message).toBe(
    "Compat fixture API returned HTTP 429: slow down",
  );
  expect((await errorFor(json({ detail: "no such model" }, 404))).message).toBe(
    "Compat fixture API returned HTTP 404: no such model",
  );
});

test("K-005: a reasonless or empty body gives exactly the status line", async () => {
  expect((await errorFor(json({ code: 17 }, 400))).message).toBe("Compat fixture API returned HTTP 400");
  expect((await errorFor(new Response("", { status: 403 }))).message).toBe("Compat fixture API returned HTTP 403");
});

test("K-005: the reason is redacted, flattened and bounded", async () => {
  const leaked = await errorFor(json({ error: { message: "bad key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789" } }, 401));
  expect(leaked.message).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
  const long = await errorFor(json({ error: { message: `line one\n\n${"x".repeat(1000)}` } }, 400));
  expect(long.message).not.toContain("\n");
  const reason = long.message.replace("Compat fixture API returned HTTP 400: ", "");
  expect(reason.length).toBeLessThanOrEqual(301);
  expect(reason.startsWith("line one x")).toBe(true);
});

test("K-005: 401/403 are authentication, 429 is a retryable rate limit that honours Retry-After", async () => {
  // Every 4xx used to be invalid_request — a refused account and a malformed field
  // were the same error, and a rate limit was never retried.
  for (const status of [401, 403]) {
    const error = await errorFor(json({ error: "no" }, status));
    expect(error.kind).toBe("authentication");
    expect(error.retryable).toBe(false);
  }
  const limited = await errorFor(json({ error: "slow" }, 429, { "retry-after": "7" }));
  expect(limited.kind).toBe("rate_limit");
  expect(limited.retryable).toBe(true);
  expect(limited.retryAfterMs).toBe(7000);
  expect((await errorFor(json({ error: "gone" }, 404))).kind).toBe("invalid_request");
  expect((await errorFor(new Response("", { status: 502 }))).kind).toBe("unavailable");
});
