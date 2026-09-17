# Keryx Shell Task Transcripts — PRD
Version: 1.0.0

## Problem

A supervised shell task's output exists only in memory, under bounds chosen to
protect the process rather than the operator. Four independent paths destroy it
(README §What is actually lost today), and the earliest output — the part that
usually names the first error — is the part destroyed first or hidden best.

### The concrete failure

A build runs for six minutes and fails. Its first compiler error scrolled past
minute one. The model is notified on completion and receives **4 000 bytes of
tail** (`NOTIFICATION_OUTPUT_TAIL_BYTES`, `src/commands/agent.ts:516`), which
holds the summary line "1 error" and not the error. The model calls
`shell_task_output` to look further back and gets the ring, which
`shrinkTerminatedOutput` reduced to the same 4 000 chars the moment the task
exited (`src/harness/tool/builtin/background-job-registry.ts:622-628`). The
first 24 000 bytes do still exist, in `info.outputHead` (`:88-95`), but no read
tool serves them: `readOutputSince` reads `outputBuffer` only (`:861-879`). The
operator cannot recover them either — nothing was written to disk. The only
remedy is to run the six-minute build again.

At 50 tracked tasks the record is evicted entirely (`:605-612`); at session exit
everything goes (`:945-949`).

### Why the existing stores do not cover this

- `keryx ctx run` writes raw command output under `.metaproject/data/gdctx/raw`
  (`src/commands/ctx.ts:755`) with a real retention policy behind it
  (`src/retention/policy.ts:79-98`). But that is a *different* execution path —
  an operator-invoked routed command, not a model-started supervised task — and
  nothing routes `shell_exec` through it.
- The session store persists conversation history, redacted, to
  `<dataDir>/sessions/<project-key>/<session-id>/` (`src/session/paths.ts:3-8`,
  `store.ts:308-321`). It records the **notification and tool results** the model
  saw, which are already truncated; it never sees the bytes that were dropped.

So the output exists nowhere once the ring moves on.

## Goal

1. Every supervised task that could lose output has a durable transcript.
2. No plaintext secret or PII that `redactSensitiveText` would catch is ever
   written to that transcript.
3. The store is bounded by a stated policy with a named owner, and says what it
   removed.
4. The model can reach the recovered bytes through the tool it already uses, and
   is never handed a filesystem path.
5. The in-memory bounds, the approval gate, the sandbox and the session-scoped
   *task* lifetime are unchanged.

## Users

| User | Need |
|---|---|
| **Interactive operator** | After a long command fails, read what it printed from the start — without re-running it, and after the session that ran it has ended. |
| **Agent (the model choosing tools)** | Ask for output older than the ring holds and receive it, instead of `missed: N bytes … cannot be re-read` (`background-job-registry.ts:1085`). |
| **Security reviewer** | Proof that a new on-disk store of raw command output does not become a credential store: what is scrubbed, when, where the file lives, who can read it, and when it is deleted. |
| **Maintainer** | One write funnel, one scrubber, one retention engine — no second copy of any of the three. |

## Requirements

### Functional

| # | Requirement |
|---|---|
| F1 | A supervised task gets a transcript file once it either outlives its yield (is promoted to `background`) or exceeds `TASK_OUTPUT_HEAD_BYTES` of output, whichever comes first. A command that exits inside its yield and stayed small leaves no file. |
| F2 | When a transcript is opened, the bytes already buffered are written first, so the transcript starts at the command's first byte, not at the threshold. |
| F3 | Every byte written to a transcript passes `redactSensitiveText` (`src/security/redact.ts:128`) first. Nothing is written raw and scrubbed later. |
| F4 | Redaction is correct across flush boundaries: a secret split across two chunks is masked exactly as it would be if the whole transcript were scrubbed at once. |
| F5 | The transcript's header records the task id, the **redacted** command, cwd and start time; the footer records terminal status, exit code, kill reason and end time. A transcript with no footer is reported as an unknown outcome, never as success. |
| F6 | `shell_task_output`'s existing cursor contract is extended, not replaced: a `since` the ring can no longer serve is answered from the transcript instead of being reported as `missed`. No new tool, no path in any model-visible string. |
| F7 | The operator can obtain a transcript's path for a task in both shells, and the store is visible to `keryx retention status`. |
| F8 | The completion notification's output tail is redacted with the same function before it enters provider-bound history — closing the gap at `src/commands/agent.ts:531-552`, where the tail is pushed at `:1277`, `:1601`, `:1655` and `:1960` with no call to `redactSensitiveText`, while every ordinary tool result is scrubbed at `:1857`. |
| F9 | Transcripts are bounded per task and per project by an explicit policy, and removal is reported per entry with a reason. |
| F10 | The whole feature can be turned off by one operator env setting, and off means no file is created at all. |

### Non-functional

| # | Requirement |
|---|---|
| N1 | Zero new npm dependencies; `node:fs` and existing helpers only. |
| N2 | The write path must not block `appendOutput` (`background-job-registry.ts:630`) on disk I/O in a way that changes task timing or the idle timer (`armIdleTimer`, `:636`). |
| N3 | Directory mode `0o700`, file mode `0o600`, matching the session store (`src/session/store.ts:166`, `:212`), best-effort on platforms without POSIX modes. |
| N4 | The store lives outside every repository working tree, so no `git add -A` can commit it. |
| N5 | The store lives outside the OS sandbox's writable roots (`defaultSandboxProfile` grants `[cwd, tmpDir]`, `src/harness/process/sandbox/profile.ts:177-186`), so a sandboxed child cannot read, forge or delete another task's transcript. |
| N6 | The in-memory bounds are untouched: the 2 MiB ring, the 4 000-byte shrink, the 24 000-byte head and the 50-task LRU keep their current values and behaviour. |

