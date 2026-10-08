import { expect, test } from "bun:test";
import { recoveryDelayMs, runAgentTurn, waitForRecovery, type AgentDeps, type AgentIO, type InteractiveRecovery } from "./agent";
import { scriptedProvider, type Script } from "./agent.test-helpers";
import type { NormalizedMessage, NormalizedUsage } from "../harness/provider/types";
import type { InteractiveTool } from "../harness/tool/builtin/interactive-tools";
import { createForegroundOperationOwner, createForegroundAgentIoFacade, runAfterForegroundSettlement, settleForegroundOperation } from "../tui/foreground-operation";

const ok: Script = [{ kind: "text_delta", text: "Recovered answer." }, { kind: "model_end" }];
const temporary = (kind: "unavailable" | "rate_limit" | "overloaded" = "unavailable", retryAfterMs?: number): Script => [
  { kind: "provider_error", error: { kind, retryable: true, message: "temporary provider outage", ...(retryAfterMs === undefined ? {} : { retryAfterMs }) } },
];
const call: Script = [
  { kind: "tool_call_start", toolCallId: "c1", toolName: "change" },
  { kind: "tool_call_end", toolCallId: "c1", input: "{}" },
];
function fixture(scripts: Script[], overrides: Partial<AgentDeps> = {}) {
  const { provider, requests } = scriptedProvider(scripts, { exhausted: "empty" });
  const system: string[] = [];
  const text: string[] = [];
  const checkpoints: string[] = [];
  const finalReasoning: string[] = [];
  const usage: NormalizedUsage[] = [];
  const history: NormalizedMessage[] = [];
  const delays: number[] = [];
  let seq = 0;
  let discarded = 0;
  const io: AgentIO = {
    write: (s) => text.push(s), onSystem: (s) => system.push(s),
    onAttemptInterrupted: () => { discarded += 1; },
    onHistoryChange: () => checkpoints.push(JSON.stringify(history)),
    onReasoningEnd: (r) => finalReasoning.push(r.text),
    onUsage: (u) => usage.push(u),
  };
  const deps: AgentDeps = { provider, providerId: "scripted", modelId: "m", tools: [], systemInstruction: "sys", idSeq: () => `id${seq++}`, ...overrides };
  const recovery: InteractiveRecovery = { wait: async (ms) => { delays.push(ms); }, random: () => 0.5 };
  const run = (options = {}) => runAgentTurn(io, deps, history, "hello", { recovery, ...options });
  return { io, deps, history, requests, system, text, checkpoints, finalReasoning, usage, delays, recovery, run, discarded: () => discarded };
}

for (const kind of ["unavailable", "rate_limit", "overloaded"] as const) {
  test(`interactive ${kind} automatically retries one prompt`, async () => {
    const f = fixture([temporary(kind), ok], { maxRounds: 1 });
    expect(await f.run()).toEqual({});
    expect(f.requests).toHaveLength(2);
    expect(f.history.filter((m) => m.role === "user")).toHaveLength(1);
    expect(f.history.at(-1)?.content).toBe("Recovered answer.");
    expect(f.delays).toEqual([750]);
    expect(f.system.join("")).not.toContain("[error]");
  });
}

test("long outage keeps probing beyond a short retry batch with a capped frequency", async () => {
  const f = fixture([...Array.from({ length: 18 }, () => temporary()), ok], { maxRounds: 1 });
  await f.run();
  expect(f.requests).toHaveLength(19);
  expect(f.delays.slice(0, 4)).toEqual([750, 1500, 3000, 6000]);
  expect(f.delays.at(-1)).toBe(45_000);
  expect(f.history).toHaveLength(2);
});

