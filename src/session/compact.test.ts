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
// flow 268 T11 (AC6): compaction slices the array (`prefix`/`suffix =
// history.slice(...)`) rather than rebuilding messages field by field, so a
// retained message's `reasoning` rides along for free — this pins that.
test("flow 268 T11: compactMessages keeps `reasoning` on a retained suffix message", () => {
  const withReasoning: NormalizedMessage = {
    role: "assistant",
    content: "ok4",
    provenance: "model",
    reasoning: { text: "because", replay: [{ providerId: "anthropic", kind: "thinking_signature", data: "sig" }] },
  };
  const h = [
    u("first task"),
    a("ok1"),
    t("tool out"),
    u("second task"),
    a("ok2"),
    u("third task"),
    a("ok3"),
    u("fourth"),
    withReasoning,
  ];
  const r = compactMessages(h, { keepLastUserTurns: 2 });
  expect(r.noop).toBe(false);
  const retained = r.context.find((m) => m.content === "ok4");
  expect(retained?.reasoning).toEqual(withReasoning.reasoning);
});

// flow 387 T8 (AC5): the 2026-10-01 pattern — injected user messages trailing the last operator turn
function inj(content: string, provenance: "project" | "tool" | "harness" = "project"): NormalizedMessage {
  return { role: "user", content, provenance, ...(provenance === "project" ? { injected: true as const } : {}) };
}

test("flow 387 T8: trailing injected messages never count as turns, so older turns are removed", () => {
  const h = [
    u("request one"),
    a("ok1"),
    u("request two"),
    a("ok2"),
    u("request three"),
    a("ok3"),
    u("request four"),
    a("ok4"),
    inj("Anchors:\nroot: /r"),
    inj("[system] A shell task finished. The text below is command output", "tool"),
    inj("Anchors update:\n+ a.ts"),
  ];
  const r = compactMessages(h, { keepLastUserTurns: 3 });
  expect(r.noop).toBe(false);
  // kept window starts at "request two": request one is summarised, not retained
  expect(r.removed).toBeGreaterThan(0);
  expect(r.context.some((m) => m.content === "request one")).toBe(false);
  expect(r.context.some((m) => m.content === "request two")).toBe(true);
  expect(r.summaryText).toContain("1. request one");
  // the three injected messages are kept, not summarised as user requests
  expect(r.summaryText).not.toContain("Anchors");
  expect(r.summaryText).toContain("1 operator turns");
});

test("flow 387 T8: a legacy session (no marker) still treats anchors, notices and summaries as non-operator", () => {
  const h = [
    u("first"),
    u("Anchors:\nroot: /r"),
    u("[system] A shell task finished. The text below is command output"),
    u("[Compacted earlier context — full transcript retained on disk]\nPrior user requests:\n1. older"),
    u("second"),
    u("third"),
  ];
  expect(indexOfKeepFrom(h, 3)).toBe(0);
  expect(indexOfKeepFrom(h, 2)).toBe(4);
});

test("flow 387 T8: every earlier request survives (>= 500 chars) and a previous summary is merged, not nested", () => {
  const long = `${"x".repeat(450)}END-OF-LONG-REQUEST`;
  const h = [u(long), a("ok"), u("second"), a("ok"), u("third"), u("fourth"), u("fifth"), u("sixth")];
  const first = compactMessages(h, { keepLastUserTurns: 3 });
  expect(first.summaryText).toContain("END-OF-LONG-REQUEST");

  const again = [...first.context, u("seventh"), u("eighth"), u("ninth")];
  const second = compactMessages(again, { keepLastUserTurns: 3 });
  expect(second.summaryText).toContain("END-OF-LONG-REQUEST");
  expect(second.summaryText).toContain("second");
  expect(second.summaryText).toContain("fourth");
  // merged: exactly one summary header, no nested copy of the first summary
  expect(second.summaryText.match(/Compacted earlier context/g)).toHaveLength(1);
  expect(second.summaryText.match(/Prior user requests:/g)).toHaveLength(1);
});

test("flow 387 T8: the summary lists files read and modified from tool calls in the removed prefix", () => {
  const call = (name: string, args: Record<string, unknown>): NormalizedMessage => ({
    role: "assistant",
    content: "",
    provenance: "model",
    toolCalls: [{ id: `c-${name}`, name, arguments: JSON.stringify(args) }],
  });
  const patch = "--- a/src/old.ts\n+++ b/src/new.ts\n@@ -1 +1 @@\n-a\n+b\n";
  const h = [
    u("first"),
    call("read_file", { path: "src/read-me.ts" }),
    call("apply_patch", { patch }),
    u("second"),
    u("third"),
    u("fourth"),
  ];
  const r = compactMessages(h, { keepLastUserTurns: 3 });
  expect(r.summaryText).toContain("Files read: src/read-me.ts");
  expect(r.summaryText).toContain("Files modified: src/old.ts, src/new.ts");
});

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
