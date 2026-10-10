# Flow Journal

- 2026-10-10T21:17:59.701Z - flow created
- 2026-10-10T21:18:37.575Z - frozen: 7 criteria; checksum recorded
- 2026-10-10T21:18:37.698Z - started
- 2026-10-10T21:18:37.820Z - task-done: T1: Collect remaining context
- 2026-10-10T21:18:37.942Z - task-done: T2: Implement per plan
- 2026-10-10T21:18:38.062Z - task-done: T3: Add/adjust tests and make them pass
- 2026-10-10T21:18:38.182Z - task-added: T5: Parser, ac kinds counts, ac confirm warning (AC1-AC4)
- 2026-10-10T21:18:38.302Z - task-added: T6: Skills failure-scenario line, sync-status share, docs (AC5 AC6)
- 2026-10-10T21:18:38.425Z - task-added: T7: Run every AC command and AC7 invariant
- 2026-10-10T21:19:12.133Z - task-attempt: T5: started (attempt 1) — 423-T5
- 2026-10-10T21:19:12.267Z - task-attempt: T6: started (attempt 1) — 423-T6

## Lane results and verification (2026-10-10)

- T5 (DONE): syntax `[verify: exec|invariant \`<cmd>\` · sensitive: revert|mutation|failure-scenario]`, ASCII `;` also accepted; a note on `judged`/`none`, an unknown value, a wrong key or an empty note is a parser error (reads `unclassified`). `AcKindReport.sensitivity = {proven, unproven, byValue}`; `ac kinds` text and `--json` carry it. `ac confirm` warns after a successful confirm when a noted criterion's `--note` has no sha/path/URL token; command layer only. sync-status line after the unclassified line, no threshold.
- T6 (DONE): one sentence appended to the criteria rule in flow-init step 7 and both flow-orchestrator copies (694 lines, at the ceiling); phrases pinned; cli-reference and CHANGELOG.
- Typecheck (first time in this program with node_modules linked into the worktrees): found a TS2345 in flow 422's `verify-kind-creation-paths.test.ts` (readonly argv); fixed on the 422 branch (98471d768) and merged here. `tsc --noEmit` exit 0.
- T7, with `GIT_TEMPLATE_DIR` set: AC1 19/0; AC2 67/0; AC3 in the AC2 run; AC4 6/0; AC5 7940/1 (the known clean-main failure: retired rule in a read-only dir); AC6 41/0; import-policy, ac-kinds surface, governance, docs, cli-reference coverage 91/0; AC7 diff empty.
- 2026-10-10T21:26:23.353Z - task-done: T5: Parser, ac kinds counts, ac confirm warning (AC1-AC4)
- 2026-10-10T21:26:23.498Z - task-done: T6: Skills failure-scenario line, sync-status share, docs (AC5 AC6)
- 2026-10-10T21:26:23.622Z - task-done: T7: Run every AC command and AC7 invariant
- 2026-10-10T21:26:23.750Z - task-attempt: T4: started (attempt 1) — review round 1
