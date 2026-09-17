# Keryx Shell Task Transcripts — Specification
Version: 1.0.0

Status: **nothing here is implemented.** Every statement about current
behaviour carries a `file:line`; everything else is marked `planned`. Where a
question could not be settled from the code it is marked `unknown` and named in
§12.

## 1. Module identity

| Field | Value |
|---|---|
| Package | `keryx-shell-task-transcripts` |
| Subsystem | Shell task supervision (`src/harness/tool/builtin/`), session storage (`src/session/`), retention (`src/retention/`) |
| Kind | module |
| Extends | `keryx-background-task-execution` D-18 (the deferred on-disk output design) |
| Owner surface | the transcript store, its retention target, and the read surfaces over it |

### 1.1 Current state (exists today)

- Every byte of task output passes through one function, `appendOutput`
  (`src/harness/tool/builtin/background-job-registry.ts:630-651`). It appends to
  the ring, tops up the head snapshot (`:632-635`), re-arms the idle timer
  (`:636`), emits an `output` event (`:637`), and — past
  `MAX_BACKGROUND_OUTPUT_BYTES` (2 MiB, `:138`) — drops the oldest bytes,
  rebases the cursor, adds to `droppedBytes` (`:648-651`) and auto-kills the
  task once with `killReason: "output-cap"` (`:653`).
- On exit the ring is shrunk to `TERMINATED_OUTPUT_TAIL_BYTES` (4 000, `:161`)
  by `shrinkTerminatedOutput` (`:622-628`), which also adds to `droppedBytes`.
- `TASK_OUTPUT_HEAD_BYTES` (24 000, `:177`) of head are kept in
  `info.outputHead` (`:88-95`) and never shrunk, but are served only by
  `shell_exec`'s own in-yield result (`src/harness/tool/builtin/shell-exec-tool.ts:435`).
- `readOutputSince(jobId, since)` (`:861-879`) maps an absolute stream position
  through `droppedBytes` and returns `missed` for anything dropped (`:870`); the
  tool renders that as `[N byte(s) older than your cursor were dropped and
  cannot be re-read]` (`:1085`).
- `shell_task_wait` returns **status lines only**, never output
  (`describeWaitedTask`, `:1147-1153`), and tells the model to read with
  `shell_task_output` (`:1174`).
- Terminated tasks are evicted at `MAX_TRACKED_JOBS` = 50 (`:152`, `:605-612`);
  `sweepAll` kills everything at session exit (`:945-949`).
- Tool output is scrubbed with `redactSensitiveText`
  (`src/security/redact.ts:128`) exactly once, at
  `src/commands/agent.ts:1857`, before entering provider-bound history.
- **The completion notification is not scrubbed.** `buildTaskNotification`
  (`src/commands/agent.ts:531-552`) slices a 4 000-byte tail (`:545-548`) and
  the result is pushed to history at `:1277`, `:1601`, `:1655` and `:1960` with
  no redaction call on the path.
- Session storage: `<dataDir>/sessions/<project-key>/<session-id>/`
  (`src/session/paths.ts:3-8`, `:96`), `dataDir` from `KERYX_DATA_DIR` / XDG /
  `APPDATA` (`:29`). Directories are forced to `0o700`
  (`src/session/store.ts:156-198`, `:201-208`), files written `0o600` through an
  atomic temp+rename (`:210-214`). History is redacted before it is written —
  `content` and each tool call's `arguments` (`:308-321`).
- Retention: `RetentionTarget` is `{id, label, dir, unit, maxAgeDays, maxBytes}`
  over a **non-recursive** listing (`src/retention/policy.ts:56-67`); the engine
  applies age first, then a byte cap oldest-first, and reports every entry with
  an outcome and reason (`src/retention/sweep.ts:32-68`). Targets today are the
  two gdctx stores (`policy.ts:79-98`) and SAC write-conflict sidecars
  (`:126-160`). `RETENTION_SCOPE_NOTE` (`sweep.ts:86-90`) promises the sweep
  touches `.metaproject/` only. An automatic sweep runs at most once per day per
  project behind an atomic claim (`src/retention/auto-sweep.ts:74`, `:85-97`),
  triggered only from the `keryx ctx` write path
  (`src/commands/ctx.ts:774-779`), and can be disabled with
  `KERYX_RETENTION_AUTO` (`auto-sweep.ts:87`).
