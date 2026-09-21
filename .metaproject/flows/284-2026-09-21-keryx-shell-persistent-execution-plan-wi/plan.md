# Implementation Plan

Status: ready

## Approach

Use a Slate-native session plan as the canonical v1 state and expose it through
three typed main-agent tools. The plan store owns validation, revision checks,
persistence, subscriptions, compact prompt rendering, and the seven-row UI
projection. The agent runtime consumes the store; the TUI only renders it.

Alternatives considered:

1. **FlowTask only.** Durable and gated, but too heavy for ordinary chat and
   coupled to Task Manager availability.
2. **Transcript parsing.** Minimal wiring, but status is inferred from prose and
   cannot reject stale transitions or reliably resume.
3. **Unified Flow/Slate adapter immediately.** Useful later, but bidirectional
   reconciliation is unnecessary for v1. Keep the store interface adaptable.

## Steps

1. Add failing tests for state transitions, persistence, tool schemas, agent
   continuation, and the sidebar window/panel.
2. Add an optional execution-plan field to Slate plus a lock-safe session plan
   store with a monotonic revision and at most one `in_progress` item.
3. Implement `plan_set`, `plan_update`, and `plan_get` in the main interactive
   tool factory. These metadata tools grant no filesystem or command access.
4. Inject a bounded plan snapshot into agent rounds and add one bounded
   continuation if a final reply leaves actionable items open.
5. Render a Plan panel above Background Jobs. Show up to seven rows using
   `start = clamp(active - floor(size / 2), 0, total - size)` and hide it when
   no plan exists.
6. Run focused tests, typecheck/lint, live TUI verification, self-review, and
   write the change report.

## Risks

- A completion guard can loop forever. Limit it to one continuation per user
  turn and surface remaining items if the agent still stops.
- Concurrent writes can overwrite progress. Require expected revision and
  return a visible conflict.
- Extending Slate can drop state in copy/fork/fold paths. Test resume and
  read-modify-write behavior, not only serialization.
- Small terminals constrain height. Use a hug-content box capped at seven rows
  and the existing scrollable sidebar.
- Reusing `/plan` would confuse execution with permission state; preserve it.
