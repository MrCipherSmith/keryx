# Flow Journal

- 2026-08-01T19:00:04.991Z - flow created
- 2026-08-01T19:22:35.339Z - frozen: 11 criteria; checksum recorded
- 2026-08-01T19:22:52.322Z - started

## The guard observed reporting the finding, BEFORE the fix (AC4)

Order matters here and it was the flow's D1. The source-level readers guard was
written first and run against an untouched `session/store.ts`:

```
(fail) every reader … > no un-exempt file both resolves a config path and reads raw
- []
+ [ { "file": "session/store.ts", "raw": "readFileSync(" } ]
```

Only then were the two reads repointed at the bounded helpers. A guard added
over already-clean code is a guard nobody has watched find anything.

## Mutation table (AC3, AC10)

Each mutation applied to `main`-shaped source, the named suite run, the file
restored from a backup afterwards. Every one went red for its stated reason.

| # | Mutation | Expected red | Observed |
|---|---|---|---|
| M1 | `scanFor` body replaced with `return []` | both detector self-checks | RED — writers: 11 of 11 planted shapes missed; readers: 10 of 10 missed. The tree assertions go GREEN under this mutation, which is exactly why the self-check exists. |
| M2 | `!stats.isFile()` refusal removed from `readBoundedFile` | the FIFO matrix | RED — 6 tests, each timing out at 20 000 ms rather than passing. The `the probe harness itself can observe a hang` control stayed green, so the timeout is measuring a real block. |
| M3 | `readTranscriptFile` pointed at `MAX_CONFIG_FILE_BYTES` | the transcript positive control | RED — `loadContext` over a 1.5 MB transcript exited 1. This is the mutation that proves the second bound is not decoration: without it the fix would refuse every real session. |
| M4 | `readJsonl` reverted to a raw `readFileSync` | the source-level guard | RED — `session/store.ts readFileSync(` reported again. |

Not claimed: no mutation was run against `readConfigFile`'s existing size bound
or against the writers guard's own exemption table. Both predate this flow and
their mutation evidence is recorded where they were built.

## Decision taken during implementation

**D5 — an unreadable transcript throws rather than returning `[]`.**
`readJsonl` returns `[]` for a session with no transcript yet, which is true. The
same `[]` for a transcript that is too large, or is a FIFO, would report "this
conversation had no messages" about an audit log the process could not open, and
the caller would resume a session that silently appears to have no history. So
`TranscriptUnreadableError` carries the file and the reason. The behavioural
probe asserts the typed refusal, not merely that the process survived.
- 2026-08-01T19:37:31.965Z - ac-confirmed: AC1
- 2026-08-01T19:37:32.048Z - ac-confirmed: AC2
- 2026-08-01T19:37:32.128Z - ac-confirmed: AC3
- 2026-08-01T19:37:32.208Z - ac-confirmed: AC4
- 2026-08-01T19:37:32.294Z - ac-confirmed: AC5
- 2026-08-01T19:37:32.378Z - ac-confirmed: AC6
- 2026-08-01T19:37:32.461Z - ac-confirmed: AC7
- 2026-08-01T19:37:32.541Z - ac-confirmed: AC8
- 2026-08-01T19:37:32.621Z - ac-confirmed: AC9
- 2026-08-01T19:37:32.707Z - ac-confirmed: AC10
- 2026-08-01T19:37:32.790Z - ac-confirmed: AC11
- 2026-08-01T19:37:36.924Z - task-done: T1: Collect remaining context
- 2026-08-01T19:37:37.011Z - task-done: T2: Implement per plan
- 2026-08-01T19:37:37.092Z - task-done: T3: Add/adjust tests and make them pass
- 2026-08-01T19:37:37.176Z - task-done: T4: Self-review and prepare draft PR
- 2026-08-01T19:38:36.157Z - implemented: draft PR: https://github.com/MrCipherSmith/keryx/pull/219
