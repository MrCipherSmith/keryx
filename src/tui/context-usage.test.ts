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
