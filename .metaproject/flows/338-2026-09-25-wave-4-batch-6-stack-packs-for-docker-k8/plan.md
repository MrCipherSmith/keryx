# Implementation Plan

Status: active

## Approach

Phase A (this session): author both packs in parallel via disjoint sonnet
worker dispatches (one per pack directory), while the runner alone edits
shared infrastructure (STACK_EXTENSIONS/authoring-lint.ts, install-manifest
wiring, shared tests, W1/W2 docs). Run offline integrity+lint only; commit
per pack; do not run the model gate. Push and report READY_FOR_GATE, then
wait for the orchestrator's go-ahead (PR #719 batch-2 + flow 334 merged to
main) before Phase B.

Phase B (after go-ahead): rebase onto main, record calibration, run the
honest 10-trial DeepSeek gate, set stability/agents from the gate result
only, update docs/ACs, open the PR into main, run an opus adversarial
review against the stack-pack lessons checklist, get CI green under the
minor/3-attempt standing rule, and report READY_TO_MERGE.

## Steps

1. Extend `authoring-lint.ts`'s extension matcher to accept extensionless
   filename globs (e.g. `**/Dockerfile`) in addition to dotted extensions;
   add `docker-k8s-terraform` and `ci-github-gitlab` to `STACK_EXTENSIONS`;
   add a regression test.
2. Dispatch a sonnet worker for `docker-k8s-terraform`: pack.json, rules/
   (coding-style, security; patterns/testing only if genuinely distinct),
   no implement skill, other skills (test/review/build-fix/migrate) only
   where the category is genuinely distinct from existing catalog skills,
   agent-refs.json (empty until gate), governance/eval.json. Security
   content verified via ctx7.
3. Dispatch a sonnet worker for `ci-github-gitlab`: pack.json, rules/
   (patterns, security scoped to workflow YAML only), skills as applicable,
   agent-refs.json, governance/eval.json. Security content (pull_request_target,
   action pinning, permissions, script injection, GitLab protected vars)
   verified via ctx7.
4. Runner wires both packs into `install-manifest.json` (profiles/components,
   `stability: experimental` until the gate), extends W1/W2 docs with an
   "Implementation notes: Wave 4 batch 6 (flow 338)" section mirroring prior
   batches' shape.
5. Run offline checks: `bun test` on stack-packs.test.ts +
   authoring-lint*.test.ts + install-manifest tests, plus targeted
   typecheck/eslint on changed files. Commit per pack + shared files.
6. Push branch, report STATUS: READY_FOR_GATE, and stop.
7. (Phase B, gated) rebase, calibration, honest gate, docs/AC update, PR,
   opus review, CI, merge per the standing rule.

## Risks

- `extends` becoming an array and `extendsList`/manifest/trigger-scoring
  changes landing in PR #719 and flow 334 will conflict with this branch's
  install-manifest.json edits — resolved at the Phase B rebase, not before.
- YAML extension overlap between the two packs and other YAML-touching packs
  — mitigated by scoping `paths:` globs to workflow/compose/k8s directories,
  not bare `*.yml`.
