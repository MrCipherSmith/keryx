# Undo a turn: /rewind

`/rewind` rolls the project files, the conversation, or both back to the point
before one of your earlier turns. It works in the OpenTUI shell and in the
`--no-tui` readline shell.

## What is recorded

Before the first tool call of a turn that can change something (a tool whose
risk is write, shell, destructive or delegate), keryx snapshots the project
work tree. It happens once per turn, after any approval and immediately before
the tool runs, so a call you deny never snapshots. A turn that only reads
creates no snapshot.

Snapshots live in a per-session shadow git repository under the session
directory, with the project root as its work tree. keryx never reads or writes
the project's own `.git`, and every git call it makes ignores inherited `GIT_*`
environment variables. The shadow repository is deleted together with its
session.

## Using it

In the TUI, `/rewind` opens a picker. Each row shows the time, an excerpt of
your prompt and the number of files that turn changed. Pick a turn, then a
mode, then confirm:

| Mode | Key | Effect |
|---|---|---|
| files | `f` | Restore the work tree to its state before that turn. |
| history | `h` | Cut the conversation back to before that turn. |
| both | `b` | Both of the above. Files are restored first. |

`y` confirms, `n` goes back one step. The sidebar shows a **Rewind** section
with the snapshot count; clicking it opens the picker.

In the readline shell:

```text
/rewind                 list snapshots, numbered
/rewind 3               preview restoring files for snapshot 3
/rewind 3 both          preview a mode (files, history or both)
/rewind confirm         apply the previewed choice
```

Any other input line withdraws a pending preview. The default mode is `files`.

## What a restore does

- Modified files are restored, files the agent created are removed, and files
  it deleted are recreated.
- `.git`, `node_modules`, `.metaproject/data` and anything your `.gitignore`
  excludes are never touched.
- Files larger than 5 MB are skipped, and the result names each one.
- Before restoring, keryx takes a `pre-rewind` snapshot, so the restore itself
  can be undone. That entry can roll back files only.
- Rewinding history truncates the conversation and its archive, so it holds
  across compaction and resume. It refuses when this process does not hold the
  session lease, because it could not persist the result; in that case `/rewind`
  refuses entirely.

## Limits

- **Only the project work tree is covered.** Side effects of `shell_exec`
  outside it (files elsewhere on disk, installed packages, network calls,
  database changes, pushed commits) are not undone.
- The TUI transcript is not repainted after a history rewind. Earlier messages
  stay on screen but leave the model's context, the same as after `/resume`.
- `/rewind` waits while a turn is running.
- Unattended runs (triggers, `keryx serve`, external agents) create no shadow
  repository and refuse `/rewind`.

## Retention and switching it off

keryx keeps at most 50 snapshots per session; the oldest are pruned first.
Set `KERYX_REWIND=off` to record nothing; `/rewind` then says so.