test("partial text/reasoning/replay are visible but never checkpointed or sent in retry history", async () => {
  const f = fixture([[
    { kind: "reasoning_delta", text: "provisional thought" },
    { kind: "reasoning_replay", replay: { providerId: "openai", kind: "opaque", data: "incomplete" } },
    { kind: "text_delta", text: "incomplete answer" }, ...temporary(),
  ], ok]);
  await f.run();
  expect(f.text).toContain("incomplete answer");
  expect(f.system.join("")).toContain("[interrupted output]");
  expect(f.discarded()).toBe(1);
  expect(f.finalReasoning).toEqual([]);
  expect(f.checkpoints.join("")).not.toContain("provisional");
  expect(f.checkpoints.join("")).not.toContain("incomplete");
  expect(JSON.stringify(f.requests[1]?.messages)).not.toContain("incomplete");
});

for (const ending of [[], temporary()] as Script[]) {
  test(`completed tool args before ${ending.length ? "error" : "EOF"} must not execute`, async () => {
    let invoked = 0;
    const tool: InteractiveTool = { definition: { name: "change", description: "change", inputSchema: { type: "object" }, risk: "read" }, invoke: async () => { invoked += 1; return { output: "done", isError: false }; } };
    const f = fixture([[...call, ...ending], ok], { tools: [tool] });
    await f.run();
    expect(invoked).toBe(0);
    expect(f.history.some((m) => m.role === "tool")).toBe(false);
    expect(f.requests).toHaveLength(2);
  });
}

test("previous successful tools and approvals survive a later failed round without duplication", async () => {
  let invoked = 0;
  let approvals = 0;
  const tool: InteractiveTool = { definition: { name: "change", description: "change", inputSchema: { type: "object" }, risk: "write" }, invoke: async () => { invoked += 1; return { output: "saved result", isError: false }; } };
  const f = fixture([[...call, { kind: "model_end" }], temporary(), ok], { tools: [tool], maxRounds: 2, maxToolCalls: 2 });
  f.io.requestApproval = async () => { approvals += 1; return true; };
  await f.run();
  expect(invoked).toBe(1);
  expect(approvals).toBe(1);
  expect(f.requests).toHaveLength(3);
  expect(f.requests[1]?.messages).toEqual(f.requests[2]?.messages);
  expect(f.requests[2]?.messages.some((m) => m.role === "tool" && m.content.includes("saved result"))).toBe(true);
});

test("plain EOF and explicitly classified adapter truncation recover", async () => {
  const f = fixture([[], [{ kind: "provider_error", error: { kind: "malformed", retryable: false, message: "truncated", detail: { incompleteStream: true } } }], ok]);
  await f.run();
  expect(f.requests).toHaveLength(3);
});

test("thrown fetch failure recovers but programming errors terminate", async () => {
  for (const message of ["fetch failed", "bad invariant"]) {
    const f = fixture([ok]);
    const provider = f.deps.provider;
    let attempts = 0;
    f.deps.provider = { ...provider, stream: (request, opts) => {
      attempts += 1;
      if (attempts === 1) return (async function* () { throw new TypeError(message); })();
      return provider.stream(request, opts);
    } };
    await f.run();
    expect(attempts).toBe(message === "fetch failed" ? 2 : 1);
  }
});

test("Retry-After is a bounded minimum, jitter never exceeds the exponential cap", async () => {
  const f = fixture([temporary("rate_limit", 20_000), temporary("rate_limit", 900_000), ok]);
  await f.run();
  expect(f.delays).toEqual([20_000, 300_000]);
  expect(recoveryDelayMs(99, undefined, () => 1)).toBe(60_000);
  expect(recoveryDelayMs(1, NaN, () => 0)).toBe(500);
  expect(recoveryDelayMs(1, -10, () => NaN)).toBe(750);
});

test("failed usage is forwarded and a host spend limit prevents another paid request", async () => {
  const f = fixture([[{ kind: "usage_update", usage: { inputTokens: 5, outputTokens: 3 } }, ...temporary()], ok]);
  f.recovery.canRequest = () => f.usage.length === 0;
  expect((await f.run()).finishReason).toBe("budget");
  expect(f.usage).toEqual([{ inputTokens: 5, outputTokens: 3 }]);
  expect(f.requests).toHaveLength(1);
  expect(f.delays).toEqual([]);
});

