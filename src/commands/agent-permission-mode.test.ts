// Phase 2 wiring: `io.permissionMode` (see `permission-mode.ts`) gates whether
// `executeCall` ever calls `requestApproval` at all. These tests pin the
// integration contract through the real `runAgentTurn` driver, not just the
// pure decision function (already covered by `permission-mode.test.ts`).

import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runAgentTurn } from "./agent";
import type { AgentDeps, AgentIO } from "./agent";
import type { PermissionMode } from "./permission-mode";
import { busLeasesFromClient } from "./shell";
import type { BusClient } from "../bus/client";
import { createLeaseView, createPauseLease } from "../bus/pause";
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

// Flow 275 F2 regression: `AgentDeps.busLeases` built from the REAL adapter
// (`busLeasesFromClient`, `./shell.ts`) over a REAL `createLeaseView`
// (`../bus/pause.ts`) holding only a `git-publish` lease — never a
// hand-written `{ appliesToMe, heldBy }` stub that could hard-code the right
// answer independently of the adapter's own scope handling. Before the F2
// fix, `heldBy()` was hard-scoped to `turns`, so with no `turns` lease active
// it returned `undefined` here even though `appliesToMe("git-publish")` was
// true — exactly the bug this replaces a masking stub to catch.
const LEASE_ROOTS: string[] = [];
afterAll(async () => {
  await Promise.all(LEASE_ROOTS.map((root) => rm(root, { recursive: true, force: true })));
});

async function realGitPublishBusLeases(
  instanceId: string,
  detail: { name: string; reason: string },
): Promise<NonNullable<AgentDeps["busLeases"]>> {
  const dir = await mkdtemp(path.join(tmpdir(), "keryx-agent-permission-mode-"));
  LEASE_ROOTS.push(dir);
  const root = path.join(dir, "bus");
  await createPauseLease(root, {
    holder: { instanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: detail.name, origin: "cli" },
    toLabel: "@all",
    scope: "git-publish",
    reason: detail.reason,
  });
  const view = createLeaseView({ root, instanceId });
  await view.refresh();
  return busLeasesFromClient({ leaseView: () => view } as unknown as BusClient);
}

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

