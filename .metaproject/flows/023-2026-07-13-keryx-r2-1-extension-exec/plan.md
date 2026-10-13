# Implementation Plan — Flow 023 (Release 2 · R2-1 extension-execution)

Status: frozen scope (R2-1 only) — Release 2

## Approach

Add `src/harness/extension/execute.ts` composing the W12 canonical child adapter +
per-capability containment, the W15 registry, the W10 approval, and W8 immutable
attempts, test-first: a registered extension is DISPATCHED with bounded, policy-governed
execution authority (canonical round-trip, STATUS→canonical before persist); a broader
tools/provider request is an escalation that requires explicit policy + provenance +
approval or is DENIED (no silent authority gain); a NEEDS_CONTEXT result retries with the
same dispatch id adding only the named artifact, prior attempt immutable. Additive-only to
prior modules; deterministic/offline; deps `{}`.

## Worker routing & Model Policy

| Task | Kind | Worker | Model | Reviewer |
|---|---|---|---|---|
| T5 (RED) | test | tests-creator | **Sonnet** | security/contract |
| T6 (impl) | implement | task-implementer | **Opus 4.8** | security/contract |
| T7 (review) | review | review-orchestrator | **Opus 4.8** | security/contract |
| T2/T3/T4 | umbrella | orchestrator | Opus | — |

Orchestrator = Opus. Workers via subagent-dispatch → subagent-result, worktree-guard
(`cd ~/goodea/keryx`).

## Steps

1. T1: R2-1 scope + 3 scenarios + reuse surface + integration map (context.md).
2. T5 (RED): `execute.ts` tests — (a) dispatchExtension: registered extension → canonical
   subagent-dispatch (validates) + STATUS-first result → canonical subagent-result before
   persist (validates); bounded to granted capabilities. (b) evaluateExtensionGrant: requested
   ⊆ granted → ok; broader tools/provider WITHOUT policy/provenance/approval → DENY (each
   missing piece independently denies); with all three → ok; out-of-enum fail-closed. (c)
   retryWithContext: NEEDS_CONTEXT → same dispatch id, only the named artifact added, prior
   attempt immutable (`.toThrow()`).
3. T6 (GREEN): `src/harness/extension/execute.ts` composing W12/W15/W11/W10/W8. Additive
   helpers to registry/child only if needed. Make T5 green.
4. T7 (review): escalation fail-closed (adversarial — any path to a broader capability without
   policy+provenance+approval?); canonical validation both directions; STATUS→canonical before
   persist; NEEDS_CONTEXT same-id + add-only-artifact + prior immutable; D-02 (no flow.json
   write); reuse-only (W12/W15/W11/W10/W8 unmodified or additive); deterministic; deps `{}`;
   frozen pkg + canonical schemas + src/eval + src/contracts + ADRs untouched.
5. `keryx health run`; confirm ACs; completion (option B) + PR (no co-authorship).

## Verification

Gate: `tsc` clean; full `bun test` ≥1210 + new green; canonical dispatch/result validate
against the frozen schemas; escalation without policy+provenance+approval DENIES (no silent
authority gain); NEEDS_CONTEXT retry same-id/add-only/prior-immutable; extension/child write
no flow.json; deterministic; no new dependency.

## Risks

- **Silent authority gain (escalation without policy)** → the KEY negative: T5/T7 assert that
  a broader-capability request denies unless policy AND provenance AND approval are all present;
  reuse `inheritPolicy` containment; each missing piece independently denies.
- **Extension writing flow.json (D-02 breach)** → the extension path only produces a dispatch/
  evidence; completion flows through ManagedFlowPort; T7 greps writeFlow/flow.json in
  src/harness/extension = 0.
- **Mutating a prior attempt on NEEDS_CONTEXT** → reuse W8 immutable attempts; the retry adds
  only the named artifact under the same dispatch id; prior attempt frozen (`.toThrow()`).
- **Rewriting W12/W15/W11/W10/W8** → reuse-only/additive; if a real refactor seems needed, STOP
  and report.
- **Non-determinism / new dep** → injected id/clock, no Date.now/Math.random; no SDK/network;
  deps `{}`.
- **Wrong-worktree / index-guard / frozen-array** → guard directives in every dispatch.
