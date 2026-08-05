// The unattended posture, driven through the real agent loop (flow 136).
//
// unattended.test.ts pins the policy decisions. This file pins what the DRIVER
// does with them: that a read-only run finishes with nobody asked, that a
// destructive command is refused and leaves the filesystem alone, that the
// supervised default still prompts, and that benchmark case A1 answers through
// `graph_affected` with no `shell_exec` of `keryx gdgraph`.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { runAgentTurn } from "./agent";
import type { AgentDeps, AgentIO, ApprovalMeta, ApprovalResponse } from "./agent";
import { computeAffected } from "../gdgraph/affected";
import type { GraphData } from "../gdgraph/types";
import { builtinReadOnlyTools } from "../harness/tool/builtin/interactive-tools";
import type { InteractiveTool } from "../harness/tool/builtin/interactive-tools";
import { createMetaprojectAdapter } from "../harness/tool/metaproject-adapter";
import { METAPROJECT_OPERATIONS, toInteractiveTools } from "../harness/tool/metaproject-operations";
import { createUnattendedApprover, type UnattendedPosture } from "../harness/policy/unattended";
import type {
  NormalizedEvent,
  NormalizedMessage,
  NormalizedRequest,
  ProviderDescription,
} from "../harness/provider/types";
import type { PolicyDeps } from "../harness/policy/types";

function policyDeps(): PolicyDeps {
  let n = 0;
  return { clock: () => "2026-08-05T00:00:00.000Z", idSeq: () => `pid-${++n}` };
}

/** A scripted provider: each `stream()` replays the next event list. */
function scriptedProvider(scripts: Partial<NormalizedEvent>[][]): {
  provider: AgentDeps["provider"];
  requests: NormalizedRequest[];
} {
  const requests: NormalizedRequest[] = [];
  let call = 0;
  const description: ProviderDescription = {
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
  return {
    requests,
    provider: {
      describe: () => description,
      stream: (request, opts) => {
        requests.push(request);
        const events = scripts[call] ?? [];
        call += 1;
        return (async function* (): AsyncGenerator<NormalizedEvent> {
          let sequence = 0;
          for (const partial of events) {
            yield {
              sequence: sequence++,
              attemptId: opts.attemptId,
              kind: "model_end",
              ...partial,
            } as NormalizedEvent;
          }
        })();
      },
    },
  };
}

/** Records every tool call, every tool result, and every approval request. */
function recordingIo(approver?: AgentIO["requestApproval"]): {
  io: AgentIO;
  toolPath: string[];
  results: Array<{ name: string; output: string; isError: boolean }>;
  approvalsAsked: Array<{ tool: string; meta?: ApprovalMeta }>;
} {
  const toolPath: string[] = [];
  const results: Array<{ name: string; output: string; isError: boolean }> = [];
  const approvalsAsked: Array<{ tool: string; meta?: ApprovalMeta }> = [];
  const io: AgentIO = {
    write: () => {},
    onToolCall: (name) => toolPath.push(name),
    onToolResult: (name, result) => results.push({ name, output: result.output, isError: result.isError }),
  };
  if (approver !== undefined) {
    io.requestApproval = async (tool, input, meta) => {
      approvalsAsked.push({ tool, ...(meta !== undefined ? { meta } : {}) });
      return approver(tool, input, meta);
    };
  }
  return { io, toolPath, results, approvalsAsked };
}

/** `shell_exec`-shaped tool that records whether it was ever actually run. */
function fakeShellExec(onRun: (command: string) => void): InteractiveTool {
  return {
    definition: {
      name: "shell_exec",
      description: "run a shell command",
      inputSchema: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
        additionalProperties: false,
      },
      risk: "shell",
    },
    invoke: async (input) => {
      const command = typeof input.command === "string" ? input.command : "";
      onRun(command);
      return { output: "ran", isError: false };
    },
  };
}

function unattendedIo(posture: UnattendedPosture): ReturnType<typeof recordingIo> {
  return recordingIo(createUnattendedApprover(posture, policyDeps()));
}

/** a ← b ← c, the transitive-dependent shape benchmark case A1 asks about. */
function chainGraph(): GraphData {
  const file = (p: string) => ({ id: p, kind: "file" as const, path: p, language: "typescript" as const });
  const edge = (from: string, to: string) => ({
    id: `${from}->${to}`,
    from,
    to,
    kind: "imports" as const,
    specifier: to,
  });
  return {
    nodes: [file("config.ts"), file("src/b.ts"), file("src/c.ts")],
    edges: [edge("src/b.ts", "config.ts"), edge("src/c.ts", "src/b.ts")],
  };
}

