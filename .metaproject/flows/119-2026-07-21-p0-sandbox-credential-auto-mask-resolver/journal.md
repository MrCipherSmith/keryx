# Journal — flow 103

## 2026-07-21

- Implemented `src/harness/process/sandbox/mask-resolve.ts` + tests (AC1–AC6, AC8).
- Wired `shell-exec-tool.ts` via `resolveShellRestrictedMasks` (AC7).
- Wired `harness exec` with `--mask-mode` / `--auto-mask` + shared resolver.
- P0.a default: unset mode → manual.
- bun test: mask-resolve + shell-exec + harness tests green.
- tsc --noEmit: run as part of verification.
- 2026-07-21T15:08:45.303Z - frozen: 10 criteria; checksum recorded
- 2026-07-21T15:08:45.368Z - started
- 2026-07-21T15:08:45.434Z - task-done: T1: Collect remaining context
- 2026-07-21T15:08:53.910Z - ac-confirmed: AC1: mask-resolve.test.ts AC1 deepseek auto
- 2026-07-21T15:08:53.975Z - ac-confirmed: AC2: mask-resolve.test.ts AC2 manual empty
- 2026-07-21T15:08:54.038Z - ac-confirmed: AC3: mask-resolve.test.ts AC3 off ignores explicit
- 2026-07-21T15:08:54.103Z - ac-confirmed: AC4: mask-resolve.test.ts AC4 merge hosts
- 2026-07-21T15:08:54.168Z - ac-confirmed: AC5: mask-resolve.test.ts AC5 auto-derived tls
- 2026-07-21T15:08:54.232Z - ac-confirmed: AC6: mask-resolve.test.ts AC6 tls false fail
- 2026-07-21T15:08:54.294Z - ac-confirmed: AC7: shell-exec-tool.test.ts resolveShellRestrictedMasks
- 2026-07-21T15:08:54.360Z - ac-confirmed: AC8: mask-resolve.test.ts resolveMasksFromSandboxEnv parity
- 2026-07-21T15:08:54.424Z - ac-confirmed: AC9: P0.a parseMaskMode default manual; fixture key only
- 2026-07-21T15:08:54.488Z - ac-confirmed: AC10: package README P0.a note; P1/P2 not claimed
- 2026-07-21T15:22:01.036Z - implemented: draft PR: https://github.com/MrCipherSmith/keryx/pull/175 (warning: PR is not a draft)
- 2026-07-21T15:22:01.129Z - completing
- 2026-07-21T15:22:03.222Z - completion-failed: pull-request: PR checks not green
- 2026-07-21T15:22:27.522Z - implemented: draft PR: https://github.com/MrCipherSmith/keryx/pull/175 (warning: PR is not a draft)
- 2026-07-21T15:22:27.623Z - completing
- 2026-07-21T15:22:29.764Z - done: all gates passed
- 2026-07-22T18:58:46.736Z - renumbered: 103 -> 119: duplicate of flow 103 (sandbox network audit runbook); ids collided because allocation was per working copy — flow 116