- The OS sandbox default is workspace-write with writable roots `[cwd, tmpDir]`
  and network off (`src/harness/process/sandbox/profile.ts:177-186`).
- `keryx security redact --file <p> [--out <p>]` (`src/commands/security.ts:107`,
  `:603-619`) and `keryx security check-output [--file <p>]` (`:104`, `:1148`)
  operate on an arbitrary file (`readContent`, `:156`).

### 1.2 Target state (planned)

A **transcript sink** hangs off the existing output funnel. It is lazily opened,
redacted before every write, bounded per task, indexed per session, swept by the
existing retention engine, and readable through the cursor the model already
uses.

## 2. Structure (planned)

```text
src/harness/tool/builtin/
  shell-task-transcript.ts        # sink: lazy open, flush rule, footer, close
  shell-task-transcript-read.ts   # raw-offset → file-offset resolution for reads
src/retention/
  policy.ts                       # + discoverShellTranscriptTargets()
  auto-sweep.ts                   # + maybeAutoSweepShellTranscripts()
```

No new module owns redaction: the sink imports `redactSensitiveText` and the
three detectors it composes (`src/security/redact.ts:128`, `:132`).

## 3. Location and layout (planned)

```text
<dataDir>/sessions/<project-key>/<session-id>/tasks/
  index.jsonl                 # one record per transcript (schema in §8)
  task-<n>-<pid>.log          # the redacted transcript
  task-<n>-<pid>.idx.jsonl    # flush map: raw stream offset → file offset
```

Why here, not elsewhere (D-01):

- It is outside every repository working tree, so no `git add -A` can commit it
  (PRD N4). The `.metaproject/data/**/raw/` alternative is inside the repo and
  relies on a `.gitignore` line (`.gitignore:55`) staying correct.
- It is outside the sandbox's writable roots — `[cwd, tmpDir]`
  (`profile.ts:177-186`) — so a sandboxed child cannot read another task's
  transcript, forge one, or delete the evidence of what it printed (PRD N5).
- It inherits the session store's modes and project scoping
  (`store.ts:156-214`, `paths.ts:91-98`) rather than inventing a second
  convention.

Directory mode `0o700` and file mode `0o600` are set the same best-effort way as
the session store (`store.ts:166`, `:201-208`, `:212`).

## 4. Configuration (planned)

| Setting | Env | Default | Meaning |
|---|---|---|---|
| `transcriptsEnabled` | `KERYX_SHELL_TRANSCRIPTS` | on | `0` / `off` / `false` disables; no file is created at all. |
| `openThresholdBytes` | — | `TASK_OUTPUT_HEAD_BYTES` (24 000, `background-job-registry.ts:177`) | Output size that opens a transcript for a task still in the foreground phase. |
| `maxTranscriptBytes` | `KERYX_SHELL_TRANSCRIPT_MAX_BYTES` | 64 MiB | Per-task written-bytes cap. |
| `carryBytes` | — | 4 096 | Bytes held back from every flush so a split secret is still seen whole (§5.2). |
| `maxPendingBytes` | — | 256 KiB | Force-flush bound for output with no line breaks. |
| `readCapBytes` | — | 64 000 | Max bytes one `shell_task_output` call returns from a transcript. |
| `maxAgeDays` | — | 7 | Retention age cap (§6). |
| `maxBytesPerSession` | — | 50 MiB | Retention byte cap per session `tasks/` directory (§6). |

