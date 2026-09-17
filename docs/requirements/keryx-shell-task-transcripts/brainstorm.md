# Keryx Shell Task Transcripts — Brainstorm and Decisions
Version: 1.0.0

This file records the prior art the design is grounded in and the decisions
taken from it, each with the alternative that was rejected and why.

## Prior art

Unlike [keryx-background-task-execution](../keryx-background-task-execution/brainstorm.md),
whose design was grounded in seven competitor harnesses read outside this
repository, **no external harness survey was performed for this package**. That
is a known omission, not a claim that none exists: how Codex, Grok Build, Gemini
CLI, Qwen, Cline, Crush or OpenCode persist command output is `unknown` here.
What follows is in-repository precedent, all of it verifiable.

| Precedent | What it establishes | Source |
|---|---|---|
| **gdctx raw logs** | keryx already writes raw command and search output to disk, with a metadata-bearing summary beside it, and bounds it with a real policy. | `src/commands/ctx.ts:755-756`, `:771-772`; `src/retention/policy.ts:79-98` |
| **…and does not redact it** | A search over `src/ctx` for any redaction call returns nothing. So an unredacted on-disk store of command output already exists in keryx; this package must not copy that property. | `rg redact src/ctx` — 0 matches (complete) |
| **Session transcript redaction** | The pattern this package follows: scrub on the way to disk, covering every field that reaches it — `content` and each tool call's `arguments`, after a credential leaked through the latter in three files. | `src/session/store.ts:290-321` |
| **Session store hardening** | Owner-only modes, a walk that forces every level, atomic temp+rename, best-effort on Windows. | `src/session/store.ts:156-214` |
| **Retention engine** | Age-primary, bytes-backstop, oldest-first, per-entry reasons, dry-run default, `incomplete` never folded into `ok`. | `src/retention/policy.ts:26-50`; `src/retention/sweep.ts:5-18`, `:32-68` |
| **Automatic sweep** | A policy only ever applied by hand is not applied: 8 126 entries and ~297 MiB sat past their own policy until the writer's own path was made to trigger it, throttled behind an atomic claim. | `src/retention/auto-sweep.ts:1-64`, `:74`, `:85-97` |
| **Fixed-width masking** | Masks are constant tokens, never length-preserving and never a partial reveal — which is why file offsets cannot equal stream offsets (D-10). | `src/security/redact.ts:11-25`, `:95-119` |
| **Operator scrub tools** | An after-the-fact pass over an arbitrary file already exists for what the regex floor missed. | `src/commands/security.ts:104`, `:107`, `:603-619` |

## Decisions

### D-01 — Transcripts live in the session directory

`<dataDir>/sessions/<project-key>/<session-id>/tasks/`
(`src/session/paths.ts:3-8`, `:96`). It is outside every working tree, so no
`git add -A` can commit it; it is outside the sandbox's writable roots, which
are `[cwd, tmpDir]` (`src/harness/process/sandbox/profile.ts:177-186`), so a
sandboxed child cannot read another task's transcript, forge one, or delete the
record of what it printed; and it inherits the session store's modes and project
scoping (`src/session/store.ts:156-214`) rather than inventing a second
convention.

- **Rejected: `.metaproject/data/shell-tasks/raw/`.** It would inherit the
  gdctx gitignore line (`.gitignore:55`) and the retention target shape for
  free, which is genuinely attractive. But it puts raw command output *inside
  the repository*, one mis-scoped `git add` from a public history, and
  `.metaproject/` is meant to hold agent-facing versioned context, not
  credential-bearing runtime logs. The gdctx store is the precedent for the
  mechanism, not for the location.
- **Rejected: a temp directory.** No stable operator address, and deletion
  timing belongs to the OS rather than to a stated policy.
- **Rejected: a path the operator configures per project.** A second location
  rule for a store whose whole risk profile is "where did the secrets land".
- Out of scope by the same reasoning: giving `keryx ctx run` a transcript. It
  has its own store and its own policy already.

### D-02 — Lazy open: on promotion, or past the head threshold

A transcript opens at the first of (a) the task being promoted to the
`background` phase (`background-job-registry.ts:906-925`, reached at
`shell-exec-tool.ts:400`), or (b) output exceeding `TASK_OUTPUT_HEAD_BYTES`
(24 000, `:177`).

Both halves matter. Promotion alone would miss a foreground command that dumps
megabytes and exits inside its yield; the threshold alone would miss a slow,
quiet, long-running task — which is the one the operator most wants a record of.

- **Rejected: open for every task.** The common case is a short command whose
  full result the model already receives (`shell-exec-tool.ts:435`). Opening for
  all of them means thousands of tiny files bought nothing.
- **Rejected: open only past 2 MiB, when the ring starts dropping.** By then the
  dropped bytes are gone; a store that begins after the loss cannot recover it.

### D-03 — Write-through, not spill-on-overflow

Once open, every chunk is written as it arrives.

