# Keryx Shell Task Transcripts — Metrics and Validation
Version: 1.0.0

Every criterion in this package is stated as a measurable invariant with a named
proof. **Nothing has shipped**, so every row is `planned` and its "Proof" column
names the test that will have to exist — and pass — for the row to move. No row
may be marked met by a source audit alone where an executable seam exists; the
two rows that genuinely have no headless seam (M13, M17) say so and name the
audit they will settle for, following the `met (P1, audit)` precedent of
[keryx-background-task-execution](../keryx-background-task-execution/metrics-and-validation.md).

The proofs below are named against planned files
(`shell-task-transcript.test.ts`, `shell-task-transcript-read.test.ts`,
`shell-task-transcript-redaction.test.ts`) plus existing suites that must keep
passing (§Regression surface).

## Invariants

| # | Invariant | Measure | Proof | Status |
|---|---|---|---|---|
| M1 | A transcript starts at the command's first byte, not at the threshold that opened it. | First bytes of the file vs first bytes the command emitted. | `shell-task-transcript.test.ts`, AC1: a fake emitting a known 40 000-byte sequence, opened at the 24 000-byte threshold (`TASK_OUTPUT_HEAD_BYTES`, `background-job-registry.ts:177`); the file's first 100 bytes equal the stream's first 100. Paired with a promoted-at-yield task that emitted only 10 bytes before promotion. | planned |
| M2 | A short command that exits inside its yield leaves no file and no directory. | Directory listing after the call. | `shell-task-transcript.test.ts`, AC2: `shell_exec` against a fake that exits in 5 ms with 200 bytes of output; the session `tasks/` dir does not exist. Paired with the same command emitting 30 000 bytes, which does create one. | planned |
| M3 | A secret contained in one flush is masked in the file. | File content vs the raw stream. | `shell-task-transcript-redaction.test.ts`: a command echoing a `ghp_`-shaped token (`src/security/detect/secrets.ts:30`); the file contains `[REDACTED:secret]` and no substring of the token. | planned |
| M4 | **A secret split across a flush boundary is masked exactly as whole-text redaction would mask it.** | File content vs `redactSensitiveText(wholeStream)` (`src/security/redact.ts:128`). | `shell-task-transcript-redaction.test.ts`, the boundary pair: the same token emitted as two chunks split at every offset inside it (parameterised over the token's length), each run asserting the file contains no fragment of the token and that the file's mask count equals the whole-text mask count. The negative half — a token that is NOT split — must also pass, so "nothing was written at all" cannot masquerade as "the boundary held". | planned |
| M5 | An unterminated private-key block fails closed. | File content after a task that emits `-----BEGIN RSA PRIVATE KEY-----` and never an END. | `shell-task-transcript-redaction.test.ts`: the body from the marker onward is masked; no base64 line of the key body appears; the index records the masking. The rule exists because the pattern is unbounded (`src/security/detect/secrets.ts:65-71`) and no carry window can contain it. | planned |
| M6 | The stored command is redacted, never the registry's raw string. | Header line and index record vs `BackgroundJobInfo.command` (`background-job-registry.ts:62`). | `shell-task-transcript.test.ts`, AC4: a task started with `curl -H "Authorization: Bearer ghp_…"`; the registry's in-memory `command` still holds the raw string (unchanged behaviour), while the header and the index record hold the mask. | planned |
| M7 | The feature off is byte-identical to today. | Tool results, task statuses, and the filesystem, with `KERYX_SHELL_TRANSCRIPTS=0`. | `shell-task-transcript.test.ts`, AC5: the existing `shell-exec-background.test.ts` scenarios re-run with the flag off produce identical results and create no path under the session dir. | planned |
| M8 | The store is owner-only, outside the repository, and outside the sandbox's writable roots. | Directory and file modes; absolute path; the sandbox profile's writable roots. | `shell-task-transcript.test.ts`: dir `0o700` / file `0o600` on POSIX (skipped on Windows, matching `src/session/store.ts:154`); the resolved path is under `keryxDataDir()` (`src/session/paths.ts:29`) and not under the project root; and an assertion that the path is not covered by `defaultSandboxProfile(cwd, tmpDir).writableRoots` (`src/harness/process/sandbox/profile.ts:177-186`). | planned |
| M9 | The sink never changes task timing or the idle rail. | Time spent inside `appendOutput`; idle-kill timing with a slow sink. | `shell-task-transcript.test.ts`, N2: a sink whose write never resolves; the task still completes, its idle timer still fires at `idleTimeoutMs` (`armIdleTimer`, `background-job-registry.ts:636`), and the transcript records `truncated: "io-error"` rather than the task stalling or being killed. | planned |
| M10 | An unfooted transcript is never read as a success. | Reader output for a file with no footer. | `shell-task-transcript-read.test.ts`, AC7: a transcript truncated mid-body reports an unknown outcome; the index record carries `footerPresent: false`. Mirrors the started-vs-completed discipline of the retention stamp (`src/retention/auto-sweep.ts:103-113`). | planned |
| M11 | Retention removes oldest-first with a stated reason, and an unreachable store is `incomplete`. | Sweep report entries and target status. | Retention suite rows beside `src/retention/sweep.test.ts`: over-age entries reported `reason: "age"`, over-cap entries `reason: "bytes-cap"` (`sweep.ts:32-45`); an unreadable `tasks/` dir yields `status: "incomplete"` with a reason, never `ok` (`sweep.ts:5-18`); dry run removes nothing. | planned |
| M12 | **The completion notification's tail is redacted before it enters provider-bound history.** | History content after a task whose output contains a token. | `agent-task-notification.test.ts`, AC6: a task emitting a `ghp_`-shaped token completes; the pushed `user`/`provenance: "tool"` message contains `[REDACTED:secret]` and no fragment of the token. This is the gap at `src/commands/agent.ts:531-552` (pushed at `:1277`, `:1601`, `:1655`, `:1960`) measured against the treatment every tool result already gets at `:1857`. | planned |
| M13 | Sweep ownership is real: session close sweeps its own dir, and the daily trigger cannot be starved by the gdctx one. | Which directories are swept, and when; stamp files after each trigger. | Executable half in the retention suite: two triggers with separate stamps (`last-auto-sweep.json` vs `last-auto-sweep-transcripts.json`) both run within one day, where one shared stamp would suppress the second. Audit half in `shell.test.ts` / `tui-shell.test.ts` for the session-exit call sites (`src/commands/shell.ts:1447`, `:1458`; `src/tui/tui-shell.ts:2380`, `:4503`, `:4703`) — the REPL exit paths have no headless seam, exactly as the previous package found for its wake cap. | planned (audit for the exit-path half) |
| M14 | A transcript-served read is flush-aligned, never skips, and is capped. | Bytes returned vs the raw stream, over a sequence of cursor calls. | `shell-task-transcript-read.test.ts`, AC11: a 500 KB task read back from `since: 0` in pages; concatenating the pages, with the disclosed at-most-one-flush overlap removed, reproduces the redacted stream with no gap. A `since` the ring cannot serve returns bytes rather than `missed` (`background-job-registry.ts:870`, rendered at `:1085`); a range the transcript also cannot serve still returns `missed`, with the trailer naming which. Per-call bytes never exceed 64 000. | planned |
| M15 | No model-visible string carries a path, and a side worker still cannot suppress a notification. | Tool result text; `observed` after a side-worker read. | `shell-task-transcript-read.test.ts`, AC12: every `shell_task_output` result — trailer included — is asserted free of the session-dir path and of any `/` path fragment of the store; and a side-worker copy (`observer: "side"`, `background-job-registry.ts:1081`) reading a FINISHED task from the transcript leaves the main session's completion still drainable (`drainUndelivered`, `:951-980`). | planned |
| M16 | The in-memory bounds are unchanged. | Existing registry suites. | `background-job-registry.test.ts` unchanged and passing: the 2 MiB ring and its `output-cap` auto-kill (`:138`, `:638-653`), the 4 000-byte shrink (`:161`, `:622-628`), the 24 000-byte head (`:177`), the 50-task LRU (`:152`, `:605-612`), cursor rebasing after truncation. A change in any of these numbers is a failure of this package, not a feature of it. | planned |
| M17 | The operator can obtain a transcript path in both shells, including while the turn is busy. | Command dispatch and printed output. | Audit rows in `shell.test.ts` and `tui-shell.test.ts`, following the `/demote` precedent: `/transcript` is present in the command registry and in the busy-dispatch allow-list in both shells. Named as an audit because neither REPL loop has a headless seam; the effect it calls is covered by execution in `shell-task-transcript-read.test.ts`. | planned |

## Measurement discipline

- **Pairs, not single observations.** M1, M2 and M4 each assert the positive and
  the negative case. A redaction test that passes because nothing was written is
  the specific false pass this package must not accept.
- **The invariant is stated over the whole stream, not over a chunk.** M4
  compares the file against `redactSensitiveText(wholeStream)` rather than
  against a hand-written expectation, so the test cannot drift from the
  scrubber's actual behaviour when a detector rule changes.
- **Parameterise the split.** M4 splits the token at *every* interior offset
  rather than one convenient one; a boundary bug that only shows at a particular
  alignment is exactly the bug this row exists to catch.
- **No wall-clock assertions where a seam exists.** M9 uses an injected sink and
  the registry's existing injectable clock/timer rather than real sleeps.
- **No claim without a `file:line` or a test.** Every row here is `planned`;
  none may be marked met by reading the code.
- **An audit is named as an audit.** M13's exit-path half and M17 say plainly
  that they pin wiring rather than execute it, and name the executed test that
  carries the load-bearing behaviour.

## Regression surface

| Surface | Existing proof that must keep passing |
|---|---|
| Ring bounds, process-group kill, cursor rebasing, drain semantics | `src/harness/tool/builtin/background-job-registry.test.ts` |
| Yield, promotion, synchronous-shaped result, idle message | `src/harness/tool/builtin/shell-exec-background.test.ts`, `shell-exec-tool.test.ts`, `shell-exec-timeout.test.ts` |
| Exactly-once completion delivery and notification shape | `src/commands/agent-task-notification.test.ts` |
| Task tools, side-worker rules, abort behaviour | `shell-task-tools.test.ts` |
| Approval across permission modes | `src/commands/agent-permission-mode.test.ts` |
| Session-scoped sweep and REPL wiring | `src/commands/shell.test.ts`, `src/tui/tui-shell.test.ts` |
| Tool registration | `src/commands/interactive-agent-tools.test.ts` |
| Redaction behaviour the sink depends on | `src/security/redact.test.ts` |
| Retention engine, policy and throttle | `src/retention/sweep.test.ts`, `policy.test.ts`, `auto-sweep.test.ts` |
| Session store modes and atomic writes | `src/session/` store suites |
