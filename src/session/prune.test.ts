import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { renderSpillPreview } from "../harness/tool/output-spill";
import type { NormalizedMessage } from "../harness/provider/types";
import { CLEARED_PREFIX, PRUNE_MIN_SAVING_TOKENS, isClearedToolResult, planPrune, pruneToolOutputs } from "./prune";
import { pair, toolsOf, useTempDirs, user } from "./prune.test-helpers";

// Flow 387 T11 (AC6): send-time pruning of old tool results. The only protected
// window is the newest 40K tokens of tool output (the operator message is never a
// tool result), so a single long operator turn is pruned too. The T11 tests below run
// with `collapseGroups: false` (results only); the T18 tests at the end cover collapsing.

const tmp = useTempDirs("prune-test-");
/** Three operator turns; the first holds `count` tool results of `chars` each. */
function longFirstTurn(count: number, chars: number): NormalizedMessage[] {
  const first: NormalizedMessage[] = [user("one")];
  for (let i = 0; i < count; i++) {
    first.push(...pair(`c${i}`, chars));
  }
  return [
    ...first,
    user("two"),
    { role: "assistant", content: "ok", provenance: "model" },
    user("three"),
    { role: "assistant", content: "ok", provenance: "model" },
  ];
}

test("clears results outside the newest 40K tokens and keeps the newest ones", async () => {
  const sessionDir = tmp();
  // 12 results of 10K tokens each: the newest 4 fill the 40K window.
  const history = longFirstTurn(12, 40_000);
  const result = await pruneToolOutputs(history, { collapseGroups: false, sessionDir });
  expect(result.pruned).toBe(8);
  expect(result.savedTokens).toBeGreaterThanOrEqual(PRUNE_MIN_SAVING_TOKENS);
  const tools = toolsOf(history);
  expect(tools.slice(0, 8).every(isClearedToolResult)).toBe(true);
  expect(tools.slice(8).some(isClearedToolResult)).toBe(false);
  // Pairing is intact: same count, same ids, every result still follows its call.
  expect(tools.map((m) => m.toolCallId)).toEqual(Array.from({ length: 12 }, (_, i) => `c${i}`));
});

test("prunes inside the last operator turn too, keeping the operator message and the newest 40K", async () => {
  const sessionDir = tmp();
  // Everything is in ONE (the last) turn: 7 results of 10K tokens.
  const history: NormalizedMessage[] = [user("one"), user("go")];
  for (let i = 0; i < 7; i++) {
    history.push(...pair(`n${i}`, 40_000));
  }
  const operator = history[1];
  const result = await pruneToolOutputs(history, { collapseGroups: false, sessionDir });
  expect(result.pruned).toBe(3);
  expect(history[1]).toBe(operator);
  const tools = toolsOf(history);
  expect(tools.slice(0, 3).every(isClearedToolResult)).toBe(true);
  expect(tools.slice(3).some(isClearedToolResult)).toBe(false);
});

test("one-operator-turn session (~100 results of 5-20K chars): old results cleared, newest 40K kept", async () => {
  const sessionDir = tmp();
  const history: NormalizedMessage[] = [user("продолжай")];
  for (let i = 0; i < 100; i++) {
    history.push(...pair(`s${i}`, 5_000 + ((i * 1543) % 15_001)));
  }
  const before = toolsOf(history).map((m) => Math.ceil(m.content.length / 4));
  const result = await pruneToolOutputs(history, { collapseGroups: false, sessionDir });
  const tools = toolsOf(history);
  const keptFrom = tools.findIndex((m) => !isClearedToolResult(m));
  expect(result.pruned).toBe(keptFrom);
  expect(keptFrom).toBeGreaterThan(0);
  // Everything from keptFrom on is verbatim and fits the 40K window; one more would not.
  const keptTokens = before.slice(keptFrom).reduce((a, b) => a + b, 0);
  expect(keptTokens).toBeLessThanOrEqual(40_000);
  expect(keptTokens + (before[keptFrom - 1] as number)).toBeGreaterThan(40_000);
  expect(tools.slice(keptFrom).some(isClearedToolResult)).toBe(false);
  expect(result.savedTokens).toBeGreaterThan(PRUNE_MIN_SAVING_TOKENS);
  expect(history[0]?.content).toBe("продолжай");
});

