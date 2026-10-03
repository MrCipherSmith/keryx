# keryx shell spends fewer tokens than competing harnesses without losing quality

Status: draft (flow-init skill formalizes this)
Source: user description (Aleksandr Tsaitler, 2026-10-02)

## Problem

`keryx shell` re-sends its whole model context on every round and has no working mechanism
that shrinks it. A live acme-frontend session (`c420e265…f8e7a378`, openai-codex/gpt-6.1-sol)
carried ~1 MB of `context.jsonl` — 335 messages, roughly 200–250K tokens per request — of which
~600K chars were tool outputs, ~143K encrypted reasoning, ~82K duplicated `Anchors:` blocks and
~37K task notifications, against ~12K chars of actual assistant text.

The cause is a set of concrete defects, not a tuning problem:

1. `openai-codex` resolves no context window (`loadSessionLimits` only knows `providerByName`
   providers), so the 85% auto-compaction guard never fires; an overflow error is not recovered.
2. `/compact` keeps the "last 3 user turns", but `Anchors:` and task-notification messages are
   role `user`, so it removes about one message; nested summaries clip real user requests to 160 chars.
3. The `Anchors:` block is appended to history on every `touched` change instead of replacing the
   previous one.
4. `estimateRequestTokens` ignores replayed encrypted reasoning and never uses provider-reported usage.
5. Old tool results are never pruned at send time, and large tool output is not spilled to a file.
6. The Codex request carries no `prompt_cache_key`, so the fully re-sent history likely misses the
   provider's prefix cache.
7. Compaction is deterministic only — no anchored summary, no token-budgeted verbatim tail, no
   read/modified file lists.

keryx positions itself as the layer that helps agents spend fewer tokens (gdctx, gdgraph, wiki).
Its own shell doing the opposite contradicts that claim.

## Expected Outcome

`keryx shell` keeps the per-request context bounded on every provider it supports, prunes and
compacts before the window is reached, uses the provider's prompt cache, and does so without the
agent losing the information it needs to finish the task — measurably better than the competing
harnesses studied in `~/sandbox/forks`.

## Outcome criteria

Effects requested by Aleksandr Tsaitler (owner, outcome author: human):

- I want to see that keryx / `keryx shell` saves tokens better than other harnesses, and helps
  save them without losing quality.

Concretely, that is judged by:

- A comparative measurement on the same tasks and the same model: input tokens billed per task
  (uncached and cached separately) for `keryx shell` versus at least codex CLI and opencode, with
  `keryx shell` lowest or tied.
- Task quality held: the same task success rate (and no rise in re-asked questions or repeated
  reads after compaction) as before the change.
- Replaying the 2026-10-01 acme-frontend session shape shows the per-request context staying
  under the compaction threshold instead of growing to ~250K tokens.

## Out of Scope

- Changing gdctx/gdgraph/wiki routing costs (separate known-mistake, flow 320).
- New providers or model catalog work beyond resolving a context window for supported providers.
- An LLM-written compaction summary (opencode/pi style) — a follow-up flow once this flow's
  measurement shows what deterministic compaction leaves on the table.
- Server-side conversation state (`previous_response_id` continuation) unless the measurement
  shows the cache key alone is insufficient.
