// RED tests for the narrow loopback egress opt-in (flow 020, T5 / AC2,
// SECURITY — no SSRF weakening).
//
// Pins two things:
//   1. `isLoopbackHost(host)` — an ADDITIVE sibling predicate to the existing
//      `isPrivateEgressHost` (`./guard.ts`) — is TRUE ONLY for loopback forms
//      (127.0.0.0/8, `::1`/`[::1]`, `localhost` case-insensitively, and the
//      encoded loopback forms the existing decoder already recognizes) and
//      FALSE for metadata/link-local/private-LAN/public hosts.
//   2. The `OllamaProvider` egress branch built on top of it: egress is
//      permitted IFF `!isPrivateEgressHost(host)` OR (`grant.allowLoopback
//      === true` AND `isLoopbackHost(host)`). So a loopback base URL is
//      DENIED fail-closed WITHOUT the opt-in; metadata/link-local/private-LAN
//      base URLs stay DENIED even WITH the opt-in (the opt-in re-permits
//      LOOPBACK ONLY, never widens the SSRF guard generally).
//
// RED (expected): `isLoopbackHost` is not yet exported from `./guard` (import
// error for section 1), and `./ollama-provider` does not exist yet (import
// error for section 2) — both are the expected T6 implementation gaps, not
// test bugs.
//
// OFFLINE / DETERMINISTIC: `fetch` is always injected; no test touches
// `globalThis.fetch`; no `Date.now`/`Math.random` anywhere in this file.
import { describe, expect, test } from "bun:test";
// PINNED API (T6 adds this additive export to guard.ts; see subagent-result).
import { isLoopbackHost } from "./guard";
import type { OllamaCapabilityGrant, OllamaProviderDeps } from "../provider/ollama/ollama-provider";
import { OllamaProvider } from "../provider/ollama/ollama-provider";
import type { NormalizedError, NormalizedEvent, NormalizedRequest, StreamOptions } from "../provider/types";

// --- Section 1: isLoopbackHost(host) pure-predicate contract ---------------

describe("AC2 (SECURITY) — isLoopbackHost(host) is TRUE only for loopback forms", () => {
  const loopbackHosts = [
    "127.0.0.1",
    "127.1",
    "::1",
    "[::1]",
    "localhost",
    "LOCALHOST",
    "2130706433", // decimal-encoded 127.0.0.1
    "0x7f000001", // hex-encoded 127.0.0.1
  ];

  for (const host of loopbackHosts) {
    test(`isLoopbackHost(${JSON.stringify(host)}) === true`, () => {
      expect(isLoopbackHost(host)).toBe(true);
    });
  }

  const nonLoopbackHosts = [
    "169.254.169.254", // cloud metadata
    "10.0.0.1", // RFC1918
    "192.168.1.1", // RFC1918
    "172.16.0.1", // RFC1918
    "8.8.8.8", // public
    "api.example.com", // public DNS name
  ];

  for (const host of nonLoopbackHosts) {
    test(`isLoopbackHost(${JSON.stringify(host)}) === false`, () => {
      expect(isLoopbackHost(host)).toBe(false);
    });
  }
});

// --- Section 2: OllamaProvider egress branch drives the opt-in end-to-end --

/** A minimal, valid in-memory NormalizedRequest for the Ollama adapter. */
function buildRequest(requestId: string): NormalizedRequest {
  return {
    providerId: "ollama",
    modelId: "llama3.1:latest",
    systemInstruction: "fixture system instruction",
    messages: [{ role: "user", content: "ping" }],
    budget: { maxOutputTokens: 64, runReservation: 64 },
    stream: true,
    requestId,
    parentRunId: "run-fixture",
  };
}

interface CapturedCall {
  input: RequestInfo | URL;
  init?: RequestInit;
}

/** Fetch mock that records calls and always resolves with a trivial 200 SSE body. */
function makeFetchMock(): { fetch: typeof fetch; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const body = 'data: {"id":"x","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
  const fn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const call: CapturedCall = init === undefined ? { input } : { input, init };
    calls.push(call);
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  return { fetch: fn as unknown as typeof fetch, calls };
}

