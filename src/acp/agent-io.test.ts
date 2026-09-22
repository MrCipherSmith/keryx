import { describe, expect, test } from "bun:test";
import { createAcpAgentIo } from "./agent-io";
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
