# Context — Flow 010 (W16 Release 0 evidence)

Collected by `keryx flow init` and enriched for W16. (T1 context.) Release 0 boundary.

## Baseline
- `bun test` = 797 pass / 0 fail; `tsc --noEmit` clean; deps `{}`. Branch @ ca57c56.

## W1–W7 artifacts to inventory (evidence sources)
- Decisions/docs (`docs/decisions/keryx-harness/`): ADR-0001…0004, EV-01-corpus-relocation.md, TM-01-task-manager-evolution.md, contract-inventory.md, decision-registry.md, research-ledger.md.
- Runtime: `src/harness/{config,startup,context,session,policy,evidence,completion,run,rpc,replay,provider,tool}`, `src/contracts/*`, `src/eval/*`, `src/flow/*` (TM evolution).
- Flows (journals = per-wave evidence): 003 (W1), 004 (W2), 005 (W3), 006 (W4), 007 (W5), 008 (W6), 009 (W7).
- Commits: W1 690b376, W2 99952a5, W3 39a884b, W4 2b92515, W5 d5fa7c0, W6 3b06260, W7 ca57c56.
- Frozen source of truth (cite, never edit): `docs/requirements/keryx-project-agent-harness/` (implementation-plan §W16, specification, acceptance.feature Release 0).

## Deliverables (all under docs/decisions/keryx-harness/)
- E-01: `E-01-release0-evidence-matrix.md` (capability → status/source/test/commit) + update `research-ledger.md` (R0 findings/OPEN resolutions) + migration-notes (in the matrix or a section) + package-index (update `decision-registry.md`).
- E-02: `E-02-release0-review-package.md` (7-lens normalized review + severity BLOCKER/P0/P1/P2/P3).
- E-03: `flow-orchestrator-handoff.md` (DAG + frozen AC proposal + gates + constraints + out-of-scope + deferred) — ONLY if no BLOCKER/P0/P1.

## Known deferred (mark explicitly, non-blocking)
- SC_R12_TRANSIENT_RETRY → W8 (durable resume / immutable attempts).
- SC_R16_BUDGET_RESERVATION reconciliation → follow-up.

## Decisions (approved)
- Docs+reviews only; NO runtime code / test changes. E-02 = one 7-lens Opus reviewer → normalized package.
- Frozen requirements pkg + ADR-0001…0004 untouched; research-ledger/decision-registry (our artifacts) may be updated.

## Operational
- keryx = `bun ./src/cli.ts`; never commit to main.
- State only via `keryx flow`; workers via subagent-dispatch/result (STATUS: first line).
- WORKTREE-GUARD: every writing worker must `cd /Users/Goodea/goodea/keryx/.claude/worktrees/feature-keryx-harness-impl && pwd` first and write ONLY under it. Verify file locations after each worker.
- Order: E-01 (T5) → E-02 (T6) → E-03 (T7, gated on E-02 clean) → verify (T8).
