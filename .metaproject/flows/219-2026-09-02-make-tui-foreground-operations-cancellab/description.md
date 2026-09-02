# Make TUI foreground operations cancellable and preserve wiki enrich command semantics

Status: ready for freeze
Source: user-reported live-session defect (`...fa69fce4`)

## Problem

The OpenTUI shell marks in-process wiki enrichment as busy but does not register it in the cancellation lifecycle used by normal agent turns. Consequently `/interrupt`, Queue → Force, and session exit cannot reliably stop enrichment, forced questions can remain queued or be re-routed to Side-1, provider requests continue, and stale callbacks may touch destroyed UI.

The same hard pre-router also treats an explicit `keryx wiki enrich ...` line as natural-language intent and reconstructs the operation with hard-coded/default values, losing supplied flags.

## Expected Outcome

All cancellable foreground work is owned by one identity-safe lifecycle. Wiki enrichment receives cancellation end to end, stops scheduling and persistence after abort, preserves completed work, and settles before priority/FIFO queue drain. Explicit wiki-enrich command arguments retain their meaning. Regression tests cover the lifecycle, provider seam, pool behavior, and command routing.

## Out of Scope

- Moving wiki enrichment to a detached OS/background process.
- Redesigning the background-job registry or sidebar.
- Changing provider adapters that already honor `StreamOptions.signal`.
- Changing general queue ordering or side-worker semantics beyond cancellation settlement.
