# Implementation Plan — Flow 009 (W7 Release 0 slice)

Status: frozen scope (W7 only) — RELEASE BOUNDARY

## Approach

Assemble the Release 0 offline read-only runtime from the W4 validator, W5 ports,
and W6 fakes, test-first, in 5 coherent sub-slices. No new primitives — reuse.
Deterministic (fixed clock/ids), offline (no network/SDK), read-only (no fs
mutation). Every durable payload validated via `src/contracts`. Coverage is
driven by the `@task-R0-01/02/03` scenarios in acceptance.feature.

## Worker routing & Model Policy

| Task | Kind | Worker | Model | Slice |
|---|---|---|---|---|
| T5/T7/T9/T11/T13 | test | tests-creator | **Sonnet** | S1–S5 RED |
| T6/T8/T10/T12/T14 | implement | task-implementer | **Opus 4.8** | S1–S5 impl |
| T15 | review | review-orchestrator | **Opus 4.8** | verify |
| T2/T3/T4 | umbrella | orchestrator | Opus | seed |

Orchestrator = Opus. Workers via `subagent-dispatch` → `subagent-result` with a
worktree-guard (cd + pwd) in every writing dispatch. TDD: RED before impl per slice.

## Sub-slices (each RED → GREEN)

- **S1 R0-01** (T5/T6) — `config`/`startup` + context-manifest: disabled floor
  (byte-identical, no provider/socket), enabled-startup preconditions, typed
  `environment_blocked`, bounded manifest with scope+fingerprints, offline
  guarantee, disabled-overhead SLO. SC_R01/R02/R14.
- **S2 session** (T7/T8) — append-only `session-manifest`/`session-entry`,
  reconstructable tree + currentLeaf, resume without duplicating evidence,
  deterministic schema migration. SC_R06.
- **S3 policy** (T9/T10) — deterministic allow/ask/deny over `policy-profile` →
  `harness-policy-decision`; hard-deny unoverridable; headless-ask fail-closed;
  stale-approval invalidation; role no-escalate; direct flow-file edit denied;
  stale/untrusted context never becomes policy. SC_R05/R07/R08/R09.
- **S4 completion** (T11/T12) — `completion-gate-result` (required evidence+gates,
  undisposed blocker, evidence-free reject), evidence records, redaction-before-
  persistence (preview+hash+category+provenance; scan-fail blocks), metric
  reliability (no fabricated exact metrics). SC_R10/R11.
- **S5 run+transport+replay** (T13/T14) — run loop assembling
  context→provider→tool→policy→session→completion; tool limits (timeout/overflow);
  budget/loop detection; CLI + JSONL/RPC (`rpc-jsonl-envelope`) semantic parity +
  transport cannot change policy; effect-free offline replay (`replay-fixture`/
  `replay-mismatch`, no live provider/network/mutating tool). SC_R04/R12/R13.

## Steps

1. T1: slice map + scenario coverage (context.md).
2. Per slice Sn: dispatch RED tests (Sonnet) → verify RED → dispatch impl (Opus)
   → verify GREEN (`tsc` + focused `bun test`) → accept.
3. T15: `tsc --noEmit` + full `bun test` (≥703 + new green); confirm every
   `@task-R0-01/02/03` scenario has a covering test; boundaries (offline/no-fs/
   no-SDK/deterministic); `deps {}`; frozen pkg + src/eval + src/contracts + ADRs
   untouched (reuse-only).
4. `keryx health run`; confirm ACs; completion choice (ask user A/B/C).

## Verification (TDD, real code)

Each slice RED before impl, GREEN after. Gate: `tsc` clean; full `bun test` ≥703
+ new green; determinism (no Date.now/Math.random/network/fs-write in slice code);
all durable payloads schema-valid; Release 0 scenario coverage complete.

## Risks

- **Scope/size** (~29 scenarios) → decomposed into 5 bounded sub-slices, each
  test-first and independently green; verify between slices.
- **Live side effects / non-determinism** → offline-only; fixed clock/ids; AC
  forbids network/fs-mutation; replay effect-free; T15 greps for violations.
- **Rewriting W4/W5/W6** → reuse-only; AC forbids new port/validator/dependency.
- **Transport changing policy** → policy engine is transport-independent; parity
  tests assert identical decisions across CLI and JSONL/RPC.
- **Wrong-worktree writes / tsc-cast / index-guard** (prior waves) → worktree-guard
  + fetch-cast + index-guard directives in every dispatch; verify after each.
- **Frozen edits** → new code only under src/harness/; validate against, never edit,
  the frozen schemas.
