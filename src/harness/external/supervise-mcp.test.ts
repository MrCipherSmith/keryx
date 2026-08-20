// Tests for the MCP-shaped codex supervisor (flow 182, T7/T8; AC3, AC6, AC8).
//
// OFFLINE, exactly like `supervise.test.ts`: every run below goes through a
// FAKE `McpClientPort` — nothing here spawns `codex` or touches
// `@modelcontextprotocol/sdk`, which is why the port is injected rather than
// imported. The real SDK-backed port (`../../mcp-client/client.ts`) has its
// own flag-gated live smoke test.
import { describe, expect, test } from "bun:test";
import { superviseCodexMcpRun, DEFAULT_MCP_TOOL_CALL_TIMEOUT_MS, DEFAULT_ELICITATION_TIMEOUT_MS } from "./supervise-mcp";
import type { ElicitationHandledRecord, SuperviseCodexMcpInput } from "./supervise-mcp";
import type {
  ElicitationResponsePayload,
  McpClientConnection,
  McpClientPort,
  McpSpawnOptions,
  McpToolCallOutcome,
  RawCodexEventNotification,
  RawElicitationRequest,
} from "../../mcp-client/types";

// ---------------------------------------------------------------------------
// The fake port
// ---------------------------------------------------------------------------

interface FakeHarness {
  readonly port: McpClientPort;
  readonly connectCalls: Array<{ argv: readonly string[]; options: McpSpawnOptions }>;
  readonly callToolCalls: Array<{ name: string; args: Record<string, unknown>; timeoutMs: number | undefined }>;
  closed: boolean;
  /** Simulate codex sending its sibling `codex/event` notification. */
  sendCodexEvent(event: RawCodexEventNotification): void;
  /** Simulate codex sending `elicitation/create`; resolves to the response the supervisor sent back. */
  sendElicitation(request: RawElicitationRequest): Promise<ElicitationResponsePayload>;
}

function fakePort(toolCallOutcome: McpToolCallOutcome): FakeHarness {
  const connectCalls: Array<{ argv: readonly string[]; options: McpSpawnOptions }> = [];
  const callToolCalls: Array<{ name: string; args: Record<string, unknown>; timeoutMs: number | undefined }> = [];
  let codexEventHandler: ((event: RawCodexEventNotification) => void) | undefined;
  let elicitationHandler: ((request: RawElicitationRequest) => Promise<ElicitationResponsePayload>) | undefined;
  const harness: FakeHarness = {
    connectCalls,
    callToolCalls,
    closed: false,
    port: {
      async connect(argv, options): Promise<McpClientConnection> {
        connectCalls.push({ argv, options });
        return {
          async callTool(name, args, opts) {
            callToolCalls.push({ name, args, timeoutMs: opts?.timeoutMs });
            return toolCallOutcome;
          },
          onElicitation(handler): void {
            elicitationHandler = handler;
          },
          onCodexEvent(handler): void {
            codexEventHandler = handler;
          },
          async close(): Promise<void> {
            harness.closed = true;
          },
        };
      },
    },
    sendCodexEvent(event) {
      codexEventHandler?.(event);
    },
    async sendElicitation(request) {
      if (elicitationHandler === undefined) throw new Error("no elicitation handler registered");
      return elicitationHandler(request);
    },
  };
  return harness;
}

function baseInput(overrides: Partial<SuperviseCodexMcpInput> = {}): SuperviseCodexMcpInput {
  return {
    cwd: "/tmp/worktree",
    env: {},
    argv: ["codex", "mcp-server"],
    toolName: "codex",
    toolArguments: { prompt: "do the thing" },
    mode: "ask",
    ...overrides,
  };
}

const execApprovalEvent = (callId: string, availableDecisions: readonly string[]): RawCodexEventNotification => ({
  msgType: "exec_approval_request",
  callId,
  availableDecisions,
  raw: {},
});

const elicitationRequest = (requestId: string | number, callId: string): RawElicitationRequest => ({
  requestId,
  message: "allow codex to run this command?",
  requestedSchema: { type: "object", properties: {} },
  vendor: { codex_call_id: callId, codex_elicitation: "exec-approval" },
});

