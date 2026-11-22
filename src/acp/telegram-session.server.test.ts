import { expect, test } from "bun:test";
import type { ProviderPort } from "../harness/provider/types";
import path from "node:path";
import { openSession } from "../session/store";
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
    const startIndex = h.frames.findIndex((frame) => frame.method === "session/update" && frame.params?.update?.sessionUpdate === "_keryx/telegram/turn" && (frame.params.update as { phase?: string }).phase === "started");
    expect(startIndex).toBeGreaterThanOrEqual(0);
    expect(h.frames[startIndex + 1]?.params?.update?.sessionUpdate).toBe("user_message_chunk");
    expect(h.frames[startIndex + 1]?.params?.update?.content?.text).toBe("first");
    await onLine("second", { ...meta, updateId: 2 });
    await onLine("duplicate", meta);
    await onLine("forged", { ...meta, updateId: 3, fromId: 0 });
    expect(turns).toBe(1);
    expect(replies).toEqual(["Input refused: this session is busy.", "Input refused: this update was already received.", "Input refused: invalid sender or message."]);
    release();
    await first;
    await h.waitFor((frame) => frame.method === "session/update" && frame.params?.update?.sessionUpdate === "_keryx/telegram/turn" && (frame.params.update as { phase?: string }).phase === "finished");
    const persisted = openSession({ cwd: h.projectDir, dataDir: path.join(h.projectDir, "data"), resumeId: sessionId });
    expect(persisted.archive.find((message) => message.role === "user")).toMatchObject({ content: "first", source: "telegram" });
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

test("Desktop turns finish while Telegram replies queue in order and report unconfirmed delivery", async () => {
  const replies: string[] = [];
  let replyStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => { replyStarted = resolve; });
  let secondReplyStarted!: () => void;
  const secondStarted = new Promise<void>((resolve) => { secondReplyStarted = resolve; });
  let finishReply!: (accepted: boolean) => void;
  const firstReply = new Promise<boolean>((resolve) => { finishReply = resolve; });
  let turn = 0;
  const provider = {
    describe: () => ({ capabilities: { streaming: true, toolCalls: false, parallelToolCalls: false, structuredOutput: false, reasoningMetadata: false, promptCaching: false, vision: false, tokenCounting: false, modelListing: false }, descriptor: { providerId: "test" } }),
    stream: (_request: unknown, opts: { attemptId: string }) => (async function* () {
      yield { sequence: 0, attemptId: opts.attemptId, kind: "text_delta", text: `desktop answer ${++turn}` };
      yield { sequence: 1, attemptId: opts.attemptId, kind: "model_end" };
    })(),
  } as unknown as ProviderPort;
  const h = harness({ profile: "shell", provider, telegramBindingTestOnly: { create: () => ({
    start: async () => ({ ok: true, threadId: 123 }),
    close: async () => {},
    reply: async (text) => {
      replies.push(text);
      if (replies.length === 1) {
        replyStarted();
        return firstReply;
      }
      secondReplyStarted();
      return true;
    },
  }) } });
  try {
    const sessionId = await open(h);
    const attach = h.request(ACP_TELEGRAM_SESSION_METHOD, { operation: "attach", sessionId });
    await h.waitFor((f) => f.id === attach);
    const prompt = h.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "local" }] });
    await firstStarted;
    expect((await h.waitFor((f) => f.id === prompt)).result?.stopReason).toBe("end_turn");
    const next = h.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "next" }] });
    expect((await h.waitFor((f) => f.id === next)).result?.stopReason).toBe("end_turn");
    expect(replies).toEqual(["desktop answer 1"]);
    finishReply(false);
    const delivery = await h.waitFor((f) => f.params?.update?.sessionUpdate === "_keryx/telegram/delivery");
    expect(delivery.params).toMatchObject({ sessionId, update: { status: "unconfirmed" } });
    await secondStarted;
    expect(replies).toEqual(["desktop answer 1", "desktop answer 2"]);
  } finally { finishReply(false); await h.end(); }
});

