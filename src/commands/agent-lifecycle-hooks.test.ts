// Flow 306 (W6 T9): `keryx shell`'s own agent loop (`agent.ts`'s `executeCall`/
// `runAgentTurn`) wired to the standalone lifecycle hook runtime
// (`src/harness/hooks/`, T5). Almost every test here uses a FAKE
// `HookRuntime` — no real subprocess, no real config file — exactly like
// `agent-permission-mode.test.ts` fakes `AgentIO.requestApproval`/
// `ProviderPort` for the same reason: this module tests the WIRING, not the
// T5 runtime's own internals (already covered by `src/harness/hooks/
// *.test.ts`). The one exception (review finding 17, at the bottom of this
// file) opts INTO the real `buildShellHookRuntime` deliberately, to prove the
// wiring also holds with a real spawned process in the loop, not just a
// scripted stand-in.
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runAgentTurn } from "./agent";
import type { AgentDeps, AgentIO } from "./agent";
import { buildShellHookRuntime, HOOK_TOOL_NAME_ALIASES } from "./agent-hooks";
import type { ShellHookContext } from "./agent-hooks";
import { detectSandboxLauncher } from "../harness/process/sandbox/detect";
import { BUILTIN_HOOK_REGISTRATIONS } from "../harness/hooks/builtins";
import { createHookRuntime } from "../harness/hooks/runtime";
import { projectHooksDigestOfDoc, recordProjectHooksTrust } from "../harness/hooks";
import type { HookFireResult, HookRuntime } from "../harness/hooks/runtime";
import type { HookProcessRunner } from "../harness/hooks/runner";
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

type FireCtx = { toolName?: string | undefined; profileId?: string | undefined; decideOutcome?: string | undefined };
type FireHandler = (event: HookEventName, payload: Record<string, unknown>, ctx?: FireCtx) => HookFireResult;

const EMPTY_RESULT: HookFireResult = {
  decisions: [],
  additionalContext: [],
  records: [],
  warnings: [],
  anomalies: [],
};

/** A fake `HookRuntime` whose `fire()` is fully scripted by the test. */
function fakeHooks(
  interactive: boolean,
  handler?: FireHandler,
): { hooks: ShellHookContext; calls: Array<{ event: HookEventName; payload: Record<string, unknown>; ctx?: FireCtx }> } {
  const calls: Array<{ event: HookEventName; payload: Record<string, unknown>; ctx?: FireCtx }> = [];
  const runtime: HookRuntime = {
    interactive,
    registrations: () => [],
    inheritedHookIds: () => [],
    forChild: () => runtime,
    async fire(event, payload, ctx) {
      calls.push({ event, payload, ...(ctx !== undefined ? { ctx } : {}) });
      return handler?.(event, payload, ctx) ?? EMPTY_RESULT;
    },
  };
  return { hooks: { runtime, sessionId: "s1", runId: "r1" }, calls };
}

