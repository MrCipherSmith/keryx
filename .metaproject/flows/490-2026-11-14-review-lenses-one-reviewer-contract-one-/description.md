# Review lenses: one reviewer contract, one severity rubric, read-only reviewers

Status: formalized
Source: owner request 2026-11-14 ("Чинить ревьюеров") after a lens audit and two recall benches in the same session.

## Problem

The bundled review lenses (`src/gdskills/bundled/skills/review/review-*`) disagree with the orchestrator contract they are dispatched under, in ways that change what a round reports:

- **Severity.** Several lenses carry their own "this is a blocker/major" tables that contradict the canonical rubric (`review-orchestrator/SKILL.md` "Severity (canonical)"): highload's inline Flags, backend vs highload on the same condition, security calling an unreachable weakness `major` (shared law 1 makes it `info`), structural findings called `major` in architecture/clean-code/frontend, duplication rated four ways in style/clean-code. Raw-to-ingested data confirms the noise: clean-code raised 10 blocker/major across past rounds, 1 survived.
- **Side effects.** testing-practices tells the reviewer to delete each new guard in the shared working tree, run the suite and revert, while other reviewers read the same tree in parallel; the verifier deletes a guarded line with no revert; degradation's `red-test`/`merge-trace` evidence needs writes; ui-ux starts a dev server. In a bench run a reviewer also ran `keryx test run --help`, which ignored `--help` and ran the suite in the snapshot.
- **Contract text.** The orchestrator says reviewers run no command except `git log/blame/show`, while every code-reading lens carries the (tested, read-only) layers block naming `keryx gdgraph/test related/wiki ask/memory search`. The finding schema forbids an empty `class_scope.sites` that the orchestrator documents as the negative-enumeration form. `reviewer-input.schema.json` declares `known_findings` twice.
- **Stale references.** `keryx wiki query` (no such command) in pr-contract; hand-offs to `code-style-review` and `code-mobx-store-review`, which review-style and review-frontend replaced; a dangling "AC9" in review-verifier.
- **Inputs nobody supplies.** highload's `load_profile`, regression/degradation's "frozen acceptance criteria", ui-ux's `url`/`screenshots`, regression dispatched on a FIX slice while its text assumes scope B.
- **Low-yield targeting.** performance and highload checklists target ORMs/React/pools/queues; this repository is a Bun CLI/TUI. Across 108 past dispatches they produced 0 blocker/major.

## Expected Outcome

- One severity rubric: no lens assigns a severity the canonical rubric places elsewhere; lens tables only say which canonical condition a finding meets.
- Reviewers never mutate the shared tree: mutations go through `keryx review mutate` (scratch copy) or `keryx review verify-run`, or are handed to the orchestrator as `mutant_candidates`.
- The orchestrator names exactly which commands a reviewer may run (the read-only history and layer commands), and names the ones it must not (anything that runs tests/health in the tree, starts servers, writes files).
- Schemas agree with the documented forms; stale references are gone; missing inputs have a stated fallback.
- performance and highload check the hot paths and concurrency this codebase actually has.
- Recall of the changed lenses on the historical bench is not lower than before.

## Outcome criteria

- Bench recall (match + 0.5·partial against historically fixed blocker/major) of the changed lenses is not lower than the pre-change baseline on the same diffs.
- In the next real rounds, the raw→ingested blocker/major drop for clean-code/style/architecture shrinks (not measured in this flow; follow-up observation).

## Out of Scope

- Removing, merging or renaming any lens (owner decision 2026-11-14: keep all lenses).
- The review-jev-* family (owner decision: do not touch).
- Moving the shared laws or class-scope block out of each lens (deliberate design pinned by `review-skills-iron-laws.test.ts` / `review-skills-class-scope.test.ts`).
- Slice size and lens gating in `src/review/slice-routing.ts` (measured separately; a later flow).
- The `--help` handling of `keryx test run` / `keryx health run` (CLI defect; a separate follow-up).
