# Skills and rules quality program

Status: in progress (flows 253-256), branch `skills/quality-program`, started 2026-09-11.

## Why

A side-by-side reading of our gdskills and rules against
[addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) (MIT,
v0.6.9) found that our execution machinery (flow state, contracts, STATUS
protocol, execution-verified review, skill learning, hook-enforced routing) is
ahead, while the way our skills themselves are written and checked is behind:

- only layer one of skill evaluation exists (`src/gdskills/bundled-eval.ts`
  says layers two and three are "NOT BUILT");
- nothing tests that a request routes to the right skill, and several skills
  collide (`interview`/`interviewer`, `test-gen`/`tests-creator`,
  `job-orchestrator` triggers overlapping `review-orchestrator`);
- no common skill anatomy: Red Flags / exit criteria are missing from
  `flow-orchestrator`, `code-verifier`, `tests-creator`, `brainstorm`,
  `interviewer`, the quality workflow skills; the largest skills run to
  2190 (`job-orchestrator`) and 1922 (`review-orchestrator`) lines;
- lifecycle gaps with no skill or rule: debugging, in-flight adversarial
  doubt, source verification of library docs, deprecation/migration of code and
  CLI surface, definition of done, CLI interface design;
- accumulated hygiene debt (see flow 256).

## What we take, and what we do not

Taken (re-expressed in our own words and mechanisms, with MIT attribution in
`THIRD_PARTY_NOTICES.md` where a technique is adapted):

- deterministic routing evals: positive prompts, negatives that name the owning
  skill (pairwise, not vacuous), catalog-wide description-collision check,
  ratcheted baseline;
- a required skill anatomy checked by lint, plus a length budget;
- description discipline: triggers, "NOT for", never a summary of the workflow;
- behavioural evals with pressure scenarios — and, unlike the source, a
  without-skill control arm and repeated runs, so impact is measured;
- debugging, doubt-driven review, source-driven development, deprecation and
  migration skills;
- a diff-scoped floor guard (lowered thresholds, `.skip`, removed asserts, new
  suppressions) as a real check, not a reference snippet;
- structured "noticed but not touching / assumptions / not touched" fields as
  schema fields in the `task-implementer` result, not free-text templates;
- interview mechanics: a guess per question, stated confidence, a hedged
  "sounds good" is not approval, mandatory out-of-scope line;
- "neutral is a revert" and a ledger of reverted attempts for performance work;
- a ledger of rejected skill changes.

Not taken: the "no orchestrators" doctrine (our flow state machine is the
stronger design), the `simplify-ignore` hook (rewrites the working tree for a
whole session), SessionStart injection of a meta-skill (our index hard gate
covers it), hand-maintained per-runtime copies (we already suffer from them).

## Flows and order

| Flow | Scope | Depends on |
|---|---|---|
| 256 skills-hygiene | duplicates, contradictions, dead references, metadata drift, git-safety rule, stack labelling of rules | - |
| 253 skill-quality-gate | anatomy + description lint, length budget, routing evals + collision check, installed-tree xref, generated runtime variants, Red Flags/Verification backfill, rejected-change ledger | 256 |
| 254 skill-gaps | new skills and rules listed above, floor guard, task-implementer result fields, interviewer and perf mechanics | 253 (new skills must pass its gate) |
| 255 skill-behavior-evals | behavioural eval runner with control arm and repeated runs on `scripts/benchmark/`, first corpus, honest update of the bundled-eval layer status | 253, 254 |

Each flow is frozen and started only when its predecessor is finished, so its
acceptance criteria are written against the tree it will actually change.

## Constraints for every task

- Worktree: `/Users/Goodea/goodea/keryx/.claude/worktrees/skills-quality`,
  branch `skills/quality-program`. Use absolute paths and `git -C <root>`.
- Source of truth for shipped skills and rules is `src/gdskills/bundled/**`;
  `.metaproject/skills/gdskills/**` and `.metaproject/rules/core/**` are
  install mirrors that must stay byte-identical (`src/gdskills/install.test.ts`).
  Edit both identically. Never run `keryx update` in this repo (it overwrites
  the curated `.metaproject/index.md`).
- Run the CLI from source: `bun ./src/cli.ts <cmd>` (the installed binary lags).
- Rules like MobX/NestJS/Storybook ship to user projects; they are labelled by
  stack, not deleted.
- Never `git stash`; never `git add -A`; stage explicit paths; commit at every
  task boundary; no `Co-Authored-By` or "Generated with" trailers.
