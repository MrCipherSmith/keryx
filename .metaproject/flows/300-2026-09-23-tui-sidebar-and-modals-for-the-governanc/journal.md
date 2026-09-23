# Flow Journal

- 2026-09-23T05:32:20.810Z - flow created
- 2026-09-23T05:40:54.709Z - frozen: 12 criteria; checksum recorded
- 2026-09-23T05:40:54.829Z - started
- 2026-09-23T05:40:54.948Z - task-added: T5: Shared trigger-ledger watcher and extracted trigger formatters
- 2026-09-23T05:40:55.068Z - task-added: T6: Governance sidebar section, background run, report modal, /governance
- 2026-09-23T05:40:55.188Z - task-added: T7: Triggers sidebar section, list+detail modal, run-now as a child process, /triggers
- 2026-09-23T05:40:55.309Z - task-added: T8: Sessions: acp rows tagged, -c does not continue an external session
- 2026-09-23T05:40:55.425Z - task-added: T9: Layout, themes, keyboard path, docs
- 2026-09-23T05:40:55.556Z - task-added: T10: Verification: CI green, keryx health run
- 2026-09-23T05:40:55.681Z - task-attempt: T5: started (attempt 1)
- 2026-09-23T06:16:00.000Z - note (implementer): T5–T9 implemented; statuses NOT changed here (the coordinator owns `keryx flow task done`). Seam: `src/tui/trigger-ledger.ts` (API documented at its top); the CLI's trigger descriptors moved to `src/trigger/describe.ts` and are shared by `keryx trigger list/status` and the TUI modal; `NETWORK_ON_WARNING`/`UNATTENDED_ROSTER_DESCRIPTION` re-exported from `commands/trigger-dispatch.ts` unchanged for existing importers. `readProjectTriggerSpend` is now exported from `governance/service.ts`.
- 2026-09-23T06:16:00.000Z - note (implementer): deviation from the phase-1 draft — the Governance section is TWO rows (label + value, the idiom of every other section), not one: the frozen AC1 strings (`no report — click to run`, `last report <date>`) do not fit beside a label in 30 columns. It is always present and mounted after Jobs; at 80x24 it sits below the fold of the scrollable `sidebarTop` (manual Linux pty run: Model/Context/Tools/Status/Ready visible at 80x24; Governance/Triggers visible at 120x50).
- 2026-09-23T06:16:00.000Z - note (implementer): `-c` semantics (AC9 clause): `latestSession()` and `latestUnleasedSession()` now skip sessions whose provider starts with `acp:`; with only an external run on disk `-c` starts a new session.
- 2026-09-23T06:16:00.000Z - note (implementer): finding — AC6's record-equality tests also pass when run-now is pointed at `keryx` on PATH, because these three refusals are recorded identically by the installed build; only the argv test and the structural test catch that revert. An in-process revert fails 4 of 6 (the held lock is re-entrant in-process, so `lock-refused` becomes a real `gdgraph build`). The in-process demonstration rewrote `.metaproject/data/gdgraph/{.provenance.json,artifacts/module-map.json,artifacts/summary.md}` in this worktree; restored with `git restore` (no other git write).
- 2026-09-23T06:16:00.000Z - note (implementer): the pty smoke's new 80x24 case is darwin-gated like the rest of that file; on Linux it is skipped (3 skip), so the 80x24 guarantee on Linux rests on the headless `ops-sidebar.test.ts` AC10 test and the manual `script(1)` run above.
