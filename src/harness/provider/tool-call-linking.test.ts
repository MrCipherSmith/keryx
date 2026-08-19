import { expect, test } from "bun:test";
import { linkToolCalls } from "./tool-call-linking";
import type { NormalizedMessage } from "./types";

function assistantWithCalls(ids: string[]): NormalizedMessage {
  return {
    role: "assistant",
    content: "",
    provenance: "model",
    toolCalls: ids.map((id) => ({ id, name: "get_cwd", arguments: "{}" })),
  };
}

function toolResult(id: string | undefined, content = "/tmp"): NormalizedMessage {
  return { role: "tool", content, provenance: "tool", ...(id !== undefined ? { toolCallId: id } : {}) };
}

test("links an assistant call to the result that answers it", () => {
  const linked = linkToolCalls([
    { role: "user", content: "покажи cwd" },
    assistantWithCalls(["c1"]),
    toolResult("c1"),
  ]);

  expect(linked[1]?.linkedCalls.map((c) => c.id)).toEqual(["c1"]);
  expect(linked[2]?.linkedToolCallId).toBe("c1");
});

test("an unanswered assistant call is NOT linked", () => {
  // The batch was abandoned before the tool ran: sending `tool_calls` that
  // nothing answers is rejected by the OpenAI-compatible APIs.
  const linked = linkToolCalls([{ role: "user", content: "go" }, assistantWithCalls(["c1"])]);
  expect(linked[1]?.linkedCalls).toEqual([]);
});

test("an orphaned tool result is NOT linked", () => {
  // Compaction cut the window between the call and its result.
  const linked = linkToolCalls([{ role: "user", content: "summary" }, toolResult("c1")]);
  expect(linked[1]?.linkedToolCallId).toBeUndefined();
});

test("a result appearing BEFORE its call is not linked to it", () => {
  const linked = linkToolCalls([toolResult("c1"), assistantWithCalls(["c1"])]);
  expect(linked[0]?.linkedToolCallId).toBeUndefined();
});

test("a repeated id links pairwise, never one result to two calls", () => {
  const linked = linkToolCalls([assistantWithCalls(["c1", "c1"]), toolResult("c1")]);
  expect(linked[0]?.linkedCalls.map((c) => c.id)).toEqual(["c1"]);
  expect(linked[1]?.linkedToolCallId).toBe("c1");
});

test("parallel calls in one turn each link to their own result", () => {
  const linked = linkToolCalls([assistantWithCalls(["c1", "c2"]), toolResult("c1"), toolResult("c2")]);
  expect(linked[0]?.linkedCalls.map((c) => c.id)).toEqual(["c1", "c2"]);
  expect(linked[1]?.linkedToolCallId).toBe("c1");
  expect(linked[2]?.linkedToolCallId).toBe("c2");
});

test("malformed entries are dropped without throwing", () => {
  const malformed = {
    role: "assistant",
    content: "",
    toolCalls: [
      { id: "", name: "x", arguments: "{}" },
      { id: "c1", name: "", arguments: "{}" },
      undefined,
      { id: "c2", name: "get_cwd" },
    ],
  } as unknown as NormalizedMessage;

  const linked = linkToolCalls([malformed, toolResult("c2")]);
  expect(linked[0]?.linkedCalls).toEqual([{ id: "c2", name: "get_cwd", arguments: "" }]);
});

test("a conversation with no tool traffic is returned untouched", () => {
  const messages: NormalizedMessage[] = [
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
  ];
  const linked = linkToolCalls(messages);
  expect(linked.map((l) => l.message)).toEqual(messages);
  expect(linked.every((l) => l.linkedCalls.length === 0 && l.linkedToolCallId === undefined)).toBe(true);
});

test("an empty array is total", () => {
  expect(linkToolCalls([])).toEqual([]);
});
