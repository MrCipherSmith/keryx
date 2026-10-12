# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Approval baseline and guarantee

Draft, not frozen or confirmed. Source audit: origin/main `6bf403944003c42fc6312ffd011e504426307382`, fetched 2026-10-08. Revalidate advancing main at implementation start.

Catchable shutdown preserves the last received state. SIGKILL/power loss cannot run a finalizer: recovery guarantees cover committed checkpoints and acknowledged critical records under the documented filesystem contract, not every displayed streaming token. Local preservation, workspace proposal and human acceptance are distinct outcomes.

## Criteria

- AC1: Executable behavioral/child-process tests cover a shared single-flight finalizer for TUI/readline agent/chat and print: /exit, busy exit, EOF, renderer destruction, SIGINT/SIGTERM/SIGHUP and startup/turn exceptions. Before session creation it is a safe no-op; concurrent exit triggers finalize each snapshot generation once. Session switching preserves the outgoing generation without terminating the new session.
- AC2: Graceful exit stops intake, bounds cancellation/settlement and commits the last received history delta, archive/context metadata and Notes/Trail/Course/Seeds before ownership release. Critical tool outcomes and successful scratch-write acknowledgements persist before success is reported; required write failures are visible, retain the prior committed generation and never report saved.
- AC3: A versioned generation commit selects a complete consistent session/scratch checkpoint; injected interruption after each payload write and commit boundary never loads mixed generations. Readers recover the latest valid committed generation or report explicit corruption. Legacy migration, fsync/rename assumptions and unsupported storage limits are documented and tested.
- AC4: Immutable durable wrap-up intent commits before live Slate archival, with session/generation identity, snapshot hash, trigger, per-group states and receipts. Trusted evidence generation/delivery read the pinned snapshot after archival/reopening, not mutable current Slate or later working-tree diff; replay never rebinds or writes a successor's live Slate.
- AC5: Seeds use trusted evidence/redaction/policy paths to reviewable proposals or durable named deferred/unbound/blocked outcomes with reason and recovery reference. Missing credentials, external off, timeout and unavailable/archived/deleted or ambiguous workspace never discard candidates silently, recreate a removed identity or bypass guards. Existing ordinary-session workspace resolution policy and external-unbound artifact-only policy remain intact.
- AC6: Zero Seeds still preserves Notes and critical tool outcomes as evidence-linked review inventory, evidence-backed draft candidates or explicit deferred review. A nontrivial zero-Seed fixture cannot silently return nothing; a trivial session records no durable results without unnecessary model calls/workspace creation. Notes/candidates never become accepted memory automatically.
- AC7: Next startup and documented explicit retry/catch-up recover unfinished intents from immutable evidence. Crash after proposal creation before receipt, partial group success, repeated exit and concurrent replay create at most one proposal per stable snapshot/group key; only unfinished groups retry. Security refusals stay visible and retry uses current authorized policy, never a bypass.
- AC8: After alternate-screen restoration, stderr shows saving start/progress, separate truthful local-saved/proposed/deferred/failed counts, elapsed time and recovery reference; unavailable terminal output never blocks persistence. Noninteractive stdout stays parseable. Required preservation failure cannot produce clean success; original failure/signal semantics are preserved. Optional hook/inference/recovery work has bounded configurable budgets, default 10 seconds for optional exit inference; timeout leaves durable pending work, never falsely marks disk writes saved.
- AC9: Ownership/takeover tests prevent successor-owned writes and competing live recovery, retain ownership through required checkpoint/intent commitment and preserve bus-before-lease release ordering. Late callbacks cannot mutate closed generations; session jobs/MCP/remote resources are cleaned while intentionally detached scheduled/review runs survive. Startup recovery cannot indefinitely block composer availability.
- AC10: Child-process/PTY fault tests cover SIGKILL, terminal closure/SIGHUP, injected ENOSPC/EACCES/write errors and corrupt snapshots. Acknowledged critical records recover from committed checkpoints; incomplete generations are diagnosed without destroying the last valid one; uncommitted streaming-tail uncertainty is explicit. No post-SIGKILL handler or unsupported power-loss guarantee is promised.
- AC11: Targeted tests, typecheck, lint, independent durability/idempotency/security review, core CI and literal full bun run check pass with evidence tied to the final implementation SHA. Security regressions cover redaction/refusals, credential nondisclosure, no execution of transcript-shaped instructions and no automatic acceptance; exit correctness tests are executable, not solely source-string assertions.
- AC12: Operator verifies normal exit, busy streaming/tool exit, offline/external-off deferred wrap-up and restart/explicit retry without duplicate proposals on an installed released artifact, recording version/path and evidence. Docs distinguish local preservation, proposals and human acceptance, list recovery commands and explain SIGKILL/storage limits; operator confirmation is separate from automated tests.

## Evidence required at implementation review

Exit matrix; checkpoint fault boundaries; snapshot/proposal key and receipts; zero-Seed/trivial fixtures; policy/ownership regressions; final-SHA gate logs; independent review; installed-artifact operator transcript. None is claimed complete by this draft.
