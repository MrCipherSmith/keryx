import { expect, test } from "bun:test";
import { formatUsageLine } from "./usage-format";

test("cache reads and writes remain subsets of input", () => {
  expect(formatUsageLine({ inputTokens: 100, outputTokens: 7, cacheReadTokens: 60, cacheWriteTokens: 10 }))
    .toBe("↑100 ↓7 tokens · cache-read 60 · cache-write 10 · uncached 30");
});
test("missing cache counters stay unknown", () => {
  expect(formatUsageLine({ inputTokens: 100 })).toBe("↑100 tokens · cache not reported");
  expect(formatUsageLine({ inputTokens: 100, cacheReadTokens: 60 })).not.toContain("uncached");
  expect(formatUsageLine({})).toBeUndefined();
});
test("zero is distinct from absent and invalid totals do not become negative", () => {
  expect(formatUsageLine({ inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 })).toContain("uncached 100");
  expect(formatUsageLine({ inputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 0 })).not.toContain("uncached");
});
