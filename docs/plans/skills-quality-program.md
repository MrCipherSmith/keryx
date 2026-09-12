# Skills and rules quality program

Status: in progress (flows 256-259), started 2026-09-11. One branch per flow,
not one for the program: 256 on `skills/quality-program` (merged, #533), 257 on
`skills/quality-gate` (merged, #540), 258 on `skills/skill-gaps` (open, #545),
259 not yet cut.

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
  2246 (`job-orchestrator`) and 1907 (`review-orchestrator`) lines;
- lifecycle gaps with no skill or rule: debugging, in-flight adversarial
  doubt, source verification of library docs, deprecation/migration of code and
  CLI surface, definition of done, CLI interface design;
- accumulated hygiene debt (see flow 256).

## What we take, and what we do not

Taken (re-expressed in our own words and mechanisms, with MIT attribution
inline in the document that adapts the technique — this repo's convention, as
`docs/skills/rejected-skill-changes.md` does it. A root `THIRD_PARTY_NOTICES.md`
was considered and dropped: `package.json` `files` would not publish it, so it
would reach nobody. Flow 258 T16 placed the credits: `quality/root-cause`,
`quality/fresh-eyes`, `quality/api-truth`, `quality/deprecation-path`,
`src/review/floor.ts`, and one line each at the adapted mechanic in
`orchestration/task-implementer`, `planning/interviewer` and
`quality/perf-check`. `rules/core/definition-of-done.mdc` and
`rules/core/cli-interface-design.mdc` carry none: the comparison prompted the
gap, but both rules are joins of documents and commands already in this repo.
T16 covered flow 258's own adaptations only — **flow 257's are outstanding, and
the list is below the bullets**):

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

### Outstanding: flow 257's credits

Flow 257 (merged as #540) adapted four of the techniques listed above and
shipped none of the attribution AC11 requires. Recorded here rather than fixed,
because every file concerned is owned by another task in flight; the credits are
owed where the technique is **implemented**, not where the subject matter
overlaps:

- `src/gdskills/bundled-eval.ts` — one credit covering three: the required
  skill anatomy checked by lint (`anatomy:sections`), the length budget
  (`anatomy:length`), and description discipline (`description:collision`, and
  the trigger / "NOT for" shape `anatomy:sections` demands). All three are the
  source's techniques made executable over our own tree; the thresholds, the
  Jaccard collision test on the router's own tokenisation, and the
  `anatomy:red-flags-collision` check are ours.
- `src/commands/routing-corpus.ts` — one credit for the corpus shape: positive
  prompts per skill plus negatives that name the `owner` which must outrank it.
  The exhaustive per-skill coverage, the two-paraphrases-without-own-triggers
  requirement and the equality-pinned `RANK1_FIRST`/`RANK1_TOTAL` ratchet are
  ours.

Two files in the same flow owe nothing, and saying so is part of the standard —
over-crediting is its own dishonesty:

- `src/commands/routing-baseline.ts` — its device (record what the scorer does
  *including what it does wrong*, before touching it) is traced in its own
  header to a local measured failure across three review rounds. The "ratcheted"
  half of "ratcheted baseline" lives in `routing-corpus.ts` and is credited
  there.
- `src/gdskills/skill-length-ceilings.ts` — the data table for a check that
  lives in `bundled-eval.ts`, and its governing policy (ceilings equal today's
  count when introduced, and move down only) comes from our own
  `rules/core/skills-storage-workflow.mdc`. Crediting it would credit a topic,
  not an adaptation.

Not taken: the "no orchestrators" doctrine (our flow state machine is the
stronger design), the `simplify-ignore` hook (rewrites the working tree for a
whole session), SessionStart injection of a meta-skill (our index hard gate
covers it), hand-maintained per-runtime copies (we already suffer from them).

## Flows and order

| Flow | Scope | Depends on |
|---|---|---|
| 256 skills-hygiene | duplicates, contradictions, dead references, metadata drift, git-safety rule, stack labelling of rules | - |
| 257 skill-quality-gate | anatomy + description lint, length budget, routing evals + collision check, installed-tree xref, generated runtime variants, Red Flags/Verification backfill, rejected-change ledger | 256 |
| 258 skill-gaps | new skills and rules listed above, floor guard, task-implementer result fields, interviewer and perf mechanics | 257 (new skills must pass its gate) |
| 259 skill-behavior-evals | behavioural eval runner with control arm and repeated runs on `scripts/benchmark/`, first corpus, honest update of the bundled-eval layer status | 257, 258 |

Each flow is frozen and started only when its predecessor is finished, so its
acceptance criteria are written against the tree it will actually change.

## Constraints for every task

- Worktree: `/Users/Goodea/goodea/keryx/.claude/worktrees/skills-quality`.
  Each flow runs on its own branch cut from main after the previous one merged
  (256: `skills/quality-program`, merged as #533; 257: `skills/quality-gate`,
  merged as #540 at `ea569c92`; 258: `skills/skill-gaps`, open as #545).
  Use absolute paths and `git -C <root>`.
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
