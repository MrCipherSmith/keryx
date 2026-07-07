# Tasks

Task definitions live here; task **statuses** live in flow.json and are managed
only via `gd-metapro flow task done <id> <taskId>`.

| ID | Kind | Title | Satisfies |
|----|------|-------|-----------|
| T1 | context | Collect context + hook pattern (done in Phase 1) | — |
| T2 | implement | Hook 1 — security git pre-push gate (render + init prompt/flag + manifest + update) | AC1, AC2 |
| T5 | implement | Hook 3 — agent `.claude/settings.json` guard hooks (merge-safe installer + init prompt/flag) | AC3, AC4 |
| T6 | implement | Registration polish: prompts gated on security enabled, help text, module doc, standard validate | AC5 |
| T3 | test | Merge-safety + no-op-when-disabled + flags + idempotency tests; existing 142 unchanged | AC6 |
| T7 | docs | security spec/README, roadmap, docs/docs (hooks + flags) | AC7 |
| T4 | review | merge-safety/clobber-focused review + code-verifier + draft PR | AC6 |

## Task detail

- **T2:** exact analog of testing pre-push; managed block; blocks push only in
  enforced/ci, warns in advisory; coexists with testing pre-push.
- **T5:** new merge-safe `.claude/settings.json` writer; UserPromptSubmit →
  `security check-input`, PreToolUse(Write|Edit) → `security check-output`;
  idempotent; preserves user entries; valid JSON.
- **T3:** the clobber-safety and disabled-no-op assertions are primary.
