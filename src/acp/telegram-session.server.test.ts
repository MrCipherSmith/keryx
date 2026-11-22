import { expect, test } from "bun:test";
import type { ProviderPort } from "../harness/provider/types";
import { ACP_PROTOCOL_VERSION } from "./protocol";
import { harness } from "./server-harness.test-helpers";
import { ACP_TELEGRAM_SESSION_METHOD } from "./telegram-session";

async function open(h: ReturnType<typeof harness>): Promise<string> {
  const init = h.request("initialize", { protocolVersion: ACP_PROTOCOL_VERSION });
  await h.waitFor((frame) => frame.id === init);
  const request = h.request("session/new", { cwd: h.projectDir, mcpServers: [] });
  const response = await h.waitFor((frame) => frame.id === request);
  return String(response.result?.sessionId);
}

test("session control is unavailable by default and refuses an unheld session", async () => {
  const h = harness({ profile: "shell", provider: {} as ProviderPort });
  try {
    const sessionId = await open(h);
    const request = h.request(ACP_TELEGRAM_SESSION_METHOD, { operation: "attach", sessionId });
    expect((await h.waitFor((frame) => frame.id === request)).result).toEqual({ sessionId, state: "unavailable", reason: "capability-unavailable" });
    const unknown = h.request(ACP_TELEGRAM_SESSION_METHOD, { operation: "attach", sessionId: "unheld" });
    expect((await h.waitFor((frame) => frame.id === unknown)).result).toEqual({ sessionId: "unheld", state: "unavailable", reason: "lease-lost" });
  } finally { await h.end(); }
});

test("session control binds the held root, emits state, and closes on connection end", async () => {
  const inputs: { sessionId: string; project: string; owner: { kind: string; incarnation: string; generation: string } }[] = [];
  let closed = 0;
  const h = harness({ profile: "shell", provider: {} as ProviderPort, telegramBindingTestOnly: { create: (input) => {
    inputs.push(input);
    return { start: async () => ({ ok: true, threadId: 123 }), close: async () => { closed++; }, reply: async () => true };
  } } });
  try {
    const sessionId = await open(h);
    const unknown = h.request(ACP_TELEGRAM_SESSION_METHOD, { operation: "attach", sessionId: "unheld" });
    await h.waitFor((frame) => frame.id === unknown);
    expect(inputs).toHaveLength(0);
    const request = h.request(ACP_TELEGRAM_SESSION_METHOD, { operation: "attach", sessionId, topicName: "work" });
    const reply = await h.waitFor((frame) => frame.id === request);
    expect(reply.result).toEqual({ sessionId, state: "active" });
    expect(inputs[0]?.project).toBe(h.projectDir);
    expect(inputs[0]?.owner.kind).toBe("desktop");
    expect(inputs[0]?.owner.generation).toBeTruthy();
    expect(h.frames.some((frame) => frame.method === "session/update" && frame.params?.update?.sessionUpdate === "_keryx/telegram/session")).toBe(true);
  } finally { await h.end(); }
  expect(closed).toBe(1);
});