- **Rejected: buffer in memory and spill only if the ring overflows.** It
  reintroduces the unbounded buffer the ring cap exists to prevent
  (`background-job-registry.ts:130-138`), and makes the file's start depend on
  timing — the same class of "what you kept depends on when you asked" the
  head/tail split already causes.

### D-04 — Redact before the bytes reach disk, never after

Every byte passes the existing `redactSensitiveText` composition
(`src/security/redact.ts:128-137`) on the write path.

- **Rejected: write raw, scrub at close.** The plaintext exists on disk for the
  whole life of the task, and a crash — the exact case a durable transcript is
  for — makes that window permanent.
- **Rejected: write raw, redact on read.** Same exposure, plus it makes every
  reader (including `cat`) a security boundary.
- **Rejected: a second, transcript-specific scrubber.** One scrubber, or the two
  drift; `src/session/store.ts:290-307` records what that drift cost once
  already.

### D-05 — The flush rule: no partial line, a carry window, never inside a match

`redactSensitiveText` is whole-string, so naive per-chunk redaction masks
neither half of a split secret. The rule (specification §5.2) flushes only up to
an offset that is at a line boundary, at least `carryBytes` (4 096) back from the
end, and not inside any detector match.

- **Rejected: redact each chunk independently.** This is the defect the rule
  exists to prevent, and it is silent — nothing in the output says a secret was
  missed.
- **Rejected: hold everything and redact once at close.** Unbounded memory, and
  nothing on disk for exactly the crash case.
- **Rejected: a bigger carry window instead of a rule.** No window bounds
  `secrets.private-key-block`, which is `[\s\S]*?` between markers
  (`src/security/detect/secrets.ts:65-71`). That pattern gets an explicit
  fail-closed rule: from an unmatched BEGIN marker onward, everything is masked
  until an END or the task's exit. It is the part of this design most worth a
  reviewer's attention.

### D-06 — Retention: age primary, bytes per session, on the existing engine

A target per session `tasks/` directory: `unit: "file"`, `maxAgeDays: 7`,
`maxBytes: 50 MiB`, swept by `src/retention/sweep.ts` unchanged. Seven days
rather than gdctx's 14 (`src/retention/policy.ts:69`) because this is raw
command output: higher sensitivity, lower re-read value than a search summary.

- **Rejected: a count axis.** `policy.ts:44-50` already argues it only fires
  where the byte cap fires, on the same entries.
- **Rejected: keep until the disk complains.** That is what gdctx did, measured
  at 8 126 entries past policy (`auto-sweep.ts:9-16`).
- **Rejected: a bespoke pruner.** A second engine with its own reporting, its
  own dry-run semantics and its own bugs.
- **Named non-goal:** a project-wide byte cap across sessions. The engine applies
  caps per target, so bounding a project's total would need a new cross-target
  pass. The cross-session bound here is the age cap, and saying so is better than
  implying a cap that is not enforced.
- **Required edit, not optional:** `RETENTION_SCOPE_NOTE` (`sweep.ts:86-90`)
  currently promises the sweep touches `.metaproject/` only. A target outside it
  makes that sentence false, and a wrong scope note is worse than none.

### D-07 — Three cleanup owners, and a separate stamp for the automatic one

Session close sweeps that session's own directory; a daily throttled sweep at
session start covers the project; `keryx retention sweep [--apply]` covers
everything, dry-run by default (`src/commands/retention.ts:26-55`).

- **Rejected: delete at task end.** It destroys the record precisely when the
  operator goes looking for it.
- **Rejected: manual only.** `auto-sweep.ts:1-16` is the measured refutation.
- **Rejected: sharing the existing auto-sweep stamp.** One stamp means whichever
  trigger runs first suppresses the other for 24 hours — a throttle that
  silently disables a sweep. Separate stamp and claim files, same constants
  (`:74`, `:85`), same `KERYX_RETENTION_AUTO` off switch (`:87`).
- **Rejected: triggering on the `keryx ctx` write path.** ctx does not write
  transcripts; a checkout that never runs a routed search would never sweep them.

### D-08 — The ring and its `output-cap` kill are unchanged

The 2 MiB ring, the auto-kill past it, the 4 000-byte shrink, the 24 000-byte
head and the 50-task LRU keep their current values and behaviour
(`background-job-registry.ts:138`, `:152`, `:161`, `:177`, `:622-628`,
`:638-653`).

- **Rejected: relaxing the `output-cap` kill because a durable copy now exists.**
  Tempting — with a transcript, a chatty task no longer needs to die to bound
  memory. But that changes *when commands die*, which is the previous package's
  contract and its proven bound (its M9). It deserves its own decision, with its
  own measurements, not a side effect of adding a file.
- Consequence to state plainly: while that kill stands, a task cannot normally
  produce more than ~2 MiB, so the 64 MiB per-task transcript cap is unreachable
  in practice today. It is a bound that does not depend on another module's
  constant, not a prediction about file sizes.

