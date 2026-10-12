// Flow 387 T6 (AC2): a provider context-overflow rejection compacts ONCE and
// retries the same round ONCE; a second overflow ends the turn with a visible
// error instead of looping. Driven through `runAgentTurn` with a fake provider.

import { expect, test } from "bun:test";
import { runAgentTurn } from "./agent";
import type { AgentDeps, AgentIO } from "./agent";
import type { NormalizedEvent, NormalizedMessage, NormalizedRequest, ProviderDescription } from "../harness/provider/types";

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
        const events = scripts[requests.length] ?? [];
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

function deps(provider: AgentDeps["provider"], extra: Partial<AgentDeps> = {}): AgentDeps {
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

/** Five user/assistant turns — more than `keepLastUserTurns: 3`, so compaction is not a noop. */
function longHistory(): NormalizedMessage[] {
  const out: NormalizedMessage[] = [];
  for (let i = 0; i < 5; i += 1) {
    out.push({ role: "user", content: `question ${i}`, provenance: "trusted", ts: "t" });
    out.push({ role: "assistant", content: `answer ${i}`, provenance: "model", ts: "t" });
  }
  return out;
}

const overflow = (message: string, kind = "context_overflow"): Script => [
  { kind: "provider_error", error: { kind, retryable: false, message } as never },
];
const okReply: Script = [{ kind: "text_delta", text: "done" }, { kind: "model_end" }];

test("overflow: compacts once, retries the same round, and the retry succeeds", async () => {
  const { provider, requests } = scriptedProvider([overflow("prompt too long"), okReply]);
  const { io, system } = collectingIo();
  const compactions: number[] = [];
  const history = longHistory();

  await runAgentTurn(io, deps(provider, { onContextCompaction: (r) => compactions.push(r.removed) }), history, "next");

  expect(requests).toHaveLength(2);
  expect(compactions).toHaveLength(1);
  // The retry carried the shrunk history, not the original one.
  expect(requests[1]!.messages.length).toBeLessThan(requests[0]!.messages.length);
  expect(system.join("")).not.toContain("[error]");
  expect(history.at(-1)?.content).toBe("done");
});

test("overflow: the Codex bare-400 shape (message only, kind invalid_request) is recovered too", async () => {
  const { provider, requests } = scriptedProvider([
    overflow("you requested 0 output tokens and your prompt contains at least 200001 input tokens", "invalid_request"),
    okReply,
  ]);
  const { io } = collectingIo();

  await runAgentTurn(io, deps(provider), longHistory(), "next");

  expect(requests).toHaveLength(2);
});

test("overflow: a second overflow on the retry ends the turn with a visible error — never a loop", async () => {
  const { provider, requests } = scriptedProvider([overflow("too long"), overflow("still too long"), okReply]);
  const { io, system } = collectingIo();
  const compactions: number[] = [];

  await runAgentTurn(io, deps(provider, { onContextCompaction: (r) => compactions.push(r.removed) }), longHistory(), "next");

  expect(requests).toHaveLength(2); // original + exactly one retry
  expect(compactions).toHaveLength(1);
  const errorLine = system.find((s) => s.includes("still too long"));
  expect(errorLine).toBeDefined();
  expect(errorLine).toContain("[error]");
});

test("overflow: a noop compaction surfaces the error immediately without a retry", async () => {
  const { provider, requests } = scriptedProvider([overflow("too long"), okReply]);
  const { io, system } = collectingIo();

  await runAgentTurn(io, deps(provider), [], "hi");

  expect(requests).toHaveLength(1);
  expect(system.find((s) => s.includes("too long"))).toContain("[error]");
});

test("a non-overflow provider error is never retried", async () => {
  const { provider, requests } = scriptedProvider([overflow("slow down", "rate_limit"), okReply]);
  const { io } = collectingIo();

  await runAgentTurn(io, deps(provider), longHistory(), "next");

  expect(requests).toHaveLength(1);
});
