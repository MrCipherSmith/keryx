# H-02: Deferred Extension Capability Grant and Isolation Contract

**Status:** Deferred capability definition (documented Release 1 / flow 017,
W15, task H-02). This is **not** an ADR edit — ADR-0001…0004 remain frozen and
unmodified. Nothing in this document enables extension execution, capability
escalation, or discovery-time authority in Release 0 or Release 1.

**Reviewer track:** security
**Depends on:** H-01 (flow 017, W15)
**Frozen source:** `implementation-plan.md` row H-02 — "Define deferred
extension capability grants and isolation without enabling them in Release
0." Negative: "extension escalation negative." Evidence: "extension contract
is explicitly later scope."

---

## Purpose

Release 0/1 gives the harness exactly one extension-related capability:
**fail-closed registration refusal.** `src/harness/extension/registry.ts`
(`registerExtension`) denies any extension that lacks a pinned manifest or a
capability grant, and performs no discovery-time mutation or authority grant
either way (`SC_R18_UNREGISTERED_EXTENSION_DENIED`, `@release-0`).

This document defines — for a **future** release — the capability grant and
isolation model a registered extension would need before it could be trusted
with provenance, execution, or privilege escalation. It exists so that a
later release can build directly on a reviewed, security-framed contract
instead of improvising one under delivery pressure. **No code in this
worktree enables any of the deferred behavior described below.**

---

## What Is Enabled Now (Release 0 / Release 1)

Only **register-and-deny**:

- `registerExtension(input: RegisterExtensionInput): RegisterExtensionResult`
  in `src/harness/extension/registry.ts` is a pure, deterministic function:
  no `Date.now`/`Math.random`/network/fs, no input mutation, no
  module-level/persisted registry state.
- An extension is denied unless it presents **both**:
  - a pinned `manifest` with a non-empty `manifestHash` (`ExtensionManifest`:
    `manifestHash`, `extensionVersion`), and
  - a non-empty `capabilityGrant` (`CapabilityGrant`: `grantId`,
    `capabilities: string[]`).
- A denial carries a `reason` string; an acceptance carries only
  `{ ok: true, extensionId }` — **no capability, authority, provenance, or
  execution right is attached to a successful registration.** Registering
  does not run, load, or trust the extension; it only decides whether the
  extension is well-formed enough to be *registrable at all*.

This satisfies `SC_R18_UNREGISTERED_EXTENSION_DENIED` (@R18 @R15 @release-0
@negative, `acceptance.feature:325-330`): "an extension attempts to register
during discovery / lacks a pinned manifest and capability grant / rejected
without discovery-time mutation or authority."

Everything past this point is explicitly **not implemented**.

---

## What Is Deferred (Release 2+, NOT Enabled)

None of the following exists in `src/harness/extension/` today. Each item is
scoped to a later release and cites the `@release-2` scenario it will close.

### 1. Registered-extension provenance

`SC_R18_REGISTERED_EXTENSION_PROVENANCE` (@R18 @R5 @release-2 @positive,
`acceptance.feature:332-338`): "a later-release extension has a pinned
manifest and explicit capability grant / it is registered / its provenance
and granted capabilities are persisted / registration does not widen
authority beyond the grant."

A future release would persist the accepted `manifest` and `capabilityGrant`
as durable provenance (who granted it, which capabilities, against which
manifest hash) — but persisting provenance must never, by itself, widen the
extension's authority past what the grant already encodes. Persistence is
record-keeping, not an authority source.

### 2. Extension execution behind an explicit policy grant

A registered extension gaining an execution surface (running, being invoked
as a tool/provider/role) is Release 2+ scope. Release 0/1 has no path from
`registerExtension` returning `{ ok: true }` to the extension actually
running. Execution, when it exists, MUST be gated the same way every other
mutating/shell/network/delegate action is gated today — through the policy
engine's `allow`/`ask`/`deny` outcome (`src/harness/policy/engine.ts`,
`src/harness/policy/types.ts`), not through registration success alone.

### 3. Extension capability escalation requires a policy decision

`SC_R08_EXTENSION_ESCALATION_REQUIRES_POLICY` (@R8 @R18 @R15 @release-2
@negative, `acceptance.feature:383-389`): "a registered extension requests
broader tools or provider access / the capability grant is evaluated /
escalation requires explicit policy, provenance, and approval / no silent
authority gain occurs."

`SC_R18_EXTENSION_ESCALATION_REQUIRES_POLICY` (@R18 @R5 @release-2
@negative, `acceptance.feature:575-580`): "a registered extension requests a
capability outside its grant / the capability evaluator runs / the
escalation is denied or asks for explicit approval."

This is the **extension escalation negative** named in the frozen H-02
requirement. The rule mirrors the existing child no-escalation invariant
(`SC_R08_ROLE_CANNOT_ESCALATE`, W12 `inheritPolicy`/`inheritBudget`
containment): a registered extension may **never** gain a capability its
capability grant does not encode.

**Invariant (fail-closed, capability ⊆ granted):**

```
runtime_capability(extension) ⊆ capabilityGrant.capabilities
```

Any attempt to exercise a capability outside this set must resolve through
the policy engine as `deny` or `ask` — never a silent `allow`. Requesting a
broader tool or provider surface than the grant covers is evaluated as an
escalation request, not honored implicitly. This is additive to, and reuses,
the existing `PolicyOutcome` (`allow | ask | deny`) vocabulary in
`src/harness/policy/types.ts`; it does not introduce a fourth outcome.

### 4. Isolation no weaker than the grant

