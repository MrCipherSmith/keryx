# Implementation Plan

Status: approved by user request 2026-09-17 ("создай ветку, запускай flow и имплементируй").

## Approach

Fix the hang first in small steps, then add one provider-neutral reasoning model and wire every
adapter and the TUI to it. Every task is test-first against fixtures; tests never touch the network.

## Steps

1. Providers lane (serial, shared files):
   T5 streaming + first-byte/idle timeouts → T6 output limits → T10 compat reasoning config and
   inline `<think>` parser → T11 reasoning on `NormalizedMessage` + persistence → T12 compat replay
   → T13 Anthropic thinking → T14 OpenAI Responses reasoning → T15 Gemini thoughts/signature →
   T16 user effort control.
2. Parallel lane (disjoint files): T7 per-message session ts (before T11, same store), T8 suggestion
   fix (tui-shell/shell-chrome), T9 wiki enrich guard + status detection.
3. T17 TUI visualization after T8, T11, T16. T18 derived-data guard tests after T9, T11.
4. T19 docs → T20 full verification → T21 smoke against a real provider → T4 review.

## Decisions

- Inline-tag parsing is opt-in via provider config (`reasoning.format: "inline-tags"`); no
  auto-detection, because a model may legitimately write `<think>` in an answer.
- Recommended MiniMax config: `format: "split"`, `requestParams: { "reasoning_split": true }`,
  `replay: "minimax"`.
- Native providers request reasoning only when the user set an effort (default off: it costs
  tokens). Signatures that arrive anyway (Gemini `thoughtSignature`) are always replayed.
- Past-turn reasoning is replayed only where a provider requires it (DeepSeek with tools, MiniMax,
  Anthropic within the tool loop).
- Timeouts: first-byte and idle default 120 s, configurable; a timeout is a retryable
  `unavailable` provider error. Abort contract of flow-019 stays: exactly one `cancelled`, no
  `model_end`.
- Bare Enter on an empty composer no longer submits the hint; Tab/Right accepts it into the composer.

Rejected: stripping `<think>` from history (breaks MiniMax guidance); per-adapter storage of
reasoning without a shared field (every adapter would invent its own, persistence would drop it).

## Risks

- Streaming rewrite can regress the flow-019 abort contract → keep existing abort tests green, add
  an abort-mid-stream test.
- Anthropic/Gemini replay shapes are only fixture-verified; live verification is T21 where
  credentials exist, otherwise reported as not run.
- `tui-shell.ts` is touched by T8 and T17 → T17 depends on T8.
