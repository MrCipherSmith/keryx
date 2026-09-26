# Implementation Plan

Status: formalized

## Approach

Edit the four `SKILL.md` files directly (canonical `src/gdskills/bundled/skills/orchestration/**`
copy, mirrored byte-identical into `.metaproject/skills/gdskills/orchestration/**`),
adding a few lines of guidance per file at the exact point each orchestrator
already dispatches `task-implementer` or reacts to a check/finding. No new
commands, schemas, or model calls — every command referenced
(`jev-edit-guard`, `ci-triage`) either already ships or is named as a
forthcoming parallel-branch command per the brief.

Every touched `SKILL.md` has a line-count ceiling in
`src/gdskills/skill-length-ceilings.ts` that must equal the file's exact line
count (`bundled-eval.test.ts`, "the ratchet only moves down"). Any addition is
paired with an equal-or-larger compensating trim (joining wrapped prose into
single lines, compacting a redundant example) in the same file, so no ceiling
is ever raised — only lowered or left equal.

## Steps

1. Read the four skills' structure; locate the exact dispatch/react points.
2. `flow-orchestrator`: before the first `task-implementer` dispatch, add the
   edit-guard install-check line; in the PR review/fix loop, add the
   ci-triage classification before treating a required check failure as a fix
   task.
3. `job-orchestrator`: before the wave's first `task-implementer` dispatch,
   add the same edit-guard check; add a CI-triage row to the Error Table for
   a failed GitHub check on the PR.
4. `task-implementer`: add one Rules-of-Engagement item for `Rule check
   flagged: …` tool results (check named rule, fix if real, note false flags
   in `notes`).
5. `code-verifier`: add a Phase 2 sub-step that triages a red GitHub CI check
   before filing it as a CRITICAL finding.
6. For each file, recount lines (`wc -l`) and update its ceiling entry only if
   the net result differs from the recorded one — never leaving the two out
   of sync.
7. Mirror every edited `SKILL.md` into `.metaproject/skills/gdskills/**` so
   both copies stay byte-identical.
8. Add `docs/docs/guides/jev-in-the-delivery-loop.md`, link it from
   `docs/docs/index.md` and `README.md`, and add an additive `## [Unreleased]`
   entry to `CHANGELOG.md`.
9. Run the skill-copy-identity, line-ceiling, catalog/evals, and round-bound
   tests, plus lint and typecheck.
10. Commit, push `feat/jev-delivery-loop`, open a draft-turned-real PR, watch
    CI, fix forward on failure (rerun known-flaky jobs at most once), then
    record the PR against the flow and close it via `keryx flow implemented`
    — never `flow complete`, since that requires a merge this task forbids.

## Risks

- **Line-ceiling ratchet.** Growing any of the four `SKILL.md` files without
  an equal trim fails `bundled-eval.test.ts`'s ceiling-equality check.
  Mitigated by compacting existing wrapped prose into single lines in the
  same file, never by raising a ceiling.
- **Pinned strings.** `round-bound.test.ts` and
  `session-plan-bridge-contract.test.ts` pin exact substrings (the three-vs-six
  attempt-bound citation, the `proposed` Phase 4 phrase) inside these same
  files — an earlier attempt to move the attempt-bound citation into a new
  `SKILL.detail.md` broke `round-bound.test.ts`, which requires the citation
  verbatim in every `SKILL*.md` file for the skill. Reverted; the trim came
  from elsewhere in the same file instead.
- **Two-copy drift.** `src/gdskills/bundled/skills/**` and
  `.metaproject/skills/gdskills/**` must stay byte-identical; every edit is
  followed by a `diff -q` check between the two paths.
- **Conflicts with parallel branches.** `feat/jev-edit-guard` and
  `feat/jev-orchestrator` are in flight on the same repository and may touch
  `CHANGELOG.md`'s `## [Unreleased]` section or the same `.mdc`/config
  surfaces; this flow only *references* their commands by name and does not
  implement them, which should keep the diff disjoint, but the CHANGELOG
  section itself may need a manual merge across the three PRs.
