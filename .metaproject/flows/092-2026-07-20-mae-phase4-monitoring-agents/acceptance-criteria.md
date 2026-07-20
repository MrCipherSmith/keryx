# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `reduceAgents(events)` in `src/harness/monitor/reduce.ts` folds a canonical `agent-event` array into an `AgentsSnapshot` — a per-`dispatch_id` record `{dispatchId, status, model?, source?, budgetRemaining?, usage}` — mapping dispatch_created→running, dispatch_completed→done, dispatch_blocked→blocked, run_failed/validation_failed→failed; unknown/absent → a defined default. Deterministic with stable key order.
- AC2: Usage accounting sums ONLY provider-reported exact token counts (event `data.usage` with `exact:true`); inexact/unknown usage is marked (not summed as exact), mirroring `NormalizedUsage.exact`.
- AC3: `diffAgents(prev, next)` derives ordered delta events (spawned/running/idle/done/failed/blocked) from two snapshots; deterministic and stable-ordered.
- AC4: A read-only `keryx agents [--json]` command folds a persisted/provided `agent-event` source and renders it — `--json` emits the `AgentsSnapshot`; text renders a parent→child tree with status, model, and ↑in/↓out tokens. The command writes nothing and has an honest descriptor in the command registry.
- AC5: `reduceAgents`/`diffAgents` are PURE — no `Date.now`/`Math.random`/network/fs inside the fold (the CLI does all I/O and any arrival-ordered rendering); the display layer never feeds back into the fold or a state hash.
- AC6: `reduce.test.ts` covers fold determinism, exact-vs-inexact usage, every status mapping, and diff deltas; the command has a json-output test; the full test suite (incl. the zero-`dependencies` guard) passes and `tsc --noEmit` is clean.
