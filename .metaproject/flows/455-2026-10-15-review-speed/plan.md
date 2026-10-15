# Implementation Plan

Status: approved by owner (scope, fast-path policy, delivery) 2026-10-15

## Approach

Fix the review pipeline where the 2026-10-15 rounds actually lost time, in keryx code first
and skill text second, so the skill's new steps are backed by commands rather than prose.
Five work areas, one PR, one patch release, then the owner's live check.

Rejected: a skill-only change (the skill already over-instructs; mutate and late results
are code bugs); harness-level collection of late child results (wider blast radius, every
subagent user affected — the review side can read the result files it already owns);
raising the subagent deadline (hides slow reviewers, makes waves longer).

## Work areas

### A. `review mutate` works or says why (P0)
- Scratch copy under the repo (`.metaproject/data/review/mutate-scratch/<id>`, gitignored)
  instead of `tmpdir()`, so ancestor `node_modules` resolution (vite `server.fs.allow`)
  matches the real checkout; keep `--scratch tmp` as an opt-out.
- Keep the baseline's stdout/stderr tail (last ~60 lines) and print it, with the command
  and cwd, when the baseline is red or times out; write it to the evidence file.
- Clean the scratch dir on exit.

### B. Recovery never re-dispatches finished work (P0)
- `keryx review retry-plan --package <dir> --next-wave` reads the package's `raw/` and
  driver files: a slice whose result file exists and parses as DONE/DONE_WITH_CONCERNS
  for that reviewer is covered and is not handed out again; it prints which results it
  picked up ("collected late: N").
- Skill: recovery = collect → validate → ingest → dispatch only what is missing; after a
  second timeout of the same reviewer, change the task (fewer slices / narrower depth),
  not only the diff size.

### C. Early verdict, early verifier (P0)
- New `keryx review verdict <id|path>`: prints the current verdict from ingested and raw
  findings (counts by severity, verified/unverified, blockers) and writes
  `verdict-interim.md` in the package. Works before ledger/mutation/complete.
- Skill: deliver the interim verdict to the operator as soon as reviewers + verifier are
  done; mutation, ledger and `complete` continue as the round's tail. Verifier starts on
  the first blocker/major instead of after all reviewers (re-run on later majors).
- Skill preflight: check PR state (merged/approved/CI) and tell the operator the risk that
  it merges before the round ends.

### D. Sized rounds (P1)
- `review required --depth light|full|auto` (default auto): light when ≤5 files, ≤300
  changed lines, no `BUNDLED_PATH_GATES` hit, not `--all`/gating → logic, testing and the
  stack's conventions reviewer; otherwise the current full set. Output states why.
- Light rounds: mutation pass not required; `complete` records "Not run: mutation (light
  round)" instead of refusing.
- `review estimate --package <dir>` (or in `slice` output): roles × slices = assignments,
  waves at the current wave budget, expected duration range; skill shows it to the
  operator before dispatch.
- Skill: depth-floor text says "size never lowers depth below the risk class"; outside it,
  the light round is the default.

### E. CLI friction (P1)
- `dispatch-check` fails with `REVIEWER_INPUT_PATH_MISSING` when `skill_path`,
  `context_doc` or any file path in the payload does not exist.
- `review required --package <dir>` reads scope, blast-radius and pr-context from the
  package.
- Per-subcommand help for start, ingest, required, mutate, blast-radius, complete, status.
- `review start` bounds the graph refresh (`--graph-timeout`, default 90 s); on timeout it
  prints `layers: deferred` and how to refresh, and continues.
- Skill: remove the shell-host contradiction (SKILL.md:88-94).

### F. Ship and observe
- Both skill copies in sync, under the 1615-line ceiling (move text to SKILL.detail.md
  rather than raising it).
- PR → owner merges → patch release 0.3.x (tag `v*` on main).
- Owner runs 2-3 live reviews in vantage-frontend; results go to journal.md and AC9.

## Risks

- Scratch under the repo can be picked up by the project's own watchers/linters — mitigate
  with `.metaproject/data/` (already ignored by keryx-managed repos) and cleanup.
- The light round can miss a defect the full set would catch — bounded by the path gates
  and by the owner's live check; full stays one flag away.
- Skill length ceiling and parity tests will fight edits — budget text, not add.
- Concurrent sessions on main: rebase before PR, commit per task.
