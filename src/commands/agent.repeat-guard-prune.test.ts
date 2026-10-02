// Flow 387 T24: pruning / collapse replaces an old tool result with "re-read the saved file". A
// model that does so repeats the SAME call; that repeat must not count against the
// per-signature attempt cap while the earlier result is no longer in context. Identical calls
// whose results ARE still visible stay capped (a genuine loop).

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runAgentTurn } from "./agent";
import type { AgentDeps, AgentIO } from "./agent";
import type { InteractiveTool } from "../harness/tool/builtin/interactive-tools";
import type { NormalizedEvent, NormalizedRequest, ProviderDescription } from "../harness/provider/types";
import type { SlateSessionRef } from "../session/slate-lifecycle";

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

const done: Script = [{ kind: "text_delta", text: "done" }, { kind: "model_end" }];

function callRound(id: string, name: string, input: string): Script {
  return [
    { kind: "tool_call_start", toolCallId: id, toolName: name },
    { kind: "tool_call_end", toolCallId: id, input },
    { kind: "model_end" },
  ];
}

/** ~12K estimated tokens per result and under the 50KB spill threshold, so it stays inline in history. */
const BIG = "x".repeat(48_000);

function tool(name: string, output: string): InteractiveTool {
  return {
    definition: {
      name,
      description: name,
      inputSchema: { type: "object", properties: {}, additionalProperties: true },
      risk: "read",
    },
    invoke: async () => ({ output, isError: false }),
  };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "keryx-t24-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function run(scripts: Script[], bigOutput: string, prune: boolean): Promise<string[]> {
  const { provider } = scriptedProvider(scripts);
  const results: string[] = [];
  const io: AgentIO = {
    write: () => {},
    onSystem: () => {},
    onToolResult: (_n, r) => results.push(r.output),
  };
  let n = 0;
  const deps: AgentDeps = {
    provider,
    providerId: "scripted",
    modelId: "m",
    tools: [tool("read_spill", bigOutput), tool("other", bigOutput)],
    systemInstruction: "sys",
    idSeq: () => `id-${n++}`,
  };
  const slateSession: SlateSessionRef = { dir, cwd: dir, opened: false };
  await runAgentTurn(io, deps, [], "go", prune ? { slateSession, pruneArchive: true } : {});
  return results;
}

const refused = (r: string): boolean => /already tried 3×/.test(r);

test("flow 387 T24: 4+ identical reads separated by a prune that cleared the earlier results are all allowed", async () => {
  // Five identical reads, each followed by six different calls: by the time of the next read
  // the previous read's result is outside the protected window and has been cleared or collapsed.
  const scripts: Script[] = [];
  let other = 0;
  for (let i = 1; i <= 5; i += 1) {
    scripts.push(callRound(`r${i}`, "read_spill", "{}"));
    if (i < 5) {
      for (let k = 0; k < 6; k += 1) {
        other += 1;
        scripts.push(callRound(`o${other}`, "other", JSON.stringify({ n: other })));
      }
    }
  }
  scripts.push(done);
  const results = await run(scripts, BIG, true);
  expect(results.some(refused)).toBe(false);
  expect(results.filter((r) => r.startsWith("x"))).toHaveLength(5 + 24);
});

test("flow 387 T24: 4 identical reads with no prune in between still hit the guard", async () => {
  const scripts: Script[] = [
    callRound("r1", "read_spill", "{}"),
    callRound("r2", "read_spill", "{}"),
    callRound("r3", "read_spill", "{}"),
    callRound("r4", "read_spill", "{}"),
    done,
  ];
  // Small output and no prune host: nothing is ever hidden.
  const results = await run(scripts, "small", false);
  expect(results.filter((r) => r === "small")).toHaveLength(3);
  expect(results.some(refused)).toBe(true);
});

test("flow 387 T24: back-to-back identical big reads whose result stays visible are still capped", async () => {
  // Pruning is on and the outputs are large, but each new result is the current batch (never
  // cleared), so the model can see the previous identical result: a genuine loop.
  const scripts: Script[] = [
    callRound("r1", "read_spill", "{}"),
    callRound("r2", "read_spill", "{}"),
    callRound("r3", "read_spill", "{}"),
    callRound("r4", "read_spill", "{}"),
    done,
  ];
  const results = await run(scripts, BIG, true);
  expect(results.some(refused)).toBe(true);
});
