---
name: ci-pipeline-code-review
description: "Use when reviewing a GitHub Actions workflow (.github/workflows/*.yml) or GitLab CI pipeline (.gitlab-ci.yml) change for security and structural risk -- pull_request_target combined with untrusted checkout, tag-pinned third-party actions, missing least-privilege permissions, script injection via unsanitized event/variable interpolation, and unprotected access to deploy secrets. Read-only, no edits."
triggers:
  - "review this GitHub Actions workflow diff for security issues"
  - "check this .gitlab-ci.yml change for exposed secrets"
  - "does this workflow have a script injection risk?"
  - "review this pull_request_target job for pwn request risk"
  - "check whether these third-party actions are pinned safely"
  - "review this deploy job for least-privilege permissions"
metadata:
  origin: authored
  category: review
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# CI pipeline security review (GitHub Actions & GitLab CI)

Review a GitHub Actions workflow or GitLab CI pipeline change for the
specific risks `rules/security.mdc` catalogs: `pull_request_target`
combined with untrusted checkout, mutable-tag action pinning, missing
least-privilege `permissions:`, script injection via unsanitized
`${{ github.event.* }}`/CI-variable interpolation, and unprotected access
to deploy secrets. **This skill is strictly read-only** — it reports
findings and a fix direction, and never edits, patches, or claims to have
applied even a partial or proof-of-concept change to the workflow file
under review; a change belongs to `ci-pipeline-implementation`, not here.

## Workflow

### Step 1: Scope the diff

1. Read the full diff of every changed `.github/workflows/*.yml` or
   `.gitlab-ci.yml` file, not just the added lines — a security-relevant
   line (a `permissions:` block, a `uses:` pin) removed or weakened is as
   much a finding as one added.
2. Note the trigger(s) each changed/added job runs under
   (`pull_request`, `pull_request_target`, `push`, `workflow_dispatch`,
   GitLab's `rules:`/pipeline source) — the trigger determines which
   findings below even apply.

### Step 2: Check each risk category

- **`pull_request_target` + untrusted checkout.** Does any
  `pull_request_target`-triggered job check out the contributor's own fork
  ref or head commit SHA (via the pull request event's own `head` field)
  and then run a build/test/lint step against that checkout?
  That combination is the "pwn request" pattern — flag it regardless of
  how innocuous the executed step looks, since the risk is the
  combination, not any one line.
- **Action pinning.** Does every third-party `uses:` line (anything
  outside the repository's own `.github/actions/`) reference a full
  commit SHA rather than a tag (`@v4`) or branch name? A tag comment next
  to a SHA is fine; a bare tag as the actual pin is not.
- **`permissions:` scope.** Is there a workflow-level `permissions:
  write-all`, or no `permissions:` key at all on a workflow whose jobs do
  not all need write access? Is `id-token: write` granted only to the job
  that actually performs OIDC federation?
- **Script injection.** For GitHub Actions: does any `run:` step
  interpolate `${{ github.event.* }}` (a PR title, issue body, branch
  name, commit message) directly into the shell string, instead of
  routing it through an intermediate `env:` entry first? For GitLab CI:
  does a `script:` line use an untrusted variable (an MR title, a branch
  name) unquoted, or concatenate it into a string handed to `eval`/
  `sh -c` — routing it through another `variables:` entry does not fix
  this, since every GitLab CI/CD variable is already a shell environment
  variable by the time `script:` runs; also check any `$[[ inputs.* ]]`
  interpolation for untrusted input, since that IS substituted before the
  job is created.
- **GitLab protected variables/branches.** Does a deploy job that
  consumes a credential-bearing variable have `rules:` restricting it to
  the protected branch/tag that variable is actually exposed to, and is
  that variable itself marked Protected and Masked?

### Step 3: Report findings

For each finding: name the exact line/job, state which risk category it
falls under, explain the concrete consequence (not just "this is
insecure"), and give a fix direction from `rules/security.mdc` — never
apply the fix yourself.

```
Findings in .github/workflows/pr-review.yml:
  - Job "test" (line 12): triggered by pull_request_target, this job
    checks out the fork's own head SHA and then runs `make test` against
    it -- pwn-request pattern. Fix direction: switch to `pull_request`, or split
    into an unprivileged build job + a separate privileged job that only
    consumes safe artifacts.
  - Job "test" (line 18): actions/checkout@v4 -- pinned to a mutable tag.
    Fix direction: pin to actions/checkout's full commit SHA.
No other findings.
```

## Rules

- Read-only: report findings and fix direction, never edit the workflow
  file or claim a fix was applied, even partially or as a proof of
  concept.
- Flag `pull_request_target` + untrusted-checkout-and-execute as a
  finding every time it appears, regardless of how trivial the executed
  step looks.
- Flag any third-party action pinned to a tag rather than a full commit
  SHA.
- Flag a workflow-level `permissions: write-all` (or no `permissions:` at
  all) alongside jobs that do not all need write access.
- Flag `${{ github.event.* }}` interpolated directly into a `run:` string
  instead of passed through `env:` first (GitHub Actions). Flag a GitLab
  CI `script:` line that uses an untrusted variable unquoted or
  concatenates it into `eval`/`sh -c` (routing it through another
  `variables:` entry does not fix this), or an untrusted pipeline/trigger
  input reaching a `$[[ inputs.* ]]` interpolation unvalidated.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "This is just a docs/CI change, security review doesn't apply" | A CI workflow change is exactly the surface this skill exists for -- a workflow file itself grants access to secrets and write scope, independent of what other code changed in the same PR |
| "The tag is from the official actions/ org, it's fine to leave unpinned" | The pinning risk is about the tag being movable, not about who currently controls it -- a first-party org account can still be compromised, and the fix costs nothing |
| "I noticed the fix while reviewing so I went ahead and applied it" | This skill is read-only; report the finding and fix direction, and let the implementation skill or the author apply it |

## Verification

Do not report the review done until all of the following hold:

- Every changed job's trigger was checked against the
  `pull_request_target` + untrusted-checkout pattern.
- Every third-party `uses:` line in the diff was checked for tag vs.
  commit-SHA pinning.
- The `permissions:` block (workflow- and job-level) was checked for
  least privilege.
- Every `run:` step touching `${{ github.event.* }}` was checked for
  direct interpolation vs. intermediate `env:` (GitHub Actions), and every
  GitLab CI `script:` step touching an untrusted variable was checked for
  unquoted use, `eval`/`sh -c` concatenation, or an unvalidated
  `$[[ inputs.* ]]` interpolation.
- No finding was silently skipped because the surrounding change looked
  unrelated to security.
