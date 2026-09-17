import { expect, test } from "bun:test";
import {
  formatReasoningBlockSummary,
  formatReasoningDurationSeconds,
  formatReasoningHeader,
  formatReasoningOneLiner,
  formatReasoningTokenCount,
  parseThinkDisplayMode,
  reasoningLivePreviewLines,
  resolveThinkDisplayMode,
  THINK_DISPLAY_MODES,
} from "./reasoning-display";

// --- flow 268 T17 (AC16): duration/token primitives -------------------------

test("formatReasoningDurationSeconds rounds to whole seconds and never goes negative", () => {
  expect(formatReasoningDurationSeconds(12_000)).toBe("12s");
  expect(formatReasoningDurationSeconds(1_200)).toBe("1s");
  expect(formatReasoningDurationSeconds(500)).toBe("1s"); // rounds up
  expect(formatReasoningDurationSeconds(400)).toBe("0s"); // rounds down
  expect(formatReasoningDurationSeconds(-100)).toBe("0s");
});

test("formatReasoningTokenCount formats sub-1000 exactly and 1000+ as one-decimal k", () => {
  expect(formatReasoningTokenCount(18)).toBe("18");
  expect(formatReasoningTokenCount(0)).toBe("0");
  expect(formatReasoningTokenCount(999)).toBe("999");
  expect(formatReasoningTokenCount(1800)).toBe("1.8k");
  expect(formatReasoningTokenCount(12000)).toBe("12k"); // no trailing .0
  expect(formatReasoningTokenCount(1050)).toBe("1.1k"); // rounds to one decimal
});

// --- flow 268 T17 (AC16): header formatters ---------------------------------

test("formatReasoningHeader: duration + tokens", () => {
  expect(formatReasoningHeader({ hasText: true, redacted: false, durationMs: 12_000, tokens: 1800 })).toBe(
    "◆ thought for 12s · 1.8k tokens",
  );
});

test("formatReasoningHeader: duration only (tokens unknown)", () => {
  expect(formatReasoningHeader({ hasText: true, redacted: false, durationMs: 12_000 })).toBe("◆ thought for 12s");
});

test("formatReasoningHeader: tokens only (duration unknown)", () => {
  expect(formatReasoningHeader({ hasText: true, redacted: false, tokens: 1800 })).toBe("◆ thought · 1.8k tokens");
});

test("formatReasoningHeader: nothing known", () => {
  expect(formatReasoningHeader({ hasText: true, redacted: false })).toBe("◆ thought");
});

test("formatReasoningHeader: redacted with no visible text and no duration", () => {
  expect(formatReasoningHeader({ hasText: false, redacted: true })).toBe("◆ thought · hidden by provider");
});

test("formatReasoningHeader: redacted with no visible text but a known duration", () => {
  expect(formatReasoningHeader({ hasText: false, redacted: true, durationMs: 12_000 })).toBe(
    "◆ thought for 12s · hidden by provider",
  );
});

test("formatReasoningHeader: partially redacted round WITH visible text omits the hidden fragment", () => {
  expect(formatReasoningHeader({ hasText: true, redacted: true, durationMs: 5_000 })).toBe("◆ thought for 5s");
});

test("formatReasoningBlockSummary mirrors the header without the ◆ thought prefix", () => {
  expect(formatReasoningBlockSummary({ hasText: true, redacted: false, durationMs: 12_000, tokens: 1800 })).toBe(
    "for 12s · 1.8k tokens",
  );
  expect(formatReasoningBlockSummary({ hasText: true, redacted: false })).toBe("");
  expect(formatReasoningBlockSummary({ hasText: false, redacted: true })).toBe("hidden by provider");
});

test("formatReasoningOneLiner: duration known, keeps the (N lines) suffix", () => {
  expect(formatReasoningOneLiner({ durationMs: 12_000, lineCount: 3, redacted: false, hasText: true })).toBe(
    "◆ thought for 12s (3 lines)",
  );
});

test("formatReasoningOneLiner: duration unknown matches the pre-T17 bare format", () => {
  expect(formatReasoningOneLiner({ lineCount: 1, redacted: false, hasText: true })).toBe("◆ thought (1 line)");
});

test("formatReasoningOneLiner: redacted with no visible lines uses the hidden wording, not (0 lines)", () => {
  expect(formatReasoningOneLiner({ lineCount: 0, redacted: true, hasText: false })).toBe("◆ thought · hidden by provider");
  expect(formatReasoningOneLiner({ durationMs: 12_000, lineCount: 0, redacted: true, hasText: false })).toBe(
    "◆ thought for 12s · hidden by provider",
  );
});

// --- flow 268 T17 (AC16): /think display mode parsing + persistence --------

test("parseThinkDisplayMode accepts the three modes case-insensitively and trims whitespace", () => {
  expect(parseThinkDisplayMode("auto")).toBe("auto");
  expect(parseThinkDisplayMode("EXPAND")).toBe("expand");
  expect(parseThinkDisplayMode("  hide  ")).toBe("hide");
});

test("parseThinkDisplayMode rejects anything else, including the legacy 'collapse' arg", () => {
  expect(parseThinkDisplayMode("collapse")).toBeUndefined();
  expect(parseThinkDisplayMode("")).toBeUndefined();
  expect(parseThinkDisplayMode("bogus")).toBeUndefined();
  expect(parseThinkDisplayMode(undefined)).toBeUndefined();
});

test("resolveThinkDisplayMode falls back to auto for absent or invalid persisted values", () => {
  expect(resolveThinkDisplayMode(undefined)).toBe("auto");
  expect(resolveThinkDisplayMode("not-a-mode")).toBe("auto");
  expect(resolveThinkDisplayMode("expand")).toBe("expand");
});

test("THINK_DISPLAY_MODES lists every mode /think's usage line advertises", () => {
  expect(THINK_DISPLAY_MODES).toEqual(["auto", "expand", "hide"]);
});

// --- flow 268 T17 (AC16): live preview line selection -----------------------

test("reasoningLivePreviewLines keeps the last N non-empty lines, dropping blanks", () => {
  const text = "line one\n\nline two\nline three\nline four";
  expect(reasoningLivePreviewLines(text, { maxLines: 3 })).toEqual(["line two", "line three", "line four"]);
});

test("reasoningLivePreviewLines returns everything when fewer lines than the bound", () => {
  expect(reasoningLivePreviewLines("only line", { maxLines: 3 })).toEqual(["only line"]);
});

test("reasoningLivePreviewLines clips each line to maxWidth with a trailing ellipsis", () => {
  const long = "x".repeat(100);
  const [line] = reasoningLivePreviewLines(long, { maxWidth: 10 });
  expect(line).toBe(`${"x".repeat(9)}…`);
  expect(line?.length).toBe(10);
});

test("reasoningLivePreviewLines returns an empty array for blank/whitespace-only input", () => {
  expect(reasoningLivePreviewLines("   \n\n  \n")).toEqual([]);
});
