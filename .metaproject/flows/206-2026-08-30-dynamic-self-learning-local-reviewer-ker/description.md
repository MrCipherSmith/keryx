# Description

## Problem

`code-boss-review` and `code-review-boss-profile.mdc` ship in the public keryx
repository carrying **one specific person's review style**: MobX and store
conventions, `currentState`, the `I` interface prefix, and that reviewer's own
speech markers. That is knowledge about a particular user, published in a general
tool.

It is also frozen. The profile was written once and only changes when somebody
edits it by hand, while the thing it describes — how a particular reviewer
actually reviews — is visible continuously in that reviewer's pull-request
comments.

The operator's requirement, in their words: keryx must hold **no knowledge of
specific users**. The shipped rule should say plainly that it is a dynamic rule
which self-learns locally. Which reviewers feed it, and in which project, is a
local decision. Learned content stays in that project and never returns to this
repository. Point it at a different reviewer in another project and the local
reviewer diverges — that is the intended behaviour, not a defect.

## What already works, verified by running it

The self-learning loop is real and is one of the six mechanisms the Phase 7 audit
found genuinely wired:

- `keryx skills learn --from-review <path> --skill <module>/<skill>` writes a
  proposal and **mutates nothing** — the propose/apply separation is enforced in
  code, not advised.
- `keryx skills learn apply <proposal.json>` bumps the version, writes into named
  sections (Review Lessons, Review Checklist, Anti-patterns), appends to
  `skill-changelog.md`, refuses a double-apply, and refuses any path outside
  `.metaproject/project-skills/`.
- Everything lands in `.metaproject/project-skills/` — local to the project.

Proved end to end in a throwaway project: `0.1.0 → 0.1.1`, the lesson present in
`SKILL.md`, an audit record written.

`keryx review comments collect` already gathers pull-request comments from all
three GitHub sources and records each author.

## What is missing

**The join.** Nothing connects "comments by these particular people" to "teach
the local skill". `learn --from-review` takes a file; the collector writes a
record; no configuration names whose comments count.

**The template.** The shipped skill and rule describe a persona instead of a
mechanism.

## Expected outcome

Keryx ships the mechanism and no people. A project names its own reviewers, and
its local skill learns from them.

## Scope of THIS flow

The template, the per-project configuration, and the join between collected
comments and the learning loop.

## Out of scope

- **Phase 5 and Phase 6** of the orchestrator-hardening roadmap.
- **The SAC ledger checkpoint hole** — awaiting an operator decision.
- Changing how `learn`/`learn apply` themselves work. They are verified working
  and are the foundation this builds on, not the subject.

## What this flow must not do

**It must not lose the operator's conventions.** They are being moved, not
deleted. Their own copies at `~/goodai-base/rules/core/code-review-boss-profile.mdc`
and `~/.claude/skills/code-boss-review/SKILL.md` were verified byte-identical to
the repository's before removal, so nothing is destroyed — but the flow must
also leave a documented path for seeding a local skill from them.

**It must not replace a person's name with a placeholder and call it generic.**
The test is whether the shipped text would read identically for a team that has
never heard of this reviewer. A rule that says "learn from the boss" is the same
defect with the noun changed.

**It must not let learned content escape the project.** A proposal applied in
Vantage Frontend belongs to Vantage Frontend. Nothing in this flow may write
learned conventions back into `src/gdskills/bundled/`.
