import { describe, expect, test } from "bun:test";
import type { NormalizedRequest, StreamOptions } from "../types";
import {
  OpenAiCompatEngine,
  type OpenAiCompatCapabilityGrant,
  type OpenAiCompatIdentity,
} from "./openai-compat-provider";

const REQUEST = {
  providerId: "test",
  modelId: "m",
  systemInstruction: "",
  messages: [],
  budget: { maxOutputTokens: 1024, runReservation: 1024 },
  stream: true,
  requestId: "r1",
  parentRunId: "p1",
} as unknown as NormalizedRequest;

const OPTIONS = { attemptId: "a1" } as unknown as StreamOptions;

const IDENTITY: OpenAiCompatIdentity = {
  defaultBaseUrl: "http://localhost:11434",
  providerRevision: "test-1",
  providerId: "test",
  defaultModel: { modelId: "m", revision: "latest" },
};

// Each event is a `data:` line terminated by a blank line; the stream ends with
// `data: [DONE]` followed by a blank line (a torn trailing record -> malformed).
const SSE_BODY = [
  'data: {"id":"1","object":"chat.completion.chunk","created":0,"model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":"hi"},"finish_reason":null}]}',
  "",
  "",
  "data: [DONE]",
  "",
  "",
].join("\n");

function recordedFetch(): { fetch: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fetchFn = (async (input: string | URL) => {
    urls.push(String(input));
    return new Response(SSE_BODY, { status: 200 });
  }) as unknown as typeof fetch;
  return { fetch: fetchFn, urls };
}

async function collect(grant: OpenAiCompatCapabilityGrant, fetchFn: typeof fetch): Promise<string[]> {
  const engine = new OpenAiCompatEngine({ fetch: fetchFn, grant }, IDENTITY);
  const kinds: string[] = [];
  for await (const event of engine.stream(REQUEST, OPTIONS)) {
    kinds.push(event.kind);
  }
  return kinds;
}

describe("OpenAiCompatEngine private-LAN egress gate (allowPrivateLan)", () => {
  test("a 10.x baseUrl WITHOUT the grant is denied BEFORE any fetch", async () => {
    const { fetch, urls } = recordedFetch();
    const kinds = await collect({ network: true, baseUrl: "http://10.110.43.19:8080" }, fetch);
    expect(urls).toEqual([]);
    expect(kinds).toEqual(["provider_error"]);
  });

  test("a 10.x baseUrl WITH allowPrivateLan reaches the network", async () => {
    const { fetch, urls } = recordedFetch();
    const kinds = await collect({ network: true, baseUrl: "http://10.110.43.19:8080", allowPrivateLan: true }, fetch);
    expect(urls).toEqual(["http://10.110.43.19:8080/v1/chat/completions"]);
    expect(kinds).toContain("model_start");
    expect(kinds).toContain("text_delta");
    expect(kinds).toContain("model_end");
    expect(kinds.some((k) => k === "provider_error")).toBe(false);
  });

  test("metadata (169.254.x) stays denied even WITH allowPrivateLan (narrow opt-in)", async () => {
    const { fetch, urls } = recordedFetch();
    const kinds = await collect({ network: true, baseUrl: "http://169.254.169.254", allowPrivateLan: true }, fetch);
    expect(urls).toEqual([]);
    expect(kinds).toEqual(["provider_error"]);
  });

  test("loopback still requires allowLoopback (allowPrivateLan does not imply it)", async () => {
    const { fetch, urls } = recordedFetch();
    const kinds = await collect({ network: true, baseUrl: "http://127.0.0.1:11434", allowPrivateLan: true }, fetch);
    expect(urls).toEqual([]);
    expect(kinds).toEqual(["provider_error"]);
  });
});