A registered extension's execution isolation must be no weaker than the
isolation its capability grant implies, reusing the containment vocabulary
already frozen for security profiles
(`docs/decisions/keryx-harness/ADR-0003-d03-security-profiles-containment.md`;
`PolicyProfileRequiredControls.isolation: "not-required" |
"required-fail-closed"` in `src/harness/policy/types.ts`). A profile that
requires `"required-fail-closed"` isolation must not be satisfiable by an
extension running without OS/container/remote containment, exactly as an
unattended-untrusted mutation cannot bypass isolation via a permission
prompt today (`SC_R15_FAIL_CLOSED_ISOLATION`). No isolation weakening may be
negotiated by an extension's own manifest or grant.

---

## Contract Sketch (Documentation Only — Later Scope, Not Implemented)

The fields below describe what a future `harness-extension-contract` schema
would carry, in the same additive-extension style D6 uses for the child wire
contract (`ADR-0004-d04-provider-branch-child.md` §D6, "the harness
extension adds **only** parent/session/attempt + fingerprint + budget +
durable-result fields" on top of the canonical `subagent-dispatch`/
`subagent-result` contracts; schema-link row `RL-05`/`RL-06`). Analogously,
a future extension-execution contract would extend — never replace — the
Release 1 registration surface with additive fields only:

| Field | Type (sketch) | Purpose | Status |
|---|---|---|---|
| `manifestHash` | `string` (pinned) | Same pinned manifest identity `registerExtension` already requires | Later scope; not implemented |
| `extensionVersion` | `string` | Same version field `ExtensionManifest` already carries | Later scope; not implemented |
| `capabilityGrant.grantId` | `string` | Identity of the specific grant record | Later scope; not implemented |
| `capabilityGrant.capabilities[]` | `string[]` | The exact, non-widenable capability set (`capability ⊆ granted`) | Later scope; not implemented |
| `policyFingerprint` | `string` | Binds the grant to the exact policy profile that authorized it (reuses `PolicyDecisionWire.policyFingerprint`) | Later scope; not implemented |
| `isolation` | `"not-required" \| "required-fail-closed"` | Minimum required containment for this extension's execution (reuses `PolicyProfileRequiredControls.isolation`) | Later scope; not implemented |

No validator, schema file, or registry mutation for this contract exists
anywhere in this worktree. This table is a naming and shape proposal only.

---

## Explicit Deferral Table

| Scenario | Tags | Status | Enabling release/wave |
|---|---|---|---|
| `SC_R18_UNREGISTERED_EXTENSION_DENIED` | @R18 @R15 @release-0 @negative | **Implemented** (Release 1, `src/harness/extension/registry.ts`) | W15 (this flow) |
| `SC_R18_REGISTERED_EXTENSION_PROVENANCE` | @R18 @R5 @release-2 @positive | Deferred — not implemented | Release 2+, first extension-execution wave |
| `SC_R08_EXTENSION_ESCALATION_REQUIRES_POLICY` | @R8 @R18 @R15 @release-2 @negative | Deferred — not implemented | Release 2+, first extension-execution wave |
| `SC_R18_EXTENSION_ESCALATION_REQUIRES_POLICY` | @R18 @R5 @release-2 @negative | Deferred — not implemented | Release 2+, first extension-execution wave |

---

## Traceability

- **Requirements:** `docs/requirements/keryx-project-agent-harness/prd.md`
  §R8 "Agent Roles and Child Agents" (child/extension isolation and
  contracts), §R18 "Explicit Extension Surface" ("Runtime extensions must not
  silently gain unrestricted access or mutate project source-of-truth files
  during discovery"), §R15 "Security Boundary" (untrusted surfaces route
  through security seams, not implicit trust), §R5 "Permission and Approval
  Engine" (every high-risk action resolves through `allow`/`ask`/`deny`).
- **Covered now:** `SC_R18_UNREGISTERED_EXTENSION_DENIED`
  (`acceptance.feature:325-330`) — Release 1, `src/harness/extension/registry.ts`,
  `src/harness/extension/registry.test.ts`.
- **Deferred (documented here, not enabled):**
  `SC_R18_REGISTERED_EXTENSION_PROVENANCE` (`acceptance.feature:332-338`),
  `SC_R08_EXTENSION_ESCALATION_REQUIRES_POLICY` (`acceptance.feature:383-389`),
  `SC_R18_EXTENSION_ESCALATION_REQUIRES_POLICY` (`acceptance.feature:575-580`).
- **Frozen ADR reference (read-only, not edited):**
  `docs/decisions/keryx-harness/ADR-0004-d04-provider-branch-child.md` §D6
  "Child Wire Framing" and its Schema-Link Table row `RL-05`/`RL-06` — cited
  above as the style precedent for additive-extension contracts; ADR-0004
  itself is unmodified by this document.
- **Frozen containment vocabulary (read-only, not edited):**
  `docs/decisions/keryx-harness/ADR-0003-d03-security-profiles-containment.md`
  (isolation/fail-closed posture) and `src/harness/policy/types.ts`
  (`PolicyOutcome`, `PolicyProfileRequiredControls.isolation`) — reused, not
  redefined, by the deferred model above.

---

## Non-Goals (Restated)

- This document does not add, modify, or enable any extension execution
  path, capability escalation path, or provenance-persistence path.
- This document does not modify `src/harness/extension/registry.ts`,
  `ADR-0001`…`ADR-0004`, the frozen requirements package, or any canonical
  contract schema.
- The contract sketch above is a naming/shape proposal for a future release;
  it is not a schema registration and has no `$id`, no validator, and no
  `schema-version-registry.json` entry.

---

**Last updated:** 2026-07-13
**Authored by:** Flow 017 documentation worker (T8 / H-02)
