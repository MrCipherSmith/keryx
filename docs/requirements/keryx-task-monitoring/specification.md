# Keryx Task Monitoring — Specification
Version: 1.0.0

Status: **nothing in this document is implemented.** Every section describing
behaviour is `planned`. Sections describing what exists today carry a
`file:line`.

This document specifies only Recommendation 3 of [prd.md](prd.md) — the
predicate wait. Recommendations 1 and 2 (close the scheduler, close the
streaming monitor) have no implementation and are recorded in
[brainstorm.md](brainstorm.md) D-01 and D-02.

## 1. Module identity

| Field | Value |
|---|---|
| Package | `keryx-task-monitoring` |
| Subsystem | Interactive agent shell execution (`src/harness/tool/builtin/`) |
| Kind | extension to a shipped module |
| Follows on from | `keryx-background-task-execution` D-08 |
| Owner surface | `shell_task_wait`, one optional input field |

### 1.1 Current state (exists today)

- `shell_task_wait` is built in
  `src/harness/tool/builtin/background-job-registry.ts`; its timeout is clamped
  by `clampTaskWaitMs` (`:1140`) against `MAX_TASK_WAIT_MS = 300_000` (`:1129`),
  applied at `:1194`.
- The wait primitive under it is `waitForExit(jobId, ms)`
  (`:273`), whose result alphabet is `"exited" | "timeout" | "unknown"`. There
  is **no output-condition primitive anywhere in the registry**: a search of the
  file for pattern/regex/match/filter returns only unrelated `.filter()` calls
  on the job map (`:559`, `:570`, `:920`).
- Output is readable from an explicit, absolute cursor via `readOutputSince`
  (`:256-266`), which returns `{ output, nextCursor, missed, status }` and
  never marks a task observed — the caller decides that (`markObserved`,
  `:267`).
- Output is retained in a ring capped at `MAX_BACKGROUND_OUTPUT_BYTES =
  2 * 1024 * 1024` (`:138`), shrunk to `TERMINATED_OUTPUT_TAIL_BYTES = 4_000`
  (`:161`) once a completion is delivered, with a separate head snapshot of
  `TASK_OUTPUT_HEAD_BYTES = 24_000` (`:177`).
- Output already exists as an **event**: `BackgroundJobEvent` includes an
  `{ type: "output"; jobId; chunk; stream }` variant (union declared at
  `:188`). Today it is delivered only to the TUI store via the registry's
  `onEvent` option (`:532`, `:543`) and `src/tui/job-bridge.ts`; nothing routes
  it to the agent.
- `shell_task_wait` is denied to side workers
  (`src/tui/tui-shell.ts:249-267`, filter applied at `:4367`) and is exempt from
  the per-signature attempt cap (`src/commands/agent.ts:456-464`).
- Completion delivery is independent of reads: `drainUndelivered` returns only
  terminal, unobserved, background-phase tasks (declared `background-job-registry.ts:292`;
  drained in `src/commands/agent.ts:1273`, `:1599`, `:1653`).

### 1.2 Target state (planned)

`shell_task_wait` gains one optional input field. The registry gains one
internal condition-matcher fed by the chunk it already appends to the ring. No
new tool, no new event, no new lifetime, no new env var.

## 2. Structure (planned)

No new files. The change is confined to:

```text
src/harness/tool/builtin/
  background-job-registry.ts   # + waitForCondition primitive, + the tool's new input field
```

The `output` event variant (`:188`) is the internal signal the matcher runs on;
it is **not** exposed to the agent (D-02).

## 3. Configuration

No new setting. The predicate wait reuses, unchanged:

| Setting | Where | Value | Role here |
|---|---|---|---|
| `MAX_TASK_WAIT_MS` | `background-job-registry.ts:1129` | 300 000 | The clamp on the whole wait, predicate or not (N4). |
| `MAX_CONDITION_PATTERN_BYTES` | new constant, planned | 200 | Longest accepted condition (D-05). |
| `MAX_CONDITION_MATCHES` | new constant, planned | 10 | Matched lines returned per wait (D-05). |
| `MAX_CONDITION_MATCH_LINE_BYTES` | new constant, planned | 400 | Per-line truncation (D-05). |
| `MAX_CONDITION_RESULT_BYTES` | new constant, planned | 4 000 | Total matched bytes per wait, mirroring `NOTIFICATION_OUTPUT_TAIL_BYTES` (`src/commands/agent.ts:516`). |

The four new constants are **module constants, not env overrides**, on purpose:
an operator who can raise the context bound will, and the bound is the whole
safety argument (D-05).

## 4. Tool surface

### 4.1 `shell_task_wait` (changed, planned)

Input today is `{ task_ids, mode, timeout_ms? }`
(`.metaproject/wiki/architecture/background-jobs.md:73`). Planned input adds:

```
until_output?: {
  contains: string,        // literal substring, ≤ 200 bytes, non-empty
  task_id?: string,        // default: any of task_ids
  since?: number           // absolute cursor; default 0 (scan retained output)
}
```

Behaviour (planned):

1. Clamp `timeout_ms` with the existing `clampTaskWaitMs` (`:1140`). Unchanged.
2. If `until_output` is absent, behave exactly as today. The existing path is
   not re-implemented.
3. Scan retained output from `since` for `contains`, **before** waiting. A
   condition already satisfied returns immediately (F3).
4. Otherwise wait for the first of: the `any`/`all` exit condition, a matching
   chunk appended to a named task, the clamped timeout, or the turn's abort
   signal (which the tool already receives — `src/harness/tool/builtin/interactive-tools.ts:35`).
5. Return each task's status and next cursor, plus `reason` and `matches`.

Output (planned): the existing per-task status result, plus

