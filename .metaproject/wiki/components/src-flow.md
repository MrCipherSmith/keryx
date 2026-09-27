---
Title: Module src/flow
Version: 1.0.2
Type: component
Status: accepted
Summary: "Owns the Task Manager lifecycle: tracks a unit of work from initialization through implementation to gated completion. Provides the FlowService facade, deterministic context assembly, and strict status state machine with acceptance-criteria integrity."
---
# Module src/flow

VerifiedAt: 4e80355f1b9fa8576742d151d54397abbd527b38
VerifiedScope: sha256:0dd43b560b4b5fd355a0d84e0cc5191b1297637aeb9756e6a119230a17ab41b2

## Overview

`src/flow` owns the Task Manager lifecycle: it tracks a unit of work (a "flow") from initialization through implementation to gated completion. It is the single writer of flow state — all status changes, task updates, and acceptance-criteria bookkeeping are routed through the `FlowService` facade and never applied by hand.

The module handles deterministic context assembly at flow creation time, pulling in:

- Issue bodies from the tracker adapter
- Related memory entries (episodic and procedural)
- Code-graph artifacts from `gdgraph`
- Health status

This ensures every flow package starts with structured, reproducible agent context.

## Architecture

The module is organized into four layers that together enforce the flow lifecycle.

### State Machine (`machine.ts`)

Defines the strict status state machine with a `TRANSITIONS` table mapping each `FlowStatus` to its allowed successors:

```
initializing → ready → in-progress → implemented → completing → done
```

`blocked` is reachable from any non-terminal state. `assertTransition` is the sole enforcement point — every caller in `service.ts` goes through it before touching `flow.status`.

### Persistence (`store.ts`)

Owns the filesystem layout and all I/O:

- Directory structure: `<cwd>/.metaproject/flows/<NNN>-<YYYY-MM-DD>-<slug>/`
- Atomic reads and writes of `flow.json` via `writeFileAtomic`
- Sequential journal appends
- Acceptance-criteria integrity via SHA-256 checksum (`flow.acChecksum`)

`assertAcIntact` recomputes the checksum on every mutating call and rejects any out-of-band edit before the transition runs.

### Context Assembly (`context.ts`)

Assembles a `context.md` document at `flow init` time by querying:

- The tracker adapter, for the source issue body
- `src/memory`, for related episodic and procedural entries
- `gdgraph` summary artifacts
- The current health-gate status

The result is a deterministic baseline that the flow-init skill enriches with brainstorm and interview results.

### Templates (`templates.ts`)

Generates all Markdown scaffolding for a new flow package:

- `description.md`
- `plan.md`
- `tasks.md`
- `acceptance-criteria.md`
- `journal.md`

Also renders the Markdown source of the flow skill router and its three sub-skill files (flow-init, flow-manager, flow-complete). These are pure string functions with no side effects.

### Service Facade (`service.ts`)

`createFlowService` accepts an injectable `FlowServiceDeps` (clock, tracker adapter, health gate, optional security gate) and returns a `FlowService` object.

Key patterns:

- All mutating operations go through the `mutate` helper, which holds a per-flow file lock (`withFileLock`) to serialize concurrent agents (F-100)
- The `save` helper stamps `updatedAt`, appends a history entry, writes `flow.json`, and writes a journal line — every state change is automatically traced

## Key Concepts

- **Flow** — A named unit of work tracked from initialization to completion. Persisted as `flow.json` inside a versioned directory.
- **FlowStatus** — The current lifecycle position: `initializing`, `ready`, `in-progress`, `implemented`, `completing`, `done`, or `blocked`. Transitions are strictly validated by `machine.ts`.
- **Acceptance Criteria (AC)** — Verifiable completion conditions written in `acceptance-criteria.md` with the format `- ACn: <criterion>`. After `flow freeze`, the file is checksum-protected; any external edit is detected by `assertAcIntact` and blocks all further transitions.
- **Flow Package** — The directory bundle for one flow, containing: `flow.json`, `description.md`, `context.md`, `plan.md`, `tasks.md`, `acceptance-criteria.md`, `journal.md`.
- **Task** — A sub-unit of work inside a flow (`T1`–`T4` by default), typed as `context | implement | test | review`. Status lives exclusively in `flow.json`.
- **Gate** — A completion check run by `flow complete`:
  - Acceptance-criteria (all confirmed + checksum intact)
  - Pull-request (exists, checks green)
  - Code health
  - Optional security gate

  All gates must pass for the flow to reach `done`.
- **TrackerAdapter** — The injected interface to the external issue tracker (GitHub). Used to fetch issue bodies, verify PR existence, check CI status, and post completion comments.