## Success criteria

| # | Criterion | Status |
|---|---|---|
| S1 | The motivating case: a task that printed 500 KB and failed can have its first 1 000 bytes read back after the completion was delivered. | planned |
| S2 | A command that echoes a GitHub token leaves no copy of that token on disk — including when the token straddles two write flushes. | planned |
| S3 | A short command that exits inside its yield creates no file. | planned |
| S4 | A project whose transcripts exceed the store's byte cap has its oldest transcripts removed, and `keryx retention status` says how many and why. | planned |
| S5 | The model never receives a filesystem path for a transcript, and a side worker cannot use the transcript to advance a main-session cursor or suppress a notification. | planned |
| S6 | Turning the feature off leaves behaviour byte-identical to today. | planned |
| S7 | No implementation claim in this package is unsupported by a `file:line`. | documentation check, not a runtime claim |

## Risks

| # | Risk | Mitigation | Residual |
|---|---|---|---|
| R1 | **A new plaintext store of raw command output.** This is the package's sharpest risk: the in-memory path is scrubbed once, at one place (`agent.ts:1857`); a file bypasses it entirely. | Redact on the write path before any byte reaches disk (F3), owner-only modes (N3), outside the repo (N4) and outside the sandbox's writable roots (N5), bounded lifetime (F9). | The scrubber is a deterministic regex floor — "regex only — no model, no config, no IO" (`src/security/redact.ts:121-127`). A credential in a shape no rule matches is written in the clear. |
| R2 | **Chunk-boundary leakage.** `redactSensitiveText` is whole-string; streaming redaction can split a secret across two calls and mask neither half. | A carry window and a line-boundary rule (specification §5.2), with a dedicated proof (metrics M4). | A pattern longer than the carry window — notably the unbounded `PRIVATE KEY` block (`src/security/detect/secrets.ts:65-71`) — is handled by an explicit rule rather than by the window, and that rule is the thing to review hardest. |
| R3 | The store grows without bound, as `.metaproject/data/gdctx/raw` did — 8 126 entries and ~297 MiB with a policy that nothing invoked (`src/retention/auto-sweep.ts:9-16`). | The policy is a target of the existing engine from day one, and the automatic trigger is specified with it, not deferred (specification §6). | A machine that never opens a session again keeps its last transcripts until something sweeps; the age cap is what bounds that. |
| R4 | A durable artifact contradicts the previous package's session-scoping line (D-04 there). | The **task** still dies with its session; the transcript is inert data with no handle, and a stale id still resolves to `unknown task_id` (previous package D-14). | An operator may reasonably expect `keryx` to leave nothing behind; the store is an explicit, documented, disable-able exception. |
| R5 | Disk I/O on the output funnel changes task timing or the idle rail. | Append asynchronously with a bounded queue; never await inside `appendOutput` (N2). | A slow or full disk degrades to dropped transcript bytes with a recorded reason — never to a stalled or mis-killed task. |
| R6 | Serving older bytes through `shell_task_output` widens what a **side worker** can read, since that is the one task tool side workers keep (`SIDE_WORKER_DENIED_TOOL_NAMES`, `src/tui/tui-shell.ts:249`). | The cursor stays explicit and still mutates nothing; the side copy still never marks a task observed (previous package D-16). | A side worker can now read further back than the ring holds. Accepted deliberately, not overlooked. |

## Recommendation

Adopt the transcript as a **side-channel of the existing funnel**, not as a new
output path:

- One funnel (`appendOutput`), one scrubber (`redactSensitiveText`), one
  retention engine (`src/retention/sweep.ts`). Adding a second of any of the
  three is the failure mode to avoid.
- Put the store in the session directory, which already has the modes, the
  project scoping and the location outside the repository.
- Do **not** relax the ring or the `output-cap` kill because a durable copy now
  exists; that is a separate decision about when commands die.
- Fix the unredacted notification tail (F8) as part of this work: a package that
  scrubs the disk path while the provider-bound path leaks would be incoherent.

## Gaps

| Gap | Impact | Tracked |
|---|---|---|
| The notification tail is unredacted today. | Command output containing a credential reaches the provider in a `user`-role message without passing the scrubber that every tool result passes. | F8, brainstorm D-13, metrics M12. Owner decision needed on whether it is fixed here or as a defect in the previous package. |
| `RETENTION_SCOPE_NOTE` (`src/retention/sweep.ts:86-90`) states the sweep covers `.metaproject/` only. | A transcript target outside `.metaproject/` makes that note false; a wrong scope note is worse than none. | specification §6.3 names the required edit. |
| No external-harness prior art was surveyed for this package. | The previous package's design was grounded in seven competitor implementations; this one is grounded only in in-repo precedent. | brainstorm §Prior art, marked `unknown`. |
| Whether the TUI inspector should render a transcript inline or only its path. | An inline render puts raw command output into a UI that has never carried it. | specification §7, marked `planned`; not settled here. |
