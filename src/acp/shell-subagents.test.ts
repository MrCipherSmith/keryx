// AC15 (specification §8): `spawn_subagent` is offered in the shell profile; `_keryx/subagent`
// events carry `sessionId` and `parentToolCallId` (the id the client was shown for the spawning
// call); `session/cancel` reaches the children; children never ask for permission.

import { afterEach, expect, test } from "bun:test";
import type { NormalizedEvent, ProviderPort, StreamOptions } from "../harness/provider/types";
import { KERYX_ACP_EXTENSION_METHODS as M } from "./profile";
import { ACP_AGENT_METHODS, ACP_CLIENT_METHODS } from "./protocol";
import type { Frame } from "./server-harness.test-helpers";
import { callsOf, driveTurn, shellHarness, textRound, toolRound, type ShellHarness } from "./shell-profile.test-helpers";

const open: ShellHarness[] = [];
// A provider id the child-routing policy knows (an unknown one is refused by it, whatever the host).
const KNOWN_PROVIDER = { providerId: "ollama", modelId: "fixture" } as const;
afterEach(async () => {
  for (const h of open.splice(0)) await h.end();
});

type FleetEvent = { kind: string; id: string; status?: string; parentToolCallId?: string; label?: string; entry?: { kind: string; text: string } };
const fleet = (h: ShellHarness): { sessionId: string; event: FleetEvent }[] =>
  h.frames.filter((f) => f.method === M.subagent).map((f) => f.params as unknown as { sessionId: string; event: FleetEvent });

test("spawn_subagent is offered; its events carry the session and the id of the spawning tool call", async () => {
  const h = shellHarness({
    rounds: [
      toolRound("s1", "spawn_subagent", { task: "look around", label: "scout" }),
      textRound("the child found 42"),
      textRound("parent done"),
    ],
    serverOptions: KNOWN_PROVIDER,
  });
  open.push(h);
  await h.initialize();
  const { sessionId } = await h.newSession();
  const { reply, asks } = await driveTurn(h, sessionId, "delegate it");
  expect(reply.result).toMatchObject({ stopReason: "end_turn" });

  // The call went through the session's gate once, as a `delegate` call: the child asked nothing.
  expect(asks.map((a) => (a.params as unknown as { toolCall: { name: string } }).toolCall.name)).toEqual(["spawn_subagent"]);
  expect(h.frames.filter((f) => f.method === ACP_CLIENT_METHODS.sessionRequestPermission)).toHaveLength(1);

  const spawned = callsOf(h.frames, "spawn_subagent").announced;
  expect(spawned).toHaveLength(1);
  const toolCallId = spawned[0]?.toolCallId;
  expect(typeof toolCallId).toBe("string");

  const events = fleet(h);
  expect(events.length).toBeGreaterThan(0);
  expect(events.every((e) => e.sessionId === sessionId)).toBe(true);
  const upserts = events.filter((e) => e.event.kind === "upsert");
  expect(upserts.length).toBeGreaterThan(0);
  expect(upserts.every((e) => e.event.parentToolCallId === toolCallId)).toBe(true);
  expect(upserts.at(-1)?.event).toMatchObject({ label: "scout", status: "done" });
  const logs = events.filter((e) => e.event.kind === "log").map((e) => e.event.entry);
  expect(logs.some((l) => l?.kind === "text" && l.text.includes("the child found 42"))).toBe(true);
});