Resolution follows the existing fail-safe pattern — unset / empty / malformed /
negative falls back to the default, and only an explicit disabling value
disables (`resolveShellYieldMs`, `shell-exec-tool.ts:95`;
`resolveMaxConcurrentBackgroundJobs`, `background-job-registry.ts:113-125`).

## 5. Write path (planned)

### 5.1 Lifecycle

1. **Open (lazy).** A transcript is opened at the first of: the task being
   promoted to the `background` phase (`promote`,
   `background-job-registry.ts:906-925`, reached from the yield/abort path at
   `shell-exec-tool.ts:400`), or its output exceeding `openThresholdBytes`. A
   command that exits inside its yield and stayed under the threshold never
   creates a file (PRD F1/S3) — that is the common case and it must stay
   file-free.
2. **Backfill.** On open, everything buffered so far is flushed first. At the
   threshold nothing has been dropped yet: the ring only drops past 2 MiB
   (`:638-651`) and only shrinks at exit (`:622-628`), so the transcript starts
   at the command's first byte (PRD F2).
3. **Write-through.** Every later `appendOutput` call feeds the sink. The sink
   **never blocks** the funnel: it enqueues and returns, so task timing and the
   idle timer (`:636`) are unchanged (PRD N2). A queue that cannot drain drops
   bytes and records `truncated: "io-error"` in the index — it never stalls or
   kills the task.
4. **Per-task cap.** Past `maxTranscriptBytes`, writing stops and the index
   records `truncated: "task-cap"` with the byte count. Note honestly: with the
   2 MiB ring auto-kill unchanged (D-08), a task cannot normally reach 64 MiB —
   the cap exists for an operator who raises the ring, and as a bound that does
   not depend on another module's constant.
5. **Footer and close.** At terminal status the sink flushes the remainder,
   writes the footer, closes, and appends the index record. A transcript with no
   footer (crash, SIGKILL) is reported by every reader as an unknown outcome,
   never as success — the same discipline as the retention stamp's
   started-vs-completed split (`auto-sweep.ts:103-113`) and the session store's
   `TranscriptUnreadableError` (`store.ts:334-342`).

### 5.2 Redaction rule (the part to review hardest)

`redactSensitiveText` is whole-string (`redact.ts:128-137`): it runs
`detectSecrets` + `detectPii` + `detectExfil` over the text and applies
fixed-width masks (`applyRedaction`, `:95-119`). Applied naively per chunk, a
secret split across two chunks matches neither half and both halves are written
in the clear. The in-memory path has no such hazard because it scrubs one
complete tool result at once (`agent.ts:1857`).

The flush rule, stated as the invariant to implement and prove:

> **No byte sequence that the whole-text detectors would mask ever appears in a
> transcript file.**

Mechanics:

1. Accumulate into `pending`.
2. Run the three detectors over the whole of `pending`.
3. Choose the flush point `F` as the **largest** offset that is simultaneously:
   (a) ≤ `pending.length - carryBytes`, (b) at a line boundary, and (c) not
   inside any detector match.
4. Write `applyRedaction(pending[0..F], matches within [0,F))`. Keep
   `pending[F..]`.
5. **Force-flush.** If `pending` exceeds `maxPendingBytes` with no `F` (output
   with no newlines), relax (b) only, keeping (a) and (c).
6. **Unbounded-pattern guard.** `secrets.private-key-block` is
   `-----BEGIN … PRIVATE KEY-----[\s\S]*?-----END …`
   (`src/security/detect/secrets.ts:65-71`) — unbounded, so the carry window
   cannot contain it. If a BEGIN marker is seen with no END, everything from the
   marker onward is masked as `[REDACTED:secret]` and the sink stays in
   masking mode until an END marker or the task's exit. **Fail closed**: a
   truncated key block is masked, never written and fixed later.
7. On close, step 2–4 run once over whatever remains, with no carry held back.

Consequences to state rather than discover:

- Masks are fixed-width (`maskFor`, `redact.ts:23-25`), so **file offsets do not
  equal stream offsets**. §7.1 handles that explicitly.
