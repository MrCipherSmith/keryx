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
