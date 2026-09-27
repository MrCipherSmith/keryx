---
Title: Module src/session
Version: 0.1.0
Type: component
Status: draft
Summary: "`src/session` groups 16 file(s). Depends on `src/lib`, `src/harness/provider`, `src/security`. Exposes 20 public symbol(s)."
---

# Module src/session

## Summary

`src/session` groups 16 file(s). Depends on `src/lib`, `src/harness/provider`, `src/security`. Exposes 20 public symbol(s).

## Overview

`src/session` is the project module responsible for managing session data and related helpers. It provides path resolution, session lookup, transcript loading, context loading, archive loading, session creation, forking, compaction, and export operations.

This module is consumed by command, TUI, harness tool, and related flows that need to inspect or mutate session state. It sits above lower-level utilities and provider/security boundaries, giving higher layers a stable way to work with sessions without directly handling their storage details.

## How it works

The module is organized around a small set of responsibilities:

- **Session identification and paths**  
  Helpers such as `resolveProjectRoot`, `projectKeyFromPath`, `projectSessionsDir`, and `sessionDir` map filesystem locations to stable session storage locations.

- **Session discovery and access**  
  Functions such as `listSessions`, `findSession`, and `latestSession` let callers enumerate or select sessions.

- **Transcript and context loading**  
  Functions such as `loadTranscript`, `loadContext`, and `loadArchive` read persisted session data. Error types such as `UnknownSessionError` and `TranscriptUnreadableError` make failure modes explicit.

- **Session mutation and maintenance**  
  Operations such as `createSession`, `forkSession`, and `compactSession` manage the lifecycle of session data. Compaction helpers such as `compactMessages` and `indexOfKeepFrom` support reducing transcript size while preserving a usable history boundary.

- **Export**  
  `exportSessionMarkdown` provides a session representation suitable for external inspection or reporting.

### Entry point

`src/session/index.ts` re-exports the public surface used by dependent modules.

### Central implementation files

- `src/session/store.ts` — core session persistence and retrieval logic
- `src/session/slate.ts` — state model definitions for the session layer

### Supporting files

- `src/session/slate-lifecycle.ts` — lifecycle-related state operations
- `src/session/slate-course.ts` — course/flow-related state model
- `src/session/slate-terminal-state.ts` — terminal state handling

## Key concepts

- **Session** — A named or identifiable interaction record persisted under project-scoped storage.

- **Project root and project key** — Path-resolution concepts that allow sessions to be associated with a stable project location.

- **Transcript** — The durable record of session activity. Transcripts may be loaded as raw history or interpreted into higher-level context.

- **Context** — A derived representation of session data intended for consumers such as commands, providers, or other session-aware components.

- **Compaction** — A maintenance operation that reduces transcript size while preserving enough history to continue working from a chosen boundary.

- **Fork** — A derived session created from an existing one, useful for branching session state.

- **Archive** — A persisted session snapshot that can be loaded independently of live session discovery.

## Main flows

### Create or resume a session

1. A consumer calls into `src/session` through `src/session/index.ts`.
2. Path helpers resolve the relevant project and session location.
3. Session helpers such as `latestSession` or `findSession` select a session, or `createSession` initializes a new one.
4. The resulting session data can then be read or modified by higher-level consumers.

### Load transcript or context

1. A consumer identifies a session through list or find operations.
2. `loadTranscript` or `loadContext` reads the session record.
3. If the session cannot be resolved or its transcript cannot be parsed, `UnknownSessionError` or `TranscriptUnreadableError` signals the problem.

### Compact or export a session

1. A maintenance flow selects an existing session.
2. Compaction logic uses helpers such as `indexOfKeepFrom` and `compactMessages` to reduce transcript size.
3. If a human-readable artifact is needed, `exportSessionMarkdown` produces an export representation.

## Reference

### Public API

| Symbol | Purpose |
|--------|---------|
| `keryxDataDir` | Resolves the top-level data directory |
| `projectKeyFromPath` | Derives a stable project key from a path |
| `projectSessionsDir` | Returns the sessions directory for a project |
| `resolveProjectRoot` | Locates the project root for a given path |
| `sessionDir` | Returns the storage directory for a specific session |
| `compactMessages` | Reduces message array size during compaction |
| `indexOfKeepFrom` | Determines the boundary index for compaction |
| `SESSION_SCHEMA_VERSION` | Schema version constant |
| `TranscriptUnreadableError` | Error when transcript cannot be parsed |
| `UnknownSessionError` | Error when session cannot be found |
| `compactSession` | Performs full session compaction |
| `createSession` | Initializes a new session |
| `exportSessionMarkdown` | Exports session as Markdown |
| `findSession` | Locates a specific session |
| `forkSession` | Creates a derived session |
| `latestSession` | Retrieves the most recent session |
| `listSessions` | Enumerates all sessions |
| `loadArchive` | Loads a session archive |
| `loadContext` | Loads session context |
| `loadTranscript` | Loads session transcript |

### Key files

| File | Imports received | Imports made |
|------|-----------------|--------------|
| `src/session/slate.ts` | 30 | 4 |
| `src/session/store.ts` | 14 | 6 |
| `src/session/slate-lifecycle.ts` | 13 | 3 |
| `src/session/index.ts` | 8 | 3 |
| `src/session/slate-course.ts` | 9 | 2 |
| `src/session/slate-terminal-state.ts` | 5 | 4 |

### Module dependencies

- **Depends on**: `src/lib` (6), `src/harness/provider` (4), `src/security` (3), `src/gdgraph` (2), `src/sac` (1), `src/flow` (1)

- **Depended on by**: `src/commands` (21), `src/sac` (19), `src/harness/tool/builtin` (12), `src/tui` (10), `src/lib` (3), `src/mcp` (2)

### Graph signals

- Files: 16
- Cross-module imports: 18

## Related Wiki

- [Wiki Index](../index.md)
- [Module src/lib](src-lib.md)
- [Module src/harness/provider](src-harness-provider.md)
- [Module src/security](src-security.md)
- [Module src/gdgraph](src-gdgraph.md)
- [Module src/sac](src-sac.md)
- [Module src/flow](src-flow.md)
- [Module src/commands](src-commands.md)
- [Module src/harness/tool/builtin](src-harness-tool-builtin.md)

## Changelog

- 0.1.0 — Generated by `keryx wiki collect` at 2026-09-16T16:24:12.891Z. Prose sections are drafts for the gdwiki enrich workflow.