test("unknown failed usage is explicit", async () => {
  const f = fixture([temporary(), ok]);
  await f.run();
  expect(f.system.join("")).toContain("usage unknown");
});

for (const kind of ["authentication", "invalid_request", "unknown"] as const) {
  test(`generic 403/${kind} stops with access guidance even if retryable is erroneously true`, async () => {
    const f = fixture([[{ kind: "provider_error", error: { kind, retryable: true, message: "HTTP 403" } }], ok]);
    await f.run();
    expect(f.requests).toHaveLength(1);
    expect(f.delays).toEqual([]);
    expect(f.system.join("")).toContain("model entitlement");
  });
}

test("structured temporary 403 may recover", async () => {
  const f = fixture([[{ kind: "provider_error", error: { kind: "unavailable", retryable: true, message: "HTTP 403 temporary unavailable" } }], ok]);
  await f.run();
  expect(f.requests).toHaveLength(2);
});

test("abort during production wait cancels immediately without a late retry", async () => {
  const controller = new AbortController();
  const f = fixture([temporary(), ok]);
  f.recovery.wait = (ms, signal) => {
    const pending = waitForRecovery(ms, signal);
    controller.abort();
    return pending;
  };
  expect((await f.run({ signal: controller.signal })).finishReason).toBe("interrupted");
  expect(f.requests).toHaveLength(1);
  expect(f.system.join("")).toContain("[stopped]");
});

test("cancellation between backoff and retry prevents the next request even when wait resolves", async () => {
  const controller = new AbortController();
  const f = fixture([temporary(), ok]);
  f.recovery.wait = async () => { controller.abort(); };
  await f.run({ signal: controller.signal });
  expect(f.requests).toHaveLength(1);
});

test("TUI foreground stays occupied throughout recovery and queued work waits for settlement", async () => {
  const owner = createForegroundOperationOwner();
  const token = owner.begin();
  const f = fixture([temporary(), ok]);
  let release!: () => void;
  let waiting!: () => void;
  const entered = new Promise<void>((resolve) => { waiting = resolve; });
  f.recovery.wait = async () => { waiting(); await new Promise<void>((resolve) => { release = resolve; }); };
  const facade = createForegroundAgentIoFacade(owner, token, f.io);
  const turn = runAgentTurn(facade, f.deps, f.history, "hello", { recovery: f.recovery, signal: owner.signal });
  await entered;
  let queuedRan = false;
  const queued = runAfterForegroundSettlement(owner, () => { queuedRan = true; });
  expect(owner.isActive).toBe(true);
  expect(() => owner.begin()).toThrow("already active");
  expect(queuedRan).toBe(false);
  release();
  await turn;
  expect(queuedRan).toBe(false);
  owner.settle(token);
  await queued;
  expect(queuedRan).toBe(true);
});

test("noninteractive/print and unattended calls do not opt in to recovery", async () => {
  for (const unattended of [false, true]) {
    const f = fixture([temporary(), ok], { unattended });
    await f.run(unattended ? {} : { recovery: undefined });
    expect(f.requests).toHaveLength(1);
    expect(f.delays).toEqual([]);
  }
});


test("cancellation after partial reasoning/text keeps history and durable callbacks clean", async () => {
  const controller = new AbortController();
  const f = fixture([ok]);
  f.deps.provider = { ...f.deps.provider, stream: (_request, opts) => (async function* () {
    yield { kind: "reasoning_delta" as const, text: "unfinished", sequence: 0, attemptId: opts.attemptId };
    yield { kind: "text_delta" as const, text: "unfinished answer", sequence: 1, attemptId: opts.attemptId };
    controller.abort();
    throw new Error("aborted stream");
  })() };
  expect((await f.run({ signal: controller.signal })).finishReason).toBe("interrupted");
  expect(f.history).toHaveLength(1);
  expect(f.checkpoints.join("")).not.toContain("unfinished");
  expect(f.finalReasoning).toEqual([]);
  expect(f.discarded()).toBe(1);
});

