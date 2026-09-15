# Plan

Branch `skills/skill-gaps`, cut from `main` at `ea569c92` (the squash merge of
flow 257). Worktree
`/Users/Goodea/goodea/keryx/.claude/worktrees/skills-quality`.

Read `context-map.md` before anything else — it corrects `description.md`,
which was written before the gate existed.

## What shapes the waves

Two measured constraints, not preferences:

- **The length ratchet.** `task-implementer` (670), `interviewer` (131),
  `perf-check` (104) and `review-performance` (374) each sit exactly at their
  ceiling, and the rule shipped in 257 forbids raising one. Every addition to
  those files is paid for by a trim of the same size in the same commit. A task
  that plans only the addition will not land.
- **`RANK1_FIRST`/`RANK1_TOTAL` is one pair of integers.** Every task that adds
  a skill moves it, and the test fails on an unrecorded improvement as well as
  a regression. Skills are therefore added in ONE lane, and the record is
  re-measured once, by the last task in that lane.

## Waves

**W1 — the skills lane, serialized.** One task per skill, in order, each
landing its own `SKILL.md`, mirror, catalog entry, ceiling entry and corpus
entry; the last one re-measures the rank-1 record for all four. Splitting this
lane across parallel workers guarantees a conflict in `routing-corpus.ts`.

**W2 — the rules, in parallel with W1.** Rules are not length-checked, not
anatomy-checked and not catalog-registered, so they touch none of W1's files.
The definition-of-done rule must first measure which rules already state a bar,
and cite them; `description.md`'s claim of "three rules" is unverified.

**W3 — the floor guard, in parallel with W1 and W2.** Genuinely new code:
a consumer of `buildReviewScope` plus a CLI surface. No overlap with the skill
or rule files. Sized as its own wave because nothing in the repo does any part
of it today.

**W4 — the existing-skill edits, after W1.** `task-implementer`, `interviewer`,
`perf-check` and `review-performance`. Each is a trim-and-extend inside a fixed
ceiling. Kept out of W1 so that a worker fighting the ratchet is not also
holding the corpus lane.

**W5 — verification and review.** Full suite, mirrors, typecheck, lint,
bundled verify; then `keryx review floor` run against this branch's own diff
(AC6); then review rounds to a clean gate.

## Order and dependencies

```
W2 rules ─┐
W3 floor ─┼─ W5 verify → review
W1 skills ─┴─ W4 edits ─┘
```

## Constraints for every task

- Workers never commit. The orchestrator commits each task's declared files.
- Never `git stash`; never `git add -A`; stage explicit paths.
- `src/gdskills/bundled/**` is the source of truth; `.metaproject/skills/gdskills/**`
  and `.metaproject/rules/core/**` are mirrors that must stay byte-identical.
- Never run `keryx update` in this repo.
- Run the CLI from source: `bun ./src/cli.ts <cmd>`.
- No `Co-Authored-By` or "Generated with" trailers.
- A skill added here must pass the gate without an exemption. An exemption is a
  finding, not a workaround: if a new skill cannot satisfy the anatomy, the
  skill is wrong, not the check.
