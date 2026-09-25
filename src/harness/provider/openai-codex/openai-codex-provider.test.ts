import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loginDeviceCode } from "../../../lib/oauth/login";
import { saveOAuthGrant } from "../../../lib/oauth/grants";
import { makeProvider } from "../make-provider";
import { OpenAiProvider } from "../openai/openai-provider";
import type { NormalizedEvent, NormalizedRequest, ProviderPort } from "../types";

// Synthetic Responses frames; never a live ChatGPT account or credential.
const textStream = readFileSync(join(import.meta.dir, "../openai/fixtures/text-stream.SYNTHETIC.sse"), "utf8");
const toolStream = readFileSync(join(import.meta.dir, "../openai/fixtures/tool-call-stream.SYNTHETIC.sse"), "utf8");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function configDir(): string {
  const root = mkdtempSync(join(tmpdir(), "keryx-codex-provider-"));
  roots.push(root);
  return root;
}
function request(): NormalizedRequest {
  return {
    providerId: "openai-codex", modelId: "gpt-5.4", systemInstruction: "Answer with tools when useful",
    messages: [{ role: "user", content: "Weather?" }],
    tools: [{ name: "get_weather", inputSchema: { type: "object", properties: { location: { type: "string" } } } }],
    budget: { maxOutputTokens: 32, runReservation: 32 }, options: { temperature: 0.2 },
    stream: true, requestId: "request", parentRunId: "run",
  };
}
async function collect(provider: ProviderPort, req = request(), signal?: AbortSignal): Promise<NormalizedEvent[]> {
  const events: NormalizedEvent[] = [];
  for await (const event of provider.stream(req, { attemptId: "attempt", ...(signal ? { signal } : {}) })) events.push(event);
  return events;
}
function saved(root: string, access = "subscription-access"): void {
  saveOAuthGrant("openai-codex", {
    method: "device-code", access, accountId: "account-fixture", expires: Date.now() + 3_600_000,
    obtainedAt: new Date().toISOString(),
  }, root);
}
function mockFetch(handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>): typeof fetch {
  return (async (url: RequestInfo | URL, init?: RequestInit) => handler(String(url), init)) as typeof fetch;
}

test("subscription login -> saved grant -> native factory -> streamed answer and tool roundtrip", async () => {
  const root = configDir();
  const calls: { url: string; init?: RequestInit }[] = [];
  const jwt = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account-fixture" }, exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.signature`;
  let modelCalls = 0;
  const fetch = mockFetch((url, init) => {
    calls.push({ url, ...(init ? { init } : {}) });
    if (url.endsWith("/deviceauth/usercode")) return Response.json({ device_auth_id: "device", user_code: "CODE", interval: 1 });
    if (url.endsWith("/deviceauth/token")) return Response.json({ authorization_code: "code", code_verifier: "verifier" });
    if (url.endsWith("/oauth/token")) return Response.json({ access_token: jwt, expires_in: 3600 });
    modelCalls++;
    return new Response(modelCalls === 1 ? toolStream : textStream);
  });
  expect((await loginDeviceCode({ provider: "openai-codex", dir: root, fetch: (url, init) => fetch(url, init), onChallenge: () => {} })).ok).toBe(true);
  const provider = makeProvider("openai-codex", "gpt-5.4", { fetch, configDir: root, env: { OPENAI_API_KEY: "platform-only" } });
  expect(provider.describe().descriptor.providerId).toBe("openai-codex");
  expect(modelCalls).toBe(0);
  const first = await collect(provider);
  expect(first.find((event) => event.kind === "tool_call_end")?.toolCallId).toBe("call_fixtureWeather0001");
  const next = request();
  next.messages = [
    ...next.messages,
    { role: "assistant", content: "", toolCalls: [{ id: "call_fixtureWeather0001", name: "get_weather", arguments: "{}" }] },
    { role: "tool", content: "sunny", toolCallId: "call_fixtureWeather0001" },
  ];
  const second = await collect(provider, next);
  expect(second.filter((event) => event.kind === "text_delta").map((event) => event.text).join("")).toBe("The weather in NYC is sunny.");
  expect(second.at(-1)?.kind).toBe("model_end");
  const last = calls.at(-1)!;
  expect(last.url).toBe("https://chatgpt.com/backend-api/codex/responses");
  const headers = new Headers(last.init?.headers);
  expect(headers.get("authorization")).toBe(`Bearer ${jwt}`);
  expect(headers.get("chatgpt-account-id")).toBe("account-fixture");
  expect(headers.get("originator")).toBe("keryx");
  expect(headers.get("user-agent")).toContain("keryx");
  const body = JSON.parse(String(last.init?.body));
  expect(body).toMatchObject({ stream: true, store: false, tool_choice: "auto", parallel_tool_calls: true });
  expect(body.max_output_tokens).toBeUndefined();
  expect(body.temperature).toBeUndefined();
  expect(body.input).toContainEqual({ type: "function_call_output", call_id: "call_fixtureWeather0001", output: "sunny" });
});

test("long-running provider reads the new saved credential on every stream", async () => {
  const root = configDir(); saved(root, "first-access");
  const headers: string[] = [];
  const fetch = mockFetch((_url, init) => { headers.push(new Headers(init?.headers).get("authorization")!); return new Response(textStream); });
  const provider = makeProvider("openai-codex", "gpt-5.4", { fetch, configDir: root, env: {} });
  await collect(provider); saved(root, "rotated-access"); await collect(provider);
  expect(headers).toEqual(["Bearer first-access", "Bearer rotated-access"]);
});

