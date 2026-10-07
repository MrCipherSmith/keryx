# Flow Journal

- 2026-10-07T03:34:23.592Z - flow created
- 2026-10-07T04:29:16.779Z - frozen: 6 criteria; checksum recorded
- 2026-10-07T05:38:33.310Z - started
- 2026-10-07T06:31:00.681Z - ac-updated: AC6: "Every rule stays linear in input length: the existing scaling tests (pii-linear-time, pii-phone-linear-time) pass, and a differential on random phone, email, name, card and SSN inputs shows every span of baseline 6f6d8898 still covered." -> "Every rule stays linear in input length: the existing scaling tests (pii-linear-time, pii-phone-linear-time) pass, and a differential on random phone, email, name, card and SSN inputs shows every span of baseline 6f6d8898 still covered, except a card span that overlaps a UUID-shaped token, which AC5 deliberately stops reporting (4 of 91,973 baseline card spans in the 60,000-input differential, all four overlapping a UUID)." (Operator poll 120 (2026-10-07): accept the AC5/AC6 loss of 4 card spans that overlap a UUID and word AC6 with that exception.)
- 2026-10-07T06:31:00.878Z - ac-confirmed: AC6: operator confirmed in poll 120 (2026-10-07): AC6 reworded with the UUID exception; backed by src/security/detect/pii-flow412-coverage.test.ts and the scaling tests (signed: 200531777+MrCipherSmith@users.noreply.github.com [derived])
- 2026-10-07T06:31:25.781Z - implemented: draft PR: https://github.com/MrCipherSmith/keryx/pull/921 (base: main)
- 2026-10-07T08:31:08.999Z - ac-confirmed: AC1: operator confirmed in poll 121 (2026-10-07); backed by src/security/detect/pii-flow412-*.test.ts, 422 detector tests pass, CI green on PR 921 (signed: 200531777+MrCipherSmith@users.noreply.github.com [derived])
- 2026-10-07T08:31:09.457Z - ac-confirmed: AC2: operator confirmed in poll 121 (2026-10-07); backed by src/security/detect/pii-flow412-*.test.ts, 422 detector tests pass, CI green on PR 921 (signed: 200531777+MrCipherSmith@users.noreply.github.com [derived])
- 2026-10-07T08:31:09.928Z - ac-confirmed: AC3: operator confirmed in poll 121 (2026-10-07); backed by src/security/detect/pii-flow412-*.test.ts, 422 detector tests pass, CI green on PR 921 (signed: 200531777+MrCipherSmith@users.noreply.github.com [derived])
- 2026-10-07T08:31:10.384Z - ac-confirmed: AC4: operator confirmed in poll 121 (2026-10-07); backed by src/security/detect/pii-flow412-*.test.ts, 422 detector tests pass, CI green on PR 921 (signed: 200531777+MrCipherSmith@users.noreply.github.com [derived])
- 2026-10-07T08:31:10.850Z - ac-confirmed: AC5: operator confirmed in poll 121 (2026-10-07); backed by src/security/detect/pii-flow412-*.test.ts, 422 detector tests pass, CI green on PR 921 (signed: 200531777+MrCipherSmith@users.noreply.github.com [derived])
- 2026-10-07T08:31:37.638Z - task-done: T1: Collect remaining context
- 2026-10-07T08:31:43.586Z - task-done: T2: Implement per plan
- 2026-10-07T08:31:44.096Z - task-done: T3: Add/adjust tests and make them pass
- 2026-10-07T08:31:44.590Z - task-done: T4: Self-review and prepare draft PR
