# Flow Journal

- 2026-09-22T23:36:31.506Z - flow created
- 2026-09-22T23:36:57.006Z - frozen: 6 criteria; checksum recorded
- 2026-09-22T23:36:57.116Z - started
- 2026-09-22T23:36:57.229Z - task-added: T5: ac update --criterion/--text with history of old and new text
- 2026-09-22T23:36:57.341Z - task-added: T6: Strict argument handling for every flow ac subcommand
- 2026-09-22T23:36:57.457Z - task-added: T7: Docs: flow help and CLI reference
- 2026-09-22T23:36:57.570Z - task-added: T8: Verification: CI green, keryx health run
- 2026-09-22T23:36:57.682Z - task-attempt: T5: started (attempt 1)
- 2026-09-22 (subagent) - T5/T6/T7 implemented. `writeAcCriterion` added to src/flow/store.ts (rewrite-or-append one `- ACn:` line). `acUpdate` in src/flow/service.ts takes optional `criterion`/`text`, validates both (AC4: non-empty, single line, no self "- ACn:" prefix, criterion name must be AC\d+, and must be an existing ACn or the next unused one), writes via `writeAcCriterion`, and records "ACn: \"<previous>\" -> \"<new>\" (<reason>)" in flow.history (AC1). `runAc` in src/commands/flow.ts gained `tokenizeArgs`/`rejectUnusedAcArgs` (precedent: review.ts's CREATE_FLAGS/rejectUnknownFlags) applied to confirm/update/reseal, plus an explicit --criterion/--text pairing check (AC3). Help text and docs/docs/cli-reference.md updated (AC5); docs/docs/complete-setup-and-agent-workflows.md too. Audited .metaproject/, docs/, src/gdskills/bundled/ for documented `flow ac` invocations the stricter parsing would refuse — found none (all already used 2-positional confirm / 1-positional update-reseal with allowed flags). Tests: src/flow/service.test.ts (AC1 rewrite+append+skip-ahead-refusal, AC2 reason-only unchanged, AC4 validation) and new src/flow/ac-strict-args.test.ts (AC3, CLI-level via flowCommand, including the exact pre-293 regression string) — 28 pass. Verified AC3's reproduction test fails (process.exitCode stays undefined instead of 1) when the strictness is reverted, then restored the fix. `bun run src/cli.ts flow check` over the whole repo: all flows still consistent. `bun run typecheck` and `bunx eslint` clean on touched files. T8 (CI green, health run) left to the flow owner — out of scope for a worktree subagent (needs push/CI).
- 2026-09-22T23:49:09.643Z - task-done: T5: ac update --criterion/--text with history of old and new text
- 2026-09-22T23:49:09.761Z - task-done: T6: Strict argument handling for every flow ac subcommand
- 2026-09-22T23:49:09.878Z - task-done: T7: Docs: flow help and CLI reference
