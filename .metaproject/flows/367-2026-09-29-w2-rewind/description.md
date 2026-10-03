# P0 W2 rewind: per-turn file snapshots with rollback of files and history

Status: draft
Source: operator "по порядку" (operator chat channel 172447), competitive review P0 item 2

## Problem

An agent turn can rewrite many files through `apply_patch` or `shell_exec`, and keryx can only resume or fork the conversation: session checkpoints are JSONL and never touch files. Gemini CLI, Claude Code, Kiro and OpenCode let the operator undo a turn's file changes; keryx does not, so a bad turn means hand-repairing the tree.

## Expected Outcome

Before the first mutating tool call of a turn, keryx records a snapshot of the project work tree in a per-session shadow git repository (a separate GIT_DIR, never the project's own `.git`). `/rewind` lists the turns, and restores the files, the conversation history, or both, to the state before a chosen turn. A rewind is itself undoable. The feature is visible in the TUI (command, modal picker, sidebar section) and works in the readline shell.

## Outcome criteria

- After a turn that edited files, `/rewind` restores the tree byte for byte and the next turn starts from the earlier history; the project's own git state is untouched.

## Out of Scope

- Side effects outside the project work tree (databases, network, files elsewhere on disk): `shell_exec` can do anything, and only the work tree is snapshotted. The docs say so.
- Unattended runs (triggers, `keryx serve`, external agents): they never snapshot and never rewind.
- Cross-session or cross-machine rewind; branching histories (`/fork` stays as it is).
