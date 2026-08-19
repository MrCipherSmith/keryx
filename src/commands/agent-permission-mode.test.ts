// Phase 2 wiring: `io.permissionMode` (see `permission-mode.ts`) gates whether
// `executeCall` ever calls `requestApproval` at all. These tests pin the
// integration contract through the real `runAgentTurn` driver, not just the
// pure decision function (already covered by `permission-mode.test.ts`).

import { expect, test } from "bun:test";
import { runAgentTurn } from "./agent";
import type { AgentIO } from "./agent";
import type { PermissionMode } from "./permission-mode";
import type { InteractiveTool } from "../harness/tool/builtin/interactive-tools";
import type { ToolRisk } from "../harness/tool/types";
import { shellExecTool } from "../harness/tool/builtin/shell-exec-tool";
// RED: flow 173 (background shell jobs) T2/T3 — this module does not exist
// yet. Colocated sibling of `shell-exec-tool.ts`; see this flow's journal.md.
import { createJobRegistry } from "../harness/tool/builtin/background-job-registry";
import type { BackgroundProcessHandle, JobRegistry } from "../harness/tool/builtin/background-job-registry";
import type {
  NormalizedEvent,
  NormalizedMessage,
  ProviderDescription,
  ProviderPort,
} from "../harness/provider/types";

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

function fakeTool(name: string, risk: ToolRisk): {
  tool: InteractiveTool;
  ran: () => boolean;
} {
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

test("auto mode never calls requestApproval, even for a destructive command", async () => {
  const { tool, ran } = fakeTool("shell_exec", "shell");
  let approvalCalls = 0;
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
      provider: scriptedProvider(callScript("shell_exec", '{"command":"rm -rf /"}')),
      providerId: "s",
      modelId: "m",
      tools: [tool],
      systemInstruction: "sys",
      idSeq,
    },
    [],
    "go",
  );
  expect(ran()).toBe(true);
  expect(approvalCalls).toBe(0);
});

test("auto mode still asks for a credentials-touching command (hard floor)", async () => {
  const { tool, ran } = fakeTool("shell_exec", "shell");
  const seen: { credentials?: boolean }[] = [];
  const io: AgentIO = {
    write: () => {},
    requestApproval: async (_t, _i, meta) => {
      seen.push({ credentials: meta?.credentials === true });
      return false;
    },
    permissionMode: () => "auto",
  };
  await runAgentTurn(
    io,
    {
      provider: scriptedProvider(callScript("shell_exec", '{"command":"cat ~/.config/keryx/auth.json"}')),
      providerId: "s",
      modelId: "m",
      tools: [tool],
      systemInstruction: "sys",
      idSeq,
    },
    [],
    "go",
  );
  expect(seen).toEqual([{ credentials: true }]);
  expect(ran()).toBe(false);
});

test("auto mode still asks for a command touching SAC confirm-review (hard floor)", async () => {
  const { tool, ran } = fakeTool("shell_exec", "shell");
  let approvalCalls = 0;
  const io: AgentIO = {
    write: () => {},
    requestApproval: async () => {
      approvalCalls += 1;
      return false;
    },
    permissionMode: () => "auto",
  };
  await runAgentTurn(
    io,
    {
      provider: scriptedProvider(
        callScript("shell_exec", '{"command":"keryx workspace confirm-review --workspace ws-1"}'),
      ),
      providerId: "s",
      modelId: "m",
      tools: [tool],
      systemInstruction: "sys",
      idSeq,
    },
    [],
    "go",
  );
  expect(approvalCalls).toBe(1);
  expect(ran()).toBe(false);
});

test("trust mode auto-approves a benign shell command without prompting", async () => {
  const { tool, ran } = fakeTool("shell_exec", "shell");
  let approvalCalls = 0;
  const io: AgentIO = {
    write: () => {},
    requestApproval: async () => {
      approvalCalls += 1;
      return true;
    },
    permissionMode: () => "trust",
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
    },
    [],
    "go",
  );
  expect(ran()).toBe(true);
  expect(approvalCalls).toBe(0);
});

test("trust mode still asks for a destructive command, and denial blocks it", async () => {
  const { tool, ran } = fakeTool("shell_exec", "shell");
  let approvalCalls = 0;
  const io: AgentIO = {
    write: () => {},
    requestApproval: async () => {
      approvalCalls += 1;
      return false;
    },
    permissionMode: () => "trust",
  };
  await runAgentTurn(
    io,
    {
      provider: scriptedProvider(callScript("shell_exec", '{"command":"rm -rf /"}')),
      providerId: "s",
      modelId: "m",
      tools: [tool],
      systemInstruction: "sys",
      idSeq,
    },
    [],
    "go",
  );
  expect(ran()).toBe(false);
  expect(approvalCalls).toBe(1);
});

