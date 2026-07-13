# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: CA-01 canonical adapter — `src/harness/child/contract.ts` adapts the canonical `subagent-dispatch`/`subagent-result` contracts (`.metaproject/core/gdskills/contracts/`) with the frozen `harness-child-contract-extension` metadata (parentRunId, sessionId, attempt{attemptId,number}, branchId, contextManifestHash, policyFingerprint, budgetReservation{reservationId,maxRuntimeMs,maxToolCalls?}, durableResultArtifact); STATUS-first prose framing is converted to a canonical `subagent-result` BEFORE persistence; round-trip identity holds and the extension validates against `harness-child-contract-extension.schema.json` via the `src/contracts` validator. The extension is metadata over the canonical contracts, NOT a replacement wire contract.
- AC2: CA-01 transport parity — a child dispatch/result round-trips identically across CLI and JSONL-RPC transports (reusing the W7 transport pattern); the persisted canonical result is byte-identical regardless of transport (round-trip and transport-parity fixtures pass).
- AC3: CA-02 isolation + fail-closed inheritance — a child gets an isolated context/session: child events are append-only into the parent session and the child cannot mutate parent state or delete parent evidence; budget inheritance is fail-closed (child budgetReservation ⊆ parent remaining — `maxRuntimeMs`/`maxToolCalls` exceeding the parent, or aggregate child reservations exceeding the parent, are DENIED, never silently exceeded); policy inheritance is fail-closed (child trust/profile is never broader/weaker than the parent — escalation is DENIED; reuse W7 `decide`/`PolicyProfile`); provenance/parent-links are recorded.
- AC4: CA-02 dispositions + parent-owned completion — NEEDS_CONTEXT / blocked / failed child dispositions are returned to the parent AS EVIDENCE (`EvidenceRecord`); the parent owns status and completion (a child completion flows only through the W11 ManagedFlowPort — the child NEVER writes flow.json; no `writeFlow`/flow.json write is reachable from `src/harness/child/**`); prior attempts are immutable (reuse W8; a new attempt never mutates a prior attempt's record).
- AC5: No regression / reuse / scope / determinism — `tsc --noEmit` is clean and the full `bun test` suite is ≥ the pre-change baseline of 924 pass with the new tests green and 0 fail; new harness code lives under `src/harness/child/` only; the W5 ports, W6 fakes, W7 completion/session/context/policy/evidence, W8 resume, W9 branch, W11 flow-port, and the `src/contracts` validator are REUSED (not rewritten); the canonical contract schemas are not modified; behavior is deterministic (injected id/clock, no `Date.now`/`Math.random`); no new production dependency (`dependencies` `{}`), no provider SDK, no network, no real fs mutation in tests; the frozen requirements package, `src/eval/`, `src/contracts/`, and ADR-0001…0004 are NOT modified. The `@release-2` child acceptance scenarios are out of scope for W12.
