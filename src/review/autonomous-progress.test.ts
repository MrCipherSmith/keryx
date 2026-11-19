// The runner reads the child's events file; this is what it makes of it.

import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createEventTail, emptyProgress, foldEvent, phaseOf } from "./autonomous-progress";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tmp = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), "autonomous-progress-"));
  dirs.push(dir);
  return dir;
};

const call = (name: string, input: unknown) => ({ type: "tool_call", name, input: JSON.stringify(input) });
const result = (name: string, output: string, isError = false) => ({ type: "tool_result", name, isError, output });

describe("phaseOf", () => {
  test("names a review subcommand", () => {
    expect(phaseOf("bash", JSON.stringify({ command: "keryx review start --target pr --ref x" }))).toBe("review start");
    expect(phaseOf("bash", JSON.stringify({ command: "cd /w && keryx review ingest --id r1" }))).toBe("review ingest");
    expect(phaseOf("bash", JSON.stringify({ command: "keryx review complete r1" }))).toBe("review complete");
  });

  test("falls back to the tool name", () => {
    expect(phaseOf("read_file", "{}")).toBe("read_file");
    expect(phaseOf("bash", JSON.stringify({ command: "ls" }))).toBe("bash");
    expect(phaseOf("bash", "not json")).toBe("bash");
  });
});

describe("foldEvent", () => {
  test("counts tool calls and tracks the open one", () => {
    let state = emptyProgress();
    state = foldEvent(state, call("bash", { command: "keryx review start x" }));
    expect(state.toolCalls).toBe(1);
    expect(state.openCalls).toBe(1);
    expect(state.phase).toBe("review start");
    state = foldEvent(state, result("bash", "ok"));
    expect(state.openCalls).toBe(0);
  });

  test("sums usage events by total, or input plus output", () => {
    let state = emptyProgress();
    state = foldEvent(state, { type: "usage", usage: { totalTokens: 100 } });
    state = foldEvent(state, { type: "usage", usage: { inputTokens: 30, outputTokens: 20 } });
    expect(state.tokens).toBe(150);
  });

  test("a turn_end total larger than the running sum wins", () => {
    let state = emptyProgress();
    state = foldEvent(state, { type: "usage", usage: { totalTokens: 10 } });
    state = foldEvent(state, { type: "turn_end", usage: { totalTokens: 500 } });
    expect(state.tokens).toBe(500);
    expect(state.turnEnded).toBe(true);
  });

  test("counts review ingests as rounds", () => {
    let state = emptyProgress();
    state = foldEvent(state, call("bash", { command: "keryx review ingest --id a" }));
    state = foldEvent(state, call("bash", { command: "keryx review ingest --id a" }));
    expect(state.rounds).toBe(2);
  });

  test("collects a floor refusal with the call that met it", () => {
    let state = emptyProgress();
    state = foldEvent(state, call("bash", { command: "gh pr merge 1" }));
    state = foldEvent(state, result("bash", "command not approved by the user; not executed", true));
    expect(state.floorRefusals).toEqual([{ phase: "bash", output: "command not approved by the user; not executed" }]);
  });

  test("notes when the latest result is the loop guard refusing a repeated call", () => {
    const refusal = "same tool call already tried 3× (hash budget); change the arguments or a different tool";
    let state = foldEvent(emptyProgress(), call("read_file", { path: "a" }));
    state = foldEvent(state, result("read_file", refusal, true));
    expect(state.endedOnLoopGuard).toBe(true);
    state = foldEvent(state, call("read_file", { path: "b" }));
    state = foldEvent(state, result("read_file", "contents"));
    expect(state.endedOnLoopGuard).toBe(false);
  });

  test("keeps an error message of the turn", () => {
    const state = foldEvent(emptyProgress(), { type: "turn_end", errorMessage: "boom" });
    expect(state.errorMessage).toBe("boom");
  });
});

