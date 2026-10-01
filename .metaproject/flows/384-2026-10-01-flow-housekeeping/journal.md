# Flow Journal

- 2026-10-01T12:24:44.273Z - flow created
- 2026-10-01T12:25:04.287Z - frozen: 7 criteria; checksum recorded
- 2026-10-01T12:25:04.477Z - started
- 2026-10-01T12:29:41.013Z - ac-updated: AC3: "`keryx flow complete` refuses with a message that names the folder and the fix when the flow folder is not tracked in git or has uncommitted changes; the green path still completes. Covered by tests for both." -> "`keryx flow complete` refuses with a message that names the folder and the fix when the flow folder is not committed in HEAD (flows created from 0.3.53 on carry the opt-in flag, like the owner and tasks gates; a flow without it reports the gate as skipped); the committed path still completes. Covered by tests for pass, fail and skipped." (wording made exact before any implementation: committed in HEAD, opt-in per package so no pre-existing flow is blocked retroactively)