function graphTools(): InteractiveTool[] {
  const graph = chainGraph();
  const port = createMetaprojectAdapter("/fixture", {
    createGdgraphService: () =>
      ({
        affected: async (_cwd: string, target: string, options?: { depth?: number; ranked?: boolean }) =>
          computeAffected(graph, target, { depth: options?.depth ?? 1, ranked: options?.ranked ?? true }),
        loadGraph: async () => graph,
      }) as never,
  });
  return toInteractiveTools(METAPROJECT_OPERATIONS, port);
}

test("AC3: a run whose only tool calls are risk:read completes with no prompt and no operator input", async () => {
  const { provider } = scriptedProvider([
    [
      { kind: "tool_call_start", toolCallId: "c1", toolName: "get_cwd" },
      { kind: "tool_call_end", toolCallId: "c1", input: "{}" },
      { kind: "model_end" },
    ],
    [{ kind: "text_delta", text: "done" }, { kind: "model_end" }],
  ]);
  const { io, toolPath, results, approvalsAsked } = unattendedIo({ profile: "read-only-review" });
  const history: NormalizedMessage[] = [];

  await runAgentTurn(
    io,
    {
      provider,
      providerId: "scripted",
      modelId: "m",
      tools: builtinReadOnlyTools(tmpdir()),
      systemInstruction: "sys",
      idSeq: () => "id",
    },
    history,
    "where am I?",
  );

  expect(toolPath).toEqual(["get_cwd"]);
  expect(results[0]?.isError).toBe(false);
  // human_interventions: 0 — the approver was never reached, because a read tool
  // does not go through the approval gate at all.
  expect(approvalsAsked).toEqual([]);
});

test("AC4: a policy-denied action is refused with the flag set exactly as it is without it", async () => {
  const script: Partial<NormalizedEvent>[][] = [
    [
      { kind: "tool_call_start", toolCallId: "c1", toolName: "shell_exec" },
      { kind: "tool_call_end", toolCallId: "c1", input: JSON.stringify({ command: "echo hi" }) },
      { kind: "model_end" },
    ],
    [{ kind: "text_delta", text: "done" }, { kind: "model_end" }],
  ];

  // With the flag, under a profile whose `shell` default is a hard deny.
  let ranUnderFlag = "";
  const flagged = unattendedIo({ profile: "read-only-review" });
  await runAgentTurn(
    flagged.io,
    {
      provider: scriptedProvider(script).provider,
      providerId: "scripted",
      modelId: "m",
      tools: [fakeShellExec((c) => (ranUnderFlag = c))],
      systemInstruction: "sys",
      idSeq: () => "id",
    },
    [],
    "run it",
  );

  // Without the flag, with an approver that refuses (the default-deny gate).
  let ranWithout = "";
  const supervised = recordingIo(async () => false);
  await runAgentTurn(
    supervised.io,
    {
      provider: scriptedProvider(script).provider,
      providerId: "scripted",
      modelId: "m",
      tools: [fakeShellExec((c) => (ranWithout = c))],
      systemInstruction: "sys",
      idSeq: () => "id",
    },
    [],
    "run it",
  );

  expect(ranUnderFlag).toBe("");
  expect(ranWithout).toBe("");
  expect(flagged.results[0]?.isError).toBe(true);
  expect(supervised.results[0]?.isError).toBe(true);
});

test("AC5: an ask with no approver resolves to deny — the tool never runs", async () => {
  const { provider } = scriptedProvider([
    [
      { kind: "tool_call_start", toolCallId: "c1", toolName: "shell_exec" },
      { kind: "tool_call_end", toolCallId: "c1", input: JSON.stringify({ command: "echo hi" }) },
      { kind: "model_end" },
    ],
    [{ kind: "text_delta", text: "done" }, { kind: "model_end" }],
  ]);
  let ran = "";
  // `unattended-untrusted` defaults `shell` to `ask` — a human WOULD have been
  // asked here. There is nobody, so it fails closed.
  const { io, results } = unattendedIo({ profile: "unattended-untrusted" });
  await runAgentTurn(
    io,
    {
      provider,
      providerId: "scripted",
      modelId: "m",
      tools: [fakeShellExec((c) => (ran = c))],
      systemInstruction: "sys",
      idSeq: () => "id",
    },
    [],
    "run it",
  );

  expect(ran).toBe("");
  expect(results[0]?.isError).toBe(true);
  expect(results[0]?.output).toContain("--unattended=unattended-untrusted");
});

