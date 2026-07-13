# Context — Flow 015 (W12 child agents)

Collected by `keryx flow init` and enriched for W12. (T1 context.) Release 1.

## Baseline
- `bun test` = 924 pass / 0 fail; `tsc --noEmit` clean; deps `{}`. Branch @ 35fccef.

## Frozen spec (implementation-plan.md — execute verbatim)
- **CA-01** (implement, reviewer=contract): "Adapt canonical `subagent-dispatch`/
  `subagent-result` with parent/session/attempt extensions and STATUS framing."
  Depends FI-01. Evidence: "round-trip and transport parity fixtures pass."
- **CA-02** (implement, reviewer=security/logic): "Add child isolation, context
  budget, provenance, NEEDS_CONTEXT, blocked/failed dispositions." Depends CA-01.
  Negatives: "child negatives." Evidence: "parent owns status and completion; prior
  attempts immutable."

## Frozen contract (validate via src/contracts)
`docs/requirements/keryx-project-agent-harness/schemas/harness-child-contract-extension.schema.json`
— extension over the canonical contracts (NOT a replacement wire contract).
`additionalProperties:false`, required:
`schemaVersion, canonicalContract (enum subagent-dispatch|subagent-result),
canonicalContractVersion (semver), parentRunId (id), sessionId (id),
attempt{attemptId(id), number(int≥1)}, branchId (id), contextManifestHash (sha256),
policyFingerprint (sha256), budgetReservation{reservationId(id), maxRuntimeMs(int≥1),
maxToolCalls?(int≥0)}, durableResultArtifact (artifactRef)`.
`$defs` (id/sha256/artifactRef/schemaVersion) come from `harness-envelope.schema.json`.
Schema note: "STATUS-first prose is adapter framing and must be converted to canonical
subagent-result before persistence."

## Canonical contracts (reuse — `.metaproject/core/gdskills/contracts/`)
`subagent-dispatch.schema.json`, `subagent-result.schema.json` (+ agent-event,
orchestrator-state, review-finding). Also mirrored/loaded by `src/gdskills/contracts.ts`
+ `src/gdskills/install.ts`. STATUS-first subagent-result protocol:
`rules/core/subagent-status-protocol.md`.

## Scope boundary (release tags)
Child acceptance scenarios are `@release-2`: SC_R08_CHILD_DISPATCH_CANONICAL_RESULT
(@R8@R9), SC_R08_NEEDS_CONTEXT_ADAPTER (@R8@R12), SC_R08_EXTENSION_ESCALATION_
REQUIRES_POLICY (@R8@R18@R15). SC_R08_BOUND_PARALLEL_WAVE is W13. SC_R08_ROLE_CANNOT_
ESCALATE is @release-0 (W7 policy-covered — reuse). W12 = the Release-1 CA-01/CA-02
**implementation** with round-trip/transport-parity + child-negative evidence; the
@release-2 scenarios are NOT gated here.

## Build on (reuse — do NOT rewrite; new code under src/harness/child/)
- Canonical schemas + `src/contracts/validator.ts` (`validateAgainstSchema`,
  `validateAgainstSchemaObject`).
- W7 `src/harness/session/{session,types}.ts`: `AppendOnlySession`, `resumeSession`,
  `SessionEntry`/`SessionManifest`/`SessionSeed`/`Provenance`/`ArtifactRef`,
  append-only invariant. `context/manifest.ts`: `buildContextManifest`,
  `ContextManifest`, context hash (contextManifestHash source). `policy/{engine,
  types}.ts`: `decide`, `PolicyProfile`, `PolicyContext`, `PolicyTrustMode`
  (read-only|trusted-local|untrusted), `PolicyDecision`, policy fingerprint
  (policyFingerprint source), `contextIsPolicyTrusted`. `evidence/types.ts`:
  `EvidenceRecord`, `EvidenceKind`, `EvidenceProvenance` (child result → evidence).
- W8 `src/harness/resume/{store,resume,recovery}.ts`: `Checkpoint`, immutable
  attempts (prior attempts immutable), `resumeSessionFrom`.
- W9 `src/harness/branch/branch.ts`: `BranchMetadata`, `branchId` (currentLeaf).
- W11 `src/harness/flow/managed-flow-port.ts`: `ManagedFlowPort`, `completeFromGate`
  — parent owns completion; child returns evidence, NEVER writes flow.json.

## D-02 invariant (ADR-0002)
The child NEVER writes flow.json. Only the Task Manager (`src/flow`) writes flow.json;
the parent advances the flow via `ManagedFlowPort`. One loop authority = Task Manager /
the parent coordinator. The child returns its result as evidence to the parent.

## Invariant / integration map
- **Child contract extension (CA-01):** `buildChildDispatch(parent, canonicalDispatch)`
  → attaches the extension metadata; `parseChildResult(statusFirstProse | canonicalResult)`
  → converts STATUS-first framing to a canonical `subagent-result` BEFORE persistence;
  round-trip identity; transport parity (CLI ⟺ JSONL-RPC, reuse W7 rpc.ts pattern);
  validate the extension against the frozen schema.
- **Budget inheritance (CA-02, fail-closed):** child `budgetReservation.maxRuntimeMs`/
  `maxToolCalls` ≤ parent remaining; exceeding → DENIED (never exceed the parent).
  Aggregate child reservations ≤ parent.
- **Policy inheritance (CA-02, fail-closed):** child `policyFingerprint` derived from
  parent; child trust/profile is never weaker/broader than parent (no escalation);
  violation → DENIED. Reuse W7 `decide`/`PolicyProfile`.
- **Isolation (CA-02):** child context/session is isolated — child events append-only
  into the parent session (provenance/parent links); the child cannot mutate parent
  state or delete parent evidence.
- **Dispositions (CA-02):** NEEDS_CONTEXT (names a missing bounded artifact) / blocked /
  failed are returned to the parent AS EVIDENCE; parent owns status/completion.
- **Prior attempts immutable (CA-02):** reuse W8 — a new attempt never mutates a prior
  attempt's record.

## Target modules
- `src/harness/child/contract.ts` (CA-01) — canonical adapter + extension build/parse +
  STATUS→canonical conversion + transport parity.
- `src/harness/child/isolation.ts` (CA-02) — budget/policy inheritance (fail-closed),
  context/session isolation, provenance.
- `src/harness/child/spawn.ts` (CA-02) — spawn a child (isolated), dispositions
  (NEEDS_CONTEXT/blocked/failed) → evidence, parent owns completion.

## Decisions (approved)
- New code under `src/harness/child/` only. Reuse canonical contracts + src/contracts +
  W7/W8/W9/W11 (composition; NO rewrite of existing behavior, NO new port/validator/
  dependency, NO network/SDK). Deterministic (injected id/clock, NO Date.now/Math.random).
  Child NEVER writes flow.json (parent owns completion via ManagedFlowPort). CA-01 and
  CA-02 both `implement`; run TDD (RED tests Sonnet → GREEN impl Opus) + combined review.

## Operational
- keryx = `bun ./src/cli.ts`; new worktree needs `bun install`. Never commit to main.
- State only via `keryx flow`; workers via subagent-dispatch/result (STATUS: first line).
- WORKTREE-GUARD: every writing worker `cd /Users/Goodea/goodea/keryx/.claude/worktrees/feature-keryx-harness-impl && pwd` first, write ONLY under it. fetch-mocks `as unknown as typeof fetch`; guard array indexing; immutability via `.toThrow()`.
- TDD order: CA-01 (T5→T6), CA-02 (T7→T8), review T9.
