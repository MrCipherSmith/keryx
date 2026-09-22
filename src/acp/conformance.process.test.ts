// The flow-285 conformance test (AC8): ONE run, over a REAL stdio pipe
// against the built CLI, with the deterministic offline fixture provider
// (`./fixture-provider.ts` — no network, no model), that drives every method
// this flow implements and asserts the ORDER the frames actually arrived in,
// not merely that each one showed up somewhere in the log.
//
// The area-specific process tests (`permission.process.test.ts`,
// `cancel-list-load.process.test.ts`, `capability-matrix.process.test.ts`,
// `../commands/acp.process.test.ts`) already prove each mechanism in
// isolation, in depth, including edge cases this file does not repeat
// (unknown optionId, a client that never answers, the fs capability both
// ways, and so on). This file is the single pass a future protocol bump or
// refactor runs as one check: initialize -> session/new -> a streamed prompt
// -> a gated call that is DENIED -> a gated call that is CANCELLED mid-ask ->
// session/list -> session/load, all on ONE connection, asserted as one
// strictly-increasing sequence of frame indices. If any later change
// reorders this — say, a permission reply racing ahead of the tool_call that
// announced it, or a cancelled turn leaking one more update after its reply
// — this test fails even though every individual mechanism still "works" in
// isolation.
//
// Deterministic by construction: every wait is on a wire EVENT (a specific
// frame arriving), never a timer, so nothing here can be outrun by a loaded
// CI runner. The one place another file in this flow uses a wall-clock
// `sleep` (`cancel-list-load.process.test.ts`'s "cancel mid-turn" test, to
// give a cancel notification real time to race an in-flight tool) is
// intentionally NOT reused here: this file cancels while a permission
// request is still open instead, which is a race resolved by waiting for the
// request itself to arrive, not by wall-clock time.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ACP_PERMISSION_OPTION_IDS } from "./permission";
import { AcpProcessClient, type WireMessage } from "./process-client.test-helpers";
import { ACP_PROTOCOL_VERSION, KERYX_AGENT_CAPABILITIES, KERYX_AUTH_METHODS } from "./protocol";
import { createSession, persistHistory } from "../session";

const TIMEOUT_MS = 60_000;

/** What `executeCall` returns when the operator says no — the local denial, verbatim (shared with `permission.process.test.ts`). */
const LOCAL_DENIAL = "command not approved by the user; not executed";

let root = "";
let projectDir = "";
let dataDir = "";

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "keryx-acp-conf-")));
  projectDir = path.join(root, "project");
  dataDir = path.join(root, "data");
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * One fixture covering every `stream()` call this test's single session
 * makes, IN CALL ORDER (the fixture provider replays `turns[N]` on the
 * (N+1)th call, across the whole process's lifetime — see
 * `fixture-provider.ts`):
 *
 *   0: the streamed turn — a `get_cwd` call (never gated), then...
 *   1: ...a streamed text answer.
 *   2: the denied turn — a `shell_exec` call (gated, denied by the client).
 *   3: the model's acknowledgement of the denial.
 *   4: the cancelled turn — a `shell_exec` call whose permission ask is
 *      still open when `session/cancel` arrives; the turn aborts before any
 *      further model round, so no 5th entry is ever consumed.
 */
function buildFixture(): string {
  const turns: Record<string, unknown>[][] = [
    [
      { kind: "reasoning_delta", text: "Checking the working directory." },
      { kind: "tool_call_start", toolCallId: "c0", toolName: "get_cwd" },
      { kind: "tool_call_end", toolCallId: "c0", input: "{}" },
      { kind: "model_end" },
    ],
    [
      { kind: "text_delta", text: "Your directory is " },
      { kind: "text_delta", text: "ready." },
      { kind: "model_end" },
    ],
    [
      { kind: "tool_call_start", toolCallId: "c1", toolName: "shell_exec" },
      { kind: "tool_call_end", toolCallId: "c1", input: JSON.stringify({ command: "echo would-run" }) },
      { kind: "model_end" },
    ],
    [{ kind: "text_delta", text: "Acknowledged." }, { kind: "model_end" }],
    [
      { kind: "tool_call_start", toolCallId: "c2", toolName: "shell_exec" },
      { kind: "tool_call_end", toolCallId: "c2", input: JSON.stringify({ command: "echo would-run-2" }) },
      { kind: "model_end" },
    ],
  ];
  const file = path.join(root, "fixture.json");
  writeFileSync(file, JSON.stringify({ turns }), "utf8");
  return file;
}