test("does nothing below the 20K-token saving threshold, acts at it", async () => {
  const sessionDir = tmp();
  const small = longFirstTurn(2, 40_000); // 2 x 10K tokens
  expect((await pruneToolOutputs(small, { collapseGroups: false, sessionDir, protectTokens: 0 })).pruned).toBe(0);
  expect(toolsOf(small).some(isClearedToolResult)).toBe(false);

  const enough = longFirstTurn(3, 40_000); // 3 x 10K tokens > 20K
  const result = await pruneToolOutputs(enough, { collapseGroups: false, sessionDir, protectTokens: 0 });
  expect(result.pruned).toBe(3);
});

test("archive keeps the original text and a readable file holds it", async () => {
  const sessionDir = tmp();
  const history = longFirstTurn(12, 40_000);
  // What `archive.jsonl` holds: the message objects as they were before pruning.
  const archive = [...history];
  const original = toolsOf(archive).map((m) => m.content);
  await pruneToolOutputs(history, { collapseGroups: false, sessionDir });

  expect(toolsOf(archive).map((m) => m.content)).toEqual(original);
  const first = toolsOf(history)[0] as NormalizedMessage;
  // Flow 387 review r1 F-004: the name is unique per message, not just the tool-call id.
  expect(first.spillPath).toMatch(/[\\/]tool-output[\\/]\d+-[0-9a-f]{8}-c0\.txt$/);
  expect(first.content).toBe(`${CLEARED_PREFIX} — full text: ${first.spillPath}]`);
  expect(readFileSync(first.spillPath as string, "utf8")).toBe(original[0] as string);
});

test("is idempotent: already-cleared results are untouched and do not count as savings", async () => {
  const sessionDir = tmp();
  const history = longFirstTurn(12, 40_000);
  await pruneToolOutputs(history, { collapseGroups: false, sessionDir });
  const after = history.map((m) => m.content);
  const again = await pruneToolOutputs(history, { collapseGroups: false, sessionDir });
  expect(again).toEqual({ pruned: 0, collapsed: 0, reasoningStripped: 0, savedTokens: 0 });
  expect(history.map((m) => m.content)).toEqual(after);
});

test("a result the spill already saved keeps its spill path and writes nothing new", async () => {
  const sessionDir = tmp();
  const history = longFirstTurn(12, 40_000);
  const spillPath = path.join(sessionDir, "tool-output", "spilled.txt");
  const preview = renderSpillPreview("y".repeat(300_000), spillPath);
  const target = history.findIndex((m) => m.role === "tool");
  history[target] = { ...(history[target] as NormalizedMessage), content: preview, spillPath };
  await pruneToolOutputs(history, { collapseGroups: false, sessionDir });
  expect((history[target] as NormalizedMessage).content).toBe(`${CLEARED_PREFIX} — full text: ${spillPath}]`);
  expect(readdirSync(path.join(sessionDir, "tool-output")).includes("spilled.txt")).toBe(false);
  expect(readdirSync(path.join(sessionDir, "tool-output")).some((f) => f.endsWith("-c0.txt"))).toBe(false);
});

test("without a session dir the placeholder carries no path", async () => {
  const history = longFirstTurn(12, 40_000);
  const result = await pruneToolOutputs(history, { collapseGroups: false, sessionDir: undefined });
  expect(result.pruned).toBe(8);
  expect((toolsOf(history)[0] as NormalizedMessage).content).toBe(`${CLEARED_PREFIX} to save context]`);
});

test("planPrune with a window larger than all tool output plans nothing", () => {
  const history = longFirstTurn(3, 40_000);
  expect(planPrune(history, { protectTokens: 1_000_000 }).entries).toEqual([]);
});
