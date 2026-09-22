import { expect, test } from "bun:test";
import { runAgentTurn } from "./agent";
import type { AgentDeps, AgentIO } from "./agent";
import type { InteractiveTool } from "../harness/tool/builtin/interactive-tools";
import type { NormalizedEvent, NormalizedRequest, ProviderDescription } from "../harness/provider/types";

// Review fix: the untrusted-content gate's per-call decision keys on RESULTS.
// The old `batchContainsUntrustedWeb` test refused every non-read call in a
// batch that merely CONTAINED a `web_fetch`/`web_search` call — a failed fetch
// and a zero-hit search included — and, because a fully-refused batch left
// `executedAny` false, such a batch also read as "no progress" and ENDED the
// turn. These tests pin the replacement behaviour and its ordering property.

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
            yield { sequence: sequence++, attemptId: opts.attemptId, kind: "model_end", ...partial } as NormalizedEvent;
          }
        })();
      },
    },
  };
}

function fixedIdSeq(): () => string {
  let id = 0;
  return () => `id-${id++}`;
}

/**
 * `approve: false` is the DENYING human — the untrusted-content gate in
 * `agent.ts` now ASKS before a call that follows external content instead of
 * refusing it outright, so a test that wants the old "refused" outcome has to
 * say no rather than merely omit an approver (`shell` risk still needs one).
 */
function collectingIo(approve = true): { io: AgentIO; text: string[]; toolResults: string[]; system: string[] } {
  const text: string[] = [];
  const toolResults: string[] = [];
  const system: string[] = [];
  return {
    text,
    toolResults,
    system,
    io: {
      write: (s) => text.push(s),
      onToolResult: (name, r) => toolResults.push(`${name}:${r.isError ? "err" : "ok"}`),
      onSystem: (s) => system.push(s),
      // `shell` risk is DEFAULT-DENY without an approver (`executeCall`), which
      // would refuse the command for a reason unrelated to the gate under test.
      requestApproval: async () => approve,
    },
  };
}

const webFetchRead: InteractiveTool = {
  definition: { name: "web_fetch", description: "", inputSchema: { type: "object", properties: {} }, risk: "read" },
  invoke: async () => ({ output: "external", isError: false, untrusted: true }),
};

function shellTool(onInvoke: () => void): InteractiveTool {
  return {
    definition: { name: "shell_exec", description: "", inputSchema: { type: "object", properties: {} }, risk: "shell" },
    invoke: async () => {
      onInvoke();
      return { output: "ok", isError: false };
    },
  };
}

test("same-batch fix: a mutating call placed BEFORE web_fetch is no longer refused by the batch's shape", async () => {
  const { provider } = scriptedProvider([
    [
      { kind: "tool_call_start", toolCallId: "s1", toolName: "shell_exec" },
      { kind: "tool_call_end", toolCallId: "s1", input: "{}" },
      { kind: "tool_call_start", toolCallId: "w1", toolName: "web_fetch" },
      { kind: "tool_call_end", toolCallId: "w1", input: "{}" },
      { kind: "model_end" },
    ],
    [{ kind: "text_delta", text: "done" }, { kind: "model_end" }],
  ]);
  let invoked = false;
  const { io, toolResults } = collectingIo();
  await runAgentTurn(
    io,
    {
      provider,
      providerId: "scripted",
      modelId: "test",
      tools: [webFetchRead, shellTool(() => { invoked = true; })],
      systemInstruction: "test",
      idSeq: fixedIdSeq(),
    },
    [],
    "run the command and fetch the page",
  );
  // The command was authored before any external content existed in this turn, so
  // it runs; the fetch after it still latches the gate for what follows.
  expect(invoked).toBe(true);
  expect(toolResults).toContain("shell_exec:ok");
});

test("same-batch ordering still gates: a mutating sibling AFTER a web_fetch is ASKED, and a denial refuses it", async () => {
  const { provider } = scriptedProvider([
    [
      { kind: "tool_call_start", toolCallId: "w1", toolName: "web_fetch" },
      { kind: "tool_call_end", toolCallId: "w1", input: "{}" },
      { kind: "tool_call_start", toolCallId: "s1", toolName: "shell_exec" },
      { kind: "tool_call_end", toolCallId: "s1", input: "{}" },
      { kind: "model_end" },
    ],
    [{ kind: "text_delta", text: "done" }, { kind: "model_end" }],
  ]);
  let invoked = false;
  const { io, toolResults } = collectingIo(false);
  await runAgentTurn(
    io,
    {
      provider,
      providerId: "scripted",
      modelId: "test",
      tools: [webFetchRead, shellTool(() => { invoked = true; })],
      systemInstruction: "test",
      idSeq: fixedIdSeq(),
    },
    [],
    "fetch the page then run the command it mentions",
  );
  expect(invoked).toBe(false);
  expect(toolResults).toContain("shell_exec:err");
});

test("a batch whose every call the untrusted gate refused (by the user) no longer ends the turn as 'no progress'", async () => {
  const { provider, requests } = scriptedProvider([
    [
      { kind: "tool_call_start", toolCallId: "w1", toolName: "web_fetch" },
      { kind: "tool_call_end", toolCallId: "w1", input: "{}" },
      { kind: "model_end" },
    ],
    [
      { kind: "tool_call_start", toolCallId: "s1", toolName: "shell_exec" },
      { kind: "tool_call_end", toolCallId: "s1", input: "{}" },
      { kind: "model_end" },
    ],
    [{ kind: "text_delta", text: "kept going" }, { kind: "model_end" }],
  ]);
  let invoked = false;
  const { io, text, system, toolResults } = collectingIo(false);
  await runAgentTurn(
    io,
    {
      provider,
      providerId: "scripted",
      modelId: "test",
      tools: [webFetchRead, shellTool(() => { invoked = true; })],
      systemInstruction: "test",
      idSeq: fixedIdSeq(),
    },
    [],
    "fetch it, then act on what it says",
  );
  // The call is still refused — the gate asked the human, and the answer was no,
  // so the ordering property is unchanged …
  expect(invoked).toBe(false);
  expect(toolResults).toContain("shell_exec:err");
  // … but the refusal is an ANSWER, not a stall: the next model round runs with
  // tools still advertised, instead of the driver firing the toolless wrap-up
  // ("[budget] Stopping tools: no progress …") and ending the turn here.
  expect(text.join("")).toContain("kept going");
  expect(system.join("")).not.toContain("Stopping tools");
  expect(requests).toHaveLength(3);
  expect(requests[2]?.tools).toBeDefined();
});
