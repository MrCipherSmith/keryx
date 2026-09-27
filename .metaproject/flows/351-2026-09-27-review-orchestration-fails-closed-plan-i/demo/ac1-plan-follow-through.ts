// Flow 347 AC12 demonstration script for AC1.
// Drives the REAL runAgentTurn code path in src/commands/agent.ts with a
// scripted provider, copying the scriptedProvider/collectingIo/fixedIdSeq
// helper patterns from src/commands/agent.test.ts (see the tests named
// "runAgentTurn with planFollowThrough ..." there).
//
// Run with: bun run <this file>   (cwd = repo root)

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  runAgentTurn,
  HARNESS_ENVELOPE_PREFIX,
  type AgentDeps,
  type AgentIO,
} from "../../../../src/commands/agent.ts";
import type {
  NormalizedEvent,
  NormalizedMessage,
  NormalizedRequest,
  ProviderDescription,
} from "../../../../src/harness/provider/types.ts";
import { writeSlate } from "../../../../src/session/slate.ts";
import { setExecutionPlan } from "../../../../src/session/execution-plan.ts";
import type { SlateSessionRef } from "../../../../src/session/slate-lifecycle.ts";

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

function collectingIo(): { io: AgentIO; text: string[]; system: string[] } {
  const text: string[] = [];
  const system: string[] = [];
  return {
    text,
    system,
    io: {
      write: (s) => text.push(s),
      onToolCall: () => {},
      onToolResult: () => {},
      onSystem: (s) => system.push(s),
    },
  };
}

async function scenarioDefault(): Promise<void> {
  console.log("\n=== Scenario A: planFollowThrough at default (off) ===");
  const dir = await mkdtemp(path.join(tmpdir(), "keryx-ac1-default-"));
  await writeSlate(dir, () => ({ anchors: { root: dir, touched: [] }, course: {}, seeds: [] }));
  await setExecutionPlan(dir, {
    expectedRevision: 0,
    items: [
      { id: "implement", title: "Implement it", status: "in_progress" },
      { id: "verify", title: "Verify it", status: "pending" },
    ],
  });
  const { provider, requests } = scriptedProvider([
    [{ kind: "text_delta", text: "I have started." }, { kind: "model_end" }],
    [{ kind: "text_delta", text: "A second round must not run." }, { kind: "model_end" }],
  ]);
  const deps: AgentDeps = {
    provider,
    providerId: "scripted",
    modelId: "m",
    tools: [],
    systemInstruction: "sys",
    idSeq: fixedIdSeq(),
    maxRounds: 5,
    // planFollowThrough intentionally omitted -- the default.
  };
  const history: NormalizedMessage[] = [];
  const slateSession: SlateSessionRef = { dir, cwd: dir, opened: true };

  const collected = collectingIo();
  await runAgentTurn(collected.io, deps, history, "hello", { slateSession });

  console.log(`requests.length === 1: ${requests.length === 1}`);
  const nudgeAppended = history.some(
    (m) => m.provenance === "harness" && String(m.content).includes("actionable items remain"),
  );
  console.log(`nudge appended to history: ${nudgeAppended}`);
  console.log(`history entries after assistant reply: ${history.length}`);
  const said = collected.system.join("");
  const hasPlanLine = said.includes("[plan] Turn ending with open plan items (follow-through is off): implement, verify");
  console.log(`operator system() contains required [plan] line: ${hasPlanLine}`);
  console.log(`--- system() output ---\n${said}`);
}

async function scenarioOptedIn(): Promise<void> {
  console.log("\n=== Scenario B: planFollowThrough: true (opt-in) ===");
  const dir = await mkdtemp(path.join(tmpdir(), "keryx-ac1-optin-"));
  await writeSlate(dir, () => ({ anchors: { root: dir, touched: [] }, course: {}, seeds: [] }));
  await setExecutionPlan(dir, {
    expectedRevision: 0,
    items: [
      { id: "implement", title: "Implement it", status: "in_progress" },
      { id: "verify", title: "Verify it", status: "pending" },
    ],
  });
  const { provider, requests } = scriptedProvider([
    [{ kind: "text_delta", text: "I have started." }, { kind: "model_end" }],
    [{ kind: "text_delta", text: "I am stopping again." }, { kind: "model_end" }],
    [{ kind: "text_delta", text: "This third round must not run." }, { kind: "model_end" }],
  ]);
  const deps: AgentDeps = {
    provider,
    providerId: "scripted",
    modelId: "m",
    tools: [],
    systemInstruction: "sys",
    idSeq: fixedIdSeq(),
    maxRounds: 5,
    planFollowThrough: true,
  };
  const history: NormalizedMessage[] = [];
  const slateSession: SlateSessionRef = { dir, cwd: dir, opened: true };

  const collected = collectingIo();
  await runAgentTurn(collected.io, deps, history, "hello", { slateSession });

  console.log(`requests.length === 2 (nudge caused exactly one follow-through): ${requests.length === 2}`);
  const nudge = history.find(
    (m) => m.provenance === "harness" && String(m.content).includes("actionable items remain"),
  );
  console.log(`nudge pushed with provenance "harness": ${nudge?.provenance === "harness"}`);
  console.log(`nudge content starts with envelope prefix: ${String(nudge?.content).startsWith(HARNESS_ENVELOPE_PREFIX)}`);
  console.log(`HARNESS_ENVELOPE_PREFIX = ${JSON.stringify(HARNESS_ENVELOPE_PREFIX)}`);
  console.log(`--- nudge content ---\n${nudge?.content}`);
}

await scenarioDefault();
await scenarioOptedIn();