- The scrubber is a deterministic regex floor — "regex only — no model, no
  config, no IO" (`redact.ts:121-127`). A credential in an unmatched shape is
  written. The operator's after-the-fact tools are
  `keryx security check-output --file` and `keryx security redact --file --out`
  (`src/commands/security.ts:104`, `:107`, `:603-619`).
- The **command string** is stored raw in the registry
  (`BackgroundJobInfo.command`, `background-job-registry.ts:62`) and routinely
  carries credentials (`curl -H "Authorization: …"`). The header and the index
  record store `redactSensitiveText(command)`, never the raw string.

## 6. Retention (planned)

### 6.1 Target

Age is the primary axis and bytes the backstop, exactly as
`src/retention/policy.ts:26-42` argues for the gdctx stores. Count is not an
axis, for the same reason given there (`:44-50`).

```text
discoverShellTranscriptTargets(cwd) → one target per session tasks/ dir:
  id:         "shell-transcripts:<session-id>"
  dir:        <projectSessionsDir(cwd)>/<session-id>/tasks
  unit:       "file"
  maxAgeDays: 7
  maxBytes:   50 MiB
```

Seven days rather than gdctx's 14 (`policy.ts:69`): this is raw command output,
higher in sensitivity and lower in re-read value than a routed-search summary.

**When the bound is hit:** the existing engine removes oldest-first and reports
each entry with `outcome` and `reason` (`age` | `bytes-cap`,
`sweep.ts:32-45`); an unreadable store or an unremovable entry marks the target
`incomplete` with a stated reason and never folds into a clean success
(`sweep.ts:5-18`). A `tasks/` directory left empty by a sweep is removed; the
session's own `summary.json` / transcript files are **never** a sweep unit —
the target is the `tasks/` directory, never the session directory above it.

**What this does not bound:** a project-wide byte total across sessions. The
engine applies caps per target (`sweep.ts` sweeps each target independently),
so the cross-session bound here is the **age cap**. A project-wide byte cap
would need a new cross-target pass in the engine; it is named as a non-goal
(D-06) rather than implied.

### 6.2 Trigger and owner

| Owner | When | What it sweeps |
|---|---|---|
| Session close | every real session-exit path, beside `sweepBackgroundJobs?.()` (`src/commands/shell.ts:1447`, `:1458`; `src/tui/tui-shell.ts:2380`, `:4503`, `:4703`) | that session's own `tasks/` dir, then removes it if empty |
| Automatic sweep | session **start**, throttled to once per day per project behind its own stamp and atomic claim | every transcript target for the project |
| `keryx retention sweep [--apply]` | operator, dry-run by default (`src/commands/retention.ts:26-55`) | every target, transcripts included |
| `keryx retention status` | operator, read-only (`:103-118`) | reports the store and when the last automatic sweep completed |

The automatic sweep gets **its own** stamp and claim files
(`last-auto-sweep-transcripts.json` / `.claim`) beside the existing pair
(`auto-sweep.ts:90-97`), with the same constants (`:74`, `:85`) and the same
`KERYX_RETENTION_AUTO` off switch (`:87`). Sharing the existing stamp would let
whichever trigger ran first suppress the other for 24 hours — a throttle that
silently disables a sweep is the defect `auto-sweep.ts:46-52` already records
once.

The trigger is session **start**, not the `keryx ctx` write path: ctx does not
write transcripts, and a checkout that never runs a routed search would
otherwise never sweep them (`auto-sweep.ts:20-25` makes the same argument in
the other direction for gdctx).

### 6.3 Required edit to existing code

`RETENTION_SCOPE_NOTE` (`sweep.ts:86-90`) states the sweep covers
`.metaproject/` only and that everything else is "never touched or promised
erased by it". Adding a target outside `.metaproject/` makes that sentence
false. It must be amended in the same change that adds the target — a scope note
that is wrong is worse than no scope note.

## 7. Read surfaces (planned)