test("context overflow's single retry remains bounded across transport recovery", async () => {
  const overflow: Script = [{ kind: "provider_error", error: { kind: "context_overflow", retryable: false, message: "too long" } }];
  const f = fixture([overflow, temporary(), overflow, ok]);
  for (let i = 0; i < 6; i += 1) {
    f.history.push({ role: "user", content: `old question ${i}`, provenance: "project" }, { role: "assistant", content: `old answer ${i}`, provenance: "model" });
  }
  await f.run();
  expect(f.requests).toHaveLength(3);
  expect(f.system.join("")).toContain("[error]");
  expect(f.delays).toHaveLength(1);
});

test("subagent turns cannot opt into the interactive recovery supervisor", async () => {
  const f = fixture([temporary(), ok], { subagentBudget: {} });
  await f.run();
  expect(f.requests).toHaveLength(1);
  expect(f.delays).toEqual([]);
});

test("failed and successful attempt usage both reach host accounting", async () => {
  const f = fixture([
    [{ kind: "usage_update", usage: { inputTokens: 10, outputTokens: 2 } }, ...temporary()],
    [{ kind: "usage_update", usage: { inputTokens: 12, outputTokens: 4 } }, ...ok],
  ]);
  await f.run();
  expect(f.usage.map((u) => u.inputTokens)).toEqual([10, 12]);
  expect(f.usage.reduce((total, u) => total + (u.outputTokens ?? 0), 0)).toBe(6);
});


test("real OpenAI adapter: HTTP 503 Retry-After date, truncated SSE, then success in one turn", async () => {
  const { OpenAiProvider } = await import("../harness/provider/openai/openai-provider");
  let fetches = 0;
  const stream = (complete: boolean) => [
    'data: {"type":"response.created","response":{"id":"r1"}}\n\n',
    'data: {"type":"response.output_text.delta","delta":"Recovered native."}\n\n',
    ...(complete ? ['data: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":2}}}\n\n'] : []),
  ].join("");
  const f = fixture([]);
  f.deps.providerId = "openai";
  f.deps.provider = new OpenAiProvider({
    grant: { network: true, apiKey: "fixture-key" }, clock: () => Date.parse("2026-10-08T10:00:00Z"),
    fetch: Object.assign(async () => {
      fetches += 1;
      if (fetches === 1) return new Response('{"error":{"message":"temporary outage"}}', {
        status: 503, headers: { "retry-after": "Thu, 08 Oct 2026 10:00:12 GMT" },
      });
      return new Response(stream(fetches === 3), { headers: { "content-type": "text/event-stream" } });
    }, { preconnect: () => {} }),
  });
  await f.run();
  expect(fetches).toBe(3);
  expect(f.delays).toEqual([12_000, 1500]);
  expect(f.history).toHaveLength(2);
  expect(f.history.at(-1)?.content).toBe("Recovered native.");
  expect(f.checkpoints.filter((s) => s.includes("Recovered native."))).toHaveLength(1);
});