// Flow 299 (AC4): `keryx flow confirm` mints the completion confirmation
// token, so it shares SAC's floor: asked in every mode, `auto` included.
for (const mode of ["ask", "trust", "auto"] as const) {
  test(`${mode} mode still asks for \`keryx flow confirm\` (flow 299 hard floor)`, async () => {
    const { tool, ran } = fakeTool("shell_exec", "shell");
    let approvalCalls = 0;
    const io: AgentIO = {
      write: () => {},
      requestApproval: async () => {
        approvalCalls += 1;
        return false;
      },
      permissionMode: () => mode,
    };
    await runAgentTurn(
      io,
      {
        provider: scriptedProvider(callScript("shell_exec", '{"command":"keryx flow confirm 299"}')),
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
}

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

// PERM-05 (0.2.55 live-testing campaign, flow 198): the campaign's own repro
// command (`rm -rf ./some-relative-dir`) is NOT actually destructive by this
// codebase's own classifier (`command-risk.ts`'s `ruleRm` only escalates a
// CATASTROPHIC target — filesystem root, home, a system root — not an
// ordinary scoped relative path), so the missing `[destructive]` tag observed
// in that live session was correct behavior, not a bug: `meta.destructive`
// was genuinely `false` for that command. This test instead exercises the
// real destructive path (`rm -rf /`) to confirm the escalation flag — and
// therefore shell.ts's `[destructive]` tag, which renders directly off this
// same `meta.destructive` — DOES reach `onAutoApproved` correctly under
// `auto` mode (the only mode that bypasses a destructive command's prompt;
// `trust` still escalates to `requestApproval` for `destructive`, per
// `resolveApprovalDecision`).
test("onAutoApproved fires with destructive:true for a genuinely catastrophic command under auto mode", async () => {
  const { tool } = fakeTool("shell_exec", "shell");
  const seen: { tool: string; destructive: boolean; credentials: boolean }[] = [];
  const io: AgentIO = {
    write: () => {},
    requestApproval: async () => true,
    permissionMode: () => "auto",
    onAutoApproved: (t, _input, meta) => {
      seen.push({ tool: t, ...meta });
    },
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
  expect(seen).toEqual([{ tool: "shell_exec", destructive: true, credentials: false }]);
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

// --- flow 265 T2: readOnly ("/plan") — orthogonal hard floor on top of the
// permission-mode gate above. Proves the axes are truly independent: `trust`
// (a mode that would otherwise auto-approve a benign shell command, per the
// "trust mode auto-approves a benign shell command without prompting" test
// above) still denies outright once `readOnly: true` is set — this is not a
// hidden 4th mode value, it is a floor `resolveApprovalDecision` applies
// before consulting `mode` at all (see `permission-mode.ts`).

test("readOnly denies a non-read tool call under trust mode, and requestApproval is never invoked", async () => {
  const { tool, ran } = fakeTool("shell_exec", "shell");
  let approvalCalls = 0;
  const results: { name: string; isError: boolean; output: string }[] = [];
  const io: AgentIO = {
    write: () => {},
    requestApproval: async () => {
      approvalCalls += 1;
      return true;
    },
    permissionMode: () => "trust",
    readOnly: () => true,
    onToolResult: (name, result) => {
      results.push({ name, isError: result.isError === true, output: result.output });
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
  expect(ran()).toBe(false);
  expect(approvalCalls).toBe(0);
  expect(results).toHaveLength(1);
  expect(results[0]?.isError).toBe(true);
  expect(results[0]?.output.toLowerCase()).toContain("read-only");
});

test("readOnly still allows a read-risk tool call to run normally", async () => {
  const { tool, ran } = fakeTool("get_cwd", "read");
  let approvalCalls = 0;
  const io: AgentIO = {
    write: () => {},
    requestApproval: async () => {
      approvalCalls += 1;
      return true;
    },
    permissionMode: () => "trust",
    readOnly: () => true,
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
  expect(ran()).toBe(true);
  expect(approvalCalls).toBe(0);
});

test("readOnly: false (or unset) reproduces existing behavior — trust mode still auto-approves a benign shell command", async () => {
  const { tool, ran } = fakeTool("shell_exec", "shell");
  let approvalCalls = 0;
  const io: AgentIO = {
    write: () => {},
    requestApproval: async () => {
      approvalCalls += 1;
      return true;
    },
    permissionMode: () => "trust",
    // no `readOnly` field at all — mirrors "no permissionMode getter" above
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

test("readOnly denies even under auto mode (the most permissive mode)", async () => {
  const { tool, ran } = fakeTool("apply_patch", "write");
  let approvalCalls = 0;
  const io: AgentIO = {
    write: () => {},
    requestApproval: async () => {
      approvalCalls += 1;
      return true;
    },
    permissionMode: () => "auto",
    readOnly: () => true,
  };
  await runAgentTurn(
    io,
    {
      provider: scriptedProvider(callScript("apply_patch", '{"command":"anything"}')),
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
  expect(approvalCalls).toBe(0);
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

// --- flow 275 T6: `bus_pause` (risk write) goes through the SAME gate as any
// other write-risk tool (AC7) — ask prompts, trust/auto skip the prompt,
// readOnly (/plan) denies outright, never on its own escalation dimension.

test("AC7: bus_pause prompts in ask mode (default)", async () => {
  const { tool, ran } = fakeTool("bus_pause", "write");
  let approvalCalls = 0;
  const io: AgentIO = {
    write: () => {},
    requestApproval: async () => {
      approvalCalls += 1;
      return true;
    },
    // no permissionMode getter — default is "ask"
  };
  await runAgentTurn(
    io,
    {
      provider: scriptedProvider(callScript("bus_pause", '{"command":"anything"}')),
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
  expect(ran()).toBe(true);
});

test("AC7: bus_pause runs without a prompt in trust mode", async () => {
  const { tool, ran } = fakeTool("bus_pause", "write");
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
      provider: scriptedProvider(callScript("bus_pause", '{"command":"anything"}')),
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
  expect(ran()).toBe(true);
});

test("AC7: bus_pause runs without a prompt in auto mode", async () => {
  const { tool, ran } = fakeTool("bus_pause", "write");
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
      provider: scriptedProvider(callScript("bus_pause", '{"command":"anything"}')),
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
  expect(ran()).toBe(true);
});

test("AC7: bus_pause is denied under /plan (readOnly), even under auto mode", async () => {
  const { tool, ran } = fakeTool("bus_pause", "write");
  let approvalCalls = 0;
  const io: AgentIO = {
    write: () => {},
    requestApproval: async () => {
      approvalCalls += 1;
      return true;
    },
    permissionMode: () => "auto",
    readOnly: () => true,
  };
  const history: NormalizedMessage[] = [];
  await runAgentTurn(
    io,
    {
      provider: scriptedProvider(callScript("bus_pause", '{"command":"anything"}')),
      providerId: "s",
      modelId: "m",
      tools: [tool],
      systemInstruction: "sys",
      idSeq,
    },
    history,
    "go",
  );
  expect(ran()).toBe(false);
  expect(approvalCalls).toBe(0);
  expect(history.find((m) => m.role === "tool")?.content).toMatch(/read-only/);
});

// --- flow 275 T6 (specification §4.4, AC6): the shell branch's publish-lease
// floor — computed as `isPublishCommand(command) &&
// deps.busLeases.appliesToMe("git-publish")` and threaded into BOTH the gate
// (`resolveApprovalDecision`) and the `ApprovalMeta` given to the approver.

test("AC6: a git-publish lease forces ask for git push even under auto mode, and the meta names the holder and reason", async () => {
  const { tool } = fakeTool("shell_exec", "shell");
  const seen: { publishLease: boolean | undefined; publishLeaseDetail: string | undefined }[] = [];
  const io: AgentIO = {
    write: () => {},
    requestApproval: async (_t, _i, meta) => {
      seen.push({ publishLease: meta?.publishLease, publishLeaseDetail: meta?.publishLeaseDetail });
      return false;
    },
    permissionMode: () => "auto",
  };
  const busLeases = await realGitPublishBusLeases("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", {
    name: "alice",
    reason: "cutting the release",
  });
  await runAgentTurn(
    io,
    {
      provider: scriptedProvider(callScript("shell_exec", '{"command":"git push origin main"}')),
      providerId: "s",
      modelId: "m",
      tools: [tool],
      systemInstruction: "sys",
      idSeq,
      busLeases,
    },
    [],
    "go",
  );
  expect(seen).toEqual([
    { publishLease: true, publishLeaseDetail: 'held by @alice — "cutting the release"' },
  ]);
});

test("AC6: without a git-publish lease, git push auto-approves under auto mode (unchanged)", async () => {
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
      provider: scriptedProvider(callScript("shell_exec", '{"command":"git push origin main"}')),
      providerId: "s",
      modelId: "m",
      tools: [tool],
      systemInstruction: "sys",
      idSeq,
      // no busLeases at all
    },
    [],
    "go",
  );
  expect(ran()).toBe(true);
  expect(approvalCalls).toBe(0);
});

test("AC6: a git-publish lease targeting a DIFFERENT scope (turns) does not force ask for git push", async () => {
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
      provider: scriptedProvider(callScript("shell_exec", '{"command":"git push origin main"}')),
      providerId: "s",
      modelId: "m",
      tools: [tool],
      systemInstruction: "sys",
      idSeq,
      busLeases: {
        appliesToMe: (scope) => scope === "turns", // not git-publish
      },
    },
    [],
    "go",
  );
  expect(ran()).toBe(true);
  expect(approvalCalls).toBe(0);
});

test("AC6: a git-publish lease does not affect a non-publish command (git status)", async () => {
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
      provider: scriptedProvider(callScript("shell_exec", '{"command":"git status"}')),
      providerId: "s",
      modelId: "m",
      tools: [tool],
      systemInstruction: "sys",
      idSeq,
      busLeases: {
        appliesToMe: (scope) => scope === "git-publish",
        heldBy: () => ({ name: "alice", reason: "cutting the release" }),
      },
    },
    [],
    "go",
  );
  expect(ran()).toBe(true);
  expect(approvalCalls).toBe(0);
});

test("AC6: publishLease still asks even when heldBy() has no detail to offer", async () => {
  const { tool } = fakeTool("shell_exec", "shell");
  const seen: { publishLease: boolean | undefined; publishLeaseDetail: string | undefined }[] = [];
  const io: AgentIO = {
    write: () => {},
    requestApproval: async (_t, _i, meta) => {
      seen.push({ publishLease: meta?.publishLease, publishLeaseDetail: meta?.publishLeaseDetail });
      return false;
    },
    permissionMode: () => "auto",
  };
  // The REAL adapter's `appliesToMe`, over a REAL git-publish lease — but a
  // caller that implements only `appliesToMe` and omits the optional
  // `heldBy` entirely (`AgentDeps.busLeases.heldBy` is `heldBy?()`), not a
  // hand-faked disconnect between the two.
  const { appliesToMe } = await realGitPublishBusLeases("cccccccc-cccc-4ccc-8ccc-cccccccccccc", {
    name: "alice",
    reason: "cutting the release",
  });
  await runAgentTurn(
    io,
    {
      provider: scriptedProvider(callScript("shell_exec", '{"command":"git push origin main"}')),
      providerId: "s",
      modelId: "m",
      tools: [tool],
      systemInstruction: "sys",
      idSeq,
      busLeases: { appliesToMe },
    },
    [],
    "go",
  );
  expect(seen).toEqual([{ publishLease: true, publishLeaseDetail: undefined }]);
});
