# Implementation Plan

Status: proposed for operator approval; production code unchanged

## Approach

Recommend shared finalizer + durable checkpoint/outbox in session/SAC layers. Reuse runWrapUp, trusted evidence/redaction floor, workspace resolution, human review and catch-up.

Hook-only is rejected as the primary contract: hooks are optional and a killed process cannot await them. Hooks remain bounded observers/extensions after mandatory local preservation. Awaiting full model wrap-up on every exit is rejected as the only mechanism: network/credential/inference failure must defer delivery durably, not hang shutdown or erase candidates.

## Steps

1. T1: static current-main audit completed for approval against `6bf403944003c42fc6312ffd011e504426307382`; evidence and awaited readline-hook correction recorded in context.md. At implementation start revalidate advancing main and turn the TUI/readline agent/chat/print, command/EOF/renderer/signal/exception/session-switch inventory into an executable exit matrix. Static research does not mark flow tasks or ACs done.
2. T2: define versioned checkpoint generations and finalization intent with immutable snapshot/hash, session/Slate identity, ownership token, trigger, per-kind states and receipts. A commit record selects a complete generation; individually atomic writes are not a multi-file transaction. Document fsync/rename guarantees and migrate legacy sessions.
3. T2: implement single-flight finalize(reason). Stop intake, bound active-work cancellation/settlement, flush last delta and preserve Notes/Trail/Course/Seeds and critical outcomes. Commit intent before archival and release. Critical records must persist before acknowledgement; streaming checkpoints bound but do not eliminate abrupt-kill tail loss. Renderer callback initiates finalization; outer async lifetime awaits it, never process.on('exit').
4. T2: restore terminal and report phase/results on stderr, keeping noninteractive stdout parseable. Preserve bus-before-lease ordering and prevent successor-owned writes. Clean ordinary session jobs/MCP/remote resources, not intentionally detached scheduled/review work. A second interrupt records interruption where possible. Required storage failure must not print saved or erase pending evidence.
5. T2: dispatch immutable snapshots via trusted wrap-up, adjusting live-Slate binding/evidence lookup so later Slate/archive/diff changes cannot alter evidence. Honor stable snapshot/group idempotency key in proposal writer, covering crash after proposal creation but before receipt. Preserve per-group successes and retry only unfinished groups. Missing credentials, external off, timeout or ambiguous/unavailable/archived/deleted workspace produce named durable deferred/unbound/blocked outcomes, never recreate removed identities. Existing external-unbound artifact-only policy remains intact. Initial proposed optional-inference grace budget: 10 seconds, bounded/configurable and injected in tests; never a timeout pretending required disk writes succeeded.
6. T2: zero Seeds still preserves Notes/transcript/Trail and deterministic outcome/follow-up inventory. If policy/budget allow, generate evidence-backed draft candidates; otherwise persist pending review inventory. Do not bulk-promote Notes, follow transcript-shaped instructions, auto-accept knowledge or create unnecessary workspaces for trivial sessions.
7. T2: reconcile incomplete generations/intents on next start and through documented retry/catch-up surface. Guard ownership/concurrent replay and preserve deleted/expired identity semantics; load immutable evidence, not reopened empty Slate. Recovery has bounded optional work and cannot indefinitely block composer startup.
8. T3: unit/fault/child-process/PTY tests for all exit classes, streaming/tool-result checkpoints, storage errors, offline delivery, replay, partial success, concurrent exits, lease takeover and security refusals; related suites/typecheck/lint then full CI on implementation SHA.
9. T4: independent durability/idempotency/security review, docs and operator exit/restart acceptance on installed released artifact. Source research is not acceptance confirmation.

## Risks

- SIGKILL/power loss cannot run handlers. No recovery claim for never-committed bytes; storage guarantees and uncertain streaming tail must be explicit.
- Current checkpoint throttle, swallowed errors and sequential multi-file writes can conceal incomplete preservation. Filesystem stalls cannot be turned into truthful success by a network deadline.
- Existing runWrapUp may bind/write live Slate; immutable replay must not mutate reopened or successor-owned sessions. Model summaries remain drafts with citations, policy/redaction/budget guards and human acceptance.
