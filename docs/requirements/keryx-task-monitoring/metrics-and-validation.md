# Keryx Task Monitoring — Metrics and Validation
Version: 1.0.0

Every criterion in this package is stated as a measurable invariant with a named
proof. **No row is `met`**: nothing in this package is implemented, so each row's
"Proof" column names the test that will have to exist for it to move, and each
status is `planned`.

Two rows are `closed` instead — the scheduler and the streaming monitor. They
are not unbuilt work waiting for a proof; they are decisions, and a row that
says so is the point of recording them here rather than quietly dropping them.

## Invariants

| # | Invariant | Measure | Proof | Status |
|---|---|---|---|---|
| M1 | A never-exiting task can be waited on to a known state without a poll per round. | Rounds consumed between starting the task and learning it is ready. | New `shell-task-condition.test.ts`: a fake task that prints a banner line and never exits; one `shell_task_wait` with `until_output` returns `reason: "match"` while `status` is still `running`. Paired with the negative: the same scenario without the field returns at the clamp having learned nothing. (AC1) | planned |
| M2 | One predicate wait cannot flood a turn. | Bytes and line count in the tool result. | Same file: a task printing 2 MiB around the matching line yields ≤ `MAX_CONDITION_RESULT_BYTES` (4 000), ≤ `MAX_CONDITION_MATCHES` (10) lines, each ≤ `MAX_CONDITION_MATCH_LINE_BYTES` (400). Asserted on the result, not on the matcher, so a future refactor cannot pass by bounding the wrong thing. (AC3, S2) | planned |
| M3 | An already-satisfied condition returns immediately, not at the clamp. | Wall time from call to result, against an injected clock. | Same file: the line is written before the wait is issued; the wait returns without the timer advancing. This is the anti-hang pair to M1. (AC2) | planned |
| M4 | A predicate wait never kills and never changes a task's phase. | Task status, `killReason` and `phase` before and after. | Same file: after a `timeout` and after a `match`, the task is still `running`, `killReason` is unset and `phase` is unchanged. Mirrors the existing "NEVER kills" guarantee proved for the exit wait in `shell-task-tools.test.ts`. (AC4, F5) | planned |
| M5 | A match does not consume a completion. | Whether the completion notification still arrives, exactly once. | Same file plus `agent-task-notification.test.ts`: a predicate wait ends on a match; the task later exits; exactly one `<task-notification>` is drained for it. The existing exactly-once proof (`background-job-registry.test.ts`, "two drains in the SAME synchronous tick never both return the task") must still pass. (AC5, S3) | planned |
| M6 | Matching does not make the output hot path expensive. | Work per appended chunk. | A test that appends N chunks with a registered waiter and asserts the matcher inspects each chunk once (instrumented counter), not the whole ring; plus the TUI repaint guard (`src/tui/tui-shell.ts:2674`) still holding under a chatty task. (N1, R3) | planned |
| M7 | Abort releases a predicate wait without killing. | Time from abort to tool result; task status. | Same file: abort against a 300 000 ms predicate wait returns promptly with `reason: "interrupted"` and every task still `running` — the same shape as the shipped proof for the exit wait (`shell-task-tools.test.ts`, flow-266 AC7). (AC6) | planned |
| M8 | The wake rails are untouched. | Auto-wake count, hold behaviour, notification shape. | The existing suites must pass unchanged: `agent-task-notification.test.ts` (cap, hold, notification envelope), `shell.test.ts` and `tui-shell.test.ts` (both REPLs apply the cap and reset on operator input). No new assertion is needed — the claim is that nothing changed, and the proof is that nothing broke. (AC9, S3) | planned |
| M9 | `until_output` absent ⇒ today's behaviour. | Result shape and timing of every existing wait case. | `shell-task-tools.test.ts` AC2/AC3 must pass byte-identically. (AC7) | planned |
| M10 | Malformed conditions are refused, not downgraded. | Tool result on empty, over-long and unknown-`task_id` input. | Same file: each is an input error naming the field; none silently becomes an exit wait, which would be a wait that looks like it is watching and is not. (AC8) | planned |
| M11 | A recurring scheduler is not built. | — | CLOSED by decision, not deferred. The execution half is already available as one supervised task (`MAX_TASK_IDLE_TIMEOUT_MS = 1_800_000`, `src/harness/tool/builtin/background-job-registry.ts:327`), and a scheduler either honours `DEFAULT_MAX_AUTO_WAKE = 5` (`src/commands/agent.ts:487`) and stops after five firings, or is exempted and deletes the rail. See brainstorm.md D-01. | closed (out of scope) |
| M12 | Push on new output is not built. | — | CLOSED by decision, not deferred. The human's live view already exists (`src/tui/background-job-inspector.ts:224-227`), and a per-chunk injection is the recurring-reminder shape the parent package's D-06 rejected. The `output` event that would enable it stays TUI-only (`background-job-registry.ts:188`, `:532`). See brainstorm.md D-02. | closed (out of scope) |

## Measurement discipline

Inherited from the parent package, and binding here:

- **No wall-clock assertions where a controlled seam exists.** M3 and M7 are
  timing claims and must run against an injected clock, not a real sleep. The
  registry's existing tests establish the pattern.
- **Pairs, not single observations.** M1 asserts both that the predicate wait
  returns and that the same scenario without it does not; M4 asserts the task is
  alive after both a match and a timeout. "Nothing happened" must not be able to
  pass as "the boundary held".
- **Assert the result, not the mechanism.** M2 measures the bytes in the tool
  result, because that is what reaches the context window; a matcher that is
  internally bounded but formats verbosely would still fail the real invariant.
- **A closed row states the decision and its grounds.** M11 and M12 carry
  `file:line` for why, so a later reader can re-open the decision on evidence
  rather than re-derive it.
- **No claim without a `file:line` or a test.** Nothing in this package is
  `met`; every row names the test that would move it.

## Regression surface

The change is additive and confined, so the proof that it is safe is mostly that
existing suites still pass:

| Surface | Existing proof that must keep passing |
|---|---|
| Exit-wait semantics, clamp, never-kills | `src/commands/shell-task-tools.test.ts` |
| Registry bounds, cursor rebasing, exactly-once drain | `src/harness/tool/builtin/background-job-registry.test.ts` |
| Completion delivery, hold, auto-wake cap, notification shape | `src/commands/agent-task-notification.test.ts` |
| Both REPLs' wake loops and cap reset | `src/commands/shell.test.ts`, `src/tui/tui-shell.test.ts` |
| Side-worker deny set (`shell_task_wait` denied, `shell_task_output` allowed) | `src/tui/tui-shell.test.ts`, `src/commands/shell-task-tools.test.ts` |
| Tool list composition | `src/commands/interactive-agent-tools.test.ts` |
| TUI store/inspector output handling | `src/tui/background-job-inspector.test.ts` |

If Recommendation 3 is not adopted, this table is the whole validation story:
the package's remaining output is two closures and a wiki correction, and
nothing to test.
