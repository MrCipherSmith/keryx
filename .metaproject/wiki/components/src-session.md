---
Title: Module src/session
Version: 1.0.0
Type: component
Status: accepted
Summary: "`src/session` owns per-project session storage: paths, discovery, persistence with redaction, fork, compaction, export, the single-holder lease, and the session-local Slate lifecycle. Depends on `src/lib`, `src/harness/provider`, `src/security`."
---

# Module src/session

## Summary

`src/session` owns per-project session storage: it resolves where a project's sessions live, persists their context, archive and summary files with secrets redacted, forks, compacts and exports them, lets only one live shell hold a session through a lease, and drives the session-local Slate's open and close lifecycle.

## Overview

`src/session` is the project module responsible for managing session data and related helpers. Each conversation is scoped to one project root, so listing, `continue` and `resume` never reach across projects. It provides path resolution, session lookup, context and archive loading, session creation, forking, compaction, export, and a lease that stops two shells from writing the same session.

This module is consumed by command, TUI, harness tool, and related flows that need to inspect or mutate session state. It sits above lower-level utilities and provider/security boundaries, giving higher layers a stable way to work with sessions without directly handling their storage details.

## How it works

A session is a directory at `<dataDir>/sessions/<project-key>/<session-id>/`. Inside it, `context.jsonl` holds the model window the agent resumes with, `archive.jsonl` holds the full history that compaction does not remove, and `summary.json` holds the metadata (title, counts, provider, model, remote-control intervals). `transcript.jsonl` is a legacy copy of the context. `paths.ts` maps a working directory to that location: `resolveProjectRoot` walks up to the nearest `.git`, and `projectKeyFromPath` URL-encodes the absolute path into a directory name, falling back to a hash for long paths.

The module is organized around a small set of responsibilities:

- **Persistence.** `store.ts` writes every file atomically (temp file, then rename). `persistHistory` redacts message content, tool-call arguments and reasoning text before serialising, then commits context, archive and summary together through `commitHistoryCheckpoint`. Reads are defensive: a malformed line is skipped, while an unreadable transcript throws `TranscriptUnreadableError` instead of reading back as empty.
- **Session discovery and access.** `listSessions` returns the project's sessions, newest first. `findSession` matches an exact id, an id prefix, a short id or a title. `latestSession` skips records of external agent runs. `openSession` creates or resumes a session.
- **Transcript and context loading.** `loadContext` reads the model window. `loadArchive` reads the full history and falls back to the context when the archive is missing or unreadable, reporting the degradation through a callback. `loadTranscript` is a deprecated alias of `loadContext`.
- **Session mutation and maintenance.** `createSession`, `forkSession` (copies context and archive into a new session that records `parentSessionId`), `renameSession`, `persistCompacted` and `compactSession`. The compaction helpers `compactMessages` and `indexOfKeepFrom` reduce the context while keeping a boundary the session can continue from.
- **Lease.** `lease.ts` holds `<sessionDir>/active.lease/` as a directory lock with an `owner.json` record. The holder refreshes it every 5 seconds. A holder silent for 15 seconds is stale and can be taken over with `takeOver`; a live holder is never taken over. When another instance takes the lease, `watchLeaseLoss` and `canPersist` stop this shell's saves.
- **Slate lifecycle.** `slate.ts` is the lock-protected storage for `slate.json`, with archive-on-close into `slate-archive/`. `slate-lifecycle.ts` recomputes Anchors from live git state on every open and drives open and close through a `SlateSessionRef`. A detached ref writes nothing.
- **Export.** `exportSessionMarkdown` renders the archive as Markdown and marks the export as incomplete when it had to fall back to the context.

### Entry point

`src/session/index.ts` re-exports the public surface used by dependent modules.

### Central implementation files

- `src/session/store.ts` — persistence, redaction, discovery, fork, compaction hand-off and export
- `src/session/slate.ts` — lock-protected storage for `slate.json`, including Trail, Notes and operator answers
- `src/session/lease.ts` — session lease acquisition, heartbeat and loss detection

### Supporting files

- `src/session/paths.ts` — data-root and project-key resolution
- `src/session/slate-lifecycle.ts` — Anchors computation and the Slate open and close wiring
- `src/session/slate-course.ts` and `src/session/slate-terminal-state.ts` — appear to hold the Course projection and terminal-state handling; not read in depth for this page

## Key concepts

- **Session** — A conversation record under project-scoped storage, identified by a UUID. `shortSessionId` gives the last eight hex characters for display.

- **Project root and project key** — `resolveProjectRoot` picks the git toplevel, or the absolute cwd when there is none. `projectKeyFromPath` turns that path into the directory name under `sessions/`.

- **Transcript** — The durable record. `context.jsonl` is what the agent resumes with. `archive.jsonl` is the full audit log, which keeps history that compaction removed from the context.

