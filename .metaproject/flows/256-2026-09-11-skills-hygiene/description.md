# Skills and rules hygiene: duplicates, contradictions, dead references, metadata drift

Status: formalized
Source: user request 2026-09-11 after the agent-skills comparison
Program: docs/plans/skills-quality-program.md (flow 1 of 4)

## Problem

The shipped skills (`src/gdskills/bundled/skills/**`) and rules
(`src/gdskills/bundled/rules/core/**`) carry debt that makes agents act on
wrong or conflicting instructions:

- a rule shipped twice under two names (`review-agent-profile.mdc` is
  byte-identical to `code-review-ai-assistant.mdc`);
- `review-orchestrator` contradicts itself about `model_strategy: current` and
  still names the removed strict synthesis pass;
- verification skills hardcode `npx jest/eslint/tsc` and disagree on the loop
  bound (2 vs 3), against `task-implementer`'s own "do not hardcode" rule;
- skills disagree on where the job context file lives;
- references to files, schemas, hooks and mirrors that do not exist;
- frontmatter drift: duplicated YAML keys in runtime variants, `claude` missing
  from `compatible_harnesses`, categories that disagree with the catalog;
- generated stub descriptions that do not read as triggers
  ("Use when choose between ...");
- entrypoint mirrors `rules/agents-md.md` / `rules/claude-md.md` that are empty;
- overlapping and conflicting rules (unhandled rejections twice, three
  incompatible documentation layouts, model choice by hand vs `keryx review tier`);
- git-concurrency lessons (never stash in a shared tree, explicit pathspecs,
  `git -C` in worktrees, commit per task) live only in one user's memory;
- stack-specific rules (MobX, NestJS, Storybook, Playwright, SQL) carry no stack
  label, and the README implies `alwaysApply`/`globs` do something nothing reads;
- `entity-skill-verifier` claims a content comparison that `verify.ts` does not
  perform, and project skills contradict their own verification status.

Every defect is re-verified in the current tree in `context.md` before freeze.

## Expected Outcome

Every confirmed defect above is fixed in the bundled source and its install
mirror, pinned by a test where a test can pin it, and the bundled tree passes
`keryx skills verify --bundled`, the full suite and a clean review.

## Out of Scope

- New skill anatomy lint, routing evals, variant generation (flow 253).
- New skills or rules beyond the git-concurrency rule (flow 254).
- Deleting stack-specific rules: they ship to user projects; they get labelled.
- Implementing real content-vs-code verification of project skills (only the
  claim is made honest here).
