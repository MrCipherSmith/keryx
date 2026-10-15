# Implementation Plan

Status: ready for freeze

## Approach

Fix the seven defects in `description.md` with deterministic, no-LLM mechanisms first, copying the
pattern that the harness comparison study (`context.md`) found strongest for each, and prove the effect with
a measurement rather than by inspection. Order is by token saved per unit of risk: the cache key and
the codex window are near one-liners with large effect; pruning and anchor dedup are the bulk of the
saving; the comparative benchmark comes last because it measures everything before it.

An LLM-written compaction summary is deliberately not in this flow (see Out of Scope in the
description): the deterministic compaction is fixed so it stops losing operator requests, and the
LLM summary follows as its own flow once this one's measurement shows what is left.

## Steps

1. **Cache key (AC8).** Send `prompt_cache_key` = session id on the Codex branch of
   `openai-provider.ts`; for the native Responses branch too when the provider accepts it. Probe the
   Codex endpoint once and record the probe in the journal, as flow 354 did for `max_output_tokens`.
2. **Codex context window (AC1).** Keep `context_window` (fallback `max_context_window`) from the
   `/models` entries `fetchOpenAiCodexModels` already downloads, and return it from
   `loadSessionLimits` for `openai-codex`. Unknown stays `undefined` — never an invented default.
3. **Overflow recovery (AC2).** Classify a provider context-overflow error; on it, compact once and
   retry the round once. A second overflow surfaces as an error, never a loop.
4. **Usage-anchored estimate (AC3).** Record the last provider-reported input usage per round;
   estimate the request as that usage plus chars/4 of messages added since, and count replayed
   reasoning bytes in the estimate. Pure estimate (today's function) remains the fallback when no
   usage is known.
5. **Operator-turn accounting in compaction (AC5).** Give operator input a distinguishable
   provenance (or marker) from harness-injected `role:user` messages — `Anchors:`, task
   notifications, repeated-failure hints. `indexOfKeepFrom` counts only operator turns; the summary
   keeps every operator request (merged, not nested inside the previous summary) and lists files
   read and modified.
6. **One anchors block (AC4).** Replace the append-per-change behaviour: the first block is full,
   later updates carry only the changed entries, and compaction re-emits one full block. Keep the
   stable prefix untouched so the cache from step 1 stays valid.
7. **Tool-output spill (AC7).** At tool time, output over 2000 lines or 50 KB is written to a file
   under the session dir; the model receives head + tail, the byte/line counts and the path with a
   "read with offset or search" hint.
8. **Old tool-output pruning (AC6).** Before each request, replace tool results older than a
   protected window (newest ~40K tokens of tool output and the last 2 operator turns) with a fixed
   placeholder carrying the spill path, only when that saves ≥ 20K tokens. Pruning edits only what is
   sent; `archive.jsonl` keeps the original. Prune → remeasure → compact only if still over threshold.
9. **Session replay fixture (AC9).** A synthetic, redacted fixture with the shape of the 2026-10-01
   acme-frontend session (message mix, tool-output sizes, anchor churn, task notifications) and a
   deterministic replay that reports per-request estimated input before and after.
10. **Comparative benchmark (AC10, AC11).** Extend the mutating-ablation runners to record uncached
    input, cached input and output tokens per task for keryx shell, codex CLI and opencode; run the
    same task set on the same model where each harness allows it (disclose any mismatch, as the M2
    ladder did); commit the report with the task success rates next to the token figures.

## Risks

- **Prefix-cache invalidation.** Pruning and anchor changes rewrite earlier messages; done
  naively, they break the cache step 1 buys. Mitigation: prune in batches only past the 20K saving
  threshold (opencode/cline batching), never touch the system prompt or tool schemas, and measure
  cached tokens in AC10 rather than assume.
- **Quality loss from pruning.** The model may need an old output again. Mitigation: placeholder
  carries the spill path, `read` output is re-readable, and AC11 measures success rate and repeated
  reads against a pre-change baseline.
- **Codex endpoint accepting `prompt_cache_key`.** Unverified on the ChatGPT backend until probed in
  step 1; codex CLI sends it, which is strong but not proof for this adapter's request shape.
- **Benchmark fairness.** Harnesses cannot all run the identical model (known from the M2 ladder).
  The report states the model per leg; a mismatched leg is reported, not dropped.
- **Real session data.** The 2026-10-01 session contains Acme project content; the AC9 fixture is
  synthetic with the same shape, never a copy of the transcript.
