# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `src/gdskills/bundled/stacks/docker-k8s-terraform/` and `src/gdskills/bundled/stacks/ci-github-gitlab/` each exist with `pack.json`, `rules/`, per-skill `SKILL.md`+`evals.json` under `skills/`, `agent-refs.json`, and `governance/eval.json`.
- AC2: `docker-k8s-terraform` ships no `implement` skill; every rule's `paths:` glob covers only Dockerfile/dockerfile-variant, compose YAML, Kubernetes manifest/Helm, and `*.tf`/`*.tfvars` file types, and `extends: common`.
- AC3: `ci-github-gitlab`'s rule `paths:` globs are scoped to `.github/workflows/*.yml` and `.gitlab-ci.yml` only, not bare `**/*.yml` or `**/*.yaml`.
- AC4: `authoring-lint.ts`'s `lintStackRule` correctly validates an extensionless filename glob (e.g. `**/Dockerfile`) against `STACK_EXTENSIONS`, backed by a passing regression test.
- AC5: `install-manifest.json` registers both packs' components/modules at `stability: experimental` and validates against `install-manifest.schema.json`.
- AC6: Every security-relevant rule statement (non-root containers, image digest pinning, k8s securityContext/NetworkPolicy, Terraform state/secrets, GitHub Actions `pull_request_target`/action-pinning/least-privilege permissions/script injection, GitLab protected variables) is traceable to a ctx7 doc lookup recorded in the flow journal.
- AC7: `bun test` passes for `src/gdskills/stack-packs.test.ts`, `src/gdskills/governance/authoring-lint.test.ts`, `src/gdskills/governance/authoring-lint-guard.test.ts`, and any install-manifest tests touched, on the pushed branch.
- AC8 (Phase B): the honest 10-trial `deepseek:deepseek-chat` gate determines each pack's `stability` and whether a generated `<id>-code-auditor`/`<id>-build-fixer` agent pair ships; no pack claims `stable` or ships a pair without a recorded passing report.
- AC9 (Phase B): a PR against `main` is opened, reviewed by an opus adversarial pass against the stack-pack lessons checklist, and merged only with 0 blocker/major findings and CI green (minor findings deferred per the standing rule after 3 attempts).