test("production composition requires explicit Desktop opt-in and verified serve", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const configDir = mkdtempSync(join(tmpdir(), "keryx-telegram-gate-"));
  const h = harness({ profile: "shell", provider: {} as ProviderPort, telegramSessionEnabled: true, shellConfigDir: configDir });
  try {
    const init = h.request("initialize", { protocolVersion: ACP_PROTOCOL_VERSION, clientCapabilities: { _meta: { keryx: { telegramSession: true } } } });
    const initialized = await h.waitFor((frame) => frame.id === init);
    const meta = initialized.result?._meta as { keryx?: { extensions?: string[] } };
    expect(meta.keryx?.extensions).toContain(ACP_TELEGRAM_SESSION_METHOD);
    const create = h.request("session/new", { cwd: h.projectDir, mcpServers: [] });
    const sessionId = String((await h.waitFor((frame) => frame.id === create)).result?.sessionId);
    const attach = h.request(ACP_TELEGRAM_SESSION_METHOD, { operation: "attach", sessionId });
    expect((await h.waitFor((frame) => frame.id === attach)).result).toMatchObject({ sessionId, state: "unavailable" });
  } finally { await h.end(); rmSync(configDir, { recursive: true, force: true }); }
});

test("trusted host gate alone does not advertise capability to other clients", async () => {
  const h = harness({ profile: "shell", provider: {} as ProviderPort, telegramSessionEnabled: true });
  try {
    const init = h.request("initialize", { protocolVersion: ACP_PROTOCOL_VERSION, clientCapabilities: {} });
    const initialized = await h.waitFor((frame) => frame.id === init);
    const meta = initialized.result?._meta as { keryx?: { extensions?: string[] } };
    expect(meta.keryx?.extensions).not.toContain(ACP_TELEGRAM_SESSION_METHOD);
  } finally { await h.end(); }
});

