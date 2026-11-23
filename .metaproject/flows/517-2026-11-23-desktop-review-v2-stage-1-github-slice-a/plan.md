# Plan

## Approach

Five implementation slices, each a worker task with its own tests, then verification tasks.

1. **Subject storage (backend).** `SessionFlags.subject = {kind: "pr" | "issue", repo: "owner/name",
   number, url, repositoryId?}` in `flags.json`, validated on read and write (GitHub https URL whose
   path matches kind, repo and number). `_keryx/session_flags` accepts `subject` (object, or null to
   unlink). `withIssueBinding` writes `{kind: "issue"}` when it binds a session. Desktop's
   `SessionFlags` type mirrors it. An older keryx ignores the key: Desktop detects the missing
   `subject` in the reply and says the binding was not saved.
2. **Issues source "repository" (backend).** `ListIssueRequest.source` gains `"repository"`: REST
   `/repos/{owner}/{repo}/issues` for the project's GitHub repository resolved from the command's cwd
   (the same resolution the PR board uses), pull requests excluded, same pagination and cursor scope.
3. **PR board GitHub-only (Desktop).** Lane function from GitHub fields only. Grouping "Status"
   (default): Draft · Waiting for review · Changes requested · Approved · Merged · Closed; grouping
   "My role": Requested from me · Mine · Others. Lanes that the current filters exclude are not
   drawn. Quick filters "Requested from me", "Mine", "CI failed" are toggles in the context row (not
   the toolbar, so the toolbar measurements of stage 0 hold). Order: `updatedAt` descending. The
   card's reason line is GitHub-derived; Keryx state moves to the work row (slice 4). The attention
   set and tab indicator stay as they are (deviation (b) remains).
4. **Work row and sessions (Desktop).** A fixed-height work row on every PR card and list row with
   three slots: review (`localReview` state text, opens the current review panel; empty: "Run
   review"), Flow (flows with matching `prUrl` or linked to a session bound to the PR; "Flow #id ·
   stage"; empty: "Create Flow"), session (bound sessions; count, opens the newest, menu with all and
   "New session"; empty: "Open in session"). "Open on GitHub" and the subscription button get text
   labels. App: open/reuse a PR-bound session (pending subject applied like `pendingFlow`), composer
   prefilled with the URL and never sent; session header link to the Subject (PR detail in Pull
   requests, issue in Issues) and to its Flow; `/review` without a target in a PR-bound session
   preselects the PR; "Create Flow" opens the bound session with a flow prompt and links the first new
   flow package that appears while that request is pending.
5. **Issues board (Desktop).** Default grouping Open · Closed (Closed only when the state filter
   includes it); GitHub Project grouping unchanged; Flow stage is a link on the card; the stage filter
   is removed; default source "Project repository"; a stored source preference wins. Work row with
   Flow and session slots; issue sessions found through `subject`.

Trade-offs:

- Flow ↔ PR binding without a PR source in `flow.json` and without Rust changes: the Flow is reached
  through the bound session's `flow` flag, linked by Desktop when the new package appears. A Flow
  created outside the pending window is not linked automatically. Recorded as a known limit.
- Quick filters live outside the toolbar to avoid re-measuring the stage 0 container queries; if a
  worker has to add a toolbar element, the toolbar is re-measured (T13).

## State × event matrix

| state \ event | local review starts / finishes / publishes | filter or grouping change | board refresh | session created / bound | flow package appears |
|---|---|---|---|---|---|
| PR card shown | lane, position, visibility unchanged; review slot text changes (AC2) | lane set recomputed from GitHub fields; impossible lanes hidden (AC3) | order by `updatedAt` (AC2) | session slot count +1 (AC6) | Flow slot shows it if linked (AC9) |
| PR card hidden by filter | stays hidden (AC3) | shown only if it matches every filter (AC3) | — | — | — |
| no bound session | — | — | — | "Open in session" creates and binds; composer prefilled, not sent (AC7) | — |
| bound session exists | — | — | — | "Open in session" opens the newest non-archived; menu offers others and "New session" (AC7) | — |
| keryx without `subject` support | — | — | — | session opens, notice says the binding was not saved (AC8) | — |
| "Create Flow" pending for a session | — | — | — | — | first new package linked to that session; none linked when several appear (AC9) |
| Issues board, no project source | — | grouping Open · Closed by GitHub state (AC11) | — | session slot from `subject` (AC12) | Flow link on card (AC12) |
| attention set (tab indicator) | unchanged behaviour (AC14) | unchanged (AC14) | unchanged (AC14) | — | — |

## Verification

Tasks T11–T15 (kind verify) carry the checks: focused test suites, mutation check of any edited
attention-set line, the end-to-end scenario test, toolbar re-measure if touched, typecheck.