test("AC6: a destructive-class tool is refused under a shell-allowing profile and deletes nothing", async () => {
  const work = mkdtempSync(path.join(tmpdir(), "keryx-unattended-"));
  const victim = path.join(work, "graph-index.json");
  mkdirSync(path.join(work, "nested"), { recursive: true });
  writeFileSync(victim, '{"nodes":[]}', "utf8");
  try {
    // A tool that REALLY deletes when it runs — confined to the fixture, so the
    // "no filesystem change" assertion observes a refusal rather than a mock.
    // This is benchmark case C1 in miniature: the graph index the run was about
    // to remove.
    let invoked = false;
    const deleteIndex: InteractiveTool = {
      definition: {
        name: "delete_graph_index",
        description: "delete the project's graph index",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        risk: "destructive",
      },
      invoke: async () => {
        invoked = true;
        rmSync(victim, { force: true });
        return { output: "deleted", isError: false };
      },
    };
    const { provider } = scriptedProvider([
      [
        { kind: "tool_call_start", toolCallId: "c1", toolName: "delete_graph_index" },
        { kind: "tool_call_end", toolCallId: "c1", input: "{}" },
        { kind: "model_end" },
      ],
      [{ kind: "text_delta", text: "done" }, { kind: "model_end" }],
    ]);
    // `monitored-trusted-local` defaults `shell` to ALLOW. The refusal therefore
    // has to come from the destructive class, not from the profile happening to
    // be restrictive — which is the distinction AC6 is written to catch.
    const { io, results, approvalsAsked } = unattendedIo({ profile: "monitored-trusted-local" });
    await runAgentTurn(
      io,
      {
        provider,
        providerId: "scripted",
        modelId: "m",
        tools: [deleteIndex],
        systemInstruction: "sys",
        idSeq: () => "id",
      },
      [],
      "clean up",
    );

    expect(approvalsAsked[0]?.meta?.destructive).toBe(true);
    expect(invoked).toBe(false);
    expect(results[0]?.isError).toBe(true);
    // The filesystem is untouched.
    expect(existsSync(victim)).toBe(true);
    expect(existsSync(work)).toBe(true);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("AC6: a shell_exec whose COMMAND reads as destructive is refused too", async () => {
  // Same posture, same shell-allowing profile — the escalation this time comes
  // from the per-command classifier rather than the tool's static risk. The
  // command text is never executed (the tool is a fake), so the catastrophic
  // target is safe to name and is what makes the classifier fire.
  const { provider } = scriptedProvider([
    [
      { kind: "tool_call_start", toolCallId: "c1", toolName: "shell_exec" },
      { kind: "tool_call_end", toolCallId: "c1", input: JSON.stringify({ command: "rm -rf ~/" }) },
      { kind: "model_end" },
    ],
    [{ kind: "text_delta", text: "done" }, { kind: "model_end" }],
  ]);
  let ran = "";
  const { io, results, approvalsAsked } = unattendedIo({ profile: "monitored-trusted-local" });
  await runAgentTurn(
    io,
    {
      provider,
      providerId: "scripted",
      modelId: "m",
      tools: [fakeShellExec((c) => (ran = c))],
      systemInstruction: "sys",
      idSeq: () => "id",
    },
    [],
    "clean up",
  );

  expect(approvalsAsked[0]?.meta?.destructive).toBe(true);
  expect(ran).toBe("");
  expect(results[0]?.isError).toBe(true);

  // Control: the SAME profile and the SAME posture DO run a non-destructive
  // command, so the refusal above is the destructive class and not the posture
  // refusing everything (which would pass AC6 while defeating AC3).
  const benign = scriptedProvider([
    [
      { kind: "tool_call_start", toolCallId: "c2", toolName: "shell_exec" },
      { kind: "tool_call_end", toolCallId: "c2", input: JSON.stringify({ command: "echo hi" }) },
      { kind: "model_end" },
    ],
    [{ kind: "text_delta", text: "done" }, { kind: "model_end" }],
  ]);
  let benignRan = "";
  const second = unattendedIo({ profile: "monitored-trusted-local" });
  await runAgentTurn(
    second.io,
    {
      provider: benign.provider,
      providerId: "scripted",
      modelId: "m",
      tools: [fakeShellExec((c) => (benignRan = c))],
      systemInstruction: "sys",
      idSeq: () => "id",
    },
    [],
    "say hi",
  );
  expect(benignRan).toBe("echo hi");
});

test("AC7: with no flag an ask still prompts, and the default posture is unchanged", async () => {
  const { provider } = scriptedProvider([
    [
      { kind: "tool_call_start", toolCallId: "c1", toolName: "shell_exec" },
      { kind: "tool_call_end", toolCallId: "c1", input: JSON.stringify({ command: "echo hi" }) },
      { kind: "model_end" },
    ],
    [{ kind: "text_delta", text: "done" }, { kind: "model_end" }],
  ]);
  const asked: ApprovalMeta[] = [];
  let ran = "";
  const io: AgentIO = {
    write: () => {},
    requestApproval: async (_tool, _input, meta): Promise<ApprovalResponse> => {
      if (meta !== undefined) {
        asked.push(meta);
      }
      return true;
    },
  };
  await runAgentTurn(
    io,
    {
      provider,
      providerId: "scripted",
      modelId: "m",
      tools: [fakeShellExec((c) => (ran = c))],
      systemInstruction: "sys",
      idSeq: () => "id",
    },
    [],
    "run it",
  );

  // The supervised path still ASKS — the flag did not loosen the default to make
  // itself look good — and a human "yes" still executes.
  expect(asked.length).toBe(1);
  expect(asked[0]?.destructive).toBe(false);
  expect(ran).toBe("echo hi");
});

test("AC7: with no flag and no approver the gate is still default-deny", async () => {
  const { provider } = scriptedProvider([
    [
      { kind: "tool_call_start", toolCallId: "c1", toolName: "shell_exec" },
      { kind: "tool_call_end", toolCallId: "c1", input: JSON.stringify({ command: "echo hi" }) },
      { kind: "model_end" },
    ],
    [{ kind: "text_delta", text: "done" }, { kind: "model_end" }],
  ]);
  let ran = "";
  const { io, results } = recordingIo();
  await runAgentTurn(
    io,
    {
      provider,
      providerId: "scripted",
      modelId: "m",
      tools: [fakeShellExec((c) => (ran = c))],
      systemInstruction: "sys",
      idSeq: () => "id",
    },
    [],
    "run it",
  );
  expect(ran).toBe("");
  // The historical wording, unchanged: a supervised refusal must not start
  // reporting an unattended reason.
  expect(results[0]?.output).toBe("command not approved by the user; not executed");
});

test("AC11: benchmark A1 answers through graph_affected under the flag, with no shell_exec", async () => {
  let shellRan = "";
  const tools = [...graphTools(), fakeShellExec((c) => (shellRan = c))];
  const { provider } = scriptedProvider([
    [
      { kind: "tool_call_start", toolCallId: "c1", toolName: "graph_affected" },
      {
        kind: "tool_call_end",
        toolCallId: "c1",
        input: JSON.stringify({ file: "config.ts", depth: 2, ranked: true }),
      },
      { kind: "model_end" },
    ],
    [
      { kind: "text_delta", text: "config.ts affects src/b.ts (hop 1) and src/c.ts (hop 2)." },
      { kind: "model_end" },
    ],
  ]);
  const { io, toolPath, results, approvalsAsked } = unattendedIo({ profile: "read-only-review" });
  const history: NormalizedMessage[] = [];

  await runAgentTurn(
    io,
    {
      provider,
      providerId: "scripted",
      modelId: "m",
      tools,
      systemInstruction: "sys",
      idSeq: () => "id",
    },
    history,
    "what depends on config.ts, directly and transitively?",
  );

  // human_interventions: 0.
  expect(approvalsAsked).toEqual([]);
  // The tool path contains graph_affected and no shell_exec at all — so in
  // particular no `shell_exec` invoking `keryx gdgraph`.
  expect(toolPath).toContain("graph_affected");
  expect(toolPath).not.toContain("shell_exec");
  expect(shellRan).toBe("");
  // And the answer is the correct transitive set, not just the direct one.
  const output = results[0]?.output ?? "";
  expect(results[0]?.isError).toBe(false);
  expect(output).toContain("src/b.ts");
  expect(output).toContain("src/c.ts");
  expect(history.some((m) => m.role === "tool" && m.content.includes("src/c.ts"))).toBe(true);
});
