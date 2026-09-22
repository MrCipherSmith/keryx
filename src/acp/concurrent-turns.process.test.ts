// One turn at a time per session (flow 285, T16 — review finding 2), over a
// REAL stdio pipe against the built CLI.
//
// `AcpSessionState.history` is ONE array, mutated in place by `runAgentTurn`
// for the session's whole life (`session.ts`). Two overlapping
// `session/prompt` calls for the same session id therefore do not run "in
// parallel": they interleave writes into the same transcript, persist each
// other's partial state, and leave `activeTurns` holding one entry where two
// turns are live — so `session/cancel` can only ever reach the newer one, and
// the older one's `finally` deletes a slot that is not its own.
// `session/load` is the same hazard from the other side: it REPLACES the
// registry entry, and with it the array the running turn keeps writing to.
//
// A real subprocess rather than an in-process harness for the same reason
// `cancel-list-load.process.test.ts` uses one: the overlap being tested is the
// read loop's own "lines are started in order and awaited separately" (F-12)
// behaviour, which an in-process harness feeding handlers by hand would not
// exercise at all. The overlap is created by parking the first turn on a
// `session/request_permission` that is never answered until the assertions
// are done — a wire event, not a timer.
//
// Offline by construction: the provider is the `--fixture` scripted one.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { JSON_RPC_ERROR_CODES } from "./jsonrpc";
import { ACP_PERMISSION_OPTION_IDS } from "./permission";
import { AcpProcessClient } from "./process-client.test-helpers";
import { ACP_PROTOCOL_VERSION } from "./protocol";

const TIMEOUT_MS = 60_000;