test("trust mode still asks when the tool's own static risk is 'destructive'", async () => {
  const { tool, ran } = fakeTool("dangerous_tool", "destructive");
  let approvalCalls = 0;
  const io: AgentIO = {
    write: () => {},
    requestApproval: async () => {
      approvalCalls += 1;
      return true;
    },
    permissionMode: () => "trust",
  };
  await runAgentTurn(
    io,
    {
      provider: scriptedProvider(callScript("dangerous_tool", '{"command":"anything"}')),
      providerId: "s",
      modelId: "m",
      tools: [tool],
      systemInstruction: "sys",
      idSeq,
    },
    [],
    "go",
  );
  expect(ran()).toBe(true);
  expect(approvalCalls).toBe(1);
});

test("no permissionMode getter behaves exactly like today's default (ask)", async () => {
  const { tool, ran } = fakeTool("shell_exec", "shell");
  let approvalCalls = 0;
  const io: AgentIO = {
    write: () => {},
    requestApproval: async () => {
      approvalCalls += 1;
      return true;
    },
    // no `permissionMode` field at all
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
    },
    [],
    "go",
  );
  expect(ran()).toBe(true);
  expect(approvalCalls).toBe(1);
});

test("the mode getter is read fresh per turn — a live toggle between turns takes effect immediately", async () => {
  const { tool, ran } = fakeTool("shell_exec", "shell");
  let mode: PermissionMode = "ask";
  let approvalCalls = 0;
  const io: AgentIO = {
    write: () => {},
    requestApproval: async () => {
      approvalCalls += 1;
      return true;
    },
    permissionMode: () => mode,
  };
  const deps = {
    providerId: "s",
    modelId: "m",
    tools: [tool],
    systemInstruction: "sys",
    idSeq,
  };

  await runAgentTurn(
    io,
    { ...deps, provider: scriptedProvider(callScript("shell_exec", '{"command":"git status"}')) },
    [],
    "go",
  );
  expect(approvalCalls).toBe(1); // ask mode: still prompted

  mode = "trust"; // live toggle, e.g. via a `/mode trust` command
  await runAgentTurn(
    io,
    { ...deps, provider: scriptedProvider(callScript("shell_exec", '{"command":"git status"}')) },
    [],
    "go again",
  );
  expect(approvalCalls).toBe(1); // trust mode: no additional prompt for a benign command
  expect(ran()).toBe(true);
});

test("onAutoApproved fires with the escalation flags when a mode skips the prompt", async () => {
  const { tool } = fakeTool("shell_exec", "shell");
  const seen: { tool: string; destructive: boolean; credentials: boolean }[] = [];
  const io: AgentIO = {
    write: () => {},
    requestApproval: async () => true,
    permissionMode: () => "trust",
    onAutoApproved: (t, _input, meta) => {
      seen.push({ tool: t, ...meta });
    },
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
    },
    [],
    "go",
  );
  expect(seen).toEqual([{ tool: "shell_exec", destructive: false, credentials: false }]);
});

test("onAutoApproved does NOT fire when the mode still asks", async () => {
  const { tool } = fakeTool("shell_exec", "shell");
  let autoApprovedCalls = 0;
  const io: AgentIO = {
    write: () => {},
    requestApproval: async () => true,
    permissionMode: () => "ask",
    onAutoApproved: () => {
      autoApprovedCalls += 1;
    },
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
    },
    [],
    "go",
  );
  expect(autoApprovedCalls).toBe(0);
});

test("onAutoApproved never fires for a plain read tool — that was already silent", async () => {
  const { tool } = fakeTool("get_cwd", "read");
  let autoApprovedCalls = 0;
  const io: AgentIO = {
    write: () => {},
    permissionMode: () => "auto",
    onAutoApproved: () => {
      autoApprovedCalls += 1;
    },
  };
  await runAgentTurn(
    io,
    {
      provider: scriptedProvider(callScript("get_cwd", '{"command":"n/a"}')),
      providerId: "s",
      modelId: "m",
      tools: [tool],
      systemInstruction: "sys",
      idSeq,
    },
    [],
    "go",
  );
  expect(autoApprovedCalls).toBe(0);
});

// --- flow 173 (background shell jobs) AC10: `background: true` must be
// gated by the EXACT SAME `resolveApprovalDecision` outcome as an ordinary
// shell_exec call, across ask/trust/auto, with the same destructive/
// credentials hard floor — no separate or stricter gate. Extends the
// ask/trust/auto coverage above using the REAL `shellExecTool` (not the
// generic `fakeTool`) wired to an injectable `JobRegistry`, so "the tool
// actually ran" is verified concretely — a job got registered — rather than
// via a synthetic invoked flag.

