# Keryx Shell Task Transcripts — Requirements Package
Version: 1.0.0

## Status

**Nothing in this package is implemented.** Every runtime claim below carries a
`file:line` for behaviour that exists today, or is marked `planned` /
`unknown`. No phase has shipped and no flow has been opened.

This package answers the follow-on that
[`keryx-background-task-execution`](../keryx-background-task-execution/README.md)
names as decision **D-18**:

> `outputFile` is removed from the task schema. Retained output is the existing
> 2 MiB ring, shrunk to a 4 000-byte tail once the completion is delivered.
> On-disk transcripts need a location, retention and redaction design of their
> own and are a follow-on package.

`outputFile` is indeed absent from the shipped code (`rg outputFile src` returns
nothing), so the gap is exactly as D-18 left it.

## Purpose

Give a supervised shell task a **durable, bounded, redacted transcript on disk**,
so that the output a task produced survives delivery, eviction and the session —
without weakening the in-memory bounds the previous package proved, and without
turning command output into a new plaintext secret store.

### What is actually lost today

Four separate losses, not one. Each is a distinct code path:

| Loss | Where | What it costs |
|---|---|---|
| Post-delivery shrink | `shrinkTerminatedOutput`, `src/harness/tool/builtin/background-job-registry.ts:622-628` | Everything but the last 4 000 chars of the ring, the moment the task exits. |
| Ring overflow | `appendOutput`, `:638-651` | The oldest bytes past 2 MiB (`MAX_BACKGROUND_OUTPUT_BYTES`, `:138`) — and the task is then auto-killed with `killReason: "output-cap"`. |
| Task eviction | `evictOldestTerminatedIfOverCap`, `:605-612` | The whole record, tail and all, once 50 tasks are tracked (`MAX_TRACKED_JOBS`, `:152`). |
| Session exit | `sweepAll`, `:945-949`; nothing is persisted | Everything. No task output has ever reached disk from this path. |

**A correction to the framing this package was commissioned with.** "Everything
except the last 4 000 bytes is gone forever" is not quite true: the first
24 000 bytes are snapshotted separately into `info.outputHead`
(`TASK_OUTPUT_HEAD_BYTES`, `:177`; written in `appendOutput`, `:632-635`) and
that snapshot is **never shrunk**. But it is reachable from exactly one place —
`shell_exec`'s own synchronous-shaped result for a command that exited inside
its yield (`src/harness/tool/builtin/shell-exec-tool.ts:435`) — and from no
model-facing read tool at all: `readOutputSince` serves the ring only
(`background-job-registry.ts:861-879`), and `drainUndelivered` falls back to the
head only when the ring is empty (`:976`). So for the motivating case — a long
build whose first error scrolled past — the early output is *retained in memory
and unreachable*, which fails the operator in the same way as being deleted, and
is then genuinely deleted at eviction or session exit.

## Document index

| Document | Audience | Read it when |
|---|---|---|
| [prd.md](prd.md) | anyone | You want the problem, users, requirements, success criteria and risks. |
| [specification.md](specification.md) | implementer | You need the file layout, the write path, the redaction rule, the retention target, the read surfaces and the acceptance criteria. |
| [brainstorm.md](brainstorm.md) | reviewer | You want the decisions D-01…D-14 with the alternative rejected for each. |
| [metrics-and-validation.md](metrics-and-validation.md) | anyone | You want each invariant stated as a measure with a named proof. |
| [schemas/shell-task-transcript-index.schema.json](schemas/shell-task-transcript-index.schema.json) | implementer | You are implementing the per-session transcript index record. |

Related, outside this package:

- [keryx-background-task-execution](../keryx-background-task-execution/README.md) —
  the shipped supervised-task model this extends. Its D-04 (session-scoped
  lifetime), D-16 (side-worker rules) and D-18 (this package) are load-bearing here.
- [`.metaproject/wiki/architecture/background-jobs.md`](../../../.metaproject/wiki/architecture/background-jobs.md) —
  the accepted description of the supervised-task model as shipped.
- [Keryx OS Sandbox](../keryx-os-sandbox/README.md) — the containment layer that
  decides whether a sandboxed child can reach the transcript store.

## Scope

**In scope**

- A per-task transcript file under the **session directory**, opened lazily,
  written through, bounded per task.
- **Redaction at the write path**, before any byte reaches disk, including the
  chunk-boundary problem that in-memory redaction does not have.
- **Retention**: an age + total-bytes policy expressed as a target of the
  existing sweep engine, with a named owner for cleanup.
- **Read surfaces**: the model reads through the existing `shell_task_output`
  cursor (no new tool, no path handed to a model); the operator gets a path and
  an index.
- One defect found while writing this package and squarely inside its subject:
  the completion-notification tail reaches provider-bound history **unredacted**
  (`src/commands/agent.ts:531-552`, pushed at `:1277`, `:1601`, `:1655`,
  `:1960`) while every ordinary tool result is scrubbed at `:1857`. See PRD F8,
  brainstorm D-13.

**Out of scope** (named, with reasons in [brainstorm.md](brainstorm.md))

- Relaxing the 2 MiB ring or its `output-cap` auto-kill now that a durable copy
  exists (D-08). That changes when commands die; it is the previous package's
  contract, not this one's.
- Making a task resumable across sessions. The transcript outlives the session;
  the **task** does not (D-09, previous package D-04).
- A full-text index or search over transcripts (D-14).
- Transcripts for anything but supervised shell tasks — `keryx ctx run` already
  has its own raw-log store with its own retention (D-01).

## Related modules

| Module | Relationship |
|---|---|
| `src/harness/tool/builtin/background-job-registry.ts` | `appendOutput` (`:630`) is the single funnel every byte passes through; the write path hooks here. |
| `src/harness/tool/builtin/shell-exec-tool.ts` | Owns the yield/promote decision (`:377-400`) that triggers a lazy transcript open. |
| `src/security/redact.ts` | `redactSensitiveText` (`:128`) is the scrubber; this package must not introduce a second one. |
| `src/session/paths.ts`, `src/session/store.ts` | The session directory (`paths.ts:96`), its `0o700`/`0o600` discipline (`store.ts:156-214`) and the layout the transcripts join. |
| `src/retention/policy.ts`, `sweep.ts`, `auto-sweep.ts` | The retention target, the sweep engine and the throttled automatic trigger. |
| `src/commands/agent.ts` | The notification builder (`:531`) and the tool-output redaction site (`:1857`). |
| `src/tui/tui-shell.ts`, `src/commands/shell.ts` | The operator surfaces (`/transcript`, inspector) and the session-exit paths. |
