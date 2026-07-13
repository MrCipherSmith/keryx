# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: Registered-extension provenance (SC_R18_REGISTERED_EXTENSION_PROVENANCE) — `src/harness/extension/provenance.ts` `registerExtensionWithProvenance` composes the W15 `registerExtension`; on a successful registration it returns an `ExtensionProvenanceRecord` persisting the extension's pinned `manifestHash`, its `grantId`, its granted `capabilities`, and a derived-trust `Provenance` (W7 shape, `trustLevel:"derived"`, a `provenanceId` from the injected id source, with taint/parent linkage); the record is the persisted form (returned; no fs mutation). A registration that fails closed (missing pinned manifest or empty grant) propagates the deny and produces NO provenance record.
- AC2: Authority not widened (SC_R18_REGISTERED_EXTENSION_PROVENANCE) — the record's `capabilities` is EXACTLY the capability grant's `capabilities` (a copy; deep-equal), never a superset; registration grants no capability, authority, or provenance beyond the explicit grant.
- AC3: Escalation requires policy — registry side (SC_R18_EXTENSION_ESCALATION_REQUIRES_POLICY, negative) — `evaluateRegisteredExtensionCapability` grants a requested capability that is within the extension's grant; a requested capability OUTSIDE the grant is an escalation that is DENIED unless an explicit policy decision + provenance + a valid approval are present (or it surfaces an explicit ask-for-approval), reusing R2-1's `evaluateExtensionGrant`; out-of-enum capabilities fail closed; there is no silent authority gain.
- AC4: D-02 + reuse — the extension/registry paths NEVER write flow.json (no `writeFlow`/flow.json write is reachable from `src/harness/extension/provenance.ts`); the W15 registry, R2-1 `execute.ts` (`evaluateExtensionGrant`), W12 `childProvenance`, W7 `Provenance`, and W10 approval are REUSED (composition / additive-only — no rewrite of existing behavior).
- AC5: No regression / determinism / scope / deps — `tsc --noEmit` is clean and the full `bun test` suite is ≥ the pre-change baseline of 1254 pass with the new tests green and 0 fail; behavior is deterministic (injected id/clock, no `Date.now`/`Math.random`); no new production dependency (`dependencies` `{}`), no provider SDK, no network, no real fs mutation in tests; new runtime code lives under `src/harness/extension/` (with additive-only edits to prior modules if strictly needed); the frozen requirements package, canonical contract schemas, `src/eval/`, `src/contracts/`, and ADR-0001…0004 are NOT modified. R2-1/R2-3/R2-4/R2-5 are out of scope.