/** The index of `frame` within `frames` (by reference) — asserted `>= 0` by the caller via `toBeGreaterThan`. */
function indexOf(frames: readonly WireMessage[], frame: WireMessage): number {
  return frames.indexOf(frame);
}

describe("AC8 — one conformance run drives the whole ACP surface, in order", () => {
  test(
    "initialize, session/new, a streamed prompt, a denial, a cancel, list and load — as one ordered sequence",
    async () => {
      const client = new AcpProcessClient({ fixture: buildFixture(), cwd: projectDir, dataDir, homeRoot: root });
      try {
        // A durable session, created OUTSIDE this connection the same way
        // `keryx shell` does (mirrors `cancel-list-load.process.test.ts`'s
        // AC5 test) — this is what `session/load` replays later. Created
        // up front so its on-disk `updatedAt` cannot race the in-connection
        // work below.
        const external = createSession({ cwd: projectDir, dataDir, provider: "fake", model: "fake-model", title: "shell session" });
        persistHistory(
          external,
          [
            { role: "user", content: "hello from keryx shell", provenance: "project", ts: new Date().toISOString() },
            { role: "assistant", content: "hi there", provenance: "model", ts: new Date().toISOString() },
          ],
          { provider: "fake", model: "fake-model" },
        );

        // --- 1. initialize -----------------------------------------------
        const initId = client.request("initialize", {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: {},
          clientInfo: { name: "conformance-test", version: "0" },
        });
        const initReply = await client.waitFor((m) => m.id === initId, "the initialize reply");
        expect(initReply.error).toBeUndefined();
        const initResult = initReply.result as {
          protocolVersion: number;
          agentCapabilities: unknown;
          authMethods: unknown[];
          agentInfo: { name: string };
        };
        expect(initResult.protocolVersion).toBe(ACP_PROTOCOL_VERSION);
        expect(initResult.agentCapabilities).toEqual(KERYX_AGENT_CAPABILITIES);
        expect(initResult.authMethods).toEqual([...KERYX_AUTH_METHODS]);
        expect(initResult.agentInfo.name).toBe("keryx");

        // --- 2. session/new ------------------------------------------------
        const newId = client.request("session/new", { cwd: projectDir, mcpServers: [] });
        const newReply = await client.waitFor((m) => m.id === newId, "the session/new reply");
        expect(newReply.error).toBeUndefined();
        const newSessionId = (newReply.result as { sessionId?: string }).sessionId;
        if (typeof newSessionId !== "string" || newSessionId.length === 0) {
          throw new Error(`session/new returned no sessionId: ${JSON.stringify(newReply)}`);
        }
        const sessionId: string = newSessionId;

        // --- 3. session/prompt: a real turn, streamed ----------------------
        const streamPromptId = client.request("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: "where am I?" }],
        });
        const streamReply = await client.waitFor((m) => m.id === streamPromptId, "the streamed prompt's reply");
        expect(streamReply.result).toEqual({ stopReason: "end_turn" });

        // AC2: the updates arrived WHILE the turn ran, not only at the end —
        // proved on frame position, not merely on their existence: everything
        // between the session/new reply and this reply that is a
        // session/update for this session is a genuine mid-turn arrival.
        {
          const frames = client.messages();
          const newReplyIndex = indexOf(frames, newReply);
          const streamReplyIndex = indexOf(frames, streamReply);
          const midTurn = frames
            .slice(newReplyIndex + 1, streamReplyIndex)
            .filter((m) => m.method === "session/update" && m.params?.["sessionId"] === sessionId);
          expect(midTurn.length).toBeGreaterThanOrEqual(2);
          const kinds = midTurn.map((m) => (m.params?.["update"] as { sessionUpdate?: string }).sessionUpdate);
          expect(kinds).toContain("tool_call");
          expect(kinds).toContain("tool_call_update");
          expect(kinds).toContain("agent_message_chunk");
        }

        // --- 4. session/prompt: a gated call, DENIED -----------------------
        const denyPromptId = client.request("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: "run it" }],
        });
        const denyAsk = await client.waitFor((m) => m.method === "session/request_permission", "the permission request for the denied call");
        const denyAskParams = denyAsk.params as { sessionId: string; toolCall: { toolCallId: string; name?: string } };
        expect(denyAskParams.sessionId).toBe(sessionId);
        expect(denyAskParams.toolCall.name).toBe("shell_exec");
        // The client was SHOWN this call (F-3) before being asked to authorise it.
        const denyAnnounced = client
          .updates("tool_call")
          .find((m) => (m.params?.["update"] as { toolCallId?: string }).toolCallId === denyAskParams.toolCall.toolCallId);
        expect(denyAnnounced).toBeDefined();

        client.send({
          id: denyAsk.id,
          result: { outcome: { outcome: "selected", optionId: ACP_PERMISSION_OPTION_IDS.rejectOnce } },
        });
        const denyClosed = await client.waitFor(
          (m) =>
            m.method === "session/update" &&
            (m.params?.["update"] as { sessionUpdate?: string; toolCallId?: string })?.sessionUpdate === "tool_call_update" &&
            (m.params?.["update"] as { toolCallId?: string })?.toolCallId === denyAskParams.toolCall.toolCallId,
          "the tool_call_update closing the denied call",
        );
        const denyUpdate = denyClosed.params?.["update"] as { status?: string; rawOutput?: unknown };
        expect(denyUpdate.status).toBe("failed");
        expect(denyUpdate.rawOutput).toBe(LOCAL_DENIAL);
        const denyReply = await client.waitFor((m) => m.id === denyPromptId, "the denied turn's reply");
        expect(denyReply.result).toEqual({ stopReason: "end_turn" });

        // --- 5. session/prompt: a gated call, CANCELLED while the ask is open --
        const cancelPromptId = client.request("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: "run it again" }],
        });
        const cancelAsk = await client.waitFor(
          (m) => m.method === "session/request_permission" && m.id !== denyAsk.id,
          "the permission request for the cancelled call",
        );
        const cancelAskParams = cancelAsk.params as { toolCall: { toolCallId: string } };
        client.send({ method: "session/cancel", params: { sessionId } });

        const cancelClosed = await client.waitFor(
          (m) =>
            m.method === "session/update" &&
            (m.params?.["update"] as { sessionUpdate?: string; toolCallId?: string })?.sessionUpdate === "tool_call_update" &&
            (m.params?.["update"] as { toolCallId?: string })?.toolCallId === cancelAskParams.toolCall.toolCallId,
          "the tool_call_update closing the cancelled call",
        );
        const cancelUpdate = cancelClosed.params?.["update"] as { status?: string; rawOutput?: unknown };
        expect(cancelUpdate.status).toBe("failed");
        expect(cancelUpdate.rawOutput).toBe(LOCAL_DENIAL);
        const cancelReply = await client.waitFor((m) => m.id === cancelPromptId, "the cancelled turn's reply");
        expect(cancelReply.result).toEqual({ stopReason: "cancelled" });
        // The client never answered this ask (F-14): the server settled it
        // locally, which `cancelClosed`/`cancelUpdate` above already prove.
        expect(cancelAsk.id).toBeDefined();

        // AC4: nothing for this session arrives on the wire after the cancelled reply.
        const framesAfterCancelReply = client.messages();
        const cancelReplyIndex = indexOf(framesAfterCancelReply, cancelReply);
        const laterUpdatesForSession = framesAfterCancelReply
          .slice(cancelReplyIndex + 1)
          .filter((m) => m.method === "session/update" && m.params?.["sessionId"] === sessionId);
        expect(laterUpdatesForSession).toEqual([]);

        // --- 6. session/list -------------------------------------------------
        const listId = client.request("session/list", { cwd: projectDir });
        const listReply = await client.waitFor((m) => m.id === listId, "the session/list reply");
        expect(listReply.error).toBeUndefined();
        const listed = (listReply.result as { sessions?: { sessionId: string; cwd: string }[] }).sessions ?? [];
        expect(listed.some((s) => s.sessionId === sessionId)).toBe(true);
        expect(listed.some((s) => s.sessionId === external.summary.id)).toBe(true);

        // --- 7. session/load ---------------------------------------------------
        const loadId = client.request("session/load", { sessionId: external.summary.id, cwd: projectDir, mcpServers: [] });
        const loadUserChunk = await client.waitFor(
          (m) =>
            m.method === "session/update" &&
            (m.params?.["update"] as { sessionUpdate?: string })?.sessionUpdate === "user_message_chunk" &&
            m.params?.["sessionId"] === external.summary.id,
          "the replayed user_message_chunk",
        );
        const loadAgentChunk = await client.waitFor(
          (m) =>
            m.method === "session/update" &&
            (m.params?.["update"] as { sessionUpdate?: string })?.sessionUpdate === "agent_message_chunk" &&
            m.params?.["sessionId"] === external.summary.id,
          "the replayed agent_message_chunk",
        );
        const loadReply = await client.waitFor((m) => m.id === loadId, "the session/load reply");
        expect(loadReply.error).toBeUndefined();
        expect((loadUserChunk.params?.["update"] as { content?: { text?: string } }).content?.text).toBe("hello from keryx shell");
        expect((loadAgentChunk.params?.["update"] as { content?: { text?: string } }).content?.text).toBe("hi there");

        // --- Stdout purity (AC1): every line, over the WHOLE exchange, parses
        // as a JSON-RPC frame — nothing else ever reached stdout.
        // (`client.messages()` only holds parsed frames; a non-frame line would
        // already have thrown inside the harness's `pump()`, so getting here at
        // all is part of the proof — this assertion documents that fact rather
        // than re-detecting it.)
        for (const frame of client.messages()) {
          expect(frame.jsonrpc).toBe("2.0");
        }

        // ------------------------------------------------------------------
        // THE ORDER ASSERTION. Every frame above, in the sequence this test
        // drove it, must appear on the wire in that same relative order —
        // not merely "each exists somewhere", which the individual waits
        // already guarantee for their own local neighbourhood, but as ONE
        // monotonically increasing run across the ENTIRE connection.
        // ------------------------------------------------------------------
        const frames = client.messages();
        const sequence = [
          initReply,
          newReply,
          streamReply,
          denyAnnounced!,
          denyAsk,
          denyClosed,
          denyReply,
          cancelAsk,
          cancelClosed,
          cancelReply,
          listReply,
          loadUserChunk,
          loadAgentChunk,
          loadReply,
        ];
        const indices: number[] = sequence.map((frame) => indexOf(frames, frame));
        expect(indices.every((index) => index >= 0)).toBe(true);
        for (let i = 1; i < indices.length; i += 1) {
          const current = indices[i];
          const previous = indices[i - 1];
          if (current === undefined || previous === undefined) {
            throw new Error(`missing index at position ${i} in the order sequence`);
          }
          expect(current).toBeGreaterThan(previous);
        }
      } finally {
        await client.kill();
      }
    },
    TIMEOUT_MS,
  );
});
