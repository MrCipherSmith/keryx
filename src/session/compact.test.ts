import { expect, test } from "bun:test";
import { compactMessages, indexOfKeepFrom } from "./compact";
import { linkToolCalls } from "../harness/provider/tool-call-linking";
import type { NormalizedMessage } from "../harness/provider/types";

function u(content: string): NormalizedMessage {
  return { role: "user", content, provenance: "project" };
}
function a(content: string): NormalizedMessage {
  return { role: "assistant", content, provenance: "model" };
}
function t(content: string): NormalizedMessage {
  return { role: "tool", content, provenance: "tool" };
}

test("indexOfKeepFrom finds the Nth last user turn", () => {
  const h = [u("1"), a("a1"), u("2"), a("a2"), u("3"), a("a3")];
  expect(indexOfKeepFrom(h, 2)).toBe(2); // starts at user "2"
  expect(indexOfKeepFrom(h, 10)).toBe(0);
  expect(indexOfKeepFrom(h, 0)).toBe(h.length);
});

test("compactMessages is noop when history is short", () => {
  const h = [u("only"), a("one")];
  const r = compactMessages(h, { keepLastUserTurns: 3 });
  expect(r.noop).toBe(true);
  expect(r.removed).toBe(0);
  expect(r.context).toEqual(h);
});

test("compactMessages keeps last user turns and summarizes the rest", () => {
  const h = [
    u("first task"),
    a("ok1"),
    t("tool out"),
    u("second task"),
    a("ok2"),
    u("third task"),
    a("ok3"),
    u("fourth"),
    a("ok4"),
  ];
  const r = compactMessages(h, { keepLastUserTurns: 2, focus: "auth" });
  expect(r.noop).toBe(false);
  expect(r.removed).toBeGreaterThan(0);
  expect(r.context[0]?.role).toBe("user");
  expect(r.context[0]?.content).toContain("Compacted earlier context");
  expect(r.context[0]?.content).toContain("Focus: auth");
  expect(r.context[0]?.content).toContain("first task");
  // last two user turns retained
  expect(r.context.some((m) => m.content === "third task")).toBe(true);
  expect(r.context.some((m) => m.content === "fourth")).toBe(true);
  expect(r.context.some((m) => m.content === "first task" && m !== r.context[0])).toBe(false);
});

// A compacted window can start in the middle of a tool round, leaving a result
// whose assistant call was cut away. That half-pair must not reach a provider as
// a dangling `tool_call_id` — the linker degrades it (flow 177).
test("a cut between an assistant call and its result leaves no dangling link", () => {
  const call: NormalizedMessage = {
    role: "assistant",
    content: "",
    provenance: "model",
    toolCalls: [{ id: "c1", name: "get_cwd", arguments: "{}" }],
  };
  const result: NormalizedMessage = { role: "tool", content: "/tmp", provenance: "tool", toolCallId: "c1" };
  const h = [u("first"), call, result, u("second"), u("third"), u("fourth")];

  const r = compactMessages(h, { keepLastUserTurns: 2 });
  expect(r.noop).toBe(false);
  // The call was cut away; whether the result survived or not, nothing in the
  // remaining window claims to answer a call that is no longer present.
  const linked = linkToolCalls(r.context);
  expect(linked.every((l) => l.linkedToolCallId === undefined)).toBe(true);
  expect(linked.every((l) => l.linkedCalls.length === 0)).toBe(true);
});
