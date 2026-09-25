# Wave 4 batch 1: stack packs and agent pairs for ts-js-node, react, python, go

Status: formalized (flow-orchestrator, 2026-09-24)
Source: agent-platform-expansion program dispatch (Wave 4, batch 1)
Base branch: feat/agent-platform-expansion (branch flow/314-w4b1)

## Problem

W1 shipped stack detection, the install manifest and the governance gates
(scout / eval / stocktake), but only one minimal stack pack (`python`, one
skill, one rule, experimental). Keryx still has no stack-aware implement /
test / review / build-fix content for TypeScript/JavaScript on Node, React,
Python or Go, and W2 has no per-stack agents. `keryx skills eval` cannot reach
`pass` for a skill that ships behavior scenarios because `--runner` is not
wired, so no pack can honestly be marked `stable`, and `keryx agents verify`
does not know stack-pack skills exist.

## Expected Outcome

- Four gated stack packs (`ts-js-node`, `react` extends `ts-js-node`,
  `python` completed, `go`) with four scoped rules each and
  implement/test/review/build-fix skills (plus migrate where it genuinely
  applies: CommonJS->ESM for ts-js-node, React major-version upgrade for react).
- Every pack skill carries authored evals (positive + negative trigger prompts,
  deterministic behavior scenarios) and a real scout record, and passes
  `keryx skills eval` through a real model runner; passing packs are `stable`.
- Eight generated agents (`<stack>-code-auditor`, `<stack>-build-fixer`) from a
  small generator, verified by `keryx agents verify`.
- Install manifest modules/components/profiles for each pack.
- Stack coverage count rises from 2 to 6 (recorded after the gate passes).

## Out of Scope

- Stack packs beyond batch 1 (vue, angular, nestjs pack, django, ...).
- Rule loader behaviour for `paths:` (W1 follow-up).
- Changing eval verdict thresholds in `eval.ts` (the 0.8 pass@k floor is
  enforced by the pack guard test, not by changing `evalSkill`).
- codex/cursor install destinations.