### D-09 — The transcript outlives the session; the task does not

`sweepAll` still kills every task at session exit
(`background-job-registry.ts:945-949`), a stale id still resolves to
`unknown task_id` (previous package D-14), and nothing reattaches. The file is
inert data.

This is a deliberate, named departure from the previous package's D-04
("a task dies with its session"). Recording it as a departure is the point: a
durable artifact from a deliberately ephemeral subsystem is exactly the kind of
change that should not be smuggled in as an implementation detail.

- **Rejected: delete transcripts at session exit.** It reduces the feature to
  "read it while the session that produced it is still open", which is the
  situation that already works.
- **Rejected: making tasks resumable from a transcript.** Process ownership,
  orphan reaping and persistence — the whole set of concerns D-04 declined.

### D-10 — Reads go through the existing cursor, flush-aligned

`shell_task_output`'s `since` keeps its meaning; a range the ring can no longer
serve — today reported as `missed` (`background-job-registry.ts:870`, rendered
at `:1085`) — is served from the transcript via a per-flush offset map.

Because masks are fixed-width (`redact.ts:23-25`), a mask changes length inside
a flush, so file offsets cannot equal stream offsets. Reads therefore begin at
the start of the flush containing `since`: **a transcript-served read may repeat
at most one flush's bytes and never skips any.** Never-skip is the property that
matters; the repeat is disclosed in the trailer.

- **Rejected: a new `shell_task_transcript` tool.** A second read surface with
  its own cursor semantics, its own side-worker question, and its own way to be
  denied — for the same bytes the existing tool already returns.
- **Rejected: an exact byte-for-byte offset map.** It would require recording a
  mapping per mask, for a precision no caller needs.
- **Rejected: making transcript offsets the cursor space.** It would silently
  redefine `since` for every existing caller.

### D-11 — No filesystem path ever reaches the model

Not in a tool result, not in the trailer, not in a notification. The transcript
is addressed by task id.

- **Rejected: returning the path so the model can `read_file` it.** It converts
  a bounded, capped, cursor-paged read into an unbounded one, hands a shell-
  capable agent the location of every other task's output, and re-opens the
  `outputFile` field the previous package deliberately removed (D-18).

### D-12 — A per-session `index.jsonl`

One append-only record per transcript: task id, redacted command, times,
terminal status, exit code, kill reason, byte counts, truncation cause, whether
a footer was written (schema in `schemas/`).

- **Rejected: discovery by filename alone.** `task-3-48211.log` is not an
  operator surface; finding "the failed build from this morning" would mean
  opening files.
- **Rejected: a database.** A new dependency (PRD N1) and a new corruption mode
  for a list that is written once per task.

### D-13 — The unredacted notification tail is named here, and fixed here

`buildTaskNotification` (`src/commands/agent.ts:531-552`) slices a 4 000-byte
output tail and it is pushed into provider-bound history at `:1277`, `:1601`,
`:1655` and `:1960` with **no** `redactSensitiveText` call on the path, while
every ordinary tool result is scrubbed at `:1857`.

This contradicts the previous package's own D-10, which justified the
notification's trust level as carrying "the same local command output a
`shell_exec` tool result carries today, **at the same trust**". It does not: the
tool result is scrubbed and the notification is not.

**Decision.** Fix it in this package (PRD F8, AC6, metrics M12). A package that
redacts the disk path while the provider-bound path leaks the same bytes would
be incoherent.

- **Rejected: filing it against the previous package and leaving it.** It is the
  same output, the same scrubber and the same risk this package exists to
  handle; splitting it across two packages means neither owns it.
- Left to the owner: whether the fix ships here or as a hotfix to the previous
  package's runtime. The defect is recorded either way.

### D-14 — No search or index over transcript content

The index (D-12) is metadata only. Grepping content, ranking it, or exposing a
search tool over it is a follow-on.

- **Rejected: a `shell_task_search` tool.** It would need its own bounds, its own
  redaction reasoning for match context, and its own side-worker rules — a
  package, not a feature.

## Alternatives considered and rejected

| Alternative | Why rejected |
|---|---|
| Raising `TERMINATED_OUTPUT_TAIL_BYTES` instead of writing a file | Trades memory for a slightly later loss; the output still dies with the session and is still gone at eviction. |
| Serving the existing 24 000-byte head snapshot through a read tool | Cheap and worth doing, but it recovers 24 KB of a 500 KB build, and nothing after the session ends. It is a smaller fix to a smaller problem. |
| Keeping the full ring in memory while a transcript exists | Regresses the bound the previous package proved (its M9) to solve a problem the file already solves. |
| Writing transcripts for side-worker tasks | Side workers have no `shell_exec` (previous package D-12), so there is nothing to write. |
| A single shared transcript per session | Interleaved output from concurrent tasks, with no way to serve a per-task cursor from it. |
| Compressing transcripts on close | Real savings, but it breaks ranged reads and plain-text operator access for a store the age cap already bounds. |