test("Desktop opt-in projects only the vetted question and Telegram resolves the same request once", async () => {
  let ask!: import("../lib/ask-user-contract").AskUserFn;
  let claim!: (index: number, fromId: number) => boolean;
  let questionSignal!: AbortSignal;
  let finish!: () => void;
  const wait = new Promise<void>((resolve) => { finish = resolve; });
  let started!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const provider = {
    describe: () => ({ capabilities: { streaming: true, toolCalls: false, parallelToolCalls: false, structuredOutput: false, reasoningMetadata: false, promptCaching: false, vision: false, tokenCounting: false, modelListing: false }, descriptor: { providerId: "test" } }),
    stream: (_request: unknown, opts: { attemptId: string }) => (async function* () { started(); await wait; yield { sequence: 0, attemptId: opts.attemptId, kind: "model_end" }; })(),
  } as unknown as ProviderPort;
  const h = harness({ profile: "shell", provider, buildShellRoster: (input) => { if (input.askUser) ask = input.askUser; return []; }, telegramBindingTestOnly: { create: () => ({
    start: async () => ({ ok: true, threadId: 123 }), close: async () => {}, reply: async () => true,
    askChoice: async (question, rows, _timeout, options) => { expect(question).toBe("Which response format do you prefer?"); expect(rows).toEqual([["Concise"], ["Detailed"]]); claim = options.claim; questionSignal = options.signal; return new Promise(() => {}); },
  }) } });
  try {
    const init = h.request("initialize", { protocolVersion: ACP_PROTOCOL_VERSION, clientCapabilities: { _meta: { keryx: { askUser: true } } } });
    await h.waitFor((f) => f.id === init);
    const create = h.request("session/new", { cwd: h.projectDir, mcpServers: [] });
    const sessionId = String((await h.waitFor((f) => f.id === create)).result?.sessionId);
    const attach = h.request(ACP_TELEGRAM_SESSION_METHOD, { operation: "attach", sessionId });
    await h.waitFor((f) => f.id === attach);
    const prompt = h.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "hello" }] });
    await entered;
    const answer = ask({ question: "Which response format do you prefer?", options: [{ id: "brief", label: "Concise", description: "private ignored" }, { id: "long", label: "Detailed", description: "private ignored" }] });
    const question = await h.waitFor((f) => f.method === "_keryx/ask_user");
    expect((question.params as unknown as { _meta?: { keryx?: { telegramProjectable?: boolean } } })._meta?.keryx?.telegramProjectable).toBe(true);
    const project = h.request("_keryx/telegram/project-question", { sessionId, requestId: question.id });
    expect((await h.waitFor((f) => f.id === project)).result).toEqual({ projected: true });
    expect(claim(1, 0)).toBe(false);
    expect(claim(1, 42)).toBe(true);
    expect(await answer).toBe("long");
    expect(claim(0, 42)).toBe(false);
    const close = await h.waitFor((f) => f.method === "session/update" && f.params?.update?.sessionUpdate === "_keryx/telegram/decision");
    expect((close.params?.update as { requestId?: string }).requestId).toBe(String(question.id));
    h.respond(question.id, { result: { outcome: "answered", answers: ["Concise"] } });
    const secondAnswer = ask({ question: "Which response format do you prefer?", options: [{ id: "brief", label: "Concise", description: "" }, { id: "long", label: "Detailed", description: "" }] });
    const second = await h.waitFor((f) => f.method === "_keryx/ask_user" && f.id !== question.id);
    const secondProject = h.request("_keryx/telegram/project-question", { sessionId, requestId: second.id });
    expect((await h.waitFor((f) => f.id === secondProject)).result).toEqual({ projected: true });
    h.respond(second.id, { result: { outcome: "answered", answers: ["Concise"] } });
    expect(await secondAnswer).toBe("brief");
    expect(questionSignal.aborted).toBe(true);
    expect(claim(1, 42)).toBe(false);
    const unsafeAnswer = ask({ question: "Publish the release?", options: [{ id: "yes", label: "Yes", description: "" }, { id: "no", label: "No", description: "" }], irreversible: true });
    const unsafe = await h.waitFor((f) => f.method === "_keryx/ask_user" && f.id !== question.id && f.id !== second.id);
    expect((unsafe.params as unknown as { _meta?: { keryx?: { telegramProjectable?: boolean } } })._meta?.keryx?.telegramProjectable).toBeUndefined();
    const refused = h.request("_keryx/telegram/project-question", { sessionId, requestId: unsafe.id });
    expect((await h.waitFor((f) => f.id === refused)).result).toEqual({ projected: false });
    h.respond(unsafe.id, { result: { outcome: "answered", answers: ["No"] } });
    expect(await unsafeAnswer).toBe("no");
    const detachedAnswer = ask({ question: "Which response format do you prefer?", options: [{ id: "brief", label: "Concise", description: "" }, { id: "long", label: "Detailed", description: "" }] });
    const detachedQuestion = await h.waitFor((f) => f.method === "_keryx/ask_user" && f.id !== question.id && f.id !== second.id && f.id !== unsafe.id);
    const thirdProject = h.request("_keryx/telegram/project-question", { sessionId, requestId: detachedQuestion.id });
    expect((await h.waitFor((f) => f.id === thirdProject)).result).toEqual({ projected: true });
    const detach = h.request(ACP_TELEGRAM_SESSION_METHOD, { operation: "detach", sessionId });
    await h.waitFor((f) => f.id === detach);
    expect(questionSignal.aborted).toBe(true);
    expect(claim(1, 42)).toBe(false);
    h.respond(detachedQuestion.id, { result: { outcome: "answered", answers: ["Concise"] } });
    expect(await detachedAnswer).toBe("brief");
    finish();
    await h.waitFor((f) => f.id === prompt);
  } finally { finish(); await h.end(); }
});
