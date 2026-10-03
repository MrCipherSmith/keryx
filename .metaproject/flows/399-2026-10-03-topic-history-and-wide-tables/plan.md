# Implementation Plan

Status: draft (PRD and acceptance criteria wait for the operator; nothing is frozen or implemented)

## Approach

Two independent pieces in one flow, sequenced so the unknown goes first (Q1 may split them into two flows).

1. Table layout. A live probe (AC1) decides between the current `table` block, rich `markdown` as helyx sends it, and an aligned HTML `<pre>`; the chosen form is then built as a pure, pinned function (AC2 to AC5) with the flow 395 invariants and the fallbacks untouched.
2. History restore. The signal is `reused: false` from `Hub.register`, carried to `RemoteBridge.enable()`; the messages come from `loadArchive` filtered by `isOperatorMessage` and the no-tool-call rule; they pass `composeReply` and the outbound queue; a marker in session state keeps it idempotent; `/history [N]` is the manual form, registered in the shell, help and remote command tables (AC6 to AC15).

## Steps

1. Operator answers the open questions in the PRD; AC are adjusted and frozen.
2. Table probe (live send only with the operator's OK), record the result, choose the variant.
3. Table builder, splitting, tests, golden fallbacks.
4. History selection and formatting (pure), then the bridge hook and the marker.
5. `/history` command in the three registries, panel key, sidebar line, transcript notice.
6. Docs, CHANGELOG, version bump, `mkdocs build --strict`.
7. Live acceptance by the operator (AC17).

## Risks

- The markdown form may not scroll sideways, or may open the model's text to a parser (spike S3); the probe exists to find out first.
- A burst of 10 messages into a new topic meets the group rate limit; the digest form (Q3) is the cheaper answer.
- The restore must never fire for a reused topic or on a retry, or the operator gets duplicates.
- Flow 395 has an unconfirmed live AC11; the table work touches the same code (Q12).
