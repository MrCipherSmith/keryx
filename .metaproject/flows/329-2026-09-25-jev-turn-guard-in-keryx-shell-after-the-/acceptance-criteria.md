# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: A turn-guard module (core, pure where possible) builds, after an agent turn in `keryx shell` ends with a final assistant message, a bounded redacted state: the user's request text for that turn, the final assistant message, and deterministic facts computed by keryx — tools called and whether any failed, files written/edited, commands run with exit codes, tests run and their pass/fail counts when detectable, and explicit markers in the final message ("I could not", "TODO", "not done", questions back to the user).
- AC2: Jev is asked `noul` questions: (a) was the user's request fully done, (b) does the final message claim success that the facts contradict (e.g. says tests pass while a test command failed); redaction through `src/security/service.ts`; 64k budget preflight; a timeout so the shell never waits more than the guard's budget (documented, e.g. 8 s), and the guard never delays the user's next prompt (runs after the turn, non-blocking).
- AC3: Deterministic contradictions decide without Jev: a failed tool/command whose failure the final message does not mention, or a claim of passing tests when the last test run failed, raise the notice even when Jev is unavailable or not configured.
- AC4: Shell UI: when the guard judges the request likely not done (below a documented threshold) or finds a contradiction, one compact notice line appears under the turn (English, e.g. "Guard: request may be incomplete — 1 command failed (bun test, exit 1). /guard for details"); `/guard` opens a modal with the facts, Jev's probabilities and the reason; nothing is shown when the turn looks done. The notice never auto-continues the agent in this flow.
- AC5: Opt-in and control: a per-user setting (and `/guard on|off`), default off until measured; `keryx shell --guard` enables for one session; state shown in the status/sidebar; the setting is documented.
- AC6: Cost/visibility: each guard call's usage is recorded like other Jev calls and visible in the modal; the guard skips trivial turns (no tools called and a short reply to a short question) without asking Jev — rule documented and tested.
- AC7: Tests: pure-function tests for fact extraction and contradiction detection on synthetic transcripts; shell render tests for the notice and modal; the guard's non-blocking behaviour pinned with a hanging fake Jev; hermetic, macOS-safe; revert-checked.
- AC8: Live check (run with `env -u OPENROUTER_API_KEY`): a scripted or fake-provider shell session with at least 6 synthetic turns — 3 genuinely done, 3 not done or contradicted (failed test not mentioned, unanswered part of the request, a claimed fix with no edit) — reports how many the guard flags correctly, with cost; journaled honestly.
- AC9: Docs (shell docs, cli-reference for the flag, HELP_GROUPS for /guard, commands-by-task), CI green, `keryx health run` passes, import zones respected.
