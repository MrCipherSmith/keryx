---
name: ci-pipeline-build-fix
description: "Use when a GitHub Actions workflow run or GitLab CI pipeline is failing at the pipeline-configuration level -- YAML syntax errors, an invalid trigger/job key, a missing or misscoped permissions block breaking a step (including GitHub's own 'Resource not accessible by integration' error), a job failing because a protected variable is unavailable on its branch, or a broken needs:/rules:/dependency graph -- with the smallest root-cause fix to the config itself. Not for a failure in the application code the pipeline runs (a Python, TypeScript, Go, or other language compile/import/test error -- fix the code, or use that language's own build-fix skill), not for a Dockerfile/Kubernetes/Terraform build or validation failure (use docker-k8s-terraform-build-fix), and not for authoring a new workflow/pipeline from scratch (use ci-pipeline-implementation)."
triggers:
  - "this GitHub Actions workflow fails to parse, what's wrong with the YAML"
  - "our deploy step lost access to a GitLab variable it needs"
  - "this job says permission denied writing to the PR, fix the workflow"
  - "the pipeline says invalid needs: reference, fix the job graph"
  - "GitLab CI says this job's rules: never match, why doesn't it run"
  - "actions/checkout is failing with an unrecognized input, fix the workflow"
  - "the bot got a 403 posting a PR comment, resource not accessible by integration"
metadata:
  origin: authored
  category: build-fix
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# CI pipeline build-fix (GitHub Actions & GitLab CI)

Fix a GitHub Actions workflow or GitLab CI pipeline that is failing at the
**pipeline-configuration level**: YAML syntax, an invalid or misspelled
trigger/job key, a `permissions:` scope too narrow for what a step needs,
a job that cannot see a variable because of GitLab's protected-branch
scoping, or a broken `needs:`/`rules:`/dependency graph. Scoped to the
workflow file itself — a failure in the application code the pipeline
builds or tests belongs to that stack's own `build-fix`/`test` skill, not
here; do not widen a permissions grant or disable a `rules:` gate just to
make a run go green without understanding why it was scoped that way.

## Workflow

### Step 1: Read the actual failure, not just the job name

1. Get the exact error from the run log or the platform's own linter
   (GitHub Actions' "Invalid workflow file" annotation, GitLab's CI Lint
   page/`gitlab-ci-lint` output) — a config-level failure usually names
   the exact line and key it choked on.
2. Classify the failure: YAML syntax (indentation, an unquoted string
   colliding with a reserved word), an unknown/misspelled key, a
   `permissions:` scope missing what a step needs (e.g. `Resource not
   accessible by integration` writing a PR comment), a variable that is
   `Protected` but the job runs on an unprotected branch, or a `needs:`/
   `rules:`/dependency reference to a job name that does not exist or
   never runs on this ref.

### Step 2: Fix the smallest root cause

- **YAML syntax**: fix the actual indentation/quoting/key at the named
  line; do not restructure unrelated parts of the file.
- **Missing permission**: grant the specific scope the failing step
  actually needs at the job level (not a blanket `write-all` at the
  workflow level) — trace the failing API call back to the
  [documented scope it requires](https://docs.github.com/en/actions/reference/authentication-in-a-workflow)
  rather than guessing.
- **Protected variable unavailable**: either move the job's `rules:` so
  it only runs on the protected branch/tag the variable is scoped to, or
  — if the job genuinely must run elsewhere — use a separate,
  non-protected variable there and keep the protected one for the
  protected-branch job only. Never unprotect the variable just to make an
  unprotected-branch job pass.
- **Broken `needs:`/`rules:`/dependency graph**: fix the job-name
  reference or the ordering itself; confirm the referenced job actually
  exists and actually runs on the ref this job runs on (a `needs:`
  reference to a job whose own `rules:`/`if:` skips it on this ref is a
  common cause of "job never starts").

### Step 3: Verify

- Re-run the platform's own linter (`actionlint`, GitLab's CI Lint page,
  or a local `gitlab-ci-lint` run) against the fixed file.
- Confirm the fix does not widen `permissions:` past what the failing
  step specifically needs, and does not remove a `rules:`/protected-branch
  gate instead of routing the job to the right ref.
- Trigger (or describe how to trigger) the same failing run once more to
  confirm the specific error is gone.

### Step 4: Report

```
Fixed: .github/workflows/deploy.yml
  - permissions.pull-requests was missing "write"; the step posting a PR
    comment needed it. Added at job level only (not workflow level).
  - actionlint passes; re-run confirms the comment step now succeeds.
```

## Rules

- Fix the smallest root cause named by the actual linter/run-log error;
  do not restructure unrelated jobs or steps while fixing one failure.
- Never grant a broader `permissions:` scope than the specific failing
  step needs, and never grant it at the workflow level to fix a
  single job's failure.
- Never unprotect a GitLab CI/CD variable, or remove a `rules:`/branch
  gate protecting it, just to make a job on the wrong branch pass —
  route the job to the right branch/ref, or use a separate variable
  there.
- Never disable or loosen a `rules:`/`if:` condition to make a job "just
  run" without first understanding why it was scoped the way it was.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "I'll set permissions: write-all, it's faster than figuring out which scope this needs" | That fixes this failure by silently widening every other job in the file too; the actual fix (one scope, one job) costs one extra line and leaves the rest of the file at its intended privilege |
| "This variable is protected and the job can't see it, I'll just uncheck Protected" | That exposes the credential to every unprotected branch's pipeline, including forks if allowed -- move the job to the protected ref instead, or use a separate non-protected variable for the non-protected case |
| "The rules: condition is why this job won't run, I'll just delete it" | Deleting the gate makes the job run everywhere the rule was written to exclude, which is usually the actual cause of the failure being investigated in the first place, not the fix for it |

## Verification

Do not report the fix done until all of the following hold:

- The platform's own linter (actionlint / GitLab CI Lint) passes against
  the fixed file.
- The specific error named in the original failure is resolved, not
  worked around by widening scope or disabling a gate.
- No `permissions:` grant was added beyond what the failing step
  specifically needs.
- No `rules:`/protected-variable gate was removed or loosened as part of
  the fix.
