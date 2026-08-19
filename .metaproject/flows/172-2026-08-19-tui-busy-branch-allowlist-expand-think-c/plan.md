# Implementation Plan

Status: formalized (flow-orchestrator, 2026-08-19)

## Approach

No brainstorm/alternatives needed — the TRD already resolved the single
viable edit shape (docs/requirements/keryx-tui-busy-command-allowlist/trd.md
§1.3) with no blocking gap found: pure insertion of five new dispatch arms
into `runLine`'s existing busy branch, reusing functions already in lexical
scope. Single implementer task is sufficient; no context-collector task
needed (context already gathered by prd-creator/trd-creator investigation),
no tests-creator task needed (TRD's own resolved finding: no test harness
exists for `runLine`'s dispatch, building one is out of scope — verification
is manual/smoke + existing full suite).

## Steps

1. **T1 (implement)** — edit `src/tui/tui-shell.ts`'s busy branch exactly per
   TRD §1.3: three `command?.name` arms (`/think`, `/expand`, `/copy`) after
   the `/queue` arm; extend `isBusyReadonlyCommand` (line 3014) to include
   `isWorkspaceCommand(line) || isReviewCommand(line)`; two more arms
   (`/workspace`, `/review`) after the existing `/status`/`/flows` arms.
2. **T2 (verify)** — `code-verifier`: typecheck (`tsc --noEmit`) + full
   `bun test` suite, confirm no regression. Manual/smoke check in the running
   TUI: start a long turn, exercise all 5 commands while busy, confirm each
   matches idle-state behavior; confirm `/model` (an out-of-scope command)
   still shows the deferred message.
3. **T3 (review)** — `review-orchestrator` on the diff (small, single-file,
   TUI domain — expect `review-logic` + `review-frontend`-equivalent or
   whatever the orchestrator auto-detects for `src/tui/*.ts`).
4. Fix any findings via a dedicated follow-up task, re-verify, before PR.
5. PR → review-orchestrator against the PR/branch → merge into `main` only
   once clean → `keryx flow implemented --pr` → confirm AC evidence →
   `keryx flow complete`. Per the operator's standing instruction for this
   session: PR, then review orchestrator, only merge once it returns clean.

## Risks

- Low risk overall: single-file, additive-only, no new state, no new
  synchronization, five commands whose safety is already proven by the
  existing `Ctrl+O`/`/status`/`/flows` precedent (TRD §1.3-§5).
- Main risk is scope creep — Non-Goals explicitly list commands NOT to touch
  (`/new`, `/resume`, `/sessions`, `/compact`, `/model`); implementer must not
  "helpfully" extend to any of these.
- No automated regression test for the busy-branch dispatch itself (TRD
  finding) — mitigated by manual/smoke verification in T2, same standard the
  six pre-existing busy-branch commands already ship under.
