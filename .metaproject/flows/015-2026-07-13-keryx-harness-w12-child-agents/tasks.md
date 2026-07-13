# Tasks — Flow 015 (W12 child agents)

Task definitions live here; task **statuses** live in flow.json and are managed
only via `keryx flow task done <id> <taskId>`.

Scope: **only W12** (implementation-plan.md CA-01/CA-02). New code under
`src/harness/child/`. Reuse canonical contracts + src/contracts + W7/W8/W9/W11 —
composition only, NO rewrite. Child NEVER writes flow.json (parent owns completion via
the W11 ManagedFlowPort). Deterministic; no new dep/SDK/network. Worktree-guard.
Release-tag boundary: the @release-2 child acceptance scenarios are NOT gated here.

| ID | Kind | Model | Title / definition |
|----|------|-------|--------------------|
| T1 | context | Haiku | Integration map + frozen child contract + D-02 + release-tag boundary (context.md). |
| T2 | implement | — | Umbrella: implement per plan (closed when T6+T8 done). |
| T3 | test | — | Umbrella: TDD tests (closed when T5/T7 authored + impls green). |
| T4 | review | — | Umbrella: self-review + completion prep (closed when T9 + completion done). |
| T5 | test (CA-01 RED) | Sonnet | `src/harness/child/contract.test.ts`: the adapter wraps a canonical `subagent-dispatch`/`subagent-result` (`.metaproject/core/gdskills/contracts/`) with the child-contract-extension metadata (schemaVersion, canonicalContract, canonicalContractVersion, parentRunId, sessionId, attempt{attemptId,number}, branchId, contextManifestHash, policyFingerprint, budgetReservation{reservationId,maxRuntimeMs,maxToolCalls?}, durableResultArtifact); STATUS-first prose framing is converted to a canonical `subagent-result` BEFORE persistence; round-trip identity (build→serialize→parse === original); transport parity (CLI ⟺ JSONL-RPC, reuse W7 rpc pattern); the extension validates against `harness-child-contract-extension.schema.json` via `validateAgainstSchema`. RED before T6. |
| T6 | impl (CA-01) | Opus | `src/harness/child/contract.ts`: `buildChildDispatchExtension(...)` + `parseChildResult(...)` (+ STATUS→canonical conversion) + transport-parity helper. Extension is metadata over the canonical contracts (NOT a replacement). Make T5 green. |
| T7 | test (CA-02 RED) | Sonnet | `src/harness/child/{isolation,spawn}.test.ts`: child context/session **isolation** (child events append-only into the parent `AppendOnlySession`; child cannot mutate parent state or delete parent evidence); **budget ⊆ parent** fail-closed (child `maxRuntimeMs`/`maxToolCalls` ≤ parent remaining; exceeding → DENIED; aggregate child reservations ≤ parent); **policy not-weaker** fail-closed (child trust/profile never broader than parent — escalation DENIED; reuse W7 `decide`/`PolicyProfile`); provenance/parent-links; **NEEDS_CONTEXT / blocked / failed** dispositions returned to parent AS EVIDENCE (`EvidenceRecord`); **parent owns status/completion** (child never writes flow.json — completion via W11 ManagedFlowPort); **prior attempts immutable** (reuse W8; `.toThrow()` on mutation); determinism (injected id/clock). RED before T8. |
| T8 | impl (CA-02) | Opus | `src/harness/child/isolation.ts` (budget/policy inheritance fail-closed, isolation, provenance) + `src/harness/child/spawn.ts` (spawn isolated child; NEEDS_CONTEXT/blocked/failed → evidence; parent owns completion). Make T7 green. |
| T9 | review | Opus | code-verifier (`tsc` + full `bun test` ≥924 + new green); D-02 (`ctx rg` writeFlow/flow.json in src/harness/child = 0; child never writes flow.json); budget/policy inheritance fail-closed (child can't exceed/weaken — adversarial); parent owns completion; prior attempts immutable; STATUS→canonical before persistence + round-trip + transport parity; extension validates against frozen schema; determinism (no Date.now/Math.random); reuse-only (W5–W11 + src/contracts unmodified); frozen requirements pkg + src/eval + src/contracts + ADRs untouched; deps `{}`. Lenses: contract + security/logic. |
