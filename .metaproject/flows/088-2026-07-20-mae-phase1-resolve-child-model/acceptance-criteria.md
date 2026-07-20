# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `resolveChildModel` exists in `src/harness/child/model.ts` as a pure function; an omitted request or `{kind:"inherit"}` returns the parent selection with `source:"inherited"`.
- AC2: An `{kind:"explicit",providerId,modelId}` request resolves to that pair with `source:"explicit"`; a `{kind:"tier",tier}` request resolves via the configured tier map with `source:"tier"`; an unknown tier is denied `{ok:false}`.
- AC3: Fail-closed gates return `{ok:false,reason}`: G1 provider not in `allowedProviders`; G2 network-class provider when the child policy forbids network (`trustMode`/`defaults.network`); G3 provider classified `unknown`.
- AC4: `KERYX_SUBAGENT_MODEL` env override takes highest precedence when set, and the literal value `inherit` is treated as unset (falls through to explicit→tier→inherit).
- AC5: `providerClass(id)` classifies every entry of `OPENAI_COMPAT_PROVIDERS` plus `anthropic`/`ollama` as `local`/`network`, and any other id as `unknown`; no new runtime dependency is added (zero-`dependencies` guard passes).
- AC6: `src/harness/child/model.test.ts` covers resolution order, all three gates, env precedence, and determinism (identical inputs deep-equal; no `Date.now`/`Math.random`); the full test suite passes.
