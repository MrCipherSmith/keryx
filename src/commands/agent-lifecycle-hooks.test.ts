// Flow 306 (W6 T9): `keryx shell`'s own agent loop (`agent.ts`'s `executeCall`/
// `runAgentTurn`) wired to the standalone lifecycle hook runtime
// (`src/harness/hooks/`, T5). Every test here uses a FAKE `HookRuntime` — no
// real subprocess, no real config file — exactly like `agent-permission-
// mode.test.ts` fakes `AgentIO.requestApproval`/`ProviderPort` for the same
// reason: this module tests the WIRING, not the T5 runtime's own internals
// (already covered by `src/harness/hooks/*.test.ts`).
import { expect, test } from "bun:test";
import { runAgentTurn } from "./agent";
import type { AgentDeps, AgentIO } from "./agent";
import { HOOK_TOOL_NAME_ALIASES } from "./agent-hooks";
import type { ShellHookContext } from "./agent-hooks";
import type { HookFireResult, HookRuntime } from "../harness/hooks/runtime";
import type { HookEventName } from "../harness/hooks/types";
import type { InteractiveTool } from "../harness/tool/builtin/interactive-tools";
import type { ToolRisk } from "../harness/tool/types";
import type { NormalizedEvent, ProviderDescription, ProviderPort } from "../harness/provider/types";

const DESCRIPTION: ProviderDescription = {
  capabilities: {
    streaming: true,
    toolCalls: true,
    parallelToolCalls: false,
    structuredOutput: false,
    reasoningMetadata: false,
    promptCaching: false,
    vision: false,
    tokenCounting: false,
    modelListing: false,
  },
  descriptor: { providerId: "scripted" },
};

function scriptedProvider(rounds: Partial<NormalizedEvent>[][]): ProviderPort {
  let call = 0;
  return {
    describe: () => DESCRIPTION,
    stream: (_request, opts) => {
      const events = rounds[call] ?? [{ kind: "text_delta", text: "done" }, { kind: "model_end" }];
      call += 1;
      return (async function* (): AsyncGenerator<NormalizedEvent> {
        let sequence = 0;
        for (const partial of events) {
          yield { sequence: sequence++, attemptId: opts.attemptId, kind: "model_end", ...partial } as NormalizedEvent;
        }
      })();
    },
  };
}

function callScript(tool: string, input: string): Partial<NormalizedEvent>[][] {
  return [
    [
      { kind: "tool_call_start", toolCallId: "c1", toolName: tool },
      { kind: "tool_call_end", toolCallId: "c1", input },
      { kind: "model_end" },
    ],
    [{ kind: "text_delta", text: "done" }, { kind: "model_end" }],
  ];
}

function fakeTool(name: string, risk: ToolRisk): { tool: InteractiveTool; ran: () => boolean } {
  let invoked = false;
  return {
    ran: () => invoked,
    tool: {
      definition: {
        name,
        description: "test tool",
        inputSchema: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
          additionalProperties: false,
        },
        risk,
      },
      invoke: async () => {
        invoked = true;
        return { output: "ran", isError: false };
      },
    },
  };
}

let seq = 0;
const idSeq = (): string => `id-${seq++}`;

type FireHandler = (event: HookEventName, payload: Record<string, unknown>, ctx?: { toolName?: string }) => HookFireResult;

const EMPTY_RESULT: HookFireResult = {
  decisions: [],
  additionalContext: [],
  records: [],
  warnings: [],
  anomalies: [],
};

/** A fake `HookRuntime` whose `fire()` is fully scripted by the test. */
function fakeHooks(interactive: boolean, handler?: FireHandler): { hooks: ShellHookContext; calls: Array<{ event: HookEventName; payload: Record<string, unknown> }> } {
  const calls: Array<{ event: HookEventName; payload: Record<string, unknown> }> = [];
  const runtime: HookRuntime = {
    interactive,
    registrations: () => [],
    inheritedHookIds: () => [],
    async fire(event, payload, ctx) {
      calls.push({ event, payload });
      return handler?.(event, payload, ctx) ?? EMPTY_RESULT;
    },
  };
  return { hooks: { runtime, sessionId: "s1", runId: "r1" }, calls };
}

// --- PreToolUse: deny --------------------------------------------------