### 7.1 Model: no new tool, no path

`shell_task_output(task_id, since?)` (`background-job-registry.ts:1047-1090`)
keeps its contract. The one change: when `since` names a range the ring can no
longer serve — today reported as `missed` (`:870`, rendered at `:1085`) — the
range is served from the transcript instead.

- The `.idx.jsonl` sidecar records one line per flush: raw stream offset, file
  offset, byte counts. A raw `since` resolves to the flush containing it.
- Reads are **flush-aligned**: the result begins at the start of the flush
  containing `since`, so a transcript-served read may repeat at most one flush's
  bytes and **never skips any**. Never-skip is the property that matters; the
  repeat is disclosed in the trailer. This is the price of fixed-width masks
  changing lengths inside a flush (§5.2).
- At most `readCapBytes` (64 000) per call; `next_cursor` advances by what was
  returned, so the model pages through exactly as it does today.
- `missed` is reported only when the transcript is absent, disabled, truncated
  past that range, or unreadable — and the trailer says which.
- **No filesystem path appears in any model-visible string** (D-11), including
  the trailer and the notification.

Side workers keep `shell_task_output` — it is the one task tool they are not
denied (`SIDE_WORKER_DENIED_TOOL_NAMES`, `src/tui/tui-shell.ts:249`; applied at
`:4367`). The cursor stays explicit and mutates nothing, and the side copy still
never marks a task observed (`shellTaskOutputTool` `observer` check, `:1081`).
The deliberate consequence: a side worker can read further back than before
(PRD R6).

### 7.2 Operator

- `/transcript <task_id>` in both shells prints the absolute path and the index
  row. It is a parser in the command registry plus one effect beside the
  registry, and it belongs in the busy-dispatch allow-list for the same reason
  `/demote` does — a turn blocked on its own command is exactly when it is
  wanted (previous package, specification §What P2 shipped).
- The TUI task inspector shows the path. Whether it should also render the
  transcript inline is **unknown / not settled here** (§12).
- The file is plain text, readable with any tool, owner-only.

## 8. Data contracts

- [schemas/shell-task-transcript-index.schema.json](schemas/shell-task-transcript-index.schema.json)
  — one `index.jsonl` record per transcript: task id, redacted command, cwd,
  times, terminal status, exit code, kill reason, file names, byte counts,
  truncation cause and whether a footer was written.
- The flush map (`.idx.jsonl`) is `{ raw, file, bytes }` per line, ascending,
  append-only.
- The transcript file itself is text: a header line, the redacted body, a footer
  line. It is an artifact for humans and for §7.1's ranged reads; it is not a
  parsed format and nothing should depend on its body shape.

## 9. Integration points

| Point | Change (planned) | Must not change |
|---|---|---|
| `appendOutput` (`background-job-registry.ts:630`) | Feed the sink after the existing ring/head/event work. | The ring cap, the cursor rebase, the idle re-arm, the `output-cap` auto-kill. |
| `promote` (`:906`) / the yield path (`shell-exec-tool.ts:377-400`) | Open the transcript on promotion. | Promote stays non-destructive and non-refusing. |
| `readOutputSince` (`:861`) + `shellTaskOutputTool` (`:1047`) | Serve an out-of-ring range from the transcript; keep `missed` for the genuinely unavailable. | The explicit cursor, its non-mutating property, and the `observer` rule. |
| `buildTaskNotification` (`agent.ts:531`) | Scrub the tail with `redactSensitiveText` before it is pushed (PRD F8). | The envelope, the banner, the round-boundary push, exactly-once delivery. |
| Session exit (`shell.ts:1447`, `:1458`; `tui-shell.ts:2380`, `:4503`, `:4703`) | Close open sinks, then sweep the session's `tasks/` dir. | `sweepBackgroundJobs` itself; `/clear` and `/new` still do not sweep. |
| `src/retention/policy.ts`, `auto-sweep.ts`, `sweep.ts` | New target discovery, new stamped trigger, amended scope note. | The engine's per-entry reporting, dry-run default, and `incomplete` semantics. |
| OS sandbox | None. | Writable roots stay `[cwd, tmpDir]`; the store stays outside them. |
| Approval gate | None. | `shell_exec` keeps `risk: "shell"` and its existing gate. |