test("real native OpenAI body reset recovers partial text and tool arguments in the same turn", async () => {
  const { OpenAiProvider } = await import("../harness/provider/openai/openai-provider");
  let fetches = 0;
  let invoked = 0;
  const wireRequests: string[] = [];
  const tool: InteractiveTool = { definition: { name: "change", description: "change", inputSchema: { type: "object" }, risk: "read" }, invoke: async () => { invoked += 1; return { output: "done", isError: false }; } };
  const f = fixture([], { tools: [tool], maxRounds: 1 });
  f.deps.providerId = "openai";
  f.deps.provider = new OpenAiProvider({
    grant: { network: true, apiKey: "fixture-key" },
    fetch: Object.assign(async (_url: unknown, init?: RequestInit) => {
      wireRequests.push(String(init?.body));
      fetches += 1;
      const first = fetches === 1;
      let pulled = false;
      const body = new ReadableStream<Uint8Array>({ pull(controller) {
        if (pulled) {
          if (first) controller.error(new TypeError("fetch failed", { cause: { code: "ECONNRESET" } }));
          else controller.close();
          return;
        }
        pulled = true;
        const records = first ? [
          { type: "response.created", response: { id: "r1" } },
          { type: "response.output_text.delta", delta: "provisional reset output" },
          { type: "response.output_item.added", item: { type: "function_call", id: "fc1", call_id: "c1", name: "change" } },
          { type: "response.function_call_arguments.done", item_id: "fc1", arguments: "{}" },
        ] : [
          { type: "response.created", response: { id: "r2" } },
          { type: "response.output_text.delta", delta: "Recovered body reset." },
          { type: "response.completed", response: { usage: { input_tokens: 3, output_tokens: 2 } } },
        ];
        controller.enqueue(new TextEncoder().encode(records.map(record => `data: ${JSON.stringify(record)}\n\n`).join("")));
      } });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    }, { preconnect: () => {} }),
  });
  const native = f.deps.provider;
  let provisionalToolEnds = 0;
  f.deps.provider = { describe: () => native.describe(), stream: (request, opts) => (async function* () {
    for await (const event of native.stream(request, opts)) {
      if (fetches === 1 && event.kind === "tool_call_end") provisionalToolEnds += 1;
      yield event;
    }
  })() };
  expect(await f.run()).toEqual({});
  expect(provisionalToolEnds).toBe(1);
  expect(fetches).toBe(2);
  expect(f.delays).toEqual([750]);
  expect(f.text).toContain("provisional reset output");
  expect(invoked).toBe(0);
  expect(f.checkpoints.join("")).not.toContain("provisional");
  expect(wireRequests[1]).not.toContain("provisional");
  expect(f.history.map(m => m.role)).toEqual(["user", "assistant"]);
  expect(f.history.at(-1)?.content).toBe("Recovered body reset.");
});

for (const stage of ["backoff", "delayed stream"] as const) {
  test(`session switch during ${stage} revokes old IO and finalization but retains busy ownership`, async () => {
    const owner = createForegroundOperationOwner();
    const token = owner.begin();
    const signal = owner.signal;
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const f = fixture([temporary(), ok]);
    const oldHistory = f.history;
    let liveHistory = oldHistory;
    const painted: string[] = [];
    const persisted: string[] = [];
    const completions: string[] = [];
    let drained = 0;
    const io = createForegroundAgentIoFacade(owner, token, {
      write: s => painted.push(s), onSystem: s => painted.push(s),
      onAssistantText: s => painted.push(s),
      onHistoryChange: () => persisted.push(JSON.stringify(liveHistory)),
    });
    if (stage === "backoff") f.recovery.wait = async () => { entered(); await waiting; };
    else f.deps.provider = { ...f.deps.provider, stream: () => (async function* () {
      yield { kind: "text_delta" as const, text: "old partial", sequence: 0, attemptId: "old" };
      entered(); await waiting;
      yield { kind: "text_delta" as const, text: "old late", sequence: 1, attemptId: "old" };
      yield { kind: "model_end" as const, sequence: 2, attemptId: "old" };
    })() };
    const pending = runAgentTurn(io, f.deps, oldHistory, "old prompt", { signal, recovery: f.recovery }).finally(() => {
      if (settleForegroundOperation(owner, token)) {
        completions.push("old completed");
        persisted.push(JSON.stringify(liveHistory));
        drained += 1;
      }
    });
    await ready;
    owner.invalidateSession();
    liveHistory = [{ role: "user", content: "new session" }];
    painted.length = 0; persisted.length = 0;
    expect(owner.isActive).toBe(true);
    expect(owner.accepts(token)).toBe(false);
    expect(() => owner.begin()).toThrow("already active");
    release(); await pending;
    expect(owner.isActive).toBe(false);
    expect(painted).toEqual([]);
    expect(completions).toEqual([]);
    expect(persisted).toEqual([]);
    expect(drained).toBe(0);
    expect(liveHistory).toEqual([{ role: "user", content: "new session" }]);
  });
}