let root = "";
let projectDir = "";
let dataDir = "";

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "keryx-acp-busy-")));
  projectDir = path.join(root, "project");
  dataDir = path.join(root, "data");
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Nth turn: one gated `shell_exec` with `commands[N]`; then a text answer for every later round. */
function shellFixture(commands: readonly string[], finalText = "done."): string {
  const turns: Record<string, unknown>[][] = commands.map((command, index) => [
    { kind: "tool_call_start", toolCallId: `c${index}`, toolName: "shell_exec" },
    { kind: "tool_call_end", toolCallId: `c${index}`, input: JSON.stringify({ command }) },
    { kind: "model_end" },
  ]);
  for (let i = 0; i < commands.length + 2; i += 1) {
    turns.push([{ kind: "text_delta", text: finalText }, { kind: "model_end" }]);
  }
  const file = path.join(root, `fixture-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify({ turns }), "utf8");
  return file;
}

async function openSession(client: AcpProcessClient): Promise<string> {
  const initId = client.request("initialize", {
    protocolVersion: ACP_PROTOCOL_VERSION,
    clientCapabilities: {},
    clientInfo: { name: "concurrent-turns-test", version: "0" },
  });
  await client.waitFor((m) => m.id === initId, "the initialize reply");
  const newId = client.request("session/new", { cwd: projectDir, mcpServers: [] });
  const created = await client.waitFor((m) => m.id === newId, "the session/new reply");
  const sessionId = (created.result as { sessionId?: string } | undefined)?.sessionId;
  if (typeof sessionId !== "string") {
    throw new Error(`session/new returned no sessionId: ${JSON.stringify(created)}`);
  }
  return sessionId;
}

describe("T16 — one turn at a time per session", () => {
  test("a second session/prompt for a busy session is refused, and the first turn finishes normally", async () => {
    const client = new AcpProcessClient({
      fixture: shellFixture(["echo first-turn"]),
      cwd: projectDir,
      dataDir,
      homeRoot: root,
    });
    try {
      const sessionId = await openSession(client);
      const firstPromptId = client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "run it" }] });

      // The first turn is now parked on an unanswered permission request —
      // genuinely in flight, with no timer involved.
      const ask = await client.waitFor((m) => m.method === "session/request_permission", "session/request_permission");

      const secondPromptId = client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "and again" }] });
      const refusal = await client.waitFor((m) => m.id === secondPromptId, "the second session/prompt reply");
      expect(refusal.result).toBeUndefined();
      expect(refusal.error?.code).toBe(JSON_RPC_ERROR_CODES.invalidRequest);
      const data = refusal.error?.data as { reason?: string; method?: string; sessionId?: string; condition?: string } | undefined;
      expect(data?.condition).toBe("session-busy");
      expect(data?.sessionId).toBe(sessionId);
      expect(String(data?.reason)).toContain("already running");
      expect(data?.method).toBe("session/prompt");

      // The refusal did not disturb the running turn: answer its ask and it
      // finishes normally.
      client.send({ id: ask.id, result: { outcome: { outcome: "selected", optionId: ACP_PERMISSION_OPTION_IDS.allowOnce } } });
      const firstReply = await client.waitFor((m) => m.id === firstPromptId, "the first session/prompt reply");
      expect(firstReply.result).toEqual({ stopReason: "end_turn" });

      // Exactly one turn ran: the refused prompt asked for no permission of
      // its own and produced no updates.
      expect(client.permissionRequests()).toHaveLength(1);

      // And the slot was released — the very next prompt is served.
      const thirdPromptId = client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "now?" }] });
      const thirdReply = await client.waitFor((m) => m.id === thirdPromptId, "the third session/prompt reply");
      expect(thirdReply.error).toBeUndefined();
      expect(thirdReply.result).toEqual({ stopReason: "end_turn" });
    } finally {
      await client.kill();
    }
  }, TIMEOUT_MS);

  test("session/load for a session with a turn in flight is refused, not swapped underneath it", async () => {
    const client = new AcpProcessClient({
      fixture: shellFixture(["echo loading"]),
      cwd: projectDir,
      dataDir,
      homeRoot: root,
    });
    try {
      const sessionId = await openSession(client);
      const promptId = client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "run it" }] });
      const ask = await client.waitFor((m) => m.method === "session/request_permission", "session/request_permission");

      // This id IS loadable — `session/new` created it in the same durable
      // store `session/list` reads — so the refusal below is the busy guard,
      // not "unknown session".
      const listId = client.request("session/list", { cwd: projectDir });
      const listed = await client.waitFor((m) => m.id === listId, "the session/list reply");
      const sessions = (listed.result as { sessions?: { sessionId: string }[] } | undefined)?.sessions ?? [];
      expect(sessions.some((s) => s.sessionId === sessionId)).toBe(true);

      const loadId = client.request("session/load", { sessionId, cwd: projectDir, mcpServers: [] });
      const refusal = await client.waitFor((m) => m.id === loadId, "the session/load reply");
      expect(refusal.result).toBeUndefined();
      expect(refusal.error?.code).toBe(JSON_RPC_ERROR_CODES.invalidRequest);
      const data = refusal.error?.data as { reason?: string; method?: string; condition?: string } | undefined;
      expect(data?.condition).toBe("session-busy");
      expect(data?.method).toBe("session/load");
      expect(String(data?.reason)).toContain("already running");

      // Nothing was replayed for the running session (a load that had gone
      // through would have emitted the session's history as updates).
      const replayed = client
        .updatesForSession(sessionId)
        .filter((m) => (m.params?.["update"] as { sessionUpdate?: string }).sessionUpdate === "user_message_chunk");
      expect(replayed).toEqual([]);

      client.send({ id: ask.id, result: { outcome: { outcome: "selected", optionId: ACP_PERMISSION_OPTION_IDS.allowOnce } } });
      const reply = await client.waitFor((m) => m.id === promptId, "the session/prompt reply");
      expect(reply.result).toEqual({ stopReason: "end_turn" });

      // Once the turn is done the same load is served.
      const secondLoadId = client.request("session/load", { sessionId, cwd: projectDir, mcpServers: [] });
      const loaded = await client.waitFor((m) => m.id === secondLoadId, "the second session/load reply");
      expect(loaded.error).toBeUndefined();
    } finally {
      await client.kill();
    }
  }, TIMEOUT_MS);

  test("a cancelled turn releases its slot: the next prompt is served, not refused as busy", async () => {
    const client = new AcpProcessClient({
      fixture: shellFixture(["echo cancelled-turn"]),
      cwd: projectDir,
      dataDir,
      homeRoot: root,
    });
    try {
      const sessionId = await openSession(client);
      const promptId = client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "run it" }] });
      await client.waitFor((m) => m.method === "session/request_permission", "session/request_permission");
      client.send({ method: "session/cancel", params: { sessionId } });
      const cancelled = await client.waitFor((m) => m.id === promptId, "the cancelled turn's reply");
      expect(cancelled.result).toEqual({ stopReason: "cancelled" });

      const nextPromptId = client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "again" }] });
      const nextReply = await client.waitFor((m) => m.id === nextPromptId, "the next session/prompt reply");
      expect(nextReply.error).toBeUndefined();
      expect(nextReply.result).toEqual({ stopReason: "end_turn" });
    } finally {
      await client.kill();
    }
  }, TIMEOUT_MS);
});