## 10. Acceptance criteria

| # | Criterion | Phase |
|---|---|---|
| AC1 | A task promoted to background has a transcript whose first bytes are the command's first bytes. (F1, F2) | P0 |
| AC2 | A command that exits inside its yield under the threshold creates no file. (F1, S3) | P0 |
| AC3 | A secret echoed by a command does not appear in the transcript — including when it straddles a flush boundary, and when it is an unterminated private-key block. (F3, F4, S2) | P0 |
| AC4 | The transcript's header command is redacted, not the raw `info.command`. (F5) | P0 |
| AC5 | `KERYX_SHELL_TRANSCRIPTS=0` produces byte-identical behaviour to today, with no file and no directory. (F10, S6) | P0 |
| AC6 | The notification tail is redacted before it enters history. (F8) | P0 |
| AC7 | A crashed session leaves an unfooted transcript, and every reader reports it as an unknown outcome rather than a success. (F5) | P1 |
| AC8 | An index record exists per transcript with the schema's required fields. (F7) | P1 |
| AC9 | Over-age and over-cap transcripts are removed oldest-first and reported with a reason; an unreadable store is `incomplete`, not `ok`. (F9, S4) | P1 |
| AC10 | Session close sweeps that session's `tasks/` dir; the automatic sweep runs at most once a day per project and cannot be starved by the gdctx trigger. (F9) | P1 |
| AC11 | `shell_task_output` with a `since` older than the ring returns transcript bytes, flush-aligned, never skipping, capped per call — and `missed` only when the transcript genuinely cannot serve it. (F6, S1) | P2 |
| AC12 | No model-visible string contains a transcript path; a side worker's read still never marks a task observed. (F6, S5) | P2 |
| AC13 | `/transcript <task_id>` prints the path in both shells, including while the turn is busy. (F7) | P2 |
| AC14 | Approval, sandbox, session sweep, ring bounds and exactly-once delivery are provably unchanged (existing suites still pass). (N6) | every phase |

Phases: **P0** write path, redaction and the notification fix; **P1** index,
footer discipline and retention; **P2** the read surfaces; **P3** the
documentation sweep (wiki page and
[`docs/verification/keryx-shell-tui-test-catalog.md`](../../verification/keryx-shell-tui-test-catalog.md)).

## 11. Migration and compatibility

- Purely additive: with the feature off, or with no session directory, every
  existing path behaves exactly as it does today.
- `shell_task_output`'s input schema is unchanged; only the content of a read
  that used to return `missed` changes.
- No change to the task schema of the previous package — `outputFile` stays
  removed (D-18, and `outputFile` appears nowhere in `src`). The transcript is
  addressed by convention from the task id, not by a path field the model sees.
- Sessions created before this ships simply have no `tasks/` directory; the
  retention target reports `empty` rather than failing (`sweep.ts` target
  statuses, `:47`).

## 12. Out of scope / unsettled

Out of scope, with reasons in [brainstorm.md](brainstorm.md): relaxing the ring
or the `output-cap` kill (D-08); cross-session resumable tasks (D-09); a
project-wide byte cap needing a new cross-target engine pass (D-06); search or
indexing over transcript content (D-14); transcripts for `keryx ctx run`, which
has its own store and policy (D-01).

Unsettled, for the package owner:

- Whether the TUI inspector renders a transcript inline or only its path (§7.2).
- Whether PRD F8 (the unredacted notification tail) is fixed here or filed as a
  defect against the previous package's runtime.
- Whether 7 days / 50 MiB are the right numbers; they are argued from the gdctx
  precedent, not measured against real transcript volume, which is `unknown`.
