import { expect, test } from "vitest";
import type { InfiniteData } from "@tanstack/react-query";
import type { Control } from "../src/api/remote";
import { latestHistoryCursor, mergeTimeline, pendingAssistantText, type CommandEntry } from "../src/features/remote/session-timeline";
const message = (cursor: number, createdAt = "2026-01-01T00:00:00Z") =>
  ({ messageId: "m" + cursor, role: "human", text: "t" + cursor, createdAt, historyCursor: cursor, runId: null }) as unknown as Control["SessionMessage"];
const entry = (operationId: string, anchor: number, invokedAt = "2026-01-01T00:00:00Z"): CommandEntry =>
  ({ outcome: { operationId } as unknown as Control["CommandOutcome"], invokedAt, anchor });
const label = (timeline: ReturnType<typeof mergeTimeline>) =>
  timeline.map(item => item.kind === "message" ? item.message.messageId : item.item.outcome.operationId);
test("an outcome goes after the last message at or below its anchor and before later ones", () => {
  expect(label(mergeTimeline([message(1), message(2), message(3)], [entry("a", 2)]))).toEqual(["m1", "m2", "a", "m3"]);
});
test("an outcome anchored before any message goes first, and one anchored past the end goes last", () => {
  expect(label(mergeTimeline([message(5)], [entry("early", 0), entry("late", Number.POSITIVE_INFINITY)]))).toEqual(["early", "m5", "late"]);
});
test("outcomes sharing an anchor keep the order they were given", () => {
  expect(label(mergeTimeline([message(1), message(2)], [entry("a", 1), entry("b", 1), entry("c", 1)]))).toEqual(["m1", "a", "b", "c", "m2"]);
});
test("wall-clock times play no part in placement", () => {
  const skewed = [message(1, "2099-01-01T00:00:00Z"), message(2, "2099-01-01T00:00:10Z")];
  expect(label(mergeTimeline(skewed, [entry("a", 2, "2026-01-01T00:00:07Z")]))).toEqual(["m1", "m2", "a"]);
});
test("the latest cursor is the highest loaded historyCursor, or 0 with nothing loaded", () => {
  const pages = (...cursors: number[][]) => ({ pages: cursors.map(list => ({ messages: list.map(cursor => message(cursor)) })), pageParams: [] }) as unknown as InfiniteData<Control["HistoryPage"]>;
  expect(latestHistoryCursor(pages([1, 2], [3]))).toBe(3);
  expect(latestHistoryCursor(undefined)).toBe(0);
});

test("keeps the next round visible when an earlier round enters history in the same millisecond", () => {
  const time = "2026-01-01T00:00:00.000Z";
  const runId = "run";
  const deltas = ["Same ", "answer", "Same ", "answer", " Next round"].map((text, index) => ({
    kind: "log" as const, stream: "assistant" as const, text, localSeq: index + 1,
    observedAt: time, runId, turnId: "turn", sessionId: "session", projectId: "project", checkoutId: "checkout",
  }));
  const first = { ...message(1, time), role: "assistant" as const, runId, text: "Same answer" };
  const second = { ...first, messageId: "m2", historyCursor: 2 };
  expect(pendingAssistantText(runId, deltas, [])).toBe("Same answerSame answer Next round");
  expect(pendingAssistantText(runId, deltas, [first])).toBe("Same answer Next round");
  expect(pendingAssistantText(runId, deltas, [first, second])).toBe("Next round");
});