function fakeJobRegistryForApprovalTests(): { registry: JobRegistry } {
  const registry = createJobRegistry({
    initialBufferMs: 0,
    spawn: (): BackgroundProcessHandle => ({
      pid: 9001,
      onOutput: () => {},
      onExit: () => {},
      kill: () => {},
    }),
  });
  return { registry };
}

test("AC10: auto mode never calls requestApproval for shell_exec background:true (benign command)", async () => {
  const { registry } = fakeJobRegistryForApprovalTests();
  const tool = shellExecTool("/proj", async () => ({ output: "unused", isError: false }), registry);
  let approvalCalls = 0;
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
      provider: scriptedProvider(callScript("shell_exec", '{"command":"git status","background":true}')),
      providerId: "s",
      modelId: "m",
      tools: [tool],
      systemInstruction: "sys",
      idSeq,
    },
    [],
    "go",
  );
  expect(approvalCalls).toBe(0);
  expect(registry.list()).toHaveLength(1); // the background job actually started
});

test("AC10: auto mode still asks for a credentials-touching background command (same hard floor)", async () => {
  const { registry } = fakeJobRegistryForApprovalTests();
  const tool = shellExecTool("/proj", async () => ({ output: "unused", isError: false }), registry);
  const seen: { credentials?: boolean }[] = [];
  const io: AgentIO = {
    write: () => {},
    requestApproval: async (_t, _i, meta) => {
      seen.push({ credentials: meta?.credentials === true });
      return false;
    },
    permissionMode: () => "auto",
  };
  await runAgentTurn(
    io,
    {
      provider: scriptedProvider(
        callScript("shell_exec", '{"command":"cat ~/.config/keryx/auth.json","background":true}'),
      ),
      providerId: "s",
      modelId: "m",
      tools: [tool],
      systemInstruction: "sys",
      idSeq,
    },
    [],
    "go",
  );
  expect(seen).toEqual([{ credentials: true }]);
  expect(registry.list()).toHaveLength(0); // denied — no job ever started
});

test("AC10: trust mode auto-approves a benign background command without prompting", async () => {
  const { registry } = fakeJobRegistryForApprovalTests();
  const tool = shellExecTool("/proj", async () => ({ output: "unused", isError: false }), registry);
  let approvalCalls = 0;
  const io: AgentIO = {
    write: () => {},
    requestApproval: async () => {
      approvalCalls += 1;
      return true;
    },
    permissionMode: () => "trust",
  };
  await runAgentTurn(
    io,
    {
      provider: scriptedProvider(callScript("shell_exec", '{"command":"git status","background":true}')),
      providerId: "s",
      modelId: "m",
      tools: [tool],
      systemInstruction: "sys",
      idSeq,
    },
    [],
    "go",
  );
  expect(approvalCalls).toBe(0);
  expect(registry.list()).toHaveLength(1);
});

test("AC10: trust mode still asks for a destructive background command, and denial blocks the job from starting", async () => {
  const { registry } = fakeJobRegistryForApprovalTests();
  const tool = shellExecTool("/proj", async () => ({ output: "unused", isError: false }), registry);
  let approvalCalls = 0;
  const io: AgentIO = {
    write: () => {},
    requestApproval: async () => {
      approvalCalls += 1;
      return false;
    },
    permissionMode: () => "trust",
  };
  await runAgentTurn(
    io,
    {
      provider: scriptedProvider(callScript("shell_exec", '{"command":"rm -rf /","background":true}')),
      providerId: "s",
      modelId: "m",
      tools: [tool],
      systemInstruction: "sys",
      idSeq,
    },
    [],
    "go",
  );
  expect(approvalCalls).toBe(1);
  expect(registry.list()).toHaveLength(0);
});

test("AC10: ask mode (default, no permissionMode getter) still prompts for a background command exactly like any other shell_exec call", async () => {
  const { registry } = fakeJobRegistryForApprovalTests();
  const tool = shellExecTool("/proj", async () => ({ output: "unused", isError: false }), registry);
  let approvalCalls = 0;
  const io: AgentIO = {
    write: () => {},
    requestApproval: async () => {
      approvalCalls += 1;
      return true;
    },
    // no `permissionMode` field at all — mirrors the existing "no
    // permissionMode getter behaves exactly like today's default (ask)" test
  };
  await runAgentTurn(
    io,
    {
      provider: scriptedProvider(callScript("shell_exec", '{"command":"git status","background":true}')),
      providerId: "s",
      modelId: "m",
      tools: [tool],
      systemInstruction: "sys",
      idSeq,
    },
    [],
    "go",
  );
  expect(approvalCalls).toBe(1);
  expect(registry.list()).toHaveLength(1);
});
