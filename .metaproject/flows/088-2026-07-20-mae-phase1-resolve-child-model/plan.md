# Implementation Plan

Status: ready to freeze

## Approach

Add a fourth pure resolver mirroring `inheritBudget`/`inheritPolicy`. Unlike those
(subset/containment checks), model selection is a lateral choice whose terminal
fallback is inherit-parent; provider *authorization* is still fail-closed via
gates. No contract or spawn wiring in this phase.

## Steps

1. New `src/harness/child/model.ts`: `resolveChildModel(parent, request, deps)`
   returning `{ok:true, selection, source}` | `{ok:false, reason}`.
   Resolution order: env override → explicit → tier → inherit(parent).
2. Gates on the candidate before `ok:true`: G1 allowlist, G2 trust/network,
   G3 classifiable (unknown ⇒ deny).
3. `providerClass(id)` classifier derived from `OPENAI_COMPAT_PROVIDERS`
   (`src/commands/providers.ts`) + `anthropic`/`ollama`.
4. New `src/harness/child/model.test.ts`: resolution order, all three gates,
   env-override precedence (`inherit` == unset), determinism.

## Risks

- Tier map / allowlist shape must match what Phase 2/3 will pass in — keep the
  `deps` interface stable and documented in specification.md.
- Determinism: no `Date.now`/`Math.random`; inputs fully injected.
