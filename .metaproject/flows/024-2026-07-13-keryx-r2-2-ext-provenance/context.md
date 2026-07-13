# Context — Flow 024 (Release 2 · R2-2 registered-extension provenance)

Collected by `keryx flow init` and enriched. (T1 context.) Release 2, Wave R2-2.

## Baseline
- Branch `feature/keryx-release2-ext-provenance` from `main` (R0+R1+R2-1+R2-4 merged).
- `bun test` = 1254 pass / 0 fail; `tsc --noEmit` clean; deps `{}`.

## Frozen scope (E-03 §4 AC-R2-2) — 2 scenarios
- SC_R18_REGISTERED_EXTENSION_PROVENANCE (acceptance.feature:333, @R18 @R5 @positive):
  pinned manifest + explicit grant → on registration, provenance AND granted capabilities
  are persisted; registration does NOT widen authority beyond the grant.
- SC_R18_EXTENSION_ESCALATION_REQUIRES_POLICY (acceptance.feature:576, @R18 @R5 @negative,
  H-02): a registered extension requests a capability OUTSIDE its grant → the capability
  evaluator denies OR asks for explicit approval (registry-side re-assertion of R2-1's
  CA-01-side invariant).

## Reuse surface (compose/additive; do NOT rewrite)
- **W15 registry** `src/harness/extension/registry.ts`: `registerExtension(input):
  {ok:true;extensionId}|{ok:false;reason}` (fail-closed — needs pinned manifest + non-empty
  grant). `CapabilityGrant {grantId; capabilities: string[]}`, `ExtensionManifest {manifestHash;
  extensionVersion}`, `RegisterExtensionInput {extensionId; manifest?; capabilityGrant?}`.
- **R2-1 execute.ts** `src/harness/extension/execute.ts`: `evaluateExtensionGrant(input:
  {grantedCapabilities; requestedCapabilities; policyDecision?; provenance?; approval?}, deps:
  {checkApproval}): {ok:true}|{ok:false;reason}` — REUSE for the registry-side escalation
  (a capability outside the grant → deny unless policy+provenance+valid-approval). `isKnownCapability`.
- **W12 provenance** `src/harness/child/isolation.ts`: `childProvenance(parent: Provenance,
  deps: {idSeq}): Provenance` (derived trust, taintIds chain). **W7 Provenance** `src/harness/
  session/types.ts`: `Provenance {provenanceId; trustLevel:"trusted"|"untrusted"|"derived"|
  "unknown"; sourceKind; sourceHash?; taintIds?}`.
- **W10 approval** `src/harness/mutation/approval.ts`: `checkApproval`, `ApprovalCheckInput` —
  the approval half (inject into evaluateExtensionGrant). **src/contracts** validators if a
  provenance/extension record needs schema validation.

## Invariant / integration map
- **registerExtensionWithProvenance(input, deps):** call `registerExtension(input)`; on
  `{ok:false}` → propagate deny (no provenance). On `{ok:true}` → build an
  `ExtensionProvenanceRecord`: `{ extensionId; manifestHash: input.manifest.manifestHash (pinned);
  grantId: input.capabilityGrant.grantId; capabilities: [...input.capabilityGrant.capabilities]
  (EXACTLY the grant — NOT widened); provenance: Provenance (via childProvenance from a parent/
  registration provenance, trustLevel "derived", taintIds linking the registration source) }`.
  This record is the persisted form (returned; NO fs). Deterministic (deps.idSeq/clock).
  Authority-not-widened: `record.capabilities` is a copy of the grant's, no extra capability.
- **evaluateRegisteredExtensionCapability(input, deps):** requested capability IN the grant →
  `{ok:true}`. OUTSIDE the grant = escalation → reuse `evaluateExtensionGrant` (deny unless
  policy=allow + provenance + valid approval); a `policyDecision:"ask"` path (or the missing-
  approval path) satisfies the scenario's "asks for explicit approval". Fail-closed on out-of-enum.

## D-02 / security
- Extension/registry NEVER write flow.json. Registration does not widen authority beyond the
  grant. A capability outside the grant → deny/ask, never a silent grant.

## Target modules
- `src/harness/extension/provenance.ts` (NEW) — `registerExtensionWithProvenance` +
  `evaluateRegisteredExtensionCapability` + `ExtensionProvenanceRecord`.
- `src/harness/extension/registry.ts` — additive helper ONLY if strictly needed.

## Decisions (approved)
- New `src/harness/extension/provenance.ts`; additive-only to prior modules. Reuse W15 registry
  + R2-1 execute.ts + W12 childProvenance + W7 Provenance + W10 approval + src/contracts. NO new
  dep/SDK/network (deps `{}`). Deterministic (injected id/clock). Fail-closed. D-02. No co-authorship.
- TDD: RED (Sonnet) → impl (Opus) → review (Opus security/contract). Internal harness logic →
  no live smoke; offline/deterministic.

## Operational
- keryx = `bun ./src/cli.ts`. Root = `/Users/Goodea/goodea/keryx` (branch feature/keryx-release2-ext-provenance).
  Never commit to main; PR at the end (no co-authorship).
- State only via `keryx flow` (flow 024); workers via subagent-dispatch/result (STATUS: first line).
- WORKTREE-GUARD: every writing worker `cd /Users/Goodea/goodea/keryx && pwd` first, write ONLY
  under it. Guard array indexing; injected id/clock; no real fs/network; `.toThrow()` for immutability.
- Order: T5 (RED) → T6 (impl) → T7 (review).
