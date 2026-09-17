// Flow 267: the round loop's automatic context guard.
//
// Proves the guard end-to-end through `runAgentTurn` (not just the pure
// `context-guard.ts` helpers, covered in their own test file): with a known
// `contextWindow`, a history that has crossed 85% of it gets compacted IN
// PLACE (array identity preserved — AC3) before the next provider request,
// and the request actually sent is measurably smaller (AC1). With
// `contextWindow` omitted, the guard never fires (AC2).

import { expect, test } from "bun:test";
import { runAgentTurn } from "./agent";
import type { AgentDeps, AgentIO } from "./agent";
import type { NormalizedEvent, NormalizedMessage, NormalizedRequest, ProviderDescription } from "../harness/provider/types";

// Same minimal scripted ProviderPort helper `agent.test.ts` uses: each
// `stream()` call replays the next scripted event list and records the
// request it received. Duplicated here (it is not exported) rather than
// reused via `FakeProvider`, whose transcript selection hashes the WHOLE
// request — impractical for a test that deliberately grows `history` across
// rounds to cross a token threshold.
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

let idCounter = 0;
function fixedIdSeq(): () => string {
  idCounter = 0;
  return () => `id-${idCounter++}`;
}

function collectingIo(): { io: AgentIO; system: string[] } {
  const system: string[] = [];
  return { system, io: { write: () => {}, onSystem: (s) => system.push(s) } };
}

/** A large fake prior turn (user + assistant), so the seeded history has
 * several `role: "user"` boundaries for `compactMessages` to cut at. */
function bigTurn(n: number): NormalizedMessage[] {
  return [
    { role: "user", content: `old question ${n} `.repeat(60), provenance: "project" },
    { role: "assistant", content: `old answer ${n} `.repeat(60), provenance: "model" },
  ];
}

test("AC1/AC3: compacts history in place before the round's request once the estimate crosses 85% of a known window", async () => {
  const { provider, requests } = scriptedProvider([
    [{ kind: "text_delta", text: "ok" }, { kind: "model_end" }],
  ]);
  const seeded: NormalizedMessage[] = [1, 2, 3, 4, 5].flatMap(bigTurn);
  const history: NormalizedMessage[] = [...seeded];
  const historyRef = history;
  const compactionCalls: { removed: number; context: NormalizedMessage[]; estimate: number }[] = [];
  // Snapshot of `historyRef.length` taken INSIDE the callback, i.e. at the
  // instant the guard fires — proves the splice already landed on the SAME
  // array object the test is holding (`historyRef`), not a reassigned new
  // one the caller would never see. A reassignment bug (`history =
  // compacted.context` instead of `history.splice(...)`) would leave
  // `historyRef` completely untouched here, and this snapshot would still
  // show the ORIGINAL, uncompacted length.
  let historyLengthWhenCallbackFired: number | undefined;
  const { io } = collectingIo();
  const deps: AgentDeps = {
    provider,
    providerId: "scripted",
    modelId: "m",
    tools: [],
    systemInstruction: "sys",
    idSeq: fixedIdSeq(),
    contextWindow: 200,
    onContextCompaction: (r) => {
      compactionCalls.push(r);
      historyLengthWhenCallbackFired = historyRef.length;
    },
  };

  await runAgentTurn(io, deps, history, "new question");

  expect(requests.length).toBe(1);
  expect(compactionCalls.length).toBe(1);
  // AC3: `history` never got reassigned to a new array — same reference
  // throughout the whole call.
  expect(history).toBe(historyRef);
  expect(historyLengthWhenCallbackFired).toBe(compactionCalls[0]!.context.length);
  expect(compactionCalls[0]!.removed).toBeGreaterThan(0);

  // The request actually sent is measurably smaller than an uncompacted
  // request (full seed history + the new turn) would have been.
  const uncompactedChars = JSON.stringify([...seeded, { role: "user", content: "new question" }]).length;
  const actualChars = JSON.stringify(requests[0]!.messages).length;
  expect(actualChars).toBeLessThan(uncompactedChars);
  // The new turn's own user message survives the cut (compaction always
  // keeps the last N user turns intact).
  expect(requests[0]!.messages.some((m) => m.content === "new question")).toBe(true);
});

test("AC2: contextWindow undefined never compacts — request is byte-identical to the uncompacted history", async () => {
  const { provider, requests } = scriptedProvider([
    [{ kind: "text_delta", text: "ok" }, { kind: "model_end" }],
  ]);
  const seeded: NormalizedMessage[] = [1, 2, 3, 4, 5].flatMap(bigTurn);
  const history: NormalizedMessage[] = [...seeded];
  const compactionCalls: unknown[] = [];
  const { io } = collectingIo();
  const deps: AgentDeps = {
    provider,
    providerId: "scripted",
    modelId: "m",
    tools: [],
    systemInstruction: "sys",
    idSeq: fixedIdSeq(),
    // contextWindow intentionally omitted.
    onContextCompaction: (r) => compactionCalls.push(r),
  };

  await runAgentTurn(io, deps, history, "new question");

  expect(compactionCalls.length).toBe(0);
  expect(requests[0]!.messages.length).toBe(seeded.length + 1);
  expect(requests[0]!.messages.some((m) => m.content.includes("[Compacted"))).toBe(false);
  expect(requests[0]!.messages[requests[0]!.messages.length - 1]?.content).toBe("new question");
});

test("a tool-call round that inflates history past the threshold compacts before the SECOND request", async () => {
  const bigInput = JSON.stringify({ data: "x".repeat(2000) });
  const { provider, requests } = scriptedProvider([
    [
      { kind: "tool_call_start", toolCallId: "c1", toolName: "noop" },
      { kind: "tool_call_end", toolCallId: "c1", input: bigInput },
      { kind: "model_end" },
    ],
    [{ kind: "text_delta", text: "done" }, { kind: "model_end" }],
  ]);
  const seeded: NormalizedMessage[] = [1, 2, 3, 4].flatMap(bigTurn);
  const history: NormalizedMessage[] = [...seeded];
  const compactionCalls: { removed: number; context: NormalizedMessage[]; estimate: number }[] = [];
  const { io } = collectingIo();
  const deps: AgentDeps = {
    provider,
    providerId: "scripted",
    modelId: "m",
    tools: [
      {
        definition: { name: "noop", description: "", inputSchema: { type: "object", properties: {} }, risk: "read" },
        invoke: async () => ({ output: "ok", isError: false }),
      },
    ],
    systemInstruction: "sys",
    idSeq: fixedIdSeq(),
    contextWindow: 300,
    onContextCompaction: (r) => compactionCalls.push(r),
  };

  await runAgentTurn(io, deps, history, "new question");

  expect(requests.length).toBe(2);
  expect(compactionCalls.length).toBeGreaterThanOrEqual(1);
  // The second request (built after the guard ran) is smaller than the first.
  expect(JSON.stringify(requests[1]!.messages).length).toBeLessThan(
    JSON.stringify(requests[0]!.messages).length + bigInput.length,
  );
});
