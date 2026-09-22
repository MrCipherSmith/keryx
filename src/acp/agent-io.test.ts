import { describe, expect, test } from "bun:test";
import { createAcpAgentIo, type AcpPermissionRequest } from "./agent-io";
import { ACP_PERMISSION_OPTION_IDS } from "./permission";
import type { AcpSessionUpdate } from "./protocol";

function collect(): { updates: AcpSessionUpdate[]; sessionIds: string[]; io: ReturnType<typeof createAcpAgentIo> } {
  const updates: AcpSessionUpdate[] = [];
  const sessionIds: string[] = [];
  const io = createAcpAgentIo("s1", (sessionId, update) => {
    sessionIds.push(sessionId);
    updates.push(update);
  });
  return { updates, sessionIds, io };
}

describe("createAcpAgentIo", () => {
  test("write() streams agent_message_chunk updates, one per call", () => {
    const { updates, io } = collect();
    io.write("hello ");
    io.write("world");
    expect(updates).toHaveLength(2);
    expect(updates[0]).toEqual({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello " } });
    expect(updates[1]).toEqual({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "world" } });
  });

  test("write('') is a no-op", () => {
    const { updates, io } = collect();
    io.write("");
    expect(updates).toHaveLength(0);
  });

  test("onReasoningDelta streams agent_thought_chunk, skips redacted/empty deltas", () => {
    const { updates, io } = collect();
    io.onReasoningDelta?.({ text: "thinking..." });
    io.onReasoningDelta?.({ text: "hidden", redacted: true });
    io.onReasoningDelta?.({ redacted: false });
    expect(updates).toHaveLength(1);
    expect(updates[0]).toEqual({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking..." } });
  });

  test("onToolCall mints a toolCallId and emits a tool_call update with kind mapped from the name", () => {
    const { updates, io } = collect();
    io.onToolCall?.("read_file", '{"path":"a.ts"}');
    expect(updates).toHaveLength(1);
    const update = updates[0];
    expect(update?.sessionUpdate).toBe("tool_call");
    if (update?.sessionUpdate === "tool_call") {
      expect(update.kind).toBe("read");
      expect(update.status).toBe("in_progress");
      expect(update.rawInput).toEqual({ path: "a.ts" });
      expect(typeof update.toolCallId).toBe("string");
      expect(update.toolCallId.length).toBeGreaterThan(0);
    }
  });

  test("onToolCall survives a non-JSON input string (raw text passed through as rawInput)", () => {
    const { updates, io } = collect();
    io.onToolCall?.("shell_exec", "not json");
    const update = updates[0];
    if (update?.sessionUpdate === "tool_call") {
      expect(update.rawInput).toBe("not json");
      expect(update.kind).toBe("execute");
    } else {
      throw new Error("expected a tool_call update");
    }
  });

  test("onToolResult correlates to the matching onToolCall's minted id (F-3 FIFO by name)", () => {
    const { updates, io } = collect();
    io.onToolCall?.("get_cwd", "{}");
    const callUpdate = updates[0];
    if (callUpdate?.sessionUpdate !== "tool_call") {
      throw new Error("expected a tool_call update");
    }
    const mintedId = callUpdate.toolCallId;

    io.onToolResult?.("get_cwd", { output: "/repo", isError: false });
    expect(updates).toHaveLength(2);
    const resultUpdate = updates[1];
    if (resultUpdate?.sessionUpdate !== "tool_call_update") {
      throw new Error("expected a tool_call_update");
    }
    expect(resultUpdate.toolCallId).toBe(mintedId);
    expect(resultUpdate.status).toBe("completed");
    expect(resultUpdate.content).toEqual([{ type: "content", content: { type: "text", text: "/repo" } }]);
  });

  test("two concurrent calls to the same tool resolve in start order (documented FIFO heuristic)", () => {
    const { updates, io } = collect();
    io.onToolCall?.("read_file", '{"path":"a"}');
    io.onToolCall?.("read_file", '{"path":"b"}');
    const firstCall = updates[0];
    const secondCall = updates[1];
    if (firstCall?.sessionUpdate !== "tool_call" || secondCall?.sessionUpdate !== "tool_call") {
      throw new Error("expected two tool_call updates");
    }
    const firstId = firstCall.toolCallId;
    const secondId = secondCall.toolCallId;
    expect(firstId).not.toBe(secondId);

    io.onToolResult?.("read_file", { output: "A", isError: false });
    io.onToolResult?.("read_file", { output: "B", isError: false });
    const firstResult = updates[2];
    const secondResult = updates[3];
    if (firstResult?.sessionUpdate !== "tool_call_update" || secondResult?.sessionUpdate !== "tool_call_update") {
      throw new Error("expected two tool_call_update updates");
    }
    expect(firstResult.toolCallId).toBe(firstId);
    expect(secondResult.toolCallId).toBe(secondId);
  });

  test("onToolResult with no matching onToolCall still emits an update, under a fresh id", () => {
    const { updates, io } = collect();
    io.onToolResult?.("mystery_tool", { output: "boo", isError: true });
    expect(updates).toHaveLength(1);
    const update = updates[0];
    expect(update?.sessionUpdate).toBe("tool_call_update");
    if (update?.sessionUpdate === "tool_call_update") {
      expect(update.status).toBe("failed");
      expect(typeof update.toolCallId).toBe("string");
    }
  });

  test("onSystem streams as an agent_message_chunk", () => {
    const { updates, io } = collect();
    io.onSystem?.("note to operator");
    expect(updates).toEqual([{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "note to operator" } }]);
  });

  test("every update carries the session id passed to createAcpAgentIo", () => {
    const { sessionIds, io } = collect();
    io.write("x");
    io.onToolCall?.("get_cwd", "{}");
    expect(sessionIds.every((id) => id === "s1")).toBe(true);
  });

  test("requestApproval is intentionally unset (T9's scope — AgentIO default-denies absent it)", () => {
    const { io } = collect();
    expect(io.requestApproval).toBeUndefined();
  });
});

/**
 * ONE ACP tool-call id per actual tool call (flow 285, T16 — review finding 1).
 *
 * `runAgentTurn` reaches the approval gate BEFORE `io.onToolCall` on two paths
 * (`commands/agent.ts`): the untrusted-content taint gate, which asks and then
 * falls through to `io.onToolCall?.(call.name, call.input)`, and the
 * concurrent `spawn_subagent` pre-pass, which approves inside `executeCall`
 * before the batch loop announces. Both used to mint a SECOND id here, and
 * since `onToolResult` closes only one, the other stayed `in_progress` in the
 * client for the rest of the session.
 */
describe("createAcpAgentIo — a call approved before it is announced", () => {
  function collectGated(answer: string): {
    updates: AcpSessionUpdate[];
    asks: AcpPermissionRequest[];
    io: ReturnType<typeof createAcpAgentIo>;
  } {
    const updates: AcpSessionUpdate[] = [];
    const asks: AcpPermissionRequest[] = [];
    const io = createAcpAgentIo(
      "s1",
      (_sessionId, update) => updates.push(update),
      async (request) => {
        asks.push(request);
        return { outcome: { outcome: "selected", optionId: answer } };
      },
    );
    return { updates, asks, io };
  }

  const toolCalls = (updates: readonly AcpSessionUpdate[]): Extract<AcpSessionUpdate, { sessionUpdate: "tool_call" }>[] =>
    updates.filter((u): u is Extract<AcpSessionUpdate, { sessionUpdate: "tool_call" }> => u.sessionUpdate === "tool_call");
  const toolResults = (
    updates: readonly AcpSessionUpdate[],
  ): Extract<AcpSessionUpdate, { sessionUpdate: "tool_call_update" }>[] =>
    updates.filter(
      (u): u is Extract<AcpSessionUpdate, { sessionUpdate: "tool_call_update" }> => u.sessionUpdate === "tool_call_update",
    );

  test("is announced exactly once, and the later onToolCall adopts that id instead of minting a second", async () => {
    const input = JSON.stringify({ command: "echo hi" });
    const { updates, asks, io } = collectGated(ACP_PERMISSION_OPTION_IDS.allowOnce);

    // The taint gate's order: approve first, announce after.
    const approved = await io.requestApproval?.("shell_exec", input, { fingerprint: "fp", destructive: false, untrustedOrigin: true });
    expect(approved).toBe(true);
    io.onToolCall?.("shell_exec", input);
    io.onToolResult?.("shell_exec", { output: "hi", isError: false });

    const announced = toolCalls(updates);
    expect(announced).toHaveLength(1);
    const announcedId = announced[0]!.toolCallId;
    // The client was asked about the call it had been shown...
    expect(asks[0]?.toolCall.toolCallId).toBe(announcedId);
    // ...and that same id is the one that reports the outcome. No announced
    // call is left without a terminal update.
    const results = toolResults(updates);
    expect(results).toHaveLength(1);
    expect(results[0]!.toolCallId).toBe(announcedId);
    expect(results[0]!.status).toBe("completed");
  });

  test("a denial closes the announced id, with no second announcement (onToolCall never runs on that path)", async () => {
    const input = JSON.stringify({ command: "rm -rf /" });
    const { updates, asks, io } = collectGated(ACP_PERMISSION_OPTION_IDS.rejectOnce);

    const approved = await io.requestApproval?.("shell_exec", input, { fingerprint: "fp", destructive: false, untrustedOrigin: true });
    expect(approved).toBe(false);
    // The taint gate `continue`s straight to onToolResult when the answer is no.
    io.onToolResult?.("shell_exec", { output: "tool blocked", isError: true });

    const announced = toolCalls(updates);
    expect(announced).toHaveLength(1);
    const results = toolResults(updates);
    expect(results).toHaveLength(1);
    expect(results[0]!.toolCallId).toBe(announced[0]!.toolCallId);
    expect(results[0]!.toolCallId).toBe(asks[0]!.toolCall.toolCallId);
    expect(results[0]!.status).toBe("failed");
  });

  test("two calls to one tool approved ahead of their announcements keep one id each, paired by input", async () => {
    // The concurrent `spawn_subagent` pre-pass shape: both approvals land
    // before either announcement, and the approvals can settle in the reverse
    // of the order the batch loop then walks the calls in.
    const first = JSON.stringify({ task: "first" });
    const second = JSON.stringify({ task: "second" });
    const { updates, asks, io } = collectGated(ACP_PERMISSION_OPTION_IDS.allowOnce);

    await io.requestApproval?.("spawn_subagent", second, { fingerprint: "b", destructive: false });
    await io.requestApproval?.("spawn_subagent", first, { fingerprint: "a", destructive: false });

    io.onToolCall?.("spawn_subagent", first);
    io.onToolResult?.("spawn_subagent", { output: "A", isError: false });
    io.onToolCall?.("spawn_subagent", second);
    io.onToolResult?.("spawn_subagent", { output: "B", isError: false });

    const announced = toolCalls(updates);
    expect(announced).toHaveLength(2);
    const idForSecond = asks[0]!.toolCall.toolCallId;
    const idForFirst = asks[1]!.toolCall.toolCallId;
    expect(idForFirst).not.toBe(idForSecond);
    expect(announced.map((u) => u.toolCallId).sort()).toEqual([idForFirst, idForSecond].sort());

    const results = toolResults(updates);
    expect(results).toHaveLength(2);
    // Each result closed the id its own call was announced and asked under.
    expect(results[0]!.toolCallId).toBe(idForFirst);
    expect(results[0]!.rawOutput).toBe("A");
    expect(results[1]!.toolCallId).toBe(idForSecond);
    expect(results[1]!.rawOutput).toBe("B");
    // Every announced call reached a terminal state.
    expect(new Set(results.map((u) => u.toolCallId)).size).toBe(announced.length);
  });

  test("the ordinary order (announce, then ask) still reuses the announced id", async () => {
    const input = JSON.stringify({ command: "echo hi" });
    const { updates, asks, io } = collectGated(ACP_PERMISSION_OPTION_IDS.allowOnce);

    io.onToolCall?.("shell_exec", input);
    await io.requestApproval?.("shell_exec", input, { fingerprint: "fp", destructive: false });
    io.onToolResult?.("shell_exec", { output: "hi", isError: false });

    const announced = toolCalls(updates);
    expect(announced).toHaveLength(1);
    expect(asks[0]?.toolCall.toolCallId).toBe(announced[0]!.toolCallId);
    expect(toolResults(updates)[0]!.toolCallId).toBe(announced[0]!.toolCallId);
  });
});