test("trusted inbound shares the ACP turn slot and refuses busy, duplicate and invalid actor", async () => {
  let onLine!: (text: string, meta: import("../remote/client").InboundMeta) => Promise<void>;
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const enteredTurn = new Promise<void>((resolve) => { entered = resolve; });
  let turns = 0;
  const replies: string[] = [];
  const provider = {
    describe: () => ({ capabilities: { streaming: true, toolCalls: false, parallelToolCalls: false, structuredOutput: false, reasoningMetadata: false, promptCaching: false, vision: false, tokenCounting: false, modelListing: false }, descriptor: { providerId: "test" } }),
    stream: (_request: unknown, opts: { attemptId: string }) => (async function* () {
      turns++; entered(); await wait;
      yield { sequence: 0, attemptId: opts.attemptId, kind: "text_delta", text: "done" };
      yield { sequence: 1, attemptId: opts.attemptId, kind: "model_end" };
    })(),
  } as unknown as ProviderPort;
  const h = harness({ profile: "shell", provider, telegramBindingTestOnly: { create: (input) => {
    onLine = input.onLine;
    return { start: async () => ({ ok: true, threadId: 123 }), close: async () => {}, reply: async (text) => { replies.push(text); return true; } };
  } } });
  try {
    const sessionId = await open(h);
    const attach = h.request(ACP_TELEGRAM_SESSION_METHOD, { operation: "attach", sessionId });
    await h.waitFor((frame) => frame.id === attach);
    const meta = { updateId: 1, threadId: 123, fromId: 42, receivedAt: Date.now() };
    const first = onLine("first", meta);
    await enteredTurn;
    await onLine("second", { ...meta, updateId: 2 });
    await onLine("duplicate", meta);
    await onLine("forged", { ...meta, updateId: 3, fromId: 0 });
    expect(turns).toBe(1);
    expect(replies).toEqual(["Input refused: this session is busy.", "Input refused: this update was already received.", "Input refused: invalid sender or message."]);
    release();
    await first;
  } finally { release(); await h.end(); }
});

test("Telegram stop aborts only its own turn and suppresses its final reply", async () => {
  let onLine!: (text: string, meta: import("../remote/client").InboundMeta) => Promise<void>;
  let finish!: () => void;
  const wait = new Promise<void>((resolve) => { finish = resolve; });
  let started!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const replies: string[] = [];
  const provider = {
    describe: () => ({ capabilities: { streaming: true, toolCalls: false, parallelToolCalls: false, structuredOutput: false, reasoningMetadata: false, promptCaching: false, vision: false, tokenCounting: false, modelListing: false }, descriptor: { providerId: "test" } }),
    stream: (_request: unknown, opts: { attemptId: string }) => (async function* () {
      started(); await wait;
      yield { sequence: 0, attemptId: opts.attemptId, kind: "text_delta", text: "should not appear" };
      yield { sequence: 1, attemptId: opts.attemptId, kind: "model_end" };
    })(),
  } as unknown as ProviderPort;
  const h = harness({ profile: "shell", provider, telegramBindingTestOnly: { create: (input) => {
    onLine = input.onLine;
    return { start: async () => ({ ok: true, threadId: 123 }), close: async () => {}, reply: async (text) => { replies.push(text); return true; } };
  } } });
  try {
    const sessionId = await open(h);
    const attach = h.request(ACP_TELEGRAM_SESSION_METHOD, { operation: "attach", sessionId });
    await h.waitFor((f) => f.id === attach);
    const meta = { updateId: 1, threadId: 123, fromId: 42, receivedAt: Date.now() };
    await onLine("hello", meta);
    await entered;
    await onLine("/stop", { ...meta, updateId: 2 });
    expect(replies).toContain("Stopping the Telegram turn.");
    finish();
  } finally { finish(); await h.end(); }
  expect(replies).not.toContain("should not appear");
});

test("final Telegram response is emitted once with secrets redacted", async () => {
  let onLine!: (text: string, meta: import("../remote/client").InboundMeta) => Promise<void>;
  let replied!: () => void;
  const replySeen = new Promise<void>((resolve) => { replied = resolve; });
  const replies: string[] = [];
  const provider = {
    describe: () => ({ capabilities: { streaming: true, toolCalls: false, parallelToolCalls: false, structuredOutput: false, reasoningMetadata: false, promptCaching: false, vision: false, tokenCounting: false, modelListing: false }, descriptor: { providerId: "test" } }),
    stream: (_request: unknown, opts: { attemptId: string }) => (async function* () {
      yield { sequence: 0, attemptId: opts.attemptId, kind: "text_delta", text: "final answer Authorization: Bearer test-secret-token-value-123456789" };
      yield { sequence: 1, attemptId: opts.attemptId, kind: "model_end" };
    })(),
  } as unknown as ProviderPort;
  const h = harness({ profile: "shell", provider, telegramBindingTestOnly: { create: (input) => {
    onLine = input.onLine;
    return { start: async () => ({ ok: true, threadId: 123 }), close: async () => {}, reply: async (text) => { replies.push(text); replied(); return true; } };
  } } });
  try {
    const sessionId = await open(h);
    const attach = h.request(ACP_TELEGRAM_SESSION_METHOD, { operation: "attach", sessionId });
    await h.waitFor((f) => f.id === attach);
    await onLine("hello", { updateId: 1, threadId: 123, fromId: 42, receivedAt: Date.now() });
    await replySeen;
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("final answer");
    expect(replies[0]).not.toContain("test-secret-token-value-123456789");
  } finally { await h.end(); }
});

