# Implementation Plan

Status: formalized

## Approach

Two layers, because either alone fails on this case:

1. **Prevention in every reviewer** (cheap, runs where the finding is born): a fourth shared law about deliberate choices and accepted practice, propagated through the canonical block, plus a "does not mirror" list in review-layout.
2. **An independent delete-only judge, `review-premise`** (catches what a rule-anchored reviewer still raises): mirrors the verifier's wiring — claims file, delete-only merge, stored record, verdict/readiness/gate effects — with one new effect, *held* findings that wait for an operator decision instead of reaching a fixer. Clean context and claim-first reading counter anchoring on the reviewer's argument.

The fix-loop orchestrators (flow-orchestrator, job-orchestrator, review-pr-feedback, feature-dev) skip held findings in `fix_context.review_feedback` and ask the operator. A flow whose source is a follow-up issue or an external finding runs `review-premise` on it before planning — that is the path the case actually took.

Alternative rejected: extending `review-verifier`. The verifier runs on the light tier and its value is that it runs something; a premise judgement is the opposite (reasoning on practice and intent, deep tier). Mixing them would cap one by the other's rules (`REASONING_CAPPED_VERDICT`).

State × event matrix: not applicable — CLI/package records and skill text; no UI state. The keryx shell card is an existing card kind (`operator-confirm-review.ts`) with one new decision spec.

## Steps (lanes)

- **L1 code core** (T1): types, `src/review/premise.ts` (claims, validation, delete-only merge), managed ingest after dedupe, persistence, scope.md block, verdict held class, readiness check, flow review-gate condition, dedupe severity, coverage `NOT_ROSTER`. Tests in `src/review/premise.test.ts` + the touched suites.
- **L2 operator + CLI surface** (T2, after T1): `premise-question` decision kind, `keryx review decide-premise` (terminal + card), `--premises` flag/help/automatic-review path flags, tier rule, routing corpus, catalog + install manifest, docs/cli-reference + review-with-a-record guide.
- **L3 skills** (T3, parallel with T1): new `review-premise/SKILL.md` (both copies); shared law 4 in the canonical block and every reviewer copy; review-layout "does not mirror"; review-orchestrator Wave D (offset text into SKILL.detail.md to stay ≤ ceiling); flow-orchestrator, job-orchestrator, review-pr-feedback, feature-dev, task-implementer handling of held findings and follow-up sources; exempt lists, count tests, ceilings.
- **T4 verify**: synthetic eval — a fixture reproducing the case (a timeline with an explicit `dir="ltr"`, an exemption comment and a sibling media control doing the same) plus control findings that are real; run `review-premise` live (Opus) and record verdicts; replay #992/#1005 ground-truth findings and record that none is challenged. Results in `eval/`.
- **T5 review** of the PR, T6 docs/CHANGELOG, then release 0.3.121.

## Risks

- The judge gutting real findings: guarded by delete-only + held-not-dismissed (only the operator dismisses) and by the #992/#1005 control eval.
- Orchestrator ceiling: Wave D text must be offset by moving detail out.
- Shared-law propagation touches ~25 reviewer files ×2 copies: mechanical, verified by the derived iron-laws test.
