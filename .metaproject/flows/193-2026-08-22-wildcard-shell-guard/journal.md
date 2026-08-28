# Flow Journal

- 2026-08-22T11:00:33.616Z - flow created
- 2026-08-22T11:03:36.796Z - frozen: 4 criteria; checksum recorded
- 2026-08-22T11:03:36.877Z - started
- 2026-08-28T08:23:03.195Z - task-done: T1: Collect remaining context
- 2026-08-28T08:23:03.294Z - task-done: T2: Implement per plan
- 2026-08-28T08:23:03.386Z - task-done: T3: Add/adjust tests and make them pass
- 2026-08-28T08:23:03.477Z - task-done: T4: Self-review and prepare draft PR
- 2026-08-28T08:23:08.705Z - ac-confirmed: AC1: Verified: PR #398 (fix(shell): reject bare 'keryx *' wildcard, merged 2026-08-22, commit 04ec6138) adds 'keryx' to PREFIX_BANNED and updates round-trip/pattern tests to reject bare 'keryx *'.
- 2026-08-28T08:23:08.799Z - ac-confirmed: AC2: Verified: PR #398 adds getRunningBinaryName() resolving the binary name dynamically from process.argv0, not a hardcoded literal, per shell-permissions.ts diff.
- 2026-08-28T08:23:08.896Z - ac-confirmed: AC3: Verified: PR #398 updates bannedPrefixGrant() to check the running binary name against loaded permissions.json; migration test asserts pre-existing bare 'keryx *' grants are rejected/flagged.
- 2026-08-28T08:23:08.987Z - ac-confirmed: AC4: Verified: PR #398 test plan reports 22/22 shell-permissions tests pass, no type errors; CI required for merge.
- 2026-08-28T08:23:14.338Z - implemented: draft PR: https://github.com/MrCipherSmith/keryx/pull/398 (warning: PR is not a draft)
- 2026-08-28T08:23:14.495Z - completing
- 2026-08-28T08:23:14.509Z - done: all gates passed
