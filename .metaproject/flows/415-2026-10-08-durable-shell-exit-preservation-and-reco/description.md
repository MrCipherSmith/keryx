# Durable shell exit preservation and recoverable workspace wrap-up

Status: researched proposal; production implementation awaits approval
Source: user description

## Problem

Shell teardown is fragmented. Slate archival does not dispatch SAC proposals; optional SessionEnd is unawaited in TUI renderer teardown (normal readline REPL awaits it); signal/renderer exits can release ownership without a final history/Slate checkpoint. Persisted Notes survive locally but are not automatically reviewed or transferred to workspace. A post-exit script alone cannot guarantee preservation after SIGKILL, a crash or terminal disappearance.

Current-main revalidation: `6bf403944003c42fc6312ffd011e504426307382`; pinned source evidence is in context.md.

## Expected Outcome

All catchable exits use one idempotent finalizer: stop intake, settle/cancel active work, commit session and scratch evidence plus a durable wrap-up intent, archive Slate, clean resources and release ownership. Restore the terminal and show progress and truthful saved/proposed/deferred/failed outcomes on stderr. Abrupt exits recover committed checkpoints and unfinished intents at next start. Seeds and evidence-backed candidates become reviewable proposals, never automatically accepted knowledge.

## Outcome criteria

- Fault-injection and operator exit/restart scenarios demonstrate recovery of acknowledged critical records without duplicate proposals. Graceful exit preserves the last received streaming delta; abrupt kill guarantees only committed checkpoints, explicitly reporting possible uncommitted streaming-tail loss.

## Out of Scope

Automatic acceptance of memory/wiki/workspace changes; bypassing policy, redaction, credentials or approvals; guarantees for never-committed bytes or hooks after SIGKILL; implementation, commit/push/merge/release in this research step.