- **Context** — The derived model window that `loadContext` returns to consumers such as commands and providers.

- **Compaction** — An operation that shrinks the context while the archive keeps the removed history.

- **Fork** — A new session that starts as a copy of an existing one. The copy is owned by the fork from its first turn, so writing to it never changes the source.

- **Archive** — The full history file. It is not an independent snapshot, and loading falls back to the context when it cannot be read.

- **Lease** — The single-holder claim on a session, stored as `active.lease`, with a heartbeat and a staleness rule. A process that already holds the lease gets its own handle back instead of being refused.

- **Remote intervals** — `summary.remote` records when a session was driven through remote control, keeping at most `MAX_REMOTE_INTERVALS` entries.

## Main flows

### Create or resume a session

1. A consumer calls `openLeasedSession` (or `openSession`) through `src/session/index.ts`.
2. For a resume, the lease is taken before the transcript is read, so a refused session is never read. `findSession` resolves the id or prefix inside the current project.
3. When nothing matches, `createSession` writes a new directory with an empty context, archive and summary.
4. `loadContext` and `loadArchive` return the history to the caller, and any archive degradation is reported alongside it.

### Load transcript or context

1. A consumer identifies a session through list or find operations.
2. `loadContext` reads `context.jsonl`, and `loadArchive` reads `archive.jsonl`, falling back to the context.
3. If the context cannot be read, `TranscriptUnreadableError` is thrown. `forkSession` throws `UnknownSessionError` when its source id matches nothing in the project.

### Compact or export a session

1. A maintenance flow selects an existing session.
2. `compactMessages` and `indexOfKeepFrom` compute the reduced context, and `persistCompacted` writes context, archive and `compactCount` in one checkpoint.
3. If a human-readable artifact is needed, `exportSessionMarkdown` renders the archive as Markdown.

<!-- keryx:reference:begin v=1 hash=1f3b6b9497159432958eb81a8aca2e2d5be906e163f7b264dfff43f6ea2c1545 -->
## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Public API

- `keryxDataDir`
- `projectKeyFromPath`
- `projectSessionsDir`
- `resolveProjectRoot`
- `sessionDir`
- `compactMessages`
- `compactSession`
- `indexOfKeepFrom`
- `MAX_REMOTE_INTERVALS`
- `REMOTE_MARK`
- `SESSION_SCHEMA_VERSION`
- `TranscriptUnreadableError`
- `UnknownSessionError`
- `createSession`
- `describeRemote`
- `exportSessionMarkdown`
- `findSession`
- `forkSession`
- `isExternalRunSession`
- `latestSession`

### Key files

- `src/session/slate.ts` - imported by 55, imports 5
- `src/session/store.ts` - imported by 33, imports 6
- `src/session/lease.ts` - imported by 24, imports 3
- `src/session/slate-lifecycle.ts` - imported by 23, imports 3
- `src/session/index.ts` - imported by 21, imports 3
- `src/session/paths.ts` - imported by 16, imports 0

### Depends on

- `src/harness/provider` - 13 import(s)
- `src/lib` - 7 import(s)
- `src/security` - 4 import(s)
- `src/gdgraph` - 3 import(s)
- `src/harness/tool` - 2 import(s)
- `src/sac` - 1 import(s)

### Depended on by

- `src/commands` - 28 import(s)
- `src/sac` - 17 import(s)
- `src/tui` - 16 import(s)
- `scripts/benchmark` - 11 import(s)
- `src/harness/tool/builtin` - 8 import(s)
- `src/harness/external` - 5 import(s)

### Dependency basis

- Production imports only: 111 import(s) from test file(s) (e.g. `scripts/benchmark/long-runner-turn.test.ts`) excluded from the two sections above in both directions.

### Entry points

- `src/session/index.ts`

### Graph signals

- Files: 46
- Cross-module imports: 32
<!-- keryx:reference:end -->

## Related Wiki

Graph-derived - regenerated by `keryx wiki collect --force`. Only pages that
exist are linked, other modules are named as code paths; when enriching, add
new links only to pages you have verified.

- [Wiki Index](../index.md)
- [Module src/harness/provider](src-harness-provider.md)
- [Module src/lib](src-lib.md)
- [Module src/security](src-security.md)
- [Module src/gdgraph](src-gdgraph.md)
- [Module src/harness/tool](src-harness-tool.md)
- [Module src/sac](src-sac.md)
- [Module src/commands](src-commands.md)
- [Module src/tui](src-tui.md)

## Changelog

- 1.0.0 — Prose enriched from Key files by the gdwiki skill.
- 0.1.1 - Generated sections regenerated by `keryx wiki collect --force`; prose untouched.
- 0.1.0 — Generated by `keryx wiki collect` at 2026-09-16T16:24:12.891Z. Prose sections are drafts for the gdwiki enrich workflow.
