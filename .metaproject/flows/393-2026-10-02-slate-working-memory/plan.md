# Implementation Plan

Status: ready for freeze

## Approach

Turn slate from an appendix of the history into the model's working memory, without breaking slate's
two invariants (Course/Seeds never auto-injected; Seeds are review-bound drafts — see context.md).

1. Two new shelves, both task-local, never promoted to workspace knowledge:
   - **Trail** — harness-owned (the model cannot write it): one entry per executed tool call with step
     number, tool, argument digest, outcome and the path of the saved full output. It is what flow 394's
     collapsed records already say, kept in `slate.json` instead of the history.
   - **Notes** — model-owned working notes (`slate_note` set/replace/delete by key), capped and redacted.
     Distinct from Seeds: Notes are for the model's own work in this task; Seeds stay as they are.
2. **Bounded request**: on hosts that keep the originals (`pruneArchive`), each request is assembled from a
   stable frame — system instruction (+ plan snapshot as today), one rebuilt **slate frame** (Anchors, the
   last N Trail entries, all Notes; untrusted-data framing), the operator messages, and the last K rounds
   verbatim. Older rounds are not sent; `archive.jsonl` keeps everything. The slate frame is rebuilt, never
   appended, and placed so the provider prefix (system + tools) stays cache-stable.
3. **Point recall** instead of re-sending: `slate_trail` (filter by file / tool / step range), `recall_step`
   (full saved output of a step, paged), `history_search` (search this session's archive). All read-only,
   confined to the live session.
4. **Note-taking is prompted, not hoped for**: the system instruction states the contract (older rounds
   leave the request; keep what you will need in Notes), and the harness warns once before a batch of
   rounds leaves the window, naming the steps about to go.
5. Fold in the two flow-394 gaps: `shell_exec` saves the full output via spill instead of truncating, and
   prune thresholds scale with the window so pruning fires before compaction on small windows.

Measured against flow 394's baseline (context.md): replay, comparative benchmark and — the real quality
test — `registry-recall`.

## Steps

1. **Data model** (`src/session/slate.ts`): `trail: TrailEntry[]` and `notes: Record<string, Note>` with
   caps (Trail entries kept on disk unbounded but rendered bounded; Notes ≤ 8K tokens total, ≤ 2K chars
   each), lock-safe read/modify/write, old slate.json files without the fields still load. Invariant A/B
   tests stay green.
2. **Trail recording** (`src/commands/agent.ts` tool-result path): append an entry per executed call,
   reusing flow 394's digest and spill path; subagents/ACP unaffected unless they opt in.
3. **Notes tool** `slate_note` + Notes included in `slate_read`; redaction and caps; never written to Seeds.
4. **Recall tools** `slate_trail`, `recall_step`, `history_search`; confinement tests (other sessions,
   `..`, symlinks) reusing flow 394's `resolveSpillReadable` pattern.
5. **Slate frame** renderer (separate code path from `renderAnchorsBlock`, so invariant A's guard still
   holds for anchors) with a token budget; untrusted-data framing for Notes/Trail digests.
6. **Bounded request assembly** behind `pruneArchive`: frame + operator messages + last K rounds; keep
   tool-call/result pairing valid; prefix-cache stable; replaces prune/collapse as the primary mechanism
   on those hosts, with compaction as the overflow fallback.
7. **Note-taking prompt + pre-eviction warning**.
8. **shell_exec spill-instead-of-truncate** and **window-relative prune thresholds**.
9. **Measurement**: replay numbers, comparative benchmark (keryx vs codex CLI, same model), `registry-recall`
   at 128K on 3 seeds branch vs flow-394 main; short benchmark success.
10. **Review** rounds and completion as in flow 394.

## Risks

- **Prompt-injection persistence**: Notes written after reading hostile content are re-sent every round.
  Mitigation: untrusted-data framing in the frame, redaction, caps, and an explicit test with an
  instruction-shaped note (AC7).
- **Model ignores Notes**: then the bounded window loses facts. Mitigation: the contract in the system
  instruction, the pre-eviction warning, and `registry-recall` as the acceptance gate (AC6).
- **Cache invalidation**: a frame rebuilt every round must not sit before the stable prefix. Mitigation:
  place it after system + tools; measure cached tokens on the comparative run.
- **Breaking slate invariants**: Seeds review semantics and Invariant A must hold (AC10).
- **Scope**: 10 steps is large; if it runs long, steps 8 can split into a follow-up without blocking the
  core (AC11/AC12 are independent).
