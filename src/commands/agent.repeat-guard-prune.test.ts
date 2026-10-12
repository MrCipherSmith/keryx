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
import { callRound, okReply as done, scriptedProvider, type Script } from "./agent.test-helpers";
import type { InteractiveTool } from "../harness/tool/builtin/interactive-tools";
import type { SlateSessionRef } from "../session/slate-lifecycle";

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
    onContextCompaction: () => {},
  };
  const slateSession: SlateSessionRef = { dir, cwd: dir, opened: false };
  await runAgentTurn(io, deps, [], "go", prune ? { slateSession, pruneArchive: true } : {});
  return results;
}

const refused = (r: string): boolean => /already tried 3×/.test(r);

test("flow 387 T24: a re-read after a prune cleared the earlier result is allowed (and never counted twice)", async () => {
  // Flow 387 review r3 F-033: following a placeholder to the saved file is forgiven once per
  // signature per turn (the cycle test below pins the bound), so the second read here is
  // allowed even though the first result is outside the protected window and has been cleared.
  const scripts: Script[] = [];
  let other = 0;
  for (let i = 1; i <= 2; i += 1) {
    scripts.push(callRound(`r${i}`, "read_spill", "{}"));
    if (i < 2) {
      for (let k = 0; k < 6; k += 1) {
        other += 1;
        scripts.push(callRound(`o${other}`, "other", JSON.stringify({ n: other })));
      }
    }
  }
  scripts.push(done);
  const results = await run(scripts, BIG, true);
  expect(results.some(refused)).toBe(false);
  expect(results.filter((r) => r.startsWith("x"))).toHaveLength(2 + 6);
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

test("flow 387 review r3 F-033: a cycle of large re-reads is eventually refused, not reset on every prune", async () => {
  // Five signatures, each ~12K tokens, cycled six times (30 rounds). Every signature's earlier
  // result is pushed out of the protected window before it repeats, so each prune hides it. A
  // once-per-signature reset forgives the first lap's repeat only: the count then reaches the cap.
  const scripts: Script[] = [];
  let id = 0;
  for (let lap = 0; lap < 6; lap += 1) {
    for (let k = 0; k < 5; k += 1) {
      id += 1;
      scripts.push(callRound(`c${id}`, "other", JSON.stringify({ path: `f${k}` })));
    }
  }
  scripts.push(done);
  const results = await run(scripts, BIG, true);
  expect(results.some(refused)).toBe(true);
  expect(results.filter((r) => r.startsWith("x")).length).toBeLessThan(30);
});
