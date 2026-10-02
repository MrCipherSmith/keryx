# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `loadSessionLimits` returns a `contextWindow` for `openai-codex`, taken from the `/models` entry's `context_window` (falling back to `max_context_window`) for the selected slug, and returns `undefined` when neither field is present — no hardcoded default. A unit test covers both cases with a recorded `/models` fixture, and `keryx shell` on `openai-codex` arms the auto-compaction guard with that window.
- AC2: When the provider rejects a request with a context-overflow error, the agent loop compacts once and retries that round once; a second overflow on the retry ends the turn with a visible error instead of looping. A test drives this with a fake provider that returns the overflow error.
- AC3: The pre-request size estimate is the last provider-reported input-token usage plus a chars/4 estimate of the messages added since that response, and it counts replayed reasoning bytes; with no usage recorded it falls back to the full estimate. Tests show a request with large replayed reasoning trips the guard that today's estimate misses.
- AC4: The model-bound history never holds more than one full `Anchors:` block: after the first, a `touched` change adds only the changed entries, and a compaction re-emits a single full block. A test that changes `touched` 20 times asserts exactly one full block and that the anchor bytes in history grow by the deltas only.
- AC5: Compaction (manual `/compact` and automatic) counts only operator-authored turns when choosing what to keep; `Anchors:` blocks, task notifications and harness hints never count as a user turn. The compaction summary contains every earlier operator request (each clipped to no fewer than 500 characters), merges a previous summary instead of nesting it, and lists files read and modified. A test reproduces the 2026-10-01 pattern (3 trailing injected messages) and asserts the compaction removes the older turns.
- AC6: Before each request, tool results outside a protected window (the newest 40K estimated tokens of tool output and the last 2 operator turns) are replaced in the outgoing request by a fixed placeholder naming the spill file, only when that saves at least 20K estimated tokens; `archive.jsonl` keeps the original text. Pruning runs before compaction, and compaction runs only if the request is still over threshold after pruning. Tests cover the threshold, the protected window and the archive content.
- AC7: A tool result over 2000 lines or 50 KB is written in full to a file under the session directory, and the model receives its head and tail, its original line and byte counts and the file path with a hint to read by offset or search. A test asserts the file content equals the original output.
- AC8: Every Codex (`openai-codex`) request carries `prompt_cache_key` equal to the session id, stable across the rounds of a session and different between sessions; a test asserts the request body, and a live probe recorded in the flow journal shows the Codex endpoint accepts the field.
- AC9: A deterministic replay of a synthetic fixture shaped like the 2026-10-01 vantage-frontend session (message mix, tool-output sizes, anchor churn, task notifications; no copied project content) is committed with a test. On it, the peak per-request estimated input stays below the compaction threshold of the window AC1 resolves for that session's model (`gpt-6.1-sol`, the window value stated in the replay output), and the total estimated input over the replay is at least 50% lower than on `main` before this flow; both numbers are printed by the replay and recorded in the journal.
- AC10: The mutating-ablation benchmark records uncached input, cached input and output tokens per task for keryx shell, codex CLI and opencode, and a committed comparative report runs all three on the same task set (model per leg stated, any mismatch disclosed). In that report keryx shell has the lowest mean uncached input tokens per task, or is within 5% of the lowest.
- AC11: In the same report, keryx shell's task success rate after this flow is not lower than its success rate on `main` before this flow on the same task set, and the count of repeated identical read calls after a compaction or prune is not higher than on that baseline.