// ---------------------------------------------------------------------------

describe("superviseCodexMcpRun — connection and tool-call outcomes", () => {
  test("connects with the given argv/cwd/env and emits child_started then child_finished on a result", async () => {
    const harness = fakePort({ kind: "result", result: { content: "done", isError: false } });
    const events: string[] = [];
    const outcome = await superviseCodexMcpRun(baseInput({ cwd: "/tmp/wt", env: { FOO: "bar" } }), {
      client: harness.port,
      requestApproval: undefined,
      onEvent: (e) => events.push(e.kind),
    });

    expect(harness.connectCalls).toEqual([{ argv: ["codex", "mcp-server"], options: { cwd: "/tmp/wt", env: { FOO: "bar" } } }]);
    expect(events).toEqual(["child_started", "child_finished"]);
    expect(outcome.events.map((e) => e.kind)).toEqual(["child_started", "child_finished"]);
    expect(outcome.toolCall).toEqual({ kind: "result", result: { content: "done", isError: false } });
    expect(harness.closed).toBe(true);
  });

  test("a timeout tool-call outcome emits child_failed naming the timeout, not a hang", async () => {
    const harness = fakePort({ kind: "timeout" });
    const outcome = await superviseCodexMcpRun(baseInput(), { client: harness.port, requestApproval: undefined });
    expect(outcome.events.map((e) => e.kind)).toEqual(["child_started", "child_failed"]);
    const failed = outcome.events[1];
    expect(failed?.kind === "child_failed" && failed.message).toMatch(/timed out/i);
  });

  test("an error tool-call outcome emits child_failed carrying the error message", async () => {
    const harness = fakePort({ kind: "error", message: "boom" });
    const outcome = await superviseCodexMcpRun(baseInput(), { client: harness.port, requestApproval: undefined });
    const failed = outcome.events[1];
    expect(failed?.kind === "child_failed" && failed.message).toBe("boom");
  });

  test("passes an explicit timeout to callTool — the default when unset, an override when set", async () => {
    const harness = fakePort({ kind: "result", result: { content: "ok", isError: false } });
    await superviseCodexMcpRun(baseInput(), { client: harness.port, requestApproval: undefined });
    expect(harness.callToolCalls[0]?.timeoutMs).toBe(DEFAULT_MCP_TOOL_CALL_TIMEOUT_MS);

    const harness2 = fakePort({ kind: "result", result: { content: "ok", isError: false } });
    await superviseCodexMcpRun(baseInput({ toolCallTimeoutMs: 5_000 }), {
      client: harness2.port,
      requestApproval: undefined,
    });
    expect(harness2.callToolCalls[0]?.timeoutMs).toBe(5_000);
  });
});

