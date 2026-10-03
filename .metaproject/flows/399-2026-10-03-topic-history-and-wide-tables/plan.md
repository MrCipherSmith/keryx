# Implementation Plan

Status: frozen with the acceptance criteria; one flow, two PRs (poll 53)

## Approach

1. PR 1, history restore. The signal is `reused: false` from `Hub.register`, carried to `RemoteBridge.enable()`, combined with a "session was resumed" flag; the messages come from `loadArchive` filtered by `isOperatorMessage` and the final-text-per-turn rule; each goes through `composeReply` and the outbound queue as a separate paced post; a per-topic marker in session state keeps it idempotent; `/history [N]` is the manual form, registered in the shell, help and remote command tables (AC6 to AC17, AC19).
2. Live probe (AC1), allowed by the operator: three test tables to the operator's keryx-shell topic, result in `spike.md` with message ids.
3. PR 2, tables, by another agent after the probe: the winning variant as a pure pinned builder, flow 395 invariants and the fallbacks untouched, split at rows (AC2 to AC5, AC18).

## Steps

1. Freeze (this flow). Not a confirmation.
2. PR 1 on its own branch and worktree from `origin/main`; version after the merge queue; targeted tests only; draft PR; green CI.
3. Probe and `spike.md`.
4. `keryx flow implemented 399` only after both PRs exist.
5. Live acceptance by the operator (AC17, AC18).

## Risks

- The restore must never fire for a reused topic, a non-resumed session, or a retry; the marker and the `reused` flag are the guards.
- Ten paced posts into a fresh topic meet the group rate limit; the outbound queue paces them and a 429 pauses it.
- The markdown table form may not scroll sideways, or may open model text to a parser (spike S3); the probe finds out first.
- Flow 395 has an unconfirmed live AC11 on the table code; PR 1 does not touch it (AC19).
