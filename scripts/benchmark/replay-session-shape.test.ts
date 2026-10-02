// Flow 387 T12 (AC9): the deterministic replay of a session shaped like the 2026-10-01
// vantage-frontend session. Fast (no network, no provider): well under 10 s.

import { describe, expect, test } from "bun:test";
import {
  REPLAY_WINDOW,
  formatComparison,
  generateSession,
  runReplay,
  type ReplayComparison,
} from "./replay-session-shape";

let comparison: Promise<ReplayComparison> | undefined;
function replay(): Promise<ReplayComparison> {
  comparison ??= runReplay();
  return comparison;
}

describe("replay-session-shape fixture", () => {
  test("is deterministic for a seed", () => {
    expect(JSON.stringify(generateSession(7))).toBe(JSON.stringify(generateSession(7)));
    expect(JSON.stringify(generateSession(7))).not.toBe(JSON.stringify(generateSession(8)));
  });

  test("matches the measured message mix and sizes", () => {
    const s = generateSession();
    let operators = 0;
    let anchorBlocks = 0;
    let notices = 0;
    let assistants = 0;
    let withReasoning = 0;
    let tools = 0;
    let toolChars = 0;
    let argChars = 0;
    let replayChars = 0;
    for (const step of s.steps) {
      if (step.kind === "operator") operators++;
      else if (step.kind === "anchors") anchorBlocks++;
      else if (step.kind === "notice") notices++;
      else {
        assistants++;
        argChars += (step.assistant.toolCalls ?? []).reduce((a, c) => a + c.arguments.length, 0);
        const items = step.assistant.reasoning?.replay ?? [];
        if (items.length > 0) withReasoning++;
        replayChars += items.reduce((a, i) => a + String(i.data).length, 0);
        tools += step.tools.length;
        toolChars += step.tools.reduce((a, t) => a + t.content.length, 0);
      }
    }
    expect(operators).toBe(15);
    expect(anchorBlocks).toBe(22);
    expect(notices).toBe(11);
    expect(assistants).toBe(110);
    expect(withReasoning).toBe(53);
    expect(tools).toBe(180);
    expect(toolChars).toBe(600_000);
    expect(Math.abs(argChars - 100_000)).toBeLessThan(500);
    expect(replayChars).toBe(143_000);
  });
});

describe("AC9: replay of the 2026-10-01 session shape", () => {
  test("prints the numbers", async () => {
    const c = await replay();
    console.log(formatComparison(c));
    expect(c.after.windowTokens).toBe(REPLAY_WINDOW);
    expect(c.before.compactions).toBe(0); // main: unknown codex window, no auto-compaction
  });

  test("peak per-request estimated input stays below the compaction threshold of the window", async () => {
    const { after } = await replay();
    expect(after.peakEstimate).toBeLessThan(0.85 * REPLAY_WINDOW);
  });

  test("total estimated input is at least 50% lower than main before this flow", async () => {
    const { before, after } = await replay();
    expect(after.totalEstimate).toBeLessThanOrEqual(before.totalEstimate * 0.5);
  });
});