describe("superviseCodexMcpRun — elicitation handling (AC3, AC6)", () => {
  test("AC8: an answered elicitation produces NO ExternalEvent — only child_started/child_finished appear", async () => {
    const harness = fakePort({ kind: "result", result: { content: "ok", isError: false } });
    const connected = superviseCodexMcpRun(baseInput({ mode: "auto" }), {
      client: harness.port,
      requestApproval: undefined,
    });
    // Give the supervisor a tick to register its handlers before we fire the events.
    await Promise.resolve();
    harness.sendCodexEvent(execApprovalEvent("call-1", ["approved", "abort"]));
    await harness.sendElicitation(elicitationRequest(1, "call-1"));
    const outcome = await connected;
    expect(outcome.events.map((e) => e.kind)).toEqual(["child_started", "child_finished"]);
    expect(outcome.elicitations).toHaveLength(1);
  });

  test("mode auto: approves a correlated elicitation without calling requestApproval", async () => {
    const harness = fakePort({ kind: "result", result: { content: "ok", isError: false } });
    let requestApprovalCalls = 0;
    const run = superviseCodexMcpRun(baseInput({ mode: "auto" }), {
      client: harness.port,
      requestApproval: async () => {
        requestApprovalCalls += 1;
        return true;
      },
    });
    await Promise.resolve();
    harness.sendCodexEvent(execApprovalEvent("call-1", ["approved", "abort"]));
    const response = await harness.sendElicitation(elicitationRequest(1, "call-1"));
    await run;

    expect(requestApprovalCalls).toBe(0);
    expect(response).toEqual({ action: "accept", decision: "approved" });
  });

  test('mode ask, no approver wired: headless-safe default-deny, sends {action:"decline", decision:"abort"}', async () => {
    const harness = fakePort({ kind: "result", result: { content: "ok", isError: false } });
    const run = superviseCodexMcpRun(baseInput({ mode: "ask" }), {
      client: harness.port,
      requestApproval: undefined,
    });
    await Promise.resolve();
    harness.sendCodexEvent(execApprovalEvent("call-1", ["approved", "abort"]));
    const response = await harness.sendElicitation(elicitationRequest(1, "call-1"));
    await run;

    expect(response).toEqual({ action: "decline", decision: "abort" });
  });

  test("mode ask, approver resolves true: approves and passes fingerprint/destructive/credentials meta", async () => {
    const harness = fakePort({ kind: "result", result: { content: "ok", isError: false } });
    const calls: Array<{ tool: string; input: string; meta: unknown }> = [];
    const run = superviseCodexMcpRun(baseInput({ mode: "ask" }), {
      client: harness.port,
      requestApproval: async (tool, input, meta) => {
        calls.push({ tool, input, meta });
        return true;
      },
    });
    await Promise.resolve();
    harness.sendCodexEvent(execApprovalEvent("call-1", ["approved", "abort"]));
    const response = await harness.sendElicitation(elicitationRequest(1, "call-1"));
    await run;

    expect(response).toEqual({ action: "accept", decision: "approved" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.tool).toBe("mcp_elicitation:1");
    expect(calls[0]?.meta).toMatchObject({ fingerprint: "1", destructive: false });
  });

  test("mode ask, approver resolves false: denies", async () => {
    const harness = fakePort({ kind: "result", result: { content: "ok", isError: false } });
    const run = superviseCodexMcpRun(baseInput({ mode: "ask" }), {
      client: harness.port,
      requestApproval: async () => false,
    });
    await Promise.resolve();
    harness.sendCodexEvent(execApprovalEvent("call-1", ["approved", "abort"]));
    const response = await harness.sendElicitation(elicitationRequest(1, "call-1"));
    await run;

    expect(response).toEqual({ action: "decline", decision: "abort" });
  });

  test("AC5: an uncorrelated elicitation (no sibling codex/event) declines WITHOUT a decision, even under auto mode", async () => {
    const harness = fakePort({ kind: "result", result: { content: "ok", isError: false } });
    const run = superviseCodexMcpRun(baseInput({ mode: "auto" }), {
      client: harness.port,
      requestApproval: undefined,
    });
    await Promise.resolve();
    // No sendCodexEvent call at all — this elicitation is never correlated.
    const response = await harness.sendElicitation(elicitationRequest(1, "call-missing"));
    await run;

    expect(response).toEqual({ action: "decline" });
  });

  test("AC6: resolveApprovalDecision is consulted for every elicitation — trust mode auto-approves a non-destructive one", async () => {
    const harness = fakePort({ kind: "result", result: { content: "ok", isError: false } });
    let requestApprovalCalls = 0;
    const run = superviseCodexMcpRun(baseInput({ mode: "trust" }), {
      client: harness.port,
      requestApproval: async () => {
        requestApprovalCalls += 1;
        return true;
      },
    });
    await Promise.resolve();
    harness.sendCodexEvent(execApprovalEvent("call-1", ["approved", "abort"]));
    const response = await harness.sendElicitation(elicitationRequest(1, "call-1"));
    await run;

    // trust mode auto-approves anything not classified destructive — the T9
    // placeholder classifier always reports destructive:false, so trust mode
    // must skip the prompt exactly like it does for a non-destructive shell call.
    expect(requestApprovalCalls).toBe(0);
    expect(response).toEqual({ action: "accept", decision: "approved" });
  });

  test("records a diagnostic ElicitationHandledRecord per elicitation, never surfaced as an ExternalEvent", async () => {
    const harness = fakePort({ kind: "result", result: { content: "ok", isError: false } });
    const handled: ElicitationHandledRecord[] = [];
    const run = superviseCodexMcpRun(baseInput({ mode: "auto" }), {
      client: harness.port,
      requestApproval: undefined,
      onElicitationHandled: (record) => handled.push(record),
    });
    await Promise.resolve();
    harness.sendCodexEvent(execApprovalEvent("call-1", ["approved", "abort"]));
    await harness.sendElicitation(elicitationRequest("req-1", "call-1"));
    const outcome = await run;

    expect(handled).toHaveLength(1);
    expect(outcome.elicitations).toEqual(handled);
    expect(outcome.elicitations[0]).toMatchObject({
      requestId: "req-1",
      callId: "call-1",
      correlation: "correlated",
      gateDecision: "auto",
      verdict: "approve",
      timedOut: false,
    });
  });
});

describe("superviseCodexMcpRun — elicitation-answer timeout (T10, AC4)", () => {
  test("a requestApproval that never resolves still lets the run complete, recorded as a timeout-driven decline, not silently as an ordinary deny", async () => {
    const harness = fakePort({ kind: "result", result: { content: "ok", isError: false } });
    const handled: ElicitationHandledRecord[] = [];
    const run = superviseCodexMcpRun(baseInput({ mode: "ask", elicitationTimeoutMs: 20 }), {
      client: harness.port,
      // Never resolves — simulates an operator who has walked away
      // (openai/codex#11816's condition).
      requestApproval: () => new Promise<boolean>(() => {}),
      onElicitationHandled: (record) => handled.push(record),
    });
    await Promise.resolve();
    harness.sendCodexEvent(execApprovalEvent("call-1", ["approved", "abort"]));
    const response = await harness.sendElicitation(elicitationRequest(1, "call-1"));
    const outcome = await run;

    // Still a clean deny to codex — never a hang, never an implicit accept.
    expect(response).toEqual({ action: "decline", decision: "abort" });
    expect(outcome.elicitations).toHaveLength(1);
    expect(outcome.elicitations[0]).toMatchObject({
      verdict: "deny",
      gateDecision: "ask",
      timedOut: true,
    });
    expect(handled).toHaveLength(1);
    expect(handled[0]?.timedOut).toBe(true);
  });

  test("uses DEFAULT_ELICITATION_TIMEOUT_MS when elicitationTimeoutMs is not set (exercised with an approver that resolves well within the default, so this only asserts the field exists and is sane)", () => {
    expect(DEFAULT_ELICITATION_TIMEOUT_MS).toBeGreaterThan(0);
    expect(DEFAULT_ELICITATION_TIMEOUT_MS).toBeLessThan(DEFAULT_MCP_TOOL_CALL_TIMEOUT_MS);
  });

  test("an operator genuinely answering (not a timeout) is recorded with timedOut: false", async () => {
    const harness = fakePort({ kind: "result", result: { content: "ok", isError: false } });
    const run = superviseCodexMcpRun(baseInput({ mode: "ask", elicitationTimeoutMs: 5_000 }), {
      client: harness.port,
      requestApproval: async () => false,
    });
    await Promise.resolve();
    harness.sendCodexEvent(execApprovalEvent("call-1", ["approved", "abort"]));
    await harness.sendElicitation(elicitationRequest(1, "call-1"));
    const outcome = await run;

    expect(outcome.elicitations[0]).toMatchObject({ verdict: "deny", timedOut: false });
  });

  test("no approver wired at all denies immediately, recorded with timedOut: false (no timer ever starts)", async () => {
    const harness = fakePort({ kind: "result", result: { content: "ok", isError: false } });
    const run = superviseCodexMcpRun(baseInput({ mode: "ask" }), {
      client: harness.port,
      requestApproval: undefined,
    });
    await Promise.resolve();
    harness.sendCodexEvent(execApprovalEvent("call-1", ["approved", "abort"]));
    await harness.sendElicitation(elicitationRequest(1, "call-1"));
    const outcome = await run;

    expect(outcome.elicitations[0]).toMatchObject({ verdict: "deny", timedOut: false });
  });
});
