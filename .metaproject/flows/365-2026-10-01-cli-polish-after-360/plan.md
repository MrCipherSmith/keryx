# Implementation Plan

Status: ready (2026-10-01, after flow 362 merged as 9c7183b5)

## Approach

Four independent CLI fixes with disjoint files, done in parallel by four workers, each test-first, one commit
each; one draft PR, CI, one review round.

- **T5 — AC1 trigger.** `src/gdskills/bundled/skills/core/reviewer-skill-creator/SKILL.md` frontmatter: replace
  the overlay-named trigger with "import overlay reviewers"; keep the `.metaproject/skills/gdskills/…` projection
  byte-identical; trigger-collision / routing tests stay green.
- **T6 — AC2 installer.** `keryx skills install --with/--without <id>`: an id that is not a known component, or
  that cannot change the plan for the chosen profile, is an error listing the valid ids; the dry-run
  `Apply this plan` hint reproduces every plan-shaping flag (`--with`, `--without`, `--include-deprecated`,
  `--target`, `--profile`). Files: `src/commands/skills.ts` (install route), `src/gdskills/manifest/plan.ts`.
- **T7 — AC3 update output and help parity.** `keryx skills update` gets its own heading/wording in the renderer
  and the same `paths: none`, `flagWarnings` and family-flag warnings an import of the package prints;
  `keryx review --help` and `keryx review comments --help` list the same `comments reply` flags, pinned by a
  test. Also, in `import-skills.ts`, qualify the rendered "`keryx skills install` overwrites rules/core"
  sentence (legacy profile route only; not the manifest form with `--target`) — part of AC4, done here because
  T7 owns that file. Files: `src/gdskills/import-skills.ts`, `src/commands/review.ts` (help only).
- **T8 — AC4 rest.** The same qualification in `src/review/reviewers.ts`'s rendered paragraph;
  `model-tier.ts` `parseSkillModelTier` and `bundled-eval.ts` `frontmatterKeys` read frontmatter through
  `src/gdskills/skill-frontmatter.ts`; the reader's header no longer lists them as exceptions. Behaviour on the
  bundled corpus must be unchanged (prove it: same model tiers and same bundled-eval result before/after).

## Rules for this flow

- Tests run locally only for the files a worker touches; the full suite runs in CI on the draft PR.
- Workers on the Sonnet model; the review round on the session model.

## Risks

- T6 changes an installer exit code: a script passing a harmless `--with` that never mattered now fails.
  Called out in the PR.
- T8 moves two parsers onto the shared reader; the reader is stricter on malformed frontmatter (flow 360
  H-018). The before/after comparison over the bundled corpus is the guard.
