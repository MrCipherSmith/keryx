---
name: ci-pipeline-implementation
description: "Use when authoring or extending a GitHub Actions workflow (.github/workflows/*.yml) or a GitLab CI pipeline (.gitlab-ci.yml) -- trigger and job design, reusable workflows/templates, caching, least-privilege permissions, and safe handling of untrusted pull-request/merge-request input."
triggers:
  - "add a GitHub Actions workflow that runs tests on every pull request"
  - "write a .gitlab-ci.yml pipeline with build, test, and deploy stages"
  - "add a job to this workflow that caches node_modules"
  - "split this workflow into a reusable workflow other repos can call"
  - "add a permissions block to this GitHub Actions workflow"
  - "set up a GitLab CI pipeline with protected deploy variables"
metadata:
  origin: authored
  category: implement
  version: "1.0.0"
  compatible_harnesses: "claude,codex,cursor,zed,opencode"
license: "MIT"
---

# CI pipeline implementation (GitHub Actions & GitLab CI)

Author or extend a GitHub Actions workflow (`.github/workflows/*.yml`) or a
GitLab CI pipeline (`.gitlab-ci.yml`): trigger and job design, reuse,
caching, and — because this file's whole job is to react to pushes and pull
requests from outside contributors — secure-by-default handling of
untrusted input from the start. `rules/patterns.mdc` and
`rules/security.mdc` carry the full stack-specific rule set this skill
draws its checklist from; read them before writing YAML, not just this
summary.

## Workflow

### Step 1: Discover the project's own conventions

1. Read the existing `.github/workflows/*.yml` files or `.gitlab-ci.yml`
   already in the repository for: trigger conventions, whether
   `permissions:` is already scoped, existing reusable
   workflows/composite actions or `include:`/`extends:` templates, and
   the runner/image already in use.
2. Check for an existing reusable workflow, composite action, or
   `include:`/`extends:` template that already does what this change
   needs before writing a new job from scratch — duplicating an existing
   step sequence is the anti-pattern `rules/patterns.mdc` calls out.
3. Note which events this change actually needs to react to (push to a
   branch, pull/merge request, tag, schedule, manual dispatch) — do not
   default to the broadest trigger available.

### Step 2: Design the trigger and permission surface first

- Decide the trigger: `pull_request` (or GitLab's merge-request pipeline)
  for anything that only builds/tests a contribution: when triggered from
  a fork, `GITHUB_TOKEN` (the base repo's own token, scoped read-only for
  this case — not a separate fork token) is the only secret passed to the
  runner at all. Reach for `pull_request_target` only when the job
  genuinely needs base-repo secrets or write access, and never combine it
  with checking out and executing the pull request's own head SHA — see
  `rules/security.mdc`.
- Set `permissions: {}` at the workflow level and grant only the specific
  scope each job needs at the job level (`contents: write`,
  `pull-requests: write`, `id-token: write`, etc.) — never
  `permissions: write-all` or an unscoped default.
- For GitLab, decide up front which variables a deploy job needs and
  confirm they are marked Protected + Masked, and that the job's `rules:`
  restrict it to the protected branch/tag those variables are exposed to.

### Step 3: Implement

1. Write the trigger (`on:`/`rules:`), job structure, and
   `permissions:` block per Step 2's design.
2. Pin every third-party `uses:` action to a full commit SHA, not a tag
   (`uses: actions/checkout@<sha>`, optionally commented with the tag it
   corresponds to for readability).
3. GitHub Actions: pass any `${{ github.event.* }}` through an
   intermediate `env:` entry before it reaches a `run:` shell string —
   never interpolate it directly into the script text. GitLab CI: quote
   every variable used in `script:` and never concatenate an untrusted one
   into an `eval`/`sh -c` string — routing it through another `variables:`
   entry does not fix this, since it is already a shell environment
   variable by the time `script:` runs; also validate/escape any untrusted
   pipeline/trigger input reaching a `$[[ inputs.* ]]` interpolation,
   which IS substituted before the job is created.
4. Add `timeout-minutes`/`timeout` to every job, and a `concurrency:`
   group (or `resource_group`, GitLab CI) to anything that deploys or
   mutates shared state — not `interruptible: true`, which means the
   opposite (safe to auto-cancel), the wrong property for a deploy.
5. Key any cache off the lockfile/manifest hash, and scope artifacts to
   what a later job actually consumes with an explicit retention.

### Step 4: Verify

- Lint the workflow (`actionlint` for GitHub Actions, `gitlab-ci-lint`/the
  project's own `.gitlab-ci.yml` CI Lint page for GitLab CI) if the
  project has it configured; otherwise re-read the file against
  `rules/security.mdc`'s anti-pattern list line by line.
- Confirm every `uses:` line names a full commit SHA, not a tag.
- Confirm no `${{ github.event.* }}` is interpolated directly inside a
  `run:` string (GitHub Actions), and no untrusted GitLab CI/CD variable
  is used unquoted or concatenated into an `eval`/`sh -c` string in
  `script:`.
- Confirm the `permissions:` block (or the absence of workflow-level
  `write-all`) matches what Step 2 decided.

### Step 5: Report

```
Added: .github/workflows/pr-checks.yml
  - pull_request trigger, permissions: {} at workflow level, contents: read at job level
  - actions/checkout pinned to a commit SHA
  - PR title passed through env: before the shell check, not interpolated directly
```

## Rules

- Never check out and execute a pull request's own head ref/SHA inside a
  `pull_request_target` job.
- Never pin a third-party action to a mutable tag; pin to a full commit
  SHA.
- Never interpolate `${{ github.event.* }}` directly into a `run:` shell
  string — route it through `env:` first. For GitLab CI, always quote a
  variable used in `script:` and never build an `eval`/`sh -c` string by
  concatenating an untrusted variable into it (routing it through another
  `variables:` entry does not change how the shell expands it).
- Never leave a workflow-level `permissions: write-all` (or an unscoped
  default) when only specific jobs need write access.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "It's just a version tag, the maintainer wouldn't push something malicious to it" | A tag is exactly the reference an attacker (via a compromised maintainer account, or the maintainer's own compromised supply chain) can silently move; a commit SHA cannot be moved |
| "I'll just checkout the PR head so the build tests the actual change" | That is precisely the `pull_request_target` + untrusted-checkout combination that hands an attacker-controlled PR your base-repo secrets |
| "The PR title is just a string, it won't break the shell" | A title containing `"`, `` ` ``, or `$(...)` breaks out of the generated shell script the moment it is interpolated directly, regardless of how innocuous most titles look |
| "permissions: write-all is simpler than figuring out exactly what each job needs" | It hands every job in the file the most-privileged job's access, including jobs that only read — the extra few lines of per-job scoping is the actual fix, not a shortcut worth skipping |

## Verification

Do not report the work done until all of the following hold:

- The trigger matches what the job actually needs (`pull_request`, not
  `pull_request_target`, unless base-repo secrets/write access are
  genuinely required).
- No `pull_request_target` job checks out and executes the pull request's
  own head SHA/ref.
- Every third-party `uses:` action is pinned to a full commit SHA.
- No untrusted `${{ github.event.* }}`/CI variable is interpolated
  directly into a `run:`/`script:` string.
- `permissions:` is scoped at the job level to only what each job needs,
  with no workflow-level `write-all`.
