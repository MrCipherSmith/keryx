# T8 Implementation Spec

## Purpose

Implement Phase 0 acceptance criteria AC3–AC5 without external model calls.

## Behavior

- Add optional `AgentDeps.maxToolCalls` as an independent per-turn limit.
- Validate direct `maxRounds` and `maxToolCalls` values before provider, approval, or tool activity. `maxRounds` accepts non-negative integers for backward compatibility with the existing unattended zero-round tests; `maxToolCalls` accepts non-negative integers. Invalid supplied values throw `RangeError`.
- Count only real invocations that pass tool lookup, input validation, trust gating, and approval and reach `tool.invoke`.
- Stop immediately when the configured tool-call count is reached, without another provider request, and return `finishReason: "tool-call-budget"`.
- Keep existing `"budget"` and `"no-progress"` reasons unchanged when the independent tool-call cap is absent or not reached.
- Preserve ordered accounting by keeping finite-cap batches on the sequential path; existing concurrent spawn behavior remains unchanged when no call cap is configured.
- Emit unattended terminal state with a distinct tool-call budget reason.
- Fix the stress report to publish `maxRounds` from `resolveAgentMaxRounds`, add an offline report-only selector, and keep the script import-safe.
- Export and use a strict containment listener-port resolver that refuses absent or invalid ports.
- Add `tsconfig.scripts.json`, wire it into `package.json` `check`, and repair the diagnosed benchmark/stress script type errors without reducing compiler strictness.

## Verification

- Focused T6 tests plus new budget edge cases.
- Full `src/commands/agent.test.ts` regression suite.
- Root TypeScript check and scripts TypeScript target.
- Project check if bounded and offline; no live benchmark/model scripts.
