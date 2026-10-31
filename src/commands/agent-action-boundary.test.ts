import { expect, test } from "bun:test";
import { runAgentTurn, type AgentIO } from "./agent";
import { callRound, makeDeps, okReply, scriptedProvider } from "./agent.test-helpers";
import type { InteractiveTool } from "../harness/tool/builtin/interactive-tools";

// A lost controller must pause read tools too; beforeMutation is insufficient.
test("headless action gate blocks a read tool and subsequent model request until reconnect", async () => {
  const { provider, requests } = scriptedProvider([callRound("read-1", "local_read", "{}"), okReply]);
  let readCalls = 0;
  let release!: () => void;
  let reached!: () => void;
  const paused = new Promise<void>((resolve) => { reached = resolve; });
  const reconnect = new Promise<void>((resolve) => { release = resolve; });
  const boundaries: string[] = [];
  const io: AgentIO & { beforeAction: (action: { kind: "model" | "tool"; toolName?: string }) => Promise<void> } = {
    write: () => {},
    beforeAction: async (action) => {
      boundaries.push(action.kind);
      if (action.kind === "tool") { reached(); await reconnect; }
    },
  };
  const tool: InteractiveTool = {
    definition: { name: "local_read", description: "read fixture", risk: "read", inputSchema: { type: "object", properties: {} } },
    invoke: async () => { readCalls++; return { output: "fixture", isError: false }; },
  };
  const done = runAgentTurn(io, makeDeps(provider, { tools: [tool] }), [], "Read the fixture");
  // Avoid a hung RED test: completion before the pause is an observable violation.
  const first = await Promise.race([paused.then(() => "paused"), done.then(() => "finished")]);
  try {
    expect(first).toBe("paused");
    expect(readCalls).toBe(0);
    expect(requests).toHaveLength(1);
  } finally { release(); await done; }
  expect(readCalls).toBe(1);
  expect(boundaries).toEqual(["model", "tool", "model"]);
});

test("headless gate covers an initial provider call before any provider side effect", async () => {
  const { provider, requests } = scriptedProvider([okReply]);
  let release!: () => void;
  let reached!: () => void;
  const paused = new Promise<void>((resolve) => { reached = resolve; });
  const reconnect = new Promise<void>((resolve) => { release = resolve; });
  const io: AgentIO & { beforeAction: () => Promise<void> } = {
    write: () => {}, beforeAction: async () => { reached(); await reconnect; },
  };
  const done = runAgentTurn(io, makeDeps(provider), [], "hello");
  const first = await Promise.race([paused.then(() => "paused"), done.then(() => "finished")]);
  try { expect(first).toBe("paused"); expect(requests).toHaveLength(0); }
  finally { release(); await done; }
  expect(requests).toHaveLength(1);
});