## Main Flows

### Flow Initialization (`flow init`)

1. `service.init` invokes `collectContext` (`context.ts`) to assemble deterministic context from the tracker, memory, gdgraph artifacts, and health status
2. Inside a `.flow-init.lock` file lock, `nextFlowId` allocates the next three-digit ID
3. A directory is created under `.metaproject/flows/`
4. `templates.ts` renders all six Markdown files
5. The `FlowState` object starts at status `initializing` and is written atomically
6. The caller receives the new flow's directory and any context-collection notes

### Status Transitions (`flow freeze` → `flow start`)

1. After criteria are written into `acceptance-criteria.md`, `service.freeze` reads the criteria via `store.readAcCriteria`
2. Criteria are verified (non-empty, not placeholder text)
3. A SHA-256 checksum is computed and stored in `flow.acChecksum`
4. Status is recorded as `ready`
5. `service.start` calls `transition`, which runs:
   - `assertAcIntact` (checksum check)
   - `assertTransition` (machine check)
6. Status moves to `in-progress` and flushes to disk with a journal entry
7. Every subsequent mutating call repeats `assertAcIntact` — criteria cannot be silently modified during implementation

### Flow Completion (`flow complete`)

1. `service.complete` takes a file lock on the flow
2. Status transitions to `completing`
3. Four gates evaluate in sequence:
   - **AC gate**: All criteria confirmed with matching checksum
   - **PR gate**: PR exists with green CI checks via tracker adapter
   - **Health gate**: Code health via injected `healthGate` dependency
   - **Security gate**: Optional, if configured
4. If all gates pass:
   - Flow moves to `done`
   - If `--comment` is set and the source is a GitHub issue, a summary comment is posted via the tracker adapter
5. If any gate fails:
   - Flow reverts to `in-progress`
   - Failure details are logged to journal and history

---

<!-- keryx:reference:begin v=1 hash=3e42ef48b889af06e38aa38a8fc1cbb6c5ad4a6e3707845c0a5327bdf9fde58e -->
## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Public API

- `FlowStatus`
- `TaskKind`
- `TaskStatus`
- `AttemptOutcome`
- `AttemptEntry`
- `TaskAttempts`
- `TaskDisposition`
- `ATTEMPT_CLI_OUTCOMES`
- `AttemptCliOutcome`
- `TaskBudget`
- `TaskRunLink`
- `FlowTask`
- `FlowSource`
- `FlowHistoryEvent`
- `FlowGates`
- `SignatureConfirmation`
- `FlowSignature`
- `FlowState`
- `FlowSummary`
- `TrackerRef`

### Key files

- `src/flow/types.ts` - imported by 60, imports 3
- `src/flow/service.ts` - imported by 46, imports 16
- `src/flow/store.ts` - imported by 31, imports 2
- `src/flow/review-gate.ts` - imported by 21, imports 5
- `src/flow/review-fixtures.ts` - imported by 13, imports 2
- `src/flow/context.ts` - imported by 4, imports 8

### Depends on

- `src/lib` - 9 import(s)
- `src/memory` - 6 import(s)
- `src/review` - 5 import(s)
- `src/security` - 1 import(s)
- `src/contracts` - 1 import(s)

### Depended on by

- `src/commands` - 20 import(s)
- `src/review` - 17 import(s)
- `src/governance` - 4 import(s)
- `src/tui` - 3 import(s)
- `src/harness/flow` - 2 import(s)
- `src/harness/tool` - 2 import(s)

### Dependency basis

- Production imports only: 71 import(s) from test file(s) (e.g. `src/bus/flow-isolation.test.ts`) excluded from the two sections above in both directions.

### Graph signals

- Files: 55
- Cross-module imports: 22
<!-- keryx:reference:end -->

## Related Wiki

Graph-derived — regenerated by `keryx wiki collect --force`. Only pages that exist are linked; when enriching, add new links only to pages you have verified.

- [Wiki Index](../index.md)
- [Module src/memory](src-memory.md)
- [Module src/lib](src-lib.md)
- [Module src/commands](src-commands.md)
- [Module src/review](src-review.md)
- [Module src/mcp](src-mcp.md)

## Changelog

- 1.0.2 - Reference refreshed from the code graph (4e80355f).
- **1.0.1** — Reference refreshed from the code graph (5886c474)
- **1.0.0** — Prose sections enriched by gdwiki enrich workflow (2026-07-10); Status: accepted
- **0.1.0** — Generated by `keryx wiki collect` at 2026-07-10T08:14:04.890Z; draft for gdwiki enrich workflow