test("scoped credentials cannot discover ambient saved OAuth or use an API key", async () => {
  const root = configDir(); saved(root);
  let calls = 0;
  const fetch = mockFetch(() => { calls++; return new Response(textStream); });
  const provider = makeProvider("openai-codex", "gpt-5.4", { fetch, configDir: root, credentials: { OPENAI_API_KEY: "platform-only" } });
  expect(provider.describe().descriptor.providerId).toBe("openai-codex");
  const events = await collect(provider);
  expect(calls).toBe(0);
  expect(events.at(-1)?.error?.kind).toBe("authentication");
});

test("missing subscription fails actionably instead of an empty FakeProvider answer", async () => {
  const root = configDir();
  const fetch = mockFetch(() => { throw new Error("must not contact network"); });
  const events = await collect(makeProvider("openai-codex", "gpt-5.4", { fetch, configDir: root, env: { OPENAI_API_KEY: "platform-only" } }));
  expect(events).toHaveLength(1);
  expect(events[0]?.error?.kind).toBe("authentication");
  expect(events[0]?.error?.message).toContain("keryx auth login openai-codex");
});

test("pre-cancelled stream never resolves authentication or reaches the network", async () => {
  const root = configDir(); saved(root);
  let calls = 0;
  const fetch = mockFetch(() => { calls++; return new Response(textStream); });
  const signal = AbortSignal.abort();
  const events = await collect(makeProvider("openai-codex", "gpt-5.4", { fetch, configDir: root }), request(), signal);
  expect(calls).toBe(0);
  expect(events.map((event) => event.error?.kind)).toEqual(["cancelled"]);
});

test("subscription HTTP authentication error is typed and does not disclose bearer", async () => {
  const root = configDir(); saved(root);
  const fetch = mockFetch(() => Response.json({ error: { message: "bad subscription-access" } }, { status: 401 }));
  const events = await collect(makeProvider("openai-codex", "gpt-5.4", { fetch, configDir: root }));
  expect(events.at(-1)?.error?.kind).toBe("authentication");
  expect(JSON.stringify(events)).not.toContain("subscription-access");
  expect(events.at(-1)?.error?.message).toContain("keryx auth login openai-codex");
});

test("401 refreshes once before content, persists rotation and sends the new bearer", async () => {
  const root = configDir();
  saveOAuthGrant("openai-codex", { method: "device-code", access: "old-access", refresh: "old-refresh", accountId: "account-fixture", expires: Date.now() + 3600000, obtainedAt: new Date().toISOString() }, root);
  const authorizations: string[] = [];
  let refreshCalls = 0;
  const fetch = mockFetch((url, init) => {
    if (url.endsWith("/oauth/token")) {
      refreshCalls++;
      return Response.json({ access_token: "new-access", refresh_token: "rotated-refresh", expires_in: 3600 });
    }
    const authorization = new Headers(init?.headers).get("authorization")!;
    authorizations.push(authorization);
    return authorization === "Bearer old-access" ? new Response(null, { status: 401 }) : new Response(textStream);
  });
  const events = await collect(makeProvider("openai-codex", "gpt-5.4", { fetch, configDir: root }));
  expect(refreshCalls).toBe(1);
  expect(authorizations).toEqual(["Bearer old-access", "Bearer new-access"]);
  expect(events.at(-1)?.kind).toBe("model_end");
  expect(events.some((event) => event.kind === "provider_error")).toBe(false);
});

test("Codex reasoning replay remains owned by subscription and is echoed before a tool result", async () => {
  const root = configDir(); saved(root);
  const reasoning = { id: "reasoning-id", type: "reasoning", encrypted_content: "opaque", summary: [] };
  const sse = `data: ${JSON.stringify({ type: "response.output_item.done", item: reasoning })}\n\ndata: ${JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } })}\n\n`;
  const bodies: Record<string, unknown>[] = [];
  const fetch = mockFetch((_url, init) => { bodies.push(JSON.parse(String(init?.body))); return new Response(sse); });
  const provider = makeProvider("openai-codex", "gpt-5.4", { fetch, configDir: root });
  const events = await collect(provider);
  const replay = events.find((event) => event.kind === "reasoning_replay")?.replay;
  expect(replay).toEqual({ providerId: "openai-codex", kind: "reasoning_item", data: reasoning });
  const next = request();
  next.options = { reasoning: "high" };
  next.messages = [
    { role: "assistant", content: "", toolCalls: [{ id: "call", name: "get_weather", arguments: "{}" }], reasoning: { replay: [replay!, { providerId: "openai", kind: "reasoning_item", data: { type: "reasoning", id: "platform-only" } }] } },
    { role: "tool", content: "result", toolCallId: "call" },
  ];
  await collect(provider, next);
  expect(bodies[1]?.input).toEqual([reasoning, { type: "function_call", call_id: "call", name: "get_weather", arguments: "{}" }, { type: "function_call_output", call_id: "call", output: "result" }]);
  expect(bodies[1]?.include).toEqual(["reasoning.encrypted_content"]);
});

test("aborting an accepted but stalled subscription stream cancels the reader promptly", async () => {
  const abort = new AbortController();
  let cancelled = false;
  const fetch = mockFetch(() => new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  const provider = new OpenAiProvider({ fetch, grant: { network: true, apiKey: "fake-access" }, codex: { accountId: "account" }, firstByteTimeoutMs: 40 });
  const pending = collect(provider, request(), abort.signal);
  setTimeout(() => abort.abort(), 5);
  const events = await pending;
  expect(events.map((event) => event.error?.kind)).toEqual(["cancelled"]);
  expect(cancelled).toBe(true);
});