/** A fake `HookRuntime` whose `fire()` throws for a given event — a gate-hook crash. */
function crashingHooks(interactive: boolean, crashOn: HookEventName): { hooks: ShellHookContext } {
  const runtime: HookRuntime = {
    interactive,
    registrations: () => [],
    inheritedHookIds: () => [],
    forChild: () => runtime,
    async fire(event) {
      if (event === crashOn) {
        throw new Error("hook runner crashed (simulated)");
      }
      return EMPTY_RESULT;
    },
  };
  return { hooks: { runtime, sessionId: "s1", runId: "r1" } };
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

// Flow 306 fix round 2 (finding B): under the DEFAULT `ask` permission mode,
// a `shell`-risk call already asks on its own — `rawDecision` is `ask` before
// any hook runs. A `PreToolUse` hook that ALSO asks then agrees with
// `rawDecision`, so `composeWithHook`'s tighten step reports no change
// (`hookTightened: false`). Before the fix, `hookAsk` was derived from
// `hookTightened` alone, so this exact case — a hook asking on a call the
// mode already asked on — silently dropped `meta.hookAsk`, and the TUI
// read-only spawn fast path / saved shell allowlist / ACP `allow_always`
// would have auto-answered an approval the hook specifically demanded.
test("PreToolUse ask under default ask mode still sets hookAsk (the mode already asked too)", async () => {
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
    // permissionMode absent -> DEFAULT_PERMISSION_MODE ("ask"), which already
    // asks for a `shell`-risk call BEFORE the hook is even consulted.
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

test("PreToolUse ask under default ask mode sets hookAsk for spawn_subagent (delegate risk) too", async () => {
  const { tool, ran } = fakeTool("spawn_subagent", "delegate");
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
    // permissionMode absent -> DEFAULT_PERMISSION_MODE ("ask"), which already
    // asks for a `delegate`-risk call (no approver-absent default-deny path
    // exercised here — an approver IS present).
  };
  await runAgentTurn(
    io,
    {
      provider: scriptedProvider(callScript("spawn_subagent", '{"command":"x"}')),
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

// F-001 (fix round 3, T21 review): the REAL `keryx.impact-evidence` builtin,
// driven through the real `firePreToolUseHook` wiring, with a real
// `apply_patch` call whose patch touches two files — proving the provider
// receives BOTH, not just a synthetic `Write`/`file_path` shape no Keryx
// tool actually produces. Uses `createHookRuntime` directly (not
// `buildShellHookRuntime`) with only the `keryx.impact-evidence`
// registration, so no command hook needs a real/fake subprocess runner.
test("F-001: an agent-level apply_patch call touching two files reaches the impact-evidence provider with both", async () => {
  // NOT `fakeTool("apply_patch", "write")` — that helper's `inputSchema`
  // requires a `command` field (the `shell_exec`/`bus_pause` shape most
  // other tests in this file use), which would reject a `{patch}` call
  // before it ever reached the hook. A real `apply_patch`-shaped schema.
  let invoked = false;
  const ran = (): boolean => invoked;
  const tool: InteractiveTool = {
    definition: {
      name: "apply_patch",
      description: "test apply_patch",
      inputSchema: { type: "object", properties: { patch: { type: "string" } }, required: ["patch"], additionalProperties: false },
      risk: "write",
    },
    invoke: async () => {
      invoked = true;
      return { output: "ran", isError: false };
    },
  };
  const seenFiles: string[][] = [];
  const neverRunner: HookProcessRunner = {
    run: async () => {
      throw new Error("no command hook should run in this test");
    },
  };
  const runtime = createHookRuntime({
    registrations: BUILTIN_HOOK_REGISTRATIONS.filter((r) => r.id === "keryx.impact-evidence"),
    runner: neverRunner,
    clock: () => "2026-01-01T00:00:00.000Z",
    profileId: "monitored-trusted-local",
    interactive: true,
    sessionId: "s1",
    runId: "r1",
    projectRoot: "/proj",
    ports: {
      impactEvidence: {
        evidenceFor: (input) => {
          seenFiles.push(input.files);
          return {};
        },
      },
    },
  });
  const hooks: ShellHookContext = { runtime, sessionId: "s1", runId: "r1" };
  const io: AgentIO = { write: () => {}, permissionMode: () => "auto" };
  const patch = [
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1 +1 @@",
    "-old a",
    "+new a",
    "--- a/src/b.ts",
    "+++ b/src/b.ts",
    "@@ -1 +1 @@",
    "-old b",
    "+new b",
    "",
  ].join("\n");
  await runAgentTurn(
    io,
    {
      provider: scriptedProvider(callScript("apply_patch", JSON.stringify({ patch }))),
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
  expect(ran()).toBe(true);
  expect(seenFiles).toEqual([["src/a.ts", "src/b.ts"]]);
});

function applyPatchTool(): { tool: InteractiveTool; invocations: () => number } {
  let invocations = 0;
  return {
    invocations: () => invocations,
    tool: {
      definition: {
        name: "apply_patch",
        description: "test apply_patch",
        inputSchema: { type: "object", properties: { patch: { type: "string" } }, required: ["patch"], additionalProperties: false },
        risk: "write",
      },
      invoke: async () => {
        invocations += 1;
        return { output: "ran", isError: false };
      },
    },
  };
}

// F-001 (fix round 4, T21 review round 4): an interactive operator's
// approval of a `keryx.impact-evidence` `ask` IS the acknowledgement W8
// strict mode waits for — without forwarding it, every LATER edit of the
// same file re-asks forever (round 4's finding). Uses the real
// `createHookRuntime` (only the `keryx.impact-evidence` registration, no
// command hooks) with a FAKE provider that models W8's own acknowledgement
// contract (ask when unacknowledged, allow once acknowledged) — the real W8
// provider is out of scope for this fix (round 4's own instruction).
test("F-001 (round 4): an interactive approval of an impact-evidence ask acknowledges it — the next edit of the same file is not asked again", async () => {
  const { tool, invocations } = applyPatchTool();
  const seenAcks: (string | undefined)[] = [];
  const neverRunner: HookProcessRunner = {
    run: async () => {
      throw new Error("no command hook should run in this test");
    },
  };
  const runtime = createHookRuntime({
    registrations: BUILTIN_HOOK_REGISTRATIONS.filter((r) => r.id === "keryx.impact-evidence"),
    runner: neverRunner,
    clock: () => "2026-01-01T00:00:00.000Z",
    profileId: "monitored-trusted-local",
    interactive: true,
    sessionId: "s1",
    runId: "r1",
    projectRoot: "/proj",
    ports: {
      impactEvidence: {
        evidenceFor: (input) => {
          seenAcks.push(input.acknowledgement);
          return input.acknowledgement === undefined ? { decision: "ask" } : {};
        },
      },
    },
  });
  const hooks: ShellHookContext = { runtime, sessionId: "s1", runId: "r1" };
  const patchInput = JSON.stringify({ patch: ["--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1 +1 @@", "-old", "+new", ""].join("\n") });
  let approvals = 0;
  const io: AgentIO = {
    write: () => {},
    permissionMode: () => "ask",
    requestApproval: async () => {
      approvals += 1;
      return true;
    },
  };

  // Two SEPARATE turns editing the same file — the second is where the fix
  // matters: with the round-3-only code, W8 would ask again here too.
  await runAgentTurn(
    io,
    { provider: scriptedProvider(callScript("apply_patch", patchInput)), providerId: "s", modelId: "m", tools: [tool], systemInstruction: "sys", idSeq, hooks },
    [],
    "go",
  );
  await runAgentTurn(
    io,
    { provider: scriptedProvider(callScript("apply_patch", patchInput)), providerId: "s", modelId: "m", tools: [tool], systemInstruction: "sys", idSeq, hooks },
    [],
    "go",
  );

  expect(invocations()).toBe(2);
  expect(approvals).toBe(2); // `ask` permission mode asks every time regardless of the hook.
  // The critical assertion: the SECOND call to the provider carries the
  // acknowledgement from the FIRST call's approval — W8 never had to ask
  // again about the same file.
  expect(seenAcks).toEqual([undefined, "operator-approved"]);
});

test("F-001 (round 4): a refused impact-evidence ask does not acknowledge — the next edit still asks", async () => {
  const { tool, invocations } = applyPatchTool();
  const seenAcks: (string | undefined)[] = [];
  const neverRunner: HookProcessRunner = {
    run: async () => {
      throw new Error("no command hook should run in this test");
    },
  };
  const runtime = createHookRuntime({
    registrations: BUILTIN_HOOK_REGISTRATIONS.filter((r) => r.id === "keryx.impact-evidence"),
    runner: neverRunner,
    clock: () => "2026-01-01T00:00:00.000Z",
    profileId: "monitored-trusted-local",
    interactive: true,
    sessionId: "s1",
    runId: "r1",
    projectRoot: "/proj",
    ports: {
      impactEvidence: {
        evidenceFor: (input) => {
          seenAcks.push(input.acknowledgement);
          // Never acknowledges — models a W8 provider the operator keeps refusing.
          return { decision: "ask" };
        },
      },
    },
  });
  const hooks: ShellHookContext = { runtime, sessionId: "s1", runId: "r1" };
  const patchInput = JSON.stringify({ patch: ["--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1 +1 @@", "-old", "+new", ""].join("\n") });
  // `auto` mode: the ONLY reason an approval is requested at all is the
  // hook's own `ask` — proves the refusal path, not the permission mode,
  // gates the acknowledgement.
  const io: AgentIO = { write: () => {}, permissionMode: () => "auto", requestApproval: async () => false };

  await runAgentTurn(
    io,
    { provider: scriptedProvider(callScript("apply_patch", patchInput)), providerId: "s", modelId: "m", tools: [tool], systemInstruction: "sys", idSeq, hooks },
    [],
    "go",
  );
  await runAgentTurn(
    io,
    { provider: scriptedProvider(callScript("apply_patch", patchInput)), providerId: "s", modelId: "m", tools: [tool], systemInstruction: "sys", idSeq, hooks },
    [],
    "go",
  );

  expect(invocations()).toBe(0);
  expect(seenAcks).toEqual([undefined, undefined]);
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

// --- review fixes: UserPromptSubmit "ask" tightening (findings 3, 4) ------

test("UserPromptSubmit ask reaches the operator via requestApproval (hookAsk set), and an approval lets the prompt through", async () => {
  let providerCalled = false;
  const provider: ProviderPort = {
    describe: () => DESCRIPTION,
    stream: () => {
      providerCalled = true;
      return (async function* (): AsyncGenerator<NormalizedEvent> {
        yield { sequence: 0, attemptId: "a", kind: "text_delta", text: "ok" } as NormalizedEvent;
        yield { sequence: 1, attemptId: "a", kind: "model_end" } as NormalizedEvent;
      })();
    },
  };
  const { hooks } = fakeHooks(true, (event) =>
    event === "UserPromptSubmit" ? { ...EMPTY_RESULT, tightened: "ask", denyReason: "needs a look" } : EMPTY_RESULT,
  );
  const seenMeta: { tool: string; hookAsk?: boolean | undefined; alwaysAsk?: boolean | undefined }[] = [];
  const io: AgentIO = {
    write: () => {},
    requestApproval: async (tool, _input, meta) => {
      seenMeta.push({ tool, hookAsk: meta?.hookAsk, alwaysAsk: meta?.alwaysAsk });
      return true;
    },
    permissionMode: () => "auto",
  };
  await runAgentTurn(
    io,
    { provider, providerId: "s", modelId: "m", tools: [], systemInstruction: "sys", idSeq, hooks },
    [],
    "go",
  );
  expect(providerCalled).toBe(true);
  // A standing `trust`/`auto` permission mode never answers this for the
  // operator (`resolveApprovalDecision` is deliberately not consulted) — a
  // REAL approval prompt must have fired, marked as a hard floor.
  expect(seenMeta).toEqual([{ tool: "user_prompt", hookAsk: true, alwaysAsk: true }]);
});

test("UserPromptSubmit ask stops the turn when the operator refuses", async () => {
  let providerCalled = false;
  const provider: ProviderPort = {
    describe: () => DESCRIPTION,
    stream: () => {
      providerCalled = true;
      return (async function* (): AsyncGenerator<NormalizedEvent> {
        yield { sequence: 0, attemptId: "a", kind: "model_end" } as NormalizedEvent;
      })();
    },
  };
  const { hooks } = fakeHooks(true, (event) =>
    event === "UserPromptSubmit" ? { ...EMPTY_RESULT, tightened: "ask" } : EMPTY_RESULT,
  );
  const io: AgentIO = { write: () => {}, requestApproval: async () => false, permissionMode: () => "auto" };
  await runAgentTurn(
    io,
    { provider, providerId: "s", modelId: "m", tools: [], systemInstruction: "sys", idSeq, hooks },
    [],
    "go",
  );
  expect(providerCalled).toBe(false);
});

test("UserPromptSubmit ask fails CLOSED (denies) when no approver is wired — the unattended posture", async () => {
  let providerCalled = false;
  const provider: ProviderPort = {
    describe: () => DESCRIPTION,
    stream: () => {
      providerCalled = true;
      return (async function* (): AsyncGenerator<NormalizedEvent> {
        yield { sequence: 0, attemptId: "a", kind: "model_end" } as NormalizedEvent;
      })();
    },
  };
  const { hooks } = fakeHooks(true, (event) =>
    event === "UserPromptSubmit" ? { ...EMPTY_RESULT, tightened: "ask" } : EMPTY_RESULT,
  );
  // No `requestApproval` at all — exactly `runOffline`'s posture.
  const io: AgentIO = { write: () => {} };
  await runAgentTurn(
    io,
    { provider, providerId: "s", modelId: "m", tools: [], systemInstruction: "sys", idSeq, hooks },
    [],
    "go",
  );
  expect(providerCalled).toBe(false);
});

test("UserPromptSubmit hook CRASH fails CLOSED — the turn is refused, not 'ignored'", async () => {
  let providerCalled = false;
  const provider: ProviderPort = {
    describe: () => DESCRIPTION,
    stream: () => {
      providerCalled = true;
      return (async function* (): AsyncGenerator<NormalizedEvent> {
        yield { sequence: 0, attemptId: "a", kind: "model_end" } as NormalizedEvent;
      })();
    },
  };
  const { hooks } = crashingHooks(true, "UserPromptSubmit");
  const systemMessages: string[] = [];
  const io: AgentIO = { write: () => {}, onSystem: (t) => systemMessages.push(t) };
  await runAgentTurn(
    io,
    { provider, providerId: "s", modelId: "m", tools: [], systemInstruction: "sys", idSeq, hooks },
    [],
    "go",
  );
  expect(providerCalled).toBe(false);
  expect(systemMessages.some((m) => m.includes("blocked") && !m.includes("ignored"))).toBe(true);
});

// --- review fixes: PreToolUse hook crash fails closed (finding 3) --------

test("PreToolUse hook CRASH fails CLOSED — the call is refused, never invoked, never silently ungated", async () => {
  const { tool, ran } = fakeTool("shell_exec", "shell");
  const { hooks } = crashingHooks(true, "PreToolUse");
  const io: AgentIO = { write: () => {}, permissionMode: () => "auto" };
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
});

// --- review fix: PreToolUse carries a provisional decideOutcome (finding 6) -

test("PreToolUse fire's ctx carries a provisional decideOutcome derived from the risk gate", async () => {
  const { tool: shellTool } = fakeTool("shell_exec", "shell");
  const { hooks, calls } = fakeHooks(true, () => EMPTY_RESULT);
  const io: AgentIO = { write: () => {}, permissionMode: () => "ask" };
  await runAgentTurn(
    io,
    {
      provider: scriptedProvider(callScript("shell_exec", '{"command":"echo hi"}')),
      providerId: "s",
      modelId: "m",
      tools: [shellTool],
      systemInstruction: "sys",
      idSeq,
      hooks,
      // No `requestApproval`: the gate's own default-deny is irrelevant here —
      // only the hook `fire()` ctx is under test.
    },
    [],
    "go",
  );
  const pre = calls.find((c) => c.event === "PreToolUse");
  // `ask` mode + shell risk (no destructive/credentials known yet at fire
  // time) => resolveApprovalDecision -> "ask" -> decideOutcome "ask".
  expect(pre?.ctx?.decideOutcome).toBe("ask");
});

test("PreToolUse fire's ctx decideOutcome is 'allow' for a read-risk tool (never otherwise gated)", async () => {
  const { tool: readTool } = fakeTool("workspace_context", "read");
  const { hooks, calls } = fakeHooks(true, () => EMPTY_RESULT);
  const io: AgentIO = { write: () => {} };
  await runAgentTurn(
    io,
    {
      provider: scriptedProvider(callScript("workspace_context", '{"command":"x"}')),
      providerId: "s",
      modelId: "m",
      tools: [readTool],
      systemInstruction: "sys",
      idSeq,
      hooks,
    },
    [],
    "go",
  );
  const pre = calls.find((c) => c.event === "PreToolUse");
  expect(pre?.ctx?.decideOutcome).toBe("allow");
});

test("PreToolUse fire's ctx decideOutcome is 'allow' for a shell tool under `auto` permission mode", async () => {
  const { tool: shellTool } = fakeTool("shell_exec", "shell");
  const { hooks, calls } = fakeHooks(true, () => EMPTY_RESULT);
  const io: AgentIO = { write: () => {}, permissionMode: () => "auto" };
  await runAgentTurn(
    io,
    {
      provider: scriptedProvider(callScript("shell_exec", '{"command":"echo hi"}')),
      providerId: "s",
      modelId: "m",
      tools: [shellTool],
      systemInstruction: "sys",
      idSeq,
      hooks,
    },
    [],
    "go",
  );
  const pre = calls.find((c) => c.event === "PreToolUse");
  expect(pre?.ctx?.decideOutcome).toBe("allow");
});

// --- review finding 17: one opt-in REAL-runtime integration test ----------
//
// Every other test in this file fakes `HookRuntime` (see the file's own doc
// comment) because `test-preload.ts` defaults `KERYX_HOOKS=off` for every
// test — an integration test that builds the REAL production runtime
// (`buildShellHookRuntime`, spawning actual OS processes via
// `createRealHookRunner`) without opting in gets nothing exercised at all.
// This is that one opt-in test: a real temp project, a real gate-hook SCRIPT
// (not a `keryx …` command — no `keryx` binary needs to be resolvable under
// `bun test`), spawned through the default SANDBOXED path (`runsIn` left at
// its default), skipped when this machine has no sandbox launcher rather
// than silently exercising the unsandboxed fallback.
test.skipIf(!detectSandboxLauncher().available)(
  "finding 17: the real buildShellHookRuntime denies a real shell_exec call via a real gate hook script",
  async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "keryx-agent-hooks-real-"));
    try {
      await mkdir(path.join(dir, ".metaproject"), { recursive: true });
      const scriptPath = path.join(dir, "deny-bash.js");
      await writeFile(scriptPath, 'process.stderr.write("denied by real gate hook\\n");\nprocess.exit(2);\n', "utf8");

      // Disable the three command built-ins (ctx-guard, the two security
      // scans) — under `bun test`, `process.argv[1]` is the test runner, not
      // keryx, so `resolveKeryxArgv` correctly falls back to plain `"keryx"`
      // on `PATH` (see its own doc comment) — which this sandboxed machine
      // may not have installed. Disabling them keeps this test about the ONE
      // thing under test: a real, hand-authored gate hook denying a real
      // call, not about whether a `keryx` binary happens to be on `PATH`.
      //
      // R700-02: all three are protected built-in GATES, so a PROJECT-scope
      // disable of them is now ignored (D10/D12) — they move to the USER
      // file with the explicit acknowledgement instead.
      const userDoc = {
        schemaVersion: "1.0.0",
        hooks: {
          PreToolUse: [
            { id: "keryx.ctx-guard", enabled: false, acknowledge: "disable-builtin-gate" },
            { id: "keryx.security-check-output", enabled: false, acknowledge: "disable-builtin-gate" },
          ],
          UserPromptSubmit: [{ id: "keryx.security-check-input", enabled: false, acknowledge: "disable-builtin-gate" }],
        },
      };
      await mkdir(path.join(dir, ".keryx"), { recursive: true });
      await writeFile(path.join(dir, ".keryx", "hooks.json"), JSON.stringify(userDoc, null, 2), "utf8");

      const doc = {
        schemaVersion: "1.0.0",
        hooks: {
          PreToolUse: [
            {
              id: "real-deny-bash",
              matcher: "Bash",
              class: "gate",
              command: { argv: [process.execPath, scriptPath] },
              timeoutMs: 5000,
              // `runsIn` deliberately omitted — defaults to "sandbox", the
              // real production path, never the `unsandboxed` fallback.
            },
          ],
        },
      };
      await writeFile(path.join(dir, ".metaproject", "hooks.json"), JSON.stringify(doc, null, 2), "utf8");

      // R700-01: a project full registration only loads once trusted — this
      // test's own point is the REAL runtime denying a real call, not the
      // trust prompt, so trust it directly the way `keryx hooks trust`
      // itself would record it.
      const configDir = path.join(dir, "config");
      const digest = projectHooksDigestOfDoc(doc);
      if (digest === undefined) throw new Error("expected a digest for a project file with one full registration");
      const trustResult = recordProjectHooksTrust({ trustRoot: dir, digest, hookIds: ["real-deny-bash"], configDir });
      if (!trustResult.ok) throw new Error(`recordProjectHooksTrust failed: ${trustResult.error}`);

      const hooks = buildShellHookRuntime({
        projectRoot: dir,
        sessionId: "s1",
        runId: "r1",
        interactive: true,
        profileId: "monitored-trusted-local",
        homeDir: dir, // ~/.keryx/hooks.json is dir/.keryx/hooks.json (the user doc above)
        configDir,
        // Explicitly NOT "off" — this IS the opt-in.
        env: { KERYX_HOOKS: "on" },
      });
      if (hooks === undefined) {
        throw new Error("buildShellHookRuntime unexpectedly returned undefined (KERYX_HOOKS must not be 'off' here)");
      }
      expect(hooks.runtime.registrations().some((r) => r.id === "real-deny-bash")).toBe(true);

      const { tool, ran } = fakeTool("shell_exec", "shell");
      // Flow 306 fix round 2 (finding H): `ran() === false` alone does not
      // distinguish the hook's real exit-2 deny from a CRASH-class failure
      // (e.g. this machine's sandbox launcher going unavailable mid-test) —
      // `runOneHook`'s fail-closed crash handling also denies a gate hook, so
      // either path leaves `ran()` false. Captured here so the assertion below
      // can pin WHICH one actually happened: the tool's own denied-call output
      // (`composeWithHook`'s `denyMessage`) carries the hook's real stderr
      // text only on the genuine exit-2 path.
      const toolResults: { name: string; output: string; isError: boolean }[] = [];
      const io: AgentIO = {
        write: () => {},
        permissionMode: () => "auto",
        onToolResult: (name, toolResult) => {
          toolResults.push({ name, output: toolResult.output, isError: toolResult.isError });
        },
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
      // The real spawned script exited 2 (gate deny) — the tool must never
      // have run.
      expect(ran()).toBe(false);
      // And the denial came from the hook's real exit 2 / stderr (the record
      // the runner actually parsed from the spawned process), not from a
      // crash/sandbox-unavailable failure denying the gate class closed —
      // both leave `ran()` false, but only the genuine exit-2 path produces
      // this exact stderr-derived reason.
      const shellResult = toolResults.find((r) => r.name === "shell_exec");
      expect(shellResult?.isError).toBe(true);
      expect(shellResult?.output).toContain("refused by hook real-deny-bash");
      expect(shellResult?.output).toContain("denied by real gate hook");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  20000,
);