async function collectEvents(iterable: AsyncIterable<NormalizedEvent>): Promise<NormalizedEvent[]> {
  const events: NormalizedEvent[] = [];
  for await (const evt of iterable) {
    events.push(evt);
  }
  return events;
}

function grant(overrides: Partial<OllamaCapabilityGrant>): OllamaCapabilityGrant {
  return { network: true, baseUrl: "http://localhost:11434", ...overrides };
}

describe("AC2 (SECURITY) — OllamaProvider egress branch: loopback re-permitted ONLY with the explicit opt-in", () => {
  test("baseUrl=http://localhost:11434 WITH grant.allowLoopback:true -> fetch IS invoked (permitted)", async () => {
    const { fetch: fetchMock, calls } = makeFetchMock();
    const deps: OllamaProviderDeps = { fetch: fetchMock, grant: grant({ baseUrl: "http://localhost:11434", allowLoopback: true }) };
    const provider = new OllamaProvider(deps);

    const events = await collectEvents(provider.stream(buildRequest("request-loopback-allow"), { attemptId: "attempt-loopback-allow" }));

    expect(calls).toHaveLength(1);
    expect(events.some((evt) => evt.kind === "provider_error")).toBe(false);
  });

  test("the SAME loopback baseUrl WITHOUT allowLoopback -> fail-closed provider_error, fetch NEVER called", async () => {
    const { fetch: fetchMock, calls } = makeFetchMock();
    const deps: OllamaProviderDeps = { fetch: fetchMock, grant: grant({ baseUrl: "http://localhost:11434" }) };
    const provider = new OllamaProvider(deps);

    const events = await collectEvents(provider.stream(buildRequest("request-loopback-deny"), { attemptId: "attempt-loopback-deny" }));

    expect(calls).toHaveLength(0);
    expect(events).toHaveLength(1);
    const evt = events[0]!;
    expect(evt.kind).toBe("provider_error");
    const error = evt.error as NormalizedError;
    expect(error.retryable).toBe(false);
  });

  test("baseUrl=http://169.254.169.254/ WITH allowLoopback:true -> STILL fail-closed, fetch NEVER called (metadata denied even with opt-in)", async () => {
    const { fetch: fetchMock, calls } = makeFetchMock();
    const deps: OllamaProviderDeps = { fetch: fetchMock, grant: grant({ baseUrl: "http://169.254.169.254/", allowLoopback: true }) };
    const provider = new OllamaProvider(deps);

    const events = await collectEvents(provider.stream(buildRequest("request-metadata-deny"), { attemptId: "attempt-metadata-deny" }));

    expect(calls).toHaveLength(0);
    expect(events).toHaveLength(1);
    const evt = events[0]!;
    expect(evt.kind).toBe("provider_error");
    const error = evt.error as NormalizedError;
    expect(error.retryable).toBe(false);
  });

  test("baseUrl=http://10.0.0.5:11434/ WITH allowLoopback:true -> fail-closed (private-LAN denied even with opt-in)", async () => {
    const { fetch: fetchMock, calls } = makeFetchMock();
    const deps: OllamaProviderDeps = { fetch: fetchMock, grant: grant({ baseUrl: "http://10.0.0.5:11434/", allowLoopback: true }) };
    const provider = new OllamaProvider(deps);

    const events = await collectEvents(provider.stream(buildRequest("request-private-lan-deny"), { attemptId: "attempt-private-lan-deny" }));

    expect(calls).toHaveLength(0);
    expect(events).toHaveLength(1);
    const evt = events[0]!;
    expect(evt.kind).toBe("provider_error");
    const error = evt.error as NormalizedError;
    expect(error.retryable).toBe(false);
  });

  test("baseUrl=https://public-ollama.example.com (public host) is permitted regardless of allowLoopback -> fetch IS invoked", async () => {
    const { fetch: fetchMock, calls } = makeFetchMock();
    const deps: OllamaProviderDeps = { fetch: fetchMock, grant: grant({ baseUrl: "https://public-ollama.example.com" }) };
    const provider = new OllamaProvider(deps);

    const events = await collectEvents(provider.stream(buildRequest("request-public-allow"), { attemptId: "attempt-public-allow" }));

    expect(calls).toHaveLength(1);
    expect(events.some((evt) => evt.kind === "provider_error")).toBe(false);
  });
});