test("PreToolUse deny refuses the call without invoking the tool or the approver", async () => {
  const { tool, ran } = fakeTool("shell_exec", "shell");
  let approvalCalls = 0;
  const { hooks } = fakeHooks(true, (event) =>
    event === "PreToolUse"
      ? { ...EMPTY_RESULT, decisions: [{ hookId: "keryx.deny-all", decision: "deny" }], records: [{ hookId: "keryx.deny-all", event, class: "gate", scope: "builtin", outcome: "deny", reason: "test denial", durationMs: 1, changedOutcome: true }] }
      : EMPTY_RESULT,
  );
  const io: AgentIO = {
    write: () => {},
    requestApproval: async () => {
      approvalCalls += 1;
      return true;
    },
    permissionMode: () => "auto",
  };
  const result = await runAgentTurn(
    io,
    {
      provider: scriptedProvider(callScript("shell_exec", '{"command":"echo hi"}')),
      providerId: "s",
      modelId: "m",
      tools: [tool],
      systemInstruction: "sys",
      idSeq,
      hooks,
    },
    [],
    "go",
  );
  expect(result).toBeDefined();
  expect(ran()).toBe(false);
  expect(approvalCalls).toBe(0);
});

test("PreToolUse deny on a read-risk tool refuses it too (read never otherwise gates)", async () => {
  const { tool, ran } = fakeTool("workspace_context", "read");
  const { hooks } = fakeHooks(true, (event) =>
    event === "PreToolUse" ? { ...EMPTY_RESULT, decisions: [{ hookId: "keryx.deny-all", decision: "deny" }] } : EMPTY_RESULT,
  );
  const io: AgentIO = { write: () => {} };
  await runAgentTurn(
    io,
    {
      provider: scriptedProvider(callScript("workspace_context", '{"command":"x"}')),
      providerId: "s",
      modelId: "m",
      tools: [tool],
      systemInstruction: "sys",
      idSeq,
      hooks,
    },
    [],
    "go",
  );
  expect(ran()).toBe(false);
});

// --- PreToolUse: ask tightening -----------------------------------------

test("PreToolUse ask forces requestApproval even under auto mode, with hookAsk set", async () => {
  const { tool, ran } = fakeTool("shell_exec", "shell");
  const seen: { hookAsk?: boolean }[] = [];
  const { hooks } = fakeHooks(true, (event) =>
    event === "PreToolUse" ? { ...EMPTY_RESULT, decisions: [{ hookId: "keryx.ask-all", decision: "ask" }] } : EMPTY_RESULT,
  );
  const io: AgentIO = {
    write: () => {},
    requestApproval: async (_t, _i, meta) => {
      seen.push(meta?.hookAsk === true ? { hookAsk: true } : {});
      return true;
    },
    permissionMode: () => "auto",
  };
  await runAgentTurn(
    io,
    {
      provider: scriptedProvider(callScript("shell_exec", '{"command":"git status"}')),
      providerId: "s",
      modelId: "m",
      tools: [tool],
      systemInstruction: "sys",
      idSeq,
      hooks,
    },
    [],
    "go",
  );
  expect(seen).toEqual([{ hookAsk: true }]);
  expect(ran()).toBe(true);
});

test("PreToolUse ask with no approver present is refused (default-deny)", async () => {
  const { tool, ran } = fakeTool("shell_exec", "shell");
  const { hooks } = fakeHooks(true, (event) =>
    event === "PreToolUse" ? { ...EMPTY_RESULT, decisions: [{ hookId: "keryx.ask-all", decision: "ask" }] } : EMPTY_RESULT,
  );
  const io: AgentIO = { write: () => {}, permissionMode: () => "auto" };
  await runAgentTurn(
    io,
    {
      provider: scriptedProvider(callScript("shell_exec", '{"command":"git status"}')),
      providerId: "s",
      modelId: "m",
      tools: [tool],
      systemInstruction: "sys",
      idSeq,
      hooks,
    },
    [],
    "go",
  );
  expect(ran()).toBe(false);
});

test("PreToolUse ask under an unattended (non-interactive) runtime fails closed to deny (AC9)", async () => {
  const { tool, ran } = fakeTool("shell_exec", "shell");
  let approvalCalls = 0;
  // interactive: false — mirrors `HookRuntime.interactive = deps.unattended !== true`.
  const { hooks } = fakeHooks(false, (event) =>
    event === "PreToolUse" ? { ...EMPTY_RESULT, decisions: [{ hookId: "keryx.ask-all", decision: "ask" }] } : EMPTY_RESULT,
  );
  const io: AgentIO = {
    write: () => {},
    requestApproval: async () => {
      approvalCalls += 1;
      return true;
    },
    permissionMode: () => "auto",
  };
  await runAgentTurn(
    io,
    {
      provider: scriptedProvider(callScript("shell_exec", '{"command":"git status"}')),
      providerId: "s",
      modelId: "m",
      tools: [tool],
      systemInstruction: "sys",
      idSeq,
      unattended: true,
      hooks,
    },
    [],
    "go",
  );
  // Denied before ever reaching the approver (mirrors `decide()`'s own
  // headless fail-closed posture — `tightenOutcome`'s `interactive: false` branch).
  expect(approvalCalls).toBe(0);
  expect(ran()).toBe(false);
});