| Field | Meaning |
|---|---|
| `reason` | `"exit"` \| `"match"` \| `"timeout"` \| `"interrupted"` — why the wait ended (F4). |
| `matches` | Matched lines only: at most `MAX_CONDITION_MATCHES`, each truncated to `MAX_CONDITION_MATCH_LINE_BYTES`, total ≤ `MAX_CONDITION_RESULT_BYTES`, each with its task id and the cursor at which it was found. |

Rules (planned):

- A predicate wait **never kills, promotes or demotes** (F5) — identical to the
  exit wait, which "NEVER kills" (`background-jobs.md:73`).
- A wait that ends on `match` with the task still running **does not mark it
  observed** (F6), so the completion notification is still delivered later by
  the existing drain. A wait that ends on `exit` follows today's rule unchanged:
  the main-session copy marks observed, the side-worker copy would not — moot,
  since side workers cannot call this tool at all (`src/tui/tui-shell.ts:264-266`).
- `contains` is a **literal substring**, case-sensitive. Not a regex (N2, D-05).
- An empty or over-long `contains`, or a `task_id` outside `task_ids`, is a tool
  input error, not a silent fallback to an exit wait.

### 4.2 Tools NOT added

No `monitor` tool (D-02). No `/loop`, `/watch` or `/every` slash command
(D-01) — the command list in `src/commands/agent-commands.ts:62-290` gains
nothing.

## 5. Data contracts

No new persisted shape and no new schema file. The predicate wait adds fields to
one tool result; the task record (`BackgroundJobInfo`) and the completion record
(`TaskCompletion`, `background-job-registry.ts:222-232`) are unchanged, which is
what keeps the notification builder (`src/commands/agent.ts:531`) untouched.

## 6. Integration points

| Point | Change (planned) | Must not change |
|---|---|---|
| Registry output path | The appended chunk is offered to any registered condition waiter before/after the ring append. | Ring cap, cursor rebasing on truncation, the auto-kill rail, and the `onEvent` feed to the TUI. |
| Completion delivery (`src/commands/agent.ts:1273`, `:1599`, `:1653`) | None. | Exactly-once drain; a predicate wait must not consume a completion. |
| Wake path | **None.** The predicate wait resolves its own tool call inside the turn that made it (D-04). | `KERYX_SHELL_HOLD_MS` (`agent.ts:467`, default `:476`), `KERYX_SHELL_MAX_AUTO_WAKE` (`:479`, default `:487`), and the readline/TUI wake loops (`src/commands/shell.ts:1411-1437`, `src/tui/tui-shell.ts:4449`). |
| Side workers | None. `shell_task_wait` is already denied (`src/tui/tui-shell.ts:264`). | The deny set and the `risk === "read"` filter. |
| Approval gate / OS sandbox | None. No new command is run. | Everything. |
| Session lifecycle | None. A predicate waiter is released by the session sweep like any other wait. | Tasks die with their session (D-06). |
| TUI | None. The predicate wait produces no new event and no new block. | The repaint guard (`src/tui/tui-shell.ts:2674`). |

### 6.1 Why there is no new wake channel

This is the load-bearing design decision and it is what keeps the package small.
A predicate wait is a **blocking tool call**, not a subscription. It returns to
the model that called it, inside the turn that called it, through the tool
result it was already waiting on. Consequently:

- It cannot start a turn, so it cannot consume an auto-wake and the cap of 5
  (`src/commands/agent.ts:487`) is arithmetically unaffected.
- It cannot fire in an idle session, because in an idle session nobody called
  it.
- It interacts with the hold only by ending sooner: a `hold` session's wait for
  its own tasks (`src/commands/agent.ts:1617`) is a separate mechanism on the
  registry's `onCompletion`, untouched here.

## 7. Acceptance criteria

| # | Criterion |
|---|---|
| AC1 | A predicate wait on a never-exiting task returns on the matching line, with `reason: "match"`, while the task stays `running`. (F1, S1) |
| AC2 | A condition already present in retained output returns immediately rather than at the clamp. (F3) |
| AC3 | A task that prints megabytes around the matching line returns at most `MAX_CONDITION_RESULT_BYTES`, at most `MAX_CONDITION_MATCHES` lines, each at most `MAX_CONDITION_MATCH_LINE_BYTES`. (F2, S2) |
| AC4 | A condition that never appears returns at the clamped timeout with `reason: "timeout"`, each task's status, and the task still running and unkilled. (F5, R2) |
| AC5 | A predicate wait that ends on a match leaves the task's completion undelivered; the completion notification still arrives afterwards, exactly once. (F6, S3) |
| AC6 | An aborted turn ends a predicate wait promptly with `reason: "interrupted"`, leaving every task running. (matches the shipped rule at `interactive-tools.ts:35`) |
| AC7 | `until_output` absent ⇒ byte-identical behaviour to today's `shell_task_wait`. (F7) |
| AC8 | Malformed conditions (empty, over-long, unknown `task_id`) are refused as input errors, never silently downgraded to an exit wait. |
| AC9 | No new tool name, slash command or env var appears; the auto-wake cap, hold and drain paths are untouched. (F7, S3) |

## 8. Migration and compatibility

- Purely additive: one optional input field. Existing calls are unaffected
  (AC7).
- No deprecation, no alias, no removal. `shell_task_output` remains the general
  read and is **not** discouraged — the predicate wait answers a yes/no
  question, not "show me the output" (D-07).

## 9. Out of scope

See [brainstorm.md](brainstorm.md) D-01, D-02, D-04, D-06. In short: no
scheduler, no `/loop`, no push on output, no streaming, no new wake channel, no
change to task lifetime, and no on-disk output (still the parent package's
D-18).
