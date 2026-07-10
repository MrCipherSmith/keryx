# Module src/flow

Version: 1.0.0
Type: component
Status: accepted

## Summary

`src/flow` groups 10 file(s). Depends on `src/memory`, `src/lib`. Exposes 2 public symbol(s).

## Overview

`src/flow` owns the Task Manager lifecycle: it tracks a unit of work ("flow") from initialization through implementation to gated completion. It is the single writer of flow state — all status changes, task updates, and acceptance-criteria bookkeeping are routed through the `FlowService` facade and never applied by hand. The module also handles deterministic context assembly at flow creation time, pulling in issue bodies, related memory entries, code-graph artifacts, and health status so that every flow package starts with structured, reproducible agent context.

## How it works

The module is organized into four layers that together enforce the flow lifecycle.

`machine.ts` defines the strict status state machine. It holds a `TRANSITIONS` table mapping each `FlowStatus` to its allowed successors (`initializing → ready → in-progress → implemented → completing → done`, with `blocked` available from any non-terminal state). `assertTransition` is the sole enforcement point; every caller in `service.ts` goes through it before touching `flow.status`.

`store.ts` is the persistence layer. It owns the filesystem layout (`<cwd>/.metaproject/flows/<NNN>-<YYYY-MM-DD>-<slug>/`), atomic reads and writes of `flow.json` via `writeFileAtomic`, sequential journal appends, and acceptance-criteria integrity. Acceptance-criteria integrity is enforced through a SHA-256 checksum stored in `flow.acChecksum`: `assertAcIntact` recomputes the checksum on every mutating call and rejects any out-of-band edit before the transition runs.

`context.ts` assembles a `context.md` document at `flow init` time. It queries the tracker adapter for the source issue body, searches `src/memory` for related entries (both episodic and procedural), references `gdgraph` summary artifacts, and reports the current health-gate status. The result is a deterministic baseline that the flow-init skill enriches with brainstorm and interview results.

`templates.ts` generates all Markdown scaffolding for a new flow package (`description.md`, `plan.md`, `tasks.md`, `acceptance-criteria.md`, `journal.md`) and also renders the Markdown source of the flow skill router and the three sub-skill files (flow-init, flow-manager, flow-complete). These are pure string functions with no side effects.

`service.ts` is the public facade. `createFlowService` accepts an injectable `FlowServiceDeps` (clock, tracker adapter, health gate, optional security gate) and returns a `FlowService` object. All mutating operations go through the `mutate` helper, which holds a per-flow file lock (`withFileLock`) to serialize concurrent agents (F-100). The `save` helper stamps `updatedAt`, appends a history entry, writes `flow.json`, and writes a journal line — so every state change is automatically traced.

## Key concepts

- **Flow** — the central domain object: a named unit of work tracked from initialization to completion. Persisted as `flow.json` inside a versioned directory.
- **FlowStatus** — the current lifecycle position: `initializing`, `ready`, `in-progress`, `implemented`, `completing`, `done`, or `blocked`. Transitions are strictly validated by `machine.ts`.
- **Acceptance criteria (AC)** — verifiable completion conditions written in `acceptance-criteria.md` with the format `- ACn: <criterion>`. After `flow freeze` the file is checksum-protected; any external edit is detected by `assertAcIntact` and blocks all further transitions.
- **Flow package** — the directory bundle for one flow: `flow.json` (machine state), `description.md`, `context.md`, `plan.md`, `tasks.md`, `acceptance-criteria.md`, `journal.md`.
- **Task** — a sub-unit of work inside a flow (`T1`–`T4` by default), typed as `context | implement | test | review`. Status lives exclusively in `flow.json`.
- **Gate** — a completion check run by `flow complete`: acceptance-criteria (all confirmed + checksum intact), pull-request (exists, checks green), code health, and optionally security. All gates must pass for the flow to reach `done`.
- **TrackerAdapter** — the injected interface to the external issue tracker (GitHub). Used to fetch issue bodies, verify PR existence, check CI status, and post completion comments.

## Main flows

**Flow initialization (`flow init`).** When `service.init` is called it first invokes `collectContext` (`context.ts`) which assembles deterministic context from the tracker, memory, gdgraph artifacts, and health status. Inside a `.flow-init.lock` file lock, `nextFlowId` allocates the next three-digit ID, a directory is created under `.metaproject/flows/`, and `templates.ts` renders all six Markdown files. The `FlowState` object starts at status `initializing` and is written atomically. The caller receives the new flow's directory and any context-collection notes.

**Status transitions (`flow freeze` → `flow start`).** After a human or agent writes criteria into `acceptance-criteria.md`, `service.freeze` reads the criteria via `store.readAcCriteria`, verifies they are non-empty and not placeholder text, computes a SHA-256 checksum, stores it in `flow.acChecksum`, and records status `ready`. `service.start` then calls `transition` which runs `assertAcIntact` (checksum check) and `assertTransition` (machine check) before moving the status to `in-progress` and flushing to disk with a journal entry. Every subsequent mutating call repeats `assertAcIntact` so the criteria cannot be silently modified during implementation.

**Flow completion (`flow complete`).** `service.complete` takes a file lock on the flow, transitions status to `completing`, then evaluates four gates in sequence: (1) all AC criteria confirmed with matching checksum; (2) PR exists with green CI checks via the tracker adapter; (3) code-health gate via the injected `healthGate` dep; (4) optional security gate. If all gates pass, the flow moves to `done` and, when `--comment` is set and the source is a GitHub issue, a summary comment is posted via the tracker adapter. If any gate fails, the flow reverts to `in-progress` with failure details logged to the journal and history.

---

## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Public API

- `createFlowService` (function)
- `collectContext` (function)

### Key files

- `src/flow/service.ts` - imported by 5, imports 5
- `src/flow/context.ts` - imported by 2, imports 5
- `src/flow/store.ts` - imported by 2, imports 1
- `src/flow/templates.ts` - imported by 3, imports 0
- `src/flow/machine.ts` - imported by 2, imports 0
- `src/flow/context-inject.test.ts` - imported by 0, imports 1

### Depends on

- `src/memory` - 4 import(s)
- `src/lib` - 3 import(s)

### Depended on by

- `src/commands` - 3 import(s)
- `src/review` - 2 import(s)
- `src/mcp` - 1 import(s)

### Graph signals

- Files: 10
- Cross-module imports: 7

## Related Wiki

Graph-derived - regenerated by `keryx wiki collect --force`. Only pages that
exist are linked; when enriching, add new links only to pages you have verified.

- [Wiki Index](../index.md)
- [Module src/memory](src-memory.md)
- [Module src/lib](src-lib.md)
- [Module src/commands](src-commands.md)
- [Module src/review](src-review.md)
- [Module src/mcp](src-mcp.md)

## Changelog

- 1.0.0 - Prose sections enriched by gdwiki enrich workflow (2026-07-10). Status: accepted.
- 0.1.0 - Generated by `keryx wiki collect` at 2026-07-10T08:14:04.890Z. Prose sections are drafts for the gdwiki enrich workflow.