test("PreToolUse ask on a read-risk tool forces an approval (read never otherwise gates)", async () => {
  const { tool, ran } = fakeTool("workspace_context", "read");
  let approvalCalls = 0;
  const { hooks } = fakeHooks(true, (event) =>
    event === "PreToolUse" ? { ...EMPTY_RESULT, decisions: [{ hookId: "keryx.ask-all", decision: "ask" }] } : EMPTY_RESULT,
  );
  const io: AgentIO = {
    write: () => {},
    requestApproval: async () => {
      approvalCalls += 1;
      return true;
    },
  };
  await runAgentTurn(
    io,
    {
      provider: scriptedProvider(callScript("workspace_context", '{"command":"x"}')),
      providerId: "s",
      modelId: "m",
      tools: [tool],
      systemInstruction: "sys",
      idSeq,
      hooks,
    },
    [],
    "go",
  );
  expect(approvalCalls).toBe(1);
  expect(ran()).toBe(true);
});

// --- PreToolUse: allow never skips a REQUIRED approval or lifts read-only ---

test("PreToolUse allow does not skip a required approval under ask mode", async () => {
  const { tool, ran } = fakeTool("shell_exec", "shell");
  let approvalCalls = 0;
  const { hooks } = fakeHooks(true, () => EMPTY_RESULT); // every hook allows (no decision)
  const io: AgentIO = {
    write: () => {},
    requestApproval: async () => {
      approvalCalls += 1;
      return true;
    },
    // permissionMode absent -> DEFAULT_PERMISSION_MODE ("ask").
  };
  await runAgentTurn(
    io,
    {
      provider: scriptedProvider(callScript("shell_exec", '{"command":"git status"}')),
      providerId: "s",
      modelId: "m",
      tools: [tool],
      systemInstruction: "sys",
      idSeq,
      hooks,
    },
    [],
    "go",
  );
  expect(approvalCalls).toBe(1);
  expect(ran()).toBe(true);
});

test("PreToolUse allow does not lift a /plan read-only deny", async () => {
  const { tool, ran } = fakeTool("apply_patch", "write");
  const { hooks } = fakeHooks(true, () => EMPTY_RESULT);
  const io: AgentIO = { write: () => {}, readOnly: () => true };
  await runAgentTurn(
    io,
    {
      provider: scriptedProvider(callScript("apply_patch", '{"patch":"diff"}')),
      providerId: "s",
      modelId: "m",
      tools: [tool],
      systemInstruction: "sys",
      idSeq,
      hooks,
    },
    [],
    "go",
  );
  expect(ran()).toBe(false);
});

// --- Post*: observe-only, never alters the result -----------------------

test("PostToolUse fires with the right event and does not alter a successful result", async () => {
  const { tool } = fakeTool("shell_exec", "shell");
  const events: HookEventName[] = [];
  const { hooks } = fakeHooks(true, (event) => {
    events.push(event);
    return EMPTY_RESULT;
  });
  const io: AgentIO = { write: () => {}, permissionMode: () => "auto" };
  await runAgentTurn(
    io,
    {
      provider: scriptedProvider(callScript("shell_exec", '{"command":"echo hi"}')),
      providerId: "s",
      modelId: "m",
      tools: [tool],
      systemInstruction: "sys",
      idSeq,
      hooks,
    },
    [],
    "go",
  );
  expect(events).toContain("PreToolUse");
  expect(events).toContain("PostToolUse");
  expect(events).not.toContain("PostToolUseFailure");
});

test("PostToolUseFailure fires (not PostToolUse) when the tool errors, and never alters the error result", async () => {
  const failingTool: InteractiveTool = {
    definition: {
      name: "shell_exec",
      description: "test",
      inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"], additionalProperties: false },
      risk: "shell",
    },
    invoke: async () => ({ output: "boom", isError: true }),
  };
  const events: HookEventName[] = [];
  const { hooks } = fakeHooks(true, (event) => {
    events.push(event);
    return EMPTY_RESULT;
  });
  const io: AgentIO = { write: () => {}, permissionMode: () => "auto" };
  await runAgentTurn(
    io,
    {
      provider: scriptedProvider(callScript("shell_exec", '{"command":"echo hi"}')),
      providerId: "s",
      modelId: "m",
      tools: [failingTool],
      systemInstruction: "sys",
      idSeq,
      hooks,
    },
    [],
    "go",
  );
  expect(events).toContain("PostToolUseFailure");
  expect(events).not.toContain("PostToolUse");
});

// --- additionalContext ---------------------------------------------------

