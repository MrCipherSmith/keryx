import { expect, test } from "bun:test";
import { buildContextUsage, formatContextUsageText, renderUsageBar } from "./context-usage";

test("empty source is an explicit empty state, not a guessed window", () => {
  const view = buildContextUsage({});
  expect(view.total).toBe(0);
  expect(view.note.toLowerCase()).toContain("no context usage");
  expect(formatContextUsageText(view).toLowerCase()).not.toContain("128k");
});

test("estimate is labelled and the bar does not invent a model limit", () => {
  const view = buildContextUsage({ estimateTokens: 80, usage: { inputTokens: 12, outputTokens: 3 } });
  expect(view.total).toBe(80);
  expect(view.estimated).toBe(true);
  expect(view.segments.map((segment) => segment.id)).toEqual(["history", "last-in", "last-out"]);
  expect(view.bar).toBe(renderUsageBar(80));
  const text = formatContextUsageText(view);
  expect(text).toContain("estimate");
  expect(text).toContain("last in");
  expect(text.toLowerCase()).toContain("no model context window");
});

test("provider-reported window fills the bar against the real limit", () => {
  const view = buildContextUsage({
    estimateTokens: 80,
    usage: { inputTokens: 12, outputTokens: 3 },
    contextWindow: 200,
  });
  expect(view.window).toBe(200);
  expect(view.free).toBe(120);
  expect(view.segments.map((segment) => segment.id)).toEqual(["history", "last-in", "last-out", "free"]);
  const text = formatContextUsageText(view);
  expect(text).toContain("80");
  expect(text).toContain("200");
  expect(text.toLowerCase()).toContain("provider-reported");
  expect(text.toLowerCase()).not.toContain("no model context window");
});

