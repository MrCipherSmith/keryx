# Flow 024 — Release 2 · Wave R2-2: registered-extension provenance

Status: formalized
Source: user runbook prompt (Release 2, Wave R2-2). Frozen scope from
`docs/decisions/keryx-harness/E-03-release1-handoff.md` §4 AC-R2-2.

## Problem

W15's `registerExtension` only register-and-denies: a successful registration returns
`{ok:true, extensionId}` — it persists NO provenance and grants NO capability/authority.
R2-2 adds provenance tracking for a SUCCESSFULLY registered extension (its pinned
manifest + explicit grant + parent/registration links + derived trust are persisted),
WITHOUT widening authority beyond the grant, and re-asserts the escalation-requires-
policy invariant from the REGISTRY side (a capability outside the grant → deny or ask).
Depends on R2-1 (`src/harness/extension/execute.ts`, now on main).

## Scope (frozen: E-03 §4 AC-R2-2) — 2 scenarios

- **SC_R18_REGISTERED_EXTENSION_PROVENANCE** (acceptance.feature:333, @R18 @R5 @positive):
  "a later-release extension has a pinned manifest and explicit capability grant / when
  it is registered / its provenance AND granted capabilities are persisted / registration
  does NOT widen authority beyond the grant."
- **SC_R18_EXTENSION_ESCALATION_REQUIRES_POLICY** (acceptance.feature:576, @R18 @R5
  @negative, task H-02): "a registered extension requests a capability OUTSIDE its grant /
  the capability evaluator runs / the escalation is DENIED or asks for explicit approval."
  (The registry-side re-assertion of R2-1's CA-01-side escalation invariant.)

NOT in scope: R2-1 (done, reused), R2-3 (bound-parallel-wave), R2-4 (done), R2-5 (real-
subprocess).

## Expected Outcome

- New `src/harness/extension/provenance.ts`:
  - **registerExtensionWithProvenance** — compose the W15 `registerExtension` (fail-closed:
    needs a pinned manifest + non-empty grant); on `ok`, produce an
    `ExtensionProvenanceRecord` = `{ extensionId; manifestHash (pinned, from the manifest);
    grantId; capabilities (EXACTLY the grant's capabilities — authority NOT widened);
    provenance: Provenance (derived trust + parent/registration links, reuse
    `childProvenance`/the W7 `Provenance` shape) }`. This record IS the persisted form
    (returned; no fs mutation in tests). On a `registerExtension` deny → propagate the
    deny (no provenance record). (SC_R18_REGISTERED_EXTENSION_PROVENANCE.)
  - **evaluateRegisteredExtensionCapability** — registry-side capability check: a request
    for a capability IN the grant → ok; a request OUTSIDE the grant is an ESCALATION →
    DENIED, or requires explicit approval (ask) — reuse R2-1's `evaluateExtensionGrant`
    (policy + provenance + valid approval) so the invariant is identical to the CA-01-side.
    (SC_R18_EXTENSION_ESCALATION_REQUIRES_POLICY.)
- Additive edits to `src/harness/extension/registry.ts` only if strictly needed.

## Out of Scope (do NOT touch)

- R2-1 (reuse its `execute.ts` unchanged) / R2-3 / R2-4 / R2-5. No new dependency
  (`dependencies` stays `{}`), no SDK, no network. No real fs mutation in tests (the
  provenance "persistence" is a returned record). The extension/registry NEVER write
  flow.json (D-02). Deterministic (injected id/clock; no `Date.now`/`Math.random`).
- Rewriting W15 registry, R2-1 execute.ts, W12 `childProvenance`, or W7 `Provenance` —
  REUSE them (composition/additive only). If a prior module seems to need a real refactor,
  STOP and report.
- The frozen requirements package + ADR-0001…0004 + canonical schemas + `src/eval/` +
  `src/contracts/` — read/cite only. Commits/PR carry NO co-authorship trailer.
- Fail-closed: registration does not widen authority beyond the grant; a capability
  outside the grant → deny/ask (never a silent grant).