describe("event tail", () => {
  test("reads only what was appended, and holds back a half line", () => {
    const file = path.join(tmp(), "events.ndjson");
    writeFileSync(file, `${JSON.stringify(call("bash", { command: "keryx review start x" }))}\n`);
    const tail = createEventTail(file);
    expect(tail.poll().toolCalls).toBe(1);
    const second = JSON.stringify(result("bash", "ok"));
    appendFileSync(file, second.slice(0, 10));
    expect(tail.poll().openCalls).toBe(1);
    appendFileSync(file, `${second.slice(10)}\n`);
    expect(tail.poll().openCalls).toBe(0);
  });

  test("a missing file is an empty state, and bytes seen reports growth", () => {
    const file = path.join(tmp(), "none.ndjson");
    const tail = createEventTail(file);
    expect(tail.poll().toolCalls).toBe(0);
    expect(tail.bytesSeen()).toBe(0);
    writeFileSync(file, `${JSON.stringify(call("read_file", {}))}\n`);
    tail.poll();
    expect(tail.bytesSeen()).toBeGreaterThan(0);
  });

  test("skips a line that is not JSON", () => {
    const file = path.join(tmp(), "events.ndjson");
    writeFileSync(file, `garbage\n${JSON.stringify(call("bash", { command: "ls" }))}\n`);
    expect(createEventTail(file).poll().toolCalls).toBe(1);
  });
});

test("attributes parallel provider requests, leaves an unreported retry partial and ignores aggregate echoes", () => {
  const parent = { participant: "coordinator" as const, provider: "openai-codex", model: "configured" };
  const child = { participant: "reviewer" as const, reviewer: "review-logic", provider: "openrouter", model: "review-model" };
  const rootUsage = { inputTokens: 100, outputTokens: 10, cacheReadTokens: 90, totalTokens: 110 };
  const childUsage = { inputTokens: 20, outputTokens: 0, cacheWriteTokens: 5, cost: { amount: 0.003, currency: "USD" } };
  const events = [
    { type: "request_start", requestId: "1", ...parent },
    { type: "request_usage", requestId: "1", ...parent, usage: rootUsage },
    { type: "usage", usage: rootUsage },
    { type: "request_start", requestId: "2", ...child },
    { type: "request_usage", requestId: "2", ...child, usage: childUsage },
    { type: "request_start", requestId: "3", ...child },
    { type: "turn_end", usage: rootUsage },
  ];
  const state = events.reduce(foldEvent, emptyProgress());
  expect(state.tokens).toBe(130);
  expect(state.usage).toEqual({
    total: { inputTokens: 120, outputTokens: 10, totalTokens: 130, cacheReadTokens: 90, cacheWriteTokens: 5 },
    coordinator: rootUsage,
    reviewers: [{ partial: true, inputTokens: 20, outputTokens: 0, cacheWriteTokens: 5, totalTokens: 20, reviewer: "review-logic", provider: "openrouter", model: "review-model" }],
    partial: true,
  });
});

test("adds confirmed charges once, preserves a reported zero and withholds sums across currencies", () => {
  const receipt = (requestId: string, reviewer: string, amount: number, currency: string) => ({
    type: "request_usage", requestId, participant: "reviewer", reviewer, provider: "vendor", model: "m",
    usage: { inputTokens: 10, outputTokens: 2, cost: { amount, currency } },
  });
  const free = receipt("a", "review-style", 0, "USD");
  const billed = receipt("b", "review-logic", 0.025, "USD");
  const complete = [free, billed, billed].reduce(foldEvent, emptyProgress()).usage;
  expect(complete?.total).toEqual({ inputTokens: 20, outputTokens: 4, totalTokens: 24, cost: { amount: 0.025, currency: "USD" } });
  expect(complete?.reviewers[0]?.cost).toEqual({ amount: 0, currency: "USD" });
  expect(complete?.partial).toBe(false);
  const mixed = [free, receipt("b", "review-logic", 2, "EUR")].reduce(foldEvent, emptyProgress()).usage;
  expect(mixed?.total.cost).toBeUndefined();
  expect(mixed?.reviewers[1]?.cost).toEqual({ amount: 2, currency: "EUR" });
});
