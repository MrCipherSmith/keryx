# Implementation Plan

Status: implemented

## Approach

Follow the exact architectural split every prior `review-jev-*` feature in this codebase already
uses: a pure `src/review/jev-*.ts` core module (no I/O, no client import), a `src/review/jev-*-
config.ts` fail-closed config reader, and a `src/commands/review-jev-*.ts` adapter where disk/`git`/
the Jev client meet. `jev-select` deviates from every sibling in exactly one place, by design: it
fails OPEN (keeps every candidate) rather than refusing, because it is the one lever the benchmark
named as unmeasured — an unmeasured lever must never cost reviewer coverage on its own account.

`keryx review ci-triage` already existed (flow 306/307) with its own opt-in gate; this flow extends
`review-orchestrator`'s SKILL.md to call it (Step 0b) rather than re-implementing anything.

## Steps

1. `src/review/reviewers.ts`: add `description` to `BundledReviewer` (needed so `jev-select`'s
   candidate list carries a description for every reviewer, bundled or project).
2. `src/review/jev-select.ts` + `jev-select-config.ts` + `src/commands/review-jev-select.ts`: core
   logic, config gate, CLI adapter (`--diff`/`--ref`, `--reviewers`, `--fixtures`, `--skip-below`,
   `--json`, `--out`), registered in `src/commands/review.ts`.
3. `src/review/jev-profile.ts` + `src/commands/review-jev-profile.ts`: the recommended-profile
   helper (`show` / `--apply recommended`), merge-safe over `.metaproject/tasks.config.json`.
4. Both `review-orchestrator/SKILL.md` copies: Step 0b (CI triage on red checks), Step 5c
   (`jev-select` before dispatch), a FIX-phase pointer to `jev-edit-guard`, kept at exactly the
   1723-line ceiling by trimming an equal number of purely-cosmetic `---` dividers elsewhere in the
   same file. Both `SKILL.detail.md` copies: the measured-verdicts table for every CLI-engine
   reviewer.
5. TUI: `src/tui/jev-profile-inspector.ts` (the `/jevprofile` modal) + shell wiring in
   `tui-shell.ts`; `AGENT_SLASH_COMMANDS`/`HELP_GROUPS` entries; regenerate
   `docs/docs/commands-by-task.md`.
6. Tests for every module above, plus a dedicated byte-identical/line-ceiling test for the two SKILL
   copies (`src/gdskills/review-orchestrator-skill-parity.test.ts`) — no generic guard for this pair
   existed yet.
7. Docs: `docs/docs/jev-in-review.md`, README/docs-site links, `cli-reference.md` entries,
   `CHANGELOG.md` under `## [Unreleased]`.
8. `keryx test related`, typecheck, lint over every touched file; one live local run of
   `keryx review jev-select` against this repo's own diff.
9. Commit, push `feat/jev-orchestrator`, open the PR, watch CI, fix — do not merge.

## Risks

- Two agents (a fork dispatched for read-only research, and this agent) ended up both attempting the
  jev-select/jev-profile implementation concurrently in the same worktree. Resolved by negotiation:
  the fork's core/config/adapter/test work for jev-select and jev-profile was reviewed, kept, and
  built on; this agent owns SKILL.md/TUI/docs/git exclusively. See the flow journal.
- The SKILL.md line-ceiling ratchet only allows lowering, never raising — every addition had to be
  paired with an equal trim elsewhere in the same file, verified by exact line count, not estimated.
