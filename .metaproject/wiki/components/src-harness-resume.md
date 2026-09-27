---
Title: Module src/harness/resume
Version: 0.1.0
Type: component
Status: draft
Summary: "`src/harness/resume` groups 7 file(s). Depends on `src/harness/session`, `src/contracts`, `src/harness`. Exposes 5 public symbol(s)."
---

# Module src/harness/resume

## Summary

Provides the resumable-session layer of the [harness](src-harness.md). This module enables capturing session state, persisting it, and recovering execution when a session resumes later. It defines contracts for snapshots, checkpoints, and storage, along with an in-memory store implementation.

**Key facts:**
- 7 files, 25 cross-module imports
- Depends on: [src/harness/session](src-harness-session.md), [src/contracts](src-contracts.md), [src/harness](src-harness.md)
- Exposes 5 public symbols

## Overview

This module owns the resumable-session layer of the harness. It provides shared abstractions for:

- **Capturing** session state at a point in time
- **Storing** that state through a storage abstraction
- **Recovering** state when execution continues later

This separation lets callers reason about state restoration independently of storage details, and keeps recovery behavior and error handling separate from the core state contracts.

## Key Concepts

- **Session snapshot** — A persistable representation of session state, allowing a session to survive process restarts or move across boundaries.
- **Checkpoint** — A resumable point in a session's progress; the operational unit that resume flows work against.
- **Session store** — A persistence abstraction (the `SessionStore` interface) for managing snapshots. Callers depend on the interface rather than a specific backend.
- **In-memory store** — `InMemorySessionStore` is a concrete implementation for process-local use, tests, and development.
- **Unknown session error** — `UnknownSessionError` is a typed error for missing or unidentifiable sessions.

## Architecture

### Contracts (state interfaces)

| Symbol | Purpose |
|--------|---------|
| `SessionSnapshot` | Describes a persisted representation of session state |
| `Checkpoint` | Describes a resumable point in a session's progress |
| `SessionStore` | Defines how snapshots are saved, retrieved, and managed |

### Persistence

- `InMemorySessionStore` implements `SessionStore` for in-process scenarios.
- Keeps the resume path usable without external infrastructure.
- Alternative stores can satisfy the same `SessionStore` interface, making persistence storage-agnostic.

### Recovery

- `recovery.ts` contains the logic that determines whether a requested session's state is available and usable.
- `UnknownSessionError` surfaces missing sessions as a typed error rather than a generic failure.

### Harness Integration

The module integrates with the broader [harness](src-harness.md) through its dependencies:

- [src/harness/session](src-harness-session.md) — 9 imports
- [src/contracts](src-contracts.md) — 4 imports
- [src/harness](src-harness.md) — 4 imports

Resumed state re-enters the harness execution flow rather than existing as an isolated data structure.

## Main Flows

### 1. Prepare state for resume

1. Session-related state is captured as snapshot- or checkpoint-shaped data.
2. Downstream harness components consume this state without needing to know its origin.

### 2. Persist and reload snapshots

1. `InMemorySessionStore` accepts snapshot values.
2. It returns them later within the same process.
3. Because persistence sits behind the `SessionStore` interface, resume behavior remains storage-agnostic — other implementations can be swapped in without changing callers.

### 3. Handle unknown sessions

1. Recovery attempts to resolve the requested session state.
2. If resolution fails, `UnknownSessionError` is raised.
3. Callers can distinguish unknown or unavailable sessions from other runtime failures.

## Public API

| Symbol | Type | Location |
|--------|------|----------|
| `Checkpoint` | interface | `resume.ts` |
| `SessionSnapshot` | interface | `resume.ts` |
| `SessionStore` | interface | `store.ts` |
| `UnknownSessionError` | class | `recovery.ts` |
| `InMemorySessionStore` | class | `store.ts` |

## Key Files

| File | Imports | Purpose |
|------|---------|---------|
| `store.ts` | 11 / 1 | Session store interface and in-memory implementation |
| `recovery.ts` | 5 / 2 | Recovery logic and error types |
| `resume.ts` | 1 / 8 | Core interfaces (`SessionSnapshot`, `Checkpoint`) |
| `resume.test.ts` | 0 / 14 | Tests for core resume behavior |
| `recovery.test.ts` | 0 / 5 | Tests for recovery logic |
| `recovery.hardening.test.ts` | 0 / 5 | Hardening tests for recovery edge cases |

## Dependencies

### Module depends on

- [src/harness/session](src-harness-session.md) — 9 imports
- [src/contracts](src-contracts.md) — 4 imports
- [src/harness](src-harness.md) — 4 imports
- [src/harness/provider](src-harness-provider.md) — 3 imports
- [src/harness/run](src-harness-run.md) — 2 imports
- [src/harness/tool](src-harness-tool.md) — 2 imports

### Depended on by

- [src/harness/branch](src-harness-branch.md) — 4 imports
- [src/harness/mutation](src-harness-mutation.md) — 3 imports
- [src/harness](src-harness.md) — 1 import
- [src/harness/process](src-harness-process.md) — 1 import

## Related

- [Wiki Index](../index.md)
- [Module src/harness](src-harness.md)
- [Module src/harness/session](src-harness-session.md)
- [Module src/contracts](src-contracts.md)

## Changelog

- **0.1.0** — Generated by `keryx wiki collect` at 2026-09-16T16:24:12.891Z
