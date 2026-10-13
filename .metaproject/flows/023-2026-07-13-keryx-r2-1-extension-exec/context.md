# Context — Flow 023 (Release 2 · R2-1 extension-execution)

Collected by `keryx flow init` and enriched. (T1 context.) Release 2, Wave R2-1.

## Baseline
- Branch `feature/keryx-release2-extension-exec` from `main` @ (R0+R1; NOT R2-4 — independent).
- `bun test` = 1210 pass / 0 fail; `tsc --noEmit` clean; deps `{}`.
- Flow renumbered 022→023 to avoid a collision with the R2-4 flow-022 (on a separate branch).

## Frozen scope (E-03 §4 AC-R2-1) — 3 scenarios
- SC_R08_CHILD_DISPATCH_CANONICAL_RESULT (acceptance.feature:376, @R8 @R9 @positive):
  coordinator with reserved child budget → dispatch a (registered) extension through the
  adapter → payload validates as canonical subagent-dispatch AND subagent-result → STATUS
  framing normalized BEFORE persistence.
- SC_R08_NEEDS_CONTEXT_ADAPTER (acceptance.feature:459, @R8 @R12 @positive): child names ONE
  missing bounded artifact → parent retries with the SAME dispatch id → only that artifact
  added → prior attempt immutable.
- SC_R08_EXTENSION_ESCALATION_REQUIRES_POLICY (acceptance.feature:384, @R8 @R18 @R15
  @negative): registered extension requests broader tools/provider → grant evaluation
  requires explicit policy + provenance + approval → escalation without them DENIED, no
  silent authority gain.

## Reuse surface (compose/additive; do NOT rewrite)
- **W15 extension registry** `src/harness/extension/registry.ts`: `registerExtension(input):
  {ok:true;extensionId}|{ok:false;reason}` (fail-closed — needs pinned manifest + non-empty
  capabilityGrant). `CapabilityGrant {grantId; capabilities: string[]}`, `ExtensionManifest
  {manifestHash; extensionVersion}`, `RegisterExtensionInput {extensionId; manifest?;
  capabilityGrant?}`. A registered extension carries a `capabilityGrant.capabilities[]`.
- **W12 child contract** `src/harness/child/contract.ts`: `buildChildDispatchExtension(input):
  ChildContractExtension` (parent/session/attempt/branch/context/policy fingerprints,
  budgetReservation, durableResultArtifact); `parseChildResult(raw|obj, meta?): ParsedChildResult`
  (STATUS-first → canonical `subagent-result` BEFORE persistence; status enum
  DONE/DONE_WITH_CONCERNS/NEEDS_CONTEXT/BLOCKED/FAILED); `serializeChildResult`; `CanonicalSubagentResult`.
- **W12 isolation** `src/harness/child/isolation.ts`: `inheritPolicy(parent, childRequest):
  {ok:true;policy}|{ok:false;reason}` — UNCONDITIONAL per-capability containment (deny<ask<allow)
  + trustMode-not-broader + isolation-not-weaker; out-of-enum fail-closed. `inheritBudget`
  (child budget ⊆ parent), `childProvenance` (derived provenance + parent links).
- **W12 spawn** `src/harness/child/spawn.ts`: `spawnChild`, `childResultToEvidence`
  (disposition → EvidenceRecord), `SpawnChildInput/Request/Deps`, `ChildSpawnResult`.
- **W11 flow-port** `src/harness/flow/managed-flow-port.ts`: parent owns completion; extension/
  child NEVER write flow.json.
- **W10 approval** `src/harness/mutation/approval.ts`: `checkApproval` (fresh/matching/unconsumed/
  unexpired/interactive → valid; else invalid) — the approval half of "escalation requires …
  approval". `Approval`, `ApprovalCheck`.
- **W8 resume** `src/harness/resume/*`: immutable attempts (a new attempt never mutates a prior).
- **src/contracts** `validateAgainstSchema`/`validateAgainstSchemaObject` — validate canonical
  subagent-dispatch/result (`.metaproject/core/gdskills/contracts/`) + the frozen child-contract-
  extension schema (`docs/requirements/keryx-project-agent-harness/schemas/`).

## Invariant / integration map
- **dispatchExtension(input, deps):** input = a REGISTERED extension (registry `ok`) + its
  `capabilityGrant` + a coordinator `reservedBudget` + parent context. Build a canonical child
  dispatch via `buildChildDispatchExtension`; the extension's authority = its granted
  capabilities ONLY (bounded). Return the canonical dispatch (validates as subagent-dispatch)
  + a parser that normalizes a STATUS-first result → canonical `subagent-result` BEFORE persist.
  Deterministic (injected id/clock).
- **evaluateExtensionGrant(grantedCapabilities, requested, deps):** requested ⊆ granted → ok
  (bounded). requested ⊄ granted (broader tools/provider) = ESCALATION → require an explicit
  policy decision (allow) + provenance (parent-linked) + a valid approval (W10 checkApproval);
  if ANY is missing → `{ok:false, reason}` DENY, no silent authority gain. Reuse the
  `inheritPolicy` per-capability-containment idea for the capability set; fail-closed on
  out-of-enum / missing policy / missing approval.
- **retryWithContext(priorAttempt, missingArtifactRef, deps):** the child result is
  NEEDS_CONTEXT naming ONE missing bounded artifact → produce a retry dispatch with the SAME
  dispatch id, adding ONLY that artifact to the bounded context; the prior attempt's record is
  immutable (frozen — mutation throws; reuse W8). Deterministic.

## D-02 / security
- Extension/child NEVER write flow.json; the parent owns completion via ManagedFlowPort. No
  capability is granted without an explicit policy + provenance + approval. Escalation → deny.

## Target modules
- `src/harness/extension/execute.ts` (NEW) — `dispatchExtension` + `evaluateExtensionGrant` +
  `retryWithContext`.
- `src/harness/extension/registry.ts` / `src/harness/child/*` — additive helpers ONLY if needed.

## Decisions (approved)
- New `src/harness/extension/execute.ts`; additive-only to prior modules. Reuse W12 contract/
  isolation/spawn + W15 registry + W11 flow-port + W10 approval + W8 immutable-attempts +
  src/contracts. NO new dep/SDK/network (deps `{}`). Deterministic (injected id/clock). Fail-
  closed escalation. D-02. No co-authorship in commits.
- TDD: RED (Sonnet) → impl (Opus) → review (Opus security/contract). Internal harness logic
  (no live component) → no live smoke; offline/deterministic throughout.

## Operational
- keryx = `bun ./src/cli.ts`. Root = `~/goodea/keryx` (branch feature/keryx-release2-extension-exec).
  Never commit to main; PR at the end (no co-authorship).
- State only via `keryx flow` (flow 023); workers via subagent-dispatch/result (STATUS: first line).
- WORKTREE-GUARD: every writing worker `cd ~/goodea/keryx && pwd` first, write ONLY
  under it. Guard array indexing; injected id/clock + fake adapters; no real fs/network; `.toThrow()`
  for immutability.
- Order: T5 (RED) → T6 (impl) → T7 (review).
