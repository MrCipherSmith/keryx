import { describe, expect, test } from "bun:test";
import { formatActiveTime, formatUsageFooter, formatUsageTable, usageFooterSegments } from "./usage-format";
import { createUsageTracker } from "./usage-tracker";

describe("usage footer format (flow 483)", () => {
  test("hidden before the first turn", () => {
    expect(formatUsageFooter(createUsageTracker({ now: () => 0 }).snapshot())).toBeUndefined();
  });
  test("live turn shows tokens, cache, cost and time; session alongside", () => {
    let t = 0;
    const tr = createUsageTracker({ now: () => t });
    tr.startTurn();
    tr.addUsage({ inputTokens: 12_345, outputTokens: 678, cacheReadTokens: 10_000, cacheWriteTokens: 0 });
    tr.setTurnCost(0.0421);
    t = 65_000;
    const text = formatUsageFooter(tr.snapshot()) ?? "";
    expect(text).toContain("turn \u219112.3k \u2193678 cache 10.0k/0 $0.04 1m05s");
    expect(text).toContain("session \u219112.3k");
    expect(formatUsageTable(tr.snapshot())).toContain("Turn (live)");
  });
  test("no cost when the model is unpriced", () => {
    const tr = createUsageTracker({ now: () => 0 });
    tr.startTurn();
    tr.addUsage({ inputTokens: 5, outputTokens: 1 });
    tr.endTurn();
    expect(formatUsageFooter(tr.snapshot())).not.toContain("$");
    expect(formatUsageTable(tr.snapshot())).toContain("n/a");
  });
  test("active time", () => {
    expect(formatActiveTime(3_725_000)).toBe("1h02m");
    expect(formatActiveTime(9_000)).toBe("9s");
  });
  test("coloured segments join to the plain footer text and colour the figures", () => {
    const tr = createUsageTracker({ now: () => 0 });
    tr.startTurn();
    tr.addUsage({ inputTokens: 12_345, outputTokens: 678, cacheReadTokens: 10_000, cacheWriteTokens: 0 });
    tr.setTurnCost(0.0421);
    const segments = usageFooterSegments(tr.snapshot()) ?? [];
    expect(segments.map((s) => s.text).join("")).toBe(formatUsageFooter(tr.snapshot()) ?? "");
    const roleOf = (needle: string) => segments.find((s) => s.text.includes(needle))?.role;
    expect(roleOf("\u219112.3k")).toBe("accent");
    expect(roleOf("\u2193678")).toBe("ok");
    expect(roleOf("$0.04")).toBe("attention");
    expect(roleOf("cache")).toBe("muted");
  });
  test("no segments before the first turn", () => {
    expect(usageFooterSegments(createUsageTracker({ now: () => 0 }).snapshot())).toBeUndefined();
  });
});
