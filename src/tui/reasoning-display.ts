// Pure formatting/parsing helpers for reasoning ("chain-of-thought") display
// (flow 268 T17, AC16). Deliberately dependency-free — no `@opentui/core`, no
// renderables — so these are unit-testable without the optional TUI package
// and reusable from BOTH the TUI (`tui-shell.ts`'s `attachBlockIo`) and the
// non-TUI one-line renderers (`createTuiAgentIo`'s default, `commands/shell.ts`'s
// readline `onReasoningEnd`).

/**
 * Persisted display mode for reasoning blocks, set by `/think auto|expand|hide`
 * and stored at `ShellConfig.thinkDisplay`.
 *
 * - `auto` (default): today's behaviour — a collapsed block, expandable with
 *   bare `/think`/ctrl+o.
 * - `expand`: the finished block renders already expanded.
 * - `hide`: no live "thinking…" preview and no retained block at all — see
 *   `attachBlockIo`'s doc comment for why this is "just hidden" rather than
 *   "hidden but still copyable".
 */
export type ThinkDisplayMode = "auto" | "expand" | "hide";

/** Every valid mode, in the order `/think`'s usage line lists them. */
export const THINK_DISPLAY_MODES: readonly ThinkDisplayMode[] = ["auto", "expand", "hide"];

/** `raw` normalized/validated against {@link THINK_DISPLAY_MODES}; `undefined` when it matches none. */
export function parseThinkDisplayMode(raw: string | undefined): ThinkDisplayMode | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const normalized = raw.trim().toLowerCase();
  return (THINK_DISPLAY_MODES as readonly string[]).includes(normalized) ? (normalized as ThinkDisplayMode) : undefined;
}

/** A persisted/hand-edited value, defaulting to `"auto"` when absent or invalid. */
export function resolveThinkDisplayMode(persisted: string | undefined): ThinkDisplayMode {
  return parseThinkDisplayMode(persisted) ?? "auto";
}

/** `12s` — whole seconds, never negative (defensive against an inverted span). */
export function formatReasoningDurationSeconds(durationMs: number): string {
  return `${Math.max(0, Math.round(durationMs / 1000))}s`;
}

/** `18` below 1000, else `1.8k` (one decimal, e.g. `12k` for round thousands — no trailing `.0`). */
export function formatReasoningTokenCount(tokens: number): string {
  const rounded = Math.max(0, Math.round(tokens));
  if (rounded < 1000) {
    return `${rounded}`;
  }
  const k = Math.round((rounded / 1000) * 10) / 10;
  return `${k}k`;
}

/** Shared input to both header formatters below. */
export interface ReasoningHeaderInfo {
  /** Whether the round produced any visible chain-of-thought text. */
  hasText: boolean;
  /** True when the provider withheld at least part of the round's reasoning. */
  redacted: boolean;
  durationMs?: number;
  tokens?: number;
}

/**
 * Ordered fragments shared by both header formatters below: `duration` (when
 * known) reads as a direct modifier of "thought" ("thought for 12s"); every
 * fragment in `rest` is a separate fact joined by " · " — including `duration`
 * ITSELF when it is the only content and appears with no anchor word (the
 * bare-redacted case: "◆ thought · hidden by provider" has no "for Ns" to
 * attach to, so the whole thing is a `rest` entry, never a `duration`).
 */
function reasoningHeaderParts(info: ReasoningHeaderInfo): { duration: string | undefined; rest: string[] } {
  const duration = info.durationMs !== undefined ? `for ${formatReasoningDurationSeconds(info.durationMs)}` : undefined;
  const rest: string[] = [];
  if (info.tokens !== undefined) {
    rest.push(`${formatReasoningTokenCount(info.tokens)} tokens`);
  }
  // Only when the round produced NO visible text at all — a partially
  // redacted round (some hidden deltas, some visible text) has text to show
  // and reads normally, with no "hidden by provider" fragment.
  if (info.redacted && !info.hasText) {
    rest.push("hidden by provider");
  }
  return { duration, rest };
}

/**
 * `◆ thought for 12s · 1.8k tokens` — the one-line, non-block reasoning
 * header (`createTuiAgentIo`'s default, `commands/shell.ts`'s readline
 * onReasoningEnd). Unknown parts are simply omitted; a fully-unknown round
 * (no duration, no tokens, not redacted) is the bare `◆ thought`.
 */
export function formatReasoningHeader(info: ReasoningHeaderInfo): string {
  const { duration, rest } = reasoningHeaderParts(info);
  let out = "◆ thought";
  if (duration !== undefined) {
    out += ` ${duration}`;
  }
  if (rest.length > 0) {
    out += ` · ${rest.join(" · ")}`;
  }
  return out;
}

/**
 * `for 12s · 1.8k tokens` (no `◆ thought` prefix and no leading separator) —
 * for the TUI's collapsible block `summary`, appended after `blockLabel`'s
 * own `▸ thought (N lines) · hint` header (see `attachBlockIo`). `""` when
 * nothing is known, so the caller's `summary.length > 0 ? …` guard falls back
 * to the bare label exactly like every other block kind.
 */
export function formatReasoningBlockSummary(info: ReasoningHeaderInfo): string {
  const { duration, rest } = reasoningHeaderParts(info);
  return [...(duration !== undefined ? [duration] : []), ...rest].join(" · ");
}

/**
 * `◆ thought for Ns (N lines)` — the non-TUI, non-block single-line reasoning
 * summary (flow 056's original `◆ thought (N lines)` format, now duration-
 * aware). A redacted round with no visible lines uses the same
 * "hidden by provider" wording as {@link formatReasoningHeader} instead of
 * claiming "(0 lines)".
 */
export function formatReasoningOneLiner(info: {
  durationMs?: number;
  lineCount: number;
  redacted: boolean;
  hasText: boolean;
}): string {
  const durationSuffix = info.durationMs !== undefined ? ` for ${formatReasoningDurationSeconds(info.durationMs)}` : "";
  if (info.redacted && !info.hasText) {
    return `◆ thought${durationSuffix} · hidden by provider`;
  }
  const unit = info.lineCount === 1 ? "line" : "lines";
  return `◆ thought${durationSuffix} (${info.lineCount} ${unit})`;
}

/**
 * The last `maxLines` NON-EMPTY lines of `accumulatedText` (streaming
 * reasoning so far), each clipped to `maxWidth` columns with a trailing `…`.
 * Used for the TUI's live "thinking…" preview while a round's reasoning is
 * still streaming (AC16) — bounded on both axes so a model that reasons in
 * one giant unbroken paragraph or in hundreds of short lines cannot grow the
 * busy line without limit.
 */
export function reasoningLivePreviewLines(
  accumulatedText: string,
  options: { maxLines?: number; maxWidth?: number } = {},
): string[] {
  const maxLines = options.maxLines ?? 3;
  const maxWidth = options.maxWidth ?? 72;
  const lines = accumulatedText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const tail = maxLines > 0 ? lines.slice(-maxLines) : [];
  return tail.map((line) => (line.length > maxWidth ? `${line.slice(0, Math.max(0, maxWidth - 1))}…` : line));
}
