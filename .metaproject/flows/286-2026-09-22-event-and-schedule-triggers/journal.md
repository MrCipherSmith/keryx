# Flow Journal

- 2026-09-22T18:18:39.374Z - flow created
- 2026-09-22T18:19:55.871Z - task-added: T5: Survey what already fires: hooks, background tasks, serve, bus; decide where triggers live
- 2026-09-22T18:19:55.969Z - task-added: T6: Trigger config: schema, validation, per-entry refusal
- 2026-09-22T18:19:56.069Z - task-added: T7: keryx trigger run: one pass, locking, exit codes
- 2026-09-22T18:19:56.170Z - task-added: T8: The fired-trigger record and keryx trigger status
- 2026-09-22T18:19:56.270Z - task-added: T9: keryx trigger install extending the existing hook installer; list
- 2026-09-22T18:19:56.370Z - task-added: T10: Schedule output: cron line or systemd timer, no daemon
- 2026-09-22T18:19:56.472Z - task-added: T11: Flow-opening action with the do-not-duplicate rule and the budget refusal outcome
- 2026-09-22T18:19:56.569Z - task-added: T12: Concurrency test: two triggered runs at once leave the artifacts intact
- 2026-09-22T18:19:56.671Z - task-added: T13: Docs: README and CLI reference for triggers
- 2026-09-22T18:19:56.770Z - task-added: T14: Verification: CI green, keryx health run
- 2026-09-22T18:30:55.324Z - frozen: 10 criteria; checksum recorded
- 2026-09-22T18:30:55.419Z - started
- 2026-09-22T18:30:55.519Z - task-attempt: T5: started (attempt 1) — sonnet: survey what already fires
- 2026-09-22T18:30:55.616Z - task-attempt: T6: started (attempt 1) — sonnet: trigger config schema
- note (implementer): T5 decision — trigger config lives at `.metaproject/triggers.json` (hand-edited, project-scoped), not inside `.metaproject/metaproject.json` or a `<module>.config.json`. Those are machine-managed by `keryx init`/`update`'s "one writer" discipline (`src/lib/routing-entrypoint.ts`); a hand-authored, independently-validated entry list follows the `src/lib/provider-config.ts` (`llm-providers.json`) precedent instead — its own file, never machine-rewritten. Full reasoning and the rest of the T5 survey (hooks, post-commit multi-block pattern, serve/bus, locking gap in gdgraph/wiki, spend-ceiling refusal shape) is in `context.md` under "Agent Findings". T6 implements the loader at `src/trigger/config.ts` against this path.
