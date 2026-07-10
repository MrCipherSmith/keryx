# Implementation Spec — Documentation and Release Readiness

Date: 2026-07-10
Agent: Codex, direct Metaproject documentation workflow

## What

Refresh the public and developer documentation so it accurately describes the
capabilities implemented after `v0.1.0`. Audit the repository for cleanup
candidates and produce an evidence-backed release-readiness report without
deleting or publishing anything.

## Why

The repository has accumulated substantial functionality since the first tagged
release, including symbol-aware graph navigation, wiki backlinks and hierarchy,
agent orientation, context routing guards, managed review workflows, and a
smaller deterministic dependency footprint. The current documentation and
self-hosted Metaproject artifacts do not consistently describe that state.

## Scope

**In scope:**

- Update `README.md`, `CHANGELOG.md`, and the developer documentation under
  `docs/docs/`.
- Update the documentation index and release roadmap where current behavior is
  missing or stale.
- Refresh the self-hosted graph and wiki artifacts when the project-local CLI
  supports deterministic regeneration.
- Audit generated files, historical flow artifacts, completed plans, duplicated
  runtime skill variants, legacy naming, and documentation layout.
- Produce a prioritized cleanup backlog and release checklist.
- Run documentation, typecheck, test, build, health, and link verification gates.

**Out of scope:**

- Deleting cleanup candidates without a separate approval.
- Bumping the package version, creating a git tag, publishing a package, or
  creating a GitHub release.
- Committing, pushing, or opening a pull request without explicit approval.
- Restoring or including the pre-existing stashed memory-artifact edits.

## Acceptance Criteria

- [ ] Public and developer documentation covers every material capability added
      after `v0.1.0`.
- [ ] CLI examples and command references match the current implementation.
- [ ] The changelog contains an accurate English-only unreleased section.
- [ ] The documentation root provides a clear navigation index.
- [ ] Self-hosted graph/wiki state is either refreshed or explicitly documented
      as blocked with a reason.
- [ ] Cleanup candidates are prioritized by safety, impact, and release timing.
- [ ] Verification results and residual release risks are recorded.
- [ ] Every created or modified repository artifact is English-only.

## Approach

Use the Metaproject wiki and graph artifacts for navigation, then verify every
material claim against the current source and CLI help. Update canonical docs in
place, add a dated release-readiness report, regenerate deterministic artifacts,
and keep cleanup recommendations non-destructive until separately approved.

## Test Strategy

- Compare documented commands with live `--help` output.
- Run documentation link and wiki validation.
- Run TypeScript typecheck, the full Bun test suite, and the production build.
- Run the normalized testing and health workflows where available.
- Inspect the final git diff for generated noise, accidental non-English text,
  and unrelated changes.
