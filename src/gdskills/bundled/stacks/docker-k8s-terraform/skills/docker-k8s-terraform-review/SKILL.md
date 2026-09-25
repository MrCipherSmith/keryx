---
name: docker-k8s-terraform-review
description: "Use when reviewing a Dockerfile, Docker Compose file, Kubernetes/Helm manifest, or Terraform change for security and config-authoring risks -- root containers, unpinned base images, secrets baked into image layers, missing Kubernetes securityContext/NetworkPolicy, and Terraform state/secrets handling. Read-only, no edits: never builds an image, runs a deployment/release (use the `deploy` quality skill for that), or resolves a failing build/validate/plan (use `docker-k8s-terraform-build-fix` for that)."
triggers:
  - "review this Dockerfile for security issues"
  - "check this Kubernetes manifest before it ships"
  - "review this Terraform change for security problems"
  - "does this Dockerfile run as root"
  - "review this Helm chart change"
  - "check this docker-compose file for secrets"
metadata:
  origin: authored
  category: review
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# Docker / Kubernetes / Terraform review

Read-only review of a Dockerfile, Docker Compose file, Kubernetes/Helm
manifest, or Terraform change for the config-authoring and security risks
specific to this pack's three file types: root containers, unpinned base
images, secrets baked into image layers, missing Kubernetes
`securityContext`/`NetworkPolicy`, and Terraform state/secrets handling.
This skill never edits config — it reports findings. `rules/coding-style.mdc`,
`rules/patterns.mdc`, and `rules/security.mdc` are the rule set findings are
checked against. It does not scan a built image for known CVEs (that is
`security-audit`'s job) and it does not run or deploy anything (that is
`deploy`'s job).

## Workflow

### Step 1: Scope the review

1. Identify the changed files (`git diff` against the review base) —
   review only Dockerfiles, compose files, Kubernetes/Helm YAML, and
   `.tf`/`.tfvars` files in the diff, not the whole repository.
2. Read enough of the surrounding, unchanged file to know whether a
   flagged pattern is new in this diff or pre-existing; note pre-existing
   issues separately from ones the diff introduces.

### Step 2: Check each changed file against the focus list

**Dockerfile and Compose**
- A missing (or removed) `USER` instruction, or a diff that adds
  `USER root` back onto a previously non-root image — flag it; the image
  runs (or is being changed to run) as root, per `rules/security.mdc`'s
  non-root-by-default rule.
- A `FROM` line pinned only by a mutable tag, or a diff that drops an
  existing digest pin (e.g. changing `FROM node:20-slim@sha256:<digest>`
  to `FROM node:latest`) — flag the loss of reproducibility; every
  production-bound Dockerfile should pin its base image by digest.
- A secret (API key, token, password) passed via `ARG`/`ENV`/`COPY`
  instead of a `RUN --mount=type=secret` build-time mount, or a Compose
  file with a credential hardcoded in `environment:` instead of sourced
  from an `.env`/secrets file — flag it; the value persists in the image
  layer or the committed file either way.

**Kubernetes and Helm**
- A container `securityContext` missing `runAsNonRoot: true`,
  `allowPrivilegeEscalation: false`, or a capabilities drop
  (`capabilities.drop: ["ALL"]`) — flag whichever is missing.
- A workload manifest shipped with no accompanying `NetworkPolicy` in a
  namespace that has none, or a `NetworkPolicy` broad enough to defeat a
  default-deny boundary — a `spec.ingress` entry that is a single empty
  rule object (`ingress: [{}]`, allow-all — not the same as an EMPTY
  `ingress:` array, which is deny-all) or a `podSelector: {}` on a policy
  meant to scope one workload — flag it.
- A container with no `resources.requests`/`resources.limits` — flag it
  per `rules/coding-style.mdc`.

**Terraform**
- A hardcoded credential or connection string literal in a `.tf`/`.tfvars`
  file — flag it regardless of whether a `sensitive = true` variable
  exists elsewhere in the same file.
- A `sensitive = true` value treated in the diff's own comments/PR
  description as if that alone encrypted the value — flag the
  misunderstanding: `sensitive` only redacts CLI/log output, the value is
  still written to state in plain form.
- A backend block with no encryption/locking configured, or a change that
  moves state from an already-encrypted remote backend to a local
  `terraform.tfstate` — flag it as a state-security regression.

### Step 3: Report

For each finding: file:line, the pattern, why it matters (the concrete
exposure or risk), and the fix direction — but do not apply it.

```
Dockerfile:14 -- USER root added back before CMD, reverting the image to
  run as root. Risk: any process compromise inside the container now runs
  with root privileges instead of a scoped user. Fix direction: restore a
  non-root USER (e.g. USER app, created earlier with RUN useradd) before
  CMD/ENTRYPOINT.
```

## Rules

- NEVER edit config — findings and fix direction only.
- Flag root containers, unpinned/downgraded base images, secrets baked
  into image layers, missing Kubernetes `securityContext`/`NetworkPolicy`
  fields, and Terraform state/secrets handling gaps; do not report generic
  formatting nits already covered by `hadolint`/`terraform fmt` (those are
  noise here).
- Distinguish a finding the diff introduces from a pre-existing one in a
  file the diff merely touches.
- When a suspected issue is not certain from reading alone (e.g. whether a
  namespace has any other `NetworkPolicy` covering the gap), say "confirm
  with `kubectl get networkpolicy -n <ns>`" rather than asserting the gap
  exists without evidence.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "`USER root` here is fine, it's just for local dev" | A Dockerfile reviewed for a change bound for a shared branch is reviewed as shipping config, not as a private local override; flag it and let the confirmation happen explicitly, not by assumption |
| "The base image is from a trusted publisher, so `FROM node:latest` without a digest is fine" | Trusting the publisher is not the same as pinning what actually gets built — `latest` (or any mutable tag) can point at a different image tomorrow than it built against today; that is what the digest pin exists to prevent |
| "It's `sensitive = true`, so it's encrypted" | `sensitive = true` only redacts CLI/log output; the value is still written to Terraform state in plain form. Encryption comes from the backend configuration, not this flag |
| "I'll just fix the missing USER instruction myself since it's a one-line change" | This skill is read-only; report the finding and its fix direction, do not edit the file |

## Verification

Do not report the review done until all of the following hold:

- Every changed Dockerfile/Compose/Kubernetes-Helm/Terraform file in the
  diff was read, not just files named in the PR description.
- Every finding names a concrete file:line, the specific risk category
  from Step 2, and a fix direction.
- No source file was modified by this review.
- Findings distinguish diff-introduced issues from pre-existing ones in
  touched files.
