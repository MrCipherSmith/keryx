# Module src/rewind

Version: 1.0.0
Type: component
Status: accepted

## Summary

`src/rewind` records snapshots of the project's work tree during a session and lets the `/rewind` command roll files, conversation history, or both back to an earlier snapshot. It groups 19 file(s), depends on `src/lib` and `src/harness/provider`, and exposes 14 public symbol(s).

## Overview

`src/rewind` owns the session's undo log. Before the first mutating tool call of each turn it captures the project tree into a private git object store, so the user can later list the turns, preview one, and restore the files and/or the conversation to that point. It sits between the agent's tool loop, which triggers snapshots, and the shell or TUI, which lists and applies rewinds.

## How it works

The module is layered around one stateful object. `createRewindRecorder` in `src/rewind/recorder.ts` returns a `RewindRecorder` that holds the current turn (`beginTurn`), a serial work queue, a cached per-session manifest, and a per-turn guard so that `beforeMutation` takes at most one snapshot per turn. Its `record` step is the only place a snapshot entry is created: it captures the tree, writes a `refs/rewind/<seq>` ref, appends to the manifest and applies retention.

Storage is a git repository used as a content-addressed store, not as the user's repository. `src/rewind/shadow.ts` points a `shadow.git` directory under the session's rewind directory at the real work tree through explicit `GIT_DIR` and `GIT_WORK_TREE`. Git is run with hooks, global config and system config disabled, and it excludes `.git`, `node_modules/` and `.metaproject/data/`. Files over `REWIND_MAX_FILE_BYTES` (5 MB) are recorded as skipped rather than stored. `src/rewind/snapshot.ts` turns the tree into a tree id by updating the shadow index from `ls-files` and `write-tree`, and computes the changed paths between two trees with `diff-tree`.

Rewinding is split into a file half and a history half. `applyRewind` in `src/rewind/apply.ts` takes a mode (`files`, `history` or `both`), checks a persistence lease, and does files first, because a file restore can be undone through its pre-rewind snapshot while a history cut cannot. History is cut through `applyConversationRewind` from `src/rewind/history`, after which `detachHistoryAfter` leaves later snapshots as file-only restore points. `src/rewind/readline-command.ts` is the plain-shell front end: it lists snapshots, previews a pick, and applies it only on `/rewind confirm`.

## Key concepts

- **Snapshot (`RewindEntry`)**: one manifest row with a sequence number `seq`, a `kind` (`turn` for a turn's pre-mutation state, `pre-rewind` for the safety copy taken before a restore), the git tree id, a timestamp, an optional `archiveIndex` that marks the conversation position, a truncated prompt, and the list of skipped files.
- **Manifest**: the per-session list of entries plus `nextSeq`, loaded and saved through `loadManifest` and `saveManifest` and kept in memory as a cache keyed by directory.
- **Shadow repo (`ShadowRepo`)**: the `gitDir` and `workTree` pair. It is never the user's own `.git`.
- **Listing (`RewindListing`)**: what `describe()` returns for the UI. Each listing's changed files are the diff between that snapshot's tree and the next one, or the live tree for the newest entry.
- **Retention**: `enforceRetention` trims old entries to `REWIND_MAX_SNAPSHOTS` (or the `maxSnapshots` option) when a turn is recorded or a restore runs.
- **Outcome types**: `RewindFilesOutcome` is either a restore result with `preRewindSeq`, or a reason string when nothing could be restored.
- **Kill switch**: `rewindDisabledByEnv` reads `KERYX_REWIND=off`, and an `enabled` option can override it.

## Main flows

1. **Snapshot before the first write of a turn.** The host calls `beginTurn` with the prompt and the conversation's archive index. When a mutating tool is about to run, it calls `beforeMutation`. If rewind is enabled and a session directory exists, the call is queued on the serial chain, `record` runs `captureTree`, writes the ref, pushes the entry and applies retention. Later calls in the same turn return the same promise. Errors go to `onError` once and never throw into the tool loop.

2. **Listing.** `describe()` copies the manifest, then walks the entries newest to oldest. Each entry is diffed against the next entry's tree with `changedFiles`, and the diff is cached by the pair of tree ids. The result is reversed so the newest snapshot comes first. The shell's `/rewind` with no argument prints this list.

3. **Rewind from the shell.** `/rewind N [mode]` checks that the snapshot exists and that the mode is available, then stores a pending choice and prints a preview. `/rewind confirm` calls `applyRewind`. In `files` or `both` mode, `restoreFiles` first records a `pre-rewind` snapshot, then calls `restoreTree` and applies retention. Only if that succeeds does the history cut run through `applyConversationRewind`, followed by `detachHistoryAfter` and the host's `afterHistoryRewind` callback. Any other input line cancels the pending choice.

---

<!-- keryx:reference:begin v=1 hash=904b80fee029e2e1cf82d037ce8adc4cdf7f4b546feca08f6bef7e031088c676 -->
## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Public API

- `RewindRecorderOptions`
- `RewindListing`
- `RewindFilesOutcome`
- `RewindRecorder`
- `rewindDisabledByEnv`
- `createRewindRecorder`
- `REWIND_MAX_FILE_BYTES`
- `ShadowRepo`
- `GitResult`
- `shadowRepo`
- `git`
- `gitOk`
- `splitNul`
- `initShadow`

### Key files

- `src/rewind/recorder.ts` - imported by 11, imports 5
- `src/rewind/shadow.ts` - imported by 8, imports 2
- `src/rewind/apply.ts` - imported by 5, imports 3
- `src/rewind/rewind.test-helpers.ts` - imported by 7, imports 1
- `src/rewind/readline-command.ts` - imported by 2, imports 5
- `src/rewind/snapshot.ts` - imported by 6, imports 1

### Depends on

- `src/lib` - 5 import(s)
- `src/harness/provider` - 3 import(s)

### Depended on by

- `src/tui` - 6 import(s)
- `src/commands` - 2 import(s)

### Dependency basis

- Production imports only: 6 import(s) from test file(s) (e.g. `src/rewind/apply.test.ts`) excluded from the two sections above in both directions.

### Graph signals

- Files: 19
- Cross-module imports: 8
<!-- keryx:reference:end -->

## Related Wiki

Graph-derived - regenerated by `keryx wiki collect --force`. Only pages that
exist are linked, other modules are named as code paths; when enriching, add
new links only to pages you have verified.

- [Wiki Index](../index.md)
- [Module src/lib](src-lib.md)
- [Module src/harness/provider](src-harness-provider.md)
- [Module src/tui](src-tui.md)
- [Module src/commands](src-commands.md)

## Changelog

- 1.0.0 — Prose enriched from Key files by the gdwiki skill.
- 0.1.0 - Generated by `keryx wiki collect` at 2026-10-19T10:13:19.815Z. Prose sections are drafts for the gdwiki enrich workflow.
