---
name: docker-k8s-terraform-build-fix
description: "Use when a Docker build fails, a Kubernetes/Helm manifest is rejected by validation or the API server, or a Terraform validate/plan fails -- resolves the actual root cause (a bad COPY path, an ownership/permission mismatch after switching to a non-root USER, a schema-invalid manifest, a Terraform state/address mismatch) with the smallest fix, never a suppression. Not for an application-code build failure unrelated to these config files (a Go/TypeScript/Python compile or test error) -- that is the language's own build-fix skill's territory, even when this pack's Dockerfile happens to build that language's code."
triggers:
  - "docker build is failing"
  - "fix this Kubernetes manifest validation error"
  - "terraform plan wants to destroy and recreate this resource"
  - "terraform validate is failing"
  - "this Dockerfile permission denied error"
  - "kubectl apply is rejecting this manifest"
metadata:
  origin: authored
  category: build-fix
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# Docker / Kubernetes / Terraform build fix

Resolve a `docker build` failure, a Kubernetes/Helm manifest rejected by
schema validation or the API server, or a `terraform validate`/`plan`
failure — with the smallest change that fixes the actual root cause.
`rules/coding-style.mdc` and `rules/security.mdc` govern what a "correct"
fix looks like; this skill never reaches for a suppression or a shortcut
that undoes a prior security fix (reverting to root, disabling a lint rule,
forcing an unreviewed apply) instead of fixing what actually broke.

## Workflow

### Step 1: Reproduce and classify

```bash
docker build .                      # or: docker compose build
kubeconform -strict -summary <manifest>   # or: kubectl apply --dry-run=server -f <manifest>
terraform validate && terraform plan
```

Read the exact error text and classify it:

- **Docker build error** (a `COPY`/`ADD` path that does not exist in the
  build context, a missing `.dockerignore` exclusion breaking a needed
  file, a package-manager install failure, a permission-denied write after
  switching to a non-root `USER`).
- **Kubernetes/Helm validation error** (an unknown field, a wrong type, a
  Helm template rendering failure from a missing `values.yaml` key, or a
  live API-server rejection such as an immutable field on an existing
  resource).
- **Terraform error** (a type mismatch or missing required argument
  `validate` catches, a provider/version constraint conflict, or a `plan`
  showing an unexpected destroy/replace after a resource rename or
  refactor).

### Step 2: Fix by category

**Docker build error:** for a missing `COPY`/`ADD` source, check the build
context and `.dockerignore` before assuming the file is genuinely absent —
a `.dockerignore` entry that is too broad is a common real cause. For a
permission-denied write after a `USER` switch to a non-root user, fix
ownership at copy time (`COPY --chown=<user>:<group> ...`) or with an
explicit `RUN chown`/`mkdir -p` step **before** the `USER` instruction
switches away from root — never fix it by reverting to `USER root` or by
running `chmod 777` on the directory; both undo the non-root hardening
this pack's security rule requires instead of fixing the actual ownership
mismatch.

**Kubernetes/Helm validation error:** for a schema error, fix the field
name/type the validator names — do not delete the offending field to make
the validator stop complaining if the field is actually required for the
workload to function correctly. For a live API-server rejection on an
immutable field (e.g. a Deployment's selector), the fix is usually to
recreate the resource under change management (a new name, or a deliberate
delete+recreate the team has agreed to), not to strip the field or force
an update that the API server is correctly refusing.

**Terraform error:** for a type/argument error, fix the resource/variable
declaration `validate` names. For an unexpected destroy+recreate after a
rename or a module refactor, relink the existing real resource to its new
configuration address — either a `moved` block (`moved { from =
<old_address> to = <new_address> }`, declarative, stays in the
configuration) or the equivalent `terraform state mv <old_address>
<new_address>` (imperative, a one-off CLI operation) — never accept the
destroy+recreate plan with `-auto-approve` (or any unreviewed apply) for a
stateful resource just to make the plan "go through"; that actually
destroys and rebuilds the real infrastructure the rename was never meant
to touch.

### Step 3: Verify

```bash
docker build .                      # or: docker compose build
kubeconform -strict -summary <manifest>
terraform validate && terraform plan
```

Re-run the specific command whose failure this fix addresses, plus any
project-configured validator (`hadolint`, `helm template | kubeconform`).
All must exit 0 — and for the Terraform case, `terraform plan` must show
no destroy/replace on the resource the fix was meant to preserve — before
reporting done.

### Step 4: Report

```
Fixed: Dockerfile permission-denied write to /app after switching to
  USER app
  - Root cause: files were COPY'd while still root, so `app` had no
    write access to /app
  - Fix: added --chown=app:app to the COPY instruction (no chmod, no
    reverting to root)
  - docker build . passes
```

State the root cause in one sentence, not just "fixed the error."

## Rules

- Find and fix the smallest change that addresses the actual root cause —
  never widen a fix beyond what the failure requires.
- NEVER fix a permission-denied error by running `chmod 777` or reverting
  to `USER root` — fix ownership at the actual `COPY`/`RUN` step instead.
- NEVER accept an unexpected Terraform destroy/replace with
  `-auto-approve` (or any unreviewed apply) — use a `moved` block or
  `terraform state mv` (or another state-preserving fix) when the
  resource itself was not meant to change.
- NEVER delete a required Kubernetes manifest field just to make a
  validator stop complaining.
- NEVER delete or skip a failing validation step to reach a green build.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "I'll just `chmod 777` the directory, it's only a build image" | Undoes the non-root hardening this pack's security rule requires and grants write access to everyone, not just the user that actually needs it; fix ownership at the COPY/RUN step instead |
| "The rename makes Terraform want to destroy and recreate it, but the resource is basically the same, so `-auto-approve` should be fine" | Terraform's plan is not wrong about what it will do — accepting an unreviewed destroy+recreate on a stateful resource can genuinely lose data; a `moved` block or `terraform state mv` fixes the address without touching real infrastructure |
| "This field keeps failing validation, I'll just remove it" | If the field is actually required for the workload (a probe, a resource limit), removing it trades a caught validation error for a runtime failure later; fix the field's value instead |
| "I'll switch back to `USER root` just to unblock this build, we can fix permissions properly later" | Reintroduces a root container to solve an ownership problem that a scoped `--chown`/`chown` step solves without giving up the non-root hardening |

## Verification

Do not report the fix done until all of the following hold:

- The specific failing command (`docker build`, `kubeconform`/`kubectl
  apply --dry-run`, `terraform validate`/`plan`) now exits 0.
- For a Terraform fix: `terraform plan` shows no destroy/replace on the
  resource the fix was meant to preserve.
- The change is the smallest one that addresses the stated root cause —
  no unrelated files touched, and no security hardening (non-root user,
  digest pin, `NetworkPolicy`) reverted to reach a green build.
- The report states the root cause in one sentence, not just "build now
  passes."