test("the editor profile does not offer it, and a second session's events carry its own sessionId", async () => {
  const h = shellHarness({
    rounds: [
      toolRound("s1", "spawn_subagent", { task: "one", label: "first" }),
      textRound("child one"),
      textRound("done one"),
      toolRound("s2", "spawn_subagent", { task: "two", label: "second" }),
      textRound("child two"),
      textRound("done two"),
    ],
    serverOptions: KNOWN_PROVIDER,
  });
  open.push(h);
  await h.initialize();
  const a = await h.newSession();
  const b = await h.newSession();
  await driveTurn(h, a.sessionId, "go");
  await driveTurn(h, b.sessionId, "go");
  const by = (id: string) => fleet(h).filter((e) => e.sessionId === id).map((e) => e.event.label ?? e.event.id);
  expect(by(a.sessionId)).toContain("first");
  expect(by(a.sessionId)).not.toContain("second");
  expect(by(b.sessionId)).toContain("second");
  // Each session's upserts name that session's own spawning call.
  const own = (id: string) => new Set(callsOf(h.frames.filter((f) => f.params?.sessionId === id), "spawn_subagent").announced.map((u) => u.toolCallId));
  for (const id of [a.sessionId, b.sessionId]) {
    const parents = fleet(h).filter((e) => e.sessionId === id && e.event.kind === "upsert").map((e) => e.event.parentToolCallId);
    expect(parents.every((p) => p !== undefined && own(id).has(p))).toBe(true);
  }

  const editor = shellHarness({ profile: "editor" });
  open.push(editor);
  await editor.initialize();
  const { sessionId } = await editor.newSession();
  const id = editor.prompt(sessionId, "/status");
  await editor.waitFor((f) => f.id === id);
  expect(JSON.stringify(editor.frames)).not.toContain("spawn_subagent");
});

/** A provider whose first call spawns a subagent and whose later calls (the child's) hang until aborted. */
function hangingChildProvider(state: { childAborted: boolean; childStarted: boolean }): ProviderPort {
  let call = 0;
  return {
    describe: () => ({
      capabilities: {
        streaming: true,
        toolCalls: true,
        parallelToolCalls: false,
        structuredOutput: false,
        reasoningMetadata: true,
        promptCaching: false,
        vision: false,
        tokenCounting: false,
        modelListing: false,
      },
      descriptor: { providerId: "hang" },
    }),
    stream: (_request, opts: StreamOptions): AsyncIterable<NormalizedEvent> => {
      const mine = call;
      call += 1;
      return (async function* (): AsyncGenerator<NormalizedEvent> {
        if (mine === 0) {
          yield { sequence: 0, attemptId: opts.attemptId, kind: "tool_call_start", toolCallId: "s1", toolName: "spawn_subagent" };
          yield { sequence: 1, attemptId: opts.attemptId, kind: "tool_call_end", toolCallId: "s1", input: JSON.stringify({ task: "wait", label: "sleeper" }) };
          yield { sequence: 2, attemptId: opts.attemptId, kind: "model_end" };
          return;
        }
        state.childStarted = true;
        await new Promise<void>((resolve) => {
          if (opts.signal?.aborted === true) return resolve();
          opts.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        state.childAborted = opts.signal?.aborted === true;
        throw new Error("aborted");
      })();
    },
  };
}

test("session/cancel reaches the running child", async () => {
  const state = { childAborted: false, childStarted: false };
  const h = shellHarness({ serverOptions: { provider: hangingChildProvider(state), ...KNOWN_PROVIDER } });
  open.push(h);
  await h.initialize();
  const { sessionId } = await h.newSession();
  const promptId = h.prompt(sessionId, "delegate and wait");
  const ask = await h.waitFor((f) => f.method === ACP_CLIENT_METHODS.sessionRequestPermission);
  h.respond(ask.id, { result: { outcome: { outcome: "selected", optionId: "allow_once" } } });
  await h.waitFor((f) => f.method === M.subagent && (f.params as unknown as { event: FleetEvent }).event.status === "running");
  // The "running" row precedes the child's first model call; wait for the call itself.
  for (let i = 0; i < 200 && !state.childStarted; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(state.childStarted).toBe(true);

  h.notify(ACP_AGENT_METHODS.sessionCancel, { sessionId });
  const reply: Frame = await h.waitFor((f) => f.id === promptId && f.method === undefined);
  expect(reply.result).toMatchObject({ stopReason: "cancelled" });
  expect(state.childAborted).toBe(true);
  // Only the spawn call itself was ever asked about.
  expect(h.frames.filter((f) => f.method === ACP_CLIENT_METHODS.sessionRequestPermission)).toHaveLength(1);
});