test("Telegram stop and detach leave a Desktop-origin turn running", async () => {
  let onLine!: (text: string, meta: import("../remote/client").InboundMeta) => Promise<void>;
  let finish!: () => void;
  const wait = new Promise<void>((resolve) => { finish = resolve; });
  let started!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const replies: string[] = [];
  const provider = {
    describe: () => ({ capabilities: { streaming: true, toolCalls: false, parallelToolCalls: false, structuredOutput: false, reasoningMetadata: false, promptCaching: false, vision: false, tokenCounting: false, modelListing: false }, descriptor: { providerId: "test" } }),
    stream: (_request: unknown, opts: { attemptId: string }) => (async function* () {
      started(); await wait;
      yield { sequence: 0, attemptId: opts.attemptId, kind: "text_delta", text: "desktop done" };
      yield { sequence: 1, attemptId: opts.attemptId, kind: "model_end" };
    })(),
  } as unknown as ProviderPort;
  const h = harness({ profile: "shell", provider, telegramBindingTestOnly: { create: (input) => {
    onLine = input.onLine;
    return { start: async () => ({ ok: true, threadId: 123 }), close: async () => {}, reply: async (text) => { replies.push(text); return true; } };
  } } });
  try {
    const sessionId = await open(h);
    const attach = h.request(ACP_TELEGRAM_SESSION_METHOD, { operation: "attach", sessionId });
    await h.waitFor((f) => f.id === attach);
    const prompt = h.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "local" }] });
    await entered;
    await onLine("/stop", { updateId: 1, threadId: 123, fromId: 42, receivedAt: Date.now() });
    expect(replies).toEqual(["No Telegram turn is running for this attachment."]);
    const detach = h.request(ACP_TELEGRAM_SESSION_METHOD, { operation: "detach", sessionId });
    await h.waitFor((f) => f.id === detach);
    finish();
    expect((await h.waitFor((f) => f.id === prompt)).result?.stopReason).toBe("end_turn");
    expect(replies).toEqual(["No Telegram turn is running for this attachment."]);
  } finally { finish(); await h.end(); }
});

test("a Desktop turn mirrors its final answer to the binding captured at admission", async () => {
  const replies: string[] = [];
  const provider = {
    describe: () => ({ capabilities: { streaming: true, toolCalls: false, parallelToolCalls: false, structuredOutput: false, reasoningMetadata: false, promptCaching: false, vision: false, tokenCounting: false, modelListing: false }, descriptor: { providerId: "test" } }),
    stream: (_request: unknown, opts: { attemptId: string }) => (async function* () {
      yield { sequence: 0, attemptId: opts.attemptId, kind: "text_delta", text: "desktop answer" };
      yield { sequence: 1, attemptId: opts.attemptId, kind: "model_end" };
    })(),
  } as unknown as ProviderPort;
  const h = harness({ profile: "shell", provider, telegramBindingTestOnly: { create: () => ({ start: async () => ({ ok: true, threadId: 123 }), close: async () => {}, reply: async (text) => { replies.push(text); return true; } }) } });
  try {
    const sessionId = await open(h);
    const attach = h.request(ACP_TELEGRAM_SESSION_METHOD, { operation: "attach", sessionId });
    await h.waitFor((f) => f.id === attach);
    const prompt = h.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "local" }] });
    expect((await h.waitFor((f) => f.id === prompt)).result?.stopReason).toBe("end_turn");
    expect(replies).toEqual(["desktop answer"]);
  } finally { await h.end(); }
});
