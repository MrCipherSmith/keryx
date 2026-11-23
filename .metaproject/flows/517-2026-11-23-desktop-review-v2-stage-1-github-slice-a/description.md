# Desktop Review v2 stage 1: GitHub slice and Keryx links on the board

## Problem

The Pull requests and Issues tabs mix GitHub state with Keryx state. A PR card changes lane when a
Keryx review starts or finishes (the "Needs attention" and "In review" lanes), Issues are grouped by
Flow stage so every issue without a Flow sits in one column, and "Open in Sessions" for a PR always
creates a new, unbound session. A review or Flow created from such a session never returns to the card.

Source: `docs/requirements/keryx-desktop-review-v2/` (PRD R1–R7, specification, implementation plan
row "1. GitHub-срез и ссылки", decisions D5 and D6). Stage 0 is Flow 516 (PR #1294).

## Expected outcome

- Pull requests: lanes, order and visibility come from GitHub data only. Default grouping "Status"
  (Draft · Waiting for review · Changes requested · Approved, plus Merged/Closed when the state filter
  includes them), alternative grouping "My role", quick filters "Requested from me", "Mine",
  "CI failed". The attention lane is gone (D6). Lanes that cannot hold cards are not drawn.
- Every PR card has a fixed-height Keryx work row: review link (state from `localReview`, no round
  number, no behind count; opens the current review panel), Flow link, session link; empty slots are
  labelled actions. Card actions are labelled with text. "Fix review comments" is out of scope.
- "Open in session" binds the session to the PR or Issue (Subject), reopens the latest bound session,
  offers another or a new one, and the session header shows the Subject with a link back.
- `/review` in a PR-bound session opens the launch dialog with that PR selected; the review appears as
  a link on the card. "Create Flow" from a PR opens the bound session with a flow prompt, and the Flow
  it creates is linked to the session and shown on the card.
- Issues: default grouping by GitHub state (Open · Closed); Flow stage is a link on the card; the
  default source is the project repository (D5); "Assigned to me" and the others stay selectable.

## Out of scope

- The Review entity, Reviews tab, round number and behind count on the review link (stage 2).
- Head movement, refresh rounds, publication options (stage 3); unified registry, "Fix review
  comments" (stage 4).
- Team review requests for the tab indicator (deviation (a)): stage 1 introduces no team membership,
  so the deviation stays open and is recorded as such.
- Rust changes in `apps/desktop/src-tauri` (not buildable locally; none planned).
