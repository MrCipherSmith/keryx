// Flow 387 review r1: host-gated pruning (F-001), session dir without an open slate
// (F-007), a stable prompt-cache key for every host (F-009, F-020) and an overflow
// retry that does not trust the estimator that just under-measured (F-006).

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { builtinReadOnlyTools } from "../harness/tool/builtin/interactive-tools";
import { runAgentTurn } from "./agent";
import type { AgentDeps, AgentIO } from "./agent";
import type { NormalizedEvent, NormalizedMessage, NormalizedRequest, ProviderDescription } from "../harness/provider/types";
import { detachSlateSession, type SlateSessionRef } from "../session/slate-lifecycle";

type Script = Partial<NormalizedEvent>[];

function scriptedProvider(scripts: Script[]): { provider: AgentDeps["provider"]; requests: NormalizedRequest[] } {
  const requests: NormalizedRequest[] = [];
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
        const events = scripts[requests.length] ?? scripts[scripts.length - 1] ?? [];
        requests.push(request);
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

function collectingIo(): { io: AgentIO; system: string[] } {
  const system: string[] = [];
  return { system, io: { write: () => {}, onSystem: (s) => system.push(s) } };
}

function makeDeps(provider: AgentDeps["provider"], extra: Partial<AgentDeps> = {}): AgentDeps {
  let n = 0;
  return {
    provider,
    providerId: "scripted",
    modelId: "m",
    tools: [],
    systemInstruction: "sys",
    idSeq: () => `id-${n++}`,
    ...extra,
  };
}

const okReply: Script = [{ kind: "text_delta", text: "done" }, { kind: "model_end" }];

const BIG = 80_000;

/** Ten old tool exchanges of ~20K tokens each: far past the protected window and the minimum saving. */
function heavyHistory(): NormalizedMessage[] {
  const out: NormalizedMessage[] = [{ role: "user", content: "start", provenance: "trusted", ts: "t" }];
  for (let i = 0; i < 10; i += 1) {
    out.push({
      role: "assistant",
      content: "",
      provenance: "model",
      ts: "t",
      toolCalls: [{ id: `c${i}`, name: "read_file", arguments: JSON.stringify({ path: `f${i}.ts` }) }],
    });
    out.push({ role: "tool", content: `${i}`.repeat(BIG), provenance: "tool", ts: "t", toolCallId: `c${i}` });
  }
  return out;
}

function totalChars(history: readonly NormalizedMessage[], first = history.length): number {
  return history.slice(0, first).reduce((sum, m) => sum + m.content.length, 0);
}

function longHistory(): NormalizedMessage[] {
  const out: NormalizedMessage[] = [];
  for (let i = 0; i < 5; i += 1) {
    out.push({ role: "user", content: `question ${i}`, provenance: "trusted", ts: "t" });
    out.push({ role: "assistant", content: `answer ${i}`, provenance: "model", ts: "t" });
  }
  return out;
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "keryx-review-r1-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// --- F-001 / F-007: pruning only where the host keeps the originals ---------------

test("F-001 shell-class host (pruneArchive + live dir, slate NOT open): old tool output is pruned (also F-007)", async () => {
  const { provider } = scriptedProvider([okReply]);
  const history = heavyHistory();
  const before = totalChars(history);
  const slateSession: SlateSessionRef = { dir, cwd: dir, opened: false };

  await runAgentTurn(collectingIo().io, makeDeps(provider), history, "go", { slateSession, pruneArchive: true });

  expect(totalChars(history)).toBeLessThan(before / 2);
});

test("F-001 ACP-like host (a live dir but no pruneArchive): history is left byte-identical, like main", async () => {
  const { provider } = scriptedProvider([okReply]);
  const history = heavyHistory();
  const snapshot = history.map((m) => m.content);
  const slateSession: SlateSessionRef = { dir, cwd: dir, opened: true };
  const { io, system } = collectingIo();

  await runAgentTurn(io, makeDeps(provider), history, "go", { slateSession });

  expect(history.slice(0, snapshot.length).map((m) => m.content)).toEqual(snapshot);
  expect(system.join("")).not.toContain("[prune]");
});

test("F-001 subagent/trigger/side-worker-class host (no options at all): never prunes", async () => {
  const { provider } = scriptedProvider([okReply]);
  const history = heavyHistory();
  const original = history.length;
  const before = totalChars(history);

  await runAgentTurn(collectingIo().io, makeDeps(provider), history, "go");

  expect(totalChars(history, original)).toBe(before);
});

test("F-001 pruneArchive without a session dir cannot prune (nowhere to put the originals)", async () => {
  const { provider } = scriptedProvider([okReply]);
  const history = heavyHistory();
  const original = history.length;
  const before = totalChars(history);

  await runAgentTurn(collectingIo().io, makeDeps(provider), history, "go", { pruneArchive: true });

  expect(totalChars(history, original)).toBe(before);
});

test("F-007 a detached (lease-lost) shell never prunes or writes into the dir it no longer holds", async () => {
  const { provider } = scriptedProvider([okReply]);
  const history = heavyHistory();
  const original = history.length;
  const before = totalChars(history);
  const slateSession: SlateSessionRef = { dir, cwd: dir, opened: true };
  detachSlateSession(slateSession);

  await runAgentTurn(collectingIo().io, makeDeps(provider), history, "go", { slateSession, pruneArchive: true });

  expect(totalChars(history, original)).toBe(before);
});

// --- F-020 / F-009: prompt-cache key for every host --------------------------------

test("F-020 a run without a slate session sends one stable promptCacheKey on every request; a second run gets another", async () => {
  const toolRound: Script = [
    { kind: "tool_call_start", toolCallId: "c1", toolName: "get_cwd" },
    { kind: "tool_call_end", toolCallId: "c1", input: "{}" },
    { kind: "model_end" },
  ];
  const first = scriptedProvider([toolRound, okReply]);
  const firstHistory: NormalizedMessage[] = [];
  const deps = makeDeps(first.provider, { tools: builtinReadOnlyTools(tmpdir()) });

  await runAgentTurn(collectingIo().io, deps, firstHistory, "one");
  await runAgentTurn(collectingIo().io, deps, firstHistory, "two");

  const keys = first.requests.map((r) => r.promptCacheKey);
  expect(first.requests.length).toBeGreaterThanOrEqual(3);
  expect(keys[0]).toBeDefined();
  expect(new Set(keys).size).toBe(1);

  const second = scriptedProvider([okReply]);
  await runAgentTurn(collectingIo().io, makeDeps(second.provider), [], "other run");
  expect(second.requests[0]?.promptCacheKey).toBeDefined();
  expect(second.requests[0]?.promptCacheKey).not.toBe(keys[0]);
});

test("F-020 a slate session id wins over an explicit cacheKey, which wins over the minted one", async () => {
  const { provider, requests } = scriptedProvider([okReply]);
  const slateSession: SlateSessionRef = { dir: path.join(dir, "session-abc"), cwd: dir, opened: false };
  await runAgentTurn(collectingIo().io, makeDeps(provider), [], "a", { slateSession, cacheKey: "explicit" });
  await runAgentTurn(collectingIo().io, makeDeps(provider), [], "b", { cacheKey: "explicit" });
  expect(requests[0]?.promptCacheKey).toBe("session-abc");
  expect(requests[1]?.promptCacheKey).toBe("explicit");
});

test("F-009 the budget wrap-up request carries the same promptCacheKey as the rounds before it", async () => {
  const toolRound: Script = [
    { kind: "tool_call_start", toolCallId: "c1", toolName: "get_cwd" },
    { kind: "tool_call_end", toolCallId: "c1", input: "{}" },
    { kind: "model_end" },
  ];
  const { provider, requests } = scriptedProvider([
    toolRound,
    toolRound,
    toolRound,
    toolRound,
    [{ kind: "text_delta", text: "wrap-up" }, { kind: "model_end" }],
  ]);
  const deps = makeDeps(provider, { tools: builtinReadOnlyTools(tmpdir()) });

  await runAgentTurn(collectingIo().io, deps, [], "loop forever", { cacheKey: "k-1" });

  const wrapUp = requests[requests.length - 1];
  expect(wrapUp?.tools).toBeUndefined();
  expect(wrapUp?.promptCacheKey).toBe("k-1");
  expect(requests.every((r) => r.promptCacheKey === "k-1")).toBe(true);
});

// --- F-006: overflow retry picks the cut from the failure, not the estimator -------

const overflow = (message: string): Script => [
  { kind: "provider_error", error: { kind: "context_overflow", retryable: false, message } as never },
];

test("F-006 unknown window and no stated limit: the retry takes the strongest cut, not the weakest", async () => {
  const { provider, requests } = scriptedProvider([overflow("prompt too long"), okReply]);

  await runAgentTurn(collectingIo().io, makeDeps(provider), longHistory(), "next");

  expect(requests).toHaveLength(2);
  const retry = requests[1]!.messages.map((m) => m.content);
  expect(retry.join("\n")).toContain("next");
  // keepLastUserTurns: 3 (the weak cut) would still carry these turns verbatim.
  expect(retry).not.toContain("question 3");
  expect(retry).not.toContain("answer 3");
});

test("F-006 a stated limit that the weak cut already fits under keeps the weak cut", async () => {
  const { provider, requests } = scriptedProvider([
    overflow("This model's maximum context length is 100000 tokens."),
    okReply,
  ]);

  await runAgentTurn(collectingIo().io, makeDeps(provider), longHistory(), "next");

  expect(requests).toHaveLength(2);
  expect(requests[1]!.messages.map((m) => m.content)).toContain("question 3");
});