test("PreToolUse additionalContext is appended to the tool result output", async () => {
  const { tool } = fakeTool("shell_exec", "shell");
  const { hooks } = fakeHooks(true, (event) =>
    event === "PreToolUse" ? { ...EMPTY_RESULT, additionalContext: ["extra evidence"] } : EMPTY_RESULT,
  );
  let seenOutput = "";
  const io: AgentIO = {
    write: () => {},
    permissionMode: () => "auto",
    onToolResult: (_name, result) => {
      seenOutput = result.output;
    },
  };
  await runAgentTurn(
    io,
    {
      provider: scriptedProvider(callScript("shell_exec", '{"command":"echo hi"}')),
      providerId: "s",
      modelId: "m",
      tools: [tool],
      systemInstruction: "sys",
      idSeq,
      hooks,
    },
    [],
    "go",
  );
  expect(seenOutput).toContain("[hook context]");
  expect(seenOutput).toContain("extra evidence");
});

// --- UserPromptSubmit ------------------------------------------------------

test("UserPromptSubmit deny stops the turn before the provider is called", async () => {
  let providerCalled = false;
  const provider: ProviderPort = {
    describe: () => DESCRIPTION,
    stream: () => {
      providerCalled = true;
      return (async function* (): AsyncGenerator<NormalizedEvent> {
        yield { sequence: 0, attemptId: "a", kind: "text_delta", text: "should not run" } as NormalizedEvent;
        yield { sequence: 1, attemptId: "a", kind: "model_end" } as NormalizedEvent;
      })();
    },
  };
  const { hooks } = fakeHooks(true, (event) =>
    event === "UserPromptSubmit" ? { ...EMPTY_RESULT, tightened: "deny", denyReason: "test" } : EMPTY_RESULT,
  );
  const systemMessages: string[] = [];
  const io: AgentIO = { write: () => {}, onSystem: (t) => systemMessages.push(t) };
  await runAgentTurn(
    io,
    { provider, providerId: "s", modelId: "m", tools: [], systemInstruction: "sys", idSeq, hooks },
    [],
    "go",
  );
  expect(providerCalled).toBe(false);
  expect(systemMessages.some((m) => m.includes("blocked"))).toBe(true);
});

test("UserPromptSubmit is skipped for a synthesized task-notification continuation", async () => {
  const events: HookEventName[] = [];
  const { hooks } = fakeHooks(true, (event) => {
    events.push(event);
    return EMPTY_RESULT;
  });
  const io: AgentIO = { write: () => {} };
  await runAgentTurn(
    io,
    {
      provider: scriptedProvider([[{ kind: "text_delta", text: "ok" }, { kind: "model_end" }]]),
      providerId: "s",
      modelId: "m",
      tools: [],
      systemInstruction: "sys",
      idSeq,
      hooks,
      jobRegistry: {
        drainUndelivered: () => [{ id: "t1", status: "done", output: "ok" }],
      } as unknown as NonNullable<AgentDeps["jobRegistry"]>,
    },
    [],
    "",
    { origin: "task-notification" },
  );
  expect(events).not.toContain("UserPromptSubmit");
});

// --- tool-name alias mapping ----------------------------------------------

test("HOOK_TOOL_NAME_ALIASES maps shell_exec to Bash and apply_patch to Edit", () => {
  expect(HOOK_TOOL_NAME_ALIASES.shell_exec).toBe("Bash");
  expect(HOOK_TOOL_NAME_ALIASES.apply_patch).toBe("Edit");
});

test("PreToolUse fire carries the aliased toolName plus the original as keryxToolName", async () => {
  const { tool } = fakeTool("shell_exec", "shell");
  const { hooks, calls } = fakeHooks(true, () => EMPTY_RESULT);
  const io: AgentIO = { write: () => {}, permissionMode: () => "auto" };
  await runAgentTurn(
    io,
    {
      provider: scriptedProvider(callScript("shell_exec", '{"command":"echo hi"}')),
      providerId: "s",
      modelId: "m",
      tools: [tool],
      systemInstruction: "sys",
      idSeq,
      hooks,
    },
    [],
    "go",
  );
  const pre = calls.find((c) => c.event === "PreToolUse");
  expect(pre?.payload.toolName).toBe("Bash");
  expect(pre?.payload.keryxToolName).toBe("shell_exec");
});

// --- hooks absent: byte-identical (regression guard) ----------------------

test("hooks absent from AgentDeps leaves the risk gate completely unaffected", async () => {
  const { tool, ran } = fakeTool("shell_exec", "shell");
  const io: AgentIO = { write: () => {}, permissionMode: () => "auto" };
  await runAgentTurn(
    io,
    {
      provider: scriptedProvider(callScript("shell_exec", '{"command":"git status"}')),
      providerId: "s",
      modelId: "m",
      tools: [tool],
      systemInstruction: "sys",
      idSeq,
      // no `hooks` field at all
    },
    [],
    "go",
  );
  expect(ran()).toBe(true);
});
