// Flow 387 T22c: the long runner's own construction (`longTurnOptions` + `uncappedShellRunner`) reaches the
// spill and prune paths of `runAgentTurn`. Offline: a scripted provider, no model. Root causes this pins:
//   - the plain `{ dir, cwd, opened: true }` ref IS accepted by `slateSessionDir` (only `detached` refuses);
//   - the stock `shell_exec` runner caps output at 20 KB, below the 50 KB / 2000-line spill threshold, so a
//     shell result could never spill; the runner's uncapped runner can.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runAgentTurn, type AgentDeps, type AgentIO } from "../../src/commands/agent";
import { shellExecTool } from "../../src/harness/tool/builtin/shell-exec-tool";
import type { InteractiveTool } from "../../src/harness/tool/builtin/interactive-tools";
import type { NormalizedEvent, NormalizedMessage, ProviderDescription } from "../../src/harness/provider/types";
import { longTurnOptions, uncappedShellRunner } from "./long-runner-shared";

type Script = Partial<NormalizedEvent>[];

function scriptedProvider(scripts: Script[]): AgentDeps["provider"] {
  let round = 0;
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
    describe: () => description,
    stream: (_request, opts) => {
      const events = scripts[round] ?? scripts[scripts.length - 1] ?? [];
      round += 1;
      return (async function* (): AsyncGenerator<NormalizedEvent> {
        let sequence = 0;
        for (const partial of events) {
          yield { sequence: sequence++, attemptId: opts.attemptId, kind: "model_end", ...partial } as NormalizedEvent;
        }
      })();
    },
  };
}

const call = (id: string, name: string, input: unknown): Script => [
  { kind: "tool_call_start", toolCallId: id, toolName: name },
  { kind: "tool_call_end", toolCallId: id, input: JSON.stringify(input) },
  { kind: "model_end" },
];
const finish: Script = [{ kind: "text_delta", text: "DONE" }, { kind: "model_end" }];

/** A read-class tool whose every result is ~11K tokens (under the 50 KB spill cap), so tool output piles up past the protected 40K. */
const bulkTool: InteractiveTool = {
  definition: { name: "bulk", description: "bulk", inputSchema: { type: "object", properties: {} }, risk: "read" },
  invoke: async () => ({ output: "x".repeat(45_000), isError: false }),
};

let sessionDir: string;
let root: string;
beforeEach(async () => {
  sessionDir = await mkdtemp(path.join(tmpdir(), "keryx-long-turn-session-"));
  root = await mkdtemp(path.join(tmpdir(), "keryx-long-turn-root-"));
});
afterEach(async () => {
  await rm(sessionDir, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
});

/** Whether some file under the session's tool-output dir holds the FULL 3000-line shell output. */
function fullOutputSaved(): boolean {
  const dir = path.join(sessionDir, "tool-output");
  if (!existsSync(dir)) return false;
  return readdirSync(dir).some((name) => readFileSync(path.join(dir, name), "utf8").endsWith("\n3000\n"));
}

async function run(shell: InteractiveTool): Promise<{ history: NormalizedMessage[]; system: string }> {
  let n = 0;
  const system: string[] = [];
  const io: AgentIO = { write: () => {}, requestApproval: async () => true, onSystem: (s) => system.push(s) };
  const deps: AgentDeps = {
    provider: scriptedProvider([
      call("s1", "shell_exec", { command: "seq 1 3000" }),
      ...Array.from({ length: 9 }, (_, i) => call(`b${i}`, "bulk", { n: i })),
      finish,
    ]),
    providerId: "scripted",
    modelId: "m",
    tools: [shell, bulkTool],
    systemInstruction: "sys",
    idSeq: () => `id-${n++}`,
    // Flow 387 review r3 F-024: pruneArchive only prunes when the host handles
    // onContextCompaction, exactly as run-ablation-long.ts's real deps do.
    onContextCompaction: () => {},
  };
  const history: NormalizedMessage[] = [];
  await runAgentTurn(io, deps, history, "go", longTurnOptions(sessionDir, root) as Parameters<typeof runAgentTurn>[4]);
  return { history, system: system.join("") };
}

test("the runner's turn options and uncapped shell runner yield a spill and a prune", async () => {
  const { history, system } = await run(shellExecTool(root, uncappedShellRunner(root)));

  expect(fullOutputSaved()).toBe(true);
  expect(system).toContain("[prune]");
  // The old exchange was collapsed into a record that names the saved file, not re-sent.
  expect(history.some((m) => m.role === "assistant" && m.content.includes("full output:"))).toBe(true);
});

test("the stock shell_exec runner caps at 20 KB, so the same command never spills (the root cause)", async () => {
  await run(shellExecTool(root));

  expect(fullOutputSaved()).toBe(false);
});
