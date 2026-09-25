# Wave 4 batch 6: stack packs for docker-k8s-terraform, ci-github-gitlab

Status: active
Source: user description (agent-platform-expansion program, Wave 4)

## Problem

W1-stack-catalog.md's target-stack table still lists `docker-k8s-terraform`
and `ci-github-gitlab` as "tool" packs with no content ("Today: none"). These
are two of the infrastructure-facing stacks in the catalog gap.

## Expected Outcome

- `src/gdskills/bundled/stacks/docker-k8s-terraform/` and
  `src/gdskills/bundled/stacks/ci-github-gitlab/` exist with the fixed pack
  shape (`pack.json`, `rules/`, `skills/*/SKILL.md` + `evals.json`,
  `agent-refs.json`, `governance/eval.json`).
- `docker-k8s-terraform` ships coding-style + security rules scoped to
  Dockerfiles, compose YAML, Kubernetes manifests/Helm, and Terraform
  (`*.tf`/`*.tfvars`) file types; no `implement` skill per the spec note
  ("config authoring lives in the `deploy` quality skill").
- `ci-github-gitlab` ships patterns + security rules scoped to
  `.github/workflows/*.yml` and `.gitlab-ci.yml`, not bare `*.yml`.
- `authoring-lint.ts`'s extension-based `paths:` glob check can express
  extensionless filename patterns (`Dockerfile`) as well as dotted
  extensions, with a regression test.
- `install-manifest.json` registers both packs' modules/components.
- Security content (non-root containers, digest pinning, k8s
  securityContext/NetworkPolicy, Terraform state/secrets,
  `pull_request_target`/script-injection/least-privilege permissions in
  Actions, GitLab protected variables) is verified against current docs via
  ctx7, not written from memory.
- Offline integrity/lint checks pass; the honest DeepSeek gate (run only in
  Phase B, after the orchestrator's go-ahead) decides `stability` and
  whether generated agent pairs ship.

## Out of Scope

- Any other stack in the W1 target-stack table.
- Running the model-backed gate before the orchestrator confirms PR #719 and
  flow 334 are merged and this branch is rebased onto main.
- Editing `install-manifest.json`/`authoring-lint.ts` from inside a worker's
  dispatch — only the runner touches shared files.
